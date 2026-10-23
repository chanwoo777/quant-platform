"""Shared dashboard plumbing: cached data access, palette, and Plotly styling.

Heavy objects (the point-in-time market context) are loaded once per process with
st.cache_resource; derived tables use st.cache_data. "Reload data" in the sidebar
clears both after the pipeline has run.
"""

from __future__ import annotations

import json
from dataclasses import asdict

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from sqlalchemy import select

from quant import analytics as an
from quant import quant_models as qm
from quant import trading_bot as tb
from quant.config import DEFAULT_FRED_SERIES, get_settings
from quant.db import init_db, session_scope
from quant.ingestion.factors import load_factors
from quant.ingestion.macro_data import load_macro
from quant.ingestion.market_data import load_bars
from quant.ingestion.relevance import RELEVANCE_THRESHOLD
from quant.ingestion.sec_edgar import load_fundamentals
from quant.models import (
    Company, NewsArticle, Portfolio, PortfolioSnapshot, Position, SignalRecord, Trade,
)

ET = "America/New_York"
TTL = 15 * 60

# --- palette (validated with the dataviz skill's validator, light and dark) ----------
_LIGHT = {
    "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9", "axis": "#c3c2b7",
    "surface": "#fcfcfb", "up": "#2a78d6", "down": "#e34948", "ma50": "#6250d6", "ma200": "#1baf7a",
    "series": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    "neutral": "#c3c2b7", "mid": "#f0efec",
}
_DARK = {
    "ink": "#f0efec", "ink2": "#c3c2b7", "muted": "#898781", "grid": "#2c2c2a", "axis": "#383835",
    "surface": "#1a1a19", "up": "#3987e5", "down": "#e66767", "ma50": "#9085e9", "ma200": "#199e70",
    "series": ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
    "neutral": "#5d5c57", "mid": "#383835",
}
STATUS = {"good": "#0ca30c", "warning": "#fab219", "serious": "#ec835a", "critical": "#d03b3b"}
STANCE_STATUS = {"Risk-On": "good", "Neutral": "warning", "Risk-Off": "critical"}
STANCE_ICON = {"Risk-On": ":material/check_circle:", "Neutral": ":material/warning:", "Risk-Off": ":material/dangerous:"}
FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'


def palette() -> dict:
    try:
        mode = st.context.theme.type
    except Exception:
        mode = None
    return _DARK if mode == "dark" else _LIGHT


def style(fig: go.Figure, height: int = 420, hovermode: str = "x unified", legend: bool = True) -> go.Figure:
    """Recessive chrome: hairline solid grid, muted axes, system sans, transparent background."""
    c = palette()
    fig.update_layout(
        height=height, margin=dict(l=8, r=48, t=40, b=8), hovermode=hovermode,
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family=FONT, color=c["ink2"], size=12),
        hoverlabel=dict(font=dict(family=FONT)),
        showlegend=legend,
        legend=dict(orientation="h", yanchor="bottom", y=1.01, xanchor="left", x=0, font=dict(color=c["ink2"])),
    )
    fig.update_xaxes(showgrid=False, linecolor=c["axis"], tickfont=dict(color=c["muted"]), zeroline=False,
                     automargin=True, spikedash="solid", spikethickness=1, spikecolor=c["muted"])
    fig.update_yaxes(gridcolor=c["grid"], gridwidth=1, linecolor=c["axis"], tickfont=dict(color=c["muted"]),
                     zeroline=False, automargin=True)
    return fig


def show(fig: go.Figure, key: str | None = None) -> None:
    st.plotly_chart(fig, width="stretch", theme=None, key=key, config={"displaylogo": False})


# --- formatting ----------------------------------------------------------------------

def pct(x, digits: int = 1, sign: bool = True) -> str:
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "–"
    return f"{x:+.{digits}%}" if sign else f"{x:.{digits}%}"


def money(x, digits: int = 0) -> str:
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "–"
    for unit, div in (("T", 1e12), ("B", 1e9), ("M", 1e6)):
        if abs(x) >= div:
            return f"${x / div:,.{max(digits, 1)}f}{unit}"
    return f"${x:,.{digits}f}"


def to_et(ts: pd.Series | pd.DatetimeIndex):
    """Naive UTC -> naive US/Eastern (for display)."""
    idx = pd.DatetimeIndex(ts)
    return idx.tz_localize("UTC").tz_convert(ET).tz_localize(None)


# --- data -------------------------------------------------------------------------------

def tickers() -> list[str]:
    """Deep-tier names: the default watchlist plus stocks/ETFs promoted from Global Overview."""
    from quant.universe.watchlist import deep_tier_tickers

    try:
        return deep_tier_tickers()
    except Exception:  # universe tables not created yet
        return list(get_settings().equities)


# --- global universe (broad tier) ----------------------------------------------------------

@st.cache_data(ttl=TTL, show_spinner="Loading the global universe...")
def universe_scores() -> pd.DataFrame:
    from quant.universe.scoring import load_scores

    return load_scores()


@st.cache_data(ttl=TTL, show_spinner=False)
def universe_regimes() -> pd.DataFrame:
    from quant.universe.scoring import load_regimes

    return load_regimes()


@st.cache_data(ttl=TTL, show_spinner=False)
def universe_close(symbol: str) -> pd.Series:
    from quant.universe.prices import load

    close = load("close")
    return close[symbol].dropna() if symbol in close else pd.Series(dtype=float)


@st.cache_data(ttl=60, show_spinner=False)
def deep_tier_analysed(symbols: tuple[str, ...]) -> set[str]:
    """Which of these symbols the deep-tier pipeline has processed: daily bars and headlines.
    Bars alone aren't enough, since the research universe (S&P 500 members) stores bars and
    SEC data for ~700 tickers without news unless NEWS_UNIVERSE=research."""
    from quant.models import PriceBar

    with session_scope(init_db()) as s:
        bars = s.scalars(select(PriceBar.ticker).where(PriceBar.ticker.in_(list(symbols)),
                                                       PriceBar.interval == "1d").distinct()).all()
        news = s.scalars(select(NewsArticle.ticker).where(NewsArticle.ticker.in_(list(symbols))).distinct()).all()
    return set(bars) & set(news)


def watchlist_items() -> pd.DataFrame:
    from quant.universe.watchlist import items

    return items()


@st.cache_resource(ttl=TTL, show_spinner="Loading prices, filings, factors and news...")
def context() -> tb.MarketContext:
    with session_scope(init_db()) as s:
        return tb.load_context(s, tickers())


@st.cache_data(ttl=TTL, show_spinner=False)
def regime() -> dict:
    return asdict(an.current_regime(context().regime))


@st.cache_data(ttl=TTL, show_spinner=False)
def benchmark_bars(ticker: str = "^GSPC") -> pd.DataFrame:
    with session_scope(init_db()) as s:
        return an.add_indicators(load_bars(s, ticker, "1d"))


@st.cache_data(ttl=TTL, show_spinner=False)
def macro_frame() -> pd.DataFrame:
    with session_scope(init_db()) as s:
        df = load_macro(s)
    df.index = pd.DatetimeIndex(df.index)
    return df


def macro_label(series_id: str) -> str:
    return DEFAULT_FRED_SERIES.get(series_id, (series_id, ""))[0]


@st.cache_data(ttl=TTL, show_spinner=False)
def headlines(limit: int = 300) -> pd.DataFrame:
    """Latest headlines: ticker news that passes the relevance filter, plus market-wide news."""
    with session_scope(init_db()) as s:
        rows = s.execute(
            select(NewsArticle.id, NewsArticle.ticker, NewsArticle.title, NewsArticle.publisher, NewsArticle.url,
                   NewsArticle.published_at, NewsArticle.sentiment_label, NewsArticle.sentiment_score,
                   NewsArticle.relevance, NewsArticle.aligned_bar_ts, NewsArticle.reaction_return)
            .order_by(NewsArticle.published_at.desc()).limit(limit * 3)
        ).all()
    df = pd.DataFrame(rows, columns=["id", "ticker", "title", "publisher", "url", "published_at", "sentiment_label",
                                     "sentiment_score", "relevance", "aligned_bar_ts", "reaction_return"])
    keep = df.ticker.isna() | (df.relevance.fillna(0) >= RELEVANCE_THRESHOLD)
    df = df[keep].head(limit).copy()
    df["published_et"] = to_et(df.published_at)
    return df


@st.cache_data(ttl=TTL, show_spinner="Explaining unusual moves...")
def anomalies(ticker: str, interval: str, days: int) -> list[dict]:
    since = pd.Timestamp.now() - pd.Timedelta(days=days)
    with session_scope(init_db()) as s:
        found = an.explain_anomalies(s, ticker, interval, since=since)
    return [asdict(a) for a in found]


@st.cache_data(ttl=TTL, show_spinner=False)
def intraday_bars(ticker: str) -> pd.DataFrame:
    with session_scope(init_db()) as s:
        return load_bars(s, ticker, get_settings().intraday_interval)


@st.cache_data(ttl=TTL, show_spinner=False)
def company(ticker: str) -> dict:
    with session_scope(init_db()) as s:
        c = s.get(Company, ticker)
        return {} if c is None else {k: getattr(c, k) for k in ("name", "cik", "sic", "sic_description", "exchange")}


@st.cache_data(ttl=TTL, show_spinner=False)
def filings(ticker: str) -> pd.DataFrame:
    with session_scope(init_db()) as s:
        return load_fundamentals(s, ticker)


@st.cache_data(ttl=TTL, show_spinner=False)
def quarterly(ticker: str) -> pd.DataFrame:
    return qm.quarterly_flows(filings(ticker))


@st.cache_data(ttl=TTL, show_spinner="Running factor regressions...")
def exposures(model: str) -> list[dict]:
    return [asdict(e) for e in qm.universe_exposures(context().universe, qm.MODELS[model])]


@st.cache_data(ttl=TTL, show_spinner=False)
def rolling_betas(ticker: str, model: str) -> pd.DataFrame:
    u = context().universe
    return qm.rolling_exposures(u.returns[ticker], u.factors, qm.MODELS[model])


@st.cache_data(ttl=TTL, show_spinner="Scoring the watchlist...")
def scores() -> pd.DataFrame:
    return qm.factor_scores(context().universe)


@st.cache_data(ttl=3 * TTL, show_spinner="Backtesting the academic strategies...")
def strategies() -> pd.DataFrame:
    return qm.run_strategies(context().universe)


@st.cache_data(ttl=TTL, show_spinner=False)
def factor_dates() -> tuple:
    with session_scope(init_db()) as s:
        f = load_factors(s)
    return (f.index.min().date(), f.index.max().date()) if len(f) else (None, None)


@st.cache_data(ttl=60, show_spinner=False)
def portfolio_names() -> list[str]:
    with session_scope(init_db()) as s:
        return list(s.scalars(select(Portfolio.name).order_by(Portfolio.id)))


@st.cache_data(ttl=60, show_spinner=False)
def portfolio(name: str) -> dict | None:
    """Everything the bot page shows, as plain frames."""
    with session_scope(init_db()) as s:
        pf = s.scalar(select(Portfolio).where(Portfolio.name == name))
        if pf is None:
            return None
        info = {k: getattr(pf, k) for k in ("id", "name", "initial_cash", "cash", "created_at", "last_run_date")}
        info["params"] = json.loads(pf.params) if pf.params else {}

        def frame(model, *order):
            rows = s.scalars(select(model).where(model.portfolio_id == pf.id).order_by(*order)).all()
            cols = [c.name for c in model.__table__.columns]
            return pd.DataFrame([{c: getattr(r, c) for c in cols} for r in rows], columns=cols)

        snaps = frame(PortfolioSnapshot, PortfolioSnapshot.date)
        positions = frame(Position, Position.ticker)
        trades = frame(Trade, Trade.trade_date.desc(), Trade.id.desc())
        last_signal_date = s.scalar(select(SignalRecord.date).where(SignalRecord.portfolio_id == pf.id)
                                    .order_by(SignalRecord.date.desc()).limit(1))
        signals = frame(SignalRecord, SignalRecord.score.desc())
        signals = signals[signals.date == last_signal_date] if last_signal_date else signals
        spy = load_bars(s, "SPY", "1d")["adj_close"]
        last_close = {t: float(load_bars(s, t, "1d")["close"].dropna().iloc[-1]) for t in positions.ticker}
    return {"info": info, "snapshots": snaps, "positions": positions, "trades": trades, "signals": signals,
            "spy": spy, "last_close": last_close}


def pick_ticker(container, label: str = "Ticker") -> str:
    """Ticker selector whose choice carries across pages (widget state does not)."""
    options = context().universe.tickers
    current = st.session_state.get("selected_ticker", options[0])
    ticker = container.selectbox(label, options, index=options.index(current) if current in options else 0)
    st.session_state["selected_ticker"] = ticker
    return ticker


def wrap(text: str, width: int = 70) -> str:
    """Line-wrap hover text with <br>."""
    import textwrap

    return "<br>".join(textwrap.wrap(str(text), width))


def sidebar() -> None:
    """Data freshness and a reload button (shown on every page)."""
    ctx = context()
    last_bar = ctx.sessions[-1].date()
    news = headlines()
    f_start, f_end = factor_dates()
    with st.sidebar:
        st.caption("Data as of")
        st.markdown(f"**Prices** {last_bar}  \n**Factors** {f_end}  \n"
                    f"**Latest headline** {news.published_et.max():%Y-%m-%d %H:%M} ET")
        if st.button("Reload data", icon=":material/refresh:", help="Clear caches after the pipeline has run"):
            st.cache_data.clear()
            st.cache_resource.clear()
            st.rerun()
        st.caption("Paper trading and research only. Not investment advice.")
