"""Stock Deep Dive: candlesticks, 50/200-day MAs, news markers and explained anomalies."""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from dashboard import common as c
from quant import analytics as an

st.title("Stock Deep Dive")
ctx = c.context()
pal = c.palette()

# --- one filter row above everything it scopes ---------------------------------------------
f1, f2, f3, f4 = st.columns([1.1, 1.7, 1.2, 2.2])
ticker = c.pick_ticker(f1)
span = f2.segmented_control("Range", ["3M", "6M", "1Y", "3Y", "All"], default="6M", key="dd_range") or "6M"
interval = f3.segmented_control("Bars", ["Daily", "15-min"], default="Daily", key="dd_interval") or "Daily"
layers = f4.pills("Overlays", ["News", "Unusual moves", "Bollinger"], selection_mode="multi",
                  default=["News", "Unusual moves"], key="dd_layers") or []
intraday = interval == "15-min"

daily = ctx.bars[ticker]
snap = an.indicator_snapshot(daily)
scores = c.scores()
info = c.company(ticker)
st.caption(f"{info.get('name', ticker)} · {info.get('sic_description') or ''} · {info.get('exchange') or ''}")

# --- KPI row -------------------------------------------------------------------------------
k = st.columns(5)
chg = daily.close.iloc[-1] / daily.close.iloc[-2] - 1
k[0].metric("Close", f"{snap['close']:.2f}", f"{chg:+.2%}", border=True, help=f"Session {snap['date']}")
spread = snap["sma_50"] / snap["sma_200"] - 1 if snap["sma_200"] else np.nan
k[1].metric("50 vs 200-day MA", f"{spread:+.1%}", "golden-cross alignment" if spread > 0 else "death-cross alignment",
            delta_color="normal" if spread > 0 else "inverse", delta_arrow="up" if spread > 0 else "down", border=True)
k[2].metric("RSI (14)", f"{snap['rsi_14']:.0f}",
            "overbought" if snap["rsi_14"] >= 70 else "oversold" if snap["rsi_14"] <= 30 else "neutral",
            delta_color="off", delta_arrow="off", border=True)
row = scores.loc[ticker] if ticker in scores.index else None
k[3].metric("Momentum 12-1", c.pct(row["momentum_12_1"], 0) if row is not None else "–", border=True,
            help="Return from 12 months to 1 month ago (Jegadeesh & Titman 1993)")
k[4].metric("Factor score", f"{row['composite']:.0f}/100" if row is not None else "–",
            f"rank {row['rank']} of {len(scores)}" if row is not None else None, delta_color="off", delta_arrow="off",
            border=True)

# --- data for the chart ------------------------------------------------------------------------
if intraday:
    bars = c.intraday_bars(ticker).copy()
    bars.index = c.to_et(bars.index)
    bars = an.add_indicators(bars) if len(bars) > 30 else bars
    start = bars.index.min()
else:
    months = {"3M": 3, "6M": 6, "1Y": 12, "3Y": 36}.get(span)
    start = daily.index[-1] - pd.DateOffset(months=months) if months else daily.index[0]
    bars = daily.loc[start:]

news = c.headlines(limit=2000)
news = news[news.ticker == ticker].copy()
moves = c.anomalies(ticker, "15m" if intraday else "1d", days=40 if intraday else max(60, (pd.Timestamp.now() - start).days))

# --- chart ---------------------------------------------------------------------------------------
fig = make_subplots(rows=3, cols=1, shared_xaxes=True, row_heights=[0.64, 0.13, 0.23], vertical_spacing=0.025)
fig.add_trace(go.Candlestick(
    x=bars.index, open=bars.open, high=bars.high, low=bars.low, close=bars.close, name="Price",
    increasing=dict(line=dict(color=pal["up"], width=1), fillcolor=pal["up"]),
    decreasing=dict(line=dict(color=pal["down"], width=1), fillcolor=pal["down"]),
), row=1, col=1)

if not intraday:
    for col, label, color in (("sma_50", "50-day MA", pal["ma50"]), ("sma_200", "200-day MA", pal["ma200"])):
        fig.add_trace(go.Scatter(x=bars.index, y=bars[col], name=label, line=dict(color=color, width=2),
                                 hovertemplate="%{y:.2f}"), row=1, col=1)
        fig.add_annotation(x=bars.index[-1], y=bars[col].iloc[-1], text=label.split("-")[0] + " MA", showarrow=False,
                           xanchor="left", xshift=6, font=dict(color=pal["ink2"], size=11), row=1, col=1)
if "Bollinger" in layers and "bb_upper" in bars:
    fig.add_trace(go.Scatter(x=bars.index, y=bars.bb_upper, name="Bollinger (20, 2)", line=dict(color=pal["muted"], width=1),
                             hoverinfo="skip"), row=1, col=1)
    fig.add_trace(go.Scatter(x=bars.index, y=bars.bb_lower, showlegend=False, line=dict(color=pal["muted"], width=1),
                             fill="tonexty", fillcolor="rgba(137,135,129,0.08)", hoverinfo="skip"), row=1, col=1)

# News markers: one per bar, shaped and coloured by average FinBERT sentiment.
if "News" in layers and len(news):
    if intraday:
        anchor = pd.Series(c.to_et(news.aligned_bar_ts.dropna()), index=news.aligned_bar_ts.dropna().index)
    else:
        sessions = daily.index
        pub = news.published_et
        after_close = (pub.dt.hour >= 16).to_numpy()
        pos = sessions.searchsorted(pub.dt.normalize().to_numpy(), side="left")
        pos = np.where(after_close, sessions.searchsorted(pub.dt.normalize().to_numpy(), side="right"), pos)
        anchor = pd.Series([sessions[i] if i < len(sessions) else pd.NaT for i in pos], index=news.index)
    news["bar"] = anchor
    grouped = news.dropna(subset=["bar"]).groupby("bar")
    pts = grouped.agg(score=("sentiment_score", "mean"), n=("title", "size"),
                      titles=("title", lambda s: "<br>".join(f"• {c.wrap(t, 60)}" for t in s.head(4))))
    pts = pts[pts.index.isin(bars.index)]
    if len(pts):
        tone = np.select([pts.score > 0.15, pts.score < -0.15], ["bullish", "bearish"], "neutral")
        y = bars.high.reindex(pts.index) * 1.02
        for label, symbol, color in (("bullish", "triangle-up", pal["up"]), ("bearish", "triangle-down", pal["down"]),
                                     ("neutral", "circle", pal["muted"])):
            m = tone == label
            if not m.any():
                continue
            fig.add_trace(go.Scatter(
                x=pts.index[m], y=y[m], mode="markers", name=f"News: {label}",
                marker=dict(symbol=symbol, size=11, color=color, line=dict(color=pal["surface"], width=2)),
                customdata=np.stack([pts.n[m], pts.score[m], pts.titles[m]], axis=-1),
                hovertemplate="%{customdata[0]} headline(s), FinBERT %{customdata[1]:+.2f}<br>%{customdata[2]}<extra></extra>",
            ), row=1, col=1)

# Unusual moves: a star above spikes / below drops, hover carries the explanation.
if "Unusual moves" in layers and moves:
    mv = pd.DataFrame(moves)
    mv["x"] = c.to_et(mv.timestamp) if intraday else pd.DatetimeIndex(mv.timestamp)
    mv = mv[mv.x.isin(bars.index)]
    if len(mv):
        hi, lo = bars.high.reindex(mv.x).to_numpy(), bars.low.reindex(mv.x).to_numpy()
        ys = np.where(mv.return_pct > 0, hi * 1.045, lo * 0.96)
        fig.add_trace(go.Scatter(
            x=mv.x, y=ys, mode="markers", name="Unusual move",
            marker=dict(symbol="star", size=14, color=pal["ink"], line=dict(color=pal["surface"], width=2)),
            customdata=[c.wrap(e, 70) for e in mv.explanation],
            hovertemplate="%{customdata}<extra></extra>",
        ), row=1, col=1)

vol_colors = np.where(bars.close >= bars.open, pal["up"], pal["down"])
fig.add_trace(go.Bar(x=bars.index, y=bars.volume, name="Volume", marker=dict(color=vol_colors, opacity=0.5),
                     showlegend=False, hovertemplate="%{y:,.0f}"), row=2, col=1)
if "rsi_14" in bars:
    fig.add_trace(go.Scatter(x=bars.index, y=bars.rsi_14, name="RSI (14)", line=dict(color=pal["ink2"], width=1.5),
                             showlegend=False, hovertemplate="%{y:.0f}"), row=3, col=1)
    for level in (30, 70):
        fig.add_hline(y=level, line=dict(color=pal["axis"], width=1), row=3, col=1)

breaks = [dict(bounds=["sat", "mon"])]
if intraday:
    breaks.append(dict(bounds=[16, 9.5], pattern="hour"))
else:
    missing = pd.bdate_range(bars.index.min(), bars.index.max()).difference(bars.index)
    breaks.append(dict(values=list(missing.strftime("%Y-%m-%d"))))
fig.update_xaxes(type="date", rangebreaks=breaks, rangeslider_visible=False)
# Pad the price axis so markers above highs / below lows are never clipped.
lo, hi = float(bars.low.min()), float(bars.high.max())
fig.update_yaxes(range=[lo * 0.95, hi * 1.06], row=1, col=1)
fig.update_yaxes(title_text=None)
fig.update_yaxes(title_text="Volume", row=2, col=1, title_font=dict(size=11))
fig.update_yaxes(title_text="RSI", row=3, col=1, range=[0, 100], tickvals=[30, 70], title_font=dict(size=11))
st.markdown(f"**{ticker} · {'15-minute bars (ET), last ~30 sessions' if intraday else span + ' daily'}**")
c.show(c.style(fig, height=640), key="deep_dive_chart")
st.caption("Candles: blue up, red down. ▲ / ▼ / ● news markers = bullish / bearish / neutral FinBERT average of on-topic "
           "headlines mapped to the bar they first affected. ★ = unusual move; hover for the explanation.")

with st.expander("Indicator readings and data table"):
    st.markdown("\n".join(f"- {r}" for r in snap["readings"]))
    cols = [x for x in ("open", "high", "low", "close", "volume", "sma_50", "sma_200", "rsi_14", "macd_hist") if x in bars]
    st.dataframe(bars[cols].iloc[::-1], width="stretch", height=260)

# --- unusual moves and news ------------------------------------------------------------------
left, right = st.columns([1, 1], gap="large")
with left:
    st.subheader("Unusual moves")
    if moves:
        mv = pd.DataFrame(moves).sort_values("timestamp", ascending=False)
        top = [m[0] if m else None for m in mv.matches]
        st.dataframe(
            pd.DataFrame({
                "When": mv.timestamp, "Move": 100 * mv.return_pct, "z": mv.zscore, "Driver": mv.driver,
                "Explanation": mv.explanation,
                "Catalyst": [t["url"] if t else None for t in top],
            }),
            hide_index=True, width="stretch", placeholder="–",
            column_config={
                "When": st.column_config.DatetimeColumn(format="YYYY-MM-DD HH:mm" if intraday else "YYYY-MM-DD"),
                "Move": st.column_config.NumberColumn(format="%+.1f%%"),
                "z": st.column_config.NumberColumn(format="%.1f", help="Move in robust standard deviations"),
                "Explanation": st.column_config.TextColumn(width="large"),
                "Catalyst": st.column_config.LinkColumn(display_text="Open"),
            },
        )
    else:
        st.info("No unusual moves in this window.")
with right:
    st.subheader("Headlines")
    if len(news):
        tone = np.select([news.sentiment_score > 0.15, news.sentiment_score < -0.15], ["▲ bullish", "▼ bearish"], "● neutral")
        st.dataframe(
            pd.DataFrame({
                "Time (ET)": news.published_et, "Headline": news.title, "Source": news.publisher, "Tone": tone,
                "FinBERT": news.sentiment_score, "1h reaction": 100 * news.reaction_return, "Link": news.url,
            }),
            hide_index=True, width="stretch", placeholder="–",
            column_config={
                "Time (ET)": st.column_config.DatetimeColumn(format="MMM D, HH:mm"),
                "Headline": st.column_config.TextColumn(width="large"),
                "FinBERT": st.column_config.NumberColumn(format="%+.2f"),
                "1h reaction": st.column_config.NumberColumn(format="%+.2f%%",
                                                             help="Price move in the hour after the headline"),
                "Link": st.column_config.LinkColumn(display_text="Open"),
            },
        )
    else:
        st.info("No on-topic headlines for this ticker yet.")
