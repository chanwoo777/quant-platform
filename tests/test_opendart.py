"""OpenDART statements -> the Credit page's figures (quant/ingestion/opendart.py) and export (quant/web/export.py).
Offline: rows shaped like fnlttSinglAcntAll.json's, the company list like CORPCODE.xml."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime

import pytest

from quant.ingestion import opendart
from quant.web import export


def line(sj, aid, name, *amounts):
    cols = dict(zip(("thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"), amounts))
    return {"sj_div": sj, "account_id": aid, "account_nm": name, "rcept_no": "20260310000123", **{k: v for k, v in cols.items()}}


CUSTOM = opendart.CUSTOM
ROWS = [
    line("BS", "ifrs-full_CashAndCashEquivalents", "현금및현금성자산", "1,000", "900", "800"),
    line("BS", "ifrs-full_CurrentAssets", "유동자산", "3,000", "2,800", "2,500"),
    line("BS", "ifrs-full_Assets", "자산총계", "10,000", "9,500", "9,000"),
    line("BS", "ifrs-full_ShorttermBorrowings", "단기차입금", "500", "600", "700"),
    line("BS", "ifrs-full_CurrentPortionOfLongtermBorrowings", "유동성장기부채", "200", "100", ""),
    line("BS", "ifrs-full_CurrentLiabilities", "유동부채", "2,000", "2,100", "2,200"),
    line("BS", CUSTOM, "사채", "300", "300", "300"),
    line("BS", CUSTOM, "미지급이자", "10", "10", "10"),  # not debt
    line("BS", "ifrs-full_NoncurrentLeaseLiabilities", "리스부채", "100", "100", "100"),
    line("BS", "ifrs-full_Liabilities", "부채총계", "4,000", "4,100", "4,200"),
    line("BS", "ifrs-full_Equity", "자본총계", "6,000", "5,400", "4,800"),
    line("CIS", "ifrs-full_Revenue", "매출액", "8,000", "7,000", "6,000"),
    line("CIS", "dart_OperatingIncomeLoss", "영업이익", "1,200", "900", "-100"),
    line("CIS", "ifrs-full_FinanceCosts", "금융비용", "150", "140", "130"),
    line("CIS", "ifrs-full_ProfitLoss", "당기순이익(손실)", "800", "600", "-200"),
    line("CF", "ifrs-full_AdjustmentsForDepreciationExpense", "감가상각비", "400", "380", "360"),
    line("CF", "ifrs-full_AdjustmentsForAmortisationExpense", "무형자산상각비", "50", "40", "30"),
    line("CF", CUSTOM, "이자의 지급", "-90", "-95", ""),
    line("CF", "ifrs-full_CashFlowsFromUsedInOperatingActivities", "영업활동현금흐름", "1,500", "1,100", "300"),
]


def test_amounts():
    assert opendart.amount("1,234,000") == 1234000 and opendart.amount("-5") == -5 and opendart.amount("(7)") == -7
    assert opendart.amount("") is None and opendart.amount("-") is None and opendart.amount(None) is None


def test_extract_three_years_from_one_report():
    years = opendart.extract(ROWS, 2025)
    assert sorted(years) == [2023, 2024, 2025]
    y = years[2025]
    assert y["revenue"] == 8000 and y["op_income"] == 1200 and y["da"] == 450 and y["ebitda"] == 1650
    assert y["debt"] == 500 + 200 + 300 + 100  # borrowings, current portion, custom bonds line, leases; not accrued interest
    assert y["interest"] == 90 and y["interest_basis"] == "interest paid"
    assert y["cash"] == 1000 and y["equity"] == 6000 and y["cfo"] == 1500 and y["current_liabilities"] == 2000
    old = years[2023]
    assert old["debt"] == 700 + 300 + 100  # an empty cell is left out, not read as zero
    assert old["interest"] == 130 and old["interest_basis"] == "finance costs"  # no interest paid that year
    assert old["op_income"] == -100 and old["ebitda"] == 290


def test_combined_depreciation_line_is_not_double_counted():
    rows = [line("CIS", "ifrs-full_Revenue", "매출액", "100"), line("CIS", "dart_OperatingIncomeLoss", "영업이익", "10"),
            line("CF", CUSTOM, "감가상각비와 무형자산상각비", "7"), line("CF", CUSTOM, "감가상각비", "5"), line("CF", CUSTOM, "대손상각비", "3")]
    assert opendart.extract(rows, 2025)[2025]["da"] == 7


def test_corp_codes_keep_listed_companies():
    xml = """<?xml version="1.0" encoding="UTF-8"?><result>
      <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name><stock_code>005930</stock_code></list>
      <list><corp_code>00999999</corp_code><corp_name>비상장</corp_name><corp_eng_name>Unlisted</corp_eng_name><stock_code> </stock_code></list>
    </result>""".encode()
    codes = opendart.parse_corp_codes(xml)
    assert codes == {"005930": {"corp_code": "00126380", "name": "삼성전자", "name_en": "SAMSUNG ELECTRONICS CO,.LTD"}}


@pytest.mark.parametrize("today, year", [(datetime(2026, 11, 13), 2025), (datetime(2026, 3, 1), 2024), (datetime(2026, 4, 1), 2025)])
def test_latest_filed_year(today, year):
    assert opendart.latest_year(today) == year


class FakeSession:
    """requests.Session stand-in: the company list zip, then annual reports (no consolidated set for one company)."""
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        resp = __import__("requests").Response()
        resp.status_code = 200
        if url == opendart.CORP_CODE_URL:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr("CORPCODE.xml", "<result><list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>"
                           "<corp_eng_name>SAMSUNG</corp_eng_name><stock_code>005930</stock_code></list></result>")
            resp._content = buf.getvalue()
        else:
            fs, year = params["fs_div"], params["bsns_year"]
            body = {"status": "013", "message": "조회된 데이타가 없습니다."} if fs == "CFS" or year == "2022" else {"status": "000", "list": ROWS}
            resp._content = json.dumps(body).encode()
        return resp


def test_refresh_caches_reports_and_falls_back_to_separate_statements(tmp_path, monkeypatch):
    monkeypatch.setattr(opendart, "api_key", lambda: "a" * 40)
    monkeypatch.setattr(opendart.time, "sleep", lambda s: None)
    fake = FakeSession()
    monkeypatch.setattr(opendart.requests, "Session", lambda: fake)
    doc = opendart.refresh(tmp_path, {"005930": "005930.KS", "000000": "000000.KS"}, today=datetime(2026, 11, 13))
    assert [c["ticker"] for c in doc["companies"]] == ["005930.KS"] and doc["missing"] == ["000000.KS"]
    c = doc["companies"][0]
    assert [y["year"] for y in c["years"]] == [2023, 2024, 2025] and c["years"][-1]["fs"] == "OFS"  # 2022's report wasn't filed
    assert c["reports"]["2025"]["url"].endswith("rcpNo=20260310000123")
    first = len(fake.calls)
    opendart.refresh(tmp_path, {"005930": "005930.KS"}, today=datetime(2026, 11, 13))
    assert len(fake.calls) == first  # everything came from the cache
    assert "a" * 40 not in json.dumps(doc)  # the key never reaches the published data


def test_refresh_needs_a_key(tmp_path, monkeypatch):
    monkeypatch.setattr(opendart, "api_key", lambda: None)
    with pytest.raises(opendart.DartError, match="DART_API_KEY"):
        opendart.refresh(tmp_path, {})


def test_export_writes_index_and_company_files(tmp_path):
    cache = tmp_path / "data" / "cache" / "dart"
    cache.mkdir(parents=True)
    years = [dict(v, year=k, fs="CFS") for k, v in sorted(opendart.extract(ROWS, 2025).items())]
    (cache / "credit.json").write_text(json.dumps({"fetched_at": "2026-11-13T07:30:00+09:00", "latest_year": 2025, "companies": [
        {"ticker": "005930.KS", "stock_code": "005930", "corp_code": "00126380", "name": "삼성전자", "name_en": "SAMSUNG", "years": years,
         "reports": {"2025": {"fs": "CFS", "url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1"}}}]}, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "site"
    stats = export.export_credit(out, tmp_path / "data")
    assert stats["companies"] == 1
    index = json.loads((out / "credit" / "index.json").read_text(encoding="utf-8"))
    assert index["companies"][0]["n"] == "삼성전자" and [y["year"] for y in index["companies"][0]["y"]] == [2024, 2025]
    company = json.loads((out / "credit" / "005930.json").read_text(encoding="utf-8"))
    assert [y["year"] for y in company["years"]] == [2023, 2024, 2025] and company["years"][-1]["ebitda"] == 1650
    assert export.export_credit(tmp_path / "other", tmp_path / "nothing") is None
