"""Score the broad universe with the platform's processes, for thousands of instruments at once.

Per instrument, from the price store (Phases 2-3 logic):
  trend     50/200-day MA alignment, distance from the 200-day, last golden/death cross
  momentum  12-1 and 6-1 month returns (Jegadeesh & Titman), on calendar days so that
            crypto (7-day weeks) and stocks compare like for like
  risk      60-day volatility (annualised by 252, or 365 for crypto), 1-year max drawdown
  unusual   today's move vs a robust (median-absolute-deviation) volatility:
            >= 8% (20% for crypto), or >= 3 sigma and >= 2% (5% for crypto)
  RSI(14)
From quotes and fundamentals:
  value     forward and trailing earnings yield, book-to-market, EBITDA/EV, dividend yield
  quality   ROE, profit margin, low debt/equity, revenue and earnings growth
  analysts  Yahoo consensus rating: the scalable stand-in for news sentiment, which runs
            only for the watchlist (FinBERT over thousands of names is not feasible daily)

Pillars are percentile ranks among peers (the Phase 3 method): stocks within their market
for trend, momentum and risk, and within market x sector for value and quality (falling
back to the global sector when a group has < 15 names); ETFs and coins within their own
class. The composite is the mean of the available pillars (0-100).

Signal (the bot's rules, simplified): BUY candidate = up-trend (50 > 200-day and price
above the 200-day) + composite >= 60 + the instrument's market is not in a Bear regime;
AVOID = down-trend + composite <= 40; otherwise HOLD.
"""

from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd
from sqlalchemy import select

from quant import analytics as an
from quant.db import session_scope
from quant.universe import prices, sources
from quant.universe.models import Instrument, InstrumentFundamentals

log = logging.getLogger(__name__)

# market -> index whose trend and volatility define that market's regime
BENCHMARKS = {
    "US": "^GSPC", "US ETFs": "^GSPC", "Canada": "^GSPTSE", "Europe": "^STOXX", "Japan": "^N225",
    "Korea": "^KS11", "China/HK": "^HSI", "Taiwan": "^TWII", "India": "^NSEI", "Australia": "^AXJO",
    "Crypto": "BTC-USD",
}
BENCHMARK_SYMBOLS = sorted(set(BENCHMARKS.values()) | {"^VIX"})
MIN_PEERS = 15
BUY_SCORE, AVOID_SCORE = 60.0, 40.0


# =============================================================================
# Per-instrument price metrics
# =============================================================================

def _at(dates: np.ndarray, values: np.ndarray, target: np.datetime64) -> float:
    """Last value on or before ``target`` (NaN when history doesn't reach back that far)."""
    i = int(np.searchsorted(dates, target, side="right")) - 1
    return float(values[i]) if i >= 0 else math.nan


def _rsi(values: np.ndarray, window: int = 14) -> float:
    delta = np.diff(values[-(window * 15):])
    if len(delta) < window + 1:
        return math.nan
    gain, loss = np.clip(delta, 0, None), np.clip(-delta, 0, None)
    avg_g, avg_l = gain[:window].mean(), loss[:window].mean()
    for g, lo in zip(gain[window:], loss[window:]):
        avg_g = (avg_g * (window - 1) + g) / window
        avg_l = (avg_l * (window - 1) + lo) / window
    return 100.0 if avg_l == 0 else float(100 - 100 / (1 + avg_g / avg_l))


def series_metrics(dates: np.ndarray, v: np.ndarray, vol: np.ndarray, crypto: bool, today: np.datetime64) -> dict:
    n = len(v)
    last_date, last = dates[-1], v[-1]
    day = np.timedelta64(1, "D")
    back = lambda days: _at(dates, v, last_date - days * day)  # noqa: E731
    covered = lambda days: dates[0] <= last_date - days * day  # noqa: E731
    rets = v[1:] / v[:-1] - 1
    out = {
        "last_close": float(last), "last_date": pd.Timestamp(last_date).date(),
        "stale_days": int((today - last_date) / day),
        "ret_1d": float(rets[-1]) if len(rets) else math.nan,
        "ret_1w": last / back(7) - 1, "ret_1m": last / back(30) - 1, "ret_3m": last / back(91) - 1,
        "ret_ytd": last / _at(dates, v, np.datetime64(f"{pd.Timestamp(last_date).year - 1}-12-31")) - 1,
        "mom_12_1": back(30) / back(365) - 1 if covered(365) else math.nan,
        "mom_6_1": back(30) / back(182) - 1 if covered(182) else math.nan,
    }
    if not covered(7):
        out["ret_1w"] = math.nan
    sma50 = v[-50:].mean() if n >= 50 else math.nan
    sma200 = v[-200:].mean() if n >= 200 else math.nan
    spread = sma50 / sma200 - 1 if n >= 200 else math.nan
    out.update(sma_50=sma50, sma_200=sma200, ma_spread=spread, dist_200=last / sma200 - 1 if n >= 200 else math.nan)
    out["ma_alignment"] = (1 if spread > 0 and last > sma200 else -1 if spread < 0 and last < sma200 else 0) \
        if n >= 200 else math.nan

    # last golden / death cross within the available history
    out["cross_type"], out["cross_sessions_ago"] = None, math.nan
    if n >= 201:
        cs = np.concatenate([[0.0], np.cumsum(v)])
        idx = np.arange(199, n)
        s50 = (cs[idx + 1] - cs[idx - 49]) / 50
        s200 = (cs[idx + 1] - cs[idx - 199]) / 200
        sign = np.sign(s50 - s200)
        flips = np.nonzero((sign[1:] != sign[:-1]) & (sign[1:] != 0))[0]
        if len(flips):
            k = flips[-1] + 1
            out["cross_type"] = "golden" if sign[k] > 0 else "death"
            out["cross_sessions_ago"] = int(len(sign) - 1 - k)

    ann = math.sqrt(365 if crypto else 252)
    out["volatility"] = float(np.std(rets[-60:], ddof=1) * ann) if len(rets) >= 20 else math.nan
    window = v[dates >= last_date - 365 * day]
    out["max_drawdown_1y"] = float((window / np.maximum.accumulate(window) - 1).min()) if len(window) > 1 else math.nan
    out["rsi_14"] = _rsi(v)

    # Phase 2 unusual-move rule against robust volatility
    out["zscore_1d"], out["unusual"] = math.nan, False
    if len(rets) >= 31:
        hist = rets[-61:-1]
        mad = np.median(np.abs(hist - np.median(hist))) * 1.4826
        r = rets[-1]
        z = r / mad if mad > 0 else math.nan
        abs_floor, min_move = (0.20, 0.05) if crypto else (0.08, 0.02)
        out["zscore_1d"] = z
        out["unusual"] = bool(abs(r) >= abs_floor or (abs(z) >= 3 and abs(r) >= min_move))
    out["adv_local"] = float(np.nanmean(v[-63:] * vol[-63:])) if len(vol) else math.nan
    spark = v[-126:][::3]
    out["sparkline"] = [round(float(x), 6) for x in spark]
    return out


def price_metrics(close: pd.DataFrame, volume: pd.DataFrame, crypto: set[str]) -> pd.DataFrame:
    dates_all = close.index.values
    today = np.datetime64(pd.Timestamp.now().normalize())
    rows = {}
    for sym in close.columns:
        col = close[sym].to_numpy(dtype="float64")
        mask = ~np.isnan(col) & (col > 0)
        if mask.sum() < 20:
            continue
        vol = volume[sym].to_numpy(dtype="float64")[mask] if sym in volume else np.zeros(mask.sum())
        rows[sym] = series_metrics(dates_all[mask], col[mask], np.nan_to_num(vol), sym in crypto, today)
    return pd.DataFrame.from_dict(rows, orient="index")


# =============================================================================
# Market regimes
# =============================================================================

def market_regimes(close: pd.DataFrame) -> pd.DataFrame:
    """Phase 2 regime per market from its index: trend (50/200 + 20% drawdown rule) and
    volatility (VIX for the US, realised 20-day volatility elsewhere)."""
    vix = close["^VIX"].dropna() if "^VIX" in close else pd.Series(dtype=float)
    rows = []
    for market, sym in BENCHMARKS.items():
        if sym not in close:
            continue
        s = close[sym].dropna()
        if len(s) < 220:
            continue
        ann = math.sqrt(365 if market == "Crypto" else 252)
        realised = s.pct_change().rolling(20).std() * ann * 100
        vol_proxy = vix.reindex(s.index).ffill() if market in ("US", "US ETFs") and len(vix) else realised
        labels = an.classify_regimes(s, s.rolling(50).mean(), s.rolling(200).mean(), vol_proxy)
        last = labels.dropna(subset=["regime"]).iloc[-1]
        trend, vol = last.trend, last.volatility
        stance = ("Risk-On" if trend == "Bull" and vol != "Volatile"
                  else "Risk-Off" if trend == "Bear" or (vol == "Volatile" and trend != "Bull") else "Neutral")
        rows.append({"market": market, "index": sym, "as_of": s.index[-1].date(), "regime": last.regime,
                     "trend": trend, "volatility": vol, "stance": stance, "level": float(s.iloc[-1]),
                     "ret_1m": float(s.iloc[-1] / s.asof(s.index[-1] - pd.Timedelta(days=30)) - 1),
                     "drawdown_52w": float(last.drawdown_52w)})
    return pd.DataFrame(rows).set_index("market")


# =============================================================================
# Peer-relative pillars
# =============================================================================

def _pct_within(s: pd.Series) -> pd.Series:
    n = s.count()
    return (s.rank(method="average") - 1) / (n - 1) if n > 1 else s * np.nan


def peer_pct(values: pd.Series, groups: pd.Series, higher_better: bool = True,
             fallback: pd.Series | None = None, min_peers: int = MIN_PEERS) -> pd.Series:
    """Percentile (0 worst .. 1 best) among peers; falls back to broader groups when thin."""
    s = values.astype(float).replace([np.inf, -np.inf], np.nan)
    s = s if higher_better else -s
    out = pd.Series(np.nan, index=s.index)
    for grp in [g for g in (groups, fallback) if g is not None]:
        counts = s.groupby(grp).transform("count")
        ranked = s.groupby(grp).transform(_pct_within)
        out = out.fillna(ranked.where(counts >= min_peers))
    out = out.fillna(_pct_within(s))
    return out.where(s.notna())


def _pillar(parts: list[pd.Series]) -> pd.Series:
    return pd.concat(parts, axis=1).mean(axis=1) * 100 if parts else pd.Series(dtype=float)


def _inverse(x: pd.Series) -> pd.Series:
    x = x.astype(float)
    return (1.0 / x).where(x.notna() & (x != 0))


def score_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Add pillar scores (0-100) and the composite to a joined instrument frame."""
    df = df.copy()
    for col in ("trend", "momentum", "risk", "value", "quality", "analysts", "cost"):
        df[col] = np.nan
    for cls, peers in (("stock", df["market"]), ("etf", None), ("crypto", None)):
        m = df.asset_class == cls
        if not m.any():
            continue
        g = peers[m] if peers is not None else pd.Series(cls, index=df.index[m])
        sub = df[m]
        df.loc[m, "trend"] = _pillar([peer_pct(sub.ma_spread, g), peer_pct(sub.dist_200, g)])
        df.loc[m, "momentum"] = _pillar([peer_pct(sub.mom_12_1, g), peer_pct(sub.mom_6_1, g)])
        df.loc[m, "risk"] = _pillar([peer_pct(sub.volatility, g, higher_better=False),
                                     peer_pct(sub.max_drawdown_1y, g)])
        if cls == "stock":
            sector = sub.sector.fillna("Unknown")
            ms = g + "|" + sector
            has_value = sub[["pe_current_year", "trailing_pe", "price_to_book", "ev_to_ebitda"]].notna().any(axis=1)
            div = sub.dividend_yield.where(sub.dividend_yield.notna() | ~has_value, 0.0)
            value_parts = [_inverse(sub.pe_current_year), _inverse(sub.trailing_pe), _inverse(sub.price_to_book),
                           _inverse(sub.ev_to_ebitda), div]
            df.loc[m, "value"] = _pillar([peer_pct(x, ms, fallback=sector) for x in value_parts])
            quality_parts = [(sub.return_on_equity, True), (sub.profit_margin, True), (sub.debt_to_equity, False),
                             (sub.revenue_growth, True), (sub.earnings_growth, True)]
            df.loc[m, "quality"] = _pillar([peer_pct(x, ms, hb, fallback=sector) for x, hb in quality_parts])
            df.loc[m, "analysts"] = _pillar([peer_pct(sub.analyst_rating, g, higher_better=False)])
        if cls == "etf":
            df.loc[m, "cost"] = _pillar([peer_pct(sub.expense_ratio, g, higher_better=False)])
    pillars = ["trend", "momentum", "risk", "value", "quality", "analysts", "cost"]
    available = df[pillars].notna().sum(axis=1)
    df["composite"] = df[pillars].mean(axis=1).where(available >= np.where(df.asset_class == "stock", 3, 2))
    return df


# =============================================================================
# Signals and rationales
# =============================================================================

def _phrases(r) -> dict[str, tuple[float, str]]:
    """pillar -> (score, phrase)."""
    out = {}
    if pd.notna(r.trend):
        if isinstance(r.cross_type, str) and pd.notna(r.cross_sessions_ago) and r.cross_sessions_ago <= 30:
            text = f"50 MA crossed {'above' if r.cross_type == 'golden' else 'below'} 200 MA {int(r.cross_sessions_ago)} sessions ago"
        elif pd.notna(r.ma_spread):
            text = f"50 MA {abs(r.ma_spread):.1%} {'above' if r.ma_spread > 0 else 'below'} 200 MA"
        else:
            text = "trend"
        out["trend"] = (r.trend, f"{text} (trend {r.trend:.0f}/100)")
    if pd.notna(r.momentum):
        out["momentum"] = (r.momentum, f"12-1 momentum {r.mom_12_1:+.0%} ({r.momentum:.0f}/100)"
                           if pd.notna(r.mom_12_1) else f"momentum {r.momentum:.0f}/100")
    if pd.notna(r.value):
        pe = f", fwd P/E {r.pe_current_year:.1f}" if pd.notna(r.pe_current_year) and r.pe_current_year > 0 else ""
        out["value"] = (r.value, f"value {r.value:.0f}/100{pe}")
    if pd.notna(r.quality):
        roe = f", ROE {r.return_on_equity:.0%}" if pd.notna(r.return_on_equity) else ""
        out["quality"] = (r.quality, f"quality {r.quality:.0f}/100{roe}")
    if pd.notna(r.risk):
        out["risk"] = (r.risk, f"volatility {r.volatility:.0%} (risk {r.risk:.0f}/100)")
    if pd.notna(r.analysts) and isinstance(r.analyst_label, str):
        out["analysts"] = (r.analysts, f"analysts {r.analyst_label} ({r.analyst_rating:.1f})")
    if pd.notna(r.cost):
        out["cost"] = (r.cost, f"expense ratio {r.expense_ratio:.2f}%")
    return out


def add_signals(df: pd.DataFrame, regimes: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    bear_markets = set(regimes.index[regimes.trend == "Bear"]) if len(regimes) else set()
    up, down = df.ma_alignment == 1, df.ma_alignment == -1
    bear = df.market.isin(bear_markets)
    df["signal"] = np.select([up & (df.composite >= BUY_SCORE) & ~bear, down & (df.composite <= AVOID_SCORE)],
                             ["BUY", "AVOID"], "HOLD")
    df.loc[df.composite.isna(), "signal"] = "N/A"
    rationales = []
    for r in df.itertuples():
        ph = _phrases(r)
        direction = -1 if r.signal == "AVOID" else 1
        ordered = sorted(ph.values(), key=lambda x: -direction * (x[0] - 50))
        note = ""
        if r.signal == "HOLD" and up.get(r.Index, False) and r.market in bear_markets and r.composite >= BUY_SCORE:
            note = f" New buys paused: {r.market} is in a Bear regime."
        unusual = f"; unusual move {r.ret_1d:+.1%} today (z {r.zscore_1d:.1f})" if r.unusual else ""
        head = {"BUY": "Buy candidate", "AVOID": "Avoid", "HOLD": "Hold / watch", "N/A": "Not enough data"}[r.signal]
        rationales.append(f"{head}: " + "; ".join(p for _, p in ordered[:4]) + unusual + "." + note)
    df["rationale"] = rationales
    return df


# =============================================================================
# Orchestration
# =============================================================================

def load_frames() -> tuple[pd.DataFrame, pd.DataFrame]:
    with session_scope() as s:
        inst = pd.read_sql(select(Instrument).where(Instrument.active.is_(True)), s.connection())
        fund = pd.read_sql(select(InstrumentFundamentals), s.connection())
    return inst, fund


def run() -> pd.DataFrame:
    close, volume = prices.load("close"), prices.load("volume")
    missing_bench = [b for b in BENCHMARK_SYMBOLS if b not in close.columns]
    if missing_bench:
        prices.update(missing_bench, prune=False)
        close, volume = prices.load("close"), prices.load("volume")
    inst, fund = load_frames()
    crypto = set(inst.symbol[inst.asset_class == "crypto"])
    cols = [c for c in inst.symbol if c in close.columns]
    pm = price_metrics(close[cols], volume, crypto)

    df = inst.set_index("symbol").join(pm, how="left")
    df = df.join(fund.drop(columns=["fetched_at", "error"]).set_index("symbol"), how="left")
    fx = sources.usd_per_unit(set(df.currency.dropna()))
    df["adv_usd"] = df.adv_local * df.currency.map(fx)
    df.loc[df.asset_class == "crypto", "adv_usd"] = df.adv_local  # quoted in USD
    stale = df.stale_days > 10  # halted or no longer trading: keep the row, drop price-based scores
    for c in ("ma_spread", "dist_200", "mom_12_1", "mom_6_1", "volatility", "max_drawdown_1y", "ma_alignment"):
        df.loc[stale, c] = np.nan

    regimes = market_regimes(close)
    df = add_signals(score_frame(df), regimes)
    df["scored_at"] = pd.Timestamp.now()
    out = df.reset_index().rename(columns={"index": "symbol"})
    path = prices.store_dir()
    out.to_parquet(path / "scores.parquet")
    regimes.reset_index().to_parquet(path / "regimes.parquet")
    (path / "history").mkdir(exist_ok=True)
    out.drop(columns=["sparkline"]).to_parquet(path / "history" / f"scores_{pd.Timestamp.now():%Y-%m-%d}.parquet")
    log.info("scored %d instruments; regimes: %s", len(out),
             ", ".join(f"{m} {r.regime}" for m, r in regimes.iterrows()))
    return out


def load_scores() -> pd.DataFrame:
    path = prices.store_dir() / "scores.parquet"
    return pd.read_parquet(path) if path.exists() else pd.DataFrame()


def load_regimes() -> pd.DataFrame:
    path = prices.store_dir() / "regimes.parquet"
    return pd.read_parquet(path).set_index("market") if path.exists() else pd.DataFrame()
