"""Offline tests for the Phase 4 bot, scheduler and price-history rebasing."""

from __future__ import annotations

import math
from datetime import date, datetime

import numpy as np
import pandas as pd
import pytest
from apscheduler.schedulers.background import BackgroundScheduler

from quant import analytics as an
from quant import quant_models as qm
from quant import trading_bot as tb
from quant.db import init_db, make_engine, session_scope, upsert
from quant.ingestion.market_data import history_rebased
from quant.models import PriceBar, Trade

P = tb.BotParams()


def _ctx(closes: dict[str, np.ndarray], start="2025-01-02", trend="Bull", stance="Risk-On", news=None) -> tb.MarketContext:
    idx = pd.bdate_range(start, periods=len(next(iter(closes.values()))))
    bars = {}
    for t, c in closes.items():
        c = np.asarray(c, dtype=float)
        df = pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "adj_close": c, "volume": 1e6},
                          index=idx)
        ind = an.add_indicators(df)
        ind["vol"] = ind["return_1d"].rolling(60).std() * math.sqrt(252)
        bars[t] = ind
    close = pd.DataFrame({t: b["close"] for t, b in bars.items()})
    universe = qm.Universe(tickers=list(closes), close=close, adj_close=close, fundamentals={}, splits={}, sic={},
                           factors=pd.DataFrame())
    regime = pd.DataFrame({"regime": f"{trend} Trending", "trend": trend, "stance": stance}, index=idx)
    if news is None:
        news = pd.DataFrame({"ticker": pd.Series(dtype=str), "published_at": pd.Series(dtype="datetime64[us]"),
                             "sentiment_score": pd.Series(dtype=float), "title": pd.Series(dtype=str)})
    return tb.MarketContext(universe=universe, bars=bars, regime=regime, news=news, benchmark=close.iloc[:, 0])


def _trending(n=300, wiggle=0.0):
    rng = np.random.default_rng(0)
    up = 100 * np.cumprod(1 + 0.002 + rng.normal(0, 0.01, n))
    down = 100 * np.cumprod(1 - 0.002 + rng.normal(0, 0.01, n))
    return {"UP": up, "DOWN": down}


# --- broker ---------------------------------------------------------------------------

def test_broker_accounting_round_trip():
    state = tb.PortfolioState(cash=10_000.0)
    broker = tb.PaperBroker(state, P)
    buy = broker.buy(date(2026, 1, 2), "X", 10, 100.0, "entry", "why", None, stop=90.0)
    assert buy.price == pytest.approx(100.05) and state.cash == pytest.approx(10_000 - 1000.5)
    broker.buy(date(2026, 1, 3), "X", 10, 110.0, "add", "why", None)
    assert state.holdings["X"].avg_cost == pytest.approx((1000.5 + 1100.55) / 20)
    trim = broker.sell(date(2026, 1, 4), "X", 5, 120.0, "trim", "why")
    assert trim.position_pnl is None and trim.realized_pnl > 0
    exit_ = broker.sell(date(2026, 1, 5), "X", 15, 120.0, "exit", "why")
    assert "X" not in state.holdings
    total_pnl = trim.realized_pnl + exit_.realized_pnl
    assert exit_.position_pnl == pytest.approx(total_pnl)
    assert exit_.position_return == pytest.approx(total_pnl / (1000.5 + 1100.55))


def test_broker_never_spends_more_than_cash():
    state = tb.PortfolioState(cash=500.0)
    fill = tb.PaperBroker(state, P).buy(date(2026, 1, 2), "X", 100, 100.0, "entry", "why", None)
    assert fill.shares == 4 and state.cash >= 0


def test_apply_split():
    h = tb.Holding("X", 10, 500.0, date(2026, 1, 2), 500.0, 450.0, 520.0)
    tb.apply_split(h, 10.0)
    assert (h.shares, h.avg_cost, h.stop, h.highest_close) == (100, 50.0, 45.0, 52.0)


# --- sizing and stops ------------------------------------------------------------------------

def test_vol_parity_weights_are_inverse_vol_and_capped():
    w, note = tb.size_positions({"A": 0.2, "B": 0.4}, gross=0.3, p=P)
    assert w["A"] == pytest.approx(0.2) and w["B"] == pytest.approx(0.1)
    assert note == "volatility parity"
    w, _ = tb.size_positions({"A": 0.1, "B": 0.5}, gross=1.0, p=P)
    assert w["A"] == pytest.approx(P.max_weight)  # capped; the excess stays in cash


def test_kelly_formula_and_scaling():
    stats = tb.kelly_stats([0.10] * 10 + [-0.05] * 10, min_trades=20)
    assert stats["win_rate"] == 0.5 and stats["payoff"] == pytest.approx(2.0)
    assert stats["kelly"] == pytest.approx(0.5 - 0.5 / 2.0)
    p = tb.BotParams(sizing="kelly")
    w, note = tb.size_positions({"A": 0.2, "B": 0.4}, gross=1.0, p=p, kelly=stats)
    assert w["A"] == pytest.approx(0.5 * 0.25 * 0.3 / 0.2)  # half Kelly x median vol / vol
    assert "Kelly" in note
    assert tb.kelly_stats([0.1] * 5, min_trades=20) is None
    _, note = tb.size_positions({"A": 0.2}, gross=1.0, p=p, kelly=None)
    assert note.startswith("volatility parity")


def test_initial_stop_respects_max_loss():
    assert tb.initial_stop(100.0, 2.0, P) == pytest.approx(100.0 - P.atr_multiple * 2.0)  # k x ATR
    assert tb.initial_stop(100.0, 10.0, P) == pytest.approx(85.0)  # capped at 15% loss


def _held_ctx(lows, opens, closes):
    """30 flat sessions, with the given lows/opens/closes on the last ones."""
    ctx = _ctx({"X": np.full(30, 100.0)})
    df = ctx.bars["X"]
    n = len(closes)
    df.iloc[-n:, df.columns.get_loc("low")] = lows
    df.iloc[-n:, df.columns.get_loc("open")] = opens
    df.iloc[-n:, df.columns.get_loc("close")] = closes
    df["atr_14"] = 2.0
    return ctx


def test_stop_fills_at_stop_or_gap_open():
    ctx = _held_ctx([99, 94], [100, 97], [100, 96])
    state = tb.PortfolioState(cash=0.0, holdings={"X": tb.Holding("X", 10, 100.0, date(2025, 1, 2), 100.0, 95.0, 100.0)})
    res = tb.run_day(state, ctx, ctx.sessions[-1], P, trade=False)
    assert res.fills[0].reason == "stop" and res.fills[0].price == pytest.approx(95.0 * (1 - 5 / 1e4))

    ctx = _held_ctx([99, 88], [100, 90], [100, 89])  # gapped below the stop
    state = tb.PortfolioState(cash=0.0, holdings={"X": tb.Holding("X", 10, 100.0, date(2025, 1, 2), 100.0, 95.0, 100.0)})
    res = tb.run_day(state, ctx, ctx.sessions[-1], P, trade=False)
    assert res.fills[0].price == pytest.approx(90.0 * (1 - 5 / 1e4))
    assert "gapped" in res.fills[0].rationale


def test_trailing_stop_only_ratchets_up():
    ctx = _held_ctx([99, 109, 106], [100, 110, 107], [100, 110, 105])  # last low stays above the ratcheted stop
    state = tb.PortfolioState(cash=0.0, holdings={"X": tb.Holding("X", 10, 100.0, date(2025, 1, 2), 100.0, 95.0, 100.0)})
    tb.run_day(state, ctx, ctx.sessions[-2], P, trade=False)
    assert state.holdings["X"].stop == pytest.approx(110 - P.atr_multiple * 2.0)
    tb.run_day(state, ctx, ctx.sessions[-1], P, trade=False)
    assert state.holdings["X"].stop == pytest.approx(110 - P.atr_multiple * 2.0)  # did not fall with the lower close


# --- signals -------------------------------------------------------------------------------

def test_sentiment_is_recency_weighted_and_needs_enough_headlines():
    cutoff = pd.Timestamp("2026-10-16 20:00")
    news = pd.DataFrame({"ticker": "X", "title": ["old bad", "fresh good"],
                         "published_at": pd.to_datetime(["2026-10-10 12:00", "2026-10-16 12:00"]),
                         "sentiment_score": [-0.8, 0.8]})
    score, details = tb.sentiment_component(news, "X", cutoff, P)
    assert score > 0 and details["headlines"] == 2 and details["lead_headline"] == "fresh good"
    score, details = tb.sentiment_component(news.iloc[1:], "X", cutoff, P)
    assert score == 0 and details["headlines"] == 1


def test_fundamental_health_flag_caps_the_component():
    row = pd.Series({"quality": 90.0, "earnings_yield": -0.01, "cash_roa": 0.05})
    value, details = tb.fundamentals_component(row, pd.DataFrame())
    assert value == -0.5 and "loss-making" in details["health_flag"]


def test_signals_buy_uptrend_and_skip_downtrend():
    ctx = _ctx(_trending())
    when = ctx.sessions[-1]
    regime = ctx.regime.loc[when]
    up = tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=P)
    down = tb.make_signal(ctx, "DOWN", when, held=True, regime=regime, p=P)
    assert up.action == "BUY" and up.components["trend"] == pytest.approx(1.0)
    assert "50 MA" in up.rationale and up.rationale.startswith("Buy UP")
    assert down.action == "SELL" and "trend broke" in down.rationale


def test_bear_regime_blocks_new_buys():
    ctx = _ctx(_trending(), trend="Bear", stance="Risk-Off")
    when = ctx.sessions[-1]
    s = tb.make_signal(ctx, "UP", when, held=False, regime=ctx.regime.loc[when], p=P)
    assert s.action == "HOLD" and "Bear" in s.rationale


def test_regime_labels_can_block_new_buys():
    ctx = _ctx(_trending(), stance="Risk-Off")
    ctx.regime["volatility"] = "Volatile"
    when = ctx.sessions[-1]
    regime = ctx.regime.loc[when]
    assert tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=P).action == "BUY"  # off by default
    for label in ("Volatile", "Risk-Off"):
        p = tb.BotParams(block_entries_when=(label,))
        s = tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=p)
        assert s.action == "HOLD" and f"new buys blocked: {label} market regime" in s.rationale
        assert tb.make_signal(ctx, "UP", when, held=True, regime=regime, p=p).action == "HOLD"  # holdings untouched
    p = tb.BotParams(block_entries_when=("Volatile",))
    ctx.regime["volatility"] = "Normal"
    assert tb.make_signal(ctx, "UP", when, held=False, regime=ctx.regime.loc[when], p=p).action == "BUY"


def test_entry_above_50_day_ma():
    p = tb.BotParams(entry_above_sma50=True)
    ctx = _ctx(_trending())
    when = ctx.sessions[-1]
    last = ctx.bars["UP"].iloc[-1]
    assert last.sma_200 < last.close < last.sma_50  # a dip inside the up-trend
    regime = ctx.regime.loc[when]
    assert tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=P).action == "BUY"
    s = tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=p)
    assert s.action == "HOLD" and "price below its 50-day MA" in s.rationale

    closes = _trending()
    closes["UP"][-1] = 1.05 * ctx.bars["UP"].sma_50.iloc[-1]
    ctx = _ctx(closes)
    assert tb.make_signal(ctx, "UP", when, held=False, regime=regime, p=p).action == "BUY"


def test_stop_cooldown_counts_recent_stop_outs():
    sessions = pd.bdate_range("2025-01-02", periods=30)
    when = sessions[-1]
    p = tb.BotParams(cooldown_stops=2, cooldown_window=10)
    state = tb.PortfolioState(cash=0.0, stop_dates=[sessions[-10].date(), sessions[-2].date()])
    assert tb.stop_cooldown(state, sessions, when, p) == "cool-down after 2 stop-outs in 10 sessions"
    assert tb.stop_cooldown(state, sessions, when, P) == ""  # off by default
    state.stop_dates[0] = sessions[-11].date()  # outside the window
    assert tb.stop_cooldown(state, sessions, when, p) == ""


def test_cooldown_pauses_entries_but_not_holdings():
    ctx = _ctx(_trending())
    p = tb.BotParams(cooldown_stops=2)
    recent = [ctx.sessions[-3].date(), ctx.sessions[-2].date()]
    state = tb.PortfolioState(cash=100_000.0, stop_dates=list(recent))
    res = tb.run_day(state, ctx, ctx.sessions[-1], p)
    assert res.fills == [] and not state.holdings
    up = next(s for s in res.signals if s.ticker == "UP")
    assert up.action == "HOLD" and "cool-down after 2 stop-outs" in up.rationale
    state = tb.PortfolioState(cash=100_000.0, stop_dates=list(recent))
    res = tb.run_day(state, ctx, ctx.sessions[-1], P)  # default: buys as before
    assert [f.ticker for f in res.fills] == ["UP"]


def test_stop_outs_are_recorded_for_the_cooldown(tmp_path):
    ctx = _held_ctx([99, 94], [100, 97], [100, 96])
    state = tb.PortfolioState(cash=0.0, holdings={"X": tb.Holding("X", 10, 100.0, date(2025, 1, 2), 100.0, 95.0, 100.0)})
    tb.run_day(state, ctx, ctx.sessions[-1], P, trade=False)
    assert state.stop_dates == [ctx.sessions[-1].date()]

    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'cd.db').as_posix()}"))
    with session_scope(engine) as s:  # the live ledger restores them
        pf = tb.get_portfolio(s, tb.LIVE)
        day = tb.DayResult(ctx.sessions[-1].date(), [], [], state.cash, 0.0, state.cash, None, None)
        day.fills = [tb.Fill(ctx.sessions[-1].date(), "X", "SELL", 10, 95.0, "stop", "why", realized_pnl=-50.0)]
        tb.save_days(s, pf, state, [day])
    with session_scope(engine) as s:
        assert tb.load_state(s, tb.get_portfolio(s, tb.LIVE, create=False)).stop_dates == [ctx.sessions[-1].date()]


def test_run_day_builds_a_capped_book_with_rationales():
    ctx = _ctx(_trending())
    state = tb.PortfolioState(cash=100_000.0)
    res = tb.run_day(state, ctx, ctx.sessions[-1], P)
    assert [f.ticker for f in res.fills] == ["UP"]
    fill = res.fills[0]
    assert fill.reason == "entry" and fill.rationale.startswith("Bought UP")
    assert fill.value / 100_000 <= P.max_weight + 1e-9
    assert state.holdings["UP"].stop < fill.price and state.cash > 0


def test_risk_off_trims_exposure():
    p = tb.BotParams(max_weight=1.0)  # let regime exposure, not the per-name cap, decide
    ctx = _ctx(_trending(), stance="Risk-On")
    state = tb.PortfolioState(cash=100_000.0)
    tb.run_day(state, ctx, ctx.sessions[-2], p)
    before = state.holdings["UP"].shares
    ctx.regime["stance"] = "Risk-Off"
    res = tb.run_day(state, ctx, ctx.sessions[-1], p)
    assert [f.reason for f in res.fills] == ["trim"] and "Risk-Off exposure 35%" in res.fills[0].rationale
    weight = state.holdings["UP"].shares * ctx.bars["UP"].close.iloc[-1] / res.equity
    assert state.holdings["UP"].shares < before and weight == pytest.approx(0.35, abs=0.01)


# --- ledger ---------------------------------------------------------------------------------

def test_run_live_persists_and_is_idempotent(tmp_path):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'bot.db').as_posix()}"))
    ctx = _ctx(_trending())
    with session_scope(engine) as s:
        days = tb.run_live(s, ["UP", "DOWN"], P, ctx=ctx)
        assert len(days) == 1 and days[0].fills
    with session_scope(engine) as s:
        assert tb.run_live(s, ["UP", "DOWN"], P, ctx=ctx) == []  # same session: nothing to do
        pf = tb.get_portfolio(s, tb.LIVE, create=False)
        assert pf.last_run_date == ctx.sessions[-1].date()
        trades = s.query(Trade).all()
        assert trades[0].rationale.startswith("Bought UP") and '"components"' in trades[0].signal
        state = tb.load_state(s, pf)
        assert "UP" in state.holdings and state.cash == pytest.approx(pf.cash)


def test_backtest_saves_and_replaces_its_portfolio(tmp_path):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'bt.db').as_posix()}"))
    ctx = _ctx(_trending(400))
    result = tb.backtest(ctx, P, str(ctx.sessions[260].date()), signal_every=5)
    assert len(result.equity) == 140 and result.fills
    assert result.equity.iloc[-1] == pytest.approx(result.final_state.cash + result.days[-1].holdings_value)
    with session_scope(engine) as s:
        tb.save_backtest(s, result)
        tb.save_backtest(s, result)  # re-saving replaces, never duplicates
    with session_scope(engine) as s:
        pf = tb.get_portfolio(s, tb.BACKTEST, create=False)
        n_trades = s.query(Trade).filter(Trade.portfolio_id == pf.id).count()
        assert n_trades == len(result.fills)
        assert tb.portfolio_status(s, tb.BACKTEST) is not None


# --- price history rebasing -------------------------------------------------------------------

def test_history_rebased_detects_split_and_dividend(tmp_path):
    engine = init_db(make_engine(f"sqlite:///{(tmp_path / 'px.db').as_posix()}"))
    idx = pd.bdate_range("2026-10-05", periods=5)
    stored = [{"ticker": "X", "interval": "1d", "timestamp": t.to_pydatetime(), "open": 100.0, "high": 100.0,
               "low": 100.0, "close": 100.0, "adj_close": 99.0, "volume": 1} for t in idx]
    with session_scope(engine) as s:
        upsert(s, PriceBar, stored, ["ticker", "interval", "timestamp"])

    def fresh(close, adj):
        return pd.DataFrame({"timestamp": idx, "open": close, "high": close, "low": close,
                             "close": close, "adj_close": adj, "volume": 1})

    with session_scope(engine) as s:
        assert not history_rebased(s, "X", fresh(100.0, 99.0))
        assert history_rebased(s, "X", fresh(10.0, 9.9))  # 10-for-1 split
        assert history_rebased(s, "X", fresh(100.0, 98.5))  # new dividend rescaled adj_close
        last_only = fresh(100.0, 99.0)
        last_only.loc[4, "close"] = 103.0  # the latest bar may have been captured mid-session
        assert not history_rebased(s, "X", last_only)


# --- scheduler -----------------------------------------------------------------------------------

def test_scheduler_jobs():
    from quant import scheduler

    sched = scheduler.build_scheduler(BackgroundScheduler(timezone=scheduler.EASTERN))
    jobs = {j.id: j for j in sched.get_jobs()}
    assert set(jobs) == {"daily_cycle", "news_refresh", "weekly_backtest"}
    monday = datetime(2026, 10, 19, 9, 0, tzinfo=scheduler.EASTERN)
    nxt = jobs["daily_cycle"].trigger.get_next_fire_time(None, monday)
    assert (nxt.weekday(), nxt.hour, nxt.minute) == (0, 17, 30)
    friday_night = datetime(2026, 10, 23, 18, 0, tzinfo=scheduler.EASTERN)
    assert jobs["daily_cycle"].trigger.get_next_fire_time(None, friday_night).weekday() == 0  # skips the weekend
