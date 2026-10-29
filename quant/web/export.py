"""Export everything the dashboard shows as static JSON for the GitHub Pages site.

    python -m quant.web.export            # build the site in data/site (code from docs/ + data)
    python -m quant.web.publish           # export, then push data/site to the gh-pages branch

The data comes from the same functions the Streamlit pages call (dashboard/common.py),
so the website and the local dashboard show the same numbers. No price history and no analyst
ratings are published: Yahoo's terms allow personal use only, so the site publishes calculated
numbers (scores, percentiles, returns, volatility, betas), and each page loads price history in the
visitor's browser instead (docs/assets/live.js, dailyHistory). Files written to data/site/data/:

  meta.json       freshness dates and counts
  global.json     the screener (every stock, ETF and coin, columnar), without the two heavy columns
  global-extra.json  those columns, the 6-month sparkline and the signal's reason, loaded after the
                  table first draws (they were over half of the compressed screener)
  indices.json    the market-regime benchmark indices with returns and trend
  symbols.json    [symbol, name, class, market] for search and autocomplete
  sym/<xx>.json   per symbol: its screener row (with sparkline and reason), fundamentals and risk
                  statistics, in 256 buckets keyed by FNV-1a(symbol), so a ticker's page or the
                  watchlist loads a few small files instead of the whole screener
  factors.json    daily Fama-French factors (FF3, momentum, FF5) for in-browser regressions
  market.json     regime and its stance history, FRED tiles, the 3-month T-bill rate,
                  watchlist movers, news
  deep/<T>.json   per deep-tier ticker: latest indicator readings, news markers, unusual
                  moves, headlines, SEC financials, rolling factor betas
  research.json   factor exposures (FF3, Carhart, FF5), composite scores, strategy backtests
  quantum.json    the nightly quantum simulations (quant/web/quantum.py, run in a subprocess with
                  a timeout): the last good result, kept when a run fails
  track.json      the signal track record: forward returns of the append-only signal log (quant/web/track.py),
                  with track/signals_<date>.csv for the latest days
  briefs.json     the rule-based daily brief, the latest 30 (quant/web/brief.py)
  changelog.json  feat: and fix: commits from the git history, methodology changes marked (quant/web/changelog.py)
  status.json     per source: last successful run, data date, rows, missing tickers, stale series,
                  outliers and the quality checks (quant/web/status.py, quant/web/quality.py)

Every step is fail-soft: a step that raises is logged, recorded in status.json and turns the sources it
publishes red, and the other steps still run, so a missing input shows as a red status on the site
rather than a half-written page.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web")

ROOT = Path(__file__).resolve().parents[2]
SITE_SRC = ROOT / "docs"
BUCKETS = 256
FACTOR_YEARS = 5
INDEX_NAMES = {"^GSPC": "S&P 500", "^GSPTSE": "S&P/TSX Composite", "^STOXX": "STOXX Europe 600",
               "^N225": "Nikkei 225", "^KS11": "KOSPI", "^HSI": "Hang Seng", "^TWII": "TAIEX",
               "^NSEI": "Nifty 50", "^AXJO": "S&P/ASX 200", "^VIX": "CBOE Volatility Index"}
# Per-symbol fundamentals for the research view: short key -> scores column.
INFO_FIELDS = {
    "ex": "exchange", "reg": "region", "ind": "industry", "cat": "category", "fpe": "forward_pe",
    "tpe": "trailing_pe", "pecy": "pe_current_year", "pb": "price_to_book", "eve": "ev_to_ebitda",
    "dy": "dividend_yield", "roe": "return_on_equity", "pm": "profit_margin", "gm": "gross_margin",
    "om": "operating_margin", "de": "debt_to_equity",
    "rg": "revenue_growth", "eg": "earnings_growth", "beta": "beta", "er": "expense_ratio",
    "aum": "fund_assets_usd", "w52": "fifty_two_week_change",
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

# The screener's columns; EXTRA_COLS go to global-extra.json instead, in the same row order.
EXTRA_COLS = ("why", "sp")
SCREENER_COLS = [
    "s", "n", "a", "m", "sec", "sig", "sc", "t", "mo", "v", "q", "r", "an", "co", "r1d", "r1w", "r1m", "r3m", "ytd",
    "m121", "fpe", "tpe", "pb", "dy", "roe", "cap", "u", "z", "px", "cur", "rsi", "d200", "also", "why", "sp", "dq",
]


# The scorer's reasons quote the analyst consensus ("analysts Strong Buy (1.4)"). Analyst ratings are
# licensed data, so the site's copy names the calculated Analysts percentile instead.
ANALYST_REASON = re.compile(r"analysts [A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)* \(\d+(?:\.\d+)?\)")


# The scoring module's reason heads are trading words; the site shows neutral ones (the signal codes are unchanged).
NEUTRAL_HEADS = (("Buy candidate:", "Positive signal:"), ("Hold / watch:", "Neutral signal:"), ("Avoid:", "Negative signal:"),
                 (" New buys paused:", " Positive labels paused:"))


def public_reason(text, analysts) -> str | None:
    if not isinstance(text, str):
        return None
    for old, new in NEUTRAL_HEADS:
        text = text.replace(old, new)
    if pd.notna(analysts):
        return ANALYST_REASON.sub(f"analysts {analysts:.0f}/100", text)
    return re.sub(r"\s*;\s*([;.])", r"\1", ANALYST_REASON.sub("", text)).replace(": ;", ":").strip(" ;")


def _spark(points) -> list[int] | None:
    if not isinstance(points, (list, np.ndarray)) or len(points) < 2:
        return None
    v = np.asarray(points, dtype=float)
    v = v[np.isfinite(v)]
    if len(v) < 2:
        return None
    lo, hi = v.min(), v.max()
    return [50] * len(v) if hi == lo else [int(round(99 * (x - lo) / (hi - lo))) for x in v]


def export_global(out: Path, flags: dict[str, list[str]] | None = None) -> dict:
    """flags: {symbol: [quality flag codes]} from quant.web.quality, published as "dq" so the site
    marks every number that comes from a series that failed a check."""
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
            public_reason(r.rationale, r.analysts), _spark(r.sparkline), ",".join((flags or {}).get(r.symbol, [])) or None,
        ])
    keep = [i for i, c in enumerate(SCREENER_COLS) if c not in EXTRA_COLS]
    head = {"scored_at": pd.Timestamp(scores.scored_at.max()).isoformat(), "regimes": regimes.to_dict("records"),
            "counts": {k: int((scores.asset_class == v).sum()) for k, v in (("s", "stock"), ("e", "etf"), ("c", "crypto"))}}
    size = write(out / "global.json", {**head, "cols": [SCREENER_COLS[i] for i in keep], "rows": [[r[i] for i in keep] for r in rows]})
    size += write(out / "global-extra.json", {"s": [r[0] for r in rows],
                                             **{c: [r[SCREENER_COLS.index(c)] for r in rows] for c in EXTRA_COLS}})

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

    # Per-symbol fundamentals and statistics (no prices), bucketed so a page loads ~1/256 of them.
    info = scores.drop_duplicates("symbol").set_index("symbol")
    fetched = fundamentals_dates()
    buckets: dict[str, dict] = {}
    row_of = {r[0]: dict(zip(SCREENER_COLS, r)) for r in rows}
    row_of.update({i["s"]: i for i in indices if i["s"] not in row_of})
    for sym in list(scores.symbol) + [i["s"] for i in indices]:
        entry: dict = {"r": row_of[sym]} if sym in row_of else {}
        if sym in info.index:
            row = info.loc[sym]
            fields = {k: clean(row[col]) for k, col in INFO_FIELDS.items() if col in row.index}
            entry["i"] = {k: v for k, v in fields.items() if v is not None}
            if sym in fetched:
                entry["i"]["fa"] = fetched[sym]  # the date Yahoo's fundamentals for it were read
        if (flags or {}).get(sym):
            entry.setdefault("i", {})["dq"] = ",".join(flags[sym])
        if entry:
            buckets.setdefault(bucket(sym), {})[sym] = entry
    for old in ("px", "sym"):
        shutil.rmtree(out / old, ignore_errors=True)
    sym_size = sum(write(out / "sym" / f"{b}.json", content) for b, content in buckets.items())
    return {"global": size, "sym": sym_size, "symbols": len(rows), "indices": len(indices), "head": head}


def fundamentals_dates() -> dict[str, str]:
    """{symbol: YYYY-MM-DD} of each symbol's last successful Yahoo fundamentals read (empty on failure)."""
    try:
        from sqlalchemy import select

        from quant.db import init_db, session_scope
        from quant.universe.models import InstrumentFundamentals as F

        with session_scope(init_db()) as s:
            rows = s.execute(select(F.symbol, F.fetched_at).where(F.error.is_(None))).all()
        return {sym: f"{pd.Timestamp(ts):%Y-%m-%d}" for sym, ts in rows if ts is not None}
    except Exception:
        log.exception("fundamentals dates unavailable")
        return {}


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

    # Risk-free rate (3-month T-bill yield): the latest value for option pricing, and four years of
    # daily history for the Compare page's Sharpe and Sortino ratios.
    bill = macro["DGS3MO"].dropna() if "DGS3MO" in macro else pd.Series(dtype=float)
    recent = bill.loc[bill.index[-1] - pd.DateOffset(years=4):] if len(bill) else bill
    rf = None if bill.empty else {"id": "DGS3MO", "label": c.macro_label("DGS3MO"), "value": bill.iloc[-1],
                                  "date": f"{bill.index[-1]:%Y-%m-%d}",
                                  "history": {"d": dates(recent.index), "v": series(recent.to_numpy(), 4)}}

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


# --- signal track record ------------------------------------------------------------------------------

TRACK_DAYS_PUBLISHED = 20  # the latest days' logged signals offered as CSV downloads


def export_track(out: Path, data_dir: Path, append: bool = True) -> dict:
    """Append tonight's signals to the append-only log (quant.web.track), then publish the forward
    performance (track.json) and the latest days' logged signals as CSV, without prices."""
    from quant.universe import prices
    from quant.universe.scoring import BENCHMARKS, load_scores
    from quant.web import track

    scores, close = load_scores(), prices.load("close")
    if close.empty:
        raise FileNotFoundError(2, "No such file", "data/universe/close.parquet")
    as_of = f"{close.index.max():%Y-%m-%d}"
    tonight = {"logged": False, "date": as_of, "reason": "logging was turned off for this run"}
    if append:
        if scores.empty:
            tonight["reason"] = "no scores to log"
        elif pd.Timestamp(scores.scored_at.max()).date() < close.index.max().date():
            tonight["reason"] = "the scores are older than the latest prices, so tonight's signals weren't logged"
        else:
            tonight = track.append(data_dir, scores, as_of)
    doc = track.summarize(data_dir, close, BENCHMARKS)
    doc["tonight"] = tonight
    folder = out / "track"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    published = []
    for day in doc["days"][-TRACK_DAYS_PUBLISHED:]:
        f = track.log_dir(data_dir) / f"signals_{day['date']}.parquet"
        if f.exists():  # the log keeps the close for the maths; the published copy leaves Yahoo's prices out
            pd.read_parquet(f).drop(columns=["close"], errors="ignore").to_csv(folder / f"signals_{day['date']}.csv", index=False)
            published.append(day["date"])
    doc["published_days"] = published
    return {"track": write(out / "track.json", doc), "days": doc["days_logged"], "tonight": tonight, "doc": doc}


# --- daily brief ----------------------------------------------------------------------------------------

def export_brief(out: Path, data_dir: Path, c) -> dict:
    """Tonight's rule-based brief (quant.web.brief), archived, and the latest 30 as briefs.json."""
    from quant.universe import prices
    from quant.universe.scoring import load_scores
    from quant.web import brief

    scores, close = load_scores(), prices.load("close")
    if scores.empty or close.empty:
        raise FileNotFoundError(2, "No such file", "data/universe/scores.parquet or close.parquet")
    tonight = brief.build(scores, close, c.macro_frame(), f"{close.index.max():%Y-%m-%d}")
    briefs = brief.archive(data_dir, tonight)
    return {"briefs": write(out / "briefs.json", {"latest": briefs[0]["date"], "briefs": briefs}), "items": len(tonight["items"]),
            "skipped": tonight["skipped"]}


# --- orchestration ----------------------------------------------------------------------------------

SITE_URL = "https://chanwoo777.github.io/quant-platform/"
# Static entry pages for search engines, which don't index #/hash routes: /global/, /markets/, ... are copies
# of index.html with their own title, description and canonical URL, and the app reads the route from the
# path. The same titles are in docs/assets/app.js (ROUTE_META), set when the visitor moves between pages.
SEO_PAGES = {
    "start": ("Start here", "Three one-click examples: compare big-tech peers, measure a basket's risk, and price an option classically and on a quantum simulator."),
    "global": ("Global stock screener", "Screen about 11,000 stocks, ETFs and coins in 21 markets by trend, momentum, value, quality and risk, with tonight's daily brief."),
    "markets": ("Market overview", "The market regime, risk score and stance, the S&P 500 shaded by regime, FRED economic indicators and breaking news."),
    "compare": ("Compare", "Two to five tickers side by side: returns, risk, Sharpe and Sortino, factor exposures, margins and correlation."),
    "quantum": ("Quantum computing for investors", "How quantum algorithms work, from zero, and what they could do for option pricing, risk and portfolios, next to the classical methods."),
    "live": ("Live chart", "A TradingView-style live chart for stocks, ETFs, indices and coins, with indicators, drawing tools and price alerts."),
    "methodology": ("Methodology", "How every score, signal and metric on the site is calculated, with the formula, the inputs, the limits and the code."),
    "status": ("Data status", "What the nightly job loaded, from where, how fresh it is, and what its data-quality checks found."),
    "track-record": ("Signal track record", "How the positive / neutral / negative signal labels did over the next 5, 20 and 60 trading days, from an append-only log."),
    "changelog": ("Changelog", "Every feature and fix, from the repository's commit messages, with methodology changes highlighted."),
}


def write_route_pages(site_dir: Path, today: str | None = None) -> list[str]:
    """The static entry pages, sitemap.xml and robots.txt. Returns the URLs in the sitemap."""
    import html as htmlmod

    today = today or dt.date.today().isoformat()
    index = (site_dir / "index.html").read_text(encoding="utf-8")
    urls = [SITE_URL]
    for route, (title, desc) in SEO_PAGES.items():
        url = f"{SITE_URL}{route}/"
        t, d = htmlmod.escape(f"{title} · Free Quant Platform", quote=True), htmlmod.escape(desc, quote=True)
        page = index.replace("<head>", '<head>\n<base href="../">', 1)
        page = re.sub(r"<title>.*?</title>", f"<title>{t}</title>", page, count=1)
        page = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{d}">', page, count=1)
        page = re.sub(r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{t}">', page, count=1)
        page = re.sub(r'<meta property="og:description" content="[^"]*">', f'<meta property="og:description" content="{d}">', page, count=1)
        page = re.sub(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{url}">', page, count=1)
        page = re.sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{url}">', page, count=1)
        (site_dir / route).mkdir(exist_ok=True)
        (site_dir / route / "index.html").write_text(page, encoding="utf-8")
        urls.append(url)
    urls += [f"{SITE_URL}about.html", f"{SITE_URL}privacy.html"]
    (site_dir / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                          + "".join(f"  <url><loc>{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls)
                                          + "</urlset>\n", encoding="utf-8")
    # Crawlers read robots.txt only at the domain's root (chanwoo777.github.io), so this one is informational;
    # submit sitemap.xml in Google Search Console instead.
    (site_dir / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}sitemap.xml\n", encoding="utf-8")
    return urls


def stamp_assets(site_dir: Path, version: str | None = None) -> str:
    """Cache-bust the site's own scripts and styles: every assets/*.js and *.css reference in the pages gets
    ?v=<export time>, and index.html carries the version so code loaded later (route scripts) uses it too.
    Data files are versioned in the browser by meta.json's generated_at (docs/assets/app.js, load)."""
    version = version or dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M")
    for page in site_dir.glob("*.html"):
        text = page.read_text(encoding="utf-8")
        text = re.sub(r'(["\'])(assets/[\w.\-]+\.(?:js|css))\1', lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(1)}", text)
        if page.name == "index.html":
            text = text.replace("<head>", f'<head>\n<meta name="asset-version" content="{version}">', 1)
        page.write_text(text, encoding="utf-8")
    return version


def build(site_dir: Path | None = None, quantum: bool = True, track_log: bool = True) -> dict:
    """Copy the site code from docs/ and write fresh data next to it. Returns sizes and timings.
    quantum=False skips the simulations and republishes the last results; track_log=False publishes the
    track record without appending tonight's signals. Every step is fail-soft (see the module docstring)."""
    logging.getLogger("streamlit").setLevel(logging.ERROR)
    from dashboard import common as c
    from quant.config import get_settings
    from quant.web import changelog, status

    data_dir = get_settings().data_dir
    site_dir = site_dir or data_dir / "site"
    site_dir.mkdir(parents=True, exist_ok=True)
    for item in site_dir.iterdir():  # keep the publish repo (.git), replace everything else
        if item.name != ".git":
            shutil.rmtree(item) if item.is_dir() else item.unlink()
    shutil.copytree(SITE_SRC, site_dir, dirs_exist_ok=True)
    stamp_assets(site_dir)
    write_route_pages(site_dir)
    out = site_dir / "data"
    out.mkdir(parents=True, exist_ok=True)
    stats, steps, started = {}, {}, time.perf_counter()

    def step(name, fn):
        t0 = time.perf_counter()
        try:
            stats[name] = fn()
            steps[name] = {"ok": True, "seconds": round(time.perf_counter() - t0, 1)}
            log.info("site %s exported in %.0fs", name, time.perf_counter() - t0)
        except Exception as exc:
            log.exception("site %s export failed", name)
            stats[name] = None
            steps[name] = {"ok": False, "seconds": round(time.perf_counter() - t0, 1), "error": f"{type(exc).__name__}: {exc}"}
        return stats[name]

    ctx = step("context", c.context)
    deep_tickers = list(ctx.universe.tickers) if ctx is not None else []
    checks = step("checks", lambda: status.collect(data_dir, deep_tickers))
    step("global", lambda: export_global(out, checks.flags if checks is not None else {}))
    step("factors", lambda: export_factors(out))
    step("deep", lambda: export_deep(out, c))
    step("market", lambda: export_market(out, c))
    step("research", lambda: export_research(out, c))
    step("quantum", lambda: export_quantum(out, run=quantum))
    track_stats = step("track", lambda: export_track(out, data_dir, append=track_log))
    step("brief", lambda: export_brief(out, data_dir, c))
    step("changelog", lambda: write(out / "changelog.json", changelog.build(ROOT, data_dir / "changelog.json")))

    def meta():
        f_start, f_end = c.factor_dates()
        news = c.headlines()
        deep = (stats.get("deep") or {}).get("tickers") or [{"ticker": t, "name": t} for t in deep_tickers]
        return write(out / "meta.json", {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "prices_as_of": f"{ctx.sessions[-1]:%Y-%m-%d}" if ctx is not None else None, "factors_as_of": f_end,
            "latest_headline_et": f"{news.published_et.max():%Y-%m-%d %H:%M}" if len(news) else None,
            "deep": deep, "buckets": BUCKETS,
            # The top of the Global page (regimes, counts, scoring time) draws from this small file first.
            "global": (stats.get("global") or {}).get("head"),
        })
    step("meta", meta)

    if checks is None:  # the source checks themselves failed: publish a status that says so
        checks = status.Builder()
        reason = steps["checks"].get("error") or steps["context"].get("error") or "the source checks failed"
        checks.add("checks", "Source checks", "quant.web.status", 1, lambda: {"error": reason})
    doc = (track_stats or {}).pop("doc", None)
    checks.add("track", "Signal track-record log", "This site's nightly signals", 1, lambda: {} if doc is None else {
        "rows": doc["days_logged"], "as_of": doc["last"], "last_success": doc["days"][-1]["logged_at"] if doc["days"] else None,
        "tonight": doc["tonight"], "error": None if doc["verify"]["ok"] else "; ".join(doc["verify"]["problems"]),
        "file": "data/track/ (append-only, one write-once file per day)"}, feeds="track")
    stats["status"] = write(out / "status.json", checks.to_dict(steps))
    stats["failed_steps"] = [k for k, v in steps.items() if not v["ok"]]
    stats["seconds"] = round(time.perf_counter() - started)
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export the dashboard data as a static website.")
    parser.add_argument("--out", type=Path, help="site directory (default: data/site)")
    parser.add_argument("--no-quantum", action="store_true", help="skip the quantum simulations; republish the last results")
    parser.add_argument("--no-track-log", action="store_true", help="publish the track record without appending tonight's signals")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "streamlit"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    stats = build(args.out, quantum=not args.no_quantum, track_log=not args.no_track_log)
    summary = {k: v for k, v in stats.items() if k not in ("deep", "checks", "context")}
    print(json.dumps(summary | {"deep_bytes": (stats.get("deep") or {}).get("deep")}, indent=1, default=str))
    if stats["failed_steps"]:
        log.error("export steps failed: %s (see status.json)", ", ".join(stats["failed_steps"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
