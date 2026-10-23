"""Phase 1 orchestrator: run every ingestion step and report what happened.

    python -m quant.ingestion.pipeline                        # all steps
    python -m quant.ingestion.pipeline --steps prices news    # a subset
    python -m quant.ingestion.pipeline --tickers AAPL MSFT --no-finbert
    python -m quant.ingestion.pipeline --universe sp500       # + point-in-time S&P 500 research universe

Each ticker / series runs in its own transaction, so one failing source never
blocks the rest. Every step is idempotent; re-running only fetches what's new.
Phase 4 schedules ``run_pipeline()`` daily with APScheduler.
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from quant.config import PREDECESSOR_CIKS, Settings, get_settings
from quant.db import init_db, session_scope
from quant.ingestion import factors, index_membership, macro_data, market_data, news_scraper, sec_edgar
from quant.ingestion.http import BROWSER_USER_AGENT, TOOL_USER_AGENT, make_session
from quant.ingestion.sentiment import get_scorer
from quant.models import FactorReturn, PriceBar

log = logging.getLogger("quant.pipeline")

STEPS = ("universe", "prices", "macro", "factors", "fundamentals", "news")
UNIVERSES = ("watchlist", index_membership.SP500)
MARKET_PROXY = "SPY"  # intraday chart that market-wide headlines are mapped onto


@dataclass
class StepResult:
    name: str
    rows: int = 0
    seconds: float = 0.0
    detail: str = ""
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _run_items(engine: Engine, items: Iterable, fn: Callable[[Session, object], int], label: str):
    """Apply ``fn`` to each item in its own transaction; collect row counts and errors."""
    rows, errors = 0, []
    for item in items:
        try:
            with session_scope(engine) as session:
                n = fn(session, item)
            rows += n
            log.info("%s %s: %d rows", label, item or "MARKET", n)
        except Exception as exc:
            errors.append(f"{item}: {type(exc).__name__}: {exc}")
            log.error("%s %s failed: %s", label, item, exc)
    return rows, errors


def research_tickers(engine: Engine, settings: Settings, priced_only: bool = False) -> list[str]:
    """Research-universe tickers beyond the watchlist: every index member since the
    start of the price window (``priced_only``: those Yahoo had prices for)."""
    if settings.research_universe == "watchlist":
        return []
    with session_scope(engine) as session:
        intervals = index_membership.load_membership(session, settings.research_universe)
        if intervals.empty:
            raise RuntimeError(f"no stored {settings.research_universe} membership: run the 'universe' step first")
        tickers = index_membership.universe_tickers(intervals, settings.history_start)
        if priced_only:
            priced = set(session.scalars(select(PriceBar.ticker).where(PriceBar.interval == "1d").distinct()))
            tickers = [t for t in tickers if t in priced]
    return [t for t in tickers if t not in settings.equities]


def ingest_universe(settings: Settings, engine: Engine, result: StepResult) -> None:
    if settings.research_universe == "watchlist":
        result.detail = "skipped: research universe is the watchlist (--universe sp500 or RESEARCH_UNIVERSE=sp500)"
        return
    http = make_session(TOOL_USER_AGENT)
    with session_scope(engine) as session:
        result.rows, result.detail, _ = index_membership.update_membership(
            session, http, settings.cache_dir, settings.http_timeout)


def ingest_prices(settings: Settings, engine: Engine, result: StepResult) -> None:
    def update(session: Session, ticker: str) -> int:
        daily = market_data.update_daily(session, ticker, settings.daily_history_period)
        intraday = market_data.update_intraday(
            session, ticker, settings.intraday_interval, settings.intraday_period
        )
        market_data.update_splits(session, ticker)
        return daily + intraday

    result.rows, result.errors = _run_items(engine, settings.price_tickers, update, "prices")
    result.detail = f"{len(settings.price_tickers)} tickers, daily ({settings.daily_history_period}) + {settings.intraday_interval}"

    extra = research_tickers(engine, settings)
    if extra:
        batch = market_data.update_daily_batch(engine, extra, settings.daily_history_period, settings.cache_dir)
        result.rows += batch.rows
        result.errors += batch.errors
        result.detail += (f"; {settings.research_universe}: {len(extra)} more tickers, daily only, "
                          f"{len(batch.no_data)} without Yahoo data, {batch.dormant} delisted")


def ingest_macro(settings: Settings, engine: Engine, result: StepResult) -> None:
    client = macro_data.FredClient(settings.http_timeout)

    def update(session: Session, series_id: str) -> int:
        title, category = settings.fred_series[series_id]
        return macro_data.update_series(session, client, series_id, title, category, settings.fred_start)

    result.rows, result.errors = _run_items(engine, settings.fred_series, update, "FRED")
    result.detail = f"{len(settings.fred_series)} series via {client.backend}"


def ingest_factors(settings: Settings, engine: Engine, result: StepResult) -> None:
    with session_scope(engine) as session:
        result.rows, backend = factors.update_factors(session, settings.factor_start, settings.http_timeout)
        latest = session.scalar(select(func.max(FactorReturn.date)))
    result.detail = f"Fama-French 3 factors + momentum via {backend}, through {latest}"


def ingest_fundamentals(settings: Settings, engine: Engine, result: StepResult) -> None:
    client = sec_edgar.SECClient(settings.sec_user_agent, settings.cache_dir, settings.http_timeout)

    def update(session: Session, ticker: str) -> int:
        return sec_edgar.update_fundamentals(
            session, client, ticker, settings.sec_max_filings,
            PREDECESSOR_CIKS.get(ticker, ()), refresh=settings.sec_refresh,
        )

    tickers = [*settings.equities, *research_tickers(engine, settings, priced_only=True)]
    fetch, linked = sec_edgar.split_share_classes(client, tickers)
    result.rows, result.errors = _run_items(engine, fetch, update, "SEC")
    for ticker, primary in linked.items():
        with session_scope(engine) as session:
            sec_edgar.link_share_class(session, ticker, primary)
    mode = "re-extracted" if settings.sec_refresh else "new filings only"
    result.detail = (f"{len(fetch)} filers, latest {settings.sec_max_filings} 10-K/10-Q each ({mode})"
                     + (f"; {len(linked)} extra share classes linked" if linked else ""))


def ingest_news(settings: Settings, engine: Engine, result: StepResult) -> None:
    # Headlines + FinBERT cover the watchlist; NEWS_UNIVERSE=research adds the research universe.
    tickers = list(settings.equities)
    if settings.news_universe == "research":
        tickers += research_tickers(engine, settings, priced_only=True)
    http = make_session(BROWSER_USER_AGENT)
    articles = news_scraper.collect_news(http, tickers, settings.news_lookback_days, settings.http_timeout)
    with session_scope(engine) as session:
        news_scraper.store_articles(session, articles)
        aliases = news_scraper.company_aliases(session, tickers)
        firms = news_scraper.research_firms(session, tickers)
        n_checked, n_relevant = news_scraper.score_relevance(session, aliases, firms)

    scorer = get_scorer(settings.sentiment_model, settings.use_finbert)
    with session_scope(engine) as session:
        scored = news_scraper.score_unscored_articles(session, scorer)

    def map_ticker(session: Session, ticker: str | None) -> int:
        return news_scraper.map_news_to_intraday(
            session,
            ticker,
            settings.intraday_interval,
            settings.intraday_minutes,
            settings.news_reaction_minutes,
            bars_ticker=ticker or MARKET_PROXY,
        )

    # Intraday bars (and so headline -> chart mapping) exist for the watchlist only.
    mapped, result.errors = _run_items(engine, [*settings.equities, None], map_ticker, "news->chart")
    result.rows = len(articles)
    result.detail = (
        f"{len(articles)} headlines, {n_relevant}/{n_checked} new on-topic, "
        f"{scored} scored ({scorer.name}), {mapped} mapped to chart"
    )


RUNNERS: dict[str, Callable[[Settings, Engine, StepResult], None]] = {
    "universe": ingest_universe,
    "prices": ingest_prices,
    "macro": ingest_macro,
    "factors": ingest_factors,
    "fundamentals": ingest_fundamentals,
    "news": ingest_news,
}


def run_pipeline(
    settings: Settings | None = None, steps: Iterable[str] = STEPS, engine: Engine | None = None
) -> list[StepResult]:
    settings = settings or get_settings()
    engine = init_db(engine)
    results = []
    for name in steps:
        result = StepResult(name)
        started = time.perf_counter()
        try:
            RUNNERS[name](settings, engine, result)
        except Exception as exc:  # a whole step failing (e.g. network down)
            log.exception("step %s failed", name)
            result.errors.append(f"{type(exc).__name__}: {exc}")
        result.seconds = time.perf_counter() - started
        results.append(result)
    return results


def print_summary(results: list[StepResult]) -> None:
    print("\n" + "=" * 78)
    print(f"{'step':<14}{'status':<9}{'rows':>9}{'time':>9}   detail")
    print("-" * 78)
    for r in results:
        status = "ok" if r.ok else f"{len(r.errors)} err"
        print(f"{r.name:<14}{status:<9}{r.rows:>9}{r.seconds:>8.1f}s   {r.detail}")
        for err in r.errors[:5]:
            print(f"{'':<14}! {err[:120]}")
    print("=" * 78)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the free-data ingestion pipeline.")
    parser.add_argument("--steps", nargs="+", choices=STEPS, default=list(STEPS))
    parser.add_argument("--tickers", nargs="+", help="override the equity watchlist")
    parser.add_argument("--universe", choices=UNIVERSES,
                        help="research universe for prices + SEC (default: RESEARCH_UNIVERSE, else watchlist)")
    parser.add_argument("--no-finbert", action="store_true", help="use the lexicon sentiment fallback")
    parser.add_argument("--refresh-fundamentals", action="store_true",
                        help="re-extract stored SEC filings (after adding a metric)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "huggingface_hub", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    settings = get_settings()
    overrides = {}
    if args.tickers:
        overrides["equities"] = tuple(t.upper() for t in args.tickers)
    if args.no_finbert:
        overrides["use_finbert"] = False
    if args.refresh_fundamentals:
        overrides["sec_refresh"] = True
    if args.universe:
        overrides["research_universe"] = args.universe
    if overrides:
        settings = dataclasses.replace(settings, **overrides)

    results = run_pipeline(settings, args.steps)
    print_summary(results)
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
