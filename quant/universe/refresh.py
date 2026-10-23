"""Refresh the global universe.

    python -m quant.universe.refresh                       # discover, prices, fundamentals, score
    python -m quant.universe.refresh --steps prices score  # a subset
    python -m quant.universe.refresh --fund-limit 4000     # fetch more fundamentals this run

Settings (environment / .env, all optional):
  UNIVERSE_MIN_CAP_USD   1e9    stock market-cap floor
  UNIVERSE_CRYPTO_TOP    250    coins by market cap
  UNIVERSE_ETF_MIN_ADV   1e6    ETF average daily dollar volume floor
  UNIVERSE_FUND_PER_RUN  1500   fundamentals fetched per run (rolling, oldest first)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time

import pandas as pd
from sqlalchemy import select, update

from quant.db import init_db, session_scope, upsert
from quant.models import utcnow
from quant.universe import prices, sources
from quant.universe.models import Instrument, ensure_tables

log = logging.getLogger("quant.universe")

STEPS = ("discover", "prices", "fundamentals", "score")
MIN_CAP_USD = float(os.getenv("UNIVERSE_MIN_CAP_USD", "1e9"))
CRYPTO_TOP = int(os.getenv("UNIVERSE_CRYPTO_TOP", "250"))
ETF_MIN_ADV = float(os.getenv("UNIVERSE_ETF_MIN_ADV", "1e6"))
FUND_PER_RUN = int(os.getenv("UNIVERSE_FUND_PER_RUN", "1500"))

INSTRUMENT_FIELDS = ["symbol", "name", "asset_class", "region", "market", "exchange", "currency", "sector",
                     "market_cap_usd", "price", "change_pct", "fifty_two_week_change", "dividend_yield",
                     "pe_current_year", "analyst_rating", "analyst_label", "coingecko_id", "rank", "also_listed"]


def save_instruments(frame: pd.DataFrame, asset_class: str, run_started, activate: bool = True) -> int:
    """Upsert one asset class and deactivate members that dropped out of it."""
    rows = sources.frame_to_rows(frame, INSTRUMENT_FIELDS)
    for r in rows:
        r["updated_at"] = utcnow()
        if activate:
            r["active"] = True
    with session_scope() as s:
        upsert(s, Instrument, rows, ["symbol"])
        s.execute(update(Instrument).where(Instrument.asset_class == asset_class,
                                           Instrument.updated_at < run_started).values(active=False))
    return len(rows)


def step_discover() -> str:
    run_started = utcnow()
    stocks = sources.discover_stocks(MIN_CAP_USD)
    n_stocks = save_instruments(stocks, "stock", run_started)
    etfs = sources.discover_us_etfs()
    # ETFs stay active/inactive as decided by the liquidity check in the prices step.
    n_etfs = save_instruments(etfs, "etf", run_started, activate=False)
    crypto = sources.discover_crypto(CRYPTO_TOP)
    n_crypto = save_instruments(crypto, "crypto", run_started)
    return f"{n_stocks} stocks, {n_etfs} ETFs listed, {n_crypto} coins"


def active_symbols(asset_classes=("stock", "etf", "crypto")) -> list[str]:
    with session_scope() as s:
        return list(s.scalars(select(Instrument.symbol).where(Instrument.active.is_(True),
                                                              Instrument.asset_class.in_(asset_classes))))


def _etf_checks_path():
    return prices.store_dir() / "etf_liquidity_checked.json"


def etfs_to_download(etf_rows, today: pd.Timestamp, recheck_days: int = 7) -> list[str]:
    """Liquid ETFs every day; the rest only when not liquidity-checked in the last week."""
    try:
        checked = json.loads(_etf_checks_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        checked = {}
    cutoff = today - pd.Timedelta(days=recheck_days)
    return [sym for sym, act in etf_rows if act or sym not in checked or pd.Timestamp(checked[sym]) <= cutoff]


def step_prices() -> str:
    with session_scope() as s:
        etf_rows = s.execute(select(Instrument.symbol, Instrument.active).where(Instrument.asset_class == "etf")).all()
    from quant.universe.scoring import BENCHMARK_SYMBOLS

    etf_candidates = etfs_to_download(etf_rows, pd.Timestamp.today().normalize())
    symbols = active_symbols(("stock", "crypto")) + etf_candidates + BENCHMARK_SYMBOLS
    stats = prices.update(symbols)
    liquid = filter_etfs(etf_candidates)
    return (f"{stats['updated']} refreshed, {stats['new']} new, {stats['rebased']} re-downloaded after "
            f"splits/dividends, {stats['missing']} without data; {len(liquid)} of {len(etf_candidates)} "
            "ETFs checked are liquid")


def filter_etfs(etf_symbols: list[str]) -> set[str]:
    """ETF liquidity filter: average daily dollar volume over ~3 months >= ETF_MIN_ADV.
    Only ``etf_symbols`` (the ones just downloaded) are re-evaluated; others keep their status."""
    close, volume = prices.load("close"), prices.load("volume")
    etfs = [sym for sym in etf_symbols if sym in close.columns]
    adv = (close[etfs] * volume[etfs]).tail(63).mean()
    liquid = set(adv[adv >= ETF_MIN_ADV].index)
    with session_scope() as s:
        s.execute(update(Instrument).where(Instrument.symbol.in_(list(etf_symbols))).values(active=False))
        if liquid:
            s.execute(update(Instrument).where(Instrument.symbol.in_(list(liquid))).values(active=True))
    illiquid = [sym for sym in etfs if sym not in liquid]
    for field in prices.FIELDS:  # don't keep history for illiquid ETFs
        df = prices.load(field)
        prices.save(field, df.drop(columns=[c for c in illiquid if c in df.columns]))
    try:
        checked = json.loads(_etf_checks_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        checked = {}
    checked.update(dict.fromkeys(etf_symbols, f"{pd.Timestamp.today():%Y-%m-%d}"))
    _etf_checks_path().write_text(json.dumps(checked, indent=0, sort_keys=True), encoding="utf-8")
    return liquid


def step_fundamentals(limit: int) -> str:
    from quant.universe import fundamentals

    return fundamentals.refresh(limit)


def step_score() -> str:
    from quant.universe import scoring

    scores = scoring.run()
    return f"{len(scores)} instruments scored; {int((scores.signal == 'BUY').sum())} buy candidates"


def run(steps=STEPS, fund_limit: int = FUND_PER_RUN) -> list[tuple[str, bool, str, float]]:
    ensure_tables(init_db())
    results = []
    for step in steps:
        started = time.perf_counter()
        try:
            detail = {"discover": step_discover, "prices": step_prices, "score": step_score,
                      "fundamentals": lambda: step_fundamentals(fund_limit)}[step]()
            ok = True
        except Exception as exc:
            log.exception("universe step %s failed", step)
            detail, ok = f"{type(exc).__name__}: {exc}", False
        results.append((step, ok, detail, time.perf_counter() - started))
        log.info("universe %s: %s (%.0fs)", step, detail, results[-1][3])
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh the global stock / ETF / crypto universe.")
    parser.add_argument("--steps", nargs="+", choices=STEPS, default=list(STEPS))
    parser.add_argument("--fund-limit", type=int, default=FUND_PER_RUN, help="fundamentals to fetch this run")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    results = run(args.steps, args.fund_limit)
    print()
    for step, ok, detail, secs in results:
        print(f"{step:<13}{'ok' if ok else 'FAILED':<8}{secs:>7.0f}s   {detail}")
    return 0 if all(ok for _, ok, _, _ in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
