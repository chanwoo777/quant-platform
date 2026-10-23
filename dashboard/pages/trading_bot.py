"""Live Trading Bot: portfolio, positions, today's signals, and the trade ledger."""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from dashboard import common as c

st.title("Live Trading Bot")
pal = c.palette()

names = c.portfolio_names()
if not names:
    st.info("No portfolio yet. Run `python -m quant.trading_bot run` (or start `python -m quant.scheduler`).")
    st.stop()
label = {"paper": "Paper (live)", "backtest": "Backtest 2018-"}
name = st.segmented_control("Portfolio", names, default="paper" if "paper" in names else names[0],
                            format_func=lambda n: label.get(n, n), key="bot_portfolio") or names[0]
data = c.portfolio(name)
info, snaps, positions, trades, signals = (data[k] for k in ("info", "snapshots", "positions", "trades", "signals"))
params = info["params"]

# --- KPIs --------------------------------------------------------------------------------------
pos = positions.copy()
pos["last"] = pos.ticker.map(data["last_close"]).fillna(pos.avg_cost) if len(pos) else []
pos["value"] = pos.shares * pos["last"] if len(pos) else []
equity = info["cash"] + (pos["value"].sum() if len(pos) else 0.0)
ret = equity / info["initial_cash"] - 1
spy_ret = None
if len(snaps):
    spy = data["spy"].loc[pd.Timestamp(snaps.date.iloc[0]):]
    spy_ret = spy.iloc[-1] / spy.iloc[0] - 1 if len(spy) > 1 else 0.0
closed = trades.position_return.dropna() if len(trades) else pd.Series(dtype=float)
wins, losses = closed[closed > 0], closed[closed <= 0]

k = st.columns(6)
k[0].metric("Equity", f"${equity:,.0f}", border=True, help=f"Started with ${info['initial_cash']:,.0f}")
k[1].metric("Total return", c.pct(ret, 2), None if spy_ret is None else f"SPY {c.pct(spy_ret, 2)} same period",
            delta_color="off", delta_arrow="off", border=True)
k[2].metric("Cash", c.pct(info["cash"] / equity, 0, sign=False), border=True)
k[3].metric("Open positions", len(pos), border=True, help=f"Max {params.get('max_positions', '?')} names, "
            f"{c.pct(params.get('max_weight', np.nan), 0, sign=False)} each")
k[4].metric("Closed trades", len(closed), f"{len(trades)} fills in total", delta_color="off", delta_arrow="off", border=True)
k[5].metric("Win rate", c.pct(len(wins) / len(closed), 0, sign=False) if len(closed) else "–",
            f"payoff {wins.mean() / abs(losses.mean()):.2f}" if len(wins) and len(losses) else None,
            delta_color="off", delta_arrow="off", border=True, help="Payoff = average win / average loss")
st.caption(f"Last session processed: {info['last_run_date']} · sizing: {params.get('sizing', 'vol_parity')} · "
           f"stops {params.get('atr_multiple', '?')}x ATR, max loss {c.pct(params.get('max_loss', np.nan), 0, sign=False)} · "
           "market-on-close fills with 5 bps slippage. Paper trading, not investment advice.")

# --- equity curve -------------------------------------------------------------------------------
st.subheader("Equity vs SPY")
if len(snaps) < 2:
    st.info("The equity curve appears after the bot has processed a second session "
            f"(so far: {len(snaps)}). The scheduler runs it every weekday at 17:30 New York time.")
else:
    s = snaps.set_index(pd.DatetimeIndex(snaps.date))
    spy = data["spy"].reindex(s.index).ffill()
    idx = pd.DataFrame({"Bot": 100 * s.equity / s.equity.iloc[0], "SPY": 100 * spy / spy.iloc[0]})
    dd = s.equity / s.equity.cummax() - 1
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, row_heights=[0.72, 0.28], vertical_spacing=0.04)
    for i, col in enumerate(idx):
        fig.add_trace(go.Scatter(x=idx.index, y=idx[col], name=col, line=dict(color=pal["series"][i], width=2),
                                 hovertemplate="%{y:.1f}"), row=1, col=1)
        fig.add_annotation(x=idx.index[-1], y=idx[col].iloc[-1], text=f"{col} {idx[col].iloc[-1]:.0f}", showarrow=False,
                           xanchor="left", xshift=6, font=dict(color=pal["ink2"], size=11), row=1, col=1)
    fig.add_hline(y=100, line=dict(color=pal["axis"], width=1), row=1, col=1)
    fig.add_trace(go.Scatter(x=dd.index, y=dd, name="Bot drawdown", fill="tozeroy", showlegend=False,
                             line=dict(color=pal["series"][0], width=1), hovertemplate="%{y:.1%}"), row=2, col=1)
    fig.update_xaxes(type="date")
    fig.update_yaxes(title_text="Growth of 100", row=1, col=1, title_font=dict(size=11))
    fig.update_yaxes(title_text="Drawdown", tickformat=".0%", row=2, col=1, title_font=dict(size=11))
    c.show(c.style(fig, height=460), key="equity")

# --- positions ----------------------------------------------------------------------------------
st.subheader("Open positions")
if len(pos):
    st.dataframe(
        pd.DataFrame({
            "Ticker": pos.ticker, "Shares": pos.shares, "Avg cost": pos.avg_cost, "Last": pos["last"],
            "Value": pos["value"], "Weight": 100 * pos["value"] / equity,
            "P&L ($)": (pos["last"] - pos.avg_cost) * pos.shares, "P&L %": 100 * (pos["last"] / pos.avg_cost - 1),
            "Stop": pos.stop_price, "To stop": 100 * (pos.stop_price / pos["last"] - 1), "Since": pos.entry_date,
        }).sort_values("Value", ascending=False),
        hide_index=True, width="stretch", placeholder="–",
        column_config={
            "Shares": st.column_config.NumberColumn(format="%g"),
            "Avg cost": st.column_config.NumberColumn(format="%.2f"), "Last": st.column_config.NumberColumn(format="%.2f"),
            "Value": st.column_config.NumberColumn(format="$%,.0f"),
            "Weight": st.column_config.ProgressColumn(color="blue", min_value=0, max_value=100 * params.get("max_weight", 0.2),
                                                      format="%.1f%%"),
            "P&L ($)": st.column_config.NumberColumn(format="%+,.0f"), "P&L %": st.column_config.NumberColumn(format="%+.1f%%"),
            "Stop": st.column_config.NumberColumn(format="%.2f", help="Trailing: highest close − k × ATR"),
            "To stop": st.column_config.NumberColumn(format="%+.1f%%", help="Distance from the last close to the stop"),
        },
    )
else:
    st.info("No open positions.")

# --- today's signals ----------------------------------------------------------------------------
st.subheader("Latest signals")
if len(signals):
    weights = {k: params.get(f"w_{k}", 0.25) for k in ("trend", "fundamentals", "valuation", "sentiment")}
    sig = signals.sort_values("score")
    fig = go.Figure()
    for i, (comp, w) in enumerate(weights.items()):
        fig.add_trace(go.Bar(y=sig.ticker, x=w * sig[comp], name=f"{comp.capitalize()} ({w:.0%})", orientation="h",
                             marker=dict(color=pal["series"][i], line=dict(color=pal["surface"], width=1)),
                             hovertemplate="%{y}: %{x:+.2f}<extra>" + comp + "</extra>"))
    fig.add_trace(go.Scatter(y=sig.ticker, x=sig.score, mode="markers", name="Score",
                             marker=dict(symbol="line-ns-open", size=16, color=pal["ink"], line=dict(width=2)),
                             hovertemplate="%{y}: score %{x:+.2f}<extra></extra>"))
    for x, text in ((params.get("buy_threshold", 0.25), "buy"), (params.get("sell_threshold", -0.1), "sell")):
        fig.add_vline(x=x, line=dict(color=pal["muted"], width=1),
                      annotation=dict(text=text, font=dict(color=pal["muted"], size=11)))
    fig.update_layout(barmode="relative", bargap=0.35)
    st.caption(f"Signals for {signals.date.iloc[0]}: each bar is a component's weighted contribution; the black tick "
               "is the total score. BUY needs score ≥ the buy line and an up-trend.")
    c.show(c.style(fig, height=60 + 34 * len(sig), hovermode="closest"), key="signals")
    st.dataframe(
        pd.DataFrame({"Ticker": signals.ticker, "Action": signals.action, "Score": signals.score,
                      "Rationale": signals.rationale}),
        hide_index=True, width="stretch", placeholder="–",
        column_config={"Score": st.column_config.NumberColumn(format="%+.2f"),
                       "Rationale": st.column_config.TextColumn(width="large")},
    )
else:
    st.info("Signals are stored for the live portfolio only.")

# --- trade ledger -------------------------------------------------------------------------------
st.subheader("Trade ledger")
if len(trades):
    f1, f2, f3 = st.columns([2, 1, 2])
    pick = f1.multiselect("Tickers", sorted(trades.ticker.unique()), key="ledger_tickers")
    side = f2.pills("Side", ["BUY", "SELL"], selection_mode="multi", key="ledger_side")
    reason = f3.pills("Reason", sorted(trades.reason.unique()), selection_mode="multi", key="ledger_reason")
    view = trades
    if pick:
        view = view[view.ticker.isin(pick)]
    if side:
        view = view[view.side.isin(side)]
    if reason:
        view = view[view.reason.isin(reason)]
    table = pd.DataFrame({
        "Date": view.trade_date, "Side": view.side, "Ticker": view.ticker, "Shares": view.shares, "Price": view.price,
        "Value": view.value, "Reason": view.reason, "Round-trip return": 100 * view.position_return,
        "Rationale": view.rationale,
    })
    st.dataframe(
        table, hide_index=True, width="stretch", placeholder="–", height=380,
        column_config={
            "Shares": st.column_config.NumberColumn(format="%g"), "Price": st.column_config.NumberColumn(format="%.2f"),
            "Value": st.column_config.NumberColumn(format="$%,.0f"),
            "Round-trip return": st.column_config.NumberColumn(format="%+.1f%%", help="On the fill that closed the position"),
            "Rationale": st.column_config.TextColumn(width="large"),
        },
    )
    st.download_button("Download ledger (CSV)", table.to_csv(index=False).encode("utf-8"),
                       file_name=f"{name}_ledger.csv", mime="text/csv", icon=":material/download:")

# --- closed trade distribution --------------------------------------------------------------------
if len(closed) >= 5:
    st.subheader("Closed trades")
    left, right = st.columns([2, 1], gap="large")
    with left:
        r = 100 * closed
        bins = np.arange(np.floor(r.min() / 2) * 2, np.ceil(r.max() / 2) * 2 + 2, 2.0)
        counts, edges = np.histogram(r, bins=bins)
        mids = (edges[:-1] + edges[1:]) / 2
        fig = go.Figure(go.Bar(x=mids, y=counts, marker=dict(color=np.where(mids > 0, pal["up"], pal["down"]),
                                                              line=dict(color=pal["surface"], width=2)),
                               hovertemplate="%{x:+.0f}% ±1: %{y} trades<extra></extra>"))
        fig.update_xaxes(ticksuffix="%", title_text="Round-trip return", title_font=dict(size=11))
        fig.update_yaxes(title_text="Trades", title_font=dict(size=11))
        c.show(c.style(fig, height=300, hovermode="closest", legend=False), key="hist")
    with right:
        by_reason = trades[trades.position_return.notna()].groupby("reason").position_return
        st.markdown("**How positions closed**")
        st.dataframe(pd.DataFrame({"Trades": by_reason.size(), "Win rate": 100 * by_reason.apply(lambda s: (s > 0).mean()),
                                   "Avg return": 100 * by_reason.mean()}),
                     width="stretch",
                     column_config={"Win rate": st.column_config.NumberColumn(format="%.0f%%"),
                                    "Avg return": st.column_config.NumberColumn(format="%+.1f%%")})
        st.caption(f"Average win {c.pct(wins.mean())}, average loss {c.pct(losses.mean())}. Blue = gains, red = losses.")
