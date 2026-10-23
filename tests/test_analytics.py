"""Offline tests for Phase 2 analytics (synthetic data, no network)."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest
from sqlalchemy import text

from quant import analytics as an
from quant.db import Base, init_db, make_engine, session_scope, upsert
from quant.models import Company, NewsArticle, PriceBar


@pytest.fixture
def engine(tmp_path):
    return init_db(make_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


def _bars(close, start="2025-01-02", volume=1e6) -> pd.DataFrame:
    close = np.asarray(close, dtype=float)
    idx = pd.bdate_range(start, periods=len(close))
    return pd.DataFrame(
        {"open": close, "high": close * 1.01, "low": close * 0.99, "close": close, "adj_close": close,
         "volume": volume},
        index=pd.Index(idx, name="timestamp"),
    )


# --- indicators ----------------------------------------------------------------

def test_add_indicators_detects_golden_cross_after_turn():
    close = np.r_[np.linspace(200, 100, 250), np.linspace(100, 220, 150)]
    df = an.add_indicators(_bars(close))

    assert df["sma_50"].iloc[:49].isna().all() and df["sma_200"].iloc[:199].isna().all()
    assert df["sma_50"].iloc[60] == pytest.approx(close[11:61].mean())
    assert df["ma_trend"].iloc[240] == -1
    crosses = df.index[df["golden_cross"]]
    assert len(crosses) == 1 and crosses[0] > df.index[250]
    assert not df["death_cross"].any()
    assert df["rsi_14"].dropna().between(0, 100).all()
    assert (df["bb_upper"].dropna() >= df["bb_lower"].dropna()).all()
    assert df["atr_14"].iloc[:13].isna().all() and (df["atr_14"].iloc[13:] > 0).all()

    snap = an.indicator_snapshot(df)
    assert snap["last_cross"]["type"] == "golden"
    assert any("golden-cross alignment" in r for r in snap["readings"])


# --- regime --------------------------------------------------------------------

RAW = an.RegimeParams(trend_confirm_days=1, vol_confirm_days=1)  # day-by-day labels, no smoothing


def test_classify_regimes_labels():
    s = lambda *v: pd.Series(v, dtype=float)
    out = an.classify_regimes(
        close=s(110, 110, 90, 101, 110),
        sma_50=s(105, 105, 95, 100.5, np.nan),
        sma_200=s(100, 100, 100, 100, np.nan),
        vix=s(12, 30, 20, 18, 15),
        params=RAW,
    )
    assert out["regime"].tolist()[:4] == ["Bull Trending", "Bull Volatile", "Bear Trending", "Sideways"]
    assert pd.isna(out["regime"].iloc[4])  # still warming up


def test_labels_derisk_at_once_but_rerisk_after_confirmation():
    vix = pd.Series([14, 30, 14, 30, 14, 14, 14, 14, 14, 20], dtype=float)
    flat = pd.Series(100.0, index=vix.index)
    out = an.classify_regimes(flat * 1.1, flat * 1.05, flat, vix)  # tuned params: 5-day confirmation
    assert out["volatility"].tolist() == [
        "Calm", "Volatile", "Volatile", "Volatile",  # spike applies at once; one calm day is not enough
        "Volatile", "Volatile", "Volatile", "Volatile",
        "Calm",  # fifth consecutive calm reading
        "Normal",  # riskier again: immediate
    ]


def test_twenty_percent_drawdown_is_bear_before_death_cross():
    close = pd.Series([150.0] * 10 + [110.0])
    out = an.classify_regimes(close, sma_50=pd.Series(120.0, index=close.index),
                              sma_200=pd.Series(116.0, index=close.index), vix=pd.Series(40.0, index=close.index))
    assert out["trend"].iloc[-1] == "Bear"
    assert out["regime"].iloc[-1] == "Bear Volatile"


def test_macro_features_are_point_in_time():
    months = pd.date_range("2025-01-01", periods=16, freq="MS")
    macro = pd.DataFrame(
        {"CPILFESL": np.linspace(300, 312, 16), "UNRATE": [4.0] * 13 + [4.0, 4.6, 5.0]},
        index=months.date,
    )
    feats = an.macro_features(macro)

    first_yoy = feats["core_cpi_yoy"].first_valid_index()
    assert first_yoy == pd.Timestamp("2026-01-01") + pd.Timedelta(days=45)  # not usable on Jan 1
    assert feats["sahm_gap"].dropna().iloc[-1] == pytest.approx((4.0 + 4.6 + 5.0) / 3 - 4.0)


def test_regime_history_risk_score_renormalises_unknown_inputs():
    bench = an.add_indicators(_bars(np.linspace(100, 160, 300)))
    vix = pd.Series(14.0, index=bench.index)
    macro = pd.DataFrame({"T10Y2Y": -0.3}, index=bench.index.date)
    last = an.market_regime_history(bench, vix, macro).iloc[-1]

    assert last.regime == "Bull Trending" and bool(last.curve_inverted)
    # trend 0 (w .30) + volatility 0 (w .25) + inverted curve 1 (w .075); other inputs unknown
    assert last.risk_score == pytest.approx(0.075 / (0.30 + 0.25 + 0.075))
    assert last.stance == "Risk-On"
    regime = an.current_regime(an.market_regime_history(bench, vix, macro), "SPY")
    assert regime.label == "Bull Trending" and any("inverted" in r for r in regime.reasons)


# --- anomalies -----------------------------------------------------------------

def _noisy_returns(n=100, seed=0):
    return np.random.default_rng(seed).normal(0, 0.005, n)


def test_detect_anomalies_zscore_rule_survives_prior_shock():
    rets = _noisy_returns()  # 0.5% daily vol
    rets[80], rets[90], rets[95] = -0.06, -0.025, 0.012  # shock, aftershock, too small
    bars = _bars(100 * np.cumprod(1 + rets), start="2026-06-01")
    flagged = an.detect_anomalies(bars, "1d")

    # robust sigma: the -6% shock doesn't inflate volatility and hide the -2.5% aftershock
    assert list(flagged.index) == [bars.index[80], bars.index[90]]
    row = flagged.iloc[0]
    assert row["return"] == pytest.approx(-0.06)
    # window: previous session close -> this session close, in UTC (EDT = UTC-4)
    assert row.window_end == pd.Timestamp(bars.index[80].date()) + pd.Timedelta(hours=20)
    assert row.window_start == pd.Timestamp(bars.index[79].date()) + pd.Timedelta(hours=20)


def test_absolute_rule_catches_big_moves_in_volatile_stocks():
    rets = np.clip(np.random.default_rng(5).normal(0, 0.04, 100), -0.07, 0.07)  # TSLA-like 4% daily vol
    rets[70], rets[80] = -0.09, 0.06
    bars = _bars(100 * np.cumprod(1 + rets), start="2026-06-01")
    flagged = an.detect_anomalies(bars, "1d").index
    assert bars.index[70] in flagged  # >= 8%: always notable
    assert bars.index[80] not in flagged  # 6% is a routine day at this volatility


def test_intraday_opening_gaps_have_their_own_scale():
    rng = np.random.default_rng(7)
    sessions = pd.bdate_range("2026-08-03", periods=30)
    index, rets = [], []
    for i, day in enumerate(sessions):
        bars_utc = pd.date_range(day + pd.Timedelta(hours=13, minutes=30), periods=26, freq="15min")
        index.extend(bars_utc)
        day_rets = rng.normal(0, 0.001, 26)  # 0.1% per 15-minute bar
        day_rets[0] = rng.normal(0, 0.008)  # routine overnight gaps, ~10x a 15-minute bar
        if i == 25:
            day_rets[10] = 0.015  # genuine intraday jump
        rets.extend(day_rets)
    close = 100 * np.cumprod(1 + np.array(rets))
    bars = pd.DataFrame({"close": close, "volume": 1e5}, index=pd.DatetimeIndex(index))

    flagged = an.detect_anomalies(bars, "15m")
    assert list(flagged.index) == [index[25 * 26 + 10]]  # the jump, not the routine gaps
    market = pd.Series(_noisy_returns(300, seed=1))
    assert an.estimate_beta(2 * market, market) == pytest.approx(2.0)
    assert an.estimate_beta(market.head(10), market.head(10)) == 1.0  # too little data


WINDOW_START, WINDOW_END = datetime(2026, 10, 12, 20), datetime(2026, 10, 13, 20)


def _anomaly(driver="idiosyncratic", ret=-0.06):
    return an.Anomaly(
        ticker="JNJ", interval="1d", timestamp=datetime(2026, 10, 13), window_start=WINDOW_START,
        window_end=WINDOW_END, return_pct=ret, zscore=-5.0, volume_ratio=3.0, direction="drop",
        market_return=0.001, beta=0.5, excess_return=ret, driver=driver,
    )


def _articles():
    rows = [
        (1, "JNJ", "J&J posts weak medical device sales, shares fall", 1.0, -0.97, datetime(2026, 10, 13, 10, 52)),
        (2, "JNJ", "Johnson & Johnson stock may be undervalued", 1.0, 0.5, datetime(2026, 10, 13, 11, 0)),
        (3, "JNJ", "Pfizer falls as J&J rates it underweight", 0.15, -0.8, datetime(2026, 10, 13, 12, 0)),
        (4, None, "J&J shares slide after earnings miss", None, -0.9, datetime(2026, 10, 13, 15, 0)),
        (5, None, "Fed holds rates steady", None, 0.0, datetime(2026, 10, 13, 18, 0)),
        (6, "JNJ", "J&J schedules earnings call", 1.0, 0.0, datetime(2026, 10, 10, 12, 0)),  # too early
        (7, "JNJ", "Why J&J stock tumbled today", 1.0, -0.9, datetime(2026, 10, 14, 2, 0)),  # coverage after
    ]
    return pd.DataFrame(
        [{"id": i, "ticker": t, "title": title, "summary": None, "publisher": "X", "url": f"u{i}",
          "published_at": ts, "relevance": rel, "sentiment_label": None, "sentiment_score": s}
         for i, t, title, rel, s, ts in rows]
    )


def test_match_news_ranks_and_filters():
    aliases = ("Johnson & Johnson", "J&J")
    matches = an.match_news(_anomaly(), _articles(), aliases, timedelta(hours=18), max_matches=10)
    ids = [m.article_id for m in matches]

    assert ids[0] == 1  # on-topic, during the move, strongly agreeing sentiment
    assert set(ids) == {1, 2, 4, 7}  # 3 = analyst-only, 5 = off-topic, 6 = outside window
    by_id = {m.article_id: m for m in matches}
    assert by_id[4].scope == "market" and by_id[7].timing == "after"
    assert by_id[1].score > by_id[2].score  # sentiment agreement breaks the tie


def test_market_driven_move_accepts_market_headlines():
    matches = an.match_news(_anomaly(driver="market"), _articles(), ("J&J",), timedelta(hours=18), max_matches=10)
    assert 5 in {m.article_id for m in matches}


def test_match_news_handles_missing_text_as_nan():
    # pandas 3 turns None into NaN in mixed text columns (as when loaded from SQL)
    articles = _articles()
    articles["summary"] = pd.Series(["J&J summary"] + [None] * (len(articles) - 1), dtype="str")
    articles["publisher"] = pd.Series([None] * len(articles), dtype="str")
    matches = an.match_news(_anomaly(), articles, ("J&J",), timedelta(hours=18), max_matches=10)
    assert matches and matches[0].article_id == 1


def test_explain_without_news_coverage():
    text_ = an.explain(_anomaly(), coverage_start=datetime(2026, 11, 1))
    assert text_.startswith("JNJ fell 6.0% on 2026-10-13") and "No news archived" in text_


def test_explain_anomalies_end_to_end(engine):
    rets = _noisy_returns(120, seed=3)
    rets[-1] = -0.07
    stock = _bars(100 * np.cumprod(1 + rets), start="2026-04-24")
    market = _bars(np.full(120, 500.0) * np.cumprod(1 + _noisy_returns(120, seed=4) / 5), start="2026-04-24")
    day = stock.index[-1]

    def rows(ticker, bars):
        return [{"ticker": ticker, "interval": "1d", "timestamp": ts.to_pydatetime(), "open": r.open, "high": r.high,
                 "low": r.low, "close": r.close, "adj_close": r.adj_close, "volume": int(r.volume)}
                for ts, r in bars.iterrows()]

    with session_scope(engine) as s:
        upsert(s, PriceBar, rows("ACME", stock), ["ticker", "interval", "timestamp"])
        upsert(s, PriceBar, rows("SPY", market), ["ticker", "interval", "timestamp"])
        upsert(s, Company, [{"ticker": "ACME", "cik": 1, "name": "ACME WIDGETS CORP"}], ["ticker"])
        s.add(NewsArticle(article_key="k", ticker="ACME", source="google_news", publisher="Reuters",
                          title="Acme Widgets plunges after guidance cut", url="u",
                          published_at=day.to_pydatetime() + timedelta(hours=14), sentiment_score=-0.9,
                          relevance=1.0))

    with session_scope(engine) as s:
        found = an.explain_anomalies(s, "ACME", "1d", since=day - pd.Timedelta(days=1))
    assert len(found) == 1
    a = found[0]
    assert a.driver == "idiosyncratic" and a.return_pct == pytest.approx(-0.07)
    assert a.matches[0].title == "Acme Widgets plunges after guidance cut"
    assert "Likely catalyst" in a.explanation
    assert an.anomalies_frame(found).loc[0, "headline"] == a.matches[0].title


# --- schema migration ------------------------------------------------------------

def test_init_db_adds_new_nullable_columns(tmp_path):
    engine = make_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE news_articles DROP COLUMN relevance"))
    init_db(engine)
    with engine.connect() as conn:
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(news_articles)"))}
    assert "relevance" in cols
