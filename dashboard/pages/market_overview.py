"""Market Overview: regime, FRED indicators, watchlist movers and breaking news."""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from dashboard import common as c

st.title("Market Overview")
ctx = c.context()
reg = c.regime()
pal = c.palette()

# --- regime ------------------------------------------------------------------------------
left, right = st.columns([3, 2], gap="large")
with left:
    a, b, d = st.columns([2, 1.3, 1])
    a.metric("Market regime", reg["label"], border=True, help="S&P 500 trend (50/200-day MA, 20% drawdown rule) + VIX level")
    b.metric("Stance", reg["stance"], border=True, help="From the 0-1 risk score: trend, volatility, credit, labour, curve, inflation")
    d.metric("Risk score", f"{reg['risk_score']:.2f}", border=True, help="0 = benign, 1 = stressed. Risk-On < 0.33, Risk-Off > 0.6")
    st.badge(f"{reg['stance']} · as of {reg['as_of']}", icon=c.STANCE_ICON.get(reg["stance"]),
             color={"Risk-On": "green", "Neutral": "orange", "Risk-Off": "red"}.get(reg["stance"], "gray"))
with right:
    st.markdown("**Why**")
    st.markdown("\n".join(f"- {r}" for r in reg["reasons"]))

# --- S&P 500 with stance shading ---------------------------------------------------------
span = st.segmented_control("Range", ["1Y", "3Y", "5Y", "10Y"], default="3Y", key="overview_range")
years = int((span or "3Y")[:-1])
spx = c.benchmark_bars("^GSPC")
start = spx.index[-1] - pd.DateOffset(years=years)
spx = spx.loc[start:]
hist = ctx.regime.loc[start:, ["stance", "regime"]].dropna()

fig = go.Figure()
runs = (hist.stance != hist.stance.shift()).cumsum()
for _, run in hist.groupby(runs):
    stance = run.stance.iloc[0]
    fig.add_vrect(x0=run.index[0], x1=run.index[-1] + pd.Timedelta(days=1), line_width=0, layer="below",
                  fillcolor=c.STATUS[c.STANCE_STATUS[stance]], opacity=0.10)
fig.add_trace(go.Scatter(x=spx.index, y=spx.close, name="S&P 500", line=dict(color=pal["ink"], width=1.5)))
fig.add_trace(go.Scatter(x=spx.index, y=spx.sma_50, name="50-day MA", line=dict(color=pal["ma50"], width=2)))
fig.add_trace(go.Scatter(x=spx.index, y=spx.sma_200, name="200-day MA", line=dict(color=pal["ma200"], width=2)))
for stance, status in c.STANCE_STATUS.items():  # legend entries for the shading (added last: axis typing)
    fig.add_trace(go.Scatter(x=[spx.index[-1]], y=[None], mode="markers", name=f"{stance} (shading)",
                             hoverinfo="skip", marker=dict(symbol="square", size=10, color=c.STATUS[status], opacity=0.4)))
for col, label, color in (("sma_50", "50 MA", pal["ma50"]), ("sma_200", "200 MA", pal["ma200"])):
    fig.add_annotation(x=spx.index[-1], y=spx[col].iloc[-1], text=label, showarrow=False, xanchor="left",
                       xshift=4, font=dict(color=pal["ink2"], size=11))
fig.update_xaxes(type="date")
fig.update_yaxes(tickformat=",.0f")
st.markdown("**S&P 500 with regime stance**")
c.show(c.style(fig, height=380), key="spx")

# --- FRED indicators -----------------------------------------------------------------------
st.subheader("Economic indicators (FRED)")
macro = c.macro_frame()


def tile(col, series_id, label, unit="%", transform=None, inverse=False, digits=2, months=1):
    s = macro[series_id].dropna() if series_id in macro else pd.Series(dtype=float)
    if transform == "yoy":
        s = (s.pct_change(12) * 100).dropna()
    if transform == "thousands":
        s = s / 1000
    if s.empty:
        col.metric(label, "–", border=True)
        return
    prev = s.loc[: s.index[-1] - pd.DateOffset(months=months)]
    delta = s.iloc[-1] - prev.iloc[-1] if len(prev) else None
    fmt = f"{{:.{digits}f}}{unit}"
    col.metric(
        label, fmt.format(s.iloc[-1]),
        delta=None if delta is None else f"{delta:+.{digits}f}{'pp' if unit == '%' else unit} vs {months}M ago",
        delta_color="inverse" if inverse else "off",
        chart_data=s.loc[s.index[-1] - pd.DateOffset(years=2):].to_list(), chart_type="line", border=True,
        help=f"{c.macro_label(series_id)} · latest {s.index[-1]:%Y-%m-%d}",
    )


row1 = st.columns(5)
tile(row1[0], "DGS10", "10Y Treasury")
tile(row1[1], "DGS2", "2Y Treasury")
tile(row1[2], "T10Y2Y", "10Y-2Y curve", unit="pp")
tile(row1[3], "DFF", "Fed funds")
tile(row1[4], "T10YIE", "10Y breakeven")
row2 = st.columns(5)
tile(row2[0], "CPILFESL", "Core CPI y/y", transform="yoy", inverse=True, digits=1)
tile(row2[1], "UNRATE", "Unemployment", inverse=True, digits=1)
tile(row2[2], "ICSA", "Jobless claims", unit="k", transform="thousands", inverse=True, digits=0)
tile(row2[3], "VIXCLS", "VIX", unit="", inverse=True, digits=1)
tile(row2[4], "BAA10Y", "Baa credit spread", unit="pp", inverse=True)

# --- watchlist movers and news -------------------------------------------------------------
movers_col, news_col = st.columns([2, 3], gap="large")
with movers_col:
    st.subheader("Watchlist")
    scores = c.scores()
    rows = []
    for t in ctx.universe.tickers:
        b = ctx.bars[t]
        px = b.adj_close.dropna()
        ytd = px.loc[str(px.index[-1].year)]
        rows.append({
            "Ticker": t, "Close": b.close.iloc[-1],
            "1D": 100 * (px.iloc[-1] / px.iloc[-2] - 1), "1M": 100 * (px.iloc[-1] / px.iloc[-22] - 1),
            "YTD": 100 * (px.iloc[-1] / ytd.iloc[0] - 1),
            "Trend": "▲ golden" if b.sma_50.iloc[-1] > b.sma_200.iloc[-1] else "▼ death",
            "RSI": b.rsi_14.iloc[-1],
            "Score": scores.composite.get(t, np.nan),
        })
    st.dataframe(
        pd.DataFrame(rows).sort_values("1D", ascending=False), hide_index=True, width="stretch", placeholder="–",
        column_config={
            "Close": st.column_config.NumberColumn(format="%.2f"),
            "1D": st.column_config.NumberColumn(format="%+.1f%%"),
            "1M": st.column_config.NumberColumn(format="%+.1f%%"),
            "YTD": st.column_config.NumberColumn(format="%+.1f%%"),
            "Trend": st.column_config.TextColumn(help="50-day vs 200-day moving average"),
            "RSI": st.column_config.NumberColumn(format="%.0f"),
            "Score": st.column_config.ProgressColumn("Factor score", color="blue", min_value=0, max_value=100, format="%.0f",
                                                     help="Composite Value / Quality / Momentum (Phase 3)"),
        },
    )

with news_col:
    st.subheader("Breaking news")
    scope = st.pills("Show", ["All", "Watchlist", "Market-wide"], default="All", key="news_scope")
    news = c.headlines()
    if scope == "Watchlist":
        news = news[news.ticker.notna()]
    elif scope == "Market-wide":
        news = news[news.ticker.isna()]
    news = news.drop_duplicates("title").head(40)
    tone = np.select([news.sentiment_score > 0.15, news.sentiment_score < -0.15], ["▲ bullish", "▼ bearish"], "● neutral")
    st.dataframe(
        pd.DataFrame({
            "Time (ET)": news.published_et, "Ticker": news.ticker.fillna("Market"), "Headline": news.title,
            "Source": news.publisher, "Tone": tone, "FinBERT": news.sentiment_score, "Link": news.url,
        }),
        hide_index=True, width="stretch", placeholder="–", height=420,
        column_config={
            "Time (ET)": st.column_config.DatetimeColumn(format="MMM D, HH:mm"),
            "Headline": st.column_config.TextColumn(width="large"),
            "FinBERT": st.column_config.NumberColumn(format="%+.2f", help="P(positive) - P(negative)"),
            "Link": st.column_config.LinkColumn(display_text="Open"),
        },
    )
