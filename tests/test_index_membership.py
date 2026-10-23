"""Offline tests for the point-in-time S&P 500 universe (synthetic tables, no network)."""

from __future__ import annotations

import json
import math
from datetime import date

import numpy as np
import pandas as pd
import pytest

from quant import analytics as an
from quant import quant_models as qm
from quant import trading_bot as tb
from quant.db import init_db, make_engine, session_scope, upsert
from quant.ingestion import index_membership as im
from quant.ingestion import market_data, sec_edgar
from quant.models import Company, Fundamental, PriceBar, StockSplit

D = date.fromisoformat

# --- parsing -----------------------------------------------------------------------------

CURRENT_HTML = """<table class="wikitable"><thead><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th>
<th>Date added</th><th>CIK</th></tr></thead><tbody>
<tr><td>AAA</td><td>Alpha Inc.</td><td>IT</td><td>1990-01-02</td><td>1</td></tr>
<tr><td>BRK.B</td><td>Berkshire Hathaway</td><td>Financials</td><td>2010-02-16</td><td>2</td></tr>
<tr><td>NEWCO</td><td>New Co</td><td>IT</td><td>2021-03-22</td><td>3</td></tr>
<tr><td>META</td><td>Meta Platforms</td><td>Comm</td><td>2013-12-23</td><td>4</td></tr>
</tbody></table>"""

# Wikipedia's change table has a two-row header (Added / Removed over Ticker / Security).
CHANGES_HTML = """<table class="wikitable"><thead>
<tr><th rowspan="2">Effective Date</th><th colspan="2">Added</th><th colspan="2">Removed</th><th rowspan="2">Reason</th></tr>
<tr><th>Ticker</th><th>Security</th><th>Ticker</th><th>Security</th></tr></thead><tbody>
<tr><td>March 22, 2021</td><td>NEWCO</td><td>New Co</td><td>OLDCO</td><td>Old Co</td><td>Market cap.</td></tr>
<tr><td>June 9, 2022</td><td>META</td><td>Meta Platforms</td><td>FB</td><td>Facebook</td><td>Symbol change.</td></tr>
<tr><td>July 1, 2019</td><td>OLDCO [1]</td><td>Old Co</td><td>GONE</td><td>Gone Corp</td><td>Gone Corp was acquired.</td></tr>
<tr><td>December 23, 2013</td><td>FB</td><td>Facebook</td><td>DROP</td><td>Dropped Inc</td><td>Market cap.</td></tr>
</tbody></table>"""

RENAMES = (im.Rename("FB", "META", D("2022-06-09")),)


def test_normalize_ticker_yahoo_format_and_markup():
    assert im.normalize_ticker("BRK.B") == "BRK-B"
    assert im.normalize_ticker("ALLE |") == "ALLE"
    assert im.normalize_ticker("XYZ[3]") == "XYZ"
    assert im.normalize_ticker(float("nan")) is None and im.normalize_ticker("  ") is None


def test_parse_tables():
    cur = im.parse_current(CURRENT_HTML)
    assert list(cur.ticker) == ["AAA", "BRK-B", "NEWCO", "META"]
    assert cur.date_added.iloc[0] == D("1990-01-02")
    chg = im.parse_changes(CHANGES_HTML)
    assert list(chg.date) == [D("2022-06-09"), D("2021-03-22"), D("2019-07-01"), D("2013-12-23")]  # newest first
    assert chg.loc[chg.date == D("2019-07-01"), "added"].item() == "OLDCO"  # footnote stripped


# --- renames -----------------------------------------------------------------------------

def test_resolve_symbol_follows_chains_and_respects_reuse():
    renames = (im.Rename("CBS", "VIAC", D("2019-12-05")), im.Rename("VIAC", "PARA", D("2022-02-16")),
               im.Rename("Q", "IQV", D("2017-11-15"), since=D("2016-10-03")))
    assert im.resolve_symbol("CBS", D("2018-01-01"), renames) == "PARA"
    assert im.resolve_symbol("VIAC", D("2021-01-01"), renames) == "PARA"
    assert im.resolve_symbol("CBS", D("2020-01-01"), renames) == "CBS"  # a later "CBS" is someone else
    assert im.resolve_symbol("Q", D("2017-01-01"), renames) == "IQV"  # QuintilesIMS
    assert im.resolve_symbol("Q", D("2011-01-01"), renames) == "Q"  # Qwest, before QuintilesIMS used it


def test_apply_renames_drops_symbol_change_rows():
    chg = im.apply_renames(im.parse_changes(CHANGES_HTML), RENAMES)
    assert D("2022-06-09") not in set(chg.date)  # FB -> META is not a membership change
    assert chg.loc[chg.date == D("2013-12-23"), "added"].item() == "META"


# --- reconstruction ----------------------------------------------------------------------

def _rec():
    return im.reconstruct(im.parse_current(CURRENT_HTML), im.parse_changes(CHANGES_HTML), RENAMES)


def test_reconstruct_stints():
    rec = _rec()
    assert rec.issues == []
    iv = rec.intervals.set_index("ticker")
    assert iv.loc["NEWCO", "added"] == D("2021-03-22") and iv.loc["NEWCO", "removed"] is None
    assert (iv.loc["OLDCO", "added"], iv.loc["OLDCO", "removed"]) == (D("2019-07-01"), D("2021-03-22"))
    assert iv.loc["GONE", "added"] is None and iv.loc["GONE", "removed"] == D("2019-07-01")  # before the log
    assert iv.loc["META", "added"] == D("2013-12-23")  # Facebook's stint filed under today's symbol
    assert iv.loc["AAA", "added"] == D("1990-01-02")  # from today's table


def test_members_on_boundaries_and_constant_count():
    iv = _rec().intervals
    assert "OLDCO" not in im.members_on(iv, "2019-06-28")
    assert "OLDCO" in im.members_on(iv, "2019-07-01")  # effective before the open: member that day
    assert "GONE" not in im.members_on(iv, "2019-07-01")  # removed: not a member on the effective date
    assert "NEWCO" in im.members_on(iv, "2021-03-22") and "OLDCO" not in im.members_on(iv, "2021-03-22")
    counts = im.member_counts(iv, pd.bdate_range("2014-01-01", "2024-01-01", freq="BME"))
    assert counts.nunique() == 1  # every change swaps one stock for another
    assert im.universe_tickers(iv, since="2020-01-01") == ["AAA", "BRK-B", "META", "NEWCO", "OLDCO"]


def test_mask_matches_members_on():
    iv = _rec().intervals
    dates = pd.bdate_range("2019-06-25", "2021-03-26")
    mask = im.membership_mask(iv, dates, ["OLDCO", "NEWCO", "GONE"])
    for d in (dates[0], pd.Timestamp("2019-07-01"), pd.Timestamp("2021-03-22"), dates[-1]):
        assert set(mask.columns[mask.loc[d]]) == set(im.members_on(iv, d)) & {"OLDCO", "NEWCO", "GONE"}


def test_inconsistent_log_is_reported():
    chg = im.parse_changes(CHANGES_HTML)
    chg.loc[chg.date == D("2021-03-22"), "added"] = "TYPO"
    rec = im.reconstruct(im.parse_current(CURRENT_HTML), chg, RENAMES)
    assert any("TYPO added but not a member" in i for i in rec.issues)


def test_store_and_load_roundtrip(tmp_path):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'm.db').as_posix()}"))
    iv = _rec().intervals
    with session_scope(engine) as s:
        assert im.store_membership(s, iv) == len(iv)
        im.store_membership(s, iv)  # rebuild replaces, never duplicates
    with session_scope(engine) as s:
        back = im.load_membership(s)
    assert len(back) == len(iv)
    assert im.members_on(back, "2020-01-02") == im.members_on(iv, "2020-01-02")


# --- point-in-time models ----------------------------------------------------------------

def _pit_universe(n=400, seed=3, switch_at=320):
    """Six stocks; LATE joins the index on session ``switch_at`` (after the 252-day
    momentum warm-up) and EARLY leaves it that day."""
    idx = pd.bdate_range("2023-01-02", periods=n)
    rng = np.random.default_rng(seed)
    prices = pd.DataFrame(100 * np.cumprod(1 + rng.normal(0.0005, 0.02, (n, 6)), axis=0), index=idx,
                          columns=["A", "B", "C", "D", "LATE", "EARLY"])
    prices["LATE"] = 100 * np.cumprod(np.full(n, 1.01))  # the best momentum all along
    half = idx[switch_at]
    members = pd.DataFrame(True, index=idx, columns=prices.columns)
    members.loc[:half - pd.Timedelta(days=1), "LATE"] = False
    members.loc[half:, "EARLY"] = False
    factors = pd.DataFrame({"mkt_rf": rng.normal(0, 0.01, n), "smb": rng.normal(0, 0.005, n),
                            "hml": rng.normal(0, 0.005, n), "mom": rng.normal(0, 0.01, n), "rf": 0.0}, index=idx)
    u = qm.Universe(tickers=list(prices.columns), close=prices, adj_close=prices, fundamentals={}, splits={},
                    sic={}, factors=factors, members=members, index_name="sp500",
                    n_members=members.sum(axis=1) + 1)  # one member without prices
    return u, half


def test_eligible_follows_membership():
    u, half = _pit_universe()
    assert "LATE" not in u.eligible(half - pd.Timedelta(days=1)) and "EARLY" in u.eligible(half - pd.Timedelta(days=1))
    assert "LATE" in u.eligible(half) and "EARLY" not in u.eligible(half)
    assert u.is_member("LATE", half) and not u.is_member("LATE", u.close.index[0])
    assert u.coverage() == pytest.approx(u.members.sum().sum() / u.n_members.sum())
    no_index = qm.Universe(tickers=["A"], close=u.close[["A"]], adj_close=u.close[["A"]], fundamentals={},
                           splits={}, sic={}, factors=pd.DataFrame())
    assert no_index.eligible(half) == ["A"] and no_index.note() == qm.SURVIVORSHIP_NOTE


def test_scores_rank_only_members():
    u, half = _pit_universe()
    before = qm.factor_scores(u, half - pd.Timedelta(days=3))
    after = qm.factor_scores(u, half + pd.Timedelta(days=3))
    assert "LATE" not in before.index and "EARLY" in before.index
    assert "LATE" in after.index and "EARLY" not in after.index
    assert after.loc["LATE", "momentum"] == 100  # top of the members ranked that day


def test_strategy_never_holds_non_members():
    u, half = _pit_universe()
    prices = u.adj_close
    signal = qm.momentum_signal(prices).where(u.eligibility())
    bt = qm.backtest_cross_sectional(prices, signal, 21, 1, 0, cost_bps=0.0)
    # Long the single best momentum stock. LATE (+1% a day) is best all along, but is
    # held only from the first rebalance after it joins the index.
    pre = bt.loc[:half]
    assert len(pre) > 20 and not np.isclose(pre["gross"], 0.01).any()
    post = bt.loc[half + pd.Timedelta(days=35):]
    assert len(post) > 20 and np.allclose(post["gross"], 0.01)
    table = qm.run_strategies(u, qm.STRATEGIES[:1], quantile=0.34)
    assert "Equal-weight universe (benchmark)" in table.index


def test_quantile_legs_scale_with_breadth():
    idx = pd.bdate_range("2024-01-01", periods=30)
    daily = 0.001 * np.arange(20)  # stock i earns i x 0.1% a day; the signal ranks them correctly
    prices = pd.DataFrame(100 * np.cumprod(np.tile(1 + daily, (30, 1)), axis=0), index=idx,
                          columns=[f"S{i}" for i in range(20)])
    signal = pd.DataFrame(np.tile(np.arange(20.0), (30, 1)), index=idx, columns=prices.columns)
    deciles = qm.backtest_cross_sectional(prices, signal, 10, 3, 3, cost_bps=0.0, quantile=0.1)
    fixed = qm.backtest_cross_sectional(prices, signal, 10, 3, 3, cost_bps=0.0)
    assert np.allclose(deciles["gross"], 0.001 * (18.5 - 0.5))  # 2 longs (S18, S19) vs 2 shorts (S0, S1)
    assert np.allclose(fixed["gross"], 0.001 * (18 - 1))  # 3 vs 3


def test_bot_sells_a_holding_that_leaves_the_index():
    u, half = _pit_universe()
    bars = {}
    for t in u.tickers:
        c = u.close[t]
        df = pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "adj_close": c, "volume": 1e6})
        ind = an.add_indicators(df)
        ind["vol"] = ind["return_1d"].rolling(60).std() * math.sqrt(252)
        bars[t] = ind
    regime = pd.DataFrame({"regime": "Bull Trending", "trend": "Bull", "stance": "Risk-On"}, index=u.close.index)
    news = pd.DataFrame({"ticker": pd.Series(dtype=str), "published_at": pd.Series(dtype="datetime64[us]"),
                         "sentiment_score": pd.Series(dtype=float), "title": pd.Series(dtype=str)})
    ctx = tb.MarketContext(universe=u, bars=bars, regime=regime, news=news, benchmark=u.close["A"])
    state = tb.PortfolioState(cash=10_000.0)
    day_before = u.close.index[u.close.index.get_loc(half) - 1]
    state.holdings["EARLY"] = tb.Holding("EARLY", 10, 100.0, date(2023, 1, 2), 100.0, 1.0, 100.0)
    res = tb.run_day(state, ctx, day_before, tb.BotParams(), trade=False)
    assert "EARLY" in state.holdings and not res.fills  # still a member: kept
    state.holdings["EARLY"].stop = 1.0  # only the index exit can sell it
    res = tb.run_day(state, ctx, half, tb.BotParams(), trade=True)
    assert "EARLY" not in state.holdings
    sale = next(f for f in res.fills if f.ticker == "EARLY")
    assert sale.reason == "exit" and "no longer in the S&P 500" in sale.rationale
    assert "LATE" in {s.ticker for s in res.signals} and "EARLY" not in {s.ticker for s in res.signals}


# --- ingestion helpers -------------------------------------------------------------------

def _download_frame(tickers, idx, split_on=None):
    if not tickers:
        return pd.DataFrame()  # what yfinance returns when nothing downloaded
    cols = pd.MultiIndex.from_product([tickers, ["Open", "High", "Low", "Close", "Adj Close", "Volume",
                                                 "Dividends", "Stock Splits"]])
    df = pd.DataFrame(1.0, index=idx, columns=cols)
    for t in tickers:
        df[(t, "Stock Splits")] = 0.0
    if split_on is not None:
        df.loc[split_on, (tickers[0], "Stock Splits")] = 4.0
    return df


def test_update_daily_batch_without_network(tmp_path, monkeypatch):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'p.db').as_posix()}"))
    idx = pd.bdate_range("2026-01-05", periods=10)
    calls = []

    def fake_download(tickers, **kwargs):
        calls.append((list(tickers), kwargs))
        return _download_frame([t for t in tickers if t != "GONE"], idx, split_on=idx[3])

    monkeypatch.setattr(market_data.yf, "download", fake_download)
    res = market_data.update_daily_batch(engine, ["AAA", "BBB", "GONE"], "10y", tmp_path, batch_size=2)
    assert res.rows == 20 and res.no_data == ["GONE"] and not res.errors
    assert [c[0] for c in calls] == [["AAA", "BBB"], ["GONE"]]  # batches of 2
    assert calls[0][1]["group_by"] == "ticker" and calls[0][1]["period"] == "10y"
    with session_scope(engine) as s:
        assert s.query(PriceBar).count() == 20
        assert s.query(StockSplit).filter_by(ticker="AAA").one().ratio == 4.0
    assert "GONE" in json.loads((tmp_path / "yahoo_no_data.json").read_text())

    calls.clear()  # second run: stored tickers refresh from their last bar; GONE is not re-asked yet
    res = market_data.update_daily_batch(engine, ["AAA", "BBB", "GONE"], "10y", tmp_path, batch_size=5)
    assert [c[0] for c in calls] == [["AAA", "BBB"]] and "start" in calls[0][1]
    assert res.no_data == ["GONE"]


class _FakeSEC:
    def __init__(self, ciks):
        self.ciks = ciks

    def cik_for(self, ticker):
        return self.ciks.get(ticker)


def test_share_classes_fetch_once_and_share_filings(tmp_path):
    fetch, linked = sec_edgar.split_share_classes(_FakeSEC({"GOOGL": 1, "GOOG": 1, "AAPL": 2}), ["GOOGL", "AAPL", "GOOG", "SPY"])
    assert fetch == ["GOOGL", "AAPL", "SPY"] and linked == {"GOOG": "GOOGL"}

    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'f.db').as_posix()}"))
    with session_scope(engine) as s:
        upsert(s, Company, [{"ticker": "GOOGL", "cik": 1, "name": "Alphabet", "sic": "7370"}], ["ticker"])
        upsert(s, Fundamental, [{"ticker": "GOOGL", "cik": 1, "form": "10-K", "accession_number": "A-1",
                                 "filing_date": D("2026-02-01"), "report_date": D("2025-12-31"), "revenue": 1.0}],
               ["accession_number"])
        sec_edgar.link_share_class(s, "GOOG", "GOOGL")
    with session_scope(engine) as s:
        many = sec_edgar.load_fundamentals_many(s, ["GOOGL", "GOOG", "NONE"])
        single = sec_edgar.load_fundamentals(s, "GOOGL")
        assert s.get(Company, "GOOG").sic == "7370"
    assert list(many["GOOG"].accession_number) == ["A-1"] and many["NONE"].empty
    pd.testing.assert_frame_equal(many["GOOGL"], single)


def test_load_universe_point_in_time_and_hindsight(tmp_path):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'u.db').as_posix()}"))
    idx = pd.bdate_range("2026-01-05", periods=30)
    joins, leaves = idx[10].date(), idx[20].date()
    iv = pd.DataFrame({"ticker": ["A", "B", "C", "NOPX"], "name": None,
                       "added": [None, joins, None, None], "removed": [None, None, leaves, None]})
    with session_scope(engine) as s:
        im.store_membership(s, iv)
        upsert(s, PriceBar, [{"ticker": t, "interval": "1d", "timestamp": d.to_pydatetime(), "open": 1.0, "high": 1.0,
                              "low": 1.0, "close": 10.0 + i, "adj_close": 10.0 + i, "volume": 1}
                             for t in ("A", "B", "C") for i, d in enumerate(idx)], ["ticker", "interval", "timestamp"])
    with session_scope(engine) as s:
        u = qm.load_universe(s, index="sp500")
        biased = qm.load_universe(s, index="sp500", point_in_time=False)
    assert u.tickers == ["A", "B", "C"]  # NOPX has no prices
    assert u.eligible(idx[9]) == ["A", "C"] and u.eligible(idx[10]) == ["A", "B", "C"]
    assert u.eligible(idx[20]) == ["A", "B"]
    assert u.coverage() == pytest.approx((30 + 20 + 20) / (30 + 20 + 20 + 30))  # NOPX is a member every day
    assert "S&P 500" in u.note() and "point-in-time" in u.note()
    assert biased.tickers == ["A", "B"] and biased.eligible(idx[0]) == ["A", "B"]  # today's members, back-filled
    assert "survivorship-biased" in biased.note()
