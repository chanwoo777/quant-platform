"""When a source fails, the nightly job tries another way: CNBC for daily bars, the U.S. Treasury, the New York Fed
and CNBC for FRED series, Bing News for headlines, smaller batches for universe downloads. All offline."""
from datetime import date, datetime

import pandas as pd
import pytest
import requests

from quant.db import init_db, make_engine, session_scope
from quant.ingestion import macro_data, market_data, news_scraper

CNBC_DOC = {"barData": {"priceBars": [
    {"open": "100.0", "high": "102.0", "low": "99.0", "close": "101.5", "volume": 1000, "tradeTime": "20261029000000"},
    {"open": "101.5", "high": "104.0", "low": "101.0", "close": "103.0", "volume": "2000", "tradeTime": "20261030000000"},
    {"open": "x", "close": "1", "tradeTime": "bad"},
]}}


@pytest.fixture
def engine(tmp_path):
    return init_db(make_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


@pytest.fixture(autouse=True)
def reset_yahoo_breaker():
    market_data._yahoo["fails"] = 0
    yield
    market_data._yahoo["fails"] = 0


def test_cnbc_symbols_and_bars():
    assert market_data.cnbc_symbol("^GSPC") == ".SPX" and market_data.cnbc_symbol("BRK-B") == "BRK.B"
    assert market_data.cnbc_symbol("AAPL") == "AAPL" and market_data.cnbc_symbol("005930.KS") is None
    bars = market_data.parse_cnbc_bars(CNBC_DOC)
    assert list(bars["timestamp"]) == [pd.Timestamp("2026-10-29"), pd.Timestamp("2026-10-30")]
    assert bars.iloc[-1][["open", "high", "low", "close", "adj_close", "volume"]].tolist() == [101.5, 104.0, 101.0, 103.0, 103.0, 2000.0]


def test_daily_bars_fall_back_to_cnbc_and_stop_asking_yahoo(engine, monkeypatch):
    calls = {"yahoo": 0, "cnbc": 0}

    def yahoo_down(*a, **k):
        calls["yahoo"] += 1
        raise requests.ConnectionError("Yahoo unreachable")

    def cnbc(ticker, span="1Y", timeout=20.0):
        calls["cnbc"] += 1
        return market_data.parse_cnbc_bars(CNBC_DOC)

    monkeypatch.setattr(market_data, "fetch_history", yahoo_down)
    monkeypatch.setattr(market_data, "fetch_cnbc_daily", cnbc)
    with session_scope(engine) as s:
        for t in ("AAPL", "MSFT", "NVDA", "AMZN"):
            assert market_data.update_daily(s, t) == 2
        stored = market_data.load_bars(s, "AMZN", "1d")
    assert calls == {"yahoo": 3, "cnbc": 4}  # after 3 Yahoo failures in a row the 4th ticker goes straight to CNBC
    assert stored["close"].iloc[-1] == 103.0


def test_no_bars_anywhere_is_an_error_not_silence(engine, monkeypatch):
    monkeypatch.setattr(market_data, "fetch_history", lambda *a, **k: (_ for _ in ()).throw(requests.Timeout("slow")))
    monkeypatch.setattr(market_data, "fetch_cnbc_daily", lambda *a, **k: (_ for _ in ()).throw(requests.HTTPError("404")))
    with session_scope(engine) as s, pytest.raises(RuntimeError, match="no daily bars from Yahoo or CNBC"):
        market_data.update_daily(s, "AAPL")


def test_failed_universe_batch_is_retried_in_halves(engine, monkeypatch):
    sizes = []

    def download(chunk, **kwargs):
        sizes.append(len(chunk))
        if len(chunk) > 2:
            raise requests.Timeout("too big")
        idx = pd.DatetimeIndex(["2026-10-29", "2026-10-30"])
        return {t: pd.DataFrame({"Open": [1.0, 2.0], "High": [1.0, 2.0], "Low": [1.0, 2.0], "Close": [1.0, 2.0],
                                 "Adj Close": [1.0, 2.0], "Volume": [10, 20]}, index=idx) for t in chunk}

    monkeypatch.setattr(market_data, "download_daily", download)
    monkeypatch.setattr(market_data.time, "sleep", lambda s: None)
    result = market_data.update_daily_batch(engine, ["A", "B", "C", "D"], batch_size=4)
    assert sizes == [4, 2, 2] and not result.errors and result.rows == 8


TREASURY = 'Date,"1 Mo","3 Mo","2 Yr","10 Yr"\n10/30/2026,4.10,4.05,4.70,4.99\n10/29/2026,4.11,4.06,4.68,5.01\n'


class FakeHttp:
    """requests.Session stand-in: FRED fails, the Treasury and the New York Fed answer."""
    def __init__(self):
        self.urls = []

    def get(self, url, params=None, timeout=None):
        self.urls.append(url)
        if "stlouisfed" in url:
            raise requests.ConnectionError("FRED down")
        resp = requests.Response()
        resp.status_code = 200
        resp._content = (TREASURY if "treasury.gov" in url else
                         '{"refRates": [{"effectiveDate": "2026-10-30", "type": "EFFR", "percentRate": 4.33}]}').encode()
        return resp


def test_fred_down_uses_the_original_publishers(monkeypatch):
    monkeypatch.setattr(macro_data, "_fetch_via_datareader", lambda *a: (_ for _ in ()).throw(ImportError("no datareader")))
    client = macro_data.FredClient()
    client.session = FakeHttp()
    start = date(2026, 10, 29)
    assert client.fetch("DGS10", start).tolist() == [5.01, 4.99]
    assert client.fetch("T10Y2Y", start).tolist() == [0.33, 0.29]
    assert client.fred_down  # two connection failures in a row
    assert client.fetch("DFF", start).tolist() == [4.33]
    with pytest.raises(RuntimeError, match="no other free source"):
        client.fetch("CPIAUCSL", start)
    assert sum("stlouisfed" in u for u in client.session.urls) == 2  # FRED isn't asked again once it's down
    assert sum("treasury.gov" in u for u in client.session.urls) == 1  # one download per year, shared by the series
    assert client.fallbacks == {"DGS10": "U.S. Treasury", "T10Y2Y": "U.S. Treasury", "DFF": "New York Fed"}
    assert "while FRED was unavailable" in client.backend


BING = b"""<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=AAPL&amp;format=rss">
<channel><item><title>Apple shares climb after earnings</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fexample.com%2fapple&amp;c=1</link>
<pubDate>Fri, 30 Oct 2026 18:00:00 GMT</pubDate><News:Source>Example News</News:Source></item></channel></rss>"""


def test_empty_feeds_fall_back_to_bing(monkeypatch):
    asked = []

    def fetch(session, url, timeout):
        asked.append(url)
        return BING if "bing.com" in url else None  # every primary feed fails

    monkeypatch.setattr(news_scraper, "fetch_feed", fetch)
    monkeypatch.setattr(news_scraper, "universe_names", lambda tickers: {})
    monkeypatch.setattr(news_scraper, "utcnow", lambda: datetime(2026, 10, 31, 12, 0))
    monkeypatch.setattr(news_scraper.time, "sleep", lambda s: None)
    rows = news_scraper.collect_news(None, ["AAPL"], lookback_days=7, include_market=True)
    assert sum("bing.com" in u for u in asked) == 2  # AAPL and the market
    apple = [r for r in rows if r["ticker"] == "AAPL"]
    assert apple and apple[0]["source"] == "bing_news" and apple[0]["publisher"] == "Example News"
    assert apple[0]["url"] == "https://example.com/apple"
