"""Signal track record: an append-only log of each night's signals, and how they did afterwards.

    data/track/signals_<date>.parquet   one file per signal date: symbol, market, class, signal, score, close
    data/track/manifest.jsonl           one line per file: date, sha256, the previous line's hash, logged at

Every file is created with exclusive mode ("xb"), so a rerun for a date that is already logged changes
nothing, and a date older than the newest logged one is refused: history is only ever appended,
never rewritten or backfilled. Each manifest line carries the SHA-256 of its file and of the line
before it, so anyone can check that no earlier day was altered after the fact.

Forward performance (summarize): a signal dated d (the close it was scored on) is entered at the next
session's close and held 5, 20 or 60 of that symbol's trading sessions. Its benchmark is the market's
index over the same dates (S&P 500 for the US, BTC for coins, and so on). Observations are signal
dates, since the names logged on one day are not independent of each other.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web")

HORIZONS = (5, 20, 60)
MIN_OBSERVATIONS = 60
SIGNALS = ("BUY", "HOLD", "AVOID")
COLUMNS = ["symbol", "market", "asset_class", "signal", "composite", "close"]


def log_dir(data_dir: Path) -> Path:
    return data_dir / "track"


def _manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _line_hash(entry: dict) -> str:
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def append(data_dir: Path, scores: pd.DataFrame, as_of: str) -> dict:
    """Log tonight's signals for the close of `as_of` (YYYY-MM-DD). Returns what happened:
    {"logged": bool, "reason": str, "date": as_of}. Never overwrites a file or a manifest line."""
    folder = log_dir(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = folder / "manifest.jsonl"
    entries = _manifest(manifest_path)
    if entries and as_of <= entries[-1]["date"]:
        same = as_of == entries[-1]["date"]
        return {"logged": False, "date": as_of, "reason": "already logged" if same else f"older than the last logged date {entries[-1]['date']}"}
    path = folder / f"signals_{as_of}.parquet"
    rows = scores.loc[scores.signal.isin(SIGNALS), [c for c in ("symbol", "market", "asset_class", "signal", "composite", "last_close") if c in scores]]
    rows = rows.rename(columns={"last_close": "close"}).sort_values("symbol").reset_index(drop=True)
    buf = io.BytesIO()
    rows.to_parquet(buf, index=False)
    data = buf.getvalue()
    try:
        with open(path, "xb") as fh:  # exclusive create: fails if the file exists
            fh.write(data)
    except FileExistsError:
        return {"logged": False, "date": as_of, "reason": "file exists"}
    entry = {"date": as_of, "file": path.name, "rows": int(len(rows)), "sha256": hashlib.sha256(data).hexdigest(),
             "prev": _line_hash(entries[-1]) if entries else None,
             "logged_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    with open(manifest_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")
    log.info("track record: logged %d signals for %s", len(rows), as_of)
    return {"logged": True, "date": as_of, "reason": "new date", "rows": int(len(rows))}


def verify(data_dir: Path) -> dict:
    """Check every logged file against its manifest hash and the chain of line hashes."""
    folder = log_dir(data_dir)
    entries = _manifest(folder / "manifest.jsonl")
    problems = []
    for i, e in enumerate(entries):
        f = folder / e["file"]
        if not f.exists():
            problems.append(f"{e['date']}: file missing")
        elif hashlib.sha256(f.read_bytes()).hexdigest() != e["sha256"]:
            problems.append(f"{e['date']}: file changed after it was logged")
        if i and e.get("prev") != _line_hash(entries[i - 1]):
            problems.append(f"{e['date']}: manifest chain broken")
    return {"entries": len(entries), "ok": not problems, "problems": problems}


def load(data_dir: Path) -> pd.DataFrame:
    folder = log_dir(data_dir)
    frames = []
    for e in _manifest(folder / "manifest.jsonl"):
        f = folder / e["file"]
        if f.exists():
            frames.append(pd.read_parquet(f).assign(date=pd.Timestamp(e["date"])))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=COLUMNS + ["date"])


def forward_returns(log_df: pd.DataFrame, close: pd.DataFrame, benchmarks: dict[str, str]) -> pd.DataFrame:
    """One row per logged (date, symbol, horizon) whose horizon has passed: ret, bench, excess."""
    cols = ["date", "symbol", "signal", "market", "horizon", "ret", "bench", "excess", "entry", "exit"]
    if log_df.empty:
        return pd.DataFrame(columns=cols)
    bench_series = {m: close[s].dropna() for m, s in benchmarks.items() if s in close}
    out = []
    for sym, g in log_df.groupby("symbol"):
        if sym not in close:
            continue
        s = close[sym].dropna()
        if len(s) < 2:
            continue
        dates, values = s.index.to_numpy(), s.to_numpy(dtype=float)
        entry = np.searchsorted(dates, g.date.to_numpy(dtype="datetime64[ns]"), side="right")  # next session after the signal
        bench = bench_series.get(g.market.iloc[0])
        for h in HORIZONS:
            k = np.flatnonzero(entry + h < len(values))
            if not len(k):
                continue
            e, x = entry[k], entry[k] + h
            ret = values[x] / values[e] - 1
            b = np.full(len(k), np.nan)
            if bench is not None and len(bench):
                bv = bench.to_numpy(dtype=float)
                be, bx = bench.index.searchsorted(dates[e], side="right") - 1, bench.index.searchsorted(dates[x], side="right") - 1
                have = (be >= 0) & (bx >= 0)
                b[have] = bv[bx[have]] / bv[be[have]] - 1
            sub = g.iloc[k]
            out.append(pd.DataFrame({"date": sub.date.to_numpy(), "symbol": sym, "signal": sub.signal.to_numpy(), "market": sub.market.to_numpy(),
                                     "horizon": h, "ret": ret, "bench": b, "excess": ret - b, "entry": dates[e], "exit": dates[x]}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=cols)


def summarize(data_dir: Path, close: pd.DataFrame, benchmarks: dict[str, str]) -> dict:
    """track.json: per horizon and signal, the average forward return, benchmark, excess and hit rate
    over the signal dates whose horizon has passed, with the number of dates (observations)."""
    entries = _manifest(log_dir(data_dir) / "manifest.jsonl")
    log_df = load(data_dir)
    fr = forward_returns(log_df, close, benchmarks)
    horizons = {}
    for h in HORIZONS:
        per = {}
        for sig in SIGNALS:
            f = fr[(fr.horizon == h) & (fr.signal == sig)].dropna(subset=["ret"])
            if f.empty:
                per[sig] = {"observations": 0, "names": 0}
                continue
            with_bench = f.dropna(subset=["bench"])
            daily = f.groupby("date").agg(ret=("ret", "mean"))
            daily_x = with_bench.groupby("date").agg(bench=("bench", "mean"), excess=("excess", "mean"))
            hits = (with_bench.excess < 0) if sig == "AVOID" else (with_bench.excess > 0)
            per[sig] = {"observations": int(daily.shape[0]), "names": int(len(f)),
                        "first": f"{f.date.min():%Y-%m-%d}", "last": f"{f.date.max():%Y-%m-%d}",
                        "avg_return": float(daily.ret.mean()), "avg_benchmark": float(daily_x.bench.mean()) if len(daily_x) else None,
                        "avg_excess": float(daily_x.excess.mean()) if len(daily_x) else None,
                        "hit_rate": float(hits.mean()) if len(with_bench) else None,
                        "hit_rule": "underperformed its benchmark" if sig == "AVOID" else "beat its benchmark",
                        "enough": int(daily.shape[0]) >= MIN_OBSERVATIONS}
        horizons[str(h)] = per
    cohorts = []
    if len(fr):
        for (d, h, sig), g in fr.groupby(["date", "horizon", "signal"]):
            gb = g.dropna(subset=["bench"])
            cohorts.append({"date": f"{d:%Y-%m-%d}", "horizon": int(h), "signal": sig, "names": int(len(g)),
                            "avg_return": float(g.ret.mean()), "avg_excess": float(gb.excess.mean()) if len(gb) else None,
                            "exit": f"{pd.Timestamp(g.exit.max()):%Y-%m-%d}"})
    counts = log_df.groupby(["date", "signal"]).size().unstack(fill_value=0) if len(log_df) else pd.DataFrame()
    days = [{"date": e["date"], "rows": e["rows"], "sha256": e["sha256"], "prev": e.get("prev"), "logged_at": e["logged_at"],
             **({s.lower(): int(counts.at[pd.Timestamp(e["date"]), s]) for s in SIGNALS if s in counts.columns}
                if len(counts) and pd.Timestamp(e["date"]) in counts.index else {})} for e in entries]
    return {"start": entries[0]["date"] if entries else None, "last": entries[-1]["date"] if entries else None,
            "days_logged": len(entries), "horizons": horizons, "cohorts": cohorts[-600:], "days": days,
            "min_observations": MIN_OBSERVATIONS, "benchmarks": benchmarks, "verify": verify(data_dir),
            "method": "Entry at the next session's close after the signal's close; exit h sessions later; benchmark = the market's index over the same dates. "
                      "Averages weight each signal date equally; the hit rate counts names. Observations = signal dates."}
