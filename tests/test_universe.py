"""Offline tests for the global universe (discovery parsing, price store, scoring)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant import analytics as an
from quant.universe import prices, scoring, sources

# --- discovery ----------------------------------------------------------------------------


def _quote(symbol, name, region, cap, currency="USD", exchange="NMS", price=100.0, adv_shares=1e6, sector="Technology"):
    return {"symbol": symbol, "longName": name, "quoteType": "EQUITY", "exchange": exchange, "currency": currency,
            "marketCap": cap, "regularMarketPrice": price, "averageDailyVolume3Month": adv_shares,
            "averageAnalystRating": "1.8 - Buy", "_region": region, "_market": sources.REGIONS[region][0],
            "_sector": sector}


FX = {"USD": 1.0, "GBP": 1.25, "GBp": 0.0125, "EUR": 1.1, "TWD": 0.031}


def test_stock_rows_dedupes_cross_listings_and_keeps_most_liquid():
    quotes = [
        _quote("TSM", "Taiwan Semiconductor Manufacturing Company Limited", "us", 2e12, adv_shares=2e7),
        _quote("2330.TW", "Taiwan Semiconductor Manufacturing Co., Ltd.", "tw", 6e13, "TWD", "TAI", 1500.0, 3e6),
        _quote("NVDA", "NVIDIA Corporation", "us", 5e12, adv_shares=2e8),
        _quote("NVD.DE", "NVIDIA Corp", "de", 4.5e12, "EUR", "GER", adv_shares=1e4),
        _quote("APC.F", "Apple Inc.", "de", 4e12, "EUR", "FRA"),  # secondary venue
        _quote("0R2V.L", "Apple Inc.", "gb", 4e12, "USD", "LSE"),  # LSE international line
        _quote("TINY", "Tiny Co", "us", 5e8),  # below the floor
    ]
    df = sources.stock_rows(quotes, FX, 1e9).set_index("symbol")
    assert set(df.index) == {"TSM", "NVDA"}
    assert df.loc["TSM", "also_listed"] == "2330.TW" and df.loc["NVDA", "also_listed"] == "NVD.DE"
    assert df.loc["NVDA", "analyst_rating"] == 1.8 and df.loc["NVDA", "analyst_label"] == "Buy"


def test_pence_quotes_use_pound_market_caps():
    # Yahoo quotes AZN.L in pence but reports its market cap in pounds.
    df = sources.stock_rows([_quote("AZN.L", "AstraZeneca PLC", "gb", 2.05e11, "GBp", "LSE", 12400.0)], FX, 1e9)
    assert df.market_cap_usd.iloc[0] == pytest.approx(2.05e11 * 1.25)


def test_normalize_name():
    assert sources.normalize_name("Samsung Electronics Co., Ltd.") == sources.normalize_name("SAMSUNG ELECTRONICS CO LTD")
    assert sources.normalize_name(float("nan")) == ""


def test_derivative_coins_are_excluded():
    assert sources.is_derivative_coin("usdt", "Tether", 1.0)
    assert sources.is_derivative_coin("wbtc", "Wrapped Bitcoin", 60000.0)
    assert sources.is_derivative_coin("steth", "Lido Staked Ether", 3000.0)
    assert sources.is_derivative_coin("xusd", "Some Dollar", 0.999)
    assert not sources.is_derivative_coin("btc", "Bitcoin", 60000.0)
    assert not sources.is_derivative_coin("paxg", "PAX Gold", 2400.0)
    # tokenized funds and non-USD fiat stablecoins
    assert sources.is_derivative_coin("jaaa", "Janus Henderson Anemoy AAA CLO Fund", 1.05)
    assert sources.is_derivative_coin("ustbl", "Spiko US T-Bills Money Market Fund", 1.1)
    assert sources.is_derivative_coin("jpyc", "JPY Coin", 0.0063)
    assert sources.is_derivative_coin("u", "United Stables", 0.9995)
    assert not sources.is_derivative_coin("aero", "Aerodrome Finance", 0.9)
    assert not sources.is_derivative_coin("ldo", "Lido DAO", 1.2)


def test_crypto_tickers_resolved_by_price(tmp_path, monkeypatch):
    # Yahoo's plain ARB-USD is another coin, Uniswap is UNI7083-USD, and XYZ isn't on Yahoo.
    yahoo = {"BTC-USD": 60000.0, "ARB-USD": 0.004, "ARB11841-USD": 0.41, "UNI7083-USD": 7.9}
    searches = []
    monkeypatch.setattr(sources, "_last_closes", lambda syms: {s: yahoo[s] for s in syms if s in yahoo})
    monkeypatch.setattr(sources, "search_yahoo_crypto", lambda base, name: searches.append(base) or
                        [s for s in yahoo if s.startswith(base) and s != f"{base}-USD"])
    coins = pd.DataFrame({"symbol": ["BTC-USD", "ARB-USD", "UNI-USD", "XYZ-USD"],
                          "name": ["Bitcoin", "Arbitrum", "Uniswap", "Xyz"],
                          "coingecko_id": ["bitcoin", "arbitrum", "uniswap", "xyz"], "price": [61000.0, 0.4, 8.0, 2.0]})
    cache = tmp_path / "crypto_symbols.json"
    assert sources.resolve_yahoo_symbols(coins, cache).tolist() == ["BTC-USD", "ARB11841-USD", "UNI7083-USD", "XYZ-USD"]
    assert searches == ["ARB", "UNI", "XYZ"]
    searches.clear()  # the next day the cache answers, and XYZ isn't searched again for a week
    assert sources.resolve_yahoo_symbols(coins, cache).tolist() == ["BTC-USD", "ARB11841-USD", "UNI7083-USD", "XYZ-USD"]
    assert searches == []


def test_parse_nasdaq_directory_keeps_live_etfs():
    text = ("ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n"
            "SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY\n"
            "BRK.B|Berkshire Hathaway Inc. Class B|N|BRK.B|N|100|N|BRK=B\n"
            "ZZZT|Test ETF|P|ZZZT|Y|100|Y|ZZZT\n"
            "File Creation Time: 1020202600:00|||||||\n")
    df = sources.parse_nasdaq_directory(text, "ACT Symbol")
    assert df.symbol.tolist() == ["SPY"]


# --- price store ------------------------------------------------------------------------------

def test_rebased_symbols_detects_split_but_not_last_bar_revision():
    idx = pd.bdate_range("2026-10-01", periods=5)
    stored = pd.DataFrame({"A": 100.0, "B": 50.0}, index=idx)
    fresh = stored.copy()
    fresh["A"] = 10.0  # 10-for-1 split rescaled the history
    fresh.loc[idx[-1], "B"] = 51.0  # the last stored bar was captured mid-session
    assert prices.rebased_symbols(stored, fresh) == ["A"]


def test_illiquid_etfs_rechecked_weekly(tmp_path, monkeypatch):
    import json

    from quant.universe import refresh

    monkeypatch.setattr(prices, "store_dir", lambda: tmp_path)
    (tmp_path / "etf_liquidity_checked.json").write_text(json.dumps(
        {"SPY": "2026-10-19", "THIN": "2026-10-19", "OLDTHIN": "2026-10-10"}))
    rows = [("SPY", True), ("THIN", False), ("OLDTHIN", False), ("NEWETF", False)]
    assert refresh.etfs_to_download(rows, pd.Timestamp("2026-10-20")) == ["SPY", "OLDTHIN", "NEWETF"]


def test_update_merges_refresh_and_new_symbols(tmp_path, monkeypatch):
    monkeypatch.setattr(prices, "store_dir", lambda: tmp_path)
    idx = pd.bdate_range("2026-09-01", periods=30)
    prices.save("close", pd.DataFrame({"A": 10.0, "OLD": 5.0}, index=idx[:-1]))
    prices.save("volume", pd.DataFrame({"A": 1e6, "OLD": 1e6}, index=idx[:-1]))

    def fake_download(symbols, period, **_):
        dates = idx if period == "2y" else idx[-5:]
        frame = pd.DataFrame({s: 11.0 if s == "B" else 10.0 for s in symbols if s != "MISSING"}, index=dates)
        if "A" in frame:
            frame.loc[idx[-1], "A"] = np.nan  # today's bar not published yet
        return {"close": frame, "volume": frame * 0 + 1e6}

    monkeypatch.setattr(prices, "download", fake_download)
    stats = prices.update(["A", "B", "MISSING"], prune=True)
    close = prices.load("close")
    assert set(close.columns) == {"A", "B"} and stats["missing"] == 1  # OLD pruned
    assert close["B"].notna().sum() == 30 and close["A"].iloc[-2] == 10.0


# --- scoring ---------------------------------------------------------------------------------

def _series(n=420, drift=0.001, seed=0, start="2025-01-01", freq="B"):
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=n, freq=freq)
    return pd.Series(100 * np.cumprod(1 + drift + rng.normal(0, 0.01, n)), index=idx)


def test_series_metrics_match_phase_2_indicators():
    s = _series()
    m = scoring.series_metrics(s.index.values, s.to_numpy(), np.full(len(s), 1e6), False,
                               np.datetime64(s.index[-1]))
    ref = an.add_indicators(pd.DataFrame({"open": s, "high": s, "low": s, "close": s, "adj_close": s, "volume": 1.0}))
    assert m["sma_50"] == pytest.approx(ref.sma_50.iloc[-1])
    assert m["sma_200"] == pytest.approx(ref.sma_200.iloc[-1])
    assert m["rsi_14"] == pytest.approx(ref.rsi_14.iloc[-1], abs=0.5)
    assert m["ma_alignment"] == (1 if ref.ma_trend.iloc[-1] > 0 and s.iloc[-1] > ref.sma_200.iloc[-1] else
                                 -1 if ref.ma_trend.iloc[-1] < 0 and s.iloc[-1] < ref.sma_200.iloc[-1] else 0)
    target = s.index[-1] - pd.Timedelta(days=30)
    assert m["ret_1m"] == pytest.approx(s.iloc[-1] / s.asof(target) - 1)
    assert m["mom_12_1"] == pytest.approx(s.asof(target) / s.asof(s.index[-1] - pd.Timedelta(days=365)) - 1)
    assert len(m["sparkline"]) == 42


def test_crypto_momentum_uses_calendar_days():
    s = _series(n=500, freq="D")
    m = scoring.series_metrics(s.index.values, s.to_numpy(), np.ones(len(s)), True, np.datetime64(s.index[-1]))
    assert m["mom_12_1"] == pytest.approx(s.iloc[-31] / s.iloc[-366] - 1)


def test_unusual_move_rule():
    s = _series(n=120, drift=0.0)
    v = s.to_numpy().copy()
    v[-1] = v[-2] * 0.91  # -9% day
    m = scoring.series_metrics(s.index.values, v, np.ones(len(v)), False, np.datetime64(s.index[-1]))
    assert m["unusual"] and m["zscore_1d"] < -3
    m = scoring.series_metrics(s.index.values, v, np.ones(len(v)), True, np.datetime64(s.index[-1]))
    assert m["unusual"]  # -9% is still >= 3 robust sigma at 1% daily vol, even for crypto


def test_peer_pct_falls_back_for_thin_groups():
    values = pd.Series([1.0, 2.0, 3.0, 10.0, 20.0])
    groups = pd.Series(["big"] * 3 + ["thin"] * 2)
    pct = scoring.peer_pct(values, groups, min_peers=3)
    assert pct.tolist()[:3] == [0.0, 0.5, 1.0]  # ranked within its own group
    assert pct.iloc[3] == pytest.approx(0.75) and pct.iloc[4] == pytest.approx(1.0)  # thin group -> global
    assert scoring.peer_pct(values, groups, higher_better=False, min_peers=3).iloc[0] == 1.0


def _frame():
    rows = []
    for i in range(30):
        rows.append({"symbol": f"S{i}", "asset_class": "stock", "market": "Korea" if i % 2 else "US",
                     "sector": "Technology", "ma_spread": i / 100, "dist_200": i / 100, "mom_12_1": i / 50,
                     "mom_6_1": i / 60, "volatility": 0.2 + i / 100, "max_drawdown_1y": -0.1 - i / 200,
                     "pe_current_year": 30 - i / 2, "trailing_pe": 25.0, "price_to_book": 3.0, "ev_to_ebitda": 12.0,
                     "dividend_yield": 1.0, "return_on_equity": 0.1, "profit_margin": 0.1, "debt_to_equity": 50.0,
                     "revenue_growth": 0.05, "earnings_growth": 0.05, "analyst_rating": 2.0, "analyst_label": "Buy",
                     "expense_ratio": np.nan, "ma_alignment": 1 if i >= 15 else -1, "cross_type": None,
                     "cross_sessions_ago": np.nan, "unusual": False, "ret_1d": 0.0, "zscore_1d": 0.0})
    return pd.DataFrame(rows).set_index("symbol")


def test_scores_and_signals():
    df = scoring.score_frame(_frame())
    assert df.loc["S29", "composite"] > df.loc["S0", "composite"]
    regimes = pd.DataFrame({"trend": ["Bull", "Bear"]}, index=["US", "Korea"])
    out = scoring.add_signals(df, regimes)
    assert out.loc["S28", "signal"] == "BUY"  # US, up-trend, strong scores
    assert out.loc["S29", "signal"] == "HOLD" and "Bear regime" in out.loc["S29", "rationale"]  # Korea in Bear
    assert out.loc["S0", "signal"] == "AVOID"
    assert out.loc["S28", "rationale"].startswith("Buy candidate:")


# --- watchlist ----------------------------------------------------------------------------------

def test_watchlist_tiers(tmp_path, monkeypatch):
    from quant import db
    from quant.db import init_db, make_engine, session_scope, upsert
    from quant.universe import models as um
    from quant.universe import watchlist as wl

    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'wl.db').as_posix()}"))
    monkeypatch.setattr(db, "get_engine", lambda: engine)
    monkeypatch.setattr(um, "get_engine", lambda: engine)
    um.ensure_tables(engine)
    with session_scope(engine) as s:
        upsert(s, um.Instrument, [
            {"symbol": "005930.KS", "name": "Samsung Electronics Co., Ltd.", "asset_class": "stock", "region": "kr",
             "market": "Korea", "currency": "KRW"},
            {"symbol": "ASML", "name": "ASML Holding N.V.", "asset_class": "stock", "region": "us", "market": "US",
             "currency": "USD"},
            {"symbol": "SOL-USD", "name": "Solana", "asset_class": "crypto", "region": "crypto", "market": "Crypto",
             "currency": "USD"},
        ], ["symbol"])
    wl.add(["005930.KS", "ASML", "SOL-USD", "ASML"])
    deep, bot = wl.deep_tier_tickers(), wl.bot_tickers()
    assert {"005930.KS", "ASML"} <= set(deep) and "SOL-USD" not in deep  # crypto stays in the broad tier
    assert "ASML" in bot and "005930.KS" not in bot  # the USD ledger trades USD quotes only
    wl.remove(["ASML"])
    assert "ASML" not in set(wl.items().symbol)

    from quant.ingestion.news_scraper import universe_names
    assert universe_names(["005930.KS", "AAPL"]) == {"005930.KS": "Samsung Electronics Co., Ltd."}
