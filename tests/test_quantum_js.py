"""The Quantum page's maths (docs/assets/quantum.js, run through Node.js if installed) must agree
with textbook values and with the Python references written here."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from scipy.stats import norm

ROOT = Path(__file__).resolve().parent.parent
QUANTUM_JS = ROOT / "docs" / "assets" / "quantum.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def bs_price(s, k, t, r, vol, kind="call"):
    d1 = (math.log(s / k) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if kind == "call":
        return s * norm.cdf(d1) - k * math.exp(-r * t) * norm.cdf(d2)
    return k * math.exp(-r * t) * norm.cdf(-d2) - s * norm.cdf(-d1)


def run_js(tmp_path: Path, body: str, data=None):
    (tmp_path / "data.json").write_text(json.dumps(data), encoding="utf-8")
    script = tmp_path / "run.js"
    script.write_text(
        f"const QX = require({json.dumps(str(QUANTUM_JS))});\n"
        f"const data = JSON.parse(require('fs').readFileSync({json.dumps(str(tmp_path / 'data.json'))}, 'utf8'));\n"
        f"const out = (() => {{ {body} }})();\n"
        "process.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


# --- option pricing (section 5) --------------------------------------------------------------------

def test_black_scholes_matches_reference_values(tmp_path):
    # Hull's textbook case: S = K = 100, T = 1, r = 5%, vol = 20% -> call 10.4506, put 5.5735.
    js = run_js(tmp_path, """return { call: QX.blackScholes(100, 100, 1, 0.05, 0.2).price, put: QX.blackScholes(100, 100, 1, 0.05, 0.2, "put").price,
        grid: data.map(([S, K, T, r, v]) => [QX.blackScholes(S, K, T, r, v).price, QX.blackScholes(S, K, T, r, v, "put").price]) };""",
                [[343.91, 343.91, 90 / 365, 0.0413, 0.265], [50, 60, 0.25, 0.03, 0.6], [1200, 1000, 0.5, 0.045, 0.35]])
    assert js["call"] == pytest.approx(10.4506, abs=0.01)
    assert js["put"] == pytest.approx(5.5735, abs=0.01)
    for (S, K, T, r, v), (call, put) in zip([[343.91, 343.91, 90 / 365, 0.0413, 0.265], [50, 60, 0.25, 0.03, 0.6],
                                              [1200, 1000, 0.5, 0.045, 0.35]], js["grid"]):
        assert call == pytest.approx(bs_price(S, K, T, r, v), abs=1e-4)
        assert put == pytest.approx(bs_price(S, K, T, r, v, "put"), abs=1e-4)
        assert call - put == pytest.approx(S - K * math.exp(-r * T), abs=1e-4)  # put-call parity


def test_normal_cdf_is_accurate(tmp_path):
    xs = np.linspace(-6, 6, 241).tolist()
    js = run_js(tmp_path, "return data.map(QX.normCdf);", xs)
    assert np.max(np.abs(np.array(js) - norm.cdf(xs))) < 2e-7


def test_monte_carlo_converges_to_black_scholes(tmp_path):
    js = run_js(tmp_path, """
        const a = { S: 100, K: 100, T: 1, r: 0.05, vol: 0.2 };
        return [1e3, 1e4, 1e5, 1e6].map((n) => QX.mcOption(Object.assign({ n, seed: 3 }, a)));""")
    bs = 10.4506
    errors = [abs(r["price"] - bs) for r in js]
    for r in js:
        assert r["ci"][0] - 1e-9 <= r["price"] <= r["ci"][1] + 1e-9
        assert abs(r["price"] - bs) < 4 * r["se"]  # within 4 standard errors
    ses = [r["se"] for r in js]
    for a, b in zip(ses, ses[1:]):
        assert b / a == pytest.approx(1 / math.sqrt(10), rel=0.15)  # error shrinks like 1/sqrt(N)
    assert errors[-1] < 0.05


def test_volatility_and_lognormal_bounds(tmp_path):
    rng = np.random.default_rng(4)
    closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 400)))
    js = run_js(tmp_path, "return { v63: QX.annualVol(data, 63), v126: QX.annualVol(data, 126), b: QX.lognormalBounds(343.91, 90 / 365, 0.0413, 0.265) };",
                closes.tolist())
    lr = np.diff(np.log(closes))
    assert js["v63"] == pytest.approx(lr[-63:].std(ddof=1) * math.sqrt(252), rel=1e-12)
    assert js["v126"] == pytest.approx(lr[-126:].std(ddof=1) * math.sqrt(252), rel=1e-12)
    s, t, r, v = 343.91, 90 / 365, 0.0413, 0.265
    mu, sig2 = math.log(s) + (r - v * v / 2) * t, v * v * t
    mean, sd = math.exp(mu + sig2 / 2), math.sqrt((math.exp(sig2) - 1) * math.exp(2 * mu + sig2))
    assert [js["b"]["mu"], js["b"]["sigma2"], js["b"]["low"], js["b"]["high"]] == pytest.approx([mu, sig2, mean - 3 * sd, mean + 3 * sd], rel=1e-12)


def test_risk_free_rate_prefers_the_t_bill_series(tmp_path):
    js = run_js(tmp_path, """return [
        QX.riskFree({ rf: { id: "DGS3MO", value: 4.22, date: "2026-10-23" }, fred: [{ id: "DFF", value: 3.88 }] }, null),
        QX.riskFree({ fred: [{ id: "DFF", value: 3.88, date: "2026-10-23" }] }, null),
        QX.riskFree(null, { rate: { series: "DGS3MO", percent: 4.1, label: "x", date: "d" } }),
        QX.riskFree(null, null)];""")
    assert [r["series"] for r in js] == ["DGS3MO", "DFF", "DGS3MO", None]
    assert js[0]["r"] == pytest.approx(math.log(1.0422))
