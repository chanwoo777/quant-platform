"""Offline tests for Phase 3 quant models (synthetic data, no network)."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from quant import quant_models as qm
from quant.ingestion.factors import parse_french_csv

# --- Kenneth French CSV ------------------------------------------------------------

FRENCH_TEXT = """This file was created by using the 202608 CRSP database.
The Tbill return is the simple daily rate, with commas, in a note.

,Mkt-RF,SMB,HML,RF
20260828,   -0.34,   -0.51,    0.28,    0.01
20260831,   -0.33,  -99.99,   -0.39,    0.01

  Annual Factors: January-December
,Mkt-RF,SMB,HML,RF
  2025,   20.00,   -3.00,    1.00,    4.00

Copyright 2026 Eugene F. Fama and Kenneth R. French
"""


def test_parse_french_csv_first_table_in_decimals():
    table = parse_french_csv(FRENCH_TEXT)
    assert list(table.columns) == ["mkt_rf", "smb", "hml", "rf"]
    assert list(table.index) == [pd.Timestamp("2026-08-28"), pd.Timestamp("2026-08-31")]
    assert table.loc["2026-08-28", "mkt_rf"] == pytest.approx(-0.0034)
    assert np.isnan(table.loc["2026-08-31", "smb"])  # -99.99 = missing


# --- factor regression ---------------------------------------------------------------

def _factors(n=750, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2023-01-02", periods=n)
    return pd.DataFrame(
        {"mkt_rf": rng.normal(0.0004, 0.01, n), "smb": rng.normal(0, 0.005, n), "hml": rng.normal(0, 0.005, n),
         "mom": rng.normal(0, 0.006, n), "rf": 0.0001},
        index=idx,
    )


def test_factor_regression_recovers_known_exposures():
    f = _factors()
    noise = np.random.default_rng(1).normal(0, 0.001, len(f))  # alpha s.e. ~0.9%/yr at this noise
    r = f.rf + 0.0002 + 1.3 * f.mkt_rf - 0.4 * f.smb + 0.6 * f.hml + noise
    e = qm.factor_regression(pd.Series(r, index=f.index), f, ticker="TEST")

    assert e.betas["mkt_rf"] == pytest.approx(1.3, abs=0.03)
    assert e.betas["smb"] == pytest.approx(-0.4, abs=0.06)
    assert e.betas["hml"] == pytest.approx(0.6, abs=0.06)
    assert e.alpha_annual == pytest.approx(0.0002 * 252, abs=0.03)
    assert sum(e.variance_share.values()) == pytest.approx(1.0)
    assert e.dominant_driver == "market"
    assert {"large-cap", "value"} <= set(e.tilts) and any(t.startswith("aggressive") for t in e.tilts)
    attribution = e.return_attribution
    assert attribution["mkt_rf"] == pytest.approx(e.betas["mkt_rf"] * f.mkt_rf.mean() * 252)


def test_factor_regression_needs_enough_overlap():
    f = _factors(100)
    with pytest.raises(ValueError):
        qm.factor_regression(pd.Series(0.001, index=f.index), f)


def test_rolling_exposures_track_a_beta_change():
    f = _factors(600)
    beta = np.where(np.arange(600) < 300, 0.5, 1.5)
    r = pd.Series(f.rf + beta * f.mkt_rf, index=f.index)
    roll = qm.rolling_exposures(r, f, window=126, step=21)
    assert roll["mkt_rf"].iloc[0] == pytest.approx(0.5, abs=1e-6)
    assert roll["mkt_rf"].iloc[-1] == pytest.approx(1.5, abs=1e-6)


# --- strategies ---------------------------------------------------------------------

def test_momentum_signal_skips_the_last_month():
    prices = pd.DataFrame({"A": np.arange(1, 301, dtype=float)})
    sig = qm.momentum_signal(prices, lookback=252, skip=21)
    assert sig["A"].iloc[299] == pytest.approx(prices.A.iloc[278] / prices.A.iloc[47] - 1)


def test_backtest_trades_on_next_day_returns_only():
    idx = pd.bdate_range("2026-01-05", periods=10)
    prices = pd.DataFrame({"A": 100 * 1.01 ** np.arange(10), "B": 100.0, "C": 100 * 0.99 ** np.arange(10)}, index=idx)
    signal = pd.DataFrame({"A": 3.0, "B": 2.0, "C": 1.0}, index=idx)
    bt = qm.backtest_cross_sectional(prices, signal, rebalance_days=100, n_long=1, n_short=1, cost_bps=10)

    assert bt.index[0] == idx[1]  # the first return is earned the day after formation
    assert bt["gross"].iloc[0] == pytest.approx(0.01 + 0.01)  # long A (+1%), short C (-1%)
    assert bt["net"].iloc[0] == pytest.approx(0.02 - 2.0 * 10 / 1e4)  # building the book costs 2x turnover
    assert bt["net"].iloc[1] == pytest.approx(0.02)


def test_backtest_ignores_signal_known_only_after_the_fact():
    # A signal equal to *today's* return would be a perfect look-ahead; lagged trading earns ~0
    rng = np.random.default_rng(3)
    idx = pd.bdate_range("2025-01-01", periods=400)
    rets = pd.DataFrame(rng.normal(0, 0.01, (400, 6)), index=idx, columns=list("ABCDEF"))
    prices = 100 * (1 + rets).cumprod()
    bt = qm.backtest_cross_sectional(prices, rets, rebalance_days=1, n_long=2, n_short=2, cost_bps=0)
    assert abs(bt["gross"].mean()) < 0.001


def test_performance_stats():
    r = pd.Series(0.001, index=pd.bdate_range("2025-01-01", periods=252))
    stats = qm.performance_stats(r)
    assert stats["cagr"] == pytest.approx(1.001 ** 252 - 1)
    assert stats["max_drawdown"] == 0.0


# --- fundamentals ---------------------------------------------------------------------

def _filing(form, report, filed, fp, rev, ni, cf, cfd, shares=100.0, capex=1.0, equity=500.0, accn=None):
    return {"form": form, "report_date": date.fromisoformat(report), "filing_date": date.fromisoformat(filed),
            "fiscal_period": fp, "period_days": 365 if form == "10-K" else 91, "cash_flow_period_days": cfd,
            "revenue": rev, "net_income": ni, "eps_diluted": ni / shares, "operating_cash_flow": cf,
            "capital_expenditure": capex * (cfd / 91), "total_assets": 1000.0, "total_liabilities": 500.0,
            "stockholders_equity": equity, "total_debt": 100.0, "cash_and_equivalents": 50.0,
            "diluted_shares": shares, "accession_number": accn or f"{form}-{report}"}


def _two_years():
    return pd.DataFrame([
        _filing("10-Q", "2024-03-31", "2024-05-01", "Q1", 9, 2, 4, 91),
        _filing("10-Q", "2024-06-30", "2024-08-01", "Q2", 9, 2, 8, 182),
        _filing("10-Q", "2024-09-30", "2024-11-01", "Q3", 9, 2, 12, 273),
        _filing("10-K", "2024-12-31", "2025-02-15", "FY", 40, 9, 17, 365),
        _filing("10-Q", "2025-03-31", "2025-05-01", "Q1", 10, 3, 5, 91),
        _filing("10-Q", "2025-06-30", "2025-08-01", "Q2", 11, 3, 12, 182),  # YTD cash flow
        _filing("10-Q", "2025-09-30", "2025-11-01", "Q3", 12, 3, 20, 273),
        _filing("10-K", "2025-12-31", "2026-02-15", "FY", 50, 13, 30, 365),
    ])


def test_quarterly_flows_derive_q4_and_difference_ytd_cash_flow():
    q = qm.quarterly_flows(_two_years())
    fy25 = q[q.report_date.dt.year == 2025]
    assert fy25.quarter.tolist() == [1, 2, 3, 4]
    assert fy25.revenue.tolist() == [10, 11, 12, 17]  # Q4 = 50 - (10 + 11 + 12)
    assert fy25.operating_cash_flow.tolist() == [5, 7, 8, 10]  # YTD 5, 12, 20, then FY 30
    assert fy25.net_income.sum() == 13


def test_quarterly_flows_accept_quarterly_cash_flow_and_dedupe_restatements():
    fund = _two_years()
    fund.loc[5, ["operating_cash_flow", "cash_flow_period_days"]] = [7, 91]  # reported as a 3-month figure
    restated = _filing("10-Q", "2025-03-31", "2025-06-01", "Q1", 10.5, 3, 5, 91, accn="restated")
    q = qm.quarterly_flows(pd.concat([fund, pd.DataFrame([restated])], ignore_index=True))
    fy25 = q[q.report_date.dt.year == 2025]
    assert fy25.operating_cash_flow.tolist()[:3] == [5, 7, 8]
    assert fy25.revenue.iloc[0] == 10.5  # newest filing for a period wins


def test_ttm_snapshot_is_point_in_time():
    fund = _two_years()
    before_10k = qm.ttm_snapshot(fund, pd.Timestamp("2026-01-15"))  # FY2025 10-K not filed yet
    assert before_10k["revenue"] == 40 - 27 + 33  # FY2024 Q4 (13) + 2025 Q1-Q3 (33)
    assert before_10k["period_end"] == pd.Timestamp("2025-09-30")
    after = qm.ttm_snapshot(fund, pd.Timestamp("2026-03-01"))
    assert after["revenue"] == 50 and after["basis"] == "4 quarters"
    assert qm.ttm_snapshot(fund, pd.Timestamp("2024-01-01")) is None


def test_ttm_falls_back_to_annual_report():
    only_10k = _two_years().query("form == '10-K'")
    snap = qm.ttm_snapshot(only_10k, pd.Timestamp("2026-03-01"))
    assert snap["revenue"] == 50 and snap["basis"] == "latest 10-K"


def test_split_factor_after():
    splits = pd.Series([4.0, 10.0], index=pd.DatetimeIndex(["2021-07-20", "2024-06-10"]))
    assert qm.split_factor_after(splits, pd.Timestamp("2022-01-01")) == 10.0
    assert qm.split_factor_after(splits, pd.Timestamp("2020-01-01")) == 40.0
    assert qm.split_factor_after(splits, pd.Timestamp("2025-01-01")) == 1.0


def test_market_cap_uses_split_adjusted_shares():
    idx = pd.bdate_range("2025-06-02", periods=300)
    close = pd.DataFrame({"X": 50.0}, index=idx)  # split-adjusted price after a 10-for-1 split
    fund = _two_years().assign(diluted_shares=100.0)  # as reported before the split
    u = qm.Universe(
        tickers=["X"], close=close, adj_close=close, fundamentals={"X": fund},
        splits={"X": pd.Series([10.0], index=pd.DatetimeIndex(["2026-06-01"]))}, sic={"X": "3571"},
        factors=pd.DataFrame(),
    )
    m = qm.raw_metrics(u, pd.Timestamp("2026-07-01"))
    assert m.loc["X", "market_cap"] == pytest.approx(50.0 * 100.0 * 10)


# --- composite score -----------------------------------------------------------------------

def test_composite_scores_rank_and_renormalise():
    metrics = pd.DataFrame(
        {
            "earnings_yield": [0.08, 0.05, 0.02], "fcf_yield": [0.06, 0.04, 0.01],
            "book_to_market": [0.5, 0.3, 0.1], "sales_yield": [1.0, 0.5, 0.2],
            "roe": [0.10, 0.20, 0.30], "cash_roa": [0.05, 0.10, 0.15],
            "leverage": [2.0, 1.0, 0.1], "accruals": [0.05, 0.0, -0.05],
            "momentum_12_1": [np.nan, np.nan, np.nan], "momentum_6_1": [np.nan, np.nan, np.nan],
        },
        index=["CHEAP", "MID", "QUALITY"],
    )
    s = qm.composite_scores(metrics)
    assert s.loc["CHEAP", "value"] == 100 and s.loc["QUALITY", "value"] == 0
    assert s.loc["QUALITY", "quality"] == 100  # low leverage and low accruals count as quality
    assert s["momentum"].isna().all()
    assert s.loc["CHEAP", "composite"] == pytest.approx(50.0)  # (100 + 0) / 2: missing pillar dropped


def test_information_coefficient_detects_a_perfect_score():
    idx = pd.bdate_range("2024-01-01", periods=200)
    rng = np.random.default_rng(5)
    prices = pd.DataFrame(100 * np.cumprod(1 + rng.normal(0, 0.01, (200, 6)), axis=0), index=idx, columns=list("ABCDEF"))
    u = qm.Universe(tickers=list("ABCDEF"), close=prices, adj_close=prices, fundamentals={}, splits={}, sic={},
                    factors=pd.DataFrame())
    fwd = prices.shift(-21) / prices - 1
    dates = idx[:150:21]
    history = pd.concat([
        pd.DataFrame({"date": d, "ticker": prices.columns, "value": fwd.loc[d].to_numpy(), "quality": 0.0,
                      "momentum": rng.normal(size=6), "composite": fwd.loc[d].to_numpy()})
        for d in dates
    ])
    ic = qm.information_coefficients(u, history)
    assert ic.loc["value", "mean_ic"] == pytest.approx(1.0)
    assert abs(ic.loc["momentum", "mean_ic"]) < 0.5
