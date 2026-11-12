"""Korean companies' annual financial statements from OpenDART (the FSS's electronic disclosure system), for the
Credit page's ratios and indicative grade.

    python -m quant.ingestion.opendart            # refresh the cache for every Korean listing in the universe

Needs a free API key from https://opendart.fss.or.kr, set as DART_API_KEY in .env (never committed). Without a
key nothing runs and the Credit page says so. Each company costs two calls per refresh: a year's annual report
carries that year and the two before it, so the latest report and the one three years earlier give six years.
Reports for past years are cached for good; the latest year is re-read after 30 days (late filings, restatements).

Statements are the consolidated ones (CFS), or the company's own (OFS) when it files no consolidated set. Figures
are matched by their K-IFRS XBRL account ids first and by their Korean names when a company uses its own account
(DART marks those "-표준계정코드 미사용-"). Everything here is public disclosure data.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree

import requests

log = logging.getLogger(__name__)

CORP_CODE_URL = "https://opendart.fss.or.kr/api/corpCode.xml"
STATEMENTS_URL = "https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json"
REPORT_URL = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo={}"
ANNUAL = "11011"  # reprt_code of the annual business report (사업보고서)
LATEST_REFRESH = timedelta(days=30)
NO_DATA, RATE_LIMIT = "013", "020"
CUSTOM = "-표준계정코드 미사용-"  # account_id when a company uses an account outside the standard taxonomy

# figure -> (statements, standard account ids, Korean name pattern for custom accounts). Lines are summed only for
# "sum" figures (debt, D&A); for the rest the first match wins, in the order of the ids.
FIGURES = {
    "revenue": (("IS", "CIS"), ("ifrs-full_Revenue", "ifrs_Revenue", "dart_Revenue"), r"^(매출액|영업수익|수익\(매출액\)|매출)$"),
    "op_income": (("IS", "CIS"), ("dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"), r"^영업이익(\(손실\))?$"),
    "net_income": (("IS", "CIS"), ("ifrs-full_ProfitLoss",), r"^(연결)?당기순이익(\(손실\))?$"),
    "interest_paid": (("CF",), ("ifrs-full_InterestPaidClassifiedAsOperatingActivities", "ifrs-full_InterestPaidClassifiedAsFinancingActivities"),
                      r"^이자(의)?\s*지급"),
    "interest_expense": (("IS", "CIS"), ("ifrs-full_InterestExpense", "dart_InterestExpense"), r"^이자비용$"),
    "finance_costs": (("IS", "CIS"), ("ifrs-full_FinanceCosts",), r"^금융(비용|원가)$"),
    "cfo": (("CF",), ("ifrs-full_CashFlowsFromUsedInOperatingActivities",), r"^영업활동\s*(으로\s*인한\s*)?현금흐름$"),
    "cash": (("BS",), ("ifrs-full_CashAndCashEquivalents",), r"^현금및현금성자산$"),
    "equity": (("BS",), ("ifrs-full_Equity",), r"^자본총계$"),
    "assets": (("BS",), ("ifrs-full_Assets",), r"^자산총계$"),
    "liabilities": (("BS",), ("ifrs-full_Liabilities",), r"^부채총계$"),
    "current_assets": (("BS",), ("ifrs-full_CurrentAssets",), r"^유동자산$"),
    "current_liabilities": (("BS",), ("ifrs-full_CurrentLiabilities",), r"^유동부채$"),
}
DEBT_IDS = ("ifrs-full_ShorttermBorrowings", "dart_ShortTermBorrowings", "ifrs-full_CurrentPortionOfLongtermBorrowings",
            "ifrs-full_CurrentPortionOfNoncurrentBorrowings", "dart_CurrentPortionOfLongTermBorrowings", "dart_CurrentPortionOfBonds",
            "ifrs-full_LongtermBorrowings", "dart_LongTermBorrowingsGross", "ifrs-full_NoncurrentPortionOfNoncurrentBorrowings",
            "ifrs-full_BondsIssued", "dart_BondsIssued", "ifrs-full_CurrentLeaseLiabilities", "ifrs-full_NoncurrentLeaseLiabilities",
            "ifrs-full_LeaseLiabilities")
DEBT_NAME = re.compile(r"차입금|사채|유동성장기부채|리스부채")
DEBT_SKIP = re.compile(r"합계|소계|미지급|이자|전환권|교환권|상환할증|파생")
DA_IDS = ("ifrs-full_AdjustmentsForDepreciationExpense", "ifrs-full_AdjustmentsForAmortisationExpense",
          "ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense", "ifrs-full_DepreciationExpense", "ifrs-full_AmortisationExpense",
          "ifrs-full_DepreciationAndAmortisationExpense")
DA_COMBINED = re.compile(r"감가상각비\s*(및|와)\s*.*상각비")
DA_NAME = re.compile(r"감가상각비|상각비")
DA_SKIP = re.compile(r"환입|손상|대손|처분|누계")
COLUMNS = (("thstrm_amount", 0), ("frmtrm_amount", 1), ("bfefrmtrm_amount", 2))


class DartError(RuntimeError):
    pass


def api_key() -> str | None:
    """DART_API_KEY from the environment (.env is loaded by quant.config)."""
    from quant import config  # noqa: F401  (loads .env)

    key = (os.getenv("DART_API_KEY") or "").strip()
    return key if re.fullmatch(r"[0-9A-Za-z]{20,64}", key) else None


def amount(text) -> float | None:
    """'1,234,000' / '-5' / '(5)' -> number; '' and '-' -> None."""
    s = str(text if text is not None else "").replace(",", "").strip()
    if not s or s == "-":
        return None
    neg = s.startswith("(") and s.endswith(")")
    try:
        v = float(s.strip("()"))
    except ValueError:
        return None
    return -v if neg else v


def parse_corp_codes(xml_bytes: bytes) -> dict[str, dict]:
    """stock_code -> {corp_code, name, name_en} for listed companies, from CORPCODE.xml."""
    out = {}
    for el in ElementTree.fromstring(xml_bytes).iter("list"):
        stock = (el.findtext("stock_code") or "").strip()
        if re.fullmatch(r"\d{6}", stock):
            out[stock] = {"corp_code": (el.findtext("corp_code") or "").strip(), "name": (el.findtext("corp_name") or "").strip(),
                          "name_en": (el.findtext("corp_eng_name") or "").strip()}
    return out


def _std(row: dict) -> str:
    return str(row.get("account_id") or "").strip()


def _pick(rows: list[dict], sj: tuple[str, ...], ids: tuple[str, ...], pattern: str, col: str) -> float | None:
    lines = [r for r in rows if r.get("sj_div") in sj]
    for i in ids:
        for r in lines:
            if _std(r) == i and (v := amount(r.get(col))) is not None:
                return v
    rx = re.compile(pattern)
    for r in lines:
        if _std(r) in (CUSTOM, "") and rx.search(str(r.get("account_nm") or "").replace(" ", "")) and (v := amount(r.get(col))) is not None:
            return v
    return None


def _sum_debt(rows: list[dict], col: str) -> float | None:
    """Borrowings, bonds and lease liabilities on the balance sheet, each standard account once, plus custom lines."""
    seen, total, found = set(), 0.0, False
    for r in rows:
        if r.get("sj_div") != "BS":
            continue
        aid, name = _std(r), str(r.get("account_nm") or "").replace(" ", "")
        take = aid in DEBT_IDS and aid not in seen or (aid in (CUSTOM, "") and DEBT_NAME.search(name) and not DEBT_SKIP.search(name))
        if take and (v := amount(r.get(col))) is not None:
            seen.add(aid)
            total += v
            found = True
    return total if found else None


def _sum_da(rows: list[dict], col: str) -> float | None:
    """Depreciation and amortisation added back in the cash flow statement (absolute values)."""
    cf = [r for r in rows if r.get("sj_div") == "CF"]
    by_id = {}
    for r in cf:
        if _std(r) in DA_IDS and _std(r) not in by_id and (v := amount(r.get(col))) is not None:
            by_id[_std(r)] = abs(v)
    if by_id:
        both = by_id.get("ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense") or by_id.get("ifrs-full_DepreciationAndAmortisationExpense")
        return both if both is not None else sum(by_id.values())
    custom = [(str(r.get("account_nm") or "").replace(" ", ""), amount(r.get(col))) for r in cf if _std(r) in (CUSTOM, "")]
    custom = [(n, abs(v)) for n, v in custom if v is not None and DA_NAME.search(n) and not DA_SKIP.search(n)]
    combined = [v for n, v in custom if DA_COMBINED.search(n)]
    if combined:
        return combined[0]
    return sum(v for _, v in custom) if custom else None


def extract(rows: list[dict], year: int) -> dict[int, dict]:
    """{fiscal year: figures} for the three years in one annual report's rows."""
    out = {}
    for col, back in COLUMNS:
        f = {k: _pick(rows, sj, ids, pat, col) for k, (sj, ids, pat) in FIGURES.items()}
        if f["revenue"] is None and f["assets"] is None:
            continue
        f["debt"] = _sum_debt(rows, col)
        f["da"] = _sum_da(rows, col)
        f["ebitda"] = f["op_income"] + f["da"] if f["op_income"] is not None and f["da"] is not None else None
        for basis, key in (("interest paid", "interest_paid"), ("interest expense", "interest_expense"), ("finance costs", "finance_costs")):
            if f[key] is not None:
                f["interest"], f["interest_basis"] = abs(f[key]), basis
                break
        else:
            f["interest"], f["interest_basis"] = None, None
        out[year - back] = f
    return out


@dataclass
class Client:
    key: str
    cache: Path
    session: requests.Session = field(default_factory=lambda: requests.Session())  # looked up per client, so tests can swap it
    pause: float = 0.15
    calls: int = 0

    def get(self, url: str, **params) -> requests.Response:
        for attempt in range(3):
            try:
                resp = self.session.get(url, params={"crtfc_key": self.key, **params}, timeout=30)
                self.calls += 1
                resp.raise_for_status()
                time.sleep(self.pause)
                return resp
            except requests.RequestException as exc:
                if attempt == 2:
                    raise DartError(f"OpenDART request failed: {type(exc).__name__}") from None
                time.sleep(2 * (attempt + 1))
        raise AssertionError("unreachable")

    def corp_codes(self) -> dict[str, dict]:
        path = self.cache / "corp_codes.json"
        if path.exists() and datetime.now().timestamp() - path.stat().st_mtime < 7 * 86400:
            return json.loads(path.read_text(encoding="utf-8"))
        resp = self.get(CORP_CODE_URL)
        if not resp.content.startswith(b"PK"):  # an error comes back as JSON or XML instead of the zip
            raise DartError(f"OpenDART refused the company list: {resp.text[:200]}")
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            codes = parse_corp_codes(z.read(z.namelist()[0]))
        path.write_text(json.dumps(codes, ensure_ascii=False), encoding="utf-8")
        return codes

    def report(self, corp_code: str, year: int, refresh: bool = False) -> dict | None:
        """{fs, rcept_no, rows} of one annual report (consolidated, else separate), cached; None when not filed."""
        path = self.cache / f"{corp_code}_{year}.json"
        if path.exists() and not refresh:
            doc = json.loads(path.read_text(encoding="utf-8"))
            return doc or None
        for fs in ("CFS", "OFS"):
            body = self.get(STATEMENTS_URL, corp_code=corp_code, bsns_year=str(year), reprt_code=ANNUAL, fs_div=fs).json()
            status = str(body.get("status"))
            if status == RATE_LIMIT:
                raise DartError("OpenDART's daily request limit was reached; the rest waits for tomorrow")
            if status == "000" and body.get("list"):
                doc = {"fs": fs, "rcept_no": body["list"][0].get("rcept_no"), "rows": body["list"]}
                path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
                return doc
            if status != NO_DATA:
                raise DartError(f"OpenDART status {status}: {body.get('message')}")
        path.write_text("{}", encoding="utf-8")  # not filed: remembered, re-asked with the latest year's refresh
        return None


def latest_year(today: datetime | None = None) -> int:
    """The newest fiscal year whose annual report should be filed: reports are due by the end of March."""
    today = today or datetime.now()
    return today.year - 1 if today.month >= 4 else today.year - 2


def company_years(client: Client, corp_code: str, today: datetime | None = None) -> tuple[dict[int, dict], dict]:
    """Up to six fiscal years of figures and the reports they came from."""
    y = latest_year(today)
    years, reports = {}, {}
    for report_year in (y, y - 3):
        path = client.cache / f"{corp_code}_{report_year}.json"
        stale = report_year == y and (not path.exists() or datetime.now().timestamp() - path.stat().st_mtime > LATEST_REFRESH.total_seconds())
        doc = client.report(corp_code, report_year, refresh=stale)
        if doc is None and report_year == y:  # the latest report isn't out yet: fall back a year
            doc = client.report(corp_code, y - 1)
            report_year = y - 1
        if not doc:
            continue
        reports[report_year] = {"fs": doc["fs"], "url": REPORT_URL.format(doc["rcept_no"]) if doc.get("rcept_no") else None}
        for fy, figs in extract(doc["rows"], report_year).items():
            years.setdefault(fy, dict(figs, fs=doc["fs"]))
    return years, reports


def korean_tickers() -> dict[str, str]:
    """{stock code: universe ticker} for the Korean listings in the screener universe (.KS / .KQ)."""
    from sqlalchemy import select

    from quant.db import session_scope
    from quant.universe.models import Instrument

    with session_scope() as s:
        syms = [x for (x,) in s.execute(select(Instrument.symbol).where(Instrument.symbol.like("%.K%"))).all()]
    return {m.group(1): sym for sym in syms if (m := re.fullmatch(r"(\d{6})\.K[SQ]", sym))}


def refresh(cache: Path | None = None, tickers: dict[str, str] | None = None, today: datetime | None = None) -> dict:
    """Update the cache for every Korean listing and write credit.json (figures per company) next to it."""
    from quant.config import get_settings

    key = api_key()
    if not key:
        raise DartError("DART_API_KEY isn't set: get a free key at https://opendart.fss.or.kr and add it to .env")
    cache = cache or get_settings().data_dir / "cache" / "dart"
    cache.mkdir(parents=True, exist_ok=True)
    client = Client(key, cache)
    codes = client.corp_codes()
    tickers = tickers if tickers is not None else korean_tickers()
    companies, missing, errors = [], [], []
    for stock, ticker in sorted(tickers.items()):
        info = codes.get(stock)
        if not info:
            missing.append(ticker)
            continue
        try:
            years, reports = company_years(client, info["corp_code"], today)
        except DartError as exc:
            errors.append(f"{ticker}: {exc}")
            if "limit" in str(exc):
                break
            continue
        if years:
            companies.append({"ticker": ticker, "stock_code": stock, "corp_code": info["corp_code"], "name": info["name"],
                              "name_en": info["name_en"], "years": [dict(v, year=k) for k, v in sorted(years.items())],
                              "reports": {str(k): v for k, v in sorted(reports.items())}})
        else:
            missing.append(ticker)
    doc = {"fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"), "latest_year": latest_year(today),
           "companies": companies, "missing": missing, "errors": errors[:50], "calls": client.calls}
    (cache / "credit.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    log.info("OpenDART: %d companies, %d without statements, %d errors, %d calls", len(companies), len(missing), len(errors), client.calls)
    return doc


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    try:
        d = refresh()
        print(f"{len(d['companies'])} companies, {len(d['missing'])} without statements, {d['calls']} calls")
    except DartError as e:
        print(e)
        raise SystemExit(1)
