"""The website's quant.js must agree with the Python models (run through Node.js if installed)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from quant import analytics as an
from quant import quant_models as qm

ROOT = Path(__file__).resolve().parent.parent
QUANT_JS = ROOT / "docs" / "assets" / "quant.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def run_js(tmp_path: Path, body: str, data) -> dict:
    (tmp_path / "data.json").write_text(json.dumps(data), encoding="utf-8")
    script = tmp_path / "run.js"
    script.write_text(
        f"const Q = require({json.dumps(str(QUANT_JS))});\n"
        f"const data = JSON.parse(require('fs').readFileSync({json.dumps(str(tmp_path / 'data.json'))}, 'utf8'));\n"
        f"const out = (() => {{ {body} }})();\n"
        "process.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


def nan_to_none(values) -> list:
    return [None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v) for v in values]


@pytest.fixture(scope="module")
def synthetic():
    rng = np.random.default_rng(7)
    idx = pd.bdate_range("2022-01-03", periods=900)
    cols = ["mkt_rf", "smb", "hml", "rf", "mom", "smb5", "rmw", "cma"]
    f = pd.DataFrame(rng.normal(0, 0.01, (len(idx), len(cols))), index=idx, columns=cols)
    f["rf"] = 0.0001
    r = 0.0003 + 1.1 * f.mkt_rf + 0.3 * f.smb - 0.2 * f.hml + 0.15 * f.mom + 0.1 * f.rmw + rng.normal(0, 0.012, len(idx))
    r.iloc[[5, 6, 300]] = np.nan  # trading halts
    f.iloc[[50, 51], f.columns.get_loc("hml")] = np.nan  # missing factor prints
    f = f.iloc[:-40]  # the French library lags the price history
    return r.rename("r"), f


def test_factor_regressions_match_python(tmp_path, synthetic):
    r, f = synthetic
    data = {"dates": [f"{d:%Y-%m-%d}" for d in r.index], "returns": nan_to_none(r),
            "factors": {"d": [f"{d:%Y-%m-%d}" for d in f.index], **{c: nan_to_none(f[c]) for c in f}}}
    js = run_js(tmp_path, """
        const stock = { dates: data.dates, returns: data.returns }, out = {};
        for (const m of ["FF3", "Carhart", "FF5"]) out[m] = { fit: Q.factorRegression(stock, data.factors, m), roll: Q.rollingExposures(stock, data.factors, m) };
        return out;""", data)
    for model in ("FF3", "Carhart", "FF5"):
        py = qm.factor_regression(r, f, qm.MODELS[model], ticker="X")
        fit = js[model]["fit"]
        assert fit["n_obs"] == py.n_obs and fit["start"] == f"{py.start}" and fit["end"] == f"{py.end}"
        assert fit["alpha_annual"] == pytest.approx(py.alpha_annual, rel=1e-6)
        assert fit["alpha_t"] == pytest.approx(py.alpha_t, rel=1e-6)  # Newey-West, 5 lags, n/(n-k)
        assert fit["r_squared"] == pytest.approx(py.r_squared, rel=1e-9)
        assert fit["idio_vol_annual"] == pytest.approx(py.idio_vol_annual, rel=1e-9)
        for k in qm.MODELS[model]:
            assert fit["betas"][k] == pytest.approx(py.betas[k], rel=1e-7)
            assert fit["t_stats"][k] == pytest.approx(py.t_stats[k], rel=1e-6)
            assert fit["variance_share"][k] == pytest.approx(py.variance_share[k], rel=1e-6, abs=1e-12)
            assert fit["return_attribution"][k] == pytest.approx(py.return_attribution[k], rel=1e-6, abs=1e-12)
        assert fit["tilts"] == py.tilts and fit["dominant_driver"] == py.dominant_driver
        roll = qm.rolling_exposures(r, f, qm.MODELS[model])
        assert js[model]["roll"]["d"] == [f"{d:%Y-%m-%d}" for d in roll.index]
        for k in qm.MODELS[model]:
            assert js[model]["roll"][k] == pytest.approx(roll[k].tolist(), rel=1e-7)


def test_indicators_match_python(tmp_path):
    rng = np.random.default_rng(3)
    close = pd.Series(100 * np.cumprod(1 + rng.normal(0.0005, 0.015, 300)), index=pd.bdate_range("2025-01-01", periods=300))
    ref = an.add_indicators(pd.DataFrame({"open": close, "high": close, "low": close, "close": close, "adj_close": close,
                                          "volume": 1.0}))
    js = run_js(tmp_path, "return { sma: Q.sma(data, 50), rsi: Q.rsi(data, 14), bb: Q.bollinger(data, 20, 2) };", close.tolist())
    assert js["sma"][-1] == pytest.approx(ref.sma_50.iloc[-1])
    assert js["rsi"][-1] == pytest.approx(ref.rsi_14.iloc[-1], abs=0.5)
    assert js["bb"]["upper"][-1] == pytest.approx(ref.bb_upper.iloc[-1], rel=1e-6)


def test_backtest_has_no_lookahead_and_counts_trades(tmp_path):
    # A strategy that "knows" tomorrow's winner would earn ~100%/day if the engine leaked
    # returns. With W[t] applied to R[t+1] it can only earn what yesterday's choice earns.
    data = {"P": [[100, 100], [110, 90], [99, 99], [108.9, 89.1], [98, 98]], "dates": [f"2026-01-0{i + 1}" for i in range(5)]}
    js = run_js(tmp_path, """
        const peek = { weights: (P) => ({ W: P.map((row, t) => t + 1 < P.length ? (P[t + 1][0] > row[0] ? [1, 0] : [0, 1]) : [0, 0]) }) };
        const bt = Q.backtest({ dates: data.dates, symbols: ["A", "B"], P: data.P, strategy: peek, params: {}, costBps: 0 });
        const mom = Q.STRATEGIES.find((s) => s.id === "buyhold");
        const bh = Q.backtest({ dates: data.dates, symbols: ["A", "B"], P: data.P, strategy: mom, params: {}, costBps: 10 });
        return { rets: bt.rets, trades: bt.trades, bh: bh.rets };""", data)
    # Day t's return uses W[t-1], which was chosen with data through t-1 (peeking at t), so the
    # peeking strategy does profit; the engine's job is to apply weights to the *next* day only.
    assert js["rets"][0] == 0
    assert js["rets"][1] == pytest.approx(0.10)  # W[0] picked A, which rose 10% on day 1
    assert len([t for t in js["trades"] if not t.get("open")]) >= 2
    assert js["bh"][0] == pytest.approx(-0.001)  # entering costs 10 bps on 100% turnover
    assert js["bh"][1] == pytest.approx(0.0)  # +10% and -10% at 50/50
