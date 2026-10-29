"""Calibration report for the Phase 2 thresholds. Re-run after changing any rule.

    python scripts/calibrate_phase2.py regime       # trend bands + VIX bands, 1990-today
    python scripts/calibrate_phase2.py anomalies    # move rules vs SEC 8-K earnings dates
    python scripts/calibrate_phase2.py anomalies --universe sp500   # ... on point-in-time S&P 500 members
    python scripts/calibrate_phase2.py relevance    # headline filter vs hand labels

Thresholds are chosen for *robustness* (plateaus, stability, separation of
forward risk), not to maximise backtest returns, so Phase 4 backtests on the
same history aren't silently overfit.
"""

from __future__ import annotations

import argparse
import dataclasses
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from quant import analytics as an  # noqa: E402
from quant.config import get_settings  # noqa: E402

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 30)
CACHE_MAX_AGE = 7 * 86400


# --- data ----------------------------------------------------------------------

def long_history(ticker: str) -> pd.DataFrame:
    """Full daily history from Yahoo (calibration only; cached, never written to the DB)."""
    import yfinance as yf

    from quant.ingestion.market_data import normalize_history

    cache = get_settings().cache_dir / f"calibration_{ticker.strip('^')}.parquet"
    if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_MAX_AGE:
        return pd.read_parquet(cache)
    bars = normalize_history(yf.Ticker(ticker).history(period="max", auto_adjust=False, actions=False), "1d")
    bars = bars.set_index("timestamp")
    bars.to_parquet(cache)
    return bars


# --- regime ----------------------------------------------------------------------

def drawdown_episodes(close: pd.Series, min_decline: float = 0.19) -> list[tuple[pd.Timestamp, pd.Timestamp, float]]:
    """(peak, trough, decline) for every peak-to-trough fall of at least min_decline."""
    episodes, peak_t, peak = [], close.index[0], close.iloc[0]
    trough_t, trough = peak_t, peak
    for t, px in close.items():
        if px > peak:
            if trough / peak - 1 <= -min_decline:
                episodes.append((peak_t, trough_t, trough / peak - 1))
            peak_t, peak, trough_t, trough = t, px, t, px
        elif px < trough:
            trough_t, trough = t, px
    if trough / peak - 1 <= -min_decline:
        episodes.append((peak_t, trough_t, trough / peak - 1))
    return episodes


def trend_metrics(trend: pd.Series, close: pd.Series, episodes) -> dict:
    trend = trend.dropna()
    close = close.loc[trend.index]
    ret = close.pct_change()
    fwd_vol = ret.rolling(21).std().shift(-21) * math.sqrt(252)
    fwd_ret = close.shift(-63) / close - 1
    fwd_min = close[::-1].rolling(63, min_periods=1).min()[::-1].shift(-1)
    fwd_dd = fwd_min / close - 1
    years = len(trend) / 252
    spells = (trend != trend.shift()).cumsum()
    spell_len = trend.groupby(spells).size()

    out = {"switches/yr": round((trend != trend.shift()).sum() / years, 1),
           "median spell": int(spell_len.median())}
    for label in ("Bull", "Sideways", "Bear"):
        mask = trend == label
        out[f"{label} %"] = round(100 * mask.mean(), 1)
        out[f"{label} fwdVol"] = round(100 * fwd_vol[mask].median(), 1)
        out[f"{label} fwd63"] = round(100 * fwd_ret[mask].mean(), 1)
        out[f"{label} fwdDD"] = round(100 * fwd_dd[mask].median(), 1)

    lags, coverage, recovery = [], [], []
    for peak, trough, _ in episodes:
        span = trend.loc[peak:trough]
        first_bear = span.index[span == "Bear"]
        lags.append(len(span.loc[:first_bear[0]]) - 1 if len(first_bear) else len(span))
        coverage.append((span == "Bear").mean())
        after = trend.loc[trough:]
        first_bull = after.index[after == "Bull"]
        recovery.append(len(after.loc[:first_bull[0]]) - 1 if len(first_bull) else len(after))
    out["bear lag (d)"] = int(np.median(lags))
    out["bear cover %"] = round(100 * float(np.mean(coverage)), 0)
    out["bull lag (d)"] = int(np.median(recovery))  # trough -> first Bull label
    return out


def run_regime_confirm() -> None:
    """Sweep the fast-to-de-risk / slow-to-re-risk confirmation window."""
    spx, vix = long_history("^GSPC").loc["1989-01-01":], long_history("^VIX")["close"]
    ind = an.add_indicators(spx)
    vix = vix.reindex(ind.index).ffill()
    eval_start = "1990-01-02"
    close = ind["close"]
    episodes = drawdown_episodes(close.loc[eval_start:])
    ret = close.pct_change()
    fwd_vol = ret.rolling(21).std().shift(-21) * math.sqrt(252)

    print("== Trend: confirmation days x sideways band (drawdown override 20%) ==")
    rows = []
    for band in (0.005, 0.01, 0.015, 0.02):
        for n in (1, 3, 5, 10, 15, 20):
            params = dataclasses.replace(an.REGIME_PARAMS, sideways_band=band, trend_confirm_days=n)
            trend = an.classify_regimes(ind.close, ind.sma_50, ind.sma_200, vix, params)["trend"].loc[eval_start:]
            m = trend_metrics(trend, close, episodes)
            rows.append({"band": band, "confirm": n, **{k: m[k] for k in (
                "switches/yr", "median spell", "Bull %", "Bull fwdVol", "Bull fwdDD", "Sideways %",
                "Bear %", "Bear fwdVol", "Bear fwdDD", "bear lag (d)", "bear cover %", "bull lag (d)")}})
    print(pd.DataFrame(rows).to_string(index=False))

    print("\n== Volatility: confirmation days x cut-offs ==")
    rows = []
    for calm, volatile in ((15, 24), (16, 24), (16, 25), (15, 25)):
        for n in (1, 3, 5, 10, 15):
            params = dataclasses.replace(an.REGIME_PARAMS, vix_calm=calm, vix_volatile=volatile,
                                         vol_confirm_days=n)
            lab = an.classify_regimes(ind.close, ind.sma_50, ind.sma_200, vix, params)["volatility"].loc[eval_start:].dropna()
            fv = fwd_vol.reindex(lab.index)
            spells = lab.groupby((lab != lab.shift()).cumsum()).size()
            rows.append({"calm<": calm, "volatile>=": volatile, "confirm": n,
                         "switches/yr": round((lab != lab.shift()).sum() / (len(lab) / 252), 1),
                         "median spell": int(spells.median()),
                         **{f"{k} %": round(100 * (lab == k).mean(), 1) for k in ("Calm", "Normal", "Volatile")},
                         **{f"{k} fwdVol": round(100 * fv[lab == k].median(), 1) for k in ("Calm", "Normal", "Volatile")}})
    print(pd.DataFrame(rows).to_string(index=False))


def run_regime() -> None:
    spx, vix = long_history("^GSPC"), long_history("^VIX")["close"]
    spx = spx.loc["1989-01-01":]
    ind = an.add_indicators(spx)
    eval_start = "1990-01-02"
    close = ind["close"]
    episodes = drawdown_episodes(close.loc[eval_start:])
    print(f"S&P 500 {close.index[0].date()}..{close.index[-1].date()}; evaluation from {eval_start}")
    print("Drawdowns >= 19%:", ", ".join(f"{p.date()}->{t.date()} ({d:.0%})" for p, t, d in episodes))

    def labels(params):
        out = an.classify_regimes(ind.close, ind.sma_50, ind.sma_200, vix.reindex(ind.index).ffill(), params)
        return out.loc[eval_start:]

    print("\n== Trend: sideways band x bear-drawdown override ==")
    rows = []
    for band in (0.0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04):
        for dd in (0.15, 0.20, 0.25, 1.0):
            params = dataclasses.replace(an.REGIME_PARAMS, sideways_band=band, bear_drawdown=dd)
            rows.append({"band": band, "drawdown": "off" if dd == 1.0 else dd,
                         **trend_metrics(labels(params)["trend"], close, episodes)})
    print(pd.DataFrame(rows).to_string(index=False))

    print("\n== VIX distribution (1990-) and forward S&P realised vol by VIX level ==")
    v = vix.loc[eval_start:]
    print("percentiles:", {q: round(float(v.quantile(q)), 1) for q in (0.1, 0.25, 0.35, 0.5, 0.65, 0.75, 0.8, 0.9, 0.95)})
    ret = close.pct_change()
    fwd_vol = (ret.rolling(21).std().shift(-21) * math.sqrt(252)).reindex(v.index)
    buckets = pd.cut(v, [0, 12, 14, 16, 18, 20, 22, 24, 27, 30, 35, 200])
    table = pd.DataFrame({"share %": (100 * buckets.value_counts(normalize=True)).round(1),
                          "fwd vol %": (100 * fwd_vol.groupby(buckets, observed=True).median()).round(1)})
    print(table.sort_index().T.to_string())

    print("\n== Volatility label: calm / volatile cut-offs ==")
    rows = []
    for calm in (14, 15, 16, 17, 18):
        for volatile in (22, 24, 25, 26, 28, 30):
            params = dataclasses.replace(an.REGIME_PARAMS, vix_calm=calm, vix_volatile=volatile)
            vol_label = labels(params)["volatility"].dropna()
            fv = fwd_vol.reindex(vol_label.index)
            switches = (vol_label != vol_label.shift()).sum() / (len(vol_label) / 252)
            rows.append({"calm<": calm, "volatile>=": volatile, "switches/yr": round(switches, 1),
                         **{f"{k} %": round(100 * (vol_label == k).mean(), 1) for k in ("Calm", "Normal", "Volatile")},
                         **{f"{k} fwdVol": round(100 * fv[vol_label == k].median(), 1) for k in ("Calm", "Normal", "Volatile")}})
    print(pd.DataFrame(rows).to_string(index=False))

    print("\n== VIX spike rule (VIX >= floor and >= ratio x 60d median), on days below the volatile cut-off ==")
    median60 = v.rolling(60, min_periods=20).median()
    rows = []
    for floor in (18, 20, 22):
        for ratio in (1.2, 1.3, 1.5):
            spike = (v >= floor) & (v >= ratio * median60) & (v < 24)
            base = (v >= floor) & (v < 24) & ~spike
            rows.append({"floor": floor, "ratio": ratio, "spike days %": round(100 * spike.mean(), 1),
                         "fwdVol spike": round(100 * fwd_vol[spike].median(), 1),
                         "fwdVol same-VIX no spike": round(100 * fwd_vol[base].median(), 1)})
    print(pd.DataFrame(rows).to_string(index=False))


def run_regime_stance() -> None:
    """Risk score -> stance cut-offs, using the macro series stored in the database."""
    from quant.db import init_db, session_scope
    from quant.ingestion.macro_data import load_macro

    with session_scope(init_db()) as session:
        macro = load_macro(session)
    spx, vix = long_history("^GSPC").loc["1999-01-01":], long_history("^VIX")["close"]
    hist = an.market_regime_history(an.add_indicators(spx), vix, macro).loc["2001-01-01":]
    close = hist["close"]
    ret = close.pct_change()
    fwd_vol = ret.rolling(21).std().shift(-21) * math.sqrt(252)
    fwd_dd = close[::-1].rolling(63, min_periods=1).min()[::-1].shift(-1) / close - 1
    risk = hist["risk_score"]
    print(f"{hist.index[0].date()}..{hist.index[-1].date()}; risk score percentiles:",
          {q: round(float(risk.quantile(q)), 2) for q in (0.1, 0.25, 0.5, 0.75, 0.9)})
    known = hist[["curve_inverted", "sahm_triggered", "credit_stress", "inflation_hot"]].notna().mean().round(2)
    print("macro inputs available (share of days):", known.to_dict())

    buckets = pd.cut(risk, [-0.01, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0])
    print("\nForward risk by risk-score bucket:")
    print(pd.DataFrame({"share %": (100 * buckets.value_counts(normalize=True)).round(1),
                        "fwd vol %": (100 * fwd_vol.groupby(buckets, observed=True).median()).round(1),
                        "fwd 63d DD %": (100 * fwd_dd.groupby(buckets, observed=True).median()).round(1)}
                       ).sort_index().T.to_string())

    rows = []
    for on, off in ((0.25, 0.5), (0.3, 0.55), (0.33, 0.6), (0.35, 0.65), (0.4, 0.7)):
        stance = pd.Series(np.select([risk < on, risk > off], ["Risk-On", "Risk-Off"], default="Neutral"), index=risk.index)
        row = {"on<": on, "off>": off, "switches/yr": round((stance != stance.shift()).sum() / (len(stance) / 252), 1)}
        for k in ("Risk-On", "Neutral", "Risk-Off"):
            m = stance == k
            row.update({f"{k} %": round(100 * m.mean(), 1), f"{k} fwdVol": round(100 * fwd_vol[m].median(), 1),
                        f"{k} fwdDD": round(100 * fwd_dd[m].median(), 1)})
        rows.append(row)
    print("\nStance cut-offs (raw, no confirmation):")
    print(pd.DataFrame(rows).to_string(index=False))

    sticky = hist["stance"]  # production stance: 0.33 / 0.6 with REGIME_PARAMS.stance_confirm_days
    row = {"switches/yr": round((sticky != sticky.shift()).sum() / (len(sticky) / 252), 1)}
    for k in ("Risk-On", "Neutral", "Risk-Off"):
        m = sticky == k
        row.update({f"{k} %": round(100 * m.mean(), 1), f"{k} fwdVol": round(100 * fwd_vol[m].median(), 1),
                    f"{k} fwdDD": round(100 * fwd_dd[m].median(), 1)})
    print(f"\nProduction stance (0.33 / 0.6, {an.REGIME_PARAMS.stance_confirm_days}-day confirmation):")
    print(pd.DataFrame([row]).to_string(index=False))


# --- anomalies -------------------------------------------------------------------

from quant.config import PREDECESSOR_CIKS as EXTRA_CIKS  # noqa: E402  (ExxonMobil's pre-2026 CIK)


def earnings_releases(tickers: list[str]) -> dict[str, list[pd.Timestamp]]:
    """8-K Item 2.02 (earnings release) acceptance times in UTC, cached for a week.
    Tickers missing from a fresh cache are fetched and added (one filer at a time)."""
    import json

    from quant.ingestion.sec_edgar import SUBMISSIONS_PAGE_URL, SECClient

    settings = get_settings()
    cache = settings.cache_dir / "calibration_earnings.json"
    fresh = cache.exists() and time.time() - cache.stat().st_mtime < CACHE_MAX_AGE
    raw = json.loads(cache.read_text()) if fresh else {}
    todo = [t for t in tickers if t not in raw]
    if todo:
        client = SECClient(settings.sec_user_agent, settings.cache_dir)
        by_cik: dict[int, list[str]] = {}
        for n, ticker in enumerate(todo, 1):
            stamps = []
            for cik in [client.cik_for(ticker), *EXTRA_CIKS.get(ticker, [])]:
                if cik is None:  # no longer an SEC registrant under this symbol
                    continue
                if cik not in by_cik:
                    found = []
                    subs = client.submissions(cik)
                    blocks = [subs["filings"]["recent"]] + [
                        client._get_json(SUBMISSIONS_PAGE_URL.format(name=f["name"])) for f in subs["filings"].get("files", [])
                    ]
                    for block in blocks:
                        for form, items, accepted in zip(block["form"], block["items"], block["acceptanceDateTime"]):
                            if form == "8-K" and "2.02" in items.split(","):
                                found.append(accepted[:19])  # UTC (Apple's 4:30pm ET release = 00:30Z next day)
                    by_cik[cik] = found
                stamps += by_cik[cik]
            raw[ticker] = sorted(set(stamps))
            if n % 50 == 0:
                print(f"  8-K earnings dates: {n}/{len(todo)} tickers", flush=True)
        cache.write_text(json.dumps(raw))
    return {t: [pd.Timestamp(s) for s in raw[t]] for t in tickers}


def reaction_days(releases: list[pd.Timestamp], sessions: pd.DatetimeIndex) -> set[pd.Timestamp]:
    """Session whose close-to-close return first reflects each release."""
    days = set()
    for ts in releases:
        local = ts.tz_localize("UTC").tz_convert(an.EXCHANGE_TZ).tz_localize(None)
        day = local.normalize()
        after_close = local.hour >= an.SESSION_CLOSE_HOUR
        i = sessions.searchsorted(day, side="right" if after_close else "left")
        if i < len(sessions):
            days.add(sessions[i])
    return days


def run_anomalies(universe: str | None = None) -> None:
    """Daily rules are scored per stock; with ``universe="sp500"`` every stock that was
    an S&P 500 member during the price history counts, but only on its member sessions."""
    from quant.db import init_db, session_scope
    from quant.ingestion.index_membership import load_membership, membership_mask, universe_tickers
    from quant.ingestion.market_data import load_bars, load_daily_bars

    settings = get_settings()
    universe = universe or settings.research_universe
    with session_scope(init_db()) as session:
        if universe == "watchlist":
            tickers, intervals = list(settings.equities), None
            bars = {t: load_bars(session, t, "1d") for t in tickers}
        else:
            intervals = load_membership(session, universe)
            candidates = universe_tickers(intervals, settings.history_start)
            bars = load_daily_bars(session, candidates)
            tickers = [t for t in candidates if t in bars and len(bars[t]) > 80]  # 60-day sigma warm-up
        spy = load_bars(session, "SPY", "1d")["adj_close"].pct_change()
        intraday = {t: load_bars(session, t, "15m") for t in tickers}
    releases = earnings_releases(tickers)

    data, short_stints = {}, []
    for t in tickers:
        sessions = pd.DatetimeIndex(bars[t].index)
        member = None if intervals is None else membership_mask(intervals, sessions, [t])[t]
        ret = bars[t]["adj_close"].pct_change()
        beta = an.estimate_beta(ret, spy, window=len(ret))
        expected = beta * spy.reindex(sessions)
        market_driven = (np.sign(expected) == np.sign(ret)) & (expected.abs() >= 0.5 * ret.abs())
        earn = reaction_days(releases[t], sessions)
        if member is not None:
            if member.sum() < 252:  # under a year in the index: per-year flag rates would be noise
                short_stints.append(t)
                continue
            earn = {d for d in earn if member[d]}
        data[t] = {"bars": bars[t], "earn": earn, "market": market_driven, "member": member,
                   "years": (len(sessions) if member is None else int(member.sum())) / 252}
    if intervals is None:
        print("Earnings releases found:", {t: len(d["earn"]) for t, d in data.items()})
    else:
        found = pd.Series({t: len(d["earn"]) for t, d in data.items()})
        print(f"{universe}: {len(data)} stocks, {data and sum(d['years'] for d in data.values()):.0f} member-years; "
              f"8-K earnings releases on member sessions: {found.sum()} (median {found.median():.0f} per stock, "
              f"{(found == 0).sum()} stocks with none: no longer SEC registrants under that symbol); "
              f"{len(short_stints)} stocks with under a year of member sessions left out")

    # Ground-truth check: the mapped reaction day should show the biggest moves.
    align = {}
    for t, d in data.items():
        if not d["earn"]:
            continue
        idx = pd.DatetimeIndex(d["bars"].index)
        excess = (d["bars"]["adj_close"].pct_change() - spy.reindex(idx)).abs()
        pos = idx.get_indexer(sorted(d["earn"]))
        align[t] = {f"day{k:+d}": round(float(excess.iloc[pos[(pos + k >= 0) & (pos + k < len(idx))] + k].median()
                                               / excess.median()), 1) for k in (-1, 0, 1)}
    print("Median |excess return| around each mapped reaction day (x a normal day):")
    if intervals is None:
        print(pd.DataFrame(align).to_string())
    else:
        print("  median across stocks:", pd.DataFrame(align).median(axis=1).round(1).to_dict())

    def evaluate(rules: dict) -> dict:
        per_ticker, flags_all, earn_hits, earn_total, mkt = {}, 0, 0, 0, 0
        for t, d in data.items():
            flagged = an.detect_anomalies(d["bars"], "1d", **rules).index
            if d["member"] is not None:
                flagged = flagged[d["member"].reindex(flagged).fillna(False).to_numpy(dtype=bool)]
            per_ticker[t] = len(flagged) / d["years"]
            flags_all += len(flagged)
            earn_hits += len(d["earn"] & set(flagged))
            earn_total += len(d["earn"])
            mkt += int(d["market"].reindex(flagged).fillna(False).sum())
        on_earn = earn_hits  # flags that fall on an earnings reaction day
        rates = pd.Series(per_ticker)
        return {"flags/tkr/yr": round(rates.mean(), 1), "calmest": round(rates.min(), 1),
                "busiest": round(rates.max(), 1), "busiest/calmest": round(rates.max() / max(rates.min(), 0.1), 1),
                **({} if intervals is None else {"p90/p10": round(rates.quantile(0.9) / max(rates.quantile(0.1), 0.1), 1)}),
                "earnings caught %": round(100 * earn_hits / earn_total, 0),
                "flags on earnings %": round(100 * on_earn / max(flags_all, 1), 0),
                "market-driven %": round(100 * mkt / max(flags_all, 1), 0)}

    print("\n== Daily rules (robust sigma, 60-day window) ==")
    rows = []
    for abs_move in (0.05, 0.08, 1.0):
        for z in (2.5, 3.0, 3.5, 4.0):
            for min_move in (0.015, 0.02, 0.03):
                rules = {"abs_move": abs_move, "z": z, "min_move": min_move}
                rows.append({"abs_move": "off" if abs_move == 1.0 else abs_move, "z": z, "min_move": min_move, **evaluate(rules)})
    print(pd.DataFrame(rows).to_string(index=False))

    print("\n== Intraday 15m (last ~30 days): opening bars vs the rest ==")
    rows = []
    for abs_move in (0.03, 1.0):
        for z in (3.0, 4.0, 5.0, 6.0):
            for min_move in (0.0075, 0.01, 0.015):
                rules = {"abs_move": abs_move, "z": z, "min_move": min_move}
                n_open = n_other = 0
                days = 0
                for t, b in intraday.items():
                    if b.empty:
                        continue
                    flagged = an.detect_anomalies(b, "15m", **rules).index
                    local = flagged.tz_localize("UTC").tz_convert(an.EXCHANGE_TZ)
                    is_open = (local.hour == 9) & (local.minute == 30)
                    n_open += int(is_open.sum())
                    n_other += int((~is_open).sum())
                    days += pd.DatetimeIndex(b.index).normalize().nunique()
                rows.append({"abs_move": "off" if abs_move == 1.0 else abs_move, "z": z, "min_move": min_move,
                             "open-bar flags/tkr/day": round(n_open / days * 1, 3),
                             "other flags/tkr/day": round(n_other / days, 3),
                             "open share %": round(100 * n_open / max(n_open + n_other, 1), 0)})
    print(pd.DataFrame(rows).to_string(index=False))


# --- relevance -------------------------------------------------------------------

LABELS = ROOT / "tests" / "fixtures" / "relevance_labels.csv"


def run_relevance() -> None:
    import csv

    from sqlalchemy import select

    from quant.config import DEFAULT_ALIASES
    from quant.db import init_db, session_scope
    from quant.ingestion.relevance import build_aliases, is_research_firm, relevance_score
    from quant.models import Company

    with session_scope(init_db()) as session:
        companies = {c.ticker: (c.name, c.sic) for c in session.scalars(select(Company))}
    with LABELS.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    scored = []
    for row in rows:
        t = row["ticker"]
        name, sic = companies.get(t, (None, None))
        aliases = build_aliases(t, name, DEFAULT_ALIASES.get(t, ()))
        scored.append((relevance_score(row["title"], None, t, aliases, is_research_firm(sic)), int(row["label"]), row))

    print(f"{len(rows)} hand-labelled headlines, {sum(lab for _, lab, _ in scored)} relevant (title-only scoring)")
    print("score tiers:", pd.Series([s for s, _, _ in scored]).value_counts().sort_index().to_dict())
    for threshold in (0.4, 0.5, 0.75):
        tp = sum(s >= threshold and lab for s, lab, _ in scored)
        fp = sum(s >= threshold and not lab for s, lab, _ in scored)
        fn = sum(s < threshold and lab for s, lab, _ in scored)
        print(f"threshold {threshold}: precision {tp / (tp + fp):.1%}  recall {tp / (tp + fn):.1%}  (fp={fp}, fn={fn})")

    print("\nRemaining errors at 0.5:")
    for s, lab, row in sorted(scored, key=lambda x: (x[1], x[0])):
        if (s >= 0.5) != bool(lab):
            print(f"  {'FN' if lab else 'FP'} {s:.2f} {row['ticker']:<5} {row['title'][:110]}")


COMMANDS = {"regime": run_regime, "regime-confirm": run_regime_confirm, "regime-stance": run_regime_stance,
            "anomalies": run_anomalies, "relevance": run_relevance}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("section", choices=sorted(COMMANDS))
    parser.add_argument("--universe", choices=("watchlist", "sp500"),
                        help="anomalies only: stocks to score (default: RESEARCH_UNIVERSE, else watchlist)")
    args = parser.parse_args()
    COMMANDS[args.section](**({"universe": args.universe} if args.section == "anomalies" else {}))
