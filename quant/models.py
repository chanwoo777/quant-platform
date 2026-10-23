"""ORM models for the ingestion layer (Phase 1).

Timestamp conventions (all naive datetimes, SQLite has no tz support):
  * daily bars       -> session date at 00:00 (exchange-local calendar date)
  * intraday bars    -> bar *start* time in UTC
  * news published_at-> UTC
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import BigInteger, Date, DateTime, Float, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from quant.db import Base


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


class PriceBar(Base):
    __tablename__ = "price_bars"
    __table_args__ = (
        UniqueConstraint("ticker", "interval", "timestamp", name="uq_price_bar"),
        Index("ix_price_bar_lookup", "ticker", "interval", "timestamp"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str] = mapped_column(String(8))  # "1d", "15m", ...
    timestamp: Mapped[dt.datetime] = mapped_column(DateTime)
    open: Mapped[float | None] = mapped_column(Float)
    high: Mapped[float | None] = mapped_column(Float)
    low: Mapped[float | None] = mapped_column(Float)
    close: Mapped[float | None] = mapped_column(Float)
    adj_close: Mapped[float | None] = mapped_column(Float)
    volume: Mapped[int | None] = mapped_column(BigInteger)


class StockSplit(Base):
    """Split history, used to put SEC share counts on the same basis as split-adjusted prices."""

    __tablename__ = "stock_splits"
    __table_args__ = (UniqueConstraint("ticker", "date", name="uq_stock_split"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(16), index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    ratio: Mapped[float] = mapped_column(Float)  # 10.0 = ten-for-one


class FactorReturn(Base):
    """Daily Fama-French factor returns (decimals, not percent) from Kenneth French's library."""

    __tablename__ = "factor_returns"

    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    mkt_rf: Mapped[float | None] = mapped_column(Float)  # market minus risk-free
    smb: Mapped[float | None] = mapped_column(Float)  # small minus big (size)
    hml: Mapped[float | None] = mapped_column(Float)  # high minus low book-to-market (value)
    rf: Mapped[float | None] = mapped_column(Float)  # 1-month T-bill, daily
    mom: Mapped[float | None] = mapped_column(Float)  # winners minus losers (Carhart momentum)


class MacroSeries(Base):
    __tablename__ = "macro_series"

    series_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(32))
    last_updated: Mapped[dt.datetime | None] = mapped_column(DateTime)


class MacroObservation(Base):
    __tablename__ = "macro_observations"
    __table_args__ = (UniqueConstraint("series_id", "date", name="uq_macro_obs"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    series_id: Mapped[str] = mapped_column(String(32), index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    value: Mapped[float] = mapped_column(Float)


class Company(Base):
    __tablename__ = "companies"

    ticker: Mapped[str] = mapped_column(String(16), primary_key=True)
    cik: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str | None] = mapped_column(String(256))
    sic: Mapped[str | None] = mapped_column(String(8))
    sic_description: Mapped[str | None] = mapped_column(String(256))
    exchange: Mapped[str | None] = mapped_column(String(32))
    fiscal_year_end: Mapped[str | None] = mapped_column(String(4))  # MMDD


class Fundamental(Base):
    """Core metrics extracted from one 10-K or 10-Q filing (XBRL)."""

    __tablename__ = "fundamentals"
    __table_args__ = (
        UniqueConstraint("accession_number", name="uq_fundamental_accn"),
        Index("ix_fundamental_ticker_period", "ticker", "report_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(16))
    cik: Mapped[int] = mapped_column(Integer)
    form: Mapped[str] = mapped_column(String(8))  # "10-K" | "10-Q"
    accession_number: Mapped[str] = mapped_column(String(32))
    filing_date: Mapped[dt.date] = mapped_column(Date)
    report_date: Mapped[dt.date] = mapped_column(Date)  # fiscal period end
    fiscal_year: Mapped[int | None] = mapped_column(Integer)
    fiscal_period: Mapped[str | None] = mapped_column(String(4))  # FY, Q1, Q2, Q3
    # Length of the income-statement period (≈91 for a quarter, ≈365 for a year).
    period_days: Mapped[int | None] = mapped_column(Integer)
    # 10-Q cash-flow statements are year-to-date, so this can exceed period_days.
    cash_flow_period_days: Mapped[int | None] = mapped_column(Integer)

    revenue: Mapped[float | None] = mapped_column(Float)
    net_income: Mapped[float | None] = mapped_column(Float)
    eps_basic: Mapped[float | None] = mapped_column(Float)
    eps_diluted: Mapped[float | None] = mapped_column(Float)
    diluted_shares: Mapped[float | None] = mapped_column(Float)  # weighted average, as reported
    total_assets: Mapped[float | None] = mapped_column(Float)
    total_liabilities: Mapped[float | None] = mapped_column(Float)
    stockholders_equity: Mapped[float | None] = mapped_column(Float)
    total_debt: Mapped[float | None] = mapped_column(Float)
    cash_and_equivalents: Mapped[float | None] = mapped_column(Float)
    operating_cash_flow: Mapped[float | None] = mapped_column(Float)
    capital_expenditure: Mapped[float | None] = mapped_column(Float)
    free_cash_flow: Mapped[float | None] = mapped_column(Float)
    debt_to_equity: Mapped[float | None] = mapped_column(Float)
    net_margin: Mapped[float | None] = mapped_column(Float)

    filing_url: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class NewsArticle(Base):
    __tablename__ = "news_articles"
    __table_args__ = (
        UniqueConstraint("article_key", name="uq_news_article_key"),
        Index("ix_news_ticker_time", "ticker", "published_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # sha1(ticker | normalised title): dedupes the same story across feeds.
    article_key: Mapped[str] = mapped_column(String(40))
    ticker: Mapped[str | None] = mapped_column(String(16))  # None = market-wide
    source: Mapped[str] = mapped_column(String(32))  # feed id, e.g. "google_news"
    publisher: Mapped[str | None] = mapped_column(String(128))
    title: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    published_at: Mapped[dt.datetime] = mapped_column(DateTime)
    fetched_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)

    # NLP sentiment: score = P(positive) - P(negative), in [-1, 1].
    sentiment_label: Mapped[str | None] = mapped_column(String(8))
    sentiment_score: Mapped[float | None] = mapped_column(Float)
    sentiment_confidence: Mapped[float | None] = mapped_column(Float)
    sentiment_model: Mapped[str | None] = mapped_column(String(64))
    # How clearly the headline is about `ticker`, in [0, 1] (see ingestion/relevance.py).
    relevance: Mapped[float | None] = mapped_column(Float)

    # Link to the intraday chart: the first bar that traded after publication,
    # the last price before it, and the return over the reaction window.
    aligned_bar_ts: Mapped[dt.datetime | None] = mapped_column(DateTime)
    price_at_publish: Mapped[float | None] = mapped_column(Float)
    reaction_return: Mapped[float | None] = mapped_column(Float)


class IndexMember(Base):
    """One stint of a stock in an index (point-in-time research universe).

    Member on sessions ``added <= d < removed``; NULL ``added`` = before the change
    log starts, NULL ``removed`` = still a member. Rebuilt from the sources on each
    ingestion run (see ingestion/index_membership.py).
    """

    __tablename__ = "index_members"
    __table_args__ = (Index("ix_index_member", "index_name", "ticker"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    index_name: Mapped[str] = mapped_column(String(16))  # "sp500"
    ticker: Mapped[str] = mapped_column(String(16))  # Yahoo format, current symbol
    name: Mapped[str | None] = mapped_column(String(256))
    added: Mapped[dt.date | None] = mapped_column(Date)
    removed: Mapped[dt.date | None] = mapped_column(Date)


# --- Phase 4: paper-trading ledger -------------------------------------------------

class Portfolio(Base):
    __tablename__ = "portfolios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)  # "paper" (live) or "backtest"
    initial_cash: Mapped[float] = mapped_column(Float)
    cash: Mapped[float] = mapped_column(Float)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    last_run_date: Mapped[dt.date | None] = mapped_column(Date)  # last trading day processed
    params: Mapped[str | None] = mapped_column(Text)  # JSON of the bot parameters in force


class Position(Base):
    """Current holdings, with the stop-loss state that travels with each position."""

    __tablename__ = "positions"
    __table_args__ = (UniqueConstraint("portfolio_id", "ticker", name="uq_position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(Integer, index=True)
    ticker: Mapped[str] = mapped_column(String(16))
    shares: Mapped[float] = mapped_column(Float)
    avg_cost: Mapped[float] = mapped_column(Float)
    entry_date: Mapped[dt.date] = mapped_column(Date)
    entry_price: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float] = mapped_column(Float)
    highest_close: Mapped[float] = mapped_column(Float)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)  # from trims while open
    cost_invested: Mapped[float] = mapped_column(Float, default=0.0)  # all buys over the position's life


class Trade(Base):
    """Immutable log of every simulated fill and why it happened."""

    __tablename__ = "trades"
    __table_args__ = (Index("ix_trade_portfolio_date", "portfolio_id", "trade_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(Integer)
    trade_date: Mapped[dt.date] = mapped_column(Date)  # trading session
    executed_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)  # wall clock of the run
    ticker: Mapped[str] = mapped_column(String(16))
    side: Mapped[str] = mapped_column(String(4))  # BUY | SELL
    shares: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)
    value: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(String(16))  # entry | add | trim | exit | stop
    rationale: Mapped[str] = mapped_column(Text)
    signal: Mapped[str | None] = mapped_column(Text)  # JSON: score, components, details
    realized_pnl: Mapped[float | None] = mapped_column(Float)  # this fill
    position_pnl: Mapped[float | None] = mapped_column(Float)  # whole round trip, on the closing fill
    position_return: Mapped[float | None] = mapped_column(Float)


class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"
    __table_args__ = (UniqueConstraint("portfolio_id", "date", name="uq_snapshot"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    cash: Mapped[float] = mapped_column(Float)
    holdings_value: Mapped[float] = mapped_column(Float)
    equity: Mapped[float] = mapped_column(Float)
    n_positions: Mapped[int] = mapped_column(Integer)
    regime: Mapped[str | None] = mapped_column(String(32))
    stance: Mapped[str | None] = mapped_column(String(16))


class SignalRecord(Base):
    """Every daily signal (BUY / SELL / HOLD) with its components, held or not."""

    __tablename__ = "signals"
    __table_args__ = (UniqueConstraint("portfolio_id", "date", "ticker", name="uq_signal"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    ticker: Mapped[str] = mapped_column(String(16))
    action: Mapped[str] = mapped_column(String(4))
    score: Mapped[float] = mapped_column(Float)
    trend: Mapped[float] = mapped_column(Float)
    fundamentals: Mapped[float] = mapped_column(Float)
    valuation: Mapped[float] = mapped_column(Float)
    sentiment: Mapped[float] = mapped_column(Float)
    rationale: Mapped[str] = mapped_column(Text)
    details: Mapped[str | None] = mapped_column(Text)  # JSON
