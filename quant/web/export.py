"""Export everything the dashboard shows as static JSON for the GitHub Pages site.

    python -m quant.web.export            # build the site in data/site (code from docs/ + data)
    python -m quant.web.publish           # export, then push data/site to the gh-pages branch

The data comes from the same functions the Streamlit pages call (dashboard/common.py),
so the website and the local dashboard show the same numbers. Files written to
data/site/data/:

  meta.json       freshness dates and counts
  global.json     regimes + the screener (every stock, ETF and coin, columnar)
  indices.json    the market-regime benchmark indices with returns and trend
  symbols.json    [symbol, name, class, market] for search and autocomplete
  sym/<xx>.json   per symbol: ~2 years of adjusted daily closes + fundamentals, in 256
                  buckets keyed by FNV-1a(symbol), so any ticker's page loads one small file
  factors.json    daily Fama-French factors (FF3, momentum, FF5) for in-browser regressions
  market.json     regime, S&P 500 with stance history, FRED tiles, the 3-month T-bill rate,
                  watchlist movers, news
  deep/<T>.json   per deep-tier ticker: OHLCV + adjusted close + indicators, news markers,
                  unusual moves, headlines, SEC financials, rolling factor betas
  research.json   factor exposures (FF3, Carhart, FF5), composite scores, strategy backtests
  quantum.json    the nightly quantum simulations (quant/web/quantum.py, run in a subprocess with
                  a timeout): the last good result, kept when a run fails
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import shutil
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web")

ROOT = Path(__file__).resolve().parents[2]
SITE_SRC = ROOT / "docs"
PX_ROWS = 600  # daily closes per symbol (the store keeps ~800 calendar days, about 550 sessions)
BUCKETS = 256
FACTOR_YEARS = 5
INDEX_NAMES = {"^GSPC": "S&P 500", "^GSPTSE": "S&P/TSX Composite", "^STOXX": "STOXX Europe 600",
               "^N225": "Nikkei 225", "^KS11": "KOSPI", "^HSI": "Hang Seng", "^TWII": "TAIEX",
               "^NSEI": "Nifty 50", "^AXJO": "S&P/ASX 200", "^VIX": "CBOE Volatility Index"}
# Per-symbol fundamentals for the research view: short key -> scores column.
INFO_FIELDS = {
    "ex": "exchange", "reg": "region", "ind": "industry", "cat": "category", "fpe": "forward_pe",
    "tpe": "trailing_pe", "pecy": "pe_current_year", "pb": "price_to_book", "eve": "ev_to_ebitda",
    "dy": "dividend_yield", "roe": "return_on_equity", "pm": "profit_margin", "de": "debt_to_equity",
    "rg": "revenue_growth", "eg": "earnings_growth", "beta": "beta", "er": "expense_ratio",
    "aum": "fund_assets_usd", "ar": "analyst_rating", "al": "analyst_label", "w52": "fifty_two_week_change",
    "vol": "volatility", "mdd": "max_drawdown_1y", "adv": "adv_usd", "m61": "mom_6_1", "cross": "cross_type",
    "cross_ago": "cross_sessions_ago", "cg": "coingecko_id", "rank": "rank",
}
FRED_TILES = [  # (series, label, unit, transform, inverse, digits) as on the Market Overview page
    ("DGS10", "10Y Treasury", "%", None, False, 2), ("DGS2", "2Y Treasury", "%", None, False, 2),
    ("T10Y2Y", "10Y-2Y curve", "pp", None, False, 2), ("DFF", "Fed funds", "%", None, False, 2),
    ("T10YIE", "10Y breakeven", "%", None, False, 2), ("CPILFESL", "Core CPI y/y", "%", "yoy", True, 1),
    ("UNRATE", "Unemployment", "%", None, True, 1), ("ICSA", "Jobless claims", "k", "thousands", True, 0),
    ("VIXCLS", "VIX", "", None, True, 1), ("BAA10Y", "Baa credit spread", "pp", None, True, 2),
]


# --- JSON helpers --------------------------------------------------------------------------------

def sig(x, digits: int = 5):
    """Round to significant digits; NaN/inf -> None."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x):
        return None
    return 0.0 if x == 0 else float(f"{x:.{digits}g}")


def rnd(x, places: int = 4):
    v = sig(x, 15)
    return None if v is None else round(v, places)


def clean(x):
    """Make anything JSON-serialisable (numpy, pandas, dates, NaN)."""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [clean(v) for v in x]
    if isinstance(x, np.ndarray):
        return [clean(v) for v in x.tolist()]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return sig(x, 6)
    if x is pd.NaT or x is None:
        return None
    if isinstance(x, pd.Timestamp):
        return x.isoformat()
    if isinstance(x, (dt.datetime, dt.date)):
        return x.isoformat()
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    return x


def write(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(clean(obj), separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def fnv1a(text: str) -> int:
    """32-bit FNV-1a over UTF-8 bytes; the site computes the same hash to find a symbol's bucket."""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def bucket(symbol: str) -> str:
    return f"{fnv1a(symbol) % BUCKETS:02x}"


def dates(index) -> list[str]:
    return [f"{d:%Y-%m-%d}" for d in pd.DatetimeIndex(index)]


def series(values, digits: int = 5) -> list:
    return [sig(v, digits) for v in values]


# --- global universe (broad tier) ----------------------------------------------------------------

SCREENER_COLS = [
    "s", "n", "a", "m", "sec", "sig", "sc", "t", "mo", "v", "q", "r", "an", "co", "r1d", "r1w", "r1m", "r3m", "ytd",
    "m121", "fpe", "tpe", "pb", "dy", "roe", "cap", "u", "z", "px", "cur", "rsi", "d200", "also", "lab", "why", "sp",
]


def _spark(points) -> list[int] | None:
    if not isinstance(points, (list, np.ndarray)) or len(points) < 2:
        return None
    v = np.asarray(points, dtype=float)
    v = v[np.isfinite(v)]
    if len(v) < 2:
        return None
    lo, hi = v.min(), v.max()
    return [50] * len(v) if hi == lo else [int(round(99 * (x - lo) / (hi - lo))) for x in v]


def export_global(out: Path) -> dict:
    from quant.universe.prices import load as load_prices
    from quant.universe.scoring import BENCHMARKS, load_regimes, load_scores, price_metrics

    scores = load_scores()
    regimes = load_regimes().reset_index()
    if scores.empty:
        return {"global": 0}
    cls = {"stock": "s", "etf": "e", "crypto": "c"}
    sector = scores.sector.where(scores.asset_class == "stock", scores.get("category"))
    rows = []
    for i, r in enumerate(scores.itertuples(index=False)):
        rows.append([
            r.symbol, r.name, cls.get(r.asset_class, r.asset_class), r.market, None if pd.isna(sector.iloc[i]) else sector.iloc[i],
            r.signal, rnd(r.composite, 1), rnd(r.trend, 0), rnd(r.momentum, 0), rnd(r.value, 0), rnd(r.quality, 0),
            rnd(r.risk, 0), rnd(r.analysts, 0), rnd(r.cost, 0), rnd(r.ret_1d), rnd(r.ret_1w), rnd(r.ret_1m), rnd(r.ret_3m),
            rnd(r.ret_ytd), rnd(r.mom_12_1), rnd(r.pe_current_year, 1), rnd(r.trailing_pe, 1), rnd(r.price_to_book, 2),
            rnd(r.dividend_yield, 2), rnd(r.return_on_equity), rnd(None if pd.isna(r.market_cap_usd) else r.market_cap_usd / 1e9, 2),
            1 if bool(r.unusual) else 0, rnd(r.zscore_1d, 1), sig(r.last_close, 6), r.currency, rnd(r.rsi_14, 0),
            rnd(r.dist_200), None if pd.isna(r.also_listed) else r.also_listed,
            None if pd.isna(r.analyst_label) else r.analyst_label, r.rationale, _spark(r.sparkline),
        ])
    size = write(out / "global.json", {
        "scored_at": pd.Timestamp(scores.scored_at.max()).isoformat(),
        "regimes": regimes.to_dict("records"),
        "cols": SCREENER_COLS, "rows": rows,
    })

    # Indices (benchmarks of the market regimes) join the search and the watchlist.
    close, volume = load_prices("close"), load_prices("volume")
    screened = set(scores.symbol)
    idx_syms = [s for s in INDEX_NAMES if s in close and s not in screened]
    market_of = {sym: m for m, sym in BENCHMARKS.items() if m != "US ETFs"}
    imetrics = price_metrics(close[idx_syms], volume.reindex(columns=idx_syms), set()) if idx_syms else pd.DataFrame()
    indices = []
    for sym in idx_syms:
        if sym not in imetrics.index:
            continue
        m = imetrics.loc[sym]
        indices.append({"s": sym, "n": INDEX_NAMES[sym], "a": "i", "m": market_of.get(sym, "US"),
                        "px": sig(m.last_close, 6), "r1d": rnd(m.ret_1d), "r1w": rnd(m.ret_1w), "r1m": rnd(m.ret_1m),
                        "r3m": rnd(m.ret_3m), "ytd": rnd(m.ret_ytd), "d200": rnd(m.dist_200), "rsi": rnd(m.rsi_14, 0),
                        "vol": rnd(m.volatility), "mdd": rnd(m.max_drawdown_1y), "sp": _spark(m.sparkline)})
    size += write(out / "indices.json", indices)
    size += write(out / "symbols.json", [r[:4] for r in rows] + [[i["s"], i["n"], "i", i["m"]] for i in indices])

    # Per-symbol prices + fundamentals, bucketed so any ticker's page loads ~1/256 of the data.
    info = scores.drop_duplicates("symbol").set_index("symbol")
    buckets: dict[str, dict] = {}
    for sym in list(scores.symbol) + [i["s"] for i in indices]:
        entry: dict = {}
        if sym in close:
            s = close[sym].dropna().tail(PX_ROWS)
            if len(s) >= 2:
                days = pd.DatetimeIndex(s.index)
                gaps = np.diff(days.values).astype("timedelta64[D]").astype(int).tolist()
                entry["p"] = [f"{days[0]:%Y-%m-%d}", gaps, series(s.to_numpy(), 6)]
        if sym in info.index:
            row = info.loc[sym]
            fields = {k: clean(row[col]) for k, col in INFO_FIELDS.items() if col in row.index}
            entry["i"] = {k: v for k, v in fields.items() if v is not None}
        if entry:
            buckets.setdefault(bucket(sym), {})[sym] = entry
    for old in ("px", "sym"):
        shutil.rmtree(out / old, ignore_errors=True)
    sym_size = sum(write(out / "sym" / f"{b}.json", content) for b, content in buckets.items())
    return {"global": size, "sym": sym_size, "symbols": len(rows), "indices": len(indices)}


def export_factors(out: Path) -> int:
    """Daily factors for in-browser regressions (the same series the Python models use)."""
    from quant.db import init_db, session_scope
    from quant.ingestion.factors import STORED, load_factors

    with session_scope(init_db()) as s:
        f = load_factors(s)
    if len(f):
        f = f.loc[f.index >= f.index.max() - pd.DateOffset(years=FACTOR_YEARS)]
    return write(out / "factors.json", {"d": dates(f.index), **{col: series(f[col], 5) for col in STORED if col in f}})


# --- deep tier ------------------------------------------------------------------------------------

def _tone(score) -> str:
    if score is None or pd.isna(score):
        return "neutral"
    return "bullish" if score > 0.15 else "bearish" if score < -0.15 else "neutral"


def _news_markers(daily: pd.DataFrame, news: pd.DataFrame) -> list[dict]:
    """One marker per session, as on the Stock Deep Dive page: headlines after 16:00 ET count
    for the next session."""
    if news.empty:
        return []
    sessions = daily.index
    pub = news.published_et
    after_close = (pub.dt.hour >= 16).to_numpy()
    norm = pub.dt.normalize().to_numpy()
    pos = np.where(after_close, sessions.searchsorted(norm, side="right"), sessions.searchsorted(norm, side="left"))
    bars = pd.Series([sessions[i] if i < len(sessions) else pd.NaT for i in pos], index=news.index)
    df = news.assign(bar=bars).dropna(subset=["bar"])
    out = []
    for bar, g in df.groupby("bar"):
        score = g.sentiment_score.mean()
        out.append({"d": f"{bar:%Y-%m-%d}", "score": sig(score, 3), "n": len(g), "tone": _tone(score),
                    "titles": g.title.head(4).tolist()})
    return out


def _financials(c, qm, tb, ticker: str) -> dict | None:
    fund = c.filings(ticker)
    if fund.empty:
        return None
    q = c.quarterly(ticker)
    snap = qm.ttm_snapshot(fund)
    growth = tb.earnings_growth(q)
    latest = fund.iloc[0]
    fcf = (snap["operating_cash_flow"] - snap["capital_expenditure"]
           if snap and pd.notna(snap["capital_expenditure"]) else None)
    eps_ttm = q.eps_diluted.tail(4).sum(min_count=4) if len(q) >= 4 else None
    de = (snap["total_debt"] / snap["stockholders_equity"]
          if snap and snap["stockholders_equity"] and pd.notna(snap["total_debt"]) else None)
    recent = q.tail(12)
    return {
        "latest": {"form": latest.form, "period": latest.report_date, "filed": latest.filing_date,
                   "url": latest.filing_url},
        "basis": snap["basis"] if snap else None,
        "ttm": {"revenue": snap["revenue"] if snap else None, "net_income": snap["net_income"] if snap else None,
                "fcf": fcf, "eps": eps_ttm, "de": de},
        "growth": growth,
        "quarters": {
            "labels": [f"{d:%b %Y}" for d in recent.report_date],
            "revenue": series(recent.revenue, 6), "net_income": series(recent.net_income, 6),
            "ocf": series(recent.operating_cash_flow, 6), "capex": series(recent.capital_expenditure, 6),
        },
        "filings": [{"form": r.form, "period": r.report_date, "filed": r.filing_date, "revenue": sig(r.revenue, 6),
                     "net_income": sig(r.net_income, 6), "eps": sig(r.eps_diluted, 4), "de": sig(r.debt_to_equity, 3),
                     "ocf": sig(r.operating_cash_flow, 6), "cf_days": r.cash_flow_period_days, "url": r.filing_url}
                    for r in fund.itertuples(index=False)],
    }


def export_deep(out: Path, c) -> dict:
    from quant import analytics as an
    from quant import quant_models as qm
    from quant import trading_bot as tb

    ctx = c.context()
    scores = c.scores()
    news_all = c.headlines(limit=5000)
    tickers = list(ctx.universe.tickers)
    deep_dir = out / "deep"
    shutil.rmtree(deep_dir, ignore_errors=True)
    total = 0
    index = []
    for t in tickers:
        daily = ctx.bars[t]
        snap = an.indicator_snapshot(daily)
        info = c.company(t)
        news = news_all[news_all.ticker == t].copy()
        moves = c.anomalies(t, "1d", days=3 * 365 + 30)
        row = scores.loc[t] if t in scores.index else None
        cols = {"o": "open", "h": "high", "l": "low", "c": "close", "ac": "adj_close", "v": "volume", "ma50": "sma_50",
                "ma200": "sma_200", "rsi": "rsi_14", "bbu": "bb_upper", "bbl": "bb_lower"}
        bars = {k: series(daily[col].to_numpy(), 6 if k != "rsi" else 3) for k, col in cols.items() if col in daily}
        rolling = {}
        for model in qm.MODELS:
            try:  # rolling_exposures already steps monthly; keep every point
                roll = c.rolling_betas(t, model).dropna(how="all")
                rolling[model] = {"d": dates(roll.index), **{f: series(roll[f], 3) for f in roll.columns}}
            except Exception:
                log.exception("rolling betas failed for %s %s", t, model)
        doc = {
            "ticker": t, "name": info.get("name") or t, "sic": info.get("sic_description"),
            "exchange": info.get("exchange"), "cik": info.get("cik"),
            "snapshot": {k: snap.get(k) for k in ("date", "close", "sma_50", "sma_200", "rsi_14", "readings")},
            "score": None if row is None else {"composite": row["composite"], "rank": row["rank"],
                                               "of": len(scores), "momentum_12_1": row["momentum_12_1"]},
            "d": dates(daily.index), **bars,
            "markers": _news_markers(daily, news),
            "moves": [{"d": f"{pd.Timestamp(m['timestamp']):%Y-%m-%d}", "ret": sig(m["return_pct"], 4),
                       "z": sig(m["zscore"], 3), "driver": m["driver"], "why": m["explanation"],
                       "url": (m["matches"][0] or {}).get("url") if m["matches"] else None} for m in moves],
            "news": [{"t": f"{r.published_et:%Y-%m-%d %H:%M}", "title": r.title, "src": r.publisher,
                      "score": sig(r.sentiment_score, 3), "tone": _tone(r.sentiment_score),
                      "react": sig(r.reaction_return, 4), "url": r.url}
                     for r in news.head(150).itertuples(index=False)],
            "fin": _financials(c, qm, tb, t),
            "rolling": rolling,
        }
        total += write(deep_dir / f"{t.replace('^', '_')}.json", doc)
        index.append({"ticker": t, "name": doc["name"]})
    return {"deep": total, "tickers": index}


# --- market overview ----------------------------------------------------------------------------

def export_market(out: Path, c) -> int:
    ctx = c.context()
    reg = c.regime()
    spx = c.benchmark_bars("^GSPC")
    hist = ctx.regime[["stance"]].dropna()
    runs = (hist.stance != hist.stance.shift()).cumsum()
    stance_runs = [[f"{g.index[0]:%Y-%m-%d}", f"{g.index[-1]:%Y-%m-%d}", g.stance.iloc[0]] for _, g in hist.groupby(runs)]

    macro = c.macro_frame()
    tiles = []
    for sid, label, unit, transform, inverse, digits in FRED_TILES:
        s = macro[sid].dropna() if sid in macro else pd.Series(dtype=float)
        if transform == "yoy":
            s = (s.pct_change(12) * 100).dropna()
        if transform == "thousands":
            s = s / 1000
        if s.empty:
            tiles.append({"id": sid, "label": label, "value": None})
            continue
        prev = s.loc[: s.index[-1] - pd.DateOffset(months=1)]
        spark = s.loc[s.index[-1] - pd.DateOffset(years=2):]
        step = max(1, len(spark) // 120)
        tiles.append({"id": sid, "label": label, "unit": unit, "inverse": inverse, "digits": digits,
                      "value": s.iloc[-1], "delta": s.iloc[-1] - prev.iloc[-1] if len(prev) else None,
                      "date": f"{s.index[-1]:%Y-%m-%d}", "help": c.macro_label(sid),
                      "spark": series(spark.iloc[::step].to_numpy(), 4)})

    # Risk-free rate for the Quantum page's option pricing (3-month T-bill yield).
    bill = macro["DGS3MO"].dropna() if "DGS3MO" in macro else pd.Series(dtype=float)
    rf = None if bill.empty else {"id": "DGS3MO", "label": c.macro_label("DGS3MO"), "value": bill.iloc[-1],
                                  "date": f"{bill.index[-1]:%Y-%m-%d}"}

    scores = c.scores()
    movers = []
    for t in ctx.universe.tickers:
        b = ctx.bars[t]
        px = b.adj_close.dropna()
        ytd = px.loc[str(px.index[-1].year)]
        movers.append({"ticker": t, "close": b.close.iloc[-1], "r1d": px.iloc[-1] / px.iloc[-2] - 1,
                       "r1m": px.iloc[-1] / px.iloc[-22] - 1, "ytd": px.iloc[-1] / ytd.iloc[0] - 1,
                       "golden": bool(b.sma_50.iloc[-1] > b.sma_200.iloc[-1]), "rsi": b.rsi_14.iloc[-1],
                       "score": scores.composite.get(t, np.nan)})

    news = c.headlines().drop_duplicates("title").head(120)
    return write(out / "market.json", {
        "regime": {k: reg.get(k) for k in ("label", "trend", "volatility", "stance", "risk_score", "reasons", "as_of",
                                             "vix")},
        "spx": {"d": dates(spx.index), "c": series(spx.close, 6), "ma50": series(spx.sma_50, 6),
                "ma200": series(spx.sma_200, 6)},
        "stance_runs": stance_runs,
        "fred": tiles,
        "rf": rf,
        "movers": movers,
        "news": [{"t": f"{r.published_et:%Y-%m-%d %H:%M}", "ticker": r.ticker if isinstance(r.ticker, str) else None,
                  "title": r.title, "src": r.publisher, "score": sig(r.sentiment_score, 3),
                  "tone": _tone(r.sentiment_score), "url": r.url} for r in news.itertuples(index=False)],
    })


# --- research -----------------------------------------------------------------------------------

def export_research(out: Path, c) -> int:
    from quant import quant_models as qm

    exposures = {model: c.exposures(model) for model in qm.MODELS}
    s = c.scores()
    scores = [{"rank": r["rank"], "ticker": t, "composite": r.composite, "value": r.value, "quality": r.quality,
               "momentum": r.momentum, "ep": r.earnings_yield, "fcfp": r.fcf_yield, "bm": r.book_to_market,
               "roe": r.roe, "de": r.leverage, "m121": r.momentum_12_1, "asof": r.fundamentals_as_of}
              for t, r in s.iterrows()]
    try:
        strat = c.strategies().reset_index()
        strategies = [{"strategy": r.strategy, "paper": r.paper, "cagr": r.cagr, "vol": r.vol, "sharpe": r.sharpe,
                       "mdd": r.max_drawdown, "turnover": r.turnover_per_year, "alpha": r.alpha, "alpha_t": r.alpha_t,
                       "mom_beta": r.mom_beta} for r in strat.itertuples(index=False)]
    except Exception:
        log.exception("strategy backtests failed")
        strategies = []
    return write(out / "research.json", {"exposures": exposures, "scores": scores, "strategies": strategies,
                                         "note": qm.SURVIVORSHIP_NOTE})


# --- quantum simulations ------------------------------------------------------------------------------

QUANTUM_TIMEOUT = 300  # seconds; the simulations take about 2.5 minutes on the PC that publishes


def export_quantum(out: Path, keep: Path | None = None, timeout: int = QUANTUM_TIMEOUT, run: bool = True) -> int:
    """Run the nightly quantum simulations (quant.web.quantum) in a subprocess with a timeout, then
    publish the last good result. The module replaces `keep` only when every job succeeds, so after a
    failure or a timeout the site shows the previous night's numbers (with their date); with no file
    at all, the Quantum page says the results aren't published yet. run=False just republishes."""
    from quant.config import get_settings

    keep = keep or get_settings().data_dir / "quantum.json"
    try:
        if run:
            done = subprocess.run([sys.executable, "-m", "quant.web.quantum", "--out", str(keep)], cwd=ROOT,
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if done.returncode:
                log.error("quantum simulations failed (exit %s); keeping the previous results\n%s",
                          done.returncode, done.stderr[-3000:])
    except subprocess.TimeoutExpired:
        log.error("quantum simulations timed out after %ss; keeping the previous results", timeout)
    except Exception:
        log.exception("quantum simulations could not start; keeping the previous results")
    if not keep.exists():
        return 0
    shutil.copyfile(keep, out / "quantum.json")
    return keep.stat().st_size


# --- orchestration ----------------------------------------------------------------------------------

def build(site_dir: Path | None = None, quantum: bool = True) -> dict:
    """Copy the site code from docs/ and write fresh data next to it. Returns sizes and timings.
    quantum=False skips the simulations and republishes the last results."""
    logging.getLogger("streamlit").setLevel(logging.ERROR)
    from dashboard import common as c
    from quant.config import get_settings

    site_dir = site_dir or get_settings().data_dir / "site"
    site_dir.mkdir(parents=True, exist_ok=True)
    for item in site_dir.iterdir():  # keep the publish repo (.git), replace everything else
        if item.name != ".git":
            shutil.rmtree(item) if item.is_dir() else item.unlink()
    shutil.copytree(SITE_SRC, site_dir, dirs_exist_ok=True)
    out = site_dir / "data"
    stats, started = {}, time.perf_counter()
    for name, fn in (("global", lambda: export_global(out)), ("factors", lambda: export_factors(out)),
                     ("deep", lambda: export_deep(out, c)),
                     ("market", lambda: export_market(out, c)), ("research", lambda: export_research(out, c)),
                     ("quantum", lambda: export_quantum(out, run=quantum))):
        t0 = time.perf_counter()
        stats[name] = fn()
        log.info("site %s exported in %.0fs", name, time.perf_counter() - t0)
    ctx = c.context()
    f_start, f_end = c.factor_dates()
    news = c.headlines()
    write(out / "meta.json", {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prices_as_of": f"{ctx.sessions[-1]:%Y-%m-%d}", "factors_as_of": f_end,
        "latest_headline_et": f"{news.published_et.max():%Y-%m-%d %H:%M}" if len(news) else None,
        "deep": stats["deep"]["tickers"], "buckets": BUCKETS,
    })
    stats["seconds"] = round(time.perf_counter() - started)
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export the dashboard data as a static website.")
    parser.add_argument("--out", type=Path, help="site directory (default: data/site)")
    parser.add_argument("--no-quantum", action="store_true", help="skip the quantum simulations; republish the last results")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "streamlit"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    stats = build(args.out, quantum=not args.no_quantum)
    print(json.dumps({k: v for k, v in stats.items() if k != "deep"} | {"deep_bytes": stats["deep"]["deep"]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
