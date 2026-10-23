"""The watchlist: instruments promoted from the broad screener to the deep tier.

Deep tier = the full Phase 1-4 treatment: daily + intraday bars in the database,
headlines with FinBERT sentiment and the relevance filter, explained unusual moves,
SEC fundamentals (US filers) and the Stock Deep Dive page. The paper-trading bot
trades only USD-quoted names (its ledger is in dollars); crypto stays in the broad
tier because its 7-day calendar doesn't fit the bot's trading sessions.
"""

from __future__ import annotations

import pandas as pd
from sqlalchemy import delete, select

from quant.config import get_settings
from quant.db import session_scope, upsert
from quant.models import utcnow
from quant.universe.models import Instrument, WatchlistItem, ensure_tables


def items() -> pd.DataFrame:
    ensure_tables()
    with session_scope() as s:
        rows = s.execute(
            select(WatchlistItem.symbol, WatchlistItem.added_at, WatchlistItem.note, Instrument.name,
                   Instrument.asset_class, Instrument.currency, Instrument.market)
            .outerjoin(Instrument, Instrument.symbol == WatchlistItem.symbol)
            .order_by(WatchlistItem.added_at)
        ).all()
    return pd.DataFrame(rows, columns=["symbol", "added_at", "note", "name", "asset_class", "currency", "market"])


def add(symbols, note: str | None = None) -> int:
    ensure_tables()
    rows = [{"symbol": s, "added_at": utcnow(), "note": note} for s in dict.fromkeys(symbols)]
    with session_scope() as s:
        return upsert(s, WatchlistItem, rows, ["symbol"], update_cols=[])


def remove(symbols) -> None:
    with session_scope() as s:
        s.execute(delete(WatchlistItem).where(WatchlistItem.symbol.in_(list(symbols))))


def _is_crypto(sym: str, asset_class) -> bool:
    return asset_class == "crypto" or (asset_class is None and sym.endswith("-USD"))


def deep_tier_tickers() -> list[str]:
    """Default watchlist + promoted stocks/ETFs (no crypto), order preserved."""
    wl = items()
    promoted = [r.symbol for r in wl.itertuples() if not _is_crypto(r.symbol, r.asset_class)]
    return list(dict.fromkeys(list(get_settings().equities) + promoted))


def bot_tickers() -> list[str]:
    """Deep-tier names the dollar-denominated paper bot can trade (USD quotes only)."""
    wl = items().set_index("symbol")
    out = []
    for t in deep_tier_tickers():
        currency = wl.currency.get(t) if t in wl.index else None
        if currency == "USD" or (currency is None and "." not in t and not t.startswith("^")):
            out.append(t)
    return out
