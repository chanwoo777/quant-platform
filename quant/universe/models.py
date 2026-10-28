"""Tables for the global universe (broad screening tier) and the user's watchlist.

Daily price history for thousands of instruments lives in Parquet files under
data/universe/ (columnar and fast); metadata, slow-moving fundamentals and the
watchlist live here.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from quant.db import Base, get_engine
from quant.models import utcnow


class Instrument(Base):
    """One tradable instrument and its latest bulk quote (Yahoo screener / CoinGecko)."""

    __tablename__ = "universe_instruments"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)  # Yahoo symbol: AAPL, 005930.KS, BTC-USD
    name: Mapped[str | None] = mapped_column(String(256))
    asset_class: Mapped[str] = mapped_column(String(8))  # stock | etf | crypto
    region: Mapped[str] = mapped_column(String(8))  # Yahoo region code (us, kr, jp...) or "crypto"
    market: Mapped[str] = mapped_column(String(16))  # peer bloc: US, Korea, Japan, China/HK, Europe, ...
    exchange: Mapped[str | None] = mapped_column(String(16))
    currency: Mapped[str | None] = mapped_column(String(8))
    sector: Mapped[str | None] = mapped_column(String(64))
    market_cap_usd: Mapped[float | None] = mapped_column(Float)
    price: Mapped[float | None] = mapped_column(Float)  # in `currency`
    change_pct: Mapped[float | None] = mapped_column(Float)  # latest session, percent
    fifty_two_week_change: Mapped[float | None] = mapped_column(Float)  # percent
    dividend_yield: Mapped[float | None] = mapped_column(Float)  # percent
    pe_current_year: Mapped[float | None] = mapped_column(Float)  # price / current-year EPS estimate
    analyst_rating: Mapped[float | None] = mapped_column(Float)  # 1 = strong buy ... 5 = sell
    analyst_label: Mapped[str | None] = mapped_column(String(32))
    coingecko_id: Mapped[str | None] = mapped_column(String(64))
    rank: Mapped[int | None] = mapped_column(Integer)  # crypto market-cap rank
    also_listed: Mapped[str | None] = mapped_column(Text)  # other listings of the same company
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    first_seen: Mapped[dt.date] = mapped_column(Date, default=lambda: utcnow().date())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class InstrumentFundamentals(Base):
    """Per-instrument fundamentals from Yahoo's quote summary, refreshed on a rolling basis.

    Only currency-free ratios are kept, so a US-listed ADR and its home listing
    compare like for like.
    """

    __tablename__ = "universe_fundamentals"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    fetched_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    industry: Mapped[str | None] = mapped_column(String(128))
    trailing_pe: Mapped[float | None] = mapped_column(Float)
    forward_pe: Mapped[float | None] = mapped_column(Float)
    price_to_book: Mapped[float | None] = mapped_column(Float)
    ev_to_ebitda: Mapped[float | None] = mapped_column(Float)
    return_on_equity: Mapped[float | None] = mapped_column(Float)
    profit_margin: Mapped[float | None] = mapped_column(Float)
    gross_margin: Mapped[float | None] = mapped_column(Float)
    operating_margin: Mapped[float | None] = mapped_column(Float)
    debt_to_equity: Mapped[float | None] = mapped_column(Float)  # Yahoo reports percent (150 = 1.5x)
    revenue_growth: Mapped[float | None] = mapped_column(Float)
    earnings_growth: Mapped[float | None] = mapped_column(Float)
    beta: Mapped[float | None] = mapped_column(Float)
    expense_ratio: Mapped[float | None] = mapped_column(Float)  # ETFs
    fund_assets_usd: Mapped[float | None] = mapped_column(Float)  # ETFs
    category: Mapped[str | None] = mapped_column(String(128))  # ETF category
    error: Mapped[str | None] = mapped_column(String(256))


class WatchlistItem(Base):
    """Instruments promoted from the screener to the deep tier (news, SEC, bot)."""

    __tablename__ = "watchlist"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    added_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    note: Mapped[str | None] = mapped_column(Text)


TABLES = [Instrument.__table__, InstrumentFundamentals.__table__, WatchlistItem.__table__]


def ensure_tables(engine=None) -> None:
    """Create the universe tables (independent of the core init_db)."""
    Base.metadata.create_all(engine or get_engine(), tables=TABLES)
