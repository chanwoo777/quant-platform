"""Nightly quantum-finance simulations for the website's Quantum page.

    python -m quant.web.quantum                 # simulate, then write data/quantum.json
    python -m quant.web.quantum --out FILE      # write somewhere else

Everything runs on Qiskit's statevector simulator: no quantum hardware and no keys. The
circuits are a handful of qubits, so they are exact to simulate; the results are educational
and are not trading signals. Three jobs, on the same price history the website shows:

  options  iterative amplitude estimation (IQAE) of at-the-money European calls, next to
           Black-Scholes, Monte Carlo and the exact value of the discretized model
  var      IQAE estimate of a basket's tail probability at its historical 95% VaR, and the
           VaR itself found by bisection over IQAE estimates (Woerner & Egger, 2019)
  qaoa     QAOA on the cardinality-constrained portfolio QUBO of a 6-stock basket, compared
           with the brute-force optimum

The file is replaced only when every job succeeds. quant.web.export runs this module in a
subprocess with a timeout and publishes the last good file, so a failure here never holds
back the rest of the site. Pinned package versions: requirements-quantum.txt.
"""

from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import logging
import math
import os
import platform
import sys
import time
import warnings
from importlib import metadata
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web.quantum")

LABEL = "Simulated on a classical computer - educational, not a trading signal"
SEED = 42
SHOTS = 200  # per circuit evaluated by the sampler
TD = 252
PX_ROWS = 600  # the same history the website's symbol files carry

OPTION_TICKERS = ["AAPL", "MSFT", "NVDA"]
MATURITIES = [30, 90, 180]  # calendar days
VOL_WINDOW = 126  # sessions (6 months), the site's default
OPTION_QUBITS = 5  # 32 price points
OPTION_EPSILON, OPTION_ALPHA, RESCALING = 0.001, 0.05, 0.1
MC_PATHS = 200_000
CONVERGENCE_EPSILONS = [0.02, 0.01, 0.005, 0.0025, 0.00125]
CONVERGENCE_SEEDS = 2

VAR_BASKET = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]
VAR_QUBITS = 5  # 32 return bins
VAR_ALPHA = 0.05
VAR_EPSILON, BISECTION_EPSILON = 0.002, 0.005
VAR_SESSIONS = 500

QAOA_BASKET = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"]
QAOA_K, QAOA_LAMBDA, QAOA_REPS = 3, 0.5, 2
QAOA_MAXITER = 300

PACKAGES = ["qiskit", "qiskit-algorithms", "qiskit-finance", "qiskit-optimization", "numpy", "scipy"]
BASIS = ["rz", "sx", "x", "cx"]


def r6(x) -> float | None:
    return None if x is None or not np.isfinite(x) else float(round(float(x), 6))


# --- inputs ------------------------------------------------------------------------------------

def load_inputs(symbols: list[str]) -> tuple[pd.DataFrame, dict]:
    """Daily closes (the website's history) and the 3-month T-bill yield from FRED."""
    from quant.db import init_db, session_scope
    from quant.ingestion.macro_data import load_macro
    from quant.universe.prices import load

    close = load("close")
    missing = [s for s in symbols if s not in close]
    if missing:
        raise RuntimeError(f"no prices for {missing}")
    px = pd.DataFrame({s: close[s].dropna().tail(PX_ROWS).astype(float) for s in symbols})
    with session_scope(init_db()) as s:
        macro = load_macro(s, ["DGS3MO"])
    rate = macro["DGS3MO"].dropna() if "DGS3MO" in macro else pd.Series(dtype=float)
    if rate.empty:
        raise RuntimeError("FRED DGS3MO is not in the database")
    pct = float(rate.iloc[-1])
    return px, {"series": "DGS3MO", "label": "3-Month Treasury yield (FRED DGS3MO)", "percent": pct,
                "date": f"{pd.Timestamp(rate.index[-1]):%Y-%m-%d}", "continuous": math.log(1 + pct / 100)}


def annual_vol(closes: pd.Series, window: int = VOL_WINDOW) -> float:
    lr = np.log(closes.dropna()).diff().dropna().tail(window)
    return float(lr.std(ddof=1) * math.sqrt(TD))


def black_scholes(s: float, k: float, t: float, r: float, vol: float, kind: str = "call") -> float:
    from scipy.stats import norm

    d1 = (math.log(s / k) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if kind == "call":
        return s * norm.cdf(d1) - k * math.exp(-r * t) * norm.cdf(d2)
    return k * math.exp(-r * t) * norm.cdf(-d2) - s * norm.cdf(-d1)


def monte_carlo(s: float, k: float, t: float, r: float, vol: float, n: int, rng) -> dict:
    z = rng.standard_normal(n)
    payoff = np.maximum(s * np.exp((r - vol * vol / 2) * t + vol * math.sqrt(t) * z) - k, 0) * math.exp(-r * t)
    half = 1.96 * payoff.std(ddof=1) / math.sqrt(n)
    return {"price": r6(payoff.mean()), "ci": [r6(payoff.mean() - half), r6(payoff.mean() + half)], "n": n}


# --- circuit helpers ---------------------------------------------------------------------------

def circuit_stats(circuit) -> dict:
    from qiskit import transpile

    t = transpile(circuit, basis_gates=BASIS, optimization_level=1, seed_transpiler=SEED)
    ops = t.count_ops()
    return {"qubits": circuit.num_qubits, "depth": t.depth(), "cx": int(ops.get("cx", 0)), "gates": int(sum(ops.values()))}


def drawing(circuit) -> str:
    return str(circuit.draw(output="text", fold=-1))


def iae(problem, epsilon: float, seed: int = SEED):
    from qiskit.primitives import StatevectorSampler
    from qiskit_algorithms import IterativeAmplitudeEstimation

    sampler = StatevectorSampler(default_shots=SHOTS, seed=seed)
    return IterativeAmplitudeEstimation(epsilon_target=epsilon, alpha=OPTION_ALPHA, sampler=sampler).estimate(problem)


def exact_amplitude(problem) -> float:
    """Probability that every objective qubit reads 1: what amplitude estimation estimates."""
    from qiskit.quantum_info import Statevector

    probs = Statevector(problem.state_preparation).probabilities()
    mask = sum(1 << q for q in problem.objective_qubits)
    return float(sum(p for i, p in enumerate(probs) if i & mask == mask))


def deepest(problem, result) -> dict:
    """Stats of the deepest circuit the run executed: A followed by Q^k for the largest k."""
    k = max(result.powers) if result.powers else 0
    circ = problem.state_preparation.copy()
    if k:
        circ.compose(problem.grover_operator.power(k), inplace=True)
    return {"grover_power": int(k), **circuit_stats(circ)}


# --- job 1: option pricing ---------------------------------------------------------------------

def lognormal_bounds(s: float, t: float, r: float, vol: float) -> tuple[float, float, float, float]:
    mu = math.log(s) + (r - vol * vol / 2) * t
    sig2 = vol * vol * t
    mean = math.exp(mu + sig2 / 2)
    std = math.sqrt((math.exp(sig2) - 1) * math.exp(2 * mu + sig2))
    return mu, sig2, max(0.0, mean - 3 * std), mean + 3 * std


def price_option(spot: float, vol: float, rate: float, days: int, epsilon: float = OPTION_EPSILON, rng=None) -> dict:
    from qiskit_finance.applications.estimation import EuropeanCallPricing
    from qiskit_finance.circuit.library import LogNormalDistribution

    t0 = time.perf_counter()
    t = days / 365
    strike = round(spot, 2)
    mu, sig2, low, high = lognormal_bounds(spot, t, rate, vol)
    model = LogNormalDistribution(OPTION_QUBITS, mu=mu, sigma=sig2, bounds=(low, high))
    ecp = EuropeanCallPricing(num_state_qubits=OPTION_QUBITS, strike_price=strike, rescaling_factor=RESCALING,
                              bounds=(low, high), uncertainty_model=model)
    problem = ecp.to_estimation_problem()
    res = iae(problem, epsilon)
    disc = math.exp(-rate * t)
    values, probs = np.asarray(model.values, dtype=float), np.asarray(model.probabilities, dtype=float)
    lo, hi = (problem.post_processing(x) for x in res.confidence_interval)
    return {
        "type": "call", "spot": r6(spot), "strike": strike, "maturity_days": days, "vol": r6(vol), "rate": r6(rate),
        "bounds": [r6(low), r6(high)], "grid": [r6(v) for v in values], "grid_probs": [r6(p) for p in probs],
        "qae": {"price": r6(disc * ecp.interpret(res)), "ci": [r6(disc * lo), r6(disc * hi)],
                "oracle_queries": int(res.num_oracle_queries), "grover_powers": [int(k) for k in res.powers],
                "shots_per_circuit": SHOTS, "epsilon": epsilon, "alpha": OPTION_ALPHA},
        "circuit_exact": r6(disc * problem.post_processing(exact_amplitude(problem))),
        "grid_exact": r6(disc * float(np.dot(probs, np.maximum(values - strike, 0)))),
        "bs": r6(black_scholes(spot, strike, t, rate, vol)),
        "mc": monte_carlo(spot, strike, t, rate, vol, MC_PATHS, rng or np.random.default_rng(SEED)),
        "runtime_s": round(time.perf_counter() - t0, 2),
        "_problem": problem, "_result": res,
    }


def job_options(px: pd.DataFrame, rate: float) -> tuple[dict, dict]:
    rng = np.random.default_rng(SEED)
    items, first = [], None
    for ticker in OPTION_TICKERS:
        spot, vol = float(px[ticker].dropna().iloc[-1]), annual_vol(px[ticker])
        for days in MATURITIES:
            item = price_option(spot, vol, rate, days, rng=rng)
            problem, res = item.pop("_problem"), item.pop("_result")
            first = first or (ticker, days, problem, res)
            items.append({"ticker": ticker, **item})
            log.info("option %s %sd: QAE %.3f, BS %.3f (%.1fs)", ticker, days, item["qae"]["price"], item["bs"], item["runtime_s"])
    ticker, days, problem, res = first
    options = {"method": "Iterative amplitude estimation (Grinko et al., 2019) of a European call payoff "
                         "(Stamatopoulos et al., 2020) on a 5-qubit lognormal model",
               "uncertainty_qubits": OPTION_QUBITS, "rescaling_factor": RESCALING, "vol_window": VOL_WINDOW,
               "dividends": "ignored", "items": items,
               "circuit": {"ticker": ticker, "maturity_days": days, "state_preparation": circuit_stats(problem.state_preparation),
                           "deepest": deepest(problem, res), "diagram": drawing(problem.state_preparation)}}
    # Convergence: amplitude error vs oracle queries as the precision target tightens (seed-averaged).
    a_true = exact_amplitude(problem)
    points = []
    for eps in CONVERGENCE_EPSILONS:
        errs, queries = [], []
        for seed in range(CONVERGENCE_SEEDS):
            res = iae(problem, eps, seed=SEED + seed)
            errs.append(abs(res.estimation - a_true))
            queries.append(res.num_oracle_queries)
        points.append({"epsilon": eps, "oracle_queries": int(np.mean(queries)), "abs_error": r6(float(np.mean(errs)))})
    convergence = {"ticker": ticker, "maturity_days": days, "amplitude": r6(a_true), "runs_per_point": CONVERGENCE_SEEDS, "points": points,
                   "mc_sigma": r6(math.sqrt(a_true * (1 - a_true)))}
    return options, convergence


# --- job 2: value at risk ----------------------------------------------------------------------

def basket_returns(px: pd.DataFrame, symbols: list[str], sessions: int = VAR_SESSIONS) -> pd.Series:
    rets = px[symbols].dropna().pct_change().dropna().tail(sessions)
    return rets.mean(axis=1)  # equal weights, rebalanced daily


def tail_problem(probs: np.ndarray, threshold: int):
    """A: load the binned distribution, then flip an objective qubit when the bin index < threshold."""
    from qiskit import QuantumCircuit
    from qiskit.circuit.library import IntegerComparator, StatePreparation
    from qiskit_algorithms import EstimationProblem

    n = int(math.log2(len(probs)))
    comparator = IntegerComparator(num_state_qubits=n, value=threshold, geq=False)
    load = QuantumCircuit(n, name="P(r)")  # wrapped so diagrams show a box, not 32 amplitudes
    load.append(StatePreparation(np.sqrt(probs)), range(n))
    qc = QuantumCircuit(comparator.num_qubits)
    qc.append(load.to_gate(), range(n))
    qc.append(comparator.to_gate(label="r<t"), range(comparator.num_qubits))
    return EstimationProblem(state_preparation=qc, objective_qubits=[n])


def job_var(px: pd.DataFrame) -> dict:
    t0 = time.perf_counter()
    r = basket_returns(px, VAR_BASKET)
    nb = 2 ** VAR_QUBITS
    edges = np.linspace(r.min(), r.max(), nb + 1)
    counts, _ = np.histogram(r, bins=edges)
    probs = counts / counts.sum()
    var_hist = -float(np.quantile(r, VAR_ALPHA))
    cvar_hist = -float(r[r <= -var_hist].mean())
    # The bin edge nearest the historical VaR is the threshold whose tail probability QAE estimates.
    t_idx = int(np.argmin(np.abs(edges - (-var_hist))))
    t_idx = min(max(t_idx, 1), nb - 1)
    problem = tail_problem(probs, t_idx)
    res = iae(problem, VAR_EPSILON)
    exact_tail = float(probs[:t_idx].sum())
    # VaR by bisection: the smallest threshold whose estimated tail probability reaches alpha.
    lo, hi, steps = 1, nb, []
    while lo < hi:
        mid = (lo + hi) // 2
        est = iae(tail_problem(probs, mid), BISECTION_EPSILON).estimation
        steps.append({"threshold_index": mid, "edge": r6(edges[mid]), "tail_qae": r6(est), "tail_exact": r6(probs[:mid].sum())})
        lo, hi = (lo, mid) if est >= VAR_ALPHA else (mid + 1, hi)
    exact_idx = int(np.argmax(np.cumsum(probs) >= VAR_ALPHA)) + 1  # same rule on exact probabilities
    return {
        "basket": VAR_BASKET, "weights": [r6(1 / len(VAR_BASKET))] * len(VAR_BASKET), "horizon_days": 1,
        "sessions": len(r), "from": f"{r.index[0]:%Y-%m-%d}", "to": f"{r.index[-1]:%Y-%m-%d}", "alpha": VAR_ALPHA,
        "qubits_distribution": VAR_QUBITS, "edges": [r6(e) for e in edges], "probs": [r6(p) for p in probs],
        "classical": {"var": r6(var_hist), "cvar": r6(cvar_hist), "method": "historical simulation"},
        "tail": {"threshold": r6(edges[t_idx]), "threshold_index": t_idx, "exact": r6(exact_tail), "qae": r6(res.estimation),
                 "ci": [r6(x) for x in res.confidence_interval], "oracle_queries": int(res.num_oracle_queries),
                 "epsilon": VAR_EPSILON, "alpha": OPTION_ALPHA},
        "bisection": {"steps": steps, "epsilon": BISECTION_EPSILON, "var_qae": r6(-edges[lo]), "var_binned_exact": r6(-edges[exact_idx])},
        "circuit": {"state_preparation": circuit_stats(problem.state_preparation), "deepest": deepest(problem, res)},
        "diagram": drawing(problem.state_preparation),
        "runtime_s": round(time.perf_counter() - t0, 2),
    }


# --- job 3: QAOA portfolio selection -----------------------------------------------------------

def qubo(mu: np.ndarray, cov: np.ndarray, k: int, lam: float) -> tuple[np.ndarray, float, float]:
    """x'Qx + const = x'(cov/k^2)x - (lam/k) mu'x + P (sum x - k)^2 for binary x (equal weights 1/k).

    The objective can't vary by more than the sum of its coefficients' sizes, so a penalty 5%
    above that makes every portfolio with the wrong number of names score worse than every
    valid one. The website builds the same matrix (quantum.js, quboMatrix)."""
    n = len(mu)
    risk, ret = cov / k**2, lam * mu / k
    penalty = 1.05 * float(np.abs(risk).sum() + np.abs(ret).sum())
    q = risk - np.diag(ret) + penalty * (np.ones((n, n)) - 2 * k * np.eye(n))
    return q, penalty * k * k, penalty


def qaoa_schematic(n: int, reps: int):
    """The QAOA circuit's layer structure, with each cost and mixer layer drawn as one box."""
    from qiskit import QuantumCircuit
    from qiskit.circuit import Gate

    qc = QuantumCircuit(n, n)
    qc.h(range(n))
    for p in range(1, reps + 1):
        qc.append(Gate(f"Cost(γ{p})", n, []), range(n))
        qc.append(Gate(f"Mixer(β{p})", n, []), range(n))
    qc.measure(range(n), range(n))
    return qc


def job_qaoa(px: pd.DataFrame) -> dict:
    from qiskit.primitives import StatevectorSampler
    from qiskit_optimization import QuadraticProgram
    from qiskit_optimization.algorithms import MinimumEigenOptimizer
    from qiskit_optimization.minimum_eigensolvers import QAOA
    from qiskit_optimization.optimizers import COBYLA

    t0 = time.perf_counter()
    rets = px[QAOA_BASKET].dropna().pct_change().dropna()
    mu, cov = rets.mean().to_numpy() * TD, rets.cov().to_numpy() * TD
    n = len(QAOA_BASKET)
    q, const, penalty = qubo(mu, cov, QAOA_K, QAOA_LAMBDA)
    qp = QuadraticProgram("cardinality_portfolio")
    for s in QAOA_BASKET:
        qp.binary_var(s)
    qp.minimize(constant=const, linear={s: q[i, i] for i, s in enumerate(QAOA_BASKET)},
                quadratic={(QAOA_BASKET[i], QAOA_BASKET[j]): 2 * q[i, j] for i in range(n) for j in range(i + 1, n)})
    start = np.random.default_rng(SEED).uniform(-0.5, 0.5, 2 * QAOA_REPS)  # fixed, so runs differ only by the data
    algo = QAOA(sampler=StatevectorSampler(default_shots=4096, seed=SEED), optimizer=COBYLA(maxiter=QAOA_MAXITER), reps=QAOA_REPS,
                initial_point=start)
    result = MinimumEigenOptimizer(algo).solve(qp)

    def f(x):
        x = np.asarray(x, dtype=float)
        return float(x @ q @ x + const)

    every = [np.array(b) for b in itertools.product([0, 1], repeat=n)]
    feasible = [x for x in every if x.sum() == QAOA_K]
    best = min(feasible, key=f)
    worst = max(feasible, key=f)
    f_all = [f(x) for x in every]
    samples = sorted(({"x": "".join(str(int(v)) for v in s.x), "fval": r6(s.fval), "probability": r6(s.probability)}
                      for s in result.samples), key=lambda s: -s["probability"])
    valid = [s for s in samples if s["x"].count("1") == QAOA_K]
    p_valid = sum(s["probability"] for s in valid)
    mean_valid = sum(s["fval"] * s["probability"] for s in valid) / p_valid if p_valid else float("nan")
    mean_f = sum(s["fval"] * s["probability"] for s in samples)
    p_opt = sum(s["probability"] for s in samples if s["x"] == "".join(str(int(v)) for v in best))
    found = np.asarray(result.x)
    ansatz = algo.ansatz
    return {
        "basket": QAOA_BASKET, "k": QAOA_K, "lambda": QAOA_LAMBDA, "penalty": r6(penalty), "constant": r6(const),
        "mu": [r6(v) for v in mu], "cov": [[r6(v) for v in row] for row in cov], "q": [[r6(v) for v in row] for row in q],
        "sessions": len(rets), "reps": QAOA_REPS, "optimizer": f"COBYLA (maxiter {QAOA_MAXITER})", "shots": 4096,
        "bit_order": "x[0] is the first ticker in the basket (strings read left to right in basket order)",
        "best_sampled": {"x": "".join(str(int(v)) for v in found), "fval": r6(result.fval),
                         "picks": [s for s, v in zip(QAOA_BASKET, found) if v > 0.5]},
        "brute_force": {"x": "".join(str(int(v)) for v in best), "fval": r6(f(best)),
                        "picks": [s for s, v in zip(QAOA_BASKET, best) if v], "worst_feasible": r6(f(worst)),
                        "feasible": len(feasible), "all": 2 ** n, "fval_max": r6(max(f_all))},
        "expected_fval": r6(mean_f), "p_optimum": r6(p_opt), "p_random": r6(1 / len(feasible)),
        "p_feasible": r6(p_valid), "p_feasible_random": r6(len(feasible) / 2 ** n),
        # Average valid sample, scaled so 1 = always the optimum and 0 = always the worst valid portfolio.
        "approximation_ratio": r6((f(worst) - mean_valid) / (f(worst) - f(best))),
        "approximation_ratio_random": r6((f(worst) - np.mean([f(x) for x in feasible])) / (f(worst) - f(best))),
        "top_samples": samples[:10],
        "circuit": circuit_stats(ansatz.assign_parameters(np.full(ansatz.num_parameters, 0.3))),  # nonzero angles: zeros would optimise away
        "diagram": drawing(qaoa_schematic(n, QAOA_REPS)),
        "runtime_s": round(time.perf_counter() - t0, 2),
    }


# --- orchestration -------------------------------------------------------------------------------

def versions() -> dict:
    out = {"python": platform.python_version()}
    for p in PACKAGES:
        try:
            out[p] = metadata.version(p)
        except metadata.PackageNotFoundError:
            out[p] = None
    return out


def run() -> dict:
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    started = time.perf_counter()
    symbols = sorted(set(OPTION_TICKERS + VAR_BASKET + QAOA_BASKET))
    px, rate = load_inputs(symbols)
    options, convergence = job_options(px, rate["continuous"])
    var = job_var(px)
    qaoa = job_qaoa(px)
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prices_as_of": f"{px.index[-1]:%Y-%m-%d}", "label": LABEL,
        "backend": "qiskit.primitives.StatevectorSampler: an exact statevector simulation, read out with sampled shots",
        "hardware": None, "versions": versions(), "rate": rate,
        "options": options, "convergence": convergence, "var": var, "qaoa": qaoa,
        "runtime_s": round(time.perf_counter() - started, 1),
    }


def main(argv: list[str] | None = None) -> int:
    from quant.config import get_settings

    parser = argparse.ArgumentParser(description="Run the website's quantum-finance simulations (simulator only).")
    parser.add_argument("--out", type=Path, help="output file (default: data/quantum.json)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("qiskit", "stevedore", "qiskit_algorithms", "qiskit_optimization", "qiskit_finance"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    out = args.out or get_settings().data_dir / "quantum.json"
    try:
        doc = run()
    except Exception:
        log.exception("quantum simulation failed; %s keeps its previous contents", out)
        return 1
    tmp = out.with_suffix(".tmp")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, out)  # atomic: readers see the old file or the new one, never half of one
    log.info("wrote %s (%d bytes) in %.0fs", out, out.stat().st_size, doc["runtime_s"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
