"""Rolling per-instrument fundamentals from Yahoo's quote summary (``Ticker.info``).

Bulk screener quotes carry no profitability or balance-sheet data, so these come
one request per instrument. Each run refreshes the ``limit`` stalest names
(never-fetched first), which cycles through the whole universe every few days
without hammering Yahoo. A rate-limit response stops the run early; the next run
picks up where this one left off.
"""

from __future__ import annotations

import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
from sqlalchemy import select

from quant.db import session_scope, upsert
from quant.models import utcnow
from quant.universe.models import Instrument, InstrumentFundamentals

log = logging.getLogger(__name__)

# Yahoo info key -> column. Only currency-free ratios (plus ETF assets, in USD for US funds).
INFO_FIELDS = {
    "industry": "industry", "trailingPE": "trailing_pe", "forwardPE": "forward_pe", "priceToBook": "price_to_book",
    "enterpriseToEbitda": "ev_to_ebitda", "returnOnEquity": "return_on_equity", "profitMargins": "profit_margin",
    "debtToEquity": "debt_to_equity", "revenueGrowth": "revenue_growth", "earningsGrowth": "earnings_growth",
    "beta": "beta", "netExpenseRatio": "expense_ratio", "totalAssets": "fund_assets_usd", "category": "category",
}
TEXT = {"industry", "category"}


def _clean(key: str, value):
    if value is None:
        return None
    if key in TEXT:
        return str(value)[:128]
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def fetch_one(symbol: str) -> dict:
    info = yf.Ticker(symbol).info or {}
    row = {"symbol": symbol, "fetched_at": utcnow(), "error": None}
    for key, col in INFO_FIELDS.items():
        row[col] = _clean(col, info.get(key))
    if row["expense_ratio"] is None and info.get("annualReportExpenseRatio") is not None:
        row["expense_ratio"] = _clean("expense_ratio", info["annualReportExpenseRatio"])
    return row


def stalest(limit: int) -> list[str]:
    with session_scope() as s:
        rows = s.execute(
            select(Instrument.symbol)
            .outerjoin(InstrumentFundamentals, InstrumentFundamentals.symbol == Instrument.symbol)
            .where(Instrument.active.is_(True), Instrument.asset_class.in_(["stock", "etf"]))
            .order_by(InstrumentFundamentals.fetched_at.is_not(None), InstrumentFundamentals.fetched_at,
                      Instrument.market_cap_usd.desc())
            .limit(limit)
        ).all()
    return [r.symbol for r in rows]


def refresh(limit: int = 1500, workers: int = 4) -> str:
    symbols = stalest(limit)
    rows, errors, rate_limited = [], 0, False
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_one, s): s for s in symbols}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                rows.append(fut.result())
            except Exception as exc:
                text = f"{type(exc).__name__}: {exc}"[:250]
                if "rate" in text.lower() or "too many" in text.lower():
                    rate_limited = True
                    for f in futures:
                        f.cancel()
                    break
                errors += 1
                rows.append({"symbol": sym, "fetched_at": utcnow(), "error": text,
                             **{c: None for c in INFO_FIELDS.values()}})
            if len(rows) % 250 == 0:
                log.info("fundamentals %d/%d in %.0fs", len(rows), len(symbols), time.perf_counter() - started)
    with session_scope() as s:
        upsert(s, InstrumentFundamentals, rows, ["symbol"])
    note = " (stopped early: Yahoo rate limit, will resume next run)" if rate_limited else ""
    return f"{len(rows) - errors} fetched, {errors} errors{note}"
