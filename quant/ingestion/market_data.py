"""Market data from Yahoo Finance via the free ``yfinance`` library.

Daily bars are fetched incrementally (full history on first run, then only the
last few sessions to pick up corrections). Intraday bars are always re-pulled
for the configured window because Yahoo only keeps short intraday history.
Quotes are ~15 minutes delayed, which is fine for daily paper trading.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from quant.db import upsert
from quant.models import PriceBar, StockSplit

log = logging.getLogger(__name__)

BAR_COLUMNS = ["timestamp", "open", "high", "low", "close", "adj_close", "volume"]
INTRADAY_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}
DAILY_REFRESH_OVERLAP = timedelta(days=7)


def normalize_history(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Turn a yfinance history frame into our bar schema.

    Daily+ bars keep the exchange-local session date; intraday bars are
    converted to naive UTC so they line up with news timestamps.
    """
    if df is None or df.empty:
        return pd.DataFrame(columns=BAR_COLUMNS)

    out = pd.DataFrame(
        {
            "open": df["Open"],
            "high": df["High"],
            "low": df["Low"],
            "close": df["Close"],
            "adj_close": df["Adj Close"] if "Adj Close" in df.columns else df["Close"],
            "volume": df["Volume"] if "Volume" in df.columns else 0,
        }
    )
    idx = pd.DatetimeIndex(out.index)
    if interval in INTRADAY_INTERVALS:
        idx = idx.tz_convert("UTC").tz_localize(None) if idx.tz is not None else idx
    else:
        idx = (idx.tz_localize(None) if idx.tz is not None else idx).normalize()
    out.index = idx
    out = out[~out.index.duplicated(keep="last")].dropna(subset=["close"])
    out = out.reset_index(names="timestamp")
    return out[BAR_COLUMNS]


def fetch_history(
    ticker: str,
    interval: str = "1d",
    period: str | None = "10y",
    start: datetime | None = None,
    retries: int = 2,
) -> pd.DataFrame:
    """Download OHLCV bars for one ticker. ``start`` overrides ``period``."""
    kwargs = {"interval": interval, "auto_adjust": False, "actions": False}
    if start is not None:
        kwargs["start"] = start.strftime("%Y-%m-%d")
    else:
        kwargs["period"] = period

    for attempt in range(retries + 1):
        try:
            raw = yf.Ticker(ticker).history(**kwargs)
            return normalize_history(raw, interval)
        except Exception as exc:  # yfinance raises a zoo of exception types
            if attempt == retries:
                raise
            wait = 2 ** (attempt + 1)
            log.warning("yfinance %s %s failed (%s); retrying in %ss", ticker, interval, exc, wait)
            time.sleep(wait)
    return pd.DataFrame(columns=BAR_COLUMNS)


def latest_quotes(tickers: list[str]) -> dict[str, dict]:
    """Near-real-time snapshot (last price, previous close, day change) per ticker."""
    quotes: dict[str, dict] = {}
    for ticker in tickers:
        try:
            info = yf.Ticker(ticker).fast_info
            last, prev = float(info["lastPrice"]), float(info["previousClose"])
            quotes[ticker] = {
                "last_price": last,
                "previous_close": prev,
                "change_pct": (last / prev - 1.0) if prev else None,
            }
        except Exception as exc:
            log.warning("quote for %s unavailable: %s", ticker, exc)
    return quotes


def _bars_to_rows(ticker: str, interval: str, bars: pd.DataFrame) -> list[dict]:
    rows = []
    for rec in bars.itertuples(index=False):
        rows.append(
            {
                "ticker": ticker,
                "interval": interval,
                "timestamp": rec.timestamp.to_pydatetime(),
                "open": float(rec.open),
                "high": float(rec.high),
                "low": float(rec.low),
                "close": float(rec.close),
                "adj_close": float(rec.adj_close),
                "volume": int(rec.volume) if pd.notna(rec.volume) else None,
            }
        )
    return rows


def store_bars(session: Session, ticker: str, interval: str, bars: pd.DataFrame) -> int:
    return upsert(session, PriceBar, _bars_to_rows(ticker, interval, bars), ["ticker", "interval", "timestamp"])


def last_bar_time(session: Session, ticker: str, interval: str) -> datetime | None:
    return session.scalar(
        select(func.max(PriceBar.timestamp)).where(PriceBar.ticker == ticker, PriceBar.interval == interval)
    )


def history_rebased(session: Session, ticker: str, fresh: pd.DataFrame, tolerance: float = 1e-4) -> bool:
    """True when Yahoo has rescaled past prices since we stored them.

    A split rescales every earlier close; a dividend rescales every earlier
    adjusted close. Either way the stored history no longer joins up with new
    bars, so it must be re-downloaded. The latest stored bar is ignored because
    it may have been captured mid-session.
    """
    if fresh.empty:
        return False
    stored = load_bars(session, ticker, "1d", start=fresh["timestamp"].min().to_pydatetime())
    if len(stored) < 2:
        return False
    stored = stored.iloc[:-1]
    new = fresh.set_index("timestamp").reindex(stored.index)
    for col in ("close", "adj_close"):
        ratio = (new[col] / stored[col]).dropna()
        if len(ratio) and ((ratio - 1).abs() > tolerance).any():
            return True
    return False


def update_daily(session: Session, ticker: str, history_period: str = "10y") -> int:
    last = last_bar_time(session, ticker, "1d")
    if last is None:
        bars = fetch_history(ticker, "1d", period=history_period)
    else:
        bars = fetch_history(ticker, "1d", start=last - DAILY_REFRESH_OVERLAP)
        if history_rebased(session, ticker, bars):
            log.info("%s: split/dividend rescaled past prices; re-downloading full history", ticker)
            bars = fetch_history(ticker, "1d", period=history_period)
    return store_bars(session, ticker, "1d", bars)


def daily_from_intraday(session: Session, ticker: str, exchange_tz: str = "America/New_York",
                        last_bar: str = "15:45", now: datetime | None = None) -> int:
    """Store a stand-in daily bar for the latest complete session when Yahoo hasn't posted the official one.

    Yahoo can post a US stock's daily bar hours after the close (on 29 October it appeared between 20:50 and
    21:00 New York, while the index bars were there at 16:30), but its 15-minute bars arrive with the session.
    When the newest 15-minute session is complete (its last bar starts at ``last_bar`` exchange time and that
    bar has ended) and is newer than the newest daily bar, its open, high, low, close and volume become that
    day's daily bar, with adj_close = close. The next run re-fetches the last week of daily bars and the
    official bar overwrites this one (upsert); history_rebased ignores the latest stored bar, so the small
    difference from the closing auction doesn't trigger a re-download. Returns the rows written (0 or 1).
    """
    intraday = load_bars(session, ticker, "15m")
    if intraday.empty:
        return 0
    local = pd.DatetimeIndex(intraday.index).tz_localize("UTC").tz_convert(exchange_tz)
    day = local[-1].normalize()
    today = intraday[local.normalize() == day]
    tlocal = local[local.normalize() == day]
    if tlocal[-1].strftime("%H:%M") != last_bar:
        return 0  # the session isn't finished (or is a half day without the usual last bar)
    now_utc = pd.Timestamp(now) if now is not None else pd.Timestamp.now(tz="UTC")  # a naive `now` is UTC
    now_local = (now_utc.tz_localize("UTC") if now_utc.tzinfo is None else now_utc).tz_convert(exchange_tz)
    if now_local < tlocal[-1] + pd.Timedelta(minutes=15):
        return 0
    last_daily = last_bar_time(session, ticker, "1d")
    session_day = day.tz_localize(None).to_pydatetime()
    if last_daily is not None and last_daily >= session_day:
        return 0
    bar = pd.DataFrame([{
        "timestamp": pd.Timestamp(session_day), "open": float(today["open"].iloc[0]), "high": float(today["high"].max()),
        "low": float(today["low"].min()), "close": float(today["close"].iloc[-1]), "adj_close": float(today["close"].iloc[-1]),
        "volume": float(today["volume"].fillna(0).sum()),
    }])
    log.info("%s: daily bar for %s built from %d 15-minute bars (Yahoo hasn't posted it yet)", ticker, f"{session_day:%Y-%m-%d}", len(today))
    return store_bars(session, ticker, "1d", bar)


def update_intraday(session: Session, ticker: str, interval: str = "15m", period: str = "30d") -> int:
    bars = fetch_history(ticker, interval, period=period)
    return store_bars(session, ticker, interval, bars)


def update_splits(session: Session, ticker: str) -> int:
    """Store the split history (needed to compare SEC share counts with adjusted prices)."""
    if ticker.startswith("^"):
        return 0
    splits = yf.Ticker(ticker).splits
    rows = [
        {"ticker": ticker, "date": pd.Timestamp(ts).date(), "ratio": float(ratio)}
        for ts, ratio in splits.items()
        if ratio and ratio > 0
    ]
    return upsert(session, StockSplit, rows, ["ticker", "date"])


def load_splits(session: Session, ticker: str) -> pd.Series:
    rows = session.execute(
        select(StockSplit.date, StockSplit.ratio).where(StockSplit.ticker == ticker).order_by(StockSplit.date)
    ).all()
    return pd.Series([r.ratio for r in rows], index=pd.DatetimeIndex([r.date for r in rows]), dtype=float)


# --- research universe: many tickers per request --------------------------------

DOWNLOAD_BATCH = 100
DORMANT_AFTER = timedelta(days=14)  # no new bar for this long: delisted, stop asking for it
MISSING_RECHECK_DAYS = 30  # Yahoo has no history for most acquired companies; re-ask monthly


def _split_download(raw: pd.DataFrame | None, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """``yf.download(group_by="ticker")`` frame -> {ticker: its OHLCV + actions columns}."""
    if raw is None or raw.empty:
        return {}
    if not isinstance(raw.columns, pd.MultiIndex):
        return {tickers[0]: raw.dropna(how="all")} if len(tickers) == 1 else {}
    present = set(raw.columns.get_level_values(0))
    out = {}
    for t in tickers:
        if t in present:
            sub = raw[t].dropna(how="all")
            if not sub.empty and sub["Close"].notna().any():
                out[t] = sub
    return out


def download_daily(tickers: list[str], period: str | None = "10y", start: datetime | None = None,
                   retries: int = 2) -> dict[str, pd.DataFrame]:
    """Daily bars and split events for many tickers in one yfinance request.
    Tickers Yahoo has no data for (most acquired companies) are simply absent."""
    kwargs = {"interval": "1d", "auto_adjust": False, "actions": True, "group_by": "ticker",
              "threads": True, "progress": False}
    if start is not None:
        kwargs["start"] = start.strftime("%Y-%m-%d")
    else:
        kwargs["period"] = period
    for attempt in range(retries + 1):
        try:
            return _split_download(yf.download(list(tickers), **kwargs), list(tickers))
        except Exception as exc:
            if attempt == retries:
                raise
            wait = 2 ** (attempt + 1)
            log.warning("yfinance batch of %d failed (%s); retrying in %ss", len(tickers), exc, wait)
            time.sleep(wait)
    return {}


def _store_download(session: Session, frames: dict[str, pd.DataFrame]) -> int:
    rows = 0
    for ticker, frame in frames.items():
        rows += store_bars(session, ticker, "1d", normalize_history(frame, "1d"))
        if "Stock Splits" in frame:
            splits = frame["Stock Splits"].dropna()
            upsert(session, StockSplit, [
                {"ticker": ticker, "date": pd.Timestamp(ts).date(), "ratio": float(r)} for ts, r in splits.items() if r > 0
            ], ["ticker", "date"])
    return rows


@dataclass
class BatchResult:
    rows: int = 0
    no_data: list[str] = field(default_factory=list)  # Yahoo has no history (usually acquired / delisted)
    dormant: int = 0  # stored history that stopped updating (delisted since)
    errors: list[str] = field(default_factory=list)


def update_daily_batch(engine, tickers: list[str], history_period: str = "10y", cache_dir: Path | None = None,
                       batch_size: int = DOWNLOAD_BATCH) -> BatchResult:
    """Daily bars for a large universe, ``batch_size`` tickers per Yahoo request.

    New tickers get the full history; stored ones only the last few sessions (and a
    full re-download when a split or dividend rescaled their past prices). Intraday
    bars are not fetched: the research universe only needs daily data. Tickers
    without Yahoo data are remembered in ``cache_dir`` and re-tried monthly.
    """
    from quant.db import session_scope

    result = BatchResult()
    missing_file = cache_dir / "yahoo_no_data.json" if cache_dir else None
    known_missing = json.loads(missing_file.read_text()) if missing_file and missing_file.exists() else {}
    recheck = (datetime.now() - timedelta(days=MISSING_RECHECK_DAYS)).date().isoformat()

    with session_scope(engine) as session:
        last = dict(session.execute(
            select(PriceBar.ticker, func.max(PriceBar.timestamp))
            .where(PriceBar.interval == "1d", PriceBar.ticker.in_(tickers)).group_by(PriceBar.ticker)
        ).all())
    newest = max(last.values(), default=None)
    fresh = [t for t in tickers if t not in last and known_missing.get(t, "") < recheck]
    active = [t for t in tickers if t in last and newest - last[t] <= DORMANT_AFTER]
    result.dormant = sum(1 for t in tickers if t in last) - len(active)
    result.no_data = [t for t in tickers if t not in last and t not in fresh]

    def run(chunk: list[str], **kwargs) -> None:
        try:
            frames = download_daily(chunk, **kwargs)
            if kwargs.get("start") is not None:
                with session_scope(engine) as session:
                    rebased = [t for t, f in frames.items()
                               if history_rebased(session, t, normalize_history(f, "1d"))]
                if rebased:
                    log.info("%d tickers rescaled past prices (split/dividend); re-downloading: %s",
                             len(rebased), ", ".join(rebased))
                    frames.update(download_daily(rebased, period=history_period))
            with session_scope(engine) as session:
                result.rows += _store_download(session, frames)
            for t in chunk:
                if t not in frames and kwargs.get("start") is None:
                    result.no_data.append(t)
                    known_missing[t] = datetime.now().date().isoformat()
                elif t in frames:
                    known_missing.pop(t, None)
            log.info("prices (batch): %d/%d tickers with data", len(frames), len(chunk))
        except Exception as exc:
            result.errors.append(f"batch {chunk[0]}..{chunk[-1]}: {type(exc).__name__}: {exc}")
            log.error("batch %s..%s failed: %s", chunk[0], chunk[-1], exc)

    for i in range(0, len(fresh), batch_size):
        run(fresh[i:i + batch_size], period=history_period)
    for i in range(0, len(active), batch_size):
        chunk = active[i:i + batch_size]
        run(chunk, start=min(last[t] for t in chunk) - DAILY_REFRESH_OVERLAP)
    if missing_file:
        missing_file.write_text(json.dumps(known_missing, indent=0, sort_keys=True))
    return result


def load_daily_bars(session: Session, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """Daily bars of many tickers in one query: {ticker: frame as ``load_bars`` returns it}."""
    stmt = (select(PriceBar.ticker, *(getattr(PriceBar, c) for c in BAR_COLUMNS))
            .where(PriceBar.interval == "1d", PriceBar.ticker.in_(list(tickers)))
            .order_by(PriceBar.ticker, PriceBar.timestamp))
    df = pd.DataFrame(session.execute(stmt).all(), columns=["ticker", *BAR_COLUMNS])
    return {t: g.drop(columns="ticker").set_index("timestamp") for t, g in df.groupby("ticker", sort=False)}


def load_bars(
    session: Session, ticker: str, interval: str = "1d", start: datetime | None = None
) -> pd.DataFrame:
    """Read stored bars back as a DataFrame indexed by timestamp."""
    stmt = select(PriceBar).where(PriceBar.ticker == ticker, PriceBar.interval == interval)
    if start is not None:
        stmt = stmt.where(PriceBar.timestamp >= start)
    stmt = stmt.order_by(PriceBar.timestamp)
    records = [
        {col: getattr(bar, col) for col in BAR_COLUMNS} for bar in session.scalars(stmt)
    ]
    if not records:
        return pd.DataFrame(columns=BAR_COLUMNS).set_index("timestamp")
    return pd.DataFrame.from_records(records).set_index("timestamp")
