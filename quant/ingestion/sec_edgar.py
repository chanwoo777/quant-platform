"""SEC EDGAR fundamentals: the latest 10-K / 10-Q filings and their core metrics.

Data flow (all free, official SEC endpoints):
  1. ticker -> CIK               www.sec.gov/files/company_tickers.json
  2. filing list                 data.sec.gov/submissions/CIK##########.json
  3. reported XBRL financials    data.sec.gov/api/xbrl/companyfacts/CIK##########.json

Each XBRL fact carries the accession number of the filing that reported it, so
metrics are matched to a filing by accession number + period end date. This is
more reliable than scraping the filing HTML, and it is the same data the filing
contains. SEC asks for <= 10 requests/second and a descriptive User-Agent with
a contact email (set SEC_USER_AGENT in .env).
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from itertools import islice
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from quant.db import upsert
from quant.ingestion.http import make_session
from quant.models import Company, Fundamental, utcnow

log = logging.getLogger(__name__)

SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
SUBMISSIONS_PAGE_URL = "https://data.sec.gov/submissions/{name}"
COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/{doc}"

FORMS = ("10-K", "10-Q")
TICKER_CACHE_MAX_AGE = 24 * 3600

# Companies switch tags over time (e.g. SalesRevenueNet -> ASC 606 revenue tags),
# so each metric lists candidate us-gaap concepts in order of preference.
DURATION_CONCEPTS: dict[str, tuple[str, ...]] = {
    "revenue": (
        "Revenues",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "RevenuesNetOfInterestExpense",
    ),
    "net_income": ("NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"),
    "eps_basic": ("EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"),
    "eps_diluted": ("EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"),
    "diluted_shares": (
        "WeightedAverageNumberOfDilutedSharesOutstanding",
        "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
        "WeightedAverageNumberOfSharesOutstandingBasic",  # e.g. ExxonMobil: basic == diluted
    ),
}
CASH_FLOW_CONCEPTS: dict[str, tuple[str, ...]] = {
    "operating_cash_flow": (
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ),
    "capital_expenditure": ("PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"),
}
INSTANT_CONCEPTS: dict[str, tuple[str, ...]] = {
    "total_assets": ("Assets",),
    "total_liabilities": ("Liabilities",),
    "stockholders_equity": (
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ),
    "cash_and_equivalents": (
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ),
}
DEBT_NONCURRENT = ("LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations")
DEBT_CURRENT = ("LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent")
DEBT_SHORT_TERM = ("CommercialPaper", "ShortTermBorrowings")
METRIC_FIELDS = (
    *DURATION_CONCEPTS,
    *CASH_FLOW_CONCEPTS,
    *INSTANT_CONCEPTS,
    "total_debt",
    "free_cash_flow",
    "debt_to_equity",
    "net_margin",
    "period_days",
    "cash_flow_period_days",
    "fiscal_year",
    "fiscal_period",
)


@dataclass(frozen=True)
class FilingRef:
    accession_number: str
    form: str
    filing_date: date
    report_date: date | None
    primary_document: str


class SECClient:
    def __init__(self, user_agent: str, cache_dir: Path, timeout: float = 20.0, min_interval: float = 0.15):
        if "example.com" in user_agent:
            log.warning("SEC_USER_AGENT is a placeholder; set it to 'Your Name your@email' in .env "
                        "or SEC may throttle/block requests")
        self.session = make_session(user_agent)
        self.cache_dir = cache_dir
        self.timeout = timeout
        self.min_interval = min_interval
        self._last_request = 0.0
        self._lock = threading.Lock()
        self._tickers: dict[str, dict] | None = None

    def _get_json(self, url: str) -> Any:
        with self._lock:  # SEC fair-access: <= 10 requests / second
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()
        resp = self.session.get(url, timeout=self.timeout)
        if resp.status_code == 403:
            raise PermissionError(f"SEC refused {url} (403). Set SEC_USER_AGENT to 'Name email@domain'.")
        resp.raise_for_status()
        return resp.json()

    def ticker_map(self) -> dict[str, dict]:
        """{TICKER: {"cik": int, "title": str}}, cached on disk for a day."""
        if self._tickers is None:
            cache = self.cache_dir / "company_tickers.json"
            if cache.exists() and time.time() - cache.stat().st_mtime < TICKER_CACHE_MAX_AGE:
                raw = json.loads(cache.read_text(encoding="utf-8"))
            else:
                raw = self._get_json(SEC_TICKERS_URL)
                cache.write_text(json.dumps(raw), encoding="utf-8")
            self._tickers = {
                row["ticker"].upper(): {"cik": int(row["cik_str"]), "title": row["title"]} for row in raw.values()
            }
        return self._tickers

    def cik_for(self, ticker: str) -> int | None:
        entry = self.ticker_map().get(ticker.upper())
        return entry["cik"] if entry else None

    def submissions(self, cik: int) -> dict:
        return self._get_json(SUBMISSIONS_URL.format(cik=cik))

    def company_facts(self, cik: int) -> dict:
        return self._get_json(COMPANY_FACTS_URL.format(cik=cik))

    def iter_filings(self, submissions: dict) -> Iterator[FilingRef]:
        """10-K/10-Q filings newest first; older pages are fetched only if consumed."""
        filings = submissions.get("filings", {})
        yield from _filings_from_block(filings.get("recent", {}))
        for page in filings.get("files", []):
            yield from _filings_from_block(self._get_json(SUBMISSIONS_PAGE_URL.format(name=page["name"])))


def _parse_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _filings_from_block(block: dict) -> Iterator[FilingRef]:
    for i, form in enumerate(block.get("form", [])):
        if form in FORMS:
            yield FilingRef(
                accession_number=block["accessionNumber"][i],
                form=form,
                filing_date=date.fromisoformat(block["filingDate"][i]),
                report_date=_parse_date(block["reportDate"][i]),
                primary_document=block["primaryDocument"][i],
            )


class FactIndex:
    """us-gaap facts indexed by concept and accession number."""

    def __init__(self, company_facts: dict):
        self._facts: dict[str, dict[str, list[dict]]] = {}
        for concept, node in company_facts.get("facts", {}).get("us-gaap", {}).items():
            by_accn: dict[str, list[dict]] = defaultdict(list)
            for unit, items in node.get("units", {}).items():
                if unit.startswith("USD") or unit == "shares":  # "USD", "USD/shares", "shares"
                    for item in items:
                        by_accn[item["accn"]].append(item)
            self._facts[concept] = by_accn

    def get(self, concept: str, accn: str) -> list[dict]:
        return self._facts.get(concept, {}).get(accn, [])

    def period_end(self, accn: str) -> date | None:
        """Fallback period end: the latest balance-sheet date reported in the filing."""
        ends = [
            item["end"]
            for concept in ("Assets", "Liabilities", "StockholdersEquity")
            for item in self.get(concept, accn)
            if "start" not in item
        ]
        return date.fromisoformat(max(ends)) if ends else None


def _duration_days(item: dict) -> int:
    return (date.fromisoformat(item["end"]) - date.fromisoformat(item["start"])).days


def _pick_duration(items: list[dict], end: str, target_days: int) -> dict | None:
    """Flow fact ending on ``end`` whose period length is closest to the target
    (a 10-Q reports both the quarter and year-to-date; we want the quarter)."""
    candidates = [i for i in items if i.get("end") == end and "start" in i]
    return min(candidates, key=lambda i: abs(_duration_days(i) - target_days)) if candidates else None


def _pick_instant(items: list[dict], end: str) -> dict | None:
    candidates = [i for i in items if i.get("end") == end and "start" not in i]
    return candidates[-1] if candidates else None


def _first_value(index: FactIndex, accn: str, concepts: tuple[str, ...], end: str) -> float | None:
    for concept in concepts:
        hit = _pick_instant(index.get(concept, accn), end)
        if hit is not None:
            return float(hit["val"])
    return None


def total_debt(index: FactIndex, accn: str, end: str) -> float | None:
    """Approximate total debt: long-term + current portion + short-term borrowings.

    Filers tag debt inconsistently, so this falls back to ``DebtCurrent`` (which
    already includes short-term borrowings) and to ``LongTermDebt`` (which
    already includes the current portion) to avoid double counting.
    """
    noncurrent = _first_value(index, accn, DEBT_NONCURRENT, end)
    debt_current = _first_value(index, accn, ("DebtCurrent",), end)
    if debt_current is not None:
        current, short_term = debt_current, 0.0
    else:
        current = _first_value(index, accn, DEBT_CURRENT, end)
        short_term = sum(v for c in DEBT_SHORT_TERM if (v := _first_value(index, accn, (c,), end)) is not None)

    if noncurrent is None and current is None:
        combined = _first_value(index, accn, ("LongTermDebt",), end)
        if combined is None and not short_term:
            return None
        return (combined or 0.0) + short_term
    return (noncurrent or 0.0) + (current or 0.0) + short_term


def extract_metrics(index: FactIndex, filing: FilingRef) -> dict | None:
    """Core metrics for one filing, or None if its XBRL data isn't available."""
    accn = filing.accession_number
    period_end = filing.report_date or index.period_end(accn)
    if period_end is None:
        return None
    end = period_end.isoformat()
    target_days = 365 if filing.form == "10-K" else 91

    row: dict[str, Any] = dict.fromkeys(METRIC_FIELDS)
    row["report_date"] = period_end
    found_any = False

    for group, is_cash_flow in ((DURATION_CONCEPTS, False), (CASH_FLOW_CONCEPTS, True)):
        for field, concepts in group.items():
            for concept in concepts:
                hit = _pick_duration(index.get(concept, accn), end, target_days)
                if hit is None:
                    continue
                row[field] = float(hit["val"])
                days_key = "cash_flow_period_days" if is_cash_flow else "period_days"
                if row[days_key] is None or field == "revenue":
                    row[days_key] = _duration_days(hit)
                row["fiscal_year"] = row["fiscal_year"] or hit.get("fy")
                row["fiscal_period"] = row["fiscal_period"] or hit.get("fp")
                found_any = True
                break

    for field, concepts in INSTANT_CONCEPTS.items():
        row[field] = _first_value(index, accn, concepts, end)
        found_any = found_any or row[field] is not None

    if not found_any:
        return None

    row["total_debt"] = total_debt(index, accn, end)
    if row["operating_cash_flow"] is not None and row["capital_expenditure"] is not None:
        row["free_cash_flow"] = row["operating_cash_flow"] - row["capital_expenditure"]
    equity = row["stockholders_equity"]
    if row["total_debt"] is not None and equity and equity > 0:
        row["debt_to_equity"] = row["total_debt"] / equity
    if row["net_income"] is not None and row["revenue"]:
        row["net_margin"] = row["net_income"] / row["revenue"]
    if row["diluted_shares"] is None:
        # Multi-class filers (Alphabet) only tag share counts per class, which the
        # aggregate API omits: diluted EPS = net income / diluted shares recovers it.
        if row["net_income"] is not None and row["eps_diluted"] and abs(row["eps_diluted"]) >= 0.05:
            row["diluted_shares"] = row["net_income"] / row["eps_diluted"]
        else:
            row["diluted_shares"] = _first_value(index, accn, ("CommonStockSharesOutstanding",), end)
    return row


def filing_url(cik: int, filing: FilingRef) -> str:
    return ARCHIVE_URL.format(cik=cik, accn=filing.accession_number.replace("-", ""), doc=filing.primary_document)


def update_fundamentals(
    session: Session,
    client: SECClient,
    ticker: str,
    max_filings: int = 44,
    predecessor_ciks: tuple[int, ...] = (),
    refresh: bool = False,
) -> int:
    """Store metrics for the latest ``max_filings`` 10-K/10-Q filings.

    Filings already stored are skipped unless ``refresh`` (use it after adding a
    metric). ``predecessor_ciks`` adds the history of earlier registrants of the
    same business (e.g. ExxonMobil before its 2026 re-registration).
    """
    cik = client.cik_for(ticker)
    if cik is None:
        log.info("%s has no SEC CIK (index, ETF or foreign filer); skipping fundamentals", ticker)
        return 0

    subs = client.submissions(cik)
    exchanges = subs.get("exchanges") or [None]
    upsert(
        session,
        Company,
        [
            {
                "ticker": ticker,
                "cik": cik,
                "name": subs.get("name"),
                "sic": subs.get("sic"),
                "sic_description": subs.get("sicDescription"),
                "exchange": exchanges[0],
                "fiscal_year_end": subs.get("fiscalYearEnd"),
            }
        ],
        ["ticker"],
    )

    by_cik = {cik: list(islice(client.iter_filings(subs), max_filings))}
    for old_cik in predecessor_ciks:
        by_cik[old_cik] = list(islice(client.iter_filings(client.submissions(old_cik)), max_filings))
    newest = sorted(((f, k) for k, fs in by_cik.items() for f in fs), key=lambda x: x[0].filing_date, reverse=True)
    newest = newest[:max_filings]

    known = set() if refresh else set(
        session.scalars(
            select(Fundamental.accession_number).where(
                Fundamental.accession_number.in_([f.accession_number for f, _ in newest])
            )
        )
    )
    todo = [(f, k) for f, k in newest if f.accession_number not in known]
    if not todo:
        return 0

    rows = []
    for filer in dict.fromkeys(k for _, k in todo):
        index = FactIndex(client.company_facts(filer))
        for filing, _ in (x for x in todo if x[1] == filer):
            metrics = extract_metrics(index, filing)
            if metrics is None:
                log.warning("%s %s %s: no XBRL facts yet; will retry next run",
                            ticker, filing.form, filing.accession_number)
                continue
            rows.append(
                {
                    "ticker": ticker,
                    "cik": filer,
                    "form": filing.form,
                    "accession_number": filing.accession_number,
                    "filing_date": filing.filing_date,
                    "filing_url": filing_url(filer, filing),
                    "fetched_at": utcnow(),
                    **metrics,
                }
            )
    return upsert(session, Fundamental, rows, ["accession_number"])


def split_share_classes(client: SECClient, tickers: list[str]) -> tuple[list[str], dict[str, str]]:
    """(tickers to fetch, {other share class: ticker fetched for its filer}).

    GOOG and GOOGL (likewise FOX/FOXA, NWS/NWSA) file one set of reports, and a
    filing is stored once (accession numbers are unique), so only the first ticker
    of each filer is fetched; earlier tickers in ``tickers`` win.
    """
    fetch, linked, by_cik = [], {}, {}
    for t in tickers:
        cik = client.cik_for(t)
        if cik is not None and cik in by_cik:
            linked[t] = by_cik[cik]
        else:
            fetch.append(t)
            if cik is not None:
                by_cik[cik] = t
    return fetch, linked


def link_share_class(session: Session, ticker: str, primary: str) -> int:
    """Register ``ticker`` as another share class of ``primary``'s filer (same Company row, new ticker)."""
    src = session.get(Company, primary)
    if src is None:
        return 0
    cols = [c.name for c in Company.__table__.columns]
    return upsert(session, Company, [{**{c: getattr(src, c) for c in cols}, "ticker": ticker}], ["ticker"])


def load_fundamentals_many(session: Session, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """``load_fundamentals`` for many tickers in two queries. A share class without
    filings of its own (GOOG) gets those of its filer (stored under GOOGL)."""
    cols = [c.name for c in Fundamental.__table__.columns]
    ciks = dict(session.execute(select(Company.ticker, Company.cik).where(Company.ticker.in_(tickers))).all())
    stmt = select(*Fundamental.__table__.columns).where(
        Fundamental.ticker.in_(tickers) | Fundamental.cik.in_(set(ciks.values()))
    )
    df = pd.DataFrame(session.execute(stmt).all(), columns=cols)
    by_ticker = dict(tuple(df.groupby("ticker", sort=False)))
    by_cik = dict(tuple(df.groupby("cik", sort=False)))
    out = {}
    for t in tickers:
        rows = by_ticker.get(t)
        if rows is None and t in ciks:
            rows = by_cik.get(ciks[t])
        out[t] = (pd.DataFrame(columns=cols) if rows is None
                  else rows.sort_values("report_date", ascending=False, kind="stable").reset_index(drop=True))
    return out


def load_fundamentals(session: Session, ticker: str, form: str | None = None) -> pd.DataFrame:
    stmt = select(Fundamental).where(Fundamental.ticker == ticker).order_by(Fundamental.report_date.desc())
    if form:
        stmt = stmt.where(Fundamental.form == form)
    cols = [c.name for c in Fundamental.__table__.columns]
    return pd.DataFrame([{c: getattr(r, c) for c in cols} for r in session.scalars(stmt)], columns=cols)
