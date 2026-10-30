"""Offline tests for the Phase 1 ingestion layer (no network access needed)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest
from sqlalchemy import func, select, update

from quant.db import init_db, make_engine, session_scope, upsert
from quant.ingestion.macro_data import parse_fred_csv, update_series
from quant.ingestion.market_data import normalize_history
from quant.ingestion.news_scraper import (
    article_key,
    clean_html,
    compute_price_reactions,
    parse_feed,
    store_articles,
)
from quant.ingestion.sec_edgar import FactIndex, FilingRef, _filings_from_block, extract_metrics, update_fundamentals
from quant.ingestion.sentiment import LexiconScorer
from quant.models import Company, Fundamental, MacroObservation, NewsArticle, PriceBar


@pytest.fixture
def engine(tmp_path):
    return init_db(make_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


# --- database ----------------------------------------------------------------

def _article(**overrides):
    row = {
        "article_key": "k1",
        "ticker": "AAPL",
        "source": "google_news",
        "publisher": "Reuters",
        "title": "Apple beats estimates",
        "summary": None,
        "url": "https://example.com/a",
        "published_at": datetime(2026, 10, 16, 14, 0),
        "fetched_at": datetime(2026, 10, 16, 15, 0),
    }
    row.update(overrides)
    return row


def test_store_articles_keeps_first_copy_and_sentiment(engine):
    with session_scope(engine) as s:
        store_articles(s, [_article()])
    with session_scope(engine) as s:
        s.execute(update(NewsArticle).values(sentiment_score=0.5))
    with session_scope(engine) as s:
        store_articles(s, [_article(title="Changed", fetched_at=datetime(2026, 10, 17))])

    with session_scope(engine) as s:
        rows = s.scalars(select(NewsArticle)).all()
        assert len(rows) == 1
        assert rows[0].title == "Apple beats estimates"
        assert rows[0].sentiment_score == 0.5
        assert rows[0].fetched_at == datetime(2026, 10, 17)


def test_upsert_updates_price_bars(engine):
    bar = {"ticker": "AAPL", "interval": "1d", "timestamp": datetime(2026, 10, 16), "open": 1.0,
           "high": 2.0, "low": 0.5, "close": 1.5, "adj_close": 1.5, "volume": 100}
    with session_scope(engine) as s:
        upsert(s, PriceBar, [bar], ["ticker", "interval", "timestamp"])
        upsert(s, PriceBar, [{**bar, "close": 1.7}], ["ticker", "interval", "timestamp"])
    with session_scope(engine) as s:
        assert s.scalar(select(func.count()).select_from(PriceBar)) == 1
        assert s.scalar(select(PriceBar.close)) == 1.7


# --- market data -------------------------------------------------------------

def test_normalize_history_intraday_to_utc_and_daily_to_date():
    idx = pd.DatetimeIndex(["2026-10-16 09:30", "2026-10-16 09:45", "2026-10-16 09:45"]).tz_localize("America/New_York")
    raw = pd.DataFrame({"Open": [1, 2, 3], "High": [1, 2, 3], "Low": [1, 2, 3], "Close": [1.0, 2.0, 3.0],
                        "Volume": [10, 20, 30]}, index=idx)

    intraday = normalize_history(raw, "15m")
    assert list(intraday["timestamp"]) == [pd.Timestamp("2026-10-16 13:30"), pd.Timestamp("2026-10-16 13:45")]
    assert intraday["close"].tolist() == [1.0, 3.0]  # duplicate bar: keep last
    assert intraday["adj_close"].tolist() == [1.0, 3.0]  # no "Adj Close" -> close

    daily = normalize_history(raw.iloc[:1], "1d")
    assert daily["timestamp"].iloc[0] == pd.Timestamp("2026-10-16")


# --- FRED --------------------------------------------------------------------

def test_parse_fred_csv_handles_missing_values():
    text = "observation_date,DGS10\n2026-09-01,4.79\n2026-09-02,.\n2026-09-03,4.77\n"
    series = parse_fred_csv(text, "DGS10")
    assert series.to_dict() == {pd.Timestamp("2026-09-01"): 4.79, pd.Timestamp("2026-09-03"): 4.77}


def test_parse_fred_csv_rejects_html():
    with pytest.raises(ValueError):
        parse_fred_csv("<html><body>Error</body></html>", "DGS10")


def test_update_series_is_incremental(engine):
    class FakeFred:
        def __init__(self):
            self.starts = []

        def fetch(self, series_id, start):
            self.starts.append(start)
            idx = pd.date_range("2026-01-01", periods=3, freq="MS")
            return pd.Series([3.0, 3.1, 3.2], index=idx)

    fred = FakeFred()
    with session_scope(engine) as s:
        assert update_series(s, fred, "UNRATE", "Unemployment", "employment", date(2000, 1, 1)) == 3
    with session_scope(engine) as s:
        update_series(s, fred, "UNRATE", "Unemployment", "employment", date(2000, 1, 1))
        assert s.scalar(select(func.count()).select_from(MacroObservation)) == 3
    assert fred.starts[0] == date(2000, 1, 1)
    assert fred.starts[1] == date(2026, 3, 1) - timedelta(days=120)  # revision window


# --- SEC EDGAR ---------------------------------------------------------------

ACCN = "0000320193-26-000077"


def _fact(val, end, start=None, accn=ACCN, fp="Q3"):
    item = {"val": val, "end": end, "accn": accn, "fy": 2026, "fp": fp, "form": "10-Q", "filed": "2026-08-01"}
    if start:
        item["start"] = start
    return item


def _usd(*items):
    return {"units": {"USD": list(items)}}


COMPANY_FACTS = {
    "facts": {
        "us-gaap": {
            "RevenueFromContractWithCustomerExcludingAssessedTax": _usd(
                _fact(100.0, "2026-06-27", "2026-03-29"),  # quarter
                _fact(300.0, "2026-06-27", "2025-09-28"),  # year to date
                _fact(90.0, "2025-06-28", "2025-03-30"),  # prior-year comparative
            ),
            "NetIncomeLoss": _usd(_fact(25.0, "2026-06-27", "2026-03-29"), _fact(70.0, "2026-06-27", "2025-09-28")),
            "EarningsPerShareDiluted": {"units": {"USD/shares": [_fact(1.5, "2026-06-27", "2026-03-29")]}},
            "NetCashProvidedByUsedInOperatingActivities": _usd(_fact(80.0, "2026-06-27", "2025-09-28")),
            "PaymentsToAcquirePropertyPlantAndEquipment": _usd(_fact(20.0, "2026-06-27", "2025-09-28")),
            "Assets": _usd(_fact(1000.0, "2026-06-27"), _fact(900.0, "2025-09-27")),
            "Liabilities": _usd(_fact(700.0, "2026-06-27")),
            "StockholdersEquity": _usd(_fact(300.0, "2026-06-27")),
            "LongTermDebtNoncurrent": _usd(_fact(150.0, "2026-06-27")),
            "LongTermDebtCurrent": _usd(_fact(20.0, "2026-06-27")),
            "CommercialPaper": _usd(_fact(10.0, "2026-06-27")),
            "CashAndCashEquivalentsAtCarryingValue": _usd(_fact(50.0, "2026-06-27")),
        }
    }
}
FILING = FilingRef(ACCN, "10-Q", date(2026, 8, 1), date(2026, 6, 27), "aapl-20260627.htm")


def test_extract_metrics_picks_quarter_not_ytd():
    m = extract_metrics(FactIndex(COMPANY_FACTS), FILING)
    assert m["revenue"] == 100.0
    assert m["net_income"] == 25.0
    assert m["eps_diluted"] == 1.5
    assert m["period_days"] == 90
    assert m["fiscal_year"] == 2026 and m["fiscal_period"] == "Q3"
    # 10-Q cash flow is year-to-date only
    assert m["operating_cash_flow"] == 80.0 and m["cash_flow_period_days"] == 272
    assert m["free_cash_flow"] == 60.0
    assert m["total_assets"] == 1000.0
    assert m["total_debt"] == 180.0  # 150 + 20 + 10 commercial paper
    assert m["debt_to_equity"] == pytest.approx(0.6)
    assert m["net_margin"] == pytest.approx(0.25)


def test_extract_metrics_falls_back_to_balance_sheet_date():
    m = extract_metrics(FactIndex(COMPANY_FACTS), FilingRef(ACCN, "10-Q", date(2026, 8, 1), None, "x.htm"))
    assert m["report_date"] == date(2026, 6, 27)


def test_total_debt_does_not_double_count_debt_current():
    facts = {"facts": {"us-gaap": {**COMPANY_FACTS["facts"]["us-gaap"],
                                   "DebtCurrent": _usd(_fact(30.0, "2026-06-27"))}}}
    m = extract_metrics(FactIndex(facts), FILING)
    assert m["total_debt"] == 180.0  # 150 noncurrent + 30 DebtCurrent (includes CP)


def test_extract_metrics_none_when_filing_not_in_xbrl():
    other = FilingRef("0000320193-26-999999", "10-Q", date(2026, 8, 1), date(2026, 6, 27), "x.htm")
    assert extract_metrics(FactIndex(COMPANY_FACTS), other) is None


def test_filings_block_keeps_only_10k_10q():
    block = {
        "form": ["4", "10-Q", "8-K", "10-K", "10-K/A"],
        "accessionNumber": ["a", "b", "c", "d", "e"],
        "filingDate": ["2026-08-02", "2026-08-01", "2026-07-01", "2025-11-01", "2025-12-01"],
        "reportDate": ["", "2026-06-27", "", "2025-09-27", "2025-09-27"],
        "primaryDocument": ["f4.xml", "q.htm", "8k.htm", "k.htm", "ka.htm"],
    }
    refs = list(_filings_from_block(block))
    assert [(r.form, r.accession_number) for r in refs] == [("10-Q", "b"), ("10-K", "d")]


def test_update_fundamentals_stores_once(engine):
    class FakeSEC:
        facts_calls = 0

        def cik_for(self, ticker):
            return 320193

        def submissions(self, cik):
            return {"name": "Apple Inc.", "sic": "3571", "sicDescription": "Electronic Computers",
                    "exchanges": ["Nasdaq"], "fiscalYearEnd": "0926"}

        def iter_filings(self, subs):
            yield FILING

        def company_facts(self, cik):
            self.facts_calls += 1
            return COMPANY_FACTS

    sec = FakeSEC()
    with session_scope(engine) as s:
        assert update_fundamentals(s, sec, "AAPL") == 1
    with session_scope(engine) as s:
        assert update_fundamentals(s, sec, "AAPL") == 0  # already stored -> companyfacts not re-downloaded
        assert sec.facts_calls == 1
        row = s.scalars(select(Fundamental)).one()
        assert row.filing_url.endswith("/320193/000032019326000077/aapl-20260627.htm")
        assert s.get(Company, "AAPL").name == "Apple Inc."


# --- news --------------------------------------------------------------------

GOOGLE_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>AAPL stock</title>
<item>
  <title>Apple beats earnings estimates - Reuters</title>
  <link>https://news.google.com/rss/articles/abc</link>
  <pubDate>Fri, 16 Oct 2026 17:44:53 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/x"&gt;Apple beats earnings estimates&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description>
  <source url="https://www.reuters.com">Reuters</source>
</item>
<item>
  <title>AAPL Stock Quote Price and Forecast - CNN</title>
  <link>https://news.google.com/rss/articles/def</link>
  <pubDate>Fri, 16 Oct 2026 17:00:00 GMT</pubDate>
  <source url="https://www.cnn.com">CNN</source>
</item>
<item>
  <title>Very old story - Reuters</title>
  <link>https://news.google.com/rss/articles/old</link>
  <pubDate>Fri, 01 Jan 2021 10:00:00 GMT</pubDate>
  <source url="https://www.reuters.com">Reuters</source>
</item>
</channel></rss>"""

YAHOO_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Yahoo</title>
<item>
  <title>UK regulator set to push Apple on iPhone payments</title>
  <link>https://finance.yahoo.com/news/x</link>
  <pubDate>Mon, 19 Oct 2026 08:13:45 +0000</pubDate>
  <description>&lt;p&gt;Under the &lt;b&gt;proposals&lt;/b&gt; the CMA &amp;amp; others&lt;/p&gt;</description>
</item>
</channel></rss>"""

NOW = datetime(2026, 10, 19, 12, 0)


def test_parse_google_feed_strips_publisher_and_quote_pages():
    rows = parse_feed(GOOGLE_RSS, "google_news", "AAPL", NOW, timedelta(days=7))
    assert len(rows) == 1
    row = rows[0]
    assert row["title"] == "Apple beats earnings estimates"
    assert row["publisher"] == "Reuters"
    assert row["summary"] is None  # Google's description just repeats the headline
    assert row["published_at"] == datetime(2026, 10, 16, 17, 44, 53)
    assert row["article_key"] == article_key("AAPL", "Apple beats earnings estimates!")


def test_parse_yahoo_feed_cleans_html_summary():
    (row,) = parse_feed(YAHOO_RSS, "yahoo_finance", "AAPL", NOW, timedelta(days=7))
    assert row["publisher"] == "Yahoo Finance"
    assert row["summary"] == "Under the proposals the CMA & others"
    assert row["published_at"] == datetime(2026, 10, 19, 8, 13, 45)


def test_clean_html_plain_text_passthrough():
    assert clean_html("  Fed   holds rates ") == "Fed holds rates"


def test_article_key_is_ticker_scoped():
    assert article_key("AAPL", "Same headline") != article_key("MSFT", "Same headline")
    assert article_key(None, "Same  Headline.") == article_key(None, "same headline")


def _two_sessions():
    day1 = pd.date_range("2026-10-15 13:30", periods=26, freq="15min")
    day2 = pd.date_range("2026-10-16 13:30", periods=26, freq="15min")
    closes = np.r_[np.arange(100.0, 126.0), np.arange(130.0, 156.0)]
    return pd.DataFrame({"close": closes}, index=day1.append(day2))


def test_compute_price_reactions_intraday_and_overnight():
    bars = _two_sessions()
    published = [
        datetime(2026, 10, 15, 14, 7),  # inside the 14:00 bar
        datetime(2026, 10, 15, 22, 0),  # after the close -> next session's open
        datetime(2026, 10, 14, 12, 0),  # before any bar
        datetime(2026, 10, 16, 19, 50),  # too fresh for a full 60-minute window
    ]
    res = compute_price_reactions(published, bars, bar_minutes=15, window_minutes=60)

    aligned, before, reaction = res[0]
    assert aligned == datetime(2026, 10, 15, 14, 0)
    assert before == 101.0  # close of the 13:45 bar
    assert reaction == pytest.approx(105.0 / 101.0 - 1)  # close of the 14:45 bar

    aligned, before, reaction = res[1]
    assert aligned == datetime(2026, 10, 16, 13, 30)
    assert before == 125.0  # previous session's last close
    assert reaction == pytest.approx(133.0 / 125.0 - 1)  # includes the overnight gap

    assert res[2] is None and res[3] is None


# --- sentiment -----------------------------------------------------------------

def test_lexicon_scorer_direction():
    pos, neg, neu = LexiconScorer().score([
        "Apple beats estimates as shares surge",
        "Tesla plunges after recall probe",
        "Company to hold annual shareholder meeting",
    ])
    assert pos.label == "positive" and pos.score > 0
    assert neg.label == "negative" and neg.score < 0
    assert neu.label == "neutral"


def _session_15m(day: str, closes: list[float]) -> pd.DataFrame:
    """15-minute bars of one New York session (09:30 to 15:45 starts), stored as naive UTC like the pipeline does."""
    starts = pd.date_range(f"{day} 09:30", f"{day} 15:45", freq="15min", tz="America/New_York")[: len(closes)]
    return pd.DataFrame({"timestamp": starts.tz_convert("UTC").tz_localize(None), "open": closes, "high": [c + 1 for c in closes],
                         "low": [c - 1 for c in closes], "close": closes, "adj_close": closes, "volume": [100] * len(closes)})


def test_daily_bar_built_from_15m_until_yahoo_posts_it(engine):
    from quant.ingestion.market_data import daily_from_intraday, load_bars, store_bars
    closes = [100.0 + i for i in range(26)]  # a full session: 26 bars, last one starts 15:45
    with session_scope(engine) as s:
        store_bars(s, "AAPL", "1d", pd.DataFrame([{"timestamp": pd.Timestamp("2026-10-28"), "open": 1, "high": 1, "low": 1,
                                                    "close": 99.0, "adj_close": 99.0, "volume": 1}]))
        store_bars(s, "AAPL", "15m", _session_15m("2026-10-29", closes))
        assert daily_from_intraday(s, "AAPL", now=pd.Timestamp("2026-10-29 19:55", tz="UTC")) == 0  # 15:55 New York: still trading
        assert daily_from_intraday(s, "AAPL", now=pd.Timestamp("2026-10-30 00:45", tz="UTC")) == 1  # 20:45 New York
        assert daily_from_intraday(s, "AAPL", now=pd.Timestamp("2026-10-30 00:50", tz="UTC")) == 0  # already there
    with session_scope(engine) as s:
        bar = load_bars(s, "AAPL", "1d").loc[pd.Timestamp("2026-10-29")]
        assert (bar.open, bar.high, bar.low, bar.close, bar.adj_close, bar.volume) == (100.0, 126.0, 99.0, 125.0, 125.0, 2600)
        # the official bar arrives on the next run and replaces the stand-in
        store_bars(s, "AAPL", "1d", pd.DataFrame([{"timestamp": pd.Timestamp("2026-10-29"), "open": 100, "high": 126.5, "low": 99,
                                                    "close": 125.3, "adj_close": 125.3, "volume": 3000}]))
    with session_scope(engine) as s:
        assert load_bars(s, "AAPL", "1d").loc[pd.Timestamp("2026-10-29")].close == 125.3


def test_no_daily_bar_from_an_unfinished_session(engine):
    from quant.ingestion.market_data import daily_from_intraday, store_bars
    with session_scope(engine) as s:
        store_bars(s, "AAPL", "15m", _session_15m("2026-10-29", [100.0] * 20))  # stops at 14:15
        assert daily_from_intraday(s, "AAPL", now=pd.Timestamp("2026-10-30 03:00", tz="UTC")) == 0
