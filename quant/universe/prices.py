"""Daily price store for the broad universe: wide Parquet tables (dates x symbols).

Columnar storage keeps ~15k symbols x 2 years (close, volume) small and lets the
scoring step compute every indicator for every symbol in one vectorised pass.
Prices are split- and dividend-adjusted (auto_adjust), which is what returns,
momentum and moving averages need.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from quant.config import get_settings

log = logging.getLogger(__name__)

FIELDS = ("close", "volume")
KEEP_DAYS = 800  # ~2.2 years: enough for 200-day MAs and 12-month momentum


def store_dir() -> Path:
    path = get_settings().data_dir / "universe"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load(field: str) -> pd.DataFrame:
    path = store_dir() / f"{field}.parquet"
    if not path.exists():
        return pd.DataFrame(index=pd.DatetimeIndex([], name="date"))
    df = pd.read_parquet(path)
    df.index = pd.DatetimeIndex(df.index, name="date")
    return df


def save(field: str, df: pd.DataFrame) -> None:
    df = df.sort_index()
    df.columns = df.columns.astype(str)
    df.astype("float32").to_parquet(store_dir() / f"{field}.parquet")


def _normalise_index(df: pd.DataFrame) -> pd.DataFrame:
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    df.index = idx.normalize()
    return df[~df.index.duplicated(keep="last")]


def download(symbols: list[str], period: str, chunk: int = 150, pause: float = 1.0) -> dict[str, pd.DataFrame]:
    """Batch-download daily close and volume. Failed symbols are simply absent."""
    out: dict[str, list[pd.DataFrame]] = {f: [] for f in FIELDS}
    started = time.perf_counter()
    for i in range(0, len(symbols), chunk):
        batch = symbols[i:i + chunk]
        data = None
        for attempt in range(3):
            try:
                data = yf.download(batch, period=period, interval="1d", auto_adjust=True, actions=False,
                                   progress=False, threads=True, group_by="column", timeout=30)
                break
            except Exception as exc:
                log.warning("download batch %d failed (%s); retrying", i // chunk, exc)
                time.sleep(10 * (attempt + 1))
        if data is None or data.empty:
            continue
        for field, col in (("close", "Close"), ("volume", "Volume")):
            part = data[col]
            if isinstance(part, pd.Series):  # single-symbol batch
                part = part.to_frame(batch[0])
            out[field].append(_normalise_index(part.dropna(how="all", axis=1)))
        if (i // chunk) % 10 == 0:
            log.info("downloaded %d/%d symbols (%s) in %.0fs", min(i + chunk, len(symbols)), len(symbols), period,
                     time.perf_counter() - started)
        time.sleep(pause)
    result = {}
    for field, parts in out.items():
        df = pd.concat(parts, axis=1) if parts else pd.DataFrame()
        result[field] = df.loc[:, ~df.columns.duplicated()] if len(df.columns) else df
    return result


def rebased_symbols(stored: pd.DataFrame, fresh: pd.DataFrame, tolerance: float = 1e-3) -> list[str]:
    """Symbols whose past prices changed (split or dividend adjustment) since we stored them.
    The last stored row is ignored because it may have been captured mid-session."""
    common = [s for s in fresh.columns if s in stored.columns]
    if not common or len(stored) < 2:
        return []
    past = stored.index[:-1]
    overlap = fresh.index.intersection(past)
    if not len(overlap):
        return []
    ratio = (fresh.loc[overlap, common] / stored.loc[overlap, common]).replace([np.inf, -np.inf], np.nan)
    drift = (ratio - 1).abs().max()
    return list(drift[drift > tolerance].index)


def update(symbols: list[str], full_period: str = "2y", refresh_period: str = "1mo", prune: bool = True) -> dict:
    """Bring the store up to date for ``symbols``. With ``prune`` (the daily refresh),
    symbols no longer in the universe are dropped; without it, others are kept."""
    symbols = list(dict.fromkeys(symbols))
    stored = {f: load(f) for f in FIELDS}
    have = set(stored["close"].columns)
    old = [s for s in symbols if s in have]
    new = [s for s in symbols if s not in have]

    fresh = download(old, refresh_period) if old else {f: pd.DataFrame() for f in FIELDS}
    rebased = rebased_symbols(stored["close"], fresh["close"])
    full = download(new + rebased, full_period) if new or rebased else {f: pd.DataFrame() for f in FIELDS}

    keep = set(symbols) if prune else set(stored["close"].columns) | set(symbols)
    for f in FIELDS:
        df = stored[f]
        df = df.loc[:, [c for c in df.columns if c in keep and c not in rebased]]
        if len(fresh[f].columns):
            upd = fresh[f].loc[:, [c for c in fresh[f].columns if c not in rebased]]
            df = upd.combine_first(df) if len(df.columns) else upd
        if len(full[f].columns):
            df = df.drop(columns=[c for c in full[f].columns if c in df.columns])
            df = pd.concat([df, full[f]], axis=1) if len(df.columns) else full[f]
        df = df.sort_index()
        if len(df):
            df = df.loc[df.index >= df.index[-1] - pd.Timedelta(days=KEEP_DAYS)]
        save(f, df)
    have = set(load("close").columns)
    missing = [s for s in symbols if s not in have]
    return {"updated": len(old), "new": len(new), "rebased": len(rebased), "missing": len(missing),
            "missing_examples": missing[:10]}
