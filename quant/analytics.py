"""Phase 2 analytics: technical indicators, market regime, and chart-to-news anomalies.

Everything is computed on demand from the database that Phase 1 fills. The core
functions take plain DataFrames (easy to test and backtest); the ``*_for``
helpers load what they need from the database.

    python -m quant.analytics                    # market regime only
    python -m quant.analytics AAPL JNJ           # + indicators and explained anomalies
    python -m quant.analytics TSLA --interval 15m
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import ta
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from quant.ingestion.macro_data import load_macro
from quant.ingestion.market_data import load_bars
from quant.ingestion.news_scraper import company_aliases, research_firms
from quant.ingestion.relevance import relevance_score
from quant.models import NewsArticle

EXCHANGE_TZ = "America/New_York"
SESSION_CLOSE_HOUR = 16
TRADING_DAYS = 252
BENCHMARK_NAMES = {"^GSPC": "S&P 500", "SPY": "SPY", "^IXIC": "Nasdaq Composite", "^DJI": "Dow Jones"}


# =============================================================================
# 1. Core indicators
# =============================================================================

def add_indicators(bars: pd.DataFrame) -> pd.DataFrame:
    """Append 50/200 MA, RSI(14), MACD(12,26,9), Bollinger(20,2), ATR(14) and
    realised volatility to daily OHLCV bars (computed with the ``ta`` library)."""
    df = bars.copy()
    close = df["close"].astype(float)

    df["sma_50"] = ta.trend.SMAIndicator(close, 50).sma_indicator()
    df["sma_200"] = ta.trend.SMAIndicator(close, 200).sma_indicator()
    df["rsi_14"] = ta.momentum.RSIIndicator(close, 14).rsi()

    macd = ta.trend.MACD(close, window_slow=26, window_fast=12, window_sign=9)
    df["macd"], df["macd_signal"], df["macd_hist"] = macd.macd(), macd.macd_signal(), macd.macd_diff()

    bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
    df["bb_upper"], df["bb_middle"], df["bb_lower"] = bb.bollinger_hband(), bb.bollinger_mavg(), bb.bollinger_lband()
    df["bb_pct_b"], df["bb_width"] = bb.bollinger_pband(), bb.bollinger_wband()

    if len(df) > 14:  # ta's ATR raises on shorter series (e.g. a new listing)
        atr = ta.volatility.AverageTrueRange(df["high"], df["low"], close, 14).average_true_range()
        df["atr_14"] = atr.mask(atr == 0)  # ta reports 0 instead of NaN while warming up
    else:
        df["atr_14"] = np.nan

    price = df["adj_close"] if "adj_close" in df else close  # dividends matter for returns
    df["return_1d"] = price.pct_change()
    df["volatility_20d"] = df["return_1d"].rolling(20).std() * math.sqrt(TRADING_DAYS)

    # +1 when the 50-day is above the 200-day (golden-cross alignment), -1 below.
    df["ma_trend"] = np.sign(df["sma_50"] - df["sma_200"])
    previous = df["ma_trend"].shift()
    df["golden_cross"] = (df["ma_trend"] > 0) & (previous < 0)
    df["death_cross"] = (df["ma_trend"] < 0) & (previous > 0)
    return df


def indicator_snapshot(df: pd.DataFrame) -> dict:
    """Latest indicator values plus plain-English readings."""
    last = df.iloc[-1]
    crosses = df[df["golden_cross"] | df["death_cross"]]
    last_cross = None
    if not crosses.empty:
        when = crosses.index[-1]
        last_cross = {
            "type": "golden" if crosses["golden_cross"].iloc[-1] else "death",
            "date": pd.Timestamp(when).date(),
            "sessions_ago": int(len(df.loc[when:]) - 1),
        }

    readings = []
    if pd.notna(last.sma_200):
        side = "above" if last.close > last.sma_200 else "below"
        align = "golden-cross" if last.sma_50 > last.sma_200 else "death-cross"
        readings.append(f"{align} alignment (50-day {last.sma_50 / last.sma_200 - 1:+.1%} vs 200-day), price {side} 200-day")
    if pd.notna(last.rsi_14):
        state = "overbought" if last.rsi_14 >= 70 else "oversold" if last.rsi_14 <= 30 else "neutral"
        readings.append(f"RSI {last.rsi_14:.0f} ({state})")
    if pd.notna(last.macd_hist):
        readings.append(f"MACD {'above' if last.macd_hist > 0 else 'below'} signal ({'bullish' if last.macd_hist > 0 else 'bearish'} momentum)")
    if pd.notna(last.bb_pct_b):
        if last.bb_pct_b > 1:
            readings.append("closed above the upper Bollinger band")
        elif last.bb_pct_b < 0:
            readings.append("closed below the lower Bollinger band")
        else:
            readings.append(f"inside Bollinger bands (%B {last.bb_pct_b:.2f})")

    cols = ["close", "sma_50", "sma_200", "rsi_14", "macd", "macd_signal", "macd_hist",
            "bb_upper", "bb_lower", "bb_pct_b", "atr_14", "volatility_20d"]
    values = {c: (None if pd.isna(last[c]) else float(last[c])) for c in cols}
    return {"date": pd.Timestamp(df.index[-1]).date(), **values, "last_cross": last_cross, "readings": readings}


def indicators_for(session: Session, ticker: str, start: datetime | None = None) -> pd.DataFrame:
    df = add_indicators(load_bars(session, ticker, "1d"))
    return df.loc[start:] if start is not None else df


# =============================================================================
# 2. Market regime
# =============================================================================

@dataclass(frozen=True)
class RegimeParams:
    """Tuned on S&P 500 / VIX 1990-2026 (scripts/calibrate_phase2.py regime*)."""

    sideways_band: float = 0.01  # 50-day within ±band of the 200-day = no clear trend
    bear_drawdown: float = 0.20  # classic bear market: 20% off the 52-week high (beats the lagging death cross)
    vix_calm: float = 16.0  # VIX below this = Calm (~39th percentile since 1990)
    vix_volatile: float = 24.0  # VIX at/above this = Volatile (~80th percentile)
    # Labels move to a riskier state at once, but back to a calmer one only after
    # this many consecutive days of calmer readings. 5 days cut trend switches from
    # 6.2 to 4.2 a year and volatility switches from 24 to 11.
    trend_confirm_days: int = 5
    vol_confirm_days: int = 5
    stance_confirm_days: int = 5


REGIME_PARAMS = RegimeParams()
TREND_RISK = {"Bull": 0, "Sideways": 1, "Bear": 2}
VOL_RISK = {"Calm": 0, "Normal": 1, "Volatile": 2}
STANCE_RISK = {"Risk-On": 0, "Neutral": 1, "Risk-Off": 2}


def _sticky(raw: pd.Series, risk: dict[str, int], confirm_days: int) -> pd.Series:
    """Fast to de-risk, slow to re-risk: riskier labels apply immediately; a calmer
    label needs ``confirm_days`` consecutive calmer readings (then the most
    cautious of those readings is adopted)."""
    if confirm_days <= 1:
        return raw
    out, state, calmer = [], None, []
    for label in raw.to_numpy(dtype=object):
        if not isinstance(label, str):
            out.append(state)
            continue
        if state is None or risk[label] > risk[state]:
            state, calmer = label, []
        elif risk[label] < risk[state]:
            calmer.append(label)
            if len(calmer) >= confirm_days:
                state, calmer = max(calmer, key=risk.get), []
        else:
            calmer = []
        out.append(state)
    return pd.Series(out, index=raw.index, dtype=object).where(raw.notna())

# FRED dates an observation by the period it describes, not when it was published
# (September CPI is dated Sep 1 but released mid-October). Shifting each series
# by a conservative publication lag keeps the regime history point-in-time,
# i.e. free of look-ahead bias when it is used for backtests.
RELEASE_LAG_DAYS = {"monthly": 45, "weekly": 7, "daily": 1}
SERIES_FREQUENCY = {"CPIAUCSL": "monthly", "CPILFESL": "monthly", "UNRATE": "monthly", "PAYEMS": "monthly", "ICSA": "weekly"}

RISK_WEIGHTS = {"trend": 0.30, "volatility": 0.25, "credit": 0.15, "labor": 0.15, "curve": 0.075, "inflation": 0.075}
# Macro stress flags. Credit uses Moody's Baa - 10Y Treasury (full history on FRED);
# 3.0% is ~85th percentile since 2000 (scripts/calibrate_phase2.py).
CREDIT_STRESS_LEVEL, CREDIT_STRESS_WIDENING = 3.0, 0.5  # spread %, 3-month change in pp
SAHM_TRIGGER = 0.5  # pp, the published Sahm-rule threshold
INFLATION_HOT = 3.0  # core CPI % y/y


def _published(series: pd.Series, series_id: str) -> pd.Series:
    lag = RELEASE_LAG_DAYS[SERIES_FREQUENCY.get(series_id, "daily")]
    shifted = series.dropna().copy()
    shifted.index = pd.DatetimeIndex(shifted.index) + pd.Timedelta(days=lag)
    return shifted


def macro_features(macro: pd.DataFrame) -> pd.DataFrame:
    """Derived macro indicators, each indexed by the date it became public."""
    if macro.empty:
        return pd.DataFrame()
    macro = macro.copy()
    macro.index = pd.DatetimeIndex(macro.index)

    def col(series_id: str) -> pd.Series:
        return macro[series_id].dropna() if series_id in macro else pd.Series(dtype=float)

    features: dict[str, pd.Series] = {}
    core = col("CPILFESL")
    features["core_cpi_yoy"] = _published(core.pct_change(12) * 100, "CPILFESL")
    features["cpi_yoy"] = _published(col("CPIAUCSL").pct_change(12) * 100, "CPIAUCSL")

    unrate = col("UNRATE")
    ma3 = unrate.rolling(3).mean()
    features["unemployment"] = _published(unrate, "UNRATE")
    # Sahm rule: 3-month average unemployment vs its low over the prior 12 months.
    features["sahm_gap"] = _published(ma3 - ma3.shift(1).rolling(12).min(), "UNRATE")

    features["curve_10y2y"] = _published(col("T10Y2Y"), "T10Y2Y")
    features["treasury_10y"] = _published(col("DGS10"), "DGS10")
    features["fed_funds"] = _published(col("DFF"), "DFF")
    hy = col("BAMLH0A0HYM2")
    baa = col("BAA10Y")
    features["credit_spread"] = _published(baa, "BAA10Y")
    features["credit_spread_3m_change"] = _published(baa - baa.shift(63), "BAA10Y")
    features["hy_spread"] = _published(hy, "BAMLH0A0HYM2")
    features["hy_spread_3m_change"] = _published(hy - hy.shift(63), "BAMLH0A0HYM2")
    features["jobless_claims_4wk"] = _published(col("ICSA").rolling(4).mean(), "ICSA")

    return pd.concat({k: v for k, v in features.items() if not v.empty}, axis=1, sort=True)


def _align(frame: pd.DataFrame | pd.Series, index: pd.DatetimeIndex):
    """Forward-fill a lower-frequency frame onto trading days."""
    if frame.empty:
        return frame.reindex(index)
    return frame.reindex(frame.index.union(index)).ffill().reindex(index)


def classify_regimes(
    close: pd.Series, sma_50: pd.Series, sma_200: pd.Series, vix: pd.Series, params: RegimeParams = REGIME_PARAMS
) -> pd.DataFrame:
    """Vectorised trend / volatility / regime labels for every day.

    Trend: Bull when the 50-day is clearly above the 200-day and price is above
    the 200-day (golden-cross alignment); Bear for the mirror image, or when
    price is under the 200-day and 20%+ below its 52-week high; else Sideways.
    """
    p = params
    spread = sma_50 / sma_200 - 1
    drawdown = close / close.rolling(TRADING_DAYS, min_periods=1).max() - 1
    bear = ((spread < -p.sideways_band) | (drawdown <= -p.bear_drawdown)) & (close < sma_200)
    trend = pd.Series(
        np.select([bear, (spread > p.sideways_band) & (close > sma_200)], ["Bear", "Bull"], default="Sideways"),
        index=close.index,
        dtype=object,
    ).where(sma_200.notna())
    trend = _sticky(trend, TREND_RISK, p.trend_confirm_days)

    volatility = pd.Series(
        np.select([vix >= p.vix_volatile, vix < p.vix_calm], ["Volatile", "Calm"], default="Normal"),
        index=close.index,
        dtype=object,
    ).where(vix.notna())
    volatility = _sticky(volatility, VOL_RISK, p.vol_confirm_days)

    suffix = np.where(volatility == "Volatile", " Volatile", np.where(trend == "Sideways", "", " Trending"))
    regime = (trend.fillna("") + pd.Series(suffix, index=close.index)).where(trend.notna() & volatility.notna())
    return pd.DataFrame({"spread_50_200": spread, "drawdown_52w": drawdown, "trend": trend,
                         "volatility": volatility, "regime": regime})


def market_regime_history(
    benchmark: pd.DataFrame, vix: pd.Series, macro: pd.DataFrame, params: RegimeParams = REGIME_PARAMS
) -> pd.DataFrame:
    """Daily regime table: labels, macro features, stress flags and a 0-1 risk score.

    ``benchmark`` needs close / sma_50 / sma_200 columns (see add_indicators);
    ``macro`` is the wide FRED frame from load_macro().
    """
    index = pd.DatetimeIndex(benchmark.index)
    vix = _align(vix, index)
    out = pd.DataFrame({"close": benchmark["close"], "sma_50": benchmark["sma_50"],
                        "sma_200": benchmark["sma_200"], "vix": vix}, index=index)
    out = out.join(classify_regimes(out.close, out.sma_50, out.sma_200, out.vix, params))
    out = out.join(_align(macro_features(macro), index))

    def feature(name: str) -> pd.Series:
        return out[name] if name in out else pd.Series(np.nan, index=index)

    def flag(cond: pd.Series, source: str) -> pd.Series:
        # nullable boolean: <NA> (unknown) wherever the underlying data is missing
        return cond.astype("boolean").where(feature(source).notna())

    out["curve_inverted"] = flag(feature("curve_10y2y") < 0, "curve_10y2y")
    out["sahm_triggered"] = flag(feature("sahm_gap") >= SAHM_TRIGGER, "sahm_gap")
    out["credit_stress"] = flag(
        (feature("credit_spread") >= CREDIT_STRESS_LEVEL)
        | (feature("credit_spread_3m_change") >= CREDIT_STRESS_WIDENING),
        "credit_spread",
    )
    out["inflation_hot"] = flag(feature("core_cpi_yoy") >= INFLATION_HOT, "core_cpi_yoy")

    components = pd.DataFrame(
        {
            "trend": out.trend.map({"Bull": 0.0, "Sideways": 0.5, "Bear": 1.0}),
            "volatility": out.volatility.map({"Calm": 0.0, "Normal": 0.4, "Volatile": 1.0}),
            "credit": out.credit_stress.astype("Float64"),
            "labor": out.sahm_triggered.astype("Float64"),
            "curve": out.curve_inverted.astype("Float64"),
            "inflation": out.inflation_hot.astype("Float64"),
        },
        index=index,
    ).astype(float)
    weights = pd.Series(RISK_WEIGHTS)
    known = components.notna()
    out["risk_score"] = (components.fillna(0) * weights).sum(axis=1) / (known * weights).sum(axis=1).replace(0, np.nan)
    stance = pd.Series(
        np.select([out.risk_score < 0.33, out.risk_score > 0.6], ["Risk-On", "Risk-Off"], default="Neutral"),
        index=index, dtype=object,
    ).where(out.risk_score.notna())
    out["stance"] = _sticky(stance, STANCE_RISK, params.stance_confirm_days)
    return out


@dataclass
class MarketRegime:
    as_of: date
    label: str  # e.g. "Bull Trending", "Bull Volatile", "Bear Trending", "Sideways"
    trend: str  # Bull | Bear | Sideways
    volatility: str  # Calm | Normal | Volatile
    stance: str  # Risk-On | Neutral | Risk-Off
    risk_score: float  # 0 = benign ... 1 = stressed
    benchmark: str
    close: float
    sma_50: float
    sma_200: float
    vix: float | None
    macro: dict[str, float | None]
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


MACRO_SNAPSHOT = ("treasury_10y", "fed_funds", "curve_10y2y", "core_cpi_yoy", "cpi_yoy", "unemployment",
                  "sahm_gap", "jobless_claims_4wk", "credit_spread", "credit_spread_3m_change", "hy_spread")


def _regime_reasons(row: pd.Series, name: str) -> list[str]:
    def known(key: str) -> bool:
        return key in row and pd.notna(row[key])

    reasons = [
        f"{name} 50-day MA {row.spread_50_200:+.1%} vs 200-day "
        f"({'golden' if row.spread_50_200 > 0 else 'death'}-cross alignment); "
        f"price {'above' if row.close > row.sma_200 else 'below'} the 200-day, "
        f"{row.drawdown_52w:.1%} from its 52-week high",
        f"VIX {row.vix:.1f}: {row.volatility.lower()} volatility",
    ]
    if known("curve_10y2y"):
        reasons.append(f"10Y-2Y Treasury curve {row.curve_10y2y:+.2f}pp" + (" (inverted)" if row.curve_10y2y < 0 else ""))
    if known("sahm_gap"):
        reasons.append(f"Sahm-rule gap {row.sahm_gap:+.2f}pp" + (" - recession signal" if row.sahm_gap >= SAHM_TRIGGER else ""))
    if known("credit_spread"):
        change = f", {row.credit_spread_3m_change:+.2f}pp over 3 months" if known("credit_spread_3m_change") else ""
        hy = f" (high-yield OAS {row.hy_spread:.2f}%)" if known("hy_spread") else ""
        stressed = pd.notna(row.credit_stress) and bool(row.credit_stress)
        reasons.append(f"Baa credit spread {row.credit_spread:.2f}%{change}{hy}" + (" - credit stress" if stressed else ""))
    if known("core_cpi_yoy"):
        reasons.append(f"Core CPI {row.core_cpi_yoy:.1f}% y/y" + (" - running hot" if row.core_cpi_yoy >= INFLATION_HOT else ""))
    return reasons


def current_regime(history: pd.DataFrame, benchmark: str = "^GSPC") -> MarketRegime:
    row = history.dropna(subset=["regime"]).iloc[-1]
    return MarketRegime(
        as_of=pd.Timestamp(row.name).date(),
        label=row.regime,
        trend=row.trend,
        volatility=row.volatility,
        stance=row.stance,
        risk_score=round(float(row.risk_score), 3),
        benchmark=benchmark,
        close=float(row.close),
        sma_50=float(row.sma_50),
        sma_200=float(row.sma_200),
        vix=float(row.vix) if pd.notna(row.vix) else None,
        macro={k: (round(float(row[k]), 3) if k in row and pd.notna(row[k]) else None) for k in MACRO_SNAPSHOT},
        reasons=_regime_reasons(row, BENCHMARK_NAMES.get(benchmark, benchmark)),
    )


def market_regime_for(
    session: Session, benchmark: str = "^GSPC", vix_ticker: str = "^VIX"
) -> tuple[MarketRegime, pd.DataFrame]:
    """Current regime plus its full daily history, from stored data."""
    bars = load_bars(session, benchmark, "1d")
    if bars.empty and benchmark != "SPY":
        benchmark, bars = "SPY", load_bars(session, "SPY", "1d")
    if bars.empty:
        raise LookupError("no benchmark bars stored; run the Phase 1 pipeline first")

    macro = load_macro(session)
    vix = load_bars(session, vix_ticker, "1d")["close"]
    if vix.empty and "VIXCLS" in macro:  # fall back to FRED's copy of the VIX
        vix = macro["VIXCLS"].dropna()
        vix.index = pd.DatetimeIndex(vix.index)

    history = market_regime_history(add_indicators(bars), vix, macro)
    return current_regime(history, benchmark), history


# =============================================================================
# 3. Chart-to-news anomaly correlation
# =============================================================================

ANOMALY_RULES = {
    # flag a move if |return| >= abs_move, or if it is a z-sigma move of at least min_move
    # Tuned against SEC 8-K earnings dates, 2016-2026 (scripts/calibrate_phase2.py anomalies):
    # ~9 flags per stock per year; an absolute 5% rule flooded volatile names (TSLA 34/yr).
    "daily": {"abs_move": 0.08, "z": 3.0, "min_move": 0.02, "vol_window": 60},
    # intraday: opening bars (overnight gap) are scored against previous opens only
    # 1.25% (not 1%): routine 1% bars flooded high-beta names (TSLA 16 flags in 30 sessions -> 3).
    "intraday": {"abs_move": 0.03, "z": 4.0, "min_move": 0.0125, "vol_window": 130, "open_window": 20},
}
# How far outside the move window a headline may fall and still count.
NEWS_PRE_BUFFER = timedelta(hours=2)
NEWS_POST_BUFFER = {"daily": timedelta(hours=18), "intraday": timedelta(hours=6)}
MIN_RELEVANCE = 0.4  # headline must name the company (lists / roundups allowed, ranked lower)


def _is_intraday(interval: str) -> bool:
    return interval not in {"1d", "1wk", "1mo"}


def _interval_minutes(interval: str) -> int:
    value, unit = int(re.match(r"\d+", interval).group()), interval[-1]
    return value * 60 if unit == "h" else value


def _session_closes_utc(days: pd.DatetimeIndex) -> pd.DatetimeIndex:
    local = (days.normalize() + pd.Timedelta(hours=SESSION_CLOSE_HOUR)).tz_localize(EXCHANGE_TZ)
    return local.tz_convert("UTC").tz_localize(None)


def _robust_sigma(ret: pd.Series, window: int) -> pd.Series:
    """1.4826 x rolling median absolute deviation, lagged one bar to exclude the move itself.
    Unlike a rolling std, one crash day doesn't inflate it and mask the aftershocks."""
    mad = ret.rolling(window, min_periods=window // 2).apply(
        lambda x: np.median(np.abs(x - np.median(x))), raw=True
    )
    return (1.4826 * mad).shift(1)


def detect_anomalies(bars: pd.DataFrame, interval: str = "1d", **overrides) -> pd.DataFrame:
    """Flag abnormal price moves and the UTC window in which each move happened.

    Daily: close-to-close return, window = previous session close -> this close
    (so after-hours earnings and pre-market news fall inside it).
    Intraday: bar-to-bar return, window = previous bar's end -> this bar's end.
    """
    kind = "intraday" if _is_intraday(interval) else "daily"
    rules = {**ANOMALY_RULES[kind], **overrides}
    if len(bars) < 3:
        return pd.DataFrame(columns=["return", "zscore", "volume_ratio", "window_start", "window_end"])

    price = bars["adj_close"] if kind == "daily" and "adj_close" in bars else bars["close"]
    ret = price.astype(float).pct_change()
    index = pd.DatetimeIndex(bars.index)
    if kind == "daily":
        sigma = _robust_sigma(ret, rules["vol_window"])
    else:
        # The first bar of a session carries the overnight gap, so it gets its own scale.
        bar = pd.Timedelta(minutes=_interval_minutes(interval))
        session_open = pd.Series(index, index=index).diff() > bar
        sigma = pd.concat([
            _robust_sigma(ret[session_open], rules["open_window"]),
            _robust_sigma(ret[~session_open], rules["vol_window"]),
        ]).reindex(index)
    zscore = ret / sigma
    volume = bars["volume"].astype(float)
    volume_ratio = (volume / volume.rolling(20, min_periods=5).mean().shift(1)).replace([np.inf, -np.inf], np.nan)

    if kind == "daily":
        window_end = pd.Series(_session_closes_utc(index), index=index)
    else:
        window_end = pd.Series(index + pd.Timedelta(minutes=_interval_minutes(interval)), index=index)
    window_start = window_end.shift(1)

    flagged = (ret.abs() >= rules["abs_move"]) | ((zscore.abs() >= rules["z"]) & (ret.abs() >= rules["min_move"]))
    frame = pd.DataFrame(
        {"return": ret, "zscore": zscore, "volume_ratio": volume_ratio,
         "window_start": window_start, "window_end": window_end},
        index=index,
    )
    return frame[flagged & ret.notna() & window_start.notna()]


def estimate_beta(stock_returns: pd.Series, market_returns: pd.Series, window: int = TRADING_DAYS) -> float:
    joined = pd.concat([stock_returns, market_returns], axis=1, join="inner").dropna().tail(window)
    if len(joined) < 30 or joined.iloc[:, 1].var() == 0:
        return 1.0
    return float(joined.cov().iloc[0, 1] / joined.iloc[:, 1].var())


@dataclass
class NewsMatch:
    article_id: int
    title: str
    publisher: str | None
    url: str
    published_at: datetime
    scope: str  # "ticker" or "market"
    relevance: float
    sentiment_label: str | None
    sentiment_score: float | None
    timing: str  # "before" | "during" | "after" the move
    score: float


@dataclass
class Anomaly:
    ticker: str
    interval: str
    timestamp: datetime  # session date (daily) or bar start in UTC (intraday)
    window_start: datetime
    window_end: datetime
    return_pct: float
    zscore: float | None
    volume_ratio: float | None
    direction: str  # "spike" | "drop"
    market_return: float | None
    beta: float
    excess_return: float | None
    driver: str  # "market" | "idiosyncratic" | "unknown"
    matches: list[NewsMatch] = field(default_factory=list)
    explanation: str = ""


def _sentiment_agreement(score: float | None, move: float) -> float:
    """1.0 for strong sentiment in the direction of the move, 0.7 neutral/unknown, 0.4 strongly opposite."""
    if score is None or pd.isna(score):
        return 0.7
    return 0.7 + 0.3 * float(score) * float(np.sign(move))


def _timing_weight(published: datetime, start: datetime, end: datetime) -> tuple[str, float]:
    if published < start:
        return "before", math.exp(-(start - published).total_seconds() / 3600 / 6)
    if published <= end:
        return "during", 1.0
    return "after", 0.6 * math.exp(-(published - end).total_seconds() / 3600 / 12)


def match_news(
    anomaly: Anomaly,
    articles: pd.DataFrame,
    aliases: tuple[str, ...],
    post_buffer: timedelta,
    max_matches: int = 3,
    min_relevance: float = MIN_RELEVANCE,
    source_firm: bool = False,
) -> list[NewsMatch]:
    """Rank headlines that could explain one anomaly.

    score = relevance x timing weight x sentiment agreement. Ticker-tagged news
    must name the company in its headline (relevance filter); market-wide news
    counts if it names the company, or - for market-driven moves - as context.
    """
    if articles.empty:
        return []
    lo, hi = anomaly.window_start - NEWS_PRE_BUFFER, anomaly.window_end + post_buffer
    window = articles[(articles.published_at >= lo) & (articles.published_at <= hi)]

    candidates: dict[str, NewsMatch] = {}
    for art in window.itertuples(index=False):
        is_market = art.ticker is None or pd.isna(art.ticker)
        if not is_market and pd.notna(art.relevance):
            relevance = float(art.relevance)
        else:
            relevance = relevance_score(art.title, art.summary, anomaly.ticker, aliases, source_firm)
        if is_market and relevance < min_relevance and anomaly.driver == "market":
            relevance = 0.5  # market headline explaining a market-wide move
        if relevance < min_relevance:
            continue

        timing, weight = _timing_weight(art.published_at, anomaly.window_start, anomaly.window_end)
        sentiment = None if pd.isna(art.sentiment_score) else float(art.sentiment_score)
        score = relevance * weight * _sentiment_agreement(sentiment, anomaly.return_pct)
        key = re.sub(r"\W+", " ", art.title.lower()).strip()  # same story via several feeds
        if key in candidates and candidates[key].score >= score:
            continue
        candidates[key] = NewsMatch(
            article_id=int(art.id), title=art.title, publisher=art.publisher, url=art.url,
            published_at=art.published_at, scope="market" if is_market else "ticker",
            relevance=relevance, sentiment_label=art.sentiment_label, sentiment_score=sentiment,
            timing=timing, score=round(score, 4),
        )
    return sorted(candidates.values(), key=lambda m: m.score, reverse=True)[:max_matches]


def _format_when(anomaly: Anomaly) -> str:
    if _is_intraday(anomaly.interval):
        local = pd.Timestamp(anomaly.timestamp).tz_localize("UTC").tz_convert(EXCHANGE_TZ)
        if (local.hour, local.minute) == (9, 30):  # first bar: includes the overnight gap
            return f"at the {local:%Y-%m-%d} open"
        return f"at {local:%Y-%m-%d %H:%M} ET"
    return f"on {anomaly.timestamp:%Y-%m-%d}"


def explain(anomaly: Anomaly, coverage_start: datetime | None) -> str:
    verb = "jumped" if anomaly.return_pct > 0 else "fell"
    text = f"{anomaly.ticker} {verb} {abs(anomaly.return_pct):.1%} {_format_when(anomaly)}"
    if anomaly.driver == "market":
        text += f", mostly market-driven (market {anomaly.market_return:+.1%}, beta {anomaly.beta:.2f})"
    elif anomaly.driver == "idiosyncratic":
        text += f", stock-specific ({anomaly.excess_return:+.1%} beyond what the market explains)"

    if anomaly.matches:
        top = anomaly.matches[0]
        sentiment = (f", FinBERT {top.sentiment_label} {top.sentiment_score:+.2f}"
                     if top.sentiment_score is not None else "")
        return f'{text}. Likely catalyst: "{top.title}" ({top.publisher or top.scope}, {top.timing} the move{sentiment}).'
    if coverage_start is None or anomaly.window_end < coverage_start:
        start = f" (news archive starts {coverage_start:%Y-%m-%d})" if coverage_start else ""
        return f"{text}. No news archived for this period yet{start}."
    return f"{text}. No on-topic headline found in the news window."


def load_articles(session: Session, ticker: str, start: datetime, end: datetime) -> pd.DataFrame:
    """Ticker-tagged plus market-wide headlines published in [start, end]."""
    cols = [NewsArticle.id, NewsArticle.ticker, NewsArticle.title, NewsArticle.summary, NewsArticle.publisher,
            NewsArticle.url, NewsArticle.published_at, NewsArticle.relevance, NewsArticle.sentiment_label,
            NewsArticle.sentiment_score]
    stmt = select(*cols).where(
        or_(NewsArticle.ticker == ticker, NewsArticle.ticker.is_(None)),
        NewsArticle.published_at >= start,
        NewsArticle.published_at <= end,
    )
    df = pd.DataFrame(session.execute(stmt).all(), columns=[c.key for c in cols])
    # pandas 3 stores missing text as NaN; keep None so "x or default" logic works.
    for col in ("ticker", "summary", "publisher", "url", "sentiment_label"):
        df[col] = df[col].astype(object).where(df[col].notna(), None)
    return df


def explain_anomalies(
    session: Session,
    ticker: str,
    interval: str = "1d",
    since: datetime | None = None,
    benchmark: str = "SPY",
    max_matches: int = 3,
    min_relevance: float = MIN_RELEVANCE,
) -> list[Anomaly]:
    """Detect anomalies on a ticker's chart and attach the headlines that explain them."""
    kind = "intraday" if _is_intraday(interval) else "daily"
    bars = load_bars(session, ticker, interval)
    flagged = detect_anomalies(bars, interval)
    if since is not None:
        flagged = flagged[flagged.index >= pd.Timestamp(since)]
    if flagged.empty:
        return []

    # Market comparison: beta from daily returns, market move from the same bar.
    daily_stock = load_bars(session, ticker, "1d")["adj_close"].pct_change()
    daily_market = load_bars(session, benchmark, "1d")["adj_close"].pct_change()
    beta = estimate_beta(daily_stock, daily_market)
    bench = load_bars(session, benchmark, interval)
    market_ret = (bench["adj_close"] if kind == "daily" else bench["close"]).pct_change()

    post_buffer = NEWS_POST_BUFFER[kind]
    articles = load_articles(
        session, ticker,
        flagged.window_start.min().to_pydatetime() - NEWS_PRE_BUFFER,
        flagged.window_end.max().to_pydatetime() + post_buffer,
    )
    aliases = company_aliases(session, [ticker])[ticker]
    source_firm = ticker in research_firms(session, [ticker])
    coverage_start = session.scalar(
        select(func.min(NewsArticle.published_at)).where(
            or_(NewsArticle.ticker == ticker, NewsArticle.ticker.is_(None))
        )
    )

    anomalies = []
    for ts, row in flagged.iterrows():
        mkt = market_ret.get(ts)
        mkt = None if mkt is None or pd.isna(mkt) else float(mkt)
        expected = beta * mkt if mkt is not None else None
        if expected is None:
            driver, excess = "unknown", None
        else:
            excess = float(row["return"] - expected)
            same_sign = np.sign(expected) == np.sign(row["return"])
            driver = "market" if same_sign and abs(expected) >= 0.5 * abs(row["return"]) else "idiosyncratic"

        anomaly = Anomaly(
            ticker=ticker, interval=interval, timestamp=pd.Timestamp(ts).to_pydatetime(),
            window_start=row.window_start.to_pydatetime(), window_end=row.window_end.to_pydatetime(),
            return_pct=float(row["return"]),
            zscore=None if pd.isna(row.zscore) else float(row.zscore),
            volume_ratio=None if pd.isna(row.volume_ratio) else float(row.volume_ratio),
            direction="spike" if row["return"] > 0 else "drop",
            market_return=mkt, beta=round(beta, 3), excess_return=excess, driver=driver,
        )
        anomaly.matches = match_news(anomaly, articles, aliases, post_buffer, max_matches, min_relevance, source_firm)
        anomaly.explanation = explain(anomaly, coverage_start)
        anomalies.append(anomaly)
    return anomalies


def anomalies_frame(anomalies: list[Anomaly]) -> pd.DataFrame:
    """Flat table (one row per anomaly, top headline only) for dashboards."""
    rows = []
    for a in anomalies:
        top = a.matches[0] if a.matches else None
        rows.append({
            "timestamp": a.timestamp, "return": a.return_pct, "zscore": a.zscore, "volume_ratio": a.volume_ratio,
            "driver": a.driver, "market_return": a.market_return, "headline": top.title if top else None,
            "headline_url": top.url if top else None, "headline_sentiment": top.sentiment_score if top else None,
            "explanation": a.explanation,
        })
    return pd.DataFrame(rows)


# =============================================================================
# CLI
# =============================================================================

def _print_regime(regime: MarketRegime) -> None:
    print(f"\nMARKET REGIME ({regime.as_of}): {regime.label}  |  {regime.stance}  |  risk score {regime.risk_score:.2f}")
    for reason in regime.reasons:
        print(f"  - {reason}")


def _print_ticker(session: Session, ticker: str, interval: str, days: int) -> None:
    snap = indicator_snapshot(indicators_for(session, ticker))
    print(f"\n{ticker}  close {snap['close']:.2f} ({snap['date']})")
    for reading in snap["readings"]:
        print(f"  - {reading}")
    if snap["last_cross"]:
        c = snap["last_cross"]
        print(f"  - last {c['type']} cross: {c['date']} ({c['sessions_ago']} sessions ago)")

    since = datetime.now() - timedelta(days=days)
    anomalies = explain_anomalies(session, ticker, interval, since=since)
    print(f"  Anomalies ({interval}, last {days} days): {len(anomalies) or 'none'}")
    for a in anomalies:
        print(f"    * {a.explanation}")
        for m in a.matches[1:]:
            print(f"        also: \"{m.title}\" ({m.publisher or m.scope}, {m.timing}, score {m.score:.2f})")


def main(argv: list[str] | None = None) -> int:
    from quant.db import init_db, session_scope

    parser = argparse.ArgumentParser(description="Market regime, indicators and explained chart anomalies.")
    parser.add_argument("tickers", nargs="*", help="tickers to analyse (omit for regime only)")
    parser.add_argument("--interval", default="1d", help="bar interval for anomaly detection (1d or 15m)")
    parser.add_argument("--days", type=int, default=None, help="anomaly lookback in days (default 90 daily / 30 intraday)")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # headlines contain characters some consoles can't print

    days = args.days or (30 if _is_intraday(args.interval) else 90)
    with session_scope(init_db()) as session:
        regime, _ = market_regime_for(session)
        _print_regime(regime)
        for ticker in args.tickers:
            _print_ticker(session, ticker.upper(), args.interval, days)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
