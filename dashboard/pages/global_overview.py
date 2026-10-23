"""Global Overview: every stock (>= $1B), liquid US-listed ETF and top coin, scored with the
platform's processes. Pick candidates here and promote them to the watchlist for the deep tier."""

import dataclasses

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from dashboard import common as c
from quant.universe import watchlist as wl

st.title("Global Overview")
pal = c.palette()
scores = c.universe_scores()
if not scores.empty:
    scores = scores.assign(
        unusual=scores.unusual.fillna(False).astype(bool),
        sparkline=scores.sparkline.map(lambda x: list(x) if isinstance(x, (list, np.ndarray)) else None),
    )
if scores.empty:
    st.info("The global universe hasn't been scored yet. Run `python -m quant.universe.refresh` (about 30 minutes "
            "the first time).")
    st.stop()
regimes = c.universe_regimes()
watch = c.watchlist_items()
watched = set(watch.symbol)
counts = scores.asset_class.value_counts()
st.caption(
    f"{counts.get('stock', 0):,} stocks ≥ $1B in 21 markets · {counts.get('etf', 0):,} liquid US-listed ETFs · "
    f"{counts.get('crypto', 0):,} coins · scored {pd.Timestamp(scores.scored_at.max()):%Y-%m-%d %H:%M}. "
    "Sources: Yahoo Finance (screener, prices, fundamentals, analyst consensus), CoinGecko, Nasdaq Trader. "
    "Research tool, not investment advice."
)

# --- market regimes -----------------------------------------------------------------------
TREND_COLOR = {"Bull": "green", "Bear": "red", "Sideways": "orange"}
if len(regimes):
    st.subheader("Market regimes")
    rows = list(regimes.iterrows())
    for start in range(0, len(rows), 6):
        cols = st.columns(6)
        for col, (market, r) in zip(cols, rows[start:start + 6]):
            move = f":{'green' if r.ret_1m >= 0 else 'red'}[{r.ret_1m:+.1%}] 1M"
            with col.container(border=True):
                st.markdown(f"**{market}**  \n:{TREND_COLOR.get(r.trend, 'gray')}-badge[{r.trend}] "
                            f":gray-badge[{r.volatility}]  \n{move} · {r.stance.replace('-', chr(0x2011))}",
                            help=f"{r.regime} · {r['index']} {r.level:,.0f} · {r.drawdown_52w:.0%} from its 52-week "
                                 f"high · as of {r.as_of}")

# --- one filter block above everything it scopes ------------------------------------------------
f = st.columns([1.5, 1.5, 1.6, 1.9])
classes = f[0].pills("Asset class", ["Stocks", "ETFs", "Crypto"], selection_mode="multi",
                     default=["Stocks", "ETFs", "Crypto"], key="go_classes") or []
signals = f[1].pills("Signal", ["BUY", "HOLD", "AVOID"], selection_mode="multi", key="go_signals") or []
stock_markets = sorted(scores.loc[scores.asset_class == "stock", "market"].dropna().unique())
markets = f[2].multiselect("Market", [*stock_markets, "US ETFs", "Crypto"], key="go_markets",
                           placeholder="All markets")
sectors = f[3].multiselect("Sector", sorted(scores.sector.dropna().unique()), key="go_sectors", placeholder="All sectors")
g = st.columns([2.2, 1.0, 1.2, 1.4, 1.5], vertical_alignment="bottom")
query = g[0].text_input("Search", placeholder="Name or symbol", key="go_query")
min_score = g[1].number_input("Min score", 0, 100, 0, step=5, key="go_min_score")
min_cap = g[2].selectbox("Size", ["Any", "≥ $10B", "≥ $100B"], key="go_min_cap")
sort_by = g[3].selectbox("Sort by", ["Score", "1-day move", "12-1 momentum", "Market cap"], key="go_sort")
unusual_only = g[4].toggle("Unusual moves only", key="go_unusual")

cls_map = {"Stocks": "stock", "ETFs": "etf", "Crypto": "crypto"}
view = scores[scores.asset_class.isin([cls_map[x] for x in classes])]
if markets:
    view = view[view.market.isin(markets)]
if sectors:
    view = view[view.sector.isin(sectors)]
if signals:
    view = view[view.signal.isin(signals)]
if min_score:
    view = view[view.composite >= min_score]
if min_cap != "Any":
    view = view[view.market_cap_usd >= {"≥ $10B": 1e10, "≥ $100B": 1e11}[min_cap]]
if unusual_only:
    view = view[view.unusual]
if query:
    q = query.lower()
    view = view[view.symbol.str.lower().str.contains(q, regex=False) | view.name.fillna("").str.lower().str.contains(q, regex=False)]
sort_col = {"Score": "composite", "1-day move": "ret_1d", "12-1 momentum": "mom_12_1", "Market cap": "market_cap_usd"}[sort_by]
view = view.sort_values(sort_col, ascending=False, key=(lambda s: s.abs()) if sort_col == "ret_1d" else None,
                        na_position="last")

k = st.columns(4)
k[0].metric("Matching", f"{len(view):,}", border=True)
k[1].metric("Buy candidates", f"{int((view.signal == 'BUY').sum()):,}", border=True,
            help="Up-trend + composite ≥ 60 + market not in a Bear regime")
k[2].metric("Avoid", f"{int((view.signal == 'AVOID').sum()):,}", border=True, help="Down-trend + composite ≤ 40")
k[3].metric("Unusual move today", f"{int(view.unusual.sum()):,}", border=True,
            help="≥ 8% (crypto 20%), or ≥ 3 robust σ and ≥ 2% (crypto 5%)")

SIGNAL_TEXT = {"BUY": "▲ BUY", "HOLD": "● HOLD", "AVOID": "▼ AVOID", "N/A": "–"}


def table(df: pd.DataFrame) -> pd.DataFrame:
    sector = df.sector.where(df.asset_class == "stock", df.get("category"))
    sector = sector.where(sector.notna(), df.asset_class.map({"etf": "ETF", "crypto": "Crypto", "stock": None}))
    return pd.DataFrame({
        "★": np.where(df.symbol.isin(watched), "★", ""), "Symbol": df.symbol, "Name": df.name, "Market": df.market,
        "Sector": sector, "Signal": df.signal.map(SIGNAL_TEXT), "Score": df.composite, "Trend": df.trend,
        "Momentum": df.momentum, "Value": df.value, "Quality": df.quality, "Risk": df.risk, "Analysts": df.analysts,
        "1D": 100 * df.ret_1d, "1M": 100 * df.ret_1m, "YTD": 100 * df.ret_ytd, "12-1": 100 * df.mom_12_1,
        "Fwd P/E": df.pe_current_year, "ROE": 100 * df.return_on_equity, "Mkt cap ($B)": df.market_cap_usd / 1e9,
        "6M": df.sparkline, "Why": df.rationale,
    })


COLUMNS = {
    "★": st.column_config.TextColumn(width="small", help="In your watchlist"),
    "Name": st.column_config.TextColumn(width="medium"),
    "Score": st.column_config.ProgressColumn(color="blue", min_value=0, max_value=100, format="%.0f",
                                             help="Composite of the pillars, 0-100 percentile among peers"),
    **{p: st.column_config.NumberColumn(format="%.0f") for p in ("Trend", "Momentum", "Value", "Quality", "Risk", "Analysts")},
    **{p: st.column_config.NumberColumn(format="%+.1f%%") for p in ("1D", "1M", "YTD", "12-1")},
    "Fwd P/E": st.column_config.NumberColumn(format="%.1f"), "ROE": st.column_config.NumberColumn(format="%.0f%%"),
    "Mkt cap ($B)": st.column_config.NumberColumn(format="%,.1f"),
    "6M": st.column_config.LineChartColumn(width="small", help="Last six months"),
    "Why": st.column_config.TextColumn(width="large"),
}


def price_chart(symbol: str, name: str) -> None:
    s = c.universe_close(symbol)
    if s.empty:
        st.info("No price history for this instrument.")
        return
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=s.index, y=s, name=symbol, line=dict(color=pal["ink"], width=1.5)))
    for w, color in ((50, pal["ma50"]), (200, pal["ma200"])):
        ma = s.rolling(w).mean()
        if ma.notna().any():
            fig.add_trace(go.Scatter(x=s.index, y=ma, name=f"{w}-day MA", line=dict(color=color, width=2)))
            fig.add_annotation(x=s.index[-1], y=ma.iloc[-1], text=f"{w} MA", showarrow=False, xanchor="left",
                               xshift=6, font=dict(color=pal["ink2"], size=11))
    fig.update_xaxes(type="date")
    st.markdown(f"**{name} ({symbol})** · adjusted close, 2 years")
    c.show(c.style(fig, height=320), key=f"go_chart_{symbol}")


def promote(symbols: list[str], analyse: bool) -> None:
    wl.add(symbols)
    deep = [s for s in symbols if not s.endswith("-USD")]
    if analyse and deep:
        from quant.config import get_settings
        from quant.ingestion.pipeline import run_pipeline

        settings = dataclasses.replace(get_settings(), equities=tuple(deep))
        with st.spinner(f"Fetching prices, SEC filings and news for {', '.join(deep)}..."):
            results = run_pipeline(settings, steps=("prices", "fundamentals", "news"))
        failed = [r for r in results if not r.ok]
        (st.warning if failed else st.success)(
            "; ".join(f"{r.name}: {'ok' if r.ok else r.errors[0][:80]}" for r in results))
    st.cache_data.clear()
    st.cache_resource.clear()


tab_screen, tab_unusual, tab_watch = st.tabs(["Screener", "Unusual movers today", "Watchlist"])

with tab_screen:
    shown = view.head(1000)
    st.caption(f"Showing {len(shown):,} of {len(view):,}. Select rows to see the chart and add them to your watchlist.")
    event = st.dataframe(table(shown), hide_index=True, width="stretch", height=560, placeholder="–",
                         on_select="rerun", selection_mode="multi-row", key="go_table", column_config=COLUMNS)
    selected = shown.symbol.iloc[event.selection.rows].tolist() if event.selection.rows else []
    st.download_button("Download filtered list (CSV)", table(view).drop(columns=["6M"]).to_csv(index=False).encode(),
                       file_name="global_overview.csv", mime="text/csv", icon=":material/download:")
    if selected:
        b = st.columns([1.3, 1.6, 4])
        if b[0].button(f"Add {len(selected)} to watchlist", icon=":material/star:", key="go_add"):
            promote(selected, analyse=False)
            st.rerun()
        if b[1].button("Add & analyse now", icon=":material/insights:", key="go_add_analyse",
                       help="Adds to the watchlist and immediately fetches daily/intraday prices, SEC filings and "
                            "news with FinBERT for stocks and ETFs (crypto stays in the broad tier)"):
            promote(selected, analyse=True)
        r = shown.set_index("symbol").loc[selected[0]]
        st.divider()
        left, right = st.columns([3, 2], gap="large")
        with left:
            price_chart(selected[0], r["name"])
        with right:
            st.markdown(f"**{SIGNAL_TEXT.get(r.signal, r.signal)}** · score {r.composite:.0f}/100"
                        if pd.notna(r.composite) else "**Not enough data to score**")
            st.markdown(r.rationale)
            p = st.columns(3)
            for i, (label, col) in enumerate([("Trend", "trend"), ("Momentum", "momentum"), ("Risk", "risk"),
                                              ("Value", "value"), ("Quality", "quality"), ("Analysts", "analysts")]):
                p[i % 3].metric(label, "–" if pd.isna(r[col]) else f"{r[col]:.0f}")
            facts = [f"Market cap {c.money(r.market_cap_usd)}" if pd.notna(r.market_cap_usd) else None,
                     f"RSI {r.rsi_14:.0f}" if pd.notna(r.rsi_14) else None,
                     f"volatility {r.volatility:.0%}" if pd.notna(r.volatility) else None,
                     f"max drawdown (1y) {r.max_drawdown_1y:.0%}" if pd.notna(r.max_drawdown_1y) else None,
                     f"also listed: {r.also_listed}" if isinstance(r.also_listed, str) else None]
            st.caption(" · ".join(x for x in facts if x))
            st.markdown(f"[Open on Yahoo Finance](https://finance.yahoo.com/quote/{selected[0]})")

with tab_unusual:
    mv = scores[scores.unusual].copy()
    mv = mv.reindex(mv.zscore_1d.abs().sort_values(ascending=False).index)
    st.caption(f"{len(mv):,} instruments moved unusually in their latest session (Phase 2 rule against each "
               "instrument's own robust volatility). For explanations from the news, add them to the watchlist.")
    st.dataframe(
        pd.DataFrame({"Symbol": mv.symbol, "Name": mv.name, "Market": mv.market, "Move": 100 * mv.ret_1d,
                      "z": mv.zscore_1d, "Session": mv.last_date, "Signal": mv.signal.map(SIGNAL_TEXT),
                      "Why": mv.rationale}),
        hide_index=True, width="stretch", height=480, placeholder="–",
        column_config={"Move": st.column_config.NumberColumn(format="%+.1f%%"),
                       "z": st.column_config.NumberColumn(format="%+.1f", help="Move in robust standard deviations"),
                       "Why": st.column_config.TextColumn(width="large")},
    )

with tab_watch:
    if watch.empty:
        st.info("Your watchlist is empty. Select rows in the Screener tab and add them.")
    else:
        merged = watch.merge(scores, on="symbol", how="left", suffixes=("", "_s"))
        deep = c.deep_tier_analysed(tuple(merged.symbol))
        status = np.where(merged.symbol.isin(deep), "analysed (deep tier)",
                          np.where(merged.symbol.str.endswith("-USD"), "broad tier only (crypto)",
                                   "pending: next daily run"))
        bot = set(wl.bot_tickers())
        ev = st.dataframe(
            pd.DataFrame({"Symbol": merged.symbol, "Name": merged.name, "Market": merged.market,
                          "Signal": merged.signal.map(SIGNAL_TEXT), "Score": merged.composite,
                          "1D": 100 * merged.ret_1d, "Deep tier": status,
                          "Paper bot": np.where(merged.symbol.isin(bot), "trades", "–"), "Why": merged.rationale}),
            hide_index=True, width="stretch", placeholder="–", on_select="rerun", selection_mode="multi-row",
            key="go_watch_table",
            column_config={"Score": st.column_config.ProgressColumn(color="blue", min_value=0, max_value=100, format="%.0f"),
                           "1D": st.column_config.NumberColumn(format="%+.1f%%"),
                           "Paper bot": st.column_config.TextColumn(help="The bot's ledger is in USD, so it trades "
                                                                         "USD-quoted stocks and ETFs only"),
                           "Why": st.column_config.TextColumn(width="large")},
        )
        chosen = merged.symbol.iloc[ev.selection.rows].tolist() if ev.selection.rows else []
        if chosen and st.button(f"Remove {len(chosen)} from watchlist", icon=":material/delete:", key="go_remove"):
            wl.remove(chosen)
            st.cache_data.clear()
            st.cache_resource.clear()
            st.rerun()
        st.caption("Analysed names appear in Stock Deep Dive, Financials & Research and (if USD-quoted) the paper bot. "
                   "The daily scheduled run keeps them updated.")
