"""Phase 4: the autonomous paper-trading bot.

    python -m quant.trading_bot signals            # today's BUY / SELL / HOLD with rationales (no trading)
    python -m quant.trading_bot run                # process the latest session(s) for the "paper" portfolio
    python -m quant.trading_bot status             # positions, P&L, win rate, recent trades
    python -m quant.trading_bot backtest --save    # walk-forward test of the same rules
    python -m quant.trading_bot backtest --universe sp500   # ... on point-in-time S&P 500 members

Daily cycle, after the close and once the pipeline has ingested the session:
  1. Stops: a position whose stop was touched during the session is sold at the
     stop, or at the open if the stock gapped below it.
  2. Trailing stops ratchet up to (highest close - k x ATR); they never move down.
  3. Signals: four components in [-1, 1] are blended into a score:
       trend         50/200-day MA alignment (60%) + 12-1 momentum rank (40%)
       fundamentals  SEC quality pillar (60%) + latest-quarter earnings growth (40%);
                     a loss or negative operating cash flow caps it at -0.5
       valuation     Fama-French-style value pillar (75%) + FF3 alpha t-stat (25%)
       sentiment     recency-weighted FinBERT score of on-topic headlines (7 days)
  4. Exits on a SELL signal or a broken trend (50 < 200-day and price < 200-day).
  5. Entries on BUY signals (score >= threshold *and* an up-trend), best first,
     unless the market regime is Bear.
  6. Sizing: volatility parity (or Kelly-scaled volatility parity once the bot has
     enough closed trades), capped per position and scaled to the regime's gross
     exposure. Positions are only resized when off target by more than the band.

Every fill is logged with a plain-English rationale and the full signal.
Simulation conventions: market-on-close fills with 5 bps slippage, whole shares,
long only, no leverage; news counts only up to the close. Paper trading for
research, not investment advice.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import asdict, dataclass, field, replace
from datetime import date

import numpy as np
import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from quant import analytics as an
from quant import quant_models as qm
from quant.ingestion.market_data import load_bars, load_daily_bars
from quant.ingestion.relevance import RELEVANCE_THRESHOLD
from quant.models import NewsArticle, Portfolio, PortfolioSnapshot, Position, SignalRecord, Trade, utcnow

log = logging.getLogger(__name__)

LIVE, BACKTEST = "paper", "backtest"
COMPONENTS = ("trend", "fundamentals", "valuation", "sentiment")


@dataclass(frozen=True)
class BotParams:
    initial_cash: float = 100_000.0
    # signal blend
    w_trend: float = 0.35
    w_fundamentals: float = 0.25
    w_valuation: float = 0.20
    w_sentiment: float = 0.20
    buy_threshold: float = 0.25
    sell_threshold: float = -0.10
    # sentiment
    sentiment_days: int = 7
    sentiment_half_life: float = 2.0  # days
    sentiment_min_headlines: int = 2
    # portfolio construction
    max_positions: int = 6
    max_weight: float = 0.20
    sizing: str = "vol_parity"  # or "kelly"
    kelly_fraction: float = 0.5  # half Kelly
    kelly_min_trades: int = 20
    vol_window: int = 60
    rebalance_band: float = 0.03  # resize only when 3+ points of equity off target
    exposure: tuple[tuple[str, float], ...] = (("Risk-On", 1.0), ("Neutral", 0.7), ("Risk-Off", 0.35))
    block_longs_in_bear: bool = True
    # Opt-in entry guards for fast drawdowns (off by default; Phase 6 tested them on the S&P 500):
    # regime labels (trend, volatility or stance, e.g. "Volatile", "Risk-Off") that block new buys,
    block_entries_when: tuple[str, ...] = ()
    # new buys only above the stock's own 50-day MA,
    entry_above_sma50: bool = False
    # no new buys after this many stop-outs within the last cooldown_window sessions (0 = off).
    cooldown_stops: int = 0
    cooldown_window: int = 10
    # stops
    # 3.5 x ATR(14): 2.5x churned 450 round trips in 2018-2026 (median hold 15 days) for no better
    # return; 3.5x cut that to 292 with similar CAGR and a smaller drawdown.
    atr_multiple: float = 3.5
    max_loss: float = 0.15
    # execution
    slippage_bps: float = 5.0
    factor_lag_days: int = 45  # French factors are published 1-2 months late

    def weight(self, component: str) -> float:
        return getattr(self, f"w_{component}")

    def gross_exposure(self, stance: str | None) -> float:
        return dict(self.exposure).get(stance or "Neutral", 0.7)


# =============================================================================
# Point-in-time market context
# =============================================================================

@dataclass
class MarketContext:
    universe: qm.Universe
    bars: dict[str, pd.DataFrame]  # daily OHLC + indicators per ticker
    regime: pd.DataFrame  # analytics.market_regime_history
    news: pd.DataFrame  # on-topic, scored headlines: ticker, published_at, sentiment_score, title
    benchmark: pd.Series  # SPY adjusted close
    _cache: dict = field(default_factory=dict, repr=False)

    @property
    def sessions(self) -> pd.DatetimeIndex:
        return self.universe.close.index

    def bar(self, ticker: str, when: pd.Timestamp) -> pd.Series | None:
        df = self.bars.get(ticker)
        if df is None or when not in df.index:
            return None
        return df.loc[when]

    def last_close(self, ticker: str, when: pd.Timestamp) -> float | None:
        df = self.bars.get(ticker)
        if df is None:
            return None
        closes = df["close"].loc[:when].dropna()
        return float(closes.iloc[-1]) if len(closes) else None

    def news_for(self, ticker: str) -> pd.DataFrame:
        """This ticker's headlines (grouped once: the S&P 500 universe has hundreds of tickers)."""
        if "news" not in self._cache:
            self._cache["news"] = dict(tuple(self.news.groupby("ticker")))
        return self._cache["news"].get(ticker, self.news.iloc[0:0])

    def scores(self, when: pd.Timestamp) -> pd.DataFrame:
        key = ("scores", when)
        if key not in self._cache:
            self._cache[key] = qm.factor_scores(self.universe, when)
        return self._cache[key]

    def alpha(self, ticker: str, when: pd.Timestamp, lag_days: int) -> tuple[float, float] | None:
        """FF3 alpha (annual) and t-stat from the 3 years of factor data public on ``when``."""
        key = ("alpha", ticker, when.to_period("M"))
        if key not in self._cache:
            try:
                e = qm.factor_regression(self.universe.returns[ticker], self.universe.factors,
                                         end=when - pd.Timedelta(days=lag_days), ticker=ticker)
                self._cache[key] = (e.alpha_annual, e.alpha_t)
            except (ValueError, KeyError):
                self._cache[key] = None
        return self._cache[key]


def load_context(session: Session, tickers: list[str], vol_window: int = 60, index: str | None = None) -> MarketContext:
    """Point-in-time inputs for ``tickers``, or for every past and present member of
    ``index`` ("sp500"), each tradable only while in the index."""
    u = qm.load_universe(session, tickers, index=index)
    daily = load_daily_bars(session, u.tickers)
    bars = {}
    for t in u.tickers:
        ind = an.add_indicators(daily[t])
        ind["vol"] = ind["return_1d"].rolling(vol_window).std() * math.sqrt(qm.TRADING_DAYS)
        bars[t] = ind
    _, regime = an.market_regime_for(session)
    rows = session.execute(
        select(NewsArticle.ticker, NewsArticle.published_at, NewsArticle.sentiment_score, NewsArticle.title).where(
            NewsArticle.ticker.in_(u.tickers),
            NewsArticle.relevance >= RELEVANCE_THRESHOLD,
            NewsArticle.sentiment_score.is_not(None),
        )
    ).all()
    news = pd.DataFrame(rows, columns=["ticker", "published_at", "sentiment_score", "title"])
    news["published_at"] = pd.to_datetime(news["published_at"])
    benchmark = load_bars(session, "SPY", "1d")["adj_close"]
    return MarketContext(universe=u, bars=bars, regime=regime, news=news, benchmark=benchmark)


def session_close_utc(when: pd.Timestamp) -> pd.Timestamp:
    return an._session_closes_utc(pd.DatetimeIndex([when]))[0]


# =============================================================================
# Signals
# =============================================================================

@dataclass
class Signal:
    ticker: str
    date: date
    action: str  # BUY | SELL | HOLD
    score: float
    components: dict[str, float]
    details: dict
    rationale: str  # full sentence for the signal log
    summary: str  # the key reasons, reused in trade rationales

    def to_json(self) -> str:
        return json.dumps({"score": self.score, "components": self.components, "details": self.details}, default=str)


def _clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return float(min(hi, max(lo, x)))


def _scaled_pillar(value) -> float:
    """0-100 percentile pillar -> [-1, 1] (50 = neutral; missing = neutral)."""
    return 0.0 if value is None or pd.isna(value) else (float(value) - 50.0) / 50.0


def trend_component(ind: pd.DataFrame, momentum_pillar) -> tuple[float, dict]:
    last = ind.iloc[-1]
    if pd.isna(last.sma_200):
        return 0.0, {"ma_alignment": 0.0, "note": "under 200 days of history"}
    spread = float(last.sma_50 / last.sma_200 - 1)
    above = bool(last.close > last.sma_200)
    ma = 1.0 if spread > 0 and above else -1.0 if spread < 0 and not above else 0.0
    crosses = ind[ind.golden_cross | ind.death_cross]
    cross = None
    if len(crosses):
        when = crosses.index[-1]
        cross = {"type": "golden" if crosses.golden_cross.iloc[-1] else "death", "date": when.date(),
                 "sessions_ago": int(len(ind.loc[when:]) - 1)}
    value = 0.6 * ma + 0.4 * _scaled_pillar(momentum_pillar)
    return _clip(value), {"ma_alignment": ma, "ma_spread": spread, "above_200": above,
                          "momentum_pillar": None if pd.isna(momentum_pillar) else float(momentum_pillar),
                          "last_cross": cross}


def earnings_growth(quarterly: pd.DataFrame) -> dict | None:
    """Latest quarter vs the same quarter a year earlier (the 'earnings report' signal)."""
    q = quarterly.dropna(subset=["net_income"]).reset_index(drop=True)
    if len(q) < 5:
        return None
    last, prior = q.iloc[-1], q.iloc[-5]
    gap = (last.report_date - prior.report_date).days
    if not 350 <= gap <= 380 or prior.net_income == 0:
        return None
    rev_yoy = (last.revenue / prior.revenue - 1) if prior.revenue and pd.notna(last.revenue) else None
    return {"period_end": last.report_date.date(), "form": last.form, "filed": last.available.date(),
            "net_income_yoy": float((last.net_income - prior.net_income) / abs(prior.net_income)),
            "revenue_yoy": None if rev_yoy is None else float(rev_yoy)}


def fundamentals_component(score_row: pd.Series | None, quarterly: pd.DataFrame) -> tuple[float, dict]:
    quality = None if score_row is None else score_row.get("quality")
    growth = earnings_growth(quarterly) if len(quarterly) else None
    q = _scaled_pillar(quality)
    value = 0.6 * q + 0.4 * _clip(growth["net_income_yoy"] / 0.5) if growth else q
    details = {"quality_pillar": None if quality is None or pd.isna(quality) else float(quality), "growth": growth}
    if score_row is not None:
        details.update(roe=score_row.get("roe"), leverage=score_row.get("leverage"))
        snap_ni, snap_ocf = score_row.get("earnings_yield"), score_row.get("cash_roa")
        if (pd.notna(snap_ni) and snap_ni <= 0) or (pd.notna(snap_ocf) and snap_ocf <= 0):
            details["health_flag"] = "loss-making or negative operating cash flow (TTM)"
            value = min(value, -0.5)
    return _clip(value), details


def valuation_component(score_row: pd.Series | None, alpha: tuple[float, float] | None) -> tuple[float, dict]:
    value_pillar = None if score_row is None else score_row.get("value")
    v = _scaled_pillar(value_pillar)
    a = _clip(alpha[1] / 3.0) if alpha else 0.0
    details = {"value_pillar": None if value_pillar is None or pd.isna(value_pillar) else float(value_pillar),
               "earnings_yield": None if score_row is None else score_row.get("earnings_yield"),
               "ff3_alpha": alpha[0] if alpha else None, "ff3_alpha_t": alpha[1] if alpha else None}
    return _clip(0.75 * v + 0.25 * a), details


def sentiment_component(news: pd.DataFrame, ticker: str, cutoff: pd.Timestamp, p: BotParams) -> tuple[float, dict]:
    start = cutoff - pd.Timedelta(days=p.sentiment_days)
    window = news[(news.ticker == ticker) & (news.published_at > start) & (news.published_at <= cutoff)]
    if len(window) < p.sentiment_min_headlines:
        return 0.0, {"headlines": int(len(window))}
    age = (cutoff - window.published_at).dt.total_seconds() / 86400
    w = 0.5 ** (age / p.sentiment_half_life)
    s = float((w * window.sentiment_score).sum() / w.sum())
    lead = window.loc[(w * window.sentiment_score.abs()).idxmax()]
    return _clip(s), {"headlines": int(len(window)), "finbert": s, "lead_headline": lead.title}


def _phrases(c: dict[str, float], d: dict) -> dict[str, str]:
    """One short phrase per component, for rationales."""
    out = {}
    t = d["trend"]
    cross = t.get("last_cross")
    if cross and cross["sessions_ago"] <= 30:
        out["trend"] = f"50 MA crossed {'above' if cross['type'] == 'golden' else 'below'} 200 MA on {cross['date']}"
    elif t.get("ma_alignment") == 1.0:
        out["trend"] = f"50 MA {t['ma_spread']:.1%} above 200 MA, price above 200 MA"
    elif t.get("ma_alignment") == -1.0:
        out["trend"] = f"50 MA {-t['ma_spread']:.1%} below 200 MA, price below 200 MA"
    else:
        out["trend"] = "mixed trend (MAs and price disagree)"
    if t.get("momentum_pillar") is not None:
        out["trend"] += f", momentum {t['momentum_pillar']:.0f}/100"

    f = d["fundamentals"]
    g = f.get("growth")
    parts = []
    if g:
        yoy = g["net_income_yoy"]
        tone = "positive" if yoy > 0.05 else "negative" if yoy < -0.05 else "flat"
        parts.append(f"{tone} SEC earnings report ({g['form']} for {g['period_end']}: net income {g['net_income_yoy']:+.0%} y/y)")
    if f.get("quality_pillar") is not None:
        parts.append(f"quality {f['quality_pillar']:.0f}/100")
    if f.get("health_flag"):
        parts.append(f["health_flag"])
    out["fundamentals"] = ", ".join(parts) or "no SEC data"

    v = d["valuation"]
    parts = []
    if v.get("value_pillar") is not None:
        ey = v.get("earnings_yield")
        parts.append(f"value {v['value_pillar']:.0f}/100" + (f" (E/P {ey:.1%})" if ey is not None and pd.notna(ey) else ""))
    if v.get("ff3_alpha") is not None:
        parts.append(f"FF3 alpha {v['ff3_alpha']:+.0%}/yr (t {v['ff3_alpha_t']:.1f})")
    out["valuation"] = ", ".join(parts) or "no valuation data"

    s = d["sentiment"]
    if "finbert" in s:
        mood = "bullish" if c["sentiment"] > 0.15 else "bearish" if c["sentiment"] < -0.15 else "neutral"
        out["sentiment"] = f"{mood} news sentiment (FinBERT {s['finbert']:+.2f}, {s['headlines']} headlines)"
    else:
        out["sentiment"] = f"too little news to score ({s['headlines']} headlines)"
    return out


def make_signal(ctx: MarketContext, ticker: str, when: pd.Timestamp, held: bool, regime: pd.Series,
                p: BotParams, cooldown: str = "") -> Signal | None:
    """``cooldown``: why new buys are paused for the whole book (see stop_cooldown), if they are."""
    ind = ctx.bars.get(ticker)
    if ind is None or when not in ind.index:
        return None
    ind = ind.loc[:when]
    scores = ctx.scores(when)
    row = scores.loc[ticker] if ticker in scores.index else None
    _, quarterly = ctx.universe.known_fundamentals(ticker, when)

    comps, details = {}, {}
    comps["trend"], details["trend"] = trend_component(ind, None if row is None else row.get("momentum"))
    comps["fundamentals"], details["fundamentals"] = fundamentals_component(row, quarterly)
    comps["valuation"], details["valuation"] = valuation_component(row, ctx.alpha(ticker, when, p.factor_lag_days))
    comps["sentiment"], details["sentiment"] = sentiment_component(ctx.news_for(ticker), ticker, session_close_utc(when), p)
    score = round(sum(p.weight(k) * comps[k] for k in COMPONENTS), 4)

    uptrend = details["trend"]["ma_alignment"] > 0
    broken = details["trend"]["ma_alignment"] < 0
    note = ""
    if held:
        action = "SELL" if broken or score <= p.sell_threshold else "HOLD"
        if broken:
            note = "trend broke"
    else:
        action = "BUY" if score >= p.buy_threshold and uptrend else "HOLD"
        labels = [regime.get(k) for k in ("trend", "volatility", "stance")]
        if action == "BUY" and p.block_longs_in_bear and regime.get("trend") == "Bear":
            action, note = "HOLD", "new buys blocked: Bear market regime"
        elif action == "BUY" and (blocked := [x for x in labels if x in p.block_entries_when]):
            action, note = "HOLD", f"new buys blocked: {' / '.join(blocked)} market regime"
        elif action == "BUY" and p.entry_above_sma50 and not ind.close.iloc[-1] > ind.sma_50.iloc[-1]:
            action, note = "HOLD", "new buys blocked: price below its 50-day MA"
        elif action == "BUY" and cooldown:
            action, note = "HOLD", f"new buys blocked: {cooldown}"

    phrases = _phrases(comps, details)
    # Lead with the reasons pointing the same way as the action.
    direction = {"BUY": 1, "SELL": -1}.get(action, 1 if score >= 0 else -1)
    ordered = sorted(COMPONENTS, key=lambda k: -direction * p.weight(k) * comps[k])
    summary = "; ".join(phrases[k] for k in ordered)
    verb = {"BUY": "Buy", "SELL": "Sell", "HOLD": "Hold"}[action]
    rationale = (f"{verb} {ticker} (score {score:+.2f}{', ' + note if note else ''}): {summary}. "
                 f"Regime {regime.get('regime')} / {regime.get('stance')}.")
    details["note"] = note
    return Signal(ticker, when.date(), action, score, {k: round(v, 4) for k, v in comps.items()}, details, rationale, summary)


# =============================================================================
# Sizing and stops
# =============================================================================

def kelly_stats(position_returns: list[float], min_trades: int = 20) -> dict | None:
    """Kelly fraction f = W - (1 - W) / R from closed round trips (W win rate, R payoff ratio)."""
    r = [x for x in position_returns if x is not None and not np.isnan(x)]
    wins, losses = [x for x in r if x > 0], [x for x in r if x <= 0]
    if len(r) < min_trades or not wins or not losses:
        return None
    win_rate = len(wins) / len(r)
    payoff = float(np.mean(wins) / abs(np.mean(losses)))
    return {"trades": len(r), "win_rate": win_rate, "payoff": payoff,
            "kelly": max(0.0, win_rate - (1 - win_rate) / payoff)}


def size_positions(vols: dict[str, float], gross: float, p: BotParams, kelly: dict | None = None) -> tuple[dict[str, float], str]:
    """Target weights for the chosen names.

    vol_parity: weights proportional to 1/volatility, summing to the gross exposure.
    kelly: fractional Kelly sets the weight of a median-volatility position; others
    are scaled by median_vol / vol. Both are capped per name and in total.
    """
    if not vols:
        return {}, "no positions"
    fallback = float(np.nanmedian(list(vols.values()))) if any(np.isfinite(v) for v in vols.values()) else 0.3
    vols = {t: (v if np.isfinite(v) and v > 0 else fallback) for t, v in vols.items()}
    if p.sizing == "kelly" and kelly and kelly["kelly"] > 0:
        base = p.kelly_fraction * kelly["kelly"]
        median = float(np.median(list(vols.values())))
        weights = {t: base * median / v for t, v in vols.items()}
        note = (f"{p.kelly_fraction:g}x Kelly: {base:.1%} for a median-volatility position "
                f"(win rate {kelly['win_rate']:.0%}, payoff {kelly['payoff']:.2f}, {kelly['trades']} trades)")
    else:
        inv = {t: 1.0 / v for t, v in vols.items()}
        total = sum(inv.values())
        weights = {t: gross * x / total for t, x in inv.items()}
        note = "volatility parity" + (" (Kelly needs more closed trades)" if p.sizing == "kelly" else "")
    weights = {t: min(w, p.max_weight) for t, w in weights.items()}
    total = sum(weights.values())
    if total > gross:
        weights = {t: w * gross / total for t, w in weights.items()}
    return weights, note


def initial_stop(close: float, atr: float, p: BotParams) -> float:
    """k x ATR below the entry, but never more than max_loss below it."""
    atr_stop = close - p.atr_multiple * atr if atr and np.isfinite(atr) else -np.inf
    return float(max(atr_stop, close * (1 - p.max_loss)))


# =============================================================================
# Paper broker
# =============================================================================

@dataclass
class Holding:
    ticker: str
    shares: float
    avg_cost: float
    entry_date: date
    entry_price: float
    stop: float
    highest_close: float
    realized_pnl: float = 0.0
    cost_invested: float = 0.0


@dataclass
class Fill:
    date: date
    ticker: str
    side: str
    shares: float
    price: float
    reason: str  # entry | add | trim | exit | stop
    rationale: str
    signal: str | None = None
    realized_pnl: float | None = None
    position_pnl: float | None = None
    position_return: float | None = None

    @property
    def value(self) -> float:
        return self.shares * self.price


@dataclass
class PortfolioState:
    cash: float
    holdings: dict[str, Holding] = field(default_factory=dict)
    stop_dates: list[date] = field(default_factory=list)  # one per stop-out, for the cool-down

    def market_value(self, ctx: MarketContext, when: pd.Timestamp) -> float:
        return sum(h.shares * (ctx.last_close(t, when) or h.avg_cost) for t, h in self.holdings.items())

    def equity(self, ctx: MarketContext, when: pd.Timestamp) -> float:
        return self.cash + self.market_value(ctx, when)


class PaperBroker:
    def __init__(self, state: PortfolioState, p: BotParams):
        self.state, self.p = state, p

    def buy(self, when: date, ticker: str, shares: int, ref_price: float, reason: str, rationale: str,
            signal: str | None, stop: float | None = None) -> Fill | None:
        price = ref_price * (1 + self.p.slippage_bps / 1e4)
        shares = int(min(shares, self.state.cash // price))
        if shares <= 0:
            return None
        cost = shares * price
        self.state.cash -= cost
        h = self.state.holdings.get(ticker)
        if h is None:
            h = Holding(ticker, 0.0, 0.0, when, price, stop if stop is not None else price * (1 - self.p.max_loss), ref_price)
            self.state.holdings[ticker] = h
        h.avg_cost = (h.avg_cost * h.shares + cost) / (h.shares + shares)
        h.shares += shares
        h.cost_invested += cost
        return Fill(when, ticker, "BUY", shares, price, reason, rationale, signal)

    def sell(self, when: date, ticker: str, shares: float, ref_price: float, reason: str, rationale: str,
             signal: str | None = None) -> Fill | None:
        h = self.state.holdings.get(ticker)
        if h is None or shares <= 0:
            return None
        shares = min(shares, h.shares)
        price = ref_price * (1 - self.p.slippage_bps / 1e4)
        pnl = (price - h.avg_cost) * shares
        self.state.cash += shares * price
        h.shares -= shares
        h.realized_pnl += pnl
        fill = Fill(when, ticker, "SELL", shares, price, reason, rationale, signal, realized_pnl=pnl)
        if h.shares <= 1e-9:
            fill.position_pnl = h.realized_pnl
            fill.position_return = h.realized_pnl / h.cost_invested if h.cost_invested else None
            del self.state.holdings[ticker]
        return fill


def stop_cooldown(state: PortfolioState, sessions: pd.DatetimeIndex, when: pd.Timestamp, p: BotParams) -> str:
    """Why new buys are paused, or "": ``cooldown_stops`` or more stop-outs in the last
    ``cooldown_window`` sessions (today included) usually mean a falling market."""
    if p.cooldown_stops <= 0:
        return ""
    since = sessions[max(0, sessions.get_loc(when) - p.cooldown_window + 1)].date()
    n = sum(d >= since for d in state.stop_dates)
    return f"cool-down after {n} stop-outs in {p.cooldown_window} sessions" if n >= p.cooldown_stops else ""


def apply_split(h: Holding, ratio: float) -> None:
    """A 10-for-1 split: 10x the shares, 1/10 the per-share prices."""
    h.shares *= ratio
    h.avg_cost /= ratio
    h.entry_price /= ratio
    h.stop /= ratio
    h.highest_close /= ratio


# =============================================================================
# The daily cycle
# =============================================================================

@dataclass
class DayResult:
    date: date
    fills: list[Fill]
    signals: list[Signal]
    cash: float
    holdings_value: float
    equity: float
    regime: str | None
    stance: str | None
    n_positions: int = 0
    sizing_note: str = ""


def run_day(state: PortfolioState, ctx: MarketContext, when: pd.Timestamp, p: BotParams,
            kelly: dict | None = None, trade: bool = True) -> DayResult:
    """One session: stops, trailing stops and (when ``trade``) signals, exits, entries, rebalancing."""
    broker = PaperBroker(state, p)
    day = when.date()
    fills: list[Fill] = []

    # 1. stops resting during the session
    for t, h in list(state.holdings.items()):
        bar = ctx.bar(t, when)
        if bar is None or bar.low > h.stop:
            continue
        price = min(float(bar.open), h.stop)
        kind = "trailing stop" if h.stop >= h.entry_price else "stop-loss"  # above entry = protecting profit
        loss = price / h.avg_cost - 1
        fills.append(broker.sell(
            day, t, h.shares, price, "stop",
            f"Sold {t}: {kind} at {h.stop:.2f} hit (low {bar.low:.2f}"
            f"{', gapped below it at the open' if bar.open < h.stop else ''}); {loss:+.1%} vs average cost."))
        state.stop_dates.append(day)

    # 2. trailing stops ratchet up
    for t, h in state.holdings.items():
        bar = ctx.bar(t, when)
        if bar is None:
            continue
        h.highest_close = max(h.highest_close, float(bar.close))
        if np.isfinite(bar.atr_14):
            h.stop = max(h.stop, h.highest_close - p.atr_multiple * float(bar.atr_14))

    # 1b. holdings that left the index (point-in-time universe): sold at the last close
    for t in [t for t in state.holdings if not ctx.universe.is_member(t, when)]:
        price = ctx.last_close(t, when) or state.holdings[t].avg_cost
        fills.append(broker.sell(day, t, state.holdings[t].shares, price, "exit",
                                 f"Sold {t}: no longer in the {qm.INDEX_LABELS.get(ctx.universe.index_name, 'index')}."))

    regime = ctx.regime.loc[:when].iloc[-1] if len(ctx.regime.loc[:when]) else pd.Series(dtype=object)
    signals: list[Signal] = []
    sizing_note = ""
    if trade:
        names = ctx.universe.eligible(when)  # index members that day (all tickers for a watchlist)
        names += [t for t in state.holdings if t not in names]
        cooldown = stop_cooldown(state, ctx.sessions, when, p)
        signals = [s for t in names
                   if (s := make_signal(ctx, t, when, t in state.holdings, regime, p, cooldown)) is not None]
        by_ticker = {s.ticker: s for s in signals}

        # 3. exits
        for s in signals:
            if s.action == "SELL" and s.ticker in state.holdings:
                bar = ctx.bar(s.ticker, when)
                h = state.holdings[s.ticker]
                fills.append(broker.sell(day, s.ticker, h.shares, float(bar.close), "exit",
                                         f"Sold {s.ticker}: {s.summary}.", s.to_json()))

        # 4. target book
        keep = list(state.holdings)
        candidates = sorted((s for s in signals if s.action == "BUY"), key=lambda s: -s.score)
        new = [s.ticker for s in candidates[: max(0, p.max_positions - len(keep))]]
        names = [t for t in keep + new if ctx.bar(t, when) is not None]
        gross = p.gross_exposure(regime.get("stance"))
        vols = {t: float(ctx.bars[t]["vol"].loc[:when].iloc[-1]) for t in names}
        weights, sizing_note = size_positions(vols, gross, p, kelly)
        equity = state.equity(ctx, when)

        # 5. trades: sells first to free cash, then buys
        orders = []
        for t in names:
            close = float(ctx.bar(t, when).close)
            target = int(weights[t] * equity // close)
            current = state.holdings[t].shares if t in state.holdings else 0
            gap = abs(target - current) * close / equity
            if t in new or (gap > p.rebalance_band and target != current):
                orders.append((t, target, current, close))
        for t, target, current, close in sorted(orders, key=lambda o: o[1] - o[2]):
            s = by_ticker.get(t)
            if target < current:
                fills.append(broker.sell(day, t, current - target, close, "trim",
                                         f"Trimmed {t} to {weights[t]:.1%} of equity ({sizing_note}, "
                                         f"{regime.get('stance')} exposure {gross:.0%}).", s.to_json() if s else None))
            elif t in new:
                bar = ctx.bar(t, when)
                stop = initial_stop(close, float(bar.atr_14), p)
                fills.append(broker.buy(
                    day, t, target, close, "entry",
                    f"Bought {t}: {s.summary}. Sized {weights[t]:.1%} of equity ({sizing_note}, "
                    f"60-day vol {vols[t]:.0%}); stop {stop:.2f} ({p.atr_multiple:g}x ATR, max loss {p.max_loss:.0%}).",
                    s.to_json(), stop))
            else:
                fills.append(broker.buy(day, t, target - current, close, "add",
                                        f"Added to {t}, back to {weights[t]:.1%} of equity ({sizing_note}).",
                                        s.to_json() if s else None))

    holdings_value = state.market_value(ctx, when)
    return DayResult(day, [f for f in fills if f is not None], signals, state.cash, holdings_value,
                     state.cash + holdings_value, regime.get("regime"), regime.get("stance"),
                     len(state.holdings), sizing_note)


# =============================================================================
# Backtest
# =============================================================================

@dataclass
class BacktestResult:
    params: BotParams
    equity: pd.Series
    fills: list[Fill]
    days: list[DayResult]
    stats: dict
    final_state: PortfolioState


def trade_stats(fills: list[Fill]) -> dict:
    closed = [f.position_return for f in fills if f.position_return is not None]
    wins = [r for r in closed if r > 0]
    losses = [r for r in closed if r <= 0]
    out = {"closed_trades": len(closed), "win_rate": len(wins) / len(closed) if closed else float("nan"),
           "avg_win": float(np.mean(wins)) if wins else float("nan"),
           "avg_loss": float(np.mean(losses)) if losses else float("nan"),
           "stops_hit": sum(f.reason == "stop" for f in fills)}
    k = kelly_stats(closed, min_trades=1)
    out["payoff"] = k["payoff"] if k else float("nan")
    out["kelly"] = k["kelly"] if k else float("nan")
    return out


def backtest(ctx: MarketContext, p: BotParams, start: str, end: str | None = None,
             signal_every: int = 5) -> BacktestResult:
    """Walk-forward simulation of the live rules. Stops are checked daily; signals and
    rebalancing run every ``signal_every`` sessions. Inputs are point-in-time; the news
    archive is short, so historical sentiment is mostly neutral."""
    state = PortfolioState(cash=p.initial_cash)
    sessions = ctx.sessions[(ctx.sessions >= pd.Timestamp(start)) & (ctx.sessions <= pd.Timestamp(end or ctx.sessions[-1]))]
    days, fills = [], []
    for i, when in enumerate(sessions):
        closed = [f.position_return for f in fills if f.position_return is not None]
        k = kelly_stats(closed, p.kelly_min_trades) if p.sizing == "kelly" else None
        res = run_day(state, ctx, when, p, k, trade=i % signal_every == 0)
        days.append(res)
        fills += res.fills
    equity = pd.Series([d.equity for d in days], index=sessions, name="equity")
    rf = ctx.universe.factors["rf"] if "rf" in ctx.universe.factors else None
    stats = {**qm.performance_stats(equity.pct_change().dropna(), rf), **trade_stats(fills)}
    spy_ret = ctx.benchmark.reindex(sessions).pct_change().dropna()
    stats["spy_cagr"] = qm.performance_stats(spy_ret)["cagr"]
    stats["avg_invested"] = float(np.mean([d.holdings_value / d.equity for d in days]))
    return BacktestResult(p, equity, fills, days, stats, state)


# =============================================================================
# Persistence (the ledger)
# =============================================================================

def get_portfolio(session: Session, name: str, p: BotParams | None = None, create: bool = True) -> Portfolio | None:
    pf = session.scalar(select(Portfolio).where(Portfolio.name == name))
    if pf is None and create:
        p = p or BotParams()
        pf = Portfolio(name=name, initial_cash=p.initial_cash, cash=p.initial_cash, params=json.dumps(asdict(p)))
        session.add(pf)
        session.flush()
    return pf


def load_state(session: Session, pf: Portfolio) -> PortfolioState:
    state = PortfolioState(cash=pf.cash)
    for pos in session.scalars(select(Position).where(Position.portfolio_id == pf.id)):
        state.holdings[pos.ticker] = Holding(pos.ticker, pos.shares, pos.avg_cost, pos.entry_date, pos.entry_price,
                                             pos.stop_price, pos.highest_close, pos.realized_pnl, pos.cost_invested)
    state.stop_dates = list(session.scalars(select(Trade.trade_date).where(
        Trade.portfolio_id == pf.id, Trade.reason == "stop")))
    return state


def save_days(session: Session, pf: Portfolio, state: PortfolioState, days: list[DayResult]) -> None:
    for d in days:
        for f in d.fills:
            session.add(Trade(portfolio_id=pf.id, trade_date=f.date, ticker=f.ticker, side=f.side, shares=f.shares,
                              price=f.price, value=f.value, reason=f.reason, rationale=f.rationale, signal=f.signal,
                              realized_pnl=f.realized_pnl, position_pnl=f.position_pnl,
                              position_return=f.position_return))
        session.execute(delete(PortfolioSnapshot).where(PortfolioSnapshot.portfolio_id == pf.id,
                                                        PortfolioSnapshot.date == d.date))
        session.add(PortfolioSnapshot(portfolio_id=pf.id, date=d.date, cash=d.cash, holdings_value=d.holdings_value,
                                      equity=d.equity, n_positions=d.n_positions, regime=d.regime,
                                      stance=d.stance))
        if d.signals:
            session.execute(delete(SignalRecord).where(SignalRecord.portfolio_id == pf.id, SignalRecord.date == d.date))
            for s in d.signals:
                session.add(SignalRecord(portfolio_id=pf.id, date=s.date, ticker=s.ticker, action=s.action,
                                         score=s.score, rationale=s.rationale,
                                         details=json.dumps(s.details, default=str), **s.components))
    session.execute(delete(Position).where(Position.portfolio_id == pf.id))
    for h in state.holdings.values():
        session.add(Position(portfolio_id=pf.id, ticker=h.ticker, shares=h.shares, avg_cost=h.avg_cost,
                             entry_date=h.entry_date, entry_price=h.entry_price, stop_price=h.stop,
                             highest_close=h.highest_close, realized_pnl=h.realized_pnl,
                             cost_invested=h.cost_invested))
    pf.cash = state.cash
    if days:
        pf.last_run_date = days[-1].date


def closed_returns(session: Session, name: str) -> list[float]:
    pf = get_portfolio(session, name, create=False)
    if pf is None:
        return []
    return list(session.scalars(select(Trade.position_return).where(
        Trade.portfolio_id == pf.id, Trade.position_return.is_not(None))))


def run_live(session: Session, tickers: list[str], p: BotParams = BotParams(), name: str = LIVE,
             ctx: MarketContext | None = None) -> list[DayResult]:
    """Process every session since the last run: stops on each, signals and trades on the latest.

    Idempotent: re-running after the latest session has been processed does nothing.
    """
    pf = get_portfolio(session, name, p)
    ctx = ctx or load_context(session, tickers, p.vol_window)
    latest = ctx.sessions[-1]
    since = pd.Timestamp(pf.last_run_date) if pf.last_run_date else latest - pd.Timedelta(days=1)
    pending = ctx.sessions[(ctx.sessions > since) & (ctx.sessions <= latest)]
    if not len(pending):
        log.info("portfolio %s already processed %s", name, pf.last_run_date)
        return []

    state = load_state(session, pf)
    for t, h in state.holdings.items():  # splits since the last run
        splits = ctx.universe.splits.get(t, pd.Series(dtype=float))
        for ratio in splits[(splits.index > since) & (splits.index <= latest)]:
            apply_split(h, float(ratio))

    closed = closed_returns(session, name)
    if len(closed) < p.kelly_min_trades:  # bootstrap Kelly from the saved backtest
        closed = closed + closed_returns(session, BACKTEST)
    k = kelly_stats(closed, p.kelly_min_trades) if p.sizing == "kelly" else None

    days = [run_day(state, ctx, when, p, k, trade=(when == latest)) for when in pending]
    save_days(session, pf, state, days)
    return days


def save_backtest(session: Session, result: BacktestResult, name: str = BACKTEST) -> None:
    """Replace the stored backtest portfolio (for the dashboard and Kelly bootstrap)."""
    old = get_portfolio(session, name, create=False)
    if old is not None:
        for model in (Trade, Position, PortfolioSnapshot, SignalRecord):
            session.execute(delete(model).where(model.portfolio_id == old.id))
        session.delete(old)
        session.flush()
    pf = get_portfolio(session, name, result.params)
    save_days(session, pf, result.final_state, [replace(d, signals=[]) for d in result.days])


# =============================================================================
# CLI
# =============================================================================

def portfolio_status(session: Session, name: str = LIVE, recent: int = 10) -> dict | None:
    pf = get_portfolio(session, name, create=False)
    if pf is None:
        return None
    positions = []
    for pos in session.scalars(select(Position).where(Position.portfolio_id == pf.id)):
        closes = load_bars(session, pos.ticker, "1d")["close"].dropna()
        last = float(closes.iloc[-1]) if len(closes) else pos.avg_cost  # no prices stored (e.g. dropped ticker)
        positions.append({"ticker": pos.ticker, "shares": pos.shares, "avg_cost": pos.avg_cost, "last": last,
                          "value": pos.shares * last, "unrealized": (last - pos.avg_cost) * pos.shares,
                          "return": last / pos.avg_cost - 1, "stop": pos.stop_price,
                          "to_stop": pos.stop_price / last - 1, "since": pos.entry_date})
    equity = pf.cash + sum(x["value"] for x in positions)
    trades = list(session.scalars(select(Trade).where(Trade.portfolio_id == pf.id)
                                  .order_by(Trade.trade_date.desc(), Trade.id.desc()).limit(recent)))
    closed = closed_returns(session, name)
    return {"portfolio": pf, "equity": equity, "positions": positions, "recent_trades": trades,
            "closed_trades": len(closed),
            "win_rate": float(np.mean([r > 0 for r in closed])) if closed else None}


def _print_signals(signals: list[Signal]) -> None:
    print(f"\n{'ticker':<7}{'action':<7}{'score':>7}{'trend':>7}{'fund':>7}{'value':>7}{'news':>7}")
    for s in sorted(signals, key=lambda s: -s.score):
        c = s.components
        print(f"{s.ticker:<7}{s.action:<7}{s.score:>+7.2f}{c['trend']:>+7.2f}{c['fundamentals']:>+7.2f}"
              f"{c['valuation']:>+7.2f}{c['sentiment']:>+7.2f}")
    print()
    for s in sorted(signals, key=lambda s: -s.score):
        print(f"- {s.rationale}")


def _print_backtest(r: BacktestResult, note: str = qm.SURVIVORSHIP_NOTE) -> None:
    s = r.stats
    print(f"\nBACKTEST {s['start']} to {s['end']} ({r.params.sizing}, signals weekly, stops daily)")
    print(f"  CAGR {s['cagr']:.1%} (SPY {s['spy_cagr']:.1%})  vol {s['vol']:.1%}  Sharpe {s['sharpe']:.2f}  "
          f"max drawdown {s['max_drawdown']:.1%}  avg invested {s['avg_invested']:.0%}")
    print(f"  closed trades {s['closed_trades']}  win rate {s['win_rate']:.0%}  avg win {s['avg_win']:+.1%}  "
          f"avg loss {s['avg_loss']:+.1%}  payoff {s['payoff']:.2f}  full Kelly {s['kelly']:.1%}  stops hit {s['stops_hit']}")
    print(f"  {note} Historical news sentiment is mostly unavailable (archive starts 2026-10).")


def main(argv: list[str] | None = None) -> int:
    from quant.config import get_settings
    from quant.db import init_db, session_scope

    parser = argparse.ArgumentParser(description="Paper-trading bot.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("signals", help="today's signals, no trading")
    run = sub.add_parser("run", help="process the latest session(s) for the paper portfolio")
    run.add_argument("--sizing", choices=("vol_parity", "kelly"), default="vol_parity")
    sub.add_parser("status", help="positions, P&L and recent trades")
    bt = sub.add_parser("backtest", help="walk-forward test of the rules")
    bt.add_argument("--start", default="2018-01-02")
    bt.add_argument("--end")
    bt.add_argument("--sizing", choices=("vol_parity", "kelly"), default="vol_parity")
    bt.add_argument("--save", action="store_true", help="store as the 'backtest' portfolio ('backtest_sp500' for sp500)")
    bt.add_argument("--universe", choices=("watchlist", "sp500"), default=None,
                    help="tradable universe (default: RESEARCH_UNIVERSE, else watchlist); live trading stays on the watchlist")
    bt.add_argument("--block-entries-when", nargs="+", default=[], metavar="LABEL",
                    help="regime labels that block new buys, e.g. Volatile Risk-Off")
    bt.add_argument("--entry-above-sma50", action="store_true", help="new buys only above the stock's 50-day MA")
    bt.add_argument("--cooldown-stops", type=int, default=0, metavar="N",
                    help="no new buys after N stop-outs within the last 10 sessions")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(errors="replace")

    settings = get_settings()
    tickers = list(settings.equities)
    p = BotParams(sizing=getattr(args, "sizing", "vol_parity"))
    if args.command == "backtest":
        p = replace(p, block_entries_when=tuple(args.block_entries_when), entry_above_sma50=args.entry_above_sma50,
                    cooldown_stops=args.cooldown_stops)
    with session_scope(init_db()) as session:
        if args.command == "signals":
            ctx = load_context(session, tickers, p.vol_window)
            pf = get_portfolio(session, LIVE, create=False)
            held = set(load_state(session, pf).holdings) if pf else set()
            when = ctx.sessions[-1]
            regime = ctx.regime.loc[:when].iloc[-1]
            print(f"SIGNALS for {when.date()} (regime {regime['regime']} / {regime['stance']})")
            _print_signals([s for t in ctx.universe.tickers
                            if (s := make_signal(ctx, t, when, t in held, regime, p)) is not None])
        elif args.command == "run":
            days = run_live(session, tickers, p)
            if not days:
                print("Nothing to do: the latest session is already processed.")
            for d in days:
                print(f"{d.date}: equity {d.equity:,.0f}  cash {d.cash:,.0f}  regime {d.regime}/{d.stance}"
                      + (f"  sizing: {d.sizing_note}" if d.sizing_note else ""))
                for f in d.fills:
                    print(f"  {f.side} {f.shares:g} {f.ticker} @ {f.price:.2f}: {f.rationale}")
        elif args.command == "status":
            st = portfolio_status(session)
            if st is None:
                print("No paper portfolio yet: run `python -m quant.trading_bot run`.")
                return 0
            pf = st["portfolio"]
            print(f"PORTFOLIO '{pf.name}' (since {pf.created_at:%Y-%m-%d}, last session {pf.last_run_date})")
            print(f"  equity {st['equity']:,.2f}  cash {pf.cash:,.2f}  return {st['equity'] / pf.initial_cash - 1:+.2%}"
                  f"  closed trades {st['closed_trades']}"
                  + (f"  win rate {st['win_rate']:.0%}" if st["win_rate"] is not None else ""))
            for x in st["positions"]:
                print(f"  {x['ticker']:<6}{x['shares']:>6g} @ {x['avg_cost']:>9.2f}  last {x['last']:>9.2f}  "
                      f"P&L {x['unrealized']:>+10,.0f} ({x['return']:+.1%})  stop {x['stop']:.2f} ({x['to_stop']:+.1%})")
            print("  recent trades:")
            for t in st["recent_trades"]:
                print(f"   {t.trade_date} {t.side:<4} {t.shares:g} {t.ticker} @ {t.price:.2f} [{t.reason}] {t.rationale}")
        elif args.command == "backtest":
            universe = args.universe or settings.research_universe
            index = None if universe == "watchlist" else universe
            ctx = load_context(session, tickers, p.vol_window, index=index)
            result = backtest(ctx, p, args.start, args.end)
            _print_backtest(result, ctx.universe.note())
            if args.save:
                name = BACKTEST if index is None else f"{BACKTEST}_{index}"  # the Kelly bootstrap reads 'backtest'
                save_backtest(session, result, name)
                print(f"  saved as portfolio '{name}' ({len(result.fills)} fills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
