"""Data-quality checks (quant/web/quality.py) on small synthetic price tables."""

import numpy as np
import pandas as pd

from quant.web import quality


def frame(n=300, cols=("AAA", "BBB", "CCC", "DDD"), seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2025-01-01", periods=n)
    close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (n, len(cols))), axis=0)), index=idx, columns=list(cols))
    volume = pd.DataFrame(1e6, index=idx, columns=list(cols))
    return close, volume


def failed(result, name):
    return {f["symbol"] for f in result["checks"][name]["failed"]}


def test_clean_table_passes_every_check():
    close, volume = frame()
    r = quality.check_prices(close, volume)
    assert all(r["checks"][c]["count"] == 0 and r["checks"][c]["error"] is None for c in quality.CHECKS)
    assert r["stale"]["count"] == 0 and r["outliers"]["count"] == 0 and r["flags"] == {}


def test_each_check_catches_its_failure():
    close, volume = frame()
    close.iloc[-10:-6, close.columns.get_loc("AAA")] = np.nan  # a 4-session gap with prices on both sides
    close.iloc[-3, close.columns.get_loc("BBB")] = -1.0  # negative price
    volume.iloc[-8:, volume.columns.get_loc("CCC")] = 0  # zero volume on 8 of the last 20 sessions
    close.iloc[-5:, close.columns.get_loc("DDD")] *= 100  # pounds -> pence
    r = quality.check_prices(close, volume)
    assert failed(r, "gaps") == {"AAA"}
    assert failed(r, "negative_prices") == {"BBB"}
    assert failed(r, "zero_volume") == {"CCC"}
    assert "DDD" in failed(r, "unit_changes")
    assert r["flags"]["AAA"] == ["gap"] and "unit_change" in r["flags"]["DDD"]


def test_duplicate_dates_and_symbols():
    close, volume = frame()
    dup = pd.concat([close, close.iloc[[-1]]]).sort_index()
    r = quality.check_prices(dup, volume)
    assert r["checks"]["duplicates"]["count"] == 1
    assert quality.duplicate_symbols(["A", "B", "A"]) == [{"symbol": "A", "date": None, "detail": "2 rows"}]


def test_outliers_beyond_five_sigma_and_stale_series():
    close, volume = frame()
    close.iloc[-1, close.columns.get_loc("AAA")] = close.iloc[-2, close.columns.get_loc("AAA")] * 1.15  # ~14 sigma
    close.iloc[-7:, close.columns.get_loc("BBB")] = np.nan  # no price for 7 sessions
    r = quality.check_prices(close, volume)
    hits = r["outliers"]["failed"]
    assert [o["symbol"] for o in hits] == ["AAA"] and hits[0]["sigma"] > 5
    assert {s["symbol"] for s in r["stale"]["failed"]} == {"BBB"}


def test_a_failing_check_is_recorded_not_raised():
    close, _ = frame()
    r = quality.check_prices(close, "not a table")  # the zero-volume check raises; the others still run
    assert r["checks"]["zero_volume"]["error"].startswith("AttributeError") and r["checks"]["zero_volume"]["count"] is None
    assert r["checks"]["gaps"]["error"] is None
    assert all(set(v) >= {"count", "failed", "error"} for v in r["checks"].values())
