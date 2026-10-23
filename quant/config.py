"""Central configuration, read from environment variables (or a local .env file).

Every data source used by the platform is free and public:
  * Yahoo Finance via yfinance          - prices, VIX, indices
  * FRED (St. Louis Fed)                - macro series, no API key needed
  * SEC EDGAR (data.sec.gov)            - 10-K / 10-Q XBRL financials
  * Google News / Yahoo / CNBC / MarketWatch RSS - headlines
  * ProsusAI/finbert on HuggingFace     - open-source sentiment model
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_EQUITIES = ("AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "JPM", "XOM", "JNJ", "TSLA")

# Broad-market benchmarks. ^VIX feeds the regime model in Phase 2; SPY is the
# tradable proxy for the market factor.
DEFAULT_INDICES = ("^GSPC", "^IXIC", "^DJI", "^RUT", "^VIX", "SPY")

# Names headlines use for each company, on top of the SEC registrant name.
# Used by the headline relevance filter; add entries when extending the watchlist.
DEFAULT_ALIASES: dict[str, tuple[str, ...]] = {
    "AAPL": ("Apple", "iPhone"),
    "MSFT": ("Microsoft", "Azure"),
    "NVDA": ("Nvidia",),
    "AMZN": ("Amazon", "AWS"),
    "GOOGL": ("Alphabet", "Google", "YouTube", "GOOG"),
    "META": ("Meta", "Facebook", "Instagram"),
    "JPM": ("JPMorgan", "JPMorganChase", "J.P. Morgan", "JP Morgan"),
    "XOM": ("Exxon", "ExxonMobil"),
    "JNJ": ("Johnson & Johnson", "J&J"),
    "TSLA": ("Tesla",),
}

# Earlier SEC registrants of the same business. ExxonMobil re-registered under a
# new CIK in 2026; its 10-K/10-Q history before that lives under CIK 34088.
PREDECESSOR_CIKS: dict[str, tuple[int, ...]] = {"XOM": (34088,)}

# FRED series id -> (human label, category). Frequencies differ: yields and
# spreads are daily, claims weekly, CPI / payrolls / unemployment monthly.
DEFAULT_FRED_SERIES: dict[str, tuple[str, str]] = {
    "CPIAUCSL": ("CPI - All Urban Consumers", "inflation"),
    "CPILFESL": ("Core CPI (ex food & energy)", "inflation"),
    "T10YIE": ("10Y Breakeven Inflation", "inflation"),
    "DGS3MO": ("3-Month Treasury Yield", "rates"),
    "DGS2": ("2-Year Treasury Yield", "rates"),
    "DGS10": ("10-Year Treasury Yield", "rates"),
    "T10Y2Y": ("10Y-2Y Treasury Spread", "rates"),
    "DFF": ("Effective Fed Funds Rate", "rates"),
    "UNRATE": ("Unemployment Rate", "employment"),
    "PAYEMS": ("Nonfarm Payrolls (thousands)", "employment"),
    "ICSA": ("Initial Jobless Claims", "employment"),
    "VIXCLS": ("CBOE Volatility Index (VIX)", "risk"),
    "BAMLH0A0HYM2": ("US High-Yield OAS Spread", "risk"),  # FRED keeps only ~3 years of ICE data
    "BAA10Y": ("Baa Corporate - 10Y Treasury Spread", "risk"),  # full history: used for credit stress
}


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name)
    if not raw:
        return default
    return tuple(item.strip().upper() for item in raw.split(",") if item.strip())


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    data_dir: Path
    cache_dir: Path
    equities: tuple[str, ...]
    indices: tuple[str, ...]
    daily_history_period: str
    intraday_interval: str
    intraday_period: str
    fred_start: date
    factor_start: date
    sec_user_agent: str
    sec_max_filings: int
    news_lookback_days: int
    news_reaction_minutes: int
    sentiment_model: str
    use_finbert: bool
    http_timeout: float
    sec_refresh: bool = False  # re-extract stored filings (after adding a metric)
    fred_series: dict[str, tuple[str, str]] = field(default_factory=lambda: dict(DEFAULT_FRED_SERIES))
    # Research universe for factor tests and backtests: "watchlist" (the equities above)
    # or "sp500" (point-in-time S&P 500 members, see ingestion/index_membership.py).
    research_universe: str = "watchlist"
    # Headlines + FinBERT for "watchlist" only, or the whole "research" universe.
    news_universe: str = "watchlist"

    @property
    def price_tickers(self) -> tuple[str, ...]:
        """Equities followed by benchmarks, de-duplicated, order preserved."""
        return tuple(dict.fromkeys(self.equities + self.indices))

    @property
    def history_start(self) -> date | None:
        """First date of the daily price window ("10y" -> ten years ago; None for "max")."""
        period = self.daily_history_period.strip().lower()
        if period.endswith("y") and period[:-1].isdigit():
            today = date.today()
            return today.replace(year=today.year - int(period[:-1]), day=min(today.day, 28))
        if period.endswith("mo") and period[:-2].isdigit():
            return date.today() - timedelta(days=31 * int(period[:-2]))
        return None

    @property
    def intraday_minutes(self) -> int:
        """Bar length in minutes for the configured intraday interval ("15m" -> 15, "1h" -> 60)."""
        unit = self.intraday_interval[-1]
        value = int(self.intraday_interval[:-1])
        return value * 60 if unit == "h" else value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    data_dir = Path(os.getenv("DATA_DIR", PROJECT_ROOT / "data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = data_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        database_url=os.getenv("DATABASE_URL", f"sqlite:///{(data_dir / 'quant.db').as_posix()}"),
        data_dir=data_dir,
        cache_dir=cache_dir,
        equities=_env_list("WATCHLIST", DEFAULT_EQUITIES),
        indices=_env_list("BENCHMARKS", DEFAULT_INDICES),
        daily_history_period=os.getenv("DAILY_HISTORY_PERIOD", "10y"),
        intraday_interval=os.getenv("INTRADAY_INTERVAL", "15m"),
        # Yahoo serves 15m bars for at most the last 60 days.
        intraday_period=os.getenv("INTRADAY_PERIOD", "30d"),
        fred_start=date.fromisoformat(os.getenv("FRED_START", "2000-01-01")),
        factor_start=date.fromisoformat(os.getenv("FACTOR_START", "2000-01-01")),
        # SEC fair-access policy requires a descriptive User-Agent with a contact
        # email, e.g. "Jane Doe Research jane@example.com". Set it in .env.
        sec_user_agent=os.getenv("SEC_USER_AGENT", "FreeQuantPlatform research admin@example.com"),
        # 44 filings ~= 11 years of 10-K + 10-Q history: enough to backtest the factor score.
        sec_max_filings=int(os.getenv("SEC_MAX_FILINGS", "44")),
        news_lookback_days=int(os.getenv("NEWS_LOOKBACK_DAYS", "7")),
        news_reaction_minutes=int(os.getenv("NEWS_REACTION_MINUTES", "60")),
        sentiment_model=os.getenv("SENTIMENT_MODEL", "ProsusAI/finbert"),
        use_finbert=_env_bool("USE_FINBERT", True),
        http_timeout=float(os.getenv("HTTP_TIMEOUT", "20")),
        research_universe=os.getenv("RESEARCH_UNIVERSE", "watchlist").strip().lower(),
        news_universe=os.getenv("NEWS_UNIVERSE", "watchlist").strip().lower(),
    )
