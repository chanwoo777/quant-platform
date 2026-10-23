"""Phase 4 automation: run the data pipeline and the paper-trading bot on a schedule.

    python -m quant.scheduler               # run forever (Ctrl+C to stop)
    python -m quant.scheduler --list        # show the jobs and their next run times
    python -m quant.scheduler --run-now     # one daily cycle immediately, then exit

Jobs (US/Eastern):
  Mon-Fri 17:30       daily cycle: ingest prices, macro, factors, SEC filings and news for the
                      deep tier (default watchlist + names promoted in Global Overview), then the
                      bot processes the session (stops, signals, trades, ledger), then the global
                      universe refresh (~30 min; skip with --no-universe)
  Mon-Fri 08:00-20:00 news refresh every 2 hours (headlines, FinBERT, relevance)
  Sat 10:00           weekly backtest refresh (dashboard history and Kelly statistics)

Everything is idempotent. On market holidays there is no new session, so the bot
does nothing. A run missed while the machine slept fires late, within 6 hours.
The bot also replays stop checks for any sessions it missed. Logs go to
data/logs/scheduler.log.
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
from datetime import datetime
from logging.handlers import RotatingFileHandler
from zoneinfo import ZoneInfo

from apscheduler.schedulers.base import BaseScheduler
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from quant import trading_bot as bot
from quant.config import get_settings
from quant.db import init_db, session_scope
from quant.ingestion.pipeline import print_summary, run_pipeline

log = logging.getLogger("quant.scheduler")
EASTERN = ZoneInfo("America/New_York")


def _deep_tier() -> tuple[list[str], list[str]]:
    """(deep-tier tickers, tickers the USD paper bot may trade): default watchlist + promoted names."""
    try:
        from quant.universe.watchlist import bot_tickers, deep_tier_tickers

        return deep_tier_tickers(), bot_tickers()
    except Exception:
        log.exception("watchlist unavailable; using the default watchlist")
        equities = list(get_settings().equities)
        return equities, equities


def daily_cycle(sizing: str = "vol_parity", universe: bool = True) -> None:
    deep, tradable = _deep_tier()
    settings = dataclasses.replace(get_settings(), equities=tuple(deep))
    log.info("daily cycle: ingesting data for %d deep-tier names", len(deep))
    print_summary(run_pipeline(settings))
    with session_scope(init_db()) as session:
        days = bot.run_live(session, tradable, bot.BotParams(sizing=sizing))
    if not days:
        log.info("bot: no new session to process")
    for d in days:
        log.info("bot %s: equity %.2f, %d fills, regime %s/%s", d.date, d.equity, len(d.fills), d.regime, d.stance)
        for f in d.fills:
            log.info("  %s %g %s @ %.2f [%s] %s", f.side, f.shares, f.ticker, f.price, f.reason, f.rationale)
    if universe:
        universe_refresh()


def universe_refresh() -> None:
    """Broad tier: re-discover, update prices, rolling fundamentals, re-score (~30 min)."""
    try:
        from quant.universe.refresh import run as refresh

        for step, ok, detail, secs in refresh():
            (log.info if ok else log.error)("universe %s: %s (%.0fs)", step, detail, secs)
    except Exception:
        log.exception("universe refresh failed")


def news_refresh() -> None:
    run_pipeline(get_settings(), steps=("news",))


def weekly_backtest(sizing: str = "vol_parity") -> None:
    settings = get_settings()
    with session_scope(init_db()) as session:
        params = bot.BotParams(sizing=sizing)
        ctx = bot.load_context(session, list(settings.equities), params.vol_window)
        result = bot.backtest(ctx, params, "2018-01-02")
        bot.save_backtest(session, result)
    log.info("weekly backtest saved: CAGR %.1f%%, %d closed trades", 100 * result.stats["cagr"],
             result.stats["closed_trades"])


def _guarded(fn, *args):
    """Log and swallow job errors so one bad day doesn't stop the scheduler."""
    def run():
        try:
            fn(*args)
        except Exception:
            log.exception("job %s failed", fn.__name__)
    run.__name__ = fn.__name__
    return run


def build_scheduler(scheduler: BaseScheduler | None = None, sizing: str = "vol_parity") -> BaseScheduler:
    sched = scheduler or BlockingScheduler(timezone=EASTERN)
    common = {"max_instances": 1, "coalesce": True, "misfire_grace_time": 6 * 3600}
    sched.add_job(_guarded(daily_cycle, sizing), CronTrigger(day_of_week="mon-fri", hour=17, minute=30, timezone=EASTERN),
                  id="daily_cycle", name="ingest data, then run the paper-trading bot", **common)
    sched.add_job(_guarded(news_refresh), CronTrigger(day_of_week="mon-fri", hour="8-20/2", minute=0, timezone=EASTERN),
                  id="news_refresh", name="refresh headlines and sentiment", **common)
    sched.add_job(_guarded(weekly_backtest, sizing), CronTrigger(day_of_week="sat", hour=10, minute=0, timezone=EASTERN),
                  id="weekly_backtest", name="refresh the stored backtest", **common)
    return sched


def _configure_logging() -> None:
    log_dir = get_settings().data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    # pythonw.exe (used by the Windows scheduled task, so no console window pops up)
    # has no stdout/stderr; send prints and library progress output to a file instead.
    windowless = sys.stdout is None or sys.stderr is None
    if windowless:
        out = open(log_dir / "scheduler.out", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or out
        sys.stderr = sys.stderr or out
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(log_dir / "scheduler.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(fmt)
    handlers: list[logging.Handler] = [file_handler]
    if not windowless:
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        handlers.append(console)
    logging.basicConfig(level=logging.INFO, handlers=handlers)
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "huggingface_hub", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Schedule the pipeline and the paper-trading bot.")
    parser.add_argument("--list", action="store_true", help="show the jobs and exit")
    parser.add_argument("--run-now", action="store_true", help="run one daily cycle now and exit")
    parser.add_argument("--sizing", choices=("vol_parity", "kelly"), default="vol_parity")
    parser.add_argument("--no-universe", action="store_true", help="skip the global universe refresh")
    args = parser.parse_args(argv)
    _configure_logging()

    if args.run_now:
        try:
            daily_cycle(args.sizing, universe=not args.no_universe)
        except Exception:
            log.exception("daily cycle failed")
            return 1  # shows up as the task's "Last Run Result"
        return 0
    sched = build_scheduler(sizing=args.sizing)
    now = datetime.now(EASTERN)
    for job in sched.get_jobs():
        nxt = job.trigger.get_next_fire_time(None, now)
        log.info("job %-16s next %s  (%s)", job.id, f"{nxt:%a %Y-%m-%d %H:%M %Z}", job.name)
    if args.list:
        return 0
    log.info("scheduler started (Ctrl+C to stop)")
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("scheduler stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
