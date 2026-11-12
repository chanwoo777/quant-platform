"""The Pairs, Credit and Portfolio pages' maths in docs/assets/quant.js, checked under Node.js: the distance
method against a port of the Lecture 7 notebook (buy_sell / buy_sell_price), the Engle-Granger and ADF
statistics against statsmodels, the credit scorecard and the portfolio sums against hand calculations."""

from __future__ import annotations

import math

import numpy as np
import pytest
from statsmodels.tsa.stattools import adfuller

from tests.test_research_js import NODE, run_js

pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def pair_prices(n=380, seed=7):
    """Two prices that share a trend and wander apart and back (a mean-reverting gap)."""
    rng = np.random.default_rng(seed)
    common = np.cumsum(rng.normal(0.0004, 0.01, n))
    gap = np.zeros(n)
    for t in range(1, n):
        gap[t] = 0.93 * gap[t - 1] + rng.normal(0, 0.012)
    a = 100 * np.exp(common + gap)
    b = 60 * np.exp(common)
    dates = [f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]  # labels only
    return dates, a, b


def lecture7(a, b, formation, trading, k=2.0):
    """Lecture 7 part 2, steps 1-4: stdev of the formation spread, buy_sell signals, buy_sell_price equity."""
    fa, fb = a[:formation] / a[0], b[:formation] / b[0]
    stdev = np.std(fa - fb, ddof=1)
    const1, const2 = stdev * k, 0
    s1, s2 = a[formation:formation + trading] / a[formation], b[formation:formation + trading] / b[formation]
    flag, buys = 0, []  # buys[i] = (long ticker, short ticker) on signal days, None otherwise
    for i in range(len(s1)):
        sig = None
        if i == len(s1) - 1:
            if flag == 1:
                sig = ("1", "2")
            elif flag == 2:
                sig = ("2", "1")
        elif flag == 0:
            if s1[i] - s2[i] > const1:
                sig, flag = ("2", "1"), 1
            elif s2[i] - s1[i] > const1:
                sig, flag = ("1", "2"), 2
        elif flag == 1 and s1[i] - s2[i] < const2:
            sig, flag = ("1", "2"), 0
        elif flag == 2 and s2[i] - s1[i] < const2:
            sig, flag = ("2", "1"), 0
        buys.append(sig)
    px = {"1": s1, "2": s2}
    out, open_, asset, multiple = [], None, 1.0, 1.0
    for i, sig in enumerate(buys):
        if sig is not None:
            if open_ is None:
                open_ = (sig[0], px[sig[0]][i], sig[1], px[sig[1]][i])
            else:
                lt, lp, st, sp = open_
                multiple *= 1 + (px[lt][i] - lp) + (sp - px[st][i])
                asset, open_ = multiple, None
        elif open_ is not None:
            lt, lp, st, sp = open_
            asset = (1 + (px[lt][i] - lp) + (sp - px[st][i])) * multiple
        out.append(asset)
    return np.array(out), sum(1 for s in buys if s is not None)


def test_distance_method_reproduces_lecture_7(tmp_path):
    dates, a, b = pair_prices()
    js = run_js(tmp_path, "return Q.pairsBacktest(data.d, data.a, data.b, { formation: 252, trading: 128, entry: 2, exit: 0 });",
                {"d": dates, "a": a.tolist(), "b": b.tolist()})
    ref, signals = lecture7(a, b, 252, 128)
    assert len(js["windows"]) == 1 and len(js["equity"]) == 128
    assert np.allclose(js["equity"], ref, rtol=1e-12, atol=1e-12)
    assert 2 * len(js["trades"]) == signals > 0  # an open and a close per trade
    assert js["windows"][0]["sigma"] == pytest.approx(np.std(a[:252] / a[0] - b[:252] / b[0], ddof=1), rel=1e-12)


def test_walk_forward_windows_chain_and_close_at_each_end(tmp_path):
    dates, a, b = pair_prices(n=600)
    js = run_js(tmp_path, "return Q.pairsBacktest(data.d, data.a, data.b, { formation: 252, trading: 126 });",
                {"d": dates, "a": a.tolist(), "b": b.tolist()})
    assert [w["tradeStart"] for w in js["windows"]] == [dates[252], dates[378], dates[504]]
    assert js["dates"][0] == dates[252] and js["dates"][-1] == dates[-1] and len(js["dates"]) == 600 - 252
    for w in js["windows"]:  # nothing is carried from one window into the next
        k = js["dates"].index(w["tradeEnd"])
        assert js["position"][k] == 0
    s = js["stats"]["strategy"]
    assert s["total"] == pytest.approx(js["equity"][-1] - 1, rel=1e-12)
    assert s["trades"] == len(js["trades"])


def test_costs_are_charged_on_both_legs_at_open_and_close(tmp_path):
    dates, a, b = pair_prices()
    body = """const free = Q.pairsBacktest(data.d, data.a, data.b, { formation: 252, trading: 128 });
              const paid = Q.pairsBacktest(data.d, data.a, data.b, { formation: 252, trading: 128, cost: 10 });
              return { free: free.trades.map((t) => t.ret), paid: paid.trades.map((t) => t.ret) };"""
    js = run_js(tmp_path, body, {"d": dates, "a": a.tolist(), "b": b.tolist()})
    assert js["free"] and len(js["free"]) == len(js["paid"])
    for f, p in zip(js["free"], js["paid"]):
        assert 1 + p == pytest.approx((1 + f) * (1 - 0.002) ** 2, rel=1e-12)  # 10 bps on 2 units, twice


def test_cointegration_method_uses_the_formation_hedge_ratio(tmp_path):
    dates, a, b = pair_prices()
    js = run_js(tmp_path, "return Q.pairsBacktest(data.d, data.a, data.b, { method: 'coint', formation: 252, trading: 128, entry: 2, exit: 0.5 });",
                {"d": dates, "a": a.tolist(), "b": b.tolist()})
    beta, alpha = np.polyfit(np.log(b[:252]), np.log(a[:252]), 1)
    w = js["windows"][0]
    assert w["beta"] == pytest.approx(beta, rel=1e-9) and w["alpha"] == pytest.approx(alpha, rel=1e-9)
    resid = np.log(a[:252]) - alpha - beta * np.log(b[:252])
    z = (np.log(a[252:]) - alpha - beta * np.log(b[252:]) - resid.mean()) / resid.std(ddof=1)
    assert np.allclose(js["spread"], z, rtol=1e-8, atol=1e-8)
    opened = [js["dates"].index(t["open"]) for t in js["trades"]]
    assert opened and all(abs(z[i]) > 2 for i in opened)


def test_adf_matches_statsmodels_and_half_life(tmp_path):
    rng = np.random.default_rng(3)
    y = np.zeros(300)
    for t in range(1, 300):
        y[t] = 0.9 * y[t - 1] + rng.normal()
    js = run_js(tmp_path, "return { adf: Q.adf(data.y, 1), hl: Q.halfLife(data.y), verdict: Q.egVerdict(Q.adf(data.y, 1).stat) };", {"y": y.tolist()})
    assert js["adf"]["stat"] == pytest.approx(adfuller(y, maxlag=1, regression="c", autolag=None, result_object=False)[0], rel=1e-9)
    b = np.polyfit(y[:-1], np.diff(y), 1)[0]
    assert js["hl"] == pytest.approx(-math.log(2) / math.log(1 + b), rel=1e-9)
    assert js["verdict"] == "cointegrated at 5%"  # -3.57: past the 5% value (-3.34), not the 1% (-3.90)


def test_find_pairs_ranks_by_sse(tmp_path):
    _, a, b = pair_prices()
    rng = np.random.default_rng(1)
    c = 80 * np.exp(np.cumsum(rng.normal(0.001, 0.02, len(a))))
    js = run_js(tmp_path, "return Q.findPairs(['A', 'B', 'C'], [data.a, data.b, data.c], 0, 252);",
                {"a": a.tolist(), "b": b.tolist(), "c": c.tolist()})
    assert [(p["a"], p["b"]) for p in js][0] == ("A", "B")
    assert js[0]["sse"] == pytest.approx(np.sum((a[:252] / a[0] - b[:252] / b[0]) ** 2), rel=1e-12)
    assert js[0]["sse"] <= js[1]["sse"] <= js[2]["sse"]


@pytest.mark.parametrize("score, label", [(1.0, "AAA"), (1.1, "AAA"), (1.4, "AA+"), (1.7, "AA+"), (2.0, "AA"), (2.3, "AA-"),
                                          (2.7, "A+"), (4.0, "BBB"), (4.34, "BBB-"), (6.7, "CCC+"), (7.0, "CCC")])
def test_grade_labels(tmp_path, score, label):
    assert run_js(tmp_path, "return Q.gradeLabel(data);", score) == label


def test_credit_ratios_and_weighted_grade(tmp_path):
    figures = {"revenue": 1000.0, "ebitda": 200.0, "interest": 20.0, "debt": 500.0, "cash": 100.0, "equity": 1000.0, "cfo": 150.0,
               "current_assets": 300.0, "current_liabilities": 200.0}
    js = run_js(tmp_path, "const r = Q.creditRatios(data); return { r, s: Q.creditScore(r, { revenueKrw: 5e11 }) };", figures)
    r = js["r"]
    assert r["debt_ebitda"] == 2.5 and r["coverage"] == 10 and r["ebitda_margin"] == 0.2
    assert r["debt_capital"] == pytest.approx(1 / 3) and r["cfo_debt"] == 0.3 and r["net_debt_ebitda"] == 2 and r["current_ratio"] == 1.5
    grades = {p["id"]: p["grade"] for p in js["s"]["parts"]}
    assert grades == {"debt_ebitda": 4, "coverage": 4, "debt_capital": 3, "ebitda_margin": 3, "cfo_debt": 4}  # BBB BBB A A BBB
    assert js["s"]["score"] == pytest.approx(0.30 * 4 + 0.25 * 4 + 0.15 * 3 + 0.15 * 3 + 0.15 * 4)
    assert js["s"]["grade"] == "BBB+" and not js["s"]["small"]


def test_credit_edge_cases(tmp_path):
    body = """return {
      noDebt: Q.creditScore(Q.creditRatios({ revenue: 100, ebitda: 30, interest: 0, debt: 0, equity: 50, cfo: 20 })),
      loss: Q.creditScore(Q.creditRatios({ revenue: 100, ebitda: -5, interest: 4, debt: 80, equity: -10, cfo: -3 })),
      small: Q.creditScore(Q.creditRatios({ revenue: 5e10, ebitda: 1e10, interest: 1e9, debt: 2e10, equity: 4e10, cfo: 8e9 }), { revenueKrw: 5e10 }),
      sparse: Q.creditScore(Q.creditRatios({ revenue: 100, ebitda: 10 })) };"""
    js = run_js(tmp_path, body)
    assert js["noDebt"]["grade"] == "AAA"
    assert js["loss"]["grade"] == "CCC"
    big = run_js(tmp_path, "return Q.creditScore(Q.creditRatios({ revenue: 5e10, ebitda: 1e10, interest: 1e9, debt: 2e10, equity: 4e10, cfo: 8e9 }));")
    assert js["small"]["small"] and js["small"]["score"] == pytest.approx(big["score"] + 1 / 3)
    assert js["sparse"]["grade"] == "n/a"


def test_portfolio_summary_and_exposure(tmp_path):
    holdings = [
        {"sym": "AAPL", "qty": 10, "cost": 150, "price": 200, "prev": 190, "fx": 1, "sec": "Technology"},
        {"sym": "005930.KS", "qty": 5, "cost": 70000, "price": 80000, "prev": 80000, "fx": 1 / 1300, "sec": "Technology"},
        {"sym": "XOM", "qty": 20, "cost": None, "price": 110, "prev": None, "fx": 1, "sec": "Energy"},
        {"sym": "NOPE", "qty": 1, "cost": 1, "price": None, "prev": None, "fx": 1, "sec": "Energy"},
    ]
    js = run_js(tmp_path, "const s = Q.portfolioSummary(data); return { s, sec: Q.exposure(s.rows, 'sec') };", holdings)
    s = js["s"]
    v = [2000, 5 * 80000 / 1300, 2200]
    assert s["total"] == pytest.approx(sum(v)) and s["unpriced"] == 1
    assert s["basis"] == pytest.approx(1500 + 5 * 70000 / 1300)
    assert s["pnl"] == pytest.approx(500 + 5 * 10000 / 1300)  # XOM has no cost basis, so no P&L
    assert s["day"] == pytest.approx(100) and s["dayPct"] == pytest.approx(100 / (2000 - 100 + 5 * 80000 / 1300))
    assert s["rows"][0]["weight"] == pytest.approx(2000 / sum(v))
    assert s["hhi"] == pytest.approx(sum((x / sum(v)) ** 2 for x in v)) and s["largest"]["sym"] == "XOM"
    assert js["sec"][0]["key"] == "Technology" and js["sec"][0]["weight"] == pytest.approx((v[0] + v[1]) / sum(v))
