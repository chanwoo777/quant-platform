"""The research tools' maths in docs/assets/quant.js (Compare, correlations, sector map, alerts),
checked under Node.js against hand calculations in numpy."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
QUANT_JS = ROOT / "docs" / "assets" / "quant.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def run_js(tmp_path: Path, body: str, data=None):
    (tmp_path / "data.json").write_text(json.dumps(data), encoding="utf-8")
    script = tmp_path / "run.js"
    script.write_text(
        f"const Q = require({json.dumps(str(QUANT_JS))});\n"
        f"const data = JSON.parse(require('fs').readFileSync({json.dumps(str(tmp_path / 'data.json'))}, 'utf8'));\n"
        f"const out = (() => {{ {body} }})();\n"
        "process.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


@pytest.fixture(scope="module")
def market():
    """One ticker, a benchmark and Fama-French factors over 500 business days."""
    rng = np.random.default_rng(21)
    idx = pd.bdate_range("2024-10-28", periods=500)
    f = pd.DataFrame({"mkt_rf": rng.normal(0.0004, 0.01, 500), "smb": rng.normal(0, 0.005, 500),
                      "hml": rng.normal(0, 0.005, 500), "mom": rng.normal(0, 0.006, 500)}, index=idx)
    f["rf"] = 0.00016
    bench = f.mkt_rf + f.rf + rng.normal(0, 0.002, 500)
    stock = 0.0002 + f.rf + 1.2 * f.mkt_rf - 0.3 * f.smb + 0.4 * f.hml + rng.normal(0, 0.012, 500)
    rf_daily = np.full(500, 0.0421 / 252)
    return {"dates": [f"{d:%Y-%m-%d}" for d in idx], "stock": stock.tolist(), "bench": bench.tolist(), "rf": rf_daily.tolist(),
            "factors": {"d": [f"{d:%Y-%m-%d}" for d in idx], **{c: f[c].tolist() for c in f}}}


def test_sharpe_sortino_beta_volatility_match_hand_calculation(tmp_path, market):
    js = run_js(tmp_path, "return Q.riskStats(data.stock, { rf: data.rf, bench: data.bench });", market)
    r, b, rf = np.array(market["stock"]), np.array(market["bench"]), np.array(market["rf"])
    ex = r - rf
    assert js["vol"] == pytest.approx(r.std(ddof=1) * math.sqrt(252), rel=1e-12)
    assert js["sharpe"] == pytest.approx(ex.mean() / ex.std(ddof=1) * math.sqrt(252), rel=1e-12)
    downside = math.sqrt(np.mean(np.minimum(ex, 0) ** 2))
    assert js["sortino"] == pytest.approx(ex.mean() * 252 / (downside * math.sqrt(252)), rel=1e-12)
    assert js["beta"] == pytest.approx(np.cov(r, b, ddof=1)[0, 1] / b.var(ddof=1), rel=1e-12)


def test_factor_betas_match_least_squares(tmp_path, market):
    js = run_js(tmp_path, """
        const stock = { dates: data.dates, returns: data.stock };
        return ["FF3", "Carhart"].map((m) => Q.factorRegression(stock, data.factors, m, { window: 1e9, minObs: 60 }));""", market)
    f = pd.DataFrame(market["factors"]).set_index("d")
    y = np.array(market["stock"]) - f.rf.to_numpy()
    for fit, cols in zip(js, (["mkt_rf", "smb", "hml"], ["mkt_rf", "smb", "hml", "mom"])):
        X = np.column_stack([np.ones(len(y)), f[cols].to_numpy()])
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ coef
        r2 = 1 - (resid @ resid) / ((y - y.mean()) @ (y - y.mean()))
        assert [fit["betas"][c] for c in cols] == pytest.approx(coef[1:].tolist(), rel=1e-9)
        assert fit["alpha_annual"] == pytest.approx(coef[0] * 252, rel=1e-9)
        assert fit["r_squared"] == pytest.approx(r2, rel=1e-9)
    assert js[0]["betas"]["mkt_rf"] == pytest.approx(1.2, abs=0.1)  # the planted loading


def test_returns_drawdown_and_weekly_factors(tmp_path):
    dates = [f"{d:%Y-%m-%d}" for d in pd.bdate_range("2023-01-02", periods=900)]
    values = (100 * np.exp(np.cumsum(np.random.default_rng(3).normal(0.0004, 0.015, 900)))).tolist()
    js = run_js(tmp_path, """
        const last = data.dates[data.dates.length - 1];
        return { m1: Q.returnSince(data.dates, data.values, Q.shiftIso(last, { months: 1 })),
          y3: Q.returnSince(data.dates, data.values, Q.shiftIso(last, { years: 3 }), 3),
          y5: Q.returnSince(data.dates, data.values, Q.shiftIso(last, { years: 5 })), mdd: Q.maxDrawdown(data.values),
          keys: ["2026-10-25", "2026-10-26", "2026-10-31"].map(Q.weekKey),
          wf: Q.weeklyFactors({ d: data.dates.slice(0, 10), mkt_rf: data.values.slice(0, 10).map((v) => v / 10000) }) };""",
                {"dates": dates, "values": values})
    s = pd.Series(values, index=pd.to_datetime(dates))
    last = s.index[-1]
    assert js["m1"] == pytest.approx(s.iloc[-1] / s.loc[: last - pd.DateOffset(months=1)].iloc[-1] - 1, rel=1e-12)
    base = s.loc[: last - pd.DateOffset(years=3)].iloc[-1]
    assert js["y3"] == pytest.approx((s.iloc[-1] / base) ** (1 / 3) - 1, rel=1e-12)
    assert js["y5"] is None  # history too short: NaN serialises as null, shown as n/a
    assert js["mdd"] == pytest.approx((s / s.cummax() - 1).min(), rel=1e-12)
    assert js["keys"] == ["2026-10-25", "2026-10-25", "2026-10-25"]  # Sunday-started weeks
    r = np.array(values[:10]) / 10000
    assert js["wf"]["d"] == ["2023-01-01", "2023-01-08"]
    assert js["wf"]["mkt_rf"] == pytest.approx([np.prod(1 + r[:5]) - 1, np.prod(1 + r[5:]) - 1], rel=1e-12)


def test_correlation_matrix_is_symmetric_with_unit_diagonal(tmp_path):
    rng = np.random.default_rng(5)
    common = rng.normal(0, 0.01, 300)
    cols = [common + rng.normal(0, s, 300) for s in (0.004, 0.006, 0.02)] + [rng.normal(0, 0.01, 300), -common + rng.normal(0, 0.005, 300)]
    js = run_js(tmp_path, """const C = Q.correlationMatrix(data);
        return { C, order: Q.clusterOrder(C), stats: Q.pairStats(C, ["A", "B", "C", "D", "E"]) };""", [c.tolist() for c in cols])
    C = np.array(js["C"])
    assert np.array_equal(C, C.T)  # exactly symmetric
    assert np.all(np.diag(C) == 1.0)
    assert C == pytest.approx(np.corrcoef(cols), abs=1e-12)
    # A and B share most of the common factor, so clustering puts them side by side.
    pos = {k: i for i, k in enumerate(js["order"])}
    assert abs(pos[0] - pos[1]) == 1 and sorted(js["order"]) == [0, 1, 2, 3, 4]
    upper = C[np.triu_indices(5, 1)]
    assert js["stats"]["average"] == pytest.approx(upper.mean(), rel=1e-12)
    assert {js["stats"]["most"]["a"], js["stats"]["most"]["b"]} == {"A", "B"}
    assert js["stats"]["least"]["rho"] == pytest.approx(upper.min(), rel=1e-12)


def test_squarified_treemap_fills_the_box_proportionally(tmp_path):
    values = [43.0, 23.8, 19.1, 13.5, 12.8, 10.6, 7.7, 7.2, 6.6, 3.8, 2.8, 0, None]
    js = run_js(tmp_path, "return Q.squarify(data, 0, 0, 900, 540);", values)
    assert sorted(r["i"] for r in js) == list(range(11))  # zero and missing sizes get no tile
    total = sum(v for v in values if v)
    for r in js:
        assert r["w"] * r["h"] == pytest.approx(values[r["i"]] / total * 900 * 540, rel=1e-9)
        assert -1e-6 <= r["x"] and r["x"] + r["w"] <= 900 + 1e-6 and -1e-6 <= r["y"] and r["y"] + r["h"] <= 540 + 1e-6
    assert sum(r["w"] * r["h"] for r in js) == pytest.approx(900 * 540, rel=1e-9)


def test_sector_moves_handle_missing_fields(tmp_path):
    rows = [{"sec": "Tech", "cap": 3.0, "r1d": 0.02}, {"sec": "Tech", "cap": 1.0, "r1d": -0.02}, {"sec": "Tech", "cap": 2.0, "r1d": None},
            {"sec": "Energy", "cap": None, "r1d": 0.01}, {"sec": "Energy", "cap": None, "r1d": 0.03},
            {"sec": None, "cap": 1.0, "r1d": None}]
    js = {g["key"]: g for g in run_js(tmp_path, 'return Q.groupMoves(data, "sec");', rows)}
    assert js["Tech"]["change"] == pytest.approx((3 * 0.02 - 1 * 0.02) / 4) and js["Tech"]["missing"] == 1 and js["Tech"]["cap"] == 6
    assert js["Energy"]["change"] == pytest.approx(0.02) and js["Energy"]["cap"] is None  # equal-weighted, cap n/a
    assert js["Unknown"]["change"] is None and js["Unknown"]["n"] == 1  # shown as n/a, never guessed
