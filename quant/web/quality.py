"""Fail-soft data-quality checks for the nightly export.

Each check looks at a wide price table (dates x symbols) and lists the series that fail it. A check
that raises is recorded with its error instead of stopping the export. Nothing here edits the data:
failures go to status.json (quant.web.status) and to a per-symbol flag the site shows next to the
numbers derived from that series, so a bad series never reaches a chart or a score unmarked.

Checks (over the last RECENT sessions of each series' market calendar):
  duplicates       repeated dates in the table, or repeated symbols
  gaps             3+ consecutive sessions missing between two prices
  negative_prices  a close at or below zero
  zero_volume      zero volume on 5+ of the last 20 sessions with a price
  unit_changes     a one-day jump of 20x or more either way (a currency or pence/pounds switch)
Also reported, for review rather than as failures:
  stale            the last price is 5+ market sessions old
  outliers         a daily move beyond 5 standard deviations of the series' previous year
"""

from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web")

RECENT = 60  # sessions checked for gaps, negatives and unit changes
GAP_SESSIONS = 3
ZERO_VOLUME_WINDOW, ZERO_VOLUME_DAYS = 20, 5
UNIT_JUMP = 20.0
STALE_SESSIONS = 5
OUTLIER_SIGMA, OUTLIER_SESSIONS, OUTLIER_LOOKBACK = 5.0, 5, 250
LIST_LIMIT = 200  # longest list kept per check in status.json (the count is always exact)
CHECKS = ("duplicates", "gaps", "negative_prices", "zero_volume", "unit_changes")
FLAG = {"duplicates": "duplicate", "gaps": "gap", "negative_prices": "negative", "zero_volume": "zero_volume",
        "unit_changes": "unit_change", "stale": "stale", "outliers": "outlier"}


def _day(ts) -> str:
    return f"{pd.Timestamp(ts):%Y-%m-%d}"


def calendars(close: pd.DataFrame, market_of: dict[str, str] | None) -> dict[str, pd.DatetimeIndex]:
    """Each market's sessions: the dates on which at least half of its symbols have a close."""
    groups: dict[str, list[str]] = {}
    for sym in close.columns:
        groups.setdefault((market_of or {}).get(sym, "all"), []).append(sym)
    out = {}
    for market, cols in groups.items():
        have = close[cols].notna().mean(axis=1)
        out[market] = close.index[have >= 0.5]
    return out


def _gaps(values: np.ndarray, dates: pd.DatetimeIndex) -> tuple[int, str] | None:
    """Longest run of missing sessions that has a price on both sides: (length, first missing date)."""
    have = ~np.isnan(values)
    if have.sum() < 2:
        return None
    first, last = np.argmax(have), len(have) - 1 - np.argmax(have[::-1])
    best, start, run, run_start = 0, None, 0, 0
    for i in range(first, last + 1):
        if have[i]:
            if run > best:
                best, start = run, run_start
            run = 0
        else:
            if run == 0:
                run_start = i
            run += 1
    return (best, _day(dates[start])) if best >= GAP_SESSIONS else None


def check_prices(close: pd.DataFrame, volume: pd.DataFrame | None = None,
                 market_of: dict[str, str] | None = None) -> dict:
    """Run every check on a wide close (and volume) table. Returns
    {"checks": {name: {"count", "failed": [{"symbol", "date", "detail"}], "error"}},
     "stale": {...}, "outliers": {...}, "flags": {symbol: [codes]}}."""
    result: dict = {"checks": {}, "flags": {}}
    close = close.sort_index()
    cals = {}
    try:
        cals = calendars(close, market_of)
    except Exception as exc:  # the checks below fall back to the table's own dates
        log.exception("quality: market calendars failed")
        result["calendar_error"] = str(exc)

    def cal_for(sym: str) -> pd.DatetimeIndex:
        return cals.get((market_of or {}).get(sym, "all"), close.index)

    def run(name: str, fn) -> None:
        try:
            failed = fn()
            entry = {"count": len(failed), "failed": failed[:LIST_LIMIT], "error": None}
            for f in failed:
                if f.get("symbol"):
                    result["flags"].setdefault(f["symbol"], set()).add(FLAG[name])
        except Exception as exc:
            log.exception("quality check %s failed", name)
            entry = {"count": None, "failed": [], "error": f"{type(exc).__name__}: {exc}"}
        if name in CHECKS:
            result["checks"][name] = entry
        else:
            result[name] = entry

    def duplicates():
        out = []
        dup_dates = close.index[close.index.duplicated()]
        if len(dup_dates):
            out.append({"symbol": None, "date": _day(dup_dates[0]), "detail": f"{len(dup_dates)} repeated dates in the table"})
        for sym in close.columns[close.columns.duplicated()].unique():
            out.append({"symbol": str(sym), "date": None, "detail": "symbol appears more than once"})
        return out

    clean = close.loc[~close.index.duplicated(keep="last"), ~close.columns.duplicated(keep="last")]

    def gaps():
        out = []
        for sym in clean.columns:
            cal = cal_for(sym)[-RECENT:]
            values = clean[sym].reindex(cal).to_numpy(dtype=float)
            g = _gaps(values, cal)
            if g:
                out.append({"symbol": sym, "date": g[1], "detail": f"{g[0]} sessions missing between two prices"})
        return out

    recent = clean.iloc[-RECENT:]

    def negatives():
        bad = (recent <= 0) & recent.notna()
        out = []
        for sym in bad.columns[bad.any()]:
            when = bad.index[bad[sym].to_numpy()][-1]
            out.append({"symbol": sym, "date": _day(when), "detail": f"close {recent.at[when, sym]:.6g}"})
        return out

    def zero_volume():
        if volume is None or volume.empty:
            return []
        vol = volume.loc[~volume.index.duplicated(keep="last"), ~volume.columns.duplicated(keep="last")]
        vol = vol.reindex(index=clean.index, columns=[c for c in clean.columns if not str(c).startswith("^")]).iloc[-ZERO_VOLUME_WINDOW:]
        priced = clean[vol.columns].iloc[-ZERO_VOLUME_WINDOW:].notna()
        has_volume = vol.notna().any()
        zeros = ((vol == 0) & priced).sum()
        out = []
        for sym in zeros.index[(zeros >= ZERO_VOLUME_DAYS) & has_volume]:
            out.append({"symbol": sym, "date": None, "detail": f"zero volume on {int(zeros[sym])} of the last {ZERO_VOLUME_WINDOW} sessions"})
        return out

    filled = clean.ffill(limit=5)
    ratio = (filled / filled.shift(1)).iloc[-RECENT:]

    def unit_changes():
        bad = ((ratio >= UNIT_JUMP) | (ratio <= 1 / UNIT_JUMP)) & ratio.notna()
        out = []
        for sym in bad.columns[bad.any()]:
            when = bad.index[bad[sym].to_numpy()][-1]
            out.append({"symbol": sym, "date": _day(when), "detail": f"one-day change x{ratio.at[when, sym]:.4g}"})
        return out

    def stale():
        out = []
        for sym in clean.columns:
            cal = cal_for(sym)
            s = clean[sym].dropna()
            if s.empty or not len(cal):
                continue
            behind = int((cal > s.index[-1]).sum())
            if behind >= STALE_SESSIONS:
                out.append({"symbol": sym, "date": _day(s.index[-1]), "detail": f"last price {behind} market sessions ago"})
        return out

    def outliers():
        logret = np.log(filled.where(filled > 0)).diff()
        tail = logret.iloc[-(OUTLIER_LOOKBACK + OUTLIER_SESSIONS):]
        sigma = tail.rolling(OUTLIER_LOOKBACK, min_periods=60).std().shift(1)
        z = (tail / sigma.where(sigma > 0)).iloc[-OUTLIER_SESSIONS:]  # a flat series has no sigma to measure against
        hits = (z.abs() > OUTLIER_SIGMA) & np.isfinite(z)
        out = []
        for sym in hits.columns[hits.any()]:
            for when in hits.index[hits[sym].to_numpy()]:
                r, zz = tail.at[when, sym], z.at[when, sym]
                out.append({"symbol": sym, "date": _day(when), "move": float(math.expm1(r)), "sigma": float(zz),
                            "detail": f"{math.expm1(r):+.1%} in a day, {abs(zz):.1f} standard deviations"})
        return sorted(out, key=lambda o: -abs(o["sigma"]))

    for name, fn in (("duplicates", duplicates), ("gaps", gaps), ("negative_prices", negatives),
                     ("zero_volume", zero_volume), ("unit_changes", unit_changes), ("stale", stale), ("outliers", outliers)):
        run(name, fn)
    result["flags"] = {s: sorted(codes) for s, codes in result["flags"].items()}
    return result


def duplicate_symbols(symbols) -> list[dict]:
    """Repeated symbols in a list of rows (the screener, a scores table)."""
    s = pd.Series(list(symbols), dtype=object)
    return [{"symbol": str(sym), "date": None, "detail": f"{int(n)} rows"} for sym, n in s.value_counts().items() if n > 1]
