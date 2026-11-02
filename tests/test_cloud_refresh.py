"""The 3-hourly GitHub Actions refresh (quant/web/cloud_refresh.py) patches the published files in place:
fresh snapshot, movers and headlines, everything else untouched, and a failed source leaves its part as it was.
All offline: the price and news fetchers are replaced."""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from quant import analytics as an
from quant.web import cloud_refresh as cr

ET = "America/New_York"


def bars(n=300, end="2026-10-30"):
    idx = pd.bdate_range(end=end, periods=n)
    close = 100 * np.exp(np.cumsum(np.full(n, 0.001)))
    df = pd.DataFrame({"open": close, "high": close * 1.01, "low": close * 0.99, "close": close, "adj_close": close,
                       "volume": 1e6}, index=idx)
    return an.add_indicators(df)


def test_todays_bar_waits_for_the_session_to_settle():
    b = bars(end="2026-11-02")
    during = cr.settled(b, pd.Timestamp("2026-11-02 14:00", tz=ET))
    after = cr.settled(b, pd.Timestamp("2026-11-02 18:00", tz=ET))
    assert during.index[-1] == pd.Timestamp("2026-10-30") and after.index[-1] == pd.Timestamp("2026-11-02")


def test_merge_news_keeps_published_copies_and_the_limit():
    old = [{"t": "2026-11-01 10:00", "title": "Apple beats", "react": 0.01},
           {"t": "2026-10-31 09:00", "title": "Older story", "react": None}]
    new = [{"t": "2026-11-02 08:00", "title": "Fresh story", "react": None},
           {"t": "2026-11-01 10:00", "title": "Apple  beats!", "react": None}]  # same headline, other punctuation
    merged = cr.merge_news(old, new, limit=2)
    assert [r["title"] for r in merged] == ["Fresh story", "Apple beats"] and merged[1]["react"] == 0.01


def test_markers_recomputed_only_for_fully_covered_sessions():
    daily = bars()
    old = [{"d": "2026-10-28", "n": 9, "score": 0.1}, {"d": "2026-10-29", "n": 5, "score": 0.0}]
    news = [{"t": "2026-10-28 10:00", "title": "a", "score": 0.5},  # the oldest session listed: may be cut off
            {"t": "2026-10-29 10:00", "title": "b", "score": 0.2},
            {"t": "2026-10-29 17:30", "title": "c", "score": -0.4}]  # after the close: next session
    out = cr.merge_markers(old, daily, news)
    assert [(m["d"], m["n"]) for m in out] == [("2026-10-28", 9), ("2026-10-29", 1), ("2026-10-30", 1)]


@pytest.fixture
def site(tmp_path):
    data = tmp_path / "data"
    (data / "deep").mkdir(parents=True)
    write = lambda name, obj: (data / name).write_text(json.dumps(obj), encoding="utf-8")  # noqa: E731
    write("meta.json", {"generated_at": "2026-11-01T22:00:00+00:00", "prices_as_of": "2026-10-29",
                        "latest_headline_et": "2026-10-31 09:00", "deep": [{"ticker": "AAPL", "name": "Apple Inc."},
                                                                          {"ticker": "MSFT", "name": "Microsoft"}]})
    write("market.json", {"regime": {"label": "kept"}, "movers": [{"ticker": "AAPL", "close": 1.0, "score": 54.1},
                                                                   {"ticker": "MSFT", "close": 2.0, "score": 40.0}],
                          "news": [{"t": "2026-10-31 09:00", "ticker": None, "title": "Old market story"}]})
    write("status.json", {"sources": [{"id": "news", "last_success": None}, {"id": "deep-prices", "last_success": None}]})
    for t in ("AAPL", "MSFT"):
        write(f"deep/{t}.json", {"ticker": t, "name": t, "sic_code": "3571", "snapshot": {"close": 1.0}, "markers": [],
                                 "news": [], "fin": {"kept": True}, "rolling": {"FF3": {}}})
    return tmp_path


def fake_news():
    df = pd.DataFrame([
        {"ticker": "AAPL", "title": "Apple climbs", "publisher": "Example", "url": "https://example.com/a",
         "published_at": datetime(2026, 10, 30, 14, 0), "sentiment_score": 0.6, "relevance": 1.0},
        {"ticker": None, "title": "Stocks rally", "publisher": "Example", "url": "https://example.com/m",
         "published_at": datetime(2026, 11, 2, 9, 0), "sentiment_score": 0.2, "relevance": None},
    ])
    df["published_et"] = cr.to_et(df.published_at)
    return df


def read(site, name):
    return json.loads((site / "data" / name).read_text(encoding="utf-8"))


def test_refresh_patches_prices_and_news_and_leaves_the_rest(site, monkeypatch):
    monkeypatch.setattr(cr, "fetch_prices", lambda engine, tickers: {"AAPL": bars()})  # MSFT failed on both sources
    monkeypatch.setattr(cr, "fetch_news", lambda engine, deep: fake_news())
    result = cr.refresh(site, now=datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc))
    assert result["prices"] == "1/2 tickers" and result["headlines"] == 2

    aapl, msft = read(site, "deep/AAPL.json"), read(site, "deep/MSFT.json")
    assert aapl["snapshot"]["date"] == "2026-10-30" and aapl["snapshot"]["close"] == pytest.approx(bars().close.iloc[-1], rel=1e-5)
    assert aapl["news"][0]["title"] == "Apple climbs" and aapl["news"][0]["tone"] == "bullish"
    assert aapl["fin"] == {"kept": True} and aapl["rolling"] == {"FF3": {}}
    assert msft["snapshot"] == {"close": 1.0}  # not refreshed: stays as published

    market = read(site, "market.json")
    assert market["regime"] == {"label": "kept"}
    assert market["movers"][0]["score"] == 54.1 and market["movers"][0]["close"] != 1.0
    assert market["movers"][1] == {"ticker": "MSFT", "close": 2.0, "score": 40.0}
    assert [r["title"] for r in market["news"]] == ["Stocks rally", "Old market story", "Apple climbs"]

    meta = read(site, "meta.json")
    assert meta["generated_at"] == "2026-11-02T12:00:00+00:00" and meta["prices_as_of"] == "2026-10-30"
    assert meta["latest_headline_et"] == "2026-11-02 04:00"
    status = {s["id"]: s for s in read(site, "status.json")["sources"]}
    assert status["news"]["last_success"] == meta["generated_at"]
    assert status["deep-prices"]["last_success"] is None  # only 1 of 2 tickers refreshed


def test_refresh_fails_loudly_when_nothing_could_be_fetched(site, monkeypatch):
    monkeypatch.setattr(cr, "fetch_prices", lambda engine, tickers: {})
    monkeypatch.setattr(cr, "fetch_news", lambda engine, deep: (_ for _ in ()).throw(ConnectionError("offline")))
    with pytest.raises(RuntimeError, match="neither prices nor headlines"):
        cr.refresh(site)
    assert read(site, "meta.json")["generated_at"] == "2026-11-01T22:00:00+00:00"
