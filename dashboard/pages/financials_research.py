"""Financials & Research: SEC filing summaries, Fama-French analysis, factor scores, strategy backtests."""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from dashboard import common as c
from quant import quant_models as qm
from quant import trading_bot as tb

st.title("Financials & Research")
pal = c.palette()

f1, f2, _ = st.columns([1.1, 1.4, 3])
ticker = c.pick_ticker(f1)
model = f2.segmented_control("Factor model", ["FF3", "Carhart"], default="FF3", key="fr_model",
                             help="Fama & French (1993) three factors; Carhart (1997) adds momentum") or "FF3"

# =============================================================================
# SEC filings
# =============================================================================
info = c.company(ticker)
fund = c.filings(ticker)
q = c.quarterly(ticker)
st.subheader(f"SEC financials · {info.get('name', ticker)}")
if fund.empty:
    st.info("No SEC filings stored for this ticker (indices, ETFs and foreign filers have none).")
else:
    latest = fund.iloc[0]
    snap = qm.ttm_snapshot(fund)
    growth = tb.earnings_growth(q)
    st.caption(
        f"Latest filing: [{latest.form} for the period ended {latest.report_date}]({latest.filing_url}), filed "
        f"{latest.filing_date} · CIK {info.get('cik')} · {info.get('sic_description') or ''}. "
        f"Trailing-twelve-month figures use {snap['basis'] if snap else 'n/a'} (Q4 = annual − Q1–Q3)."
    )
    k = st.columns(6)
    fcf = snap["operating_cash_flow"] - snap["capital_expenditure"] if snap and pd.notna(snap["capital_expenditure"]) else np.nan
    eps_ttm = q.eps_diluted.tail(4).sum(min_count=4) if len(q) >= 4 else np.nan
    k[0].metric("Revenue (TTM)", c.money(snap["revenue"]) if snap else "–",
                c.pct(growth["revenue_yoy"], 0) + " y/y latest qtr" if growth and growth["revenue_yoy"] is not None else None,
                border=True)
    k[1].metric("Net income (TTM)", c.money(snap["net_income"]) if snap else "–",
                c.pct(growth["net_income_yoy"], 0) + " y/y latest qtr" if growth else None, border=True)
    k[2].metric("Net margin", c.pct(snap["net_income"] / snap["revenue"], 1, sign=False) if snap and snap["revenue"] else "–",
                border=True)
    k[3].metric("Free cash flow (TTM)", c.money(fcf), border=True, help="Operating cash flow − capex")
    k[4].metric("EPS (TTM, diluted)", f"{eps_ttm:.2f}" if pd.notna(eps_ttm) else "–", border=True)
    de = snap["total_debt"] / snap["stockholders_equity"] if snap and snap["stockholders_equity"] and pd.notna(snap["total_debt"]) else np.nan
    k[5].metric("Debt / equity", f"{de:.2f}" if pd.notna(de) else "–", border=True)

    recent = q.tail(12)
    labels = [f"{d:%b %Y}" for d in recent.report_date]
    left, right = st.columns(2, gap="large")
    with left:
        st.markdown("**Quarterly revenue and net income**")
        fig = go.Figure()
        fig.add_trace(go.Bar(x=labels, y=recent.revenue / 1e9, name="Revenue", marker_color=pal["series"][0],
                             hovertemplate="%{x}: %{customdata}<extra>Revenue</extra>",
                             customdata=[c.money(v) for v in recent.revenue]))
        fig.add_trace(go.Bar(x=labels, y=recent.net_income / 1e9, name="Net income", marker_color=pal["series"][1],
                             hovertemplate="%{x}: %{customdata}<extra>Net income</extra>",
                             customdata=[c.money(v) for v in recent.net_income]))
        fig.update_layout(barmode="group", bargap=0.3, bargroupgap=0.08)
        fig.update_yaxes(tickprefix="$", ticksuffix="B", tickformat=",.0f")
        c.show(c.style(fig, height=330, hovermode="closest"), key="rev_ni")
    with right:
        st.markdown("**Quarterly margins**")
        margins = pd.DataFrame({
            "Net margin": recent.net_income / recent.revenue,
            "Free-cash-flow margin": (recent.operating_cash_flow - recent.capital_expenditure) / recent.revenue,
        })
        fig = go.Figure()
        for i, col in enumerate(margins):
            fig.add_trace(go.Scatter(x=labels, y=margins[col], name=col, mode="lines+markers",
                                     line=dict(color=pal["series"][i], width=2), marker=dict(size=8)))
        fig.add_hline(y=0, line=dict(color=pal["axis"], width=1))
        fig.update_yaxes(tickformat=".0%")
        c.show(c.style(fig, height=330), key="margins")

    with st.expander("Filings (10-K / 10-Q)", expanded=False):
        st.dataframe(
            pd.DataFrame({
                "Form": fund.form, "Period end": fund.report_date, "Filed": fund.filing_date,
                "Revenue": fund.revenue, "Net income": fund.net_income, "EPS (diluted)": fund.eps_diluted,
                "Debt/equity": fund.debt_to_equity, "Operating CF": fund.operating_cash_flow,
                "CF period (days)": fund.cash_flow_period_days, "Filing": fund.filing_url,
            }),
            hide_index=True, width="stretch", placeholder="–", height=320,
            column_config={
                "Revenue": st.column_config.NumberColumn(format="compact"),
                "Net income": st.column_config.NumberColumn(format="compact"),
                "Operating CF": st.column_config.NumberColumn(format="compact",
                                                              help="10-Q cash flow is year-to-date: see CF period"),
                "EPS (diluted)": st.column_config.NumberColumn(format="%.2f"),
                "Debt/equity": st.column_config.NumberColumn(format="%.2f"),
                "Filing": st.column_config.LinkColumn(display_text="SEC"),
            },
        )

# =============================================================================
# Fama-French
# =============================================================================
st.divider()
exps = {e["ticker"]: e for e in c.exposures(model)}
e = exps.get(ticker)
st.subheader(f"Fama-French {model} analysis")
if e is None:
    st.info("Not enough overlapping price and factor history for this ticker.")
else:
    st.caption(f"Daily excess returns, {e['start']} to {e['end']} ({e['n_obs']} days; the French library lags 1-2 "
               f"months). Newey-West t-statistics; |t| ≥ 2 is significant.")
    names = {"mkt_rf": "Market β", "smb": "Size β (SMB)", "hml": "Value β (HML)", "mom": "Momentum β"}
    k = st.columns(2 + len(e["betas"]))
    k[0].metric("Alpha / year", c.pct(e["alpha_annual"]), f"t = {e['alpha_t']:.1f}", delta_color="off", delta_arrow="off", border=True,
                help="Return not explained by the factors")
    for i, (f, b) in enumerate(e["betas"].items(), start=1):
        t = e["t_stats"][f]
        k[i].metric(names[f], f"{b:.2f}", f"t = {t:.1f}{' · significant' if abs(t) >= 2 else ''}", delta_color="off",
                    delta_arrow="off", border=True)
    k[-1].metric("R²", f"{e['r_squared']:.2f}", f"driven by {e['dominant_driver']}", delta_color="off", delta_arrow="off", border=True)
    if e["tilts"]:
        st.markdown("**Reading:** " + ", ".join(e["tilts"]) + ".")

    left, right = st.columns(2, gap="large")
    with left:
        st.markdown("**Where the annual return came from**")
        attr = e["return_attribution"]
        steps = [("Risk-free", attr["risk_free"])] + [(names[f].split(" ")[0], attr[f]) for f in e["betas"]] + \
                [("Alpha", attr["alpha"])]
        fig = go.Figure(go.Waterfall(
            x=[s[0] for s in steps] + ["Total"], y=[s[1] for s in steps] + [sum(s[1] for s in steps)],
            measure=["relative"] * len(steps) + ["total"],
            increasing=dict(marker=dict(color=pal["up"])), decreasing=dict(marker=dict(color=pal["down"])),
            totals=dict(marker=dict(color=pal["ink2"])), connector=dict(line=dict(color=pal["axis"], width=1)),
            texttemplate="%{y:+.1%}", textposition="outside", hovertemplate="%{x}: %{y:+.2%}<extra></extra>",
        ))
        fig.update_yaxes(tickformat=".0%")
        c.show(c.style(fig, height=340, hovermode="closest", legend=False), key="waterfall")
        st.caption("Annualised: risk-free rate + β × each factor's average premium + alpha.")
    with right:
        st.markdown("**Rolling 1-year betas**")
        roll = c.rolling_betas(ticker, model)
        fig = go.Figure()
        for i, f in enumerate(e["betas"]):
            fig.add_trace(go.Scatter(x=roll.index, y=roll[f], name=names[f], line=dict(color=pal["series"][i], width=2),
                                     hovertemplate="%{y:.2f}"))
        fig.add_hline(y=0, line=dict(color=pal["axis"], width=1))
        fig.update_xaxes(type="date")
        c.show(c.style(fig, height=340), key="rolling")

    st.markdown("**Watchlist factor exposures**")
    rows = []
    for t, x in exps.items():
        rows.append({
            "Ticker": t, "Alpha/yr": 100 * x["alpha_annual"], "Alpha t": x["alpha_t"],
            **{names[f]: x["betas"][f] for f in x["betas"]},
            "R²": x["r_squared"], "Stock-specific": 100 * x["variance_share"]["idiosyncratic"],
            "Driven by": x["dominant_driver"], "Tilts": ", ".join(x["tilts"]),
        })
    st.dataframe(
        pd.DataFrame(rows), hide_index=True, width="stretch", placeholder="–",
        column_config={
            "Alpha/yr": st.column_config.NumberColumn(format="%+.1f%%"),
            "Alpha t": st.column_config.NumberColumn(format="%.1f"),
            **{n: st.column_config.NumberColumn(format="%.2f") for n in names.values()},
            "R²": st.column_config.NumberColumn(format="%.2f"),
            "Stock-specific": st.column_config.ProgressColumn("Stock-specific variance", color="blue", min_value=0, max_value=100,
                                                              format="%.0f%%"),
            "Tilts": st.column_config.TextColumn(width="large"),
        },
    )

# =============================================================================
# Factor scores and strategies
# =============================================================================
st.divider()
st.subheader("Composite factor scores")
st.caption("Each metric is ranked across the watchlist (0 = worst, 100 = best) and averaged into pillars: "
           "Value (E/P, FCF/P, B/M, S/P), Quality (ROE, cash ROA, low leverage, low accruals), Momentum (12-1, 6-1).")
s = c.scores()
st.dataframe(
    pd.DataFrame({
        "Rank": s["rank"], "Ticker": s.index, "Composite": s.composite, "Value": s.value, "Quality": s.quality,
        "Momentum": s.momentum, "E/P": 100 * s.earnings_yield, "FCF/P": 100 * s.fcf_yield, "B/M": s.book_to_market,
        "ROE": 100 * s.roe, "D/E": s.leverage, "Mom 12-1": 100 * s.momentum_12_1,
        "Fundamentals as of": s.fundamentals_as_of,
    }),
    hide_index=True, width="stretch", placeholder="–",
    column_config={
        **{p: st.column_config.ProgressColumn(p, color="blue", min_value=0, max_value=100, format="%.0f")
           for p in ("Composite", "Value", "Quality", "Momentum")},
        "E/P": st.column_config.NumberColumn(format="%.1f%%"), "FCF/P": st.column_config.NumberColumn(format="%.1f%%"),
        "B/M": st.column_config.NumberColumn(format="%.2f"), "ROE": st.column_config.NumberColumn(format="%.0f%%"),
        "D/E": st.column_config.NumberColumn(format="%.2f"), "Mom 12-1": st.column_config.NumberColumn(format="%+.0f%%"),
    },
)

with st.expander("Academic strategy backtests (momentum and reversal)"):
    strat = c.strategies().reset_index()
    st.dataframe(
        pd.DataFrame({
            "Strategy": strat.strategy, "Paper": strat.paper, "CAGR": 100 * strat.cagr, "Vol": 100 * strat.vol,
            "Sharpe": strat.sharpe, "Max drawdown": 100 * strat.max_drawdown, "Turnover/yr": strat.turnover_per_year,
            "Carhart alpha": 100 * strat.alpha, "Alpha t": strat.alpha_t, "Momentum β": strat.mom_beta,
        }),
        hide_index=True, width="stretch", placeholder="–",
        column_config={
            "CAGR": st.column_config.NumberColumn(format="%.1f%%"), "Vol": st.column_config.NumberColumn(format="%.1f%%"),
            "Sharpe": st.column_config.NumberColumn(format="%.2f"),
            "Max drawdown": st.column_config.NumberColumn(format="%.1f%%"),
            "Turnover/yr": st.column_config.NumberColumn(format="%.1fx"),
            "Carhart alpha": st.column_config.NumberColumn(format="%+.1f%%"),
            "Alpha t": st.column_config.NumberColumn(format="%.1f"), "Momentum β": st.column_config.NumberColumn(format="%.2f"),
        },
    )
    st.caption(qm.SURVIVORSHIP_NOTE + " Net of 5 bps per unit of turnover.")
