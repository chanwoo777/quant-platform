"""Every financial calculation on the site, checked against values worked out by hand.

Each test uses a handful of numbers small enough to check on paper; the working is in the comments.
The browser's maths (docs/assets/quant.js, quantum.js) runs under Node.js; the nightly job's maths
(quant/universe/scoring.py, quant/quant_models.py) runs here. tests/test_research_js.py and
tests/test_quantum_js.py add checks against numpy and scipy on larger, random data.

Covered: returns (simple, since a date, annualised), volatility, max drawdown, Sharpe, Sortino,
beta, factor regression, correlation, VaR and CVaR, Black-Scholes, plus the Python versions of
returns, volatility, drawdown and the factor model.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ASSETS = Path(__file__).resolve().parent.parent / "docs" / "assets"
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="needs Node.js")

# Four daily returns used throughout: mean 0.005; deviations ±0.015, ±0.025;
# sum of squared deviations 2 x 0.000225 + 2 x 0.000625 = 0.0017; sample variance 0.0017 / 3.
R = [0.02, -0.01, 0.03, -0.02]
SD = math.sqrt(0.0017 / 3)  # 0.0238048...


def js(tmp_path: Path, body: str):
    script = tmp_path / "calc.js"
    script.write_text(f"const Q = require({json.dumps(str(ASSETS / 'quant.js'))});\n"
                      f"const QX = require({json.dumps(str(ASSETS / 'quantum.js'))});\n"
                      f"const out = (() => {{ {body} }})();\nprocess.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


# --- returns -------------------------------------------------------------------------------------

@needs_node
def test_returns(tmp_path):
    out = js(tmp_path, """
      const d = ["2024-01-02", "2025-01-02", "2026-01-02"];
      return { daily: Q.returns([100, 110, 99, 108.9]),
               since: Q.returnSince(d, [100, 110, 121], "2025-01-02"),
               annual: Q.returnSince(d, [100, 110, 121], "2024-01-02", 2),
               before: Q.returnSince(d, [100, 110, 121], "2023-01-01") };""")
    # 110/100 - 1 = 0.10; 99/110 - 1 = -0.10; 108.9/99 - 1 = 0.10; the first day has no return.
    assert out["daily"][0] is None and out["daily"][1:] == pytest.approx([0.10, -0.10, 0.10])
    assert out["since"] == pytest.approx(0.10)      # 121 / 110 - 1
    assert out["annual"] == pytest.approx(0.10)     # (121 / 100) ** (1 / 2) - 1 = 1.1 - 1
    assert out["before"] is None                    # history starts after the date: n/a, not a guess


# --- volatility, Sharpe, Sortino, beta ----------------------------------------------------------------

@needs_node
def test_volatility_sharpe_sortino_beta(tmp_path):
    out = js(tmp_path, f"""
      const r = {R}, b = [0.01, -0.01, 0.02, -0.02];
      return {{ one: Q.riskStats(r, {{ ppy: 1, bench: b }}), daily: Q.riskStats(r),
               rf: Q.riskStats(r, {{ ppy: 1, rf: [0.001, 0.001, 0.001, 0.001] }}) }};""")
    one = out["one"]
    assert one["vol"] == pytest.approx(SD)                      # sample std, not annualised (ppy = 1)
    assert out["daily"]["vol"] == pytest.approx(SD * math.sqrt(252))
    assert one["sharpe"] == pytest.approx(0.005 / SD)           # 0.2100...
    assert out["daily"]["sharpe"] == pytest.approx(0.005 / SD * math.sqrt(252))
    # Downside deviation: sqrt(mean(min(r, 0)^2)) = sqrt((0.0001 + 0.0004) / 4) = sqrt(0.000125).
    assert one["sortino"] == pytest.approx(0.005 / math.sqrt(0.000125))  # = sqrt(0.2) = 0.4472...
    # Beta: cov(r, b) = (0.015*0.01 + 0.015*0.01 + 0.025*0.02 + 0.025*0.02) / 3 = 0.0013 / 3;
    # var(b) = (0.0001 + 0.0001 + 0.0004 + 0.0004) / 3 = 0.001 / 3; beta = 1.3.
    assert one["beta"] == pytest.approx(1.3)
    # A constant 0.1% risk-free rate lowers the mean excess return to 0.004; the std is unchanged.
    assert out["rf"]["sharpe"] == pytest.approx(0.004 / SD)


# --- drawdown --------------------------------------------------------------------------------------

@needs_node
def test_max_drawdown(tmp_path):
    out = js(tmp_path, "return [Q.maxDrawdown([100, 120, 90, 110, 60, 80]), Q.maxDrawdown([1, 2, 3])];")
    assert out == pytest.approx([-0.5, 0.0])  # peak 120, trough 60: 60/120 - 1; a rising series never draws down


# --- factor regression --------------------------------------------------------------------------------

def factor_frame(n=150):
    """Factors that are clearly not collinear, and a stock built exactly from them:
    excess return = 0.0002 + 1.2 mkt + 0.5 smb - 0.3 hml, with no noise."""
    t = np.arange(n)
    f = pd.DataFrame({"mkt_rf": 0.01 * np.sin(t / 3.0), "smb": 0.006 * np.cos(t / 7.0), "hml": 0.004 * np.sin(t / 11.0 + 1),
                      "rf": np.full(n, 0.0001)}, index=pd.bdate_range("2025-01-02", periods=n))
    excess = 0.0002 + 1.2 * f.mkt_rf + 0.5 * f.smb - 0.3 * f.hml
    return f, excess + f.rf


@needs_node
def test_factor_regression_recovers_known_betas(tmp_path):
    f, stock = factor_frame()
    out = js(tmp_path, f"""
      const f = {json.dumps({"d": [f"{d:%Y-%m-%d}" for d in f.index], **{c: f[c].tolist() for c in f}})};
      const s = {{ dates: f.d, returns: {json.dumps(stock.tolist())} }};
      const e = Q.factorRegression(s, f, "FF3");
      return {{ betas: e.betas, alpha: e.alpha_annual, r2: e.r_squared, n: e.n_obs }};""")
    assert out["betas"] == pytest.approx({"mkt_rf": 1.2, "smb": 0.5, "hml": -0.3}, abs=1e-9)
    assert out["alpha"] == pytest.approx(0.0002 * 252)  # daily alpha x 252 trading days = 0.0504
    assert out["r2"] == pytest.approx(1.0) and out["n"] == 150


def test_python_factor_regression_recovers_known_betas():
    from quant.quant_models import FF3, factor_regression

    f, stock = factor_frame()
    e = factor_regression(stock, f, FF3)
    assert e.betas == pytest.approx({"mkt_rf": 1.2, "smb": 0.5, "hml": -0.3}, abs=1e-9)
    assert e.alpha_annual == pytest.approx(0.0504) and e.r_squared == pytest.approx(1.0)


# --- correlation -----------------------------------------------------------------------------------

@needs_node
def test_correlation(tmp_path):
    out = js(tmp_path, "return Q.correlationMatrix([[1, 2, 3, 4], [2, 4, 6, 8], [4, 3, 2, 1], [1, 3, 2, 4]]);")
    assert out[0] == pytest.approx([1, 1, -1, 0.8])
    # [1,2,3,4] vs [1,3,2,4]: deviations (-1.5,-.5,.5,1.5) and (-1.5,.5,-.5,1.5); products sum to 4,
    # each variance sums to 5, so the correlation is 4 / 5 = 0.8.
    assert out[3][0] == pytest.approx(0.8) and out[2][2] == 1


# --- VaR and CVaR -----------------------------------------------------------------------------------

@needs_node
def test_var_and_cvar(tmp_path):
    out = js(tmp_path, """
      const r = [-0.05, -0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04];
      return [QX.varCvar(r, 0.95), QX.varCvar(r, 0.8)];""")
    # 95%: the 5% quantile sits at position 9 x 0.05 = 0.45 between -0.05 and -0.04: -0.0455.
    # The only return at or below it is -0.05, so CVaR = 0.05.
    assert out[0] == pytest.approx({"var": 0.0455, "cvar": 0.05})
    # 80%: position 9 x 0.2 = 1.8 between -0.04 and -0.03: -0.032; CVaR = mean(0.05, 0.04) = 0.045.
    assert out[1] == pytest.approx({"var": 0.032, "cvar": 0.045})


# --- Black-Scholes ---------------------------------------------------------------------------------

@needs_node
def test_black_scholes_textbook_values(tmp_path):
    out = js(tmp_path, """
      return { atm: [QX.blackScholes(100, 100, 1, 0.05, 0.2, "call"), QX.blackScholes(100, 100, 1, 0.05, 0.2, "put")],
               hull: [QX.blackScholes(42, 40, 0.5, 0.1, 0.2, "call"), QX.blackScholes(42, 40, 0.5, 0.1, 0.2, "put")] };""")
    call, put = out["atm"]
    # d1 = (ln 1 + (0.05 + 0.02) x 1) / 0.2 = 0.35; d2 = 0.15; N(0.35) = 0.63683, N(0.15) = 0.55962.
    assert call["d1"] == pytest.approx(0.35) and call["d2"] == pytest.approx(0.15)
    assert call["price"] == pytest.approx(10.4506, abs=1e-4) and put["price"] == pytest.approx(5.5735, abs=1e-4)
    assert call["delta"] == pytest.approx(0.6368, abs=1e-4)
    # Put-call parity: C - P = S - K e^(-rT) = 100 - 95.1229 = 4.8771.
    assert call["price"] - put["price"] == pytest.approx(100 - 100 * math.exp(-0.05), abs=1e-9)
    # Hull, Options, Futures and Other Derivatives, example 15.6: call 4.76, put 0.81.
    assert out["hull"][0]["price"] == pytest.approx(4.76, abs=0.005) and out["hull"][1]["price"] == pytest.approx(0.81, abs=0.005)


# --- the qubit simulator and Grover search (Quantum page) -----------------------------------------------

@needs_node
def test_qubit_simulator_and_grover(tmp_path):
    out = js(tmp_path, """
      const p = (n, g) => QX.probabilities(QX.simulate(n, g));
      const counts = QX.sampleCounts([0.5, 0, 0, 0.5], 1000, 1);
      return { h: p(1, [{ g: "H", t: 0 }]), hzh: p(1, [{ g: "H", t: 0 }, { g: "Z", t: 0 }, { g: "H", t: 0 }]),
               x: p(1, [{ g: "X", t: 0 }]), bell: p(2, [{ g: "H", t: 0 }, { g: "CNOT", c: 0, t: 1 }]), counts: [counts[0], counts[1], counts[2], counts[3]],
               opt16: QX.groverOptimal(16), p16: [0, 1, 2, 3].map((k) => QX.groverProbability(16, k)),
               steps: QX.groverSteps(4, 2, 1), curve: QX.mcErrorCurve(7, [[100, 50]]) };""")
    assert out["h"] == pytest.approx([0.5, 0.5])        # H|0> = (|0> + |1>)/sqrt2
    assert out["hzh"] == pytest.approx([0, 1])          # H Z H = X: interference sends |0> to |1>
    assert out["x"] == pytest.approx([0, 1])
    assert out["bell"] == pytest.approx([0.5, 0, 0, 0.5])  # only |00> and |11>: the pair always agrees
    assert out["counts"][1] == 0 and out["counts"][2] == 0 and out["counts"][0] + out["counts"][3] == 1000
    # Grover on N = 16: floor(pi/4 x 4) = 3 iterations; P = sin^2((2k+1) asin(1/4)):
    # k=0: 1/16 = 0.0625; k=1: 0.4727; k=2: 0.9084; k=3: 0.9613.
    assert out["opt16"] == 3
    assert out["p16"] == pytest.approx([0.0625, 0.47266, 0.90838, 0.96131], abs=1e-4)
    # N = 4, one iteration: amplitudes start at 1/2 each; the oracle flips item 2 to -1/2 (mean 1/4);
    # diffusion reflects about the mean, 2 x 1/4 - x: the others become 0 and item 2 becomes 1.
    assert [s["step"] for s in out["steps"]] == ["start", "oracle", "diffusion"]
    assert out["steps"][1]["mean"] == pytest.approx(0.25)
    assert out["steps"][2]["amps"] == pytest.approx([0, 0, 1, 0], abs=1e-12)
    # Monte Carlo error: the mean of n standard normals has standard deviation 1/sqrt(n) = 0.1 for n = 100.
    assert out["curve"][0]["n"] == 100 and out["curve"][0]["rms"] == pytest.approx(0.1, rel=0.3)


# --- the nightly job's versions -------------------------------------------------------------------------

def test_python_market_regime_from_index_closes():
    from quant.universe.scoring import market_regimes

    # 300 sessions rising 0.1% a day: the 50-day average sits above the 200-day and the price above
    # both, with no drawdown, so the US index reads Bull; a flat VIX of 12 is Calm, so the stance is Risk-On.
    idx = pd.bdate_range("2025-01-01", periods=300)
    up = pd.Series(100 * 1.001 ** np.arange(300), index=idx)
    down = pd.Series(100 * 0.997 ** np.arange(300), index=idx)  # falls 0.3% a day: about 59% below its high
    r = market_regimes(pd.DataFrame({"^GSPC": up, "^VIX": 12.0, "^KS11": down}))
    us, kr = r.loc["US"], r.loc["Korea"]
    assert (us.trend, us.volatility, us.stance) == ("Bull", "Calm", "Risk-On")
    assert us.drawdown_52w == pytest.approx(0.0) and us.level == pytest.approx(100 * 1.001 ** 299)
    assert kr.trend == "Bear" and kr.stance == "Risk-Off"
    # One month back from the last session: 30 calendar days = 21 or 22 sessions of -0.3%.
    assert kr.ret_1m == pytest.approx(down.iloc[-1] / down.asof(idx[-1] - pd.Timedelta(days=30)) - 1)


def test_python_price_metrics_skips_short_and_bad_series():
    from quant.universe.scoring import price_metrics

    idx = pd.bdate_range("2026-01-05", periods=30)
    close = pd.DataFrame({"OK": 100 * 1.01 ** np.arange(30), "SHORT": [np.nan] * 15 + [10.0] * 15, "NEG": [-1.0] * 30}, index=idx)
    m = price_metrics(close, close * 0 + 1000, set())
    assert list(m.index) == ["OK"]                       # fewer than 20 good closes: left out
    assert m.loc["OK", "ret_1d"] == pytest.approx(0.01)  # every day +1%
    assert m.loc["OK", "volatility"] == pytest.approx(0.0, abs=1e-12)  # constant returns: no volatility




def test_python_returns_volatility_and_drawdown():
    from quant.universe.scoring import series_metrics

    # Prices built from the four returns above, repeated five times: 21 closes, 20 returns.
    closes = [100.0]
    for r in R * 5:
        closes.append(closes[-1] * (1 + r))
    dates = pd.bdate_range("2026-01-05", periods=len(closes)).to_numpy()
    m = series_metrics(dates, np.array(closes), np.full(len(closes), 1e6), False, dates[-1])
    assert m["ret_1d"] == pytest.approx(-0.02)
    # 20 returns, mean 0.005, squared deviations 5 x 0.0017 = 0.0085; sample variance 0.0085 / 19.
    assert m["volatility"] == pytest.approx(math.sqrt(0.0085 / 19) * math.sqrt(252))
    # The deepest fall from a running peak is one -2% day (each cycle ends higher than it started):
    # the peak after "+3%" is followed by "-2%", then a new high.
    assert m["max_drawdown_1y"] == pytest.approx(-0.02)
    # The 21st weekday from Monday 5 January is Monday 2 February; a week back is Monday 26 January,
    # so the week holds the last five returns: -2%, +2%, -1%, +3%, -2%.
    assert m["ret_1w"] == pytest.approx(0.98 * 1.02 * 0.99 * 1.03 * 0.98 - 1)  # -0.109%


def test_python_performance_stats():
    from quant.quant_models import performance_stats

    r = pd.Series(R * 63, index=pd.bdate_range("2025-01-02", periods=252))  # one year of the four returns
    s = performance_stats(r)
    assert s["vol"] == pytest.approx(r.std() * math.sqrt(252))
    assert s["sharpe"] == pytest.approx(0.005 * 252 / s["vol"])
    assert s["cagr"] == pytest.approx((1.02 * 0.99 * 1.03 * 0.98) ** 63 - 1)  # 252 days = exactly one year
    assert s["max_drawdown"] == pytest.approx(-0.02)
