"""Phase 3 quant models: Fama-French factor exposures, momentum and mean-reversion
strategies, and a composite Value / Quality / Momentum score.

    python -m quant.quant_models                       # full report for the watchlist
    python -m quant.quant_models --model carhart       # add the momentum factor
    python -m quant.quant_models --evaluate            # + does the score predict returns?

Research behind each piece
  * Factor model     Fama & French (1993) three factors; Carhart (1997) adds momentum.
  * Momentum         Jegadeesh & Titman (1993): 12-month return skipping the last month.
  * Mean reversion   Jegadeesh (1990) one-month and Lehmann (1990) one-week reversal.
  * Value            Basu (1977) earnings yield; Fama & French (1992) book-to-market.
  * Quality          Sloan (1996) accruals; Novy-Marx (2013) profitability;
                     Asness, Frazzini & Pedersen (2019) quality-minus-junk.

Everything is point-in-time: a fundamental counts only from its SEC *filing* date,
and share counts are converted to today's split basis so they match the
split-adjusted prices.
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from datetime import date

import numpy as np
import pandas as pd
import statsmodels.api as sm
from sqlalchemy import select
from sqlalchemy.orm import Session

from quant.ingestion.factors import load_factors
from quant.ingestion.index_membership import load_membership, membership_mask, universe_tickers
from quant.ingestion.market_data import load_daily_bars
from quant.ingestion.sec_edgar import load_fundamentals_many
from quant.models import Company, StockSplit

TRADING_DAYS = 252
FF3 = ("mkt_rf", "smb", "hml")
CARHART = ("mkt_rf", "smb", "hml", "mom")
FF5 = ("mkt_rf", "smb5", "hml", "rmw", "cma")  # Fama & French (2015); size uses the five-factor sorts
MODELS = {"FF3": FF3, "Carhart": CARHART, "FF5": FF5}
FACTOR_LABELS = {"mkt_rf": "market", "smb": "size", "smb5": "size", "hml": "value", "mom": "momentum",
                 "rmw": "profitability", "cma": "investment", "idiosyncratic": "stock-specific"}
SURVIVORSHIP_NOTE = (
    "The universe is today's watchlist of mega-caps, chosen with hindsight, so backtests are "
    "survivorship-biased and illustrative only."
)
HINDSIGHT_NOTE = (
    "Universe: today's {index} members ranked over the whole history (survivorship-biased on purpose, "
    "for comparison with the point-in-time universe)."
)
INDEX_NOTE = (
    "Universe: point-in-time {index} members (a stock is ranked only while in the index). "
    "Yahoo has no prices for {missing:.1%} of member-days, mostly companies later acquired or failed, "
    "so a residual survivorship bias remains."
)


# =============================================================================
# Data bundle
# =============================================================================

@dataclass
class Universe:
    """Everything the models need, loaded once (fast to re-score at many dates)."""

    tickers: list[str]
    close: pd.DataFrame  # split-adjusted close: market cap = close x shares on today's split basis
    adj_close: pd.DataFrame  # split- and dividend-adjusted: returns and momentum
    fundamentals: dict[str, pd.DataFrame]
    splits: dict[str, pd.Series]
    sic: dict[str, str | None]
    factors: pd.DataFrame
    # Point-in-time index membership (sessions x tickers); None = every ticker always eligible.
    members: pd.DataFrame | None = None
    index_name: str | None = None
    n_members: pd.Series | None = None  # all members per session, with or without prices
    point_in_time: bool = True  # False: today's members back-filled (the biased comparison)
    _quarterly: dict = field(default_factory=dict, repr=False)
    _eligible: pd.DataFrame | None = field(default=None, repr=False)
    _eligible_np: np.ndarray | None = field(default=None, repr=False)
    _returns: pd.DataFrame | None = field(default=None, repr=False)

    def eligibility(self) -> pd.DataFrame | None:
        """True where a ticker can be ranked: an index member with a price that session."""
        if self.members is None:
            return None
        if self._eligible is None:
            self._eligible = self.members.reindex(columns=self.tickers, fill_value=False) & self.close[self.tickers].notna()
        return self._eligible

    def eligible(self, when: pd.Timestamp) -> list[str]:
        """Tickers rankable on ``when`` (all of them for a plain watchlist)."""
        mask = self.eligibility()
        if mask is None:
            return self.tickers
        i = mask.index.searchsorted(when, side="right") - 1  # latest session on or before ``when``
        if i < 0:
            return []
        if self._eligible_np is None:
            self._eligible_np = mask.to_numpy()
        return mask.columns[self._eligible_np[i]].tolist()

    def is_member(self, ticker: str, when: pd.Timestamp) -> bool:
        if self.members is None:
            return True
        if ticker not in self.members:
            return False
        i = self.members.index.searchsorted(when, side="right") - 1
        return bool(i >= 0 and self.members[ticker].iat[i])

    def coverage(self) -> float | None:
        """Share of member-days (since prices start) that have a price."""
        mask = self.eligibility()
        if mask is None or self.n_members is None:
            return None
        return float(mask.sum(axis=1).sum() / self.n_members.sum())

    def note(self) -> str:
        if self.members is None:
            return SURVIVORSHIP_NOTE
        if not self.point_in_time:
            return HINDSIGHT_NOTE.format(index=INDEX_LABELS.get(self.index_name, self.index_name))
        return INDEX_NOTE.format(index=INDEX_LABELS.get(self.index_name, self.index_name),
                                 missing=1 - (self.coverage() or 1.0))

    def known_fundamentals(self, ticker: str, as_of: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Filings public on ``as_of`` and their quarterly flows (cached)."""
        fund = self.fundamentals.get(ticker, pd.DataFrame())
        if fund.empty:
            if None not in self._quarterly:
                self._quarterly[None] = quarterly_flows(fund)
            return fund, self._quarterly[None]
        known = fund[pd.to_datetime(fund.filing_date) <= as_of]
        key = (ticker, len(known))
        if key not in self._quarterly:
            self._quarterly[key] = quarterly_flows(known)
        return known, self._quarterly[key]

    @property
    def returns(self) -> pd.DataFrame:
        if self._returns is None:
            self._returns = self.adj_close.pct_change()
        return self._returns


INDEX_LABELS = {"sp500": "S&P 500"}


def load_universe(session: Session, tickers: list[str] | None = None, index: str | None = None,
                  point_in_time: bool = True) -> Universe:
    """Prices, filings, splits and factors for ``tickers``, or, with ``index`` ("sp500"),
    for every stock that was an index member while prices are stored. Index members
    are only eligible on the sessions they were in the index (point in time).
    ``point_in_time=False`` instead ranks today's members over the whole history: the
    survivorship-biased setup, kept only to measure the bias."""
    intervals = None
    if index:
        intervals = load_membership(session, index)
        if intervals.empty:
            raise LookupError(f"no {index} membership stored: run "
                              f"`python -m quant.ingestion.pipeline --universe {index} --steps universe prices fundamentals`")
        tickers = universe_tickers(intervals)
    tickers = list(dict.fromkeys(tickers or []))
    bars = load_daily_bars(session, tickers)
    close = pd.DataFrame({t: b["close"] for t, b in bars.items() if not b.empty}).sort_index()
    adj = pd.DataFrame({t: b["adj_close"] for t, b in bars.items() if not b.empty}).sort_index()

    members = n_members = None
    if intervals is not None:
        everyone = universe_tickers(intervals, since=close.index[0])
        mask = membership_mask(intervals, close.index, everyone)
        if not point_in_time:
            mask = pd.DataFrame(np.broadcast_to(mask.iloc[-1].to_numpy(), mask.shape), index=mask.index,
                                columns=mask.columns)
        n_members = mask.sum(axis=1)
        priced = [t for t in everyone if t in close]
        members = mask[priced]
        ever = (members & close[priced].notna()).any()
        tickers = [t for t in priced if ever[t]]
    else:
        tickers = [t for t in tickers if t in close]

    sic = dict(session.execute(select(Company.ticker, Company.sic).where(Company.ticker.in_(tickers))).all())
    split_rows = session.execute(select(StockSplit.ticker, StockSplit.date, StockSplit.ratio)
                                 .where(StockSplit.ticker.in_(tickers)).order_by(StockSplit.date)).all()
    splits = {t: pd.Series(dtype=float, index=pd.DatetimeIndex([])) for t in tickers}
    for t, grp in pd.DataFrame(split_rows, columns=["ticker", "date", "ratio"]).groupby("ticker"):
        splits[t] = pd.Series(grp.ratio.to_numpy(dtype=float), index=pd.DatetimeIndex(grp.date))
    return Universe(
        tickers=tickers,
        close=close[tickers].astype(float),
        adj_close=adj[tickers].astype(float),
        fundamentals=load_fundamentals_many(session, tickers),
        splits=splits,
        sic={t: sic.get(t) for t in tickers},
        factors=load_factors(session),
        members=members,
        index_name=index,
        n_members=n_members,
        point_in_time=point_in_time,
    )


# =============================================================================
# 1. Fama-French factor exposures
# =============================================================================

@dataclass
class FactorExposure:
    ticker: str
    model: str  # "FF3" or "Carhart"
    start: date
    end: date
    n_obs: int
    alpha_annual: float  # intercept x 252: return not explained by the factors
    alpha_t: float  # Newey-West t-statistic
    betas: dict[str, float]
    t_stats: dict[str, float]
    r_squared: float
    idio_vol_annual: float  # residual volatility
    variance_share: dict[str, float]  # share of return variance from each factor (+ stock-specific)
    return_attribution: dict[str, float]  # annualised return: risk-free + alpha + beta x factor premium
    dominant_driver: str
    tilts: list[str] = field(default_factory=list)


def _tilts(betas: dict[str, float], t: dict[str, float], alpha_t: float) -> list[str]:
    out = []
    mkt = betas["mkt_rf"]
    if mkt >= 1.2:
        out.append(f"aggressive (market beta {mkt:.2f})")
    elif mkt <= 0.8:
        out.append(f"defensive (market beta {mkt:.2f})")
    size = "smb5" if "smb5" in betas else "smb"
    if abs(t[size]) >= 2:
        out.append("large-cap" if betas[size] < 0 else "small-cap")
    if abs(t["hml"]) >= 2:
        out.append("growth" if betas["hml"] < 0 else "value")
    if "mom" in betas and abs(t["mom"]) >= 2:
        out.append("momentum" if betas["mom"] > 0 else "anti-momentum")
    if "rmw" in betas and abs(t["rmw"]) >= 2:
        out.append("robust profitability" if betas["rmw"] > 0 else "weak profitability")
    if "cma" in betas and abs(t["cma"]) >= 2:
        out.append("conservative investment" if betas["cma"] > 0 else "aggressive investment")
    if abs(alpha_t) >= 2:
        out.append("significant positive alpha" if alpha_t > 0 else "significant negative alpha")
    return out


def factor_regression(
    stock_returns: pd.Series,
    factors: pd.DataFrame,
    model: tuple[str, ...] = FF3,
    window: int = 3 * TRADING_DAYS,
    end: pd.Timestamp | None = None,
    ticker: str = "",
    excess: bool = True,
) -> FactorExposure:
    """OLS of daily excess returns on the factors, with Newey-West (HAC) t-stats.

    Variance shares use the Euler decomposition beta_k * cov(f_k, r) / var(r), which
    sums to R-squared across factors; the rest is stock-specific. Pass
    ``excess=False`` for self-financing (long-short) portfolio returns.
    """
    data = pd.concat([stock_returns.rename("r"), factors[list(model) + ["rf"]]], axis=1, join="inner").dropna()
    if end is not None:
        data = data.loc[:end]
    data = data.tail(window)
    if len(data) < 120:
        raise ValueError(f"only {len(data)} overlapping days for {ticker or 'series'}")

    y = data["r"] - data["rf"] if excess else data["r"]
    fit = sm.OLS(y, sm.add_constant(data[list(model)])).fit(cov_type="HAC", cov_kwds={"maxlags": 5})
    betas = {k: float(fit.params[k]) for k in model}
    t_stats = {k: float(fit.tvalues[k]) for k in model}
    var_y = float(y.var())
    shares = {k: betas[k] * float(np.cov(data[k], y)[0, 1]) / var_y for k in model}
    shares["idiosyncratic"] = 1.0 - float(fit.rsquared)
    attribution = {
        "risk_free": float(data["rf"].mean() * TRADING_DAYS) if excess else 0.0,
        "alpha": float(fit.params["const"] * TRADING_DAYS),
        **{k: betas[k] * float(data[k].mean() * TRADING_DAYS) for k in model},
    }
    alpha_t = float(fit.tvalues["const"])
    return FactorExposure(
        ticker=ticker,
        model=next((name for name, cols in MODELS.items() if tuple(model) == cols), "custom"),
        start=data.index[0].date(),
        end=data.index[-1].date(),
        n_obs=len(data),
        alpha_annual=attribution["alpha"],
        alpha_t=alpha_t,
        betas=betas,
        t_stats=t_stats,
        r_squared=float(fit.rsquared),
        idio_vol_annual=float(fit.resid.std() * math.sqrt(TRADING_DAYS)),
        variance_share=shares,
        return_attribution=attribution,
        dominant_driver=FACTOR_LABELS[max(shares, key=shares.get)],
        tilts=_tilts(betas, t_stats, alpha_t),
    )


def rolling_exposures(
    stock_returns: pd.Series,
    factors: pd.DataFrame,
    model: tuple[str, ...] = FF3,
    window: int = TRADING_DAYS,
    step: int = 21,
) -> pd.DataFrame:
    """Betas and annualised alpha over a rolling window (for charts of drifting exposures)."""
    data = pd.concat([stock_returns.rename("r"), factors[list(model) + ["rf"]]], axis=1, join="inner").dropna()
    y = (data["r"] - data["rf"]).to_numpy()
    X = np.column_stack([np.ones(len(data)), data[list(model)].to_numpy()])
    rows = []
    for end in range(window, len(data) + 1, step):
        coef, *_ = np.linalg.lstsq(X[end - window:end], y[end - window:end], rcond=None)
        rows.append({"date": data.index[end - 1], "alpha_annual": coef[0] * TRADING_DAYS,
                     **dict(zip(model, coef[1:]))})
    return pd.DataFrame(rows).set_index("date") if rows else pd.DataFrame(columns=["alpha_annual", *model])


def universe_exposures(u: Universe, model: tuple[str, ...] = FF3, window: int = 3 * TRADING_DAYS,
                       tickers: list[str] | None = None) -> list[FactorExposure]:
    out = []
    for t in tickers or u.tickers:
        try:
            out.append(factor_regression(u.returns[t], u.factors, model, window, ticker=t))
        except ValueError:
            continue
    return out


# =============================================================================
# 2. Momentum and mean-reversion strategies
# =============================================================================

def momentum_signal(prices: pd.DataFrame, lookback: int = TRADING_DAYS, skip: int = 21) -> pd.DataFrame:
    """Jegadeesh-Titman momentum: return from t-lookback to t-skip. Skipping the
    latest month avoids contamination by the short-term reversal effect."""
    return prices.shift(skip) / prices.shift(lookback) - 1


def reversal_signal(prices: pd.DataFrame, lookback: int = 5) -> pd.DataFrame:
    """Short-term reversal (Lehmann 1990, Jegadeesh 1990): minus the recent return,
    so recent losers score high."""
    return -(prices / prices.shift(lookback) - 1)


def bollinger_z(prices: pd.DataFrame, window: int = 20) -> pd.DataFrame:
    """Distance from the 20-day mean in standard deviations (time-series mean reversion)."""
    mean = prices.rolling(window).mean()
    return (prices - mean) / prices.rolling(window).std()


@dataclass(frozen=True)
class Strategy:
    name: str
    citation: str
    rebalance_days: int
    n_long: int
    n_short: int
    kind: str  # "momentum" | "reversal_week" | "reversal_month"

    def signal(self, prices: pd.DataFrame) -> pd.DataFrame:
        if self.kind == "momentum":
            return momentum_signal(prices)
        return reversal_signal(prices, 5 if self.kind == "reversal_week" else 21)


STRATEGIES = (
    Strategy("Momentum 12-1, long/short", "Jegadeesh & Titman (1993)", 21, 3, 3, "momentum"),
    Strategy("Momentum 12-1, long only", "Jegadeesh & Titman (1993)", 21, 3, 0, "momentum"),
    Strategy("Reversal 1-week, long/short", "Lehmann (1990)", 5, 3, 3, "reversal_week"),
    Strategy("Reversal 1-month, long/short", "Jegadeesh (1990)", 21, 3, 3, "reversal_month"),
)


def backtest_cross_sectional(
    prices: pd.DataFrame,
    signal: pd.DataFrame,
    rebalance_days: int,
    n_long: int,
    n_short: int = 0,
    cost_bps: float = 5.0,
    quantile: float | None = None,
) -> pd.DataFrame:
    """Daily returns of a rank-based portfolio: equal weight in the n_long highest and
    (short) the n_short lowest signals, re-formed every ``rebalance_days``. With
    ``quantile`` (0.1 = deciles) each leg holds that share of the stocks ranked that
    day instead. NaN signals are never held: mask stocks outside the universe with NaN.

    Weights are set from the signal at a rebalance day's close and earn returns
    from the next day on, so there is no look-ahead. Between rebalances weights are
    held at target (the usual simplification in academic backtests). Costs are
    ``cost_bps`` per unit of turnover.
    """
    returns = prices.pct_change()
    need = (2 if n_short else 1) if quantile else n_long + n_short  # names to rank before the first build
    valid = (signal.notna().sum(axis=1) >= need).to_numpy()
    dates = signal.index[valid][::rebalance_days]
    target = pd.DataFrame(np.nan, index=prices.index, columns=prices.columns)
    for d in dates:
        ranked = signal.loc[d].dropna().sort_values()
        k_long, k_short = n_long, n_short
        if quantile:
            k_long = max(1, int(len(ranked) * quantile))
            k_short = k_long if n_short else 0
        w = pd.Series(0.0, index=prices.columns)
        w[ranked.index[-k_long:]] = 1.0 / k_long
        if k_short:
            w[ranked.index[:k_short]] = -1.0 / k_short
        target.loc[d] = w
    weights = target.ffill().fillna(0.0)
    turnover = weights.diff().fillna(weights).abs().sum(axis=1)  # first build counts in full
    gross = (weights.shift(1) * returns).sum(axis=1)
    net = gross - turnover.shift(1).fillna(0.0) * cost_bps / 1e4
    out = pd.DataFrame({"gross": gross, "net": net, "turnover": turnover})
    return out.loc[dates[0]:].iloc[1:] if len(dates) else out.iloc[0:0]


def performance_stats(returns: pd.Series, rf: pd.Series | None = None, turnover: pd.Series | None = None) -> dict:
    """CAGR, volatility, Sharpe (excess of rf when given), max drawdown, turnover."""
    r = returns.dropna()
    years = len(r) / TRADING_DAYS
    wealth = (1 + r).cumprod()
    excess = r - (rf.reindex(r.index).fillna(0.0) if rf is not None else 0.0)
    vol = r.std() * math.sqrt(TRADING_DAYS)
    return {
        "start": r.index[0].date(),
        "end": r.index[-1].date(),
        "cagr": float(wealth.iloc[-1] ** (1 / years) - 1),
        "vol": float(vol),
        "sharpe": float(excess.mean() * TRADING_DAYS / vol) if vol else float("nan"),
        "max_drawdown": float((wealth / wealth.cummax() - 1).min()),
        "turnover_per_year": float(turnover.reindex(r.index).sum() / years) if turnover is not None else float("nan"),
    }


def run_strategies(u: Universe, strategies: tuple[Strategy, ...] = STRATEGIES, cost_bps: float = 5.0,
                   quantile: float | None = None) -> pd.DataFrame:
    """Backtest each strategy and the equal-weight benchmark; Carhart alpha for each.

    With point-in-time membership a stock is ranked only on sessions it is in the
    index, and the benchmark holds the members of the previous close.
    """
    prices = u.adj_close[u.tickers].dropna(how="all")
    rf = u.factors["rf"]
    rows = []
    eligible = u.eligibility()
    returns = u.returns[u.tickers]
    if eligible is not None:
        eligible = eligible.reindex(prices.index, fill_value=False)
        returns = returns.where(eligible.shift(1, fill_value=False))
    bench = returns.mean(axis=1).dropna()
    for strat in strategies:
        signal = strat.signal(prices)
        if eligible is not None:
            signal = signal.where(eligible)
        bt = backtest_cross_sectional(prices, signal, strat.rebalance_days, strat.n_long, strat.n_short, cost_bps,
                                      quantile)
        if bt.empty:
            continue
        long_short = strat.n_short > 0
        stats = performance_stats(bt["net"], None if long_short else rf, bt["turnover"])
        try:
            ff = factor_regression(bt["net"], u.factors, CARHART, window=len(bt), ticker=strat.name, excess=not long_short)
            stats.update(alpha=ff.alpha_annual, alpha_t=ff.alpha_t, mom_beta=ff.betas["mom"], mkt_beta=ff.betas["mkt_rf"])
        except ValueError:
            pass
        rows.append({"strategy": strat.name, "paper": strat.citation, **stats})
    if rows:
        bench = bench.loc[pd.Timestamp(rows[0]["start"]):]
    stats = performance_stats(bench, rf)
    ff = factor_regression(bench, u.factors, CARHART, window=len(bench), ticker="benchmark")
    rows.append({"strategy": "Equal-weight universe (benchmark)", "paper": "", **stats,
                 "alpha": ff.alpha_annual, "alpha_t": ff.alpha_t, "mom_beta": ff.betas["mom"], "mkt_beta": ff.betas["mkt_rf"]})
    return pd.DataFrame(rows).set_index("strategy")


def strategy_signals(u: Universe, as_of: pd.Timestamp | None = None, n_leg: int = 3) -> pd.DataFrame:
    """Today's (or as_of's) momentum and mean-reversion readings per eligible stock."""
    prices = u.adj_close[u.tickers].loc[:as_of] if as_of is not None else u.adj_close[u.tickers]
    prices = prices[u.eligible(prices.index[-1])]
    last = prices.index[-1]
    mom = momentum_signal(prices).loc[last]
    rev_week = -reversal_signal(prices, 5).loc[last]  # plain 5-day return
    z = bollinger_z(prices).loc[last]
    out = pd.DataFrame({"momentum_12_1": mom, "return_5d": rev_week, "bollinger_z": z})
    mom_rank = mom.rank(ascending=False)
    n = mom.notna().sum()
    out["momentum_rank"] = mom_rank.astype("Int64")
    out["reversal_rank"] = rev_week.rank(ascending=True).astype("Int64")  # 1 = biggest recent loser
    out["momentum_leg"] = np.where(mom_rank <= n_leg, "long", np.where(mom_rank > n - n_leg, "short", ""))
    out["mean_reversion"] = np.select([z <= -2, z >= 2], ["oversold", "overbought"], default="")
    return out


# =============================================================================
# 3. Fundamentals (TTM, point-in-time) and the composite score
# =============================================================================

INCOME_FIELDS = ("revenue", "net_income", "eps_diluted")
CASH_FIELDS = ("operating_cash_flow", "capital_expenditure")
STOCK_FIELDS = ("total_assets", "total_liabilities", "stockholders_equity", "total_debt",
                "cash_and_equivalents", "diluted_shares")


def _record(row: dict, quarter: int) -> dict:
    return {"report_date": pd.Timestamp(row["report_date"]), "available": pd.Timestamp(row["filing_date"]),
            "form": row["form"], "quarter": quarter, **{f: row[f] for f in STOCK_FIELDS}}


def quarterly_flows(fund: pd.DataFrame) -> pd.DataFrame:
    """One row per fiscal quarter with three-month flows.

    10-Q income statements already cover the quarter; 10-Q cash flows are usually
    year-to-date and are differenced. 10-Ks only report the full year, so Q4 =
    year minus Q1-Q3. Each 10-K closes the fiscal year that contains the 10-Qs
    filed since the previous 10-K. Quarters that can't be derived are NaN.
    """
    cols = ["report_date", "available", "form", "quarter", *INCOME_FIELDS, *CASH_FIELDS, *STOCK_FIELDS]
    if fund.empty:
        return pd.DataFrame(columns=cols)
    f = (fund.sort_values("filing_date").drop_duplicates("report_date", keep="last")
         .sort_values("report_date").reset_index(drop=True))
    numeric = [*INCOME_FIELDS, *CASH_FIELDS, *STOCK_FIELDS, "period_days", "cash_flow_period_days"]
    f[numeric] = f[numeric].apply(pd.to_numeric, errors="coerce")  # None (e.g. banks' capex) -> NaN
    annual_ends = pd.DatetimeIndex(f.loc[f.form == "10-K", "report_date"])
    year_id = annual_ends.searchsorted(pd.DatetimeIndex(f.report_date), side="left")

    # Plain dicts, not iterrows: this runs for every (stock, filing count) in a
    # 600-stock backtest, and row Series over Arrow strings are slow.
    years: dict[int, list[dict]] = {}
    for rec, y in zip(f.to_dict("records"), year_id):
        years.setdefault(int(y), []).append(rec)

    rows = []
    for _, grp in sorted(years.items()):
        quarters = {}
        for r in (x for x in grp if x["form"] == "10-Q"):
            fp = r["fiscal_period"] if isinstance(r["fiscal_period"], str) else ""
            q = int(fp[1]) if fp in {"Q1", "Q2", "Q3"} else len(quarters) + 1
            rec = _record(r, q)
            for fld in INCOME_FIELDS:
                rec[fld] = r[fld] if pd.isna(r["period_days"]) or r["period_days"] < 120 else np.nan
            prev = quarters.get(q - 1)
            for fld in CASH_FIELDS:
                ytd_reported = pd.notna(r["cash_flow_period_days"]) and r["cash_flow_period_days"] > 120
                if q == 1:
                    rec[f"_ytd_{fld}"] = r[fld]
                elif prev is not None:
                    rec[f"_ytd_{fld}"] = r[fld] if ytd_reported else prev[f"_ytd_{fld}"] + r[fld]
                else:
                    rec[f"_ytd_{fld}"] = np.nan
                rec[fld] = rec[f"_ytd_{fld}"] - (prev[f"_ytd_{fld}"] if prev is not None and q > 1 else 0.0)
            quarters[q] = rec
        annual = [x for x in grp if x["form"] == "10-K"]
        rows += quarters.values()
        if annual:
            r = annual[-1]
            rec = _record(r, 4)
            complete = all(q in quarters for q in (1, 2, 3))
            for fld in INCOME_FIELDS:
                rec[fld] = r[fld] - sum(quarters[q][fld] for q in (1, 2, 3)) if complete else np.nan
            for fld in CASH_FIELDS:
                rec[fld] = r[fld] - quarters[3][f"_ytd_{fld}"] if complete else np.nan
            rows.append(rec)
    if not rows:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(rows).sort_values("report_date").reset_index(drop=True)
    return out[cols]


def split_factor_after(splits: pd.Series, when: pd.Timestamp) -> float:
    """Product of split ratios after ``when``: converts as-reported share counts to
    today's basis (the basis of split-adjusted prices)."""
    later = splits[splits.index > when] if len(splits) else splits
    return float(later.prod()) if len(later) else 1.0


def ttm_snapshot(
    fund: pd.DataFrame, as_of: pd.Timestamp | None = None, quarterly: pd.DataFrame | None = None
) -> dict | None:
    """Trailing-twelve-month flows and the latest balance sheet, as known on ``as_of``."""
    if fund.empty:
        return None
    known = fund if as_of is None else fund[pd.to_datetime(fund.filing_date) <= as_of]
    if known.empty:
        return None
    q = quarterly if quarterly is not None else quarterly_flows(known)
    last4 = q.tail(4)
    span = (last4.report_date.iloc[-1] - last4.report_date.iloc[0]).days if len(last4) == 4 else 0
    flows = [*INCOME_FIELDS[:2], *CASH_FIELDS]
    if len(last4) == 4 and 250 <= span <= 300 and last4[["revenue", "net_income"]].notna().all().all():
        ttm = {f: float(last4[f].sum(min_count=4)) for f in flows}
        basis = "4 quarters"
    else:  # fall back to the latest annual report
        annual = known[known.form == "10-K"].sort_values("report_date")
        if annual.empty:
            return None
        a = annual.iloc[-1]
        ttm = {f: (np.nan if pd.isna(a[f]) else float(a[f])) for f in flows}
        basis = "latest 10-K"
    latest = q.iloc[-1]
    return {**ttm, "basis": basis, "period_end": latest.report_date, "available": latest.available,
            **{f: latest[f] for f in STOCK_FIELDS}}


def is_financial(sic: str | None) -> bool:
    try:
        return 6000 <= int(sic) <= 6799
    except (TypeError, ValueError):
        return False


# metric -> (pillar, higher_is_better)
METRICS = {
    "earnings_yield": ("value", True),  # TTM net income / market cap (inverse P/E)
    "fcf_yield": ("value", True),  # TTM free cash flow / market cap
    "book_to_market": ("value", True),  # equity / market cap
    "sales_yield": ("value", True),  # TTM revenue / market cap (inverse P/S)
    "roe": ("quality", True),  # TTM net income / equity
    "cash_roa": ("quality", True),  # TTM operating cash flow / assets
    "leverage": ("quality", False),  # debt / equity
    "accruals": ("quality", False),  # (net income - operating cash flow) / assets (Sloan 1996)
    "momentum_12_1": ("momentum", True),
    "momentum_6_1": ("momentum", True),
}
# Cash-flow and leverage ratios say little about banks, whose balance sheet is the business.
NOT_FOR_FINANCIALS = {"fcf_yield", "sales_yield", "cash_roa", "leverage", "accruals"}
DEFAULT_WEIGHTS = {"value": 1 / 3, "quality": 1 / 3, "momentum": 1 / 3}


def raw_metrics(u: Universe, as_of: pd.Timestamp | None = None) -> pd.DataFrame:
    """Unranked factor metrics per stock, using only information public on ``as_of``."""
    close = u.close.loc[:as_of] if as_of is not None else u.close
    adj = u.adj_close.loc[:as_of] if as_of is not None else u.adj_close
    when = close.index[-1]
    mom12 = momentum_signal(adj).loc[when]
    mom6 = momentum_signal(adj, lookback=126).loc[when]
    rows = {}
    for t in u.eligible(when):  # point in time: only index members on ``when``
        row = {"momentum_12_1": mom12.get(t), "momentum_6_1": mom6.get(t)}
        known, quarterly = u.known_fundamentals(t, when)
        snap = ttm_snapshot(known, quarterly=quarterly)
        price = close[t].dropna()
        if snap and len(price) and pd.notna(snap["diluted_shares"]):
            shares = snap["diluted_shares"] * split_factor_after(u.splits.get(t, pd.Series(dtype=float)), snap["available"])
            mcap = float(price.iloc[-1]) * shares
            equity, assets = snap["stockholders_equity"], snap["total_assets"]
            fcf = (snap["operating_cash_flow"] - snap["capital_expenditure"]
                   if pd.notna(snap["capital_expenditure"]) else np.nan)
            row.update(
                market_cap=mcap,
                earnings_yield=snap["net_income"] / mcap,
                fcf_yield=fcf / mcap,
                book_to_market=equity / mcap,
                sales_yield=snap["revenue"] / mcap,
                roe=snap["net_income"] / equity if equity and equity > 0 else np.nan,
                cash_roa=snap["operating_cash_flow"] / assets if assets else np.nan,
                leverage=snap["total_debt"] / equity if equity and equity > 0 and pd.notna(snap["total_debt"]) else np.nan,
                accruals=(snap["net_income"] - snap["operating_cash_flow"]) / assets if assets else np.nan,
                fundamentals_as_of=snap["period_end"].date(),
                ttm_basis=snap["basis"],
            )
            if is_financial(u.sic.get(t)):
                row.update({m: np.nan for m in NOT_FOR_FINANCIALS})
        rows[t] = row
    out = pd.DataFrame.from_dict(rows, orient="index", columns=["momentum_12_1", "momentum_6_1"] if not rows else None)
    for m in METRICS:
        if m not in out:
            out[m] = np.nan
    return out


def _percentile(values: pd.Series, higher_is_better: bool) -> pd.Series:
    """0 (worst) .. 1 (best) by rank: robust to outliers in a small universe."""
    s = values.astype(float) if higher_is_better else -values.astype(float)
    n = s.count()
    if n < 2:
        return pd.Series(np.nan, index=values.index)
    return (s.rank(method="average") - 1) / (n - 1)


def composite_scores(metrics: pd.DataFrame, weights: dict[str, float] | None = None) -> pd.DataFrame:
    """Rank each metric across stocks, average ranks into Value / Quality / Momentum
    pillars (0-100), then combine pillars with ``weights`` into a composite.
    Missing metrics or pillars are skipped and the remaining weights renormalised."""
    weights = weights or DEFAULT_WEIGHTS
    ranks = pd.DataFrame({m: _percentile(metrics[m], better) for m, (_, better) in METRICS.items()})
    pillars = pd.DataFrame({
        p: ranks[[m for m, (pill, _) in METRICS.items() if pill == p]].mean(axis=1) * 100
        for p in ("value", "quality", "momentum")
    })
    w = pd.Series(weights)
    known = pillars.notna()
    composite = (pillars.fillna(0) * w).sum(axis=1) / (known * w).sum(axis=1).replace(0, np.nan)
    out = pillars.round(1)
    out["composite"] = composite.round(1)
    out["rank"] = composite.rank(ascending=False, method="min").astype("Int64")
    return out.join(metrics).sort_values("composite", ascending=False)


def factor_scores(u: Universe, as_of: pd.Timestamp | None = None, weights: dict[str, float] | None = None) -> pd.DataFrame:
    return composite_scores(raw_metrics(u, as_of), weights)


def score_history(u: Universe, dates: pd.DatetimeIndex, weights: dict[str, float] | None = None) -> pd.DataFrame:
    """Point-in-time scores at each date (long format: date, ticker, pillars, composite)."""
    frames = []
    for d in dates:
        s = factor_scores(u, d, weights)[["value", "quality", "momentum", "composite"]]
        frames.append(s.assign(date=d).rename_axis("ticker").reset_index())
    return pd.concat(frames, ignore_index=True)


def information_coefficients(u: Universe, history: pd.DataFrame, horizon: int = 21) -> pd.DataFrame:
    """Spearman rank correlation of each score with the next ``horizon``-day return,
    averaged over dates (Grinold & Kahn's IC), with a t-statistic."""
    prices = u.adj_close
    fwd = prices.shift(-horizon) / prices - 1
    rows = []
    for col in ("value", "quality", "momentum", "composite"):
        ics = []
        for d, grp in history.groupby("date"):
            if d not in fwd.index:
                continue
            ret = fwd.loc[d].reindex(grp.ticker).to_numpy()
            score = grp[col].to_numpy()
            mask = ~(np.isnan(ret) | np.isnan(score))
            if mask.sum() >= 5 and np.ptp(score[mask]) > 0:  # constant scores carry no ranking
                ics.append(pd.Series(score[mask]).rank().corr(pd.Series(ret[mask]).rank()))
        ics = pd.Series(ics, dtype=float)
        sd = ics.std()
        t_stat = ics.mean() / sd * math.sqrt(len(ics)) if len(ics) > 1 and sd > 0 else float("nan")
        rows.append({"score": col, "mean_ic": ics.mean(), "t_stat": t_stat,
                     "hit_rate": (ics > 0).mean(), "months": len(ics)})
    return pd.DataFrame(rows).set_index("score")


# =============================================================================
# CLI
# =============================================================================

def _pct(x: float | None, digits: int = 1) -> str:
    return "" if x is None or pd.isna(x) else f"{100 * x:.{digits}f}%"


def _print_exposures(exposures: list[FactorExposure]) -> None:
    if not exposures:
        print("\nNo factor data: run `python -m quant.ingestion.pipeline --steps factors` first.")
        return
    e0 = exposures[0]
    print(f"\nFAMA-FRENCH {e0.model} EXPOSURES ({e0.start} to {e0.end}, daily, Newey-West t-stats)")
    names = list(e0.betas)
    header = f"{'ticker':<7}{'alpha/yr':>10}{'(t)':>7}" + "".join(f"{n + ' b':>10}" for n in names)
    print(header + f"{'R2':>6}  driven by        tilts")
    for e in exposures:
        betas = "".join(f"{e.betas[n]:>7.2f}{'*' if abs(e.t_stats[n]) >= 2 else ' ':<3}" for n in names)
        driver = f"{e.dominant_driver} ({e.variance_share[next(k for k, v in FACTOR_LABELS.items() if v == e.dominant_driver)]:.0%})"
        print(f"{e.ticker:<7}{_pct(e.alpha_annual):>10}{e.alpha_t:>7.1f}{betas}{e.r_squared:>6.2f}  {driver:<16} {', '.join(e.tilts)}")
    print("  * = |t| >= 2. Variance shares: beta x cov(factor, return) / var(return).")


def _print_strategies(table: pd.DataFrame, note: str = SURVIVORSHIP_NOTE, legs: str = "top/bottom 3") -> None:
    print(f"\nSTRATEGY BACKTESTS ({table.start.min()} to {table.end.max()}, legs {legs}, "
          f"net of 5 bps/turnover, Carhart alpha)")
    print(f"{'strategy':<36}{'CAGR':>8}{'vol':>8}{'Sharpe':>8}{'maxDD':>9}{'turn/yr':>9}{'alpha':>9}{'(t)':>6}{'mom b':>7}")
    for name, r in table.iterrows():
        turn = "" if pd.isna(r.turnover_per_year) else f"{r.turnover_per_year:.1f}x"
        print(f"{name:<36}{_pct(r.cagr):>8}{_pct(r.vol):>8}{r.sharpe:>8.2f}{_pct(r.max_drawdown):>9}{turn:>9}"
              f"{_pct(r.alpha):>9}{r.alpha_t:>6.1f}{r.mom_beta:>7.2f}")
    print(f"  {note}")


def _print_signals(sig: pd.DataFrame, of: int | None = None) -> None:
    print("\nCURRENT SIGNALS" + (f" (watchlist names, ranked among {of} index members)" if of else ""))
    print(f"{'ticker':<7}{'mom 12-1':>10}{'rank':>6}{'leg':>7}{'5d ret':>9}{'rev rank':>10}{'boll z':>8}  state")
    for t, r in sig.sort_values("momentum_rank").iterrows():
        print(f"{t:<7}{_pct(r.momentum_12_1):>10}{r.momentum_rank:>6}{r.momentum_leg:>7}{_pct(r.return_5d):>9}"
              f"{r.reversal_rank:>10}{r.bollinger_z:>8.2f}  {r.mean_reversion}")


def _print_scores(scores: pd.DataFrame, as_of, within: str = "the watchlist") -> None:
    print(f"\nCOMPOSITE FACTOR SCORES (as of {as_of}; 0-100 percentile within {within}, equal pillar weights)")
    print(f"{'#':>3} {'ticker':<7}{'value':>7}{'quality':>9}{'momentum':>10}{'composite':>11}   "
          f"{'E/P':>6}{'FCF/P':>7}{'B/M':>6}{'ROE':>7}{'D/E':>6}{'mom12-1':>9}  fundamentals")
    for t, r in scores.iterrows():
        de = "" if pd.isna(r.leverage) else f"{r.leverage:.2f}"
        bm = "" if pd.isna(r.book_to_market) else f"{r.book_to_market:.2f}"
        fund = f"{r.fundamentals_as_of} ({r.ttm_basis})" if pd.notna(r.get("fundamentals_as_of")) else "n/a"
        print(f"{r['rank']:>3} {t:<7}{r.value:>7.0f}{r.quality:>9.0f}{r.momentum:>10.0f}{r.composite:>11.0f}   "
              f"{_pct(r.earnings_yield):>6}{_pct(r.fcf_yield):>7}{bm:>6}{_pct(r.roe, 0):>7}{de:>6}{_pct(r.momentum_12_1, 0):>9}  {fund}")


def main(argv: list[str] | None = None) -> int:
    from quant.config import get_settings
    from quant.db import init_db, session_scope

    settings = get_settings()
    parser = argparse.ArgumentParser(description="Factor exposures, strategy backtests and composite scores.")
    parser.add_argument("--tickers", nargs="+", help="override the watchlist")
    parser.add_argument("--universe", choices=("watchlist", "sp500"), default=None,
                        help="research universe (default: RESEARCH_UNIVERSE, else watchlist); sp500 = point-in-time members")
    parser.add_argument("--no-pit", action="store_true",
                        help="with an index: rank today's members over all history (survivorship-biased comparison)")
    parser.add_argument("--quantile", type=float, default=None,
                        help="strategy leg size as a share of ranked stocks (default: deciles for sp500, top/bottom 3 otherwise)")
    parser.add_argument("--model", choices=("ff3", "carhart"), default="ff3")
    parser.add_argument("--window", type=int, default=3 * TRADING_DAYS, help="regression window in trading days")
    parser.add_argument("--evaluate", action="store_true", help="monthly score history and information coefficients")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")

    watchlist = [t.upper() for t in args.tickers] if args.tickers else list(settings.equities)
    universe = args.universe or settings.research_universe
    index = None if universe == "watchlist" else universe
    with session_scope(init_db()) as session:
        u = load_universe(session, watchlist, index=index, point_in_time=not args.no_pit)
    quantile = args.quantile if args.quantile is not None else (0.1 if index else None)
    legs = f"{quantile:.0%} of ranked stocks each" if quantile else "top/bottom 3"
    last = u.close.index[-1]
    today = u.eligible(last)
    shown = [t for t in watchlist if t in today] if index else u.tickers
    if index and u.point_in_time:
        print(f"UNIVERSE: point-in-time {INDEX_LABELS.get(index, index)}: {len(u.tickers)} stocks were members while "
              f"prices are stored ({u.close.index[0].date()} to {last.date()}), {len(today)} today; "
              f"{u.coverage():.1%} of member-days have prices")
    elif index:
        print(f"UNIVERSE: today's {len(today)} {INDEX_LABELS.get(index, index)} members over all history (hindsight)")

    _print_exposures(universe_exposures(u, CARHART if args.model == "carhart" else FF3, args.window, tickers=shown))
    _print_strategies(run_strategies(u, quantile=quantile), u.note(), legs)
    n_leg = max(1, int(len(today) * quantile)) if quantile else 3
    _print_signals(strategy_signals(u, n_leg=n_leg).reindex(shown), of=len(today) if index else None)
    scores = factor_scores(u)
    if index:
        scores = scores[(scores["rank"] <= 10) | scores.index.isin(shown)]
    _print_scores(scores, last.date(), f"{len(today)} {INDEX_LABELS.get(index, index)} members (top 10 + watchlist)"
                  if index else "the watchlist")

    if args.evaluate:
        month_ends = u.close.resample("ME").last().index
        dates = [u.close.index[u.close.index.searchsorted(d, side="right") - 1] for d in month_ends]
        history = score_history(u, pd.DatetimeIndex(dates[13:]))
        ic = information_coefficients(u, history)
        breadth = history.groupby("date").size()
        print(f"\nSCORE PREDICTIVENESS: rank IC vs next-21-day return, {ic.months.iloc[0]} monthly cross-sections "
              f"of {breadth.min()}-{breadth.max()} stocks")
        for name, r in ic.iterrows():
            print(f"  {name:<10} mean IC {r.mean_ic:+.3f}  t {r.t_stat:+.2f}  positive in {r.hit_rate:.0%} of months")
        if index:
            print(f"  |t| >= 2 is the usual bar for evidence. {u.note()}")
        else:
            print(f"  With 10 stocks a single month's IC is very noisy; |t| < 2 means no reliable evidence. {SURVIVORSHIP_NOTE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
