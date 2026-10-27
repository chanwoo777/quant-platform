"""The nightly quantum simulations (quant/web/quantum.py) and how the export runs them."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from quant.web import export
from quant.web import quantum as qw

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


# --- the export keeps the last good results ---------------------------------------------------------

def _fake_run(result):
    def run(*args, **kwargs):
        if isinstance(result, BaseException):
            raise result
        return subprocess.CompletedProcess(args, result, "", "boom")
    return run


@pytest.mark.parametrize("outcome", [1, subprocess.TimeoutExpired(["python"], 300), OSError("no python")])
def test_failed_run_keeps_previous_results(tmp_path, monkeypatch, outcome):
    keep, out = tmp_path / "quantum.json", tmp_path / "site"
    out.mkdir()
    keep.write_text('{"generated_at": "yesterday"}', encoding="utf-8")
    monkeypatch.setattr(export.subprocess, "run", _fake_run(outcome))
    assert export.export_quantum(out, keep=keep) > 0
    assert json.loads((out / "quantum.json").read_text(encoding="utf-8")) == {"generated_at": "yesterday"}


def test_no_results_yet_publishes_nothing(tmp_path, monkeypatch):
    out = tmp_path / "site"
    out.mkdir()
    monkeypatch.setattr(export.subprocess, "run", _fake_run(1))
    assert export.export_quantum(out, keep=tmp_path / "missing.json") == 0
    assert not (out / "quantum.json").exists()


def test_skipping_the_run_republishes(tmp_path, monkeypatch):
    keep, out = tmp_path / "quantum.json", tmp_path / "site"
    out.mkdir()
    keep.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(export.subprocess, "run", _fake_run(AssertionError("must not run")))
    assert export.export_quantum(out, keep=keep, run=False) == 2


# --- the QUBO is the website's ------------------------------------------------------------------------

@pytest.mark.skipif(NODE is None, reason="needs Node.js")
def test_qubo_matches_the_website(tmp_path):
    rng = np.random.default_rng(3)
    a = rng.normal(0.0005, 0.015, (400, 6))
    mu, cov = a.mean(axis=0) * 252, np.cov(a.T) * 252
    q, const, pen = qw.qubo(mu, cov, 3, 0.5)
    script = tmp_path / "run.js"
    script.write_text(f"const QX = require({json.dumps(str(ROOT / 'docs' / 'assets' / 'quantum.js'))});\n"
                      f"process.stdout.write(JSON.stringify(QX.quboMatrix({json.dumps(mu.tolist())}, {json.dumps(cov.tolist())}, 3, 0.5)));",
                      encoding="utf-8")
    js = json.loads(subprocess.run([NODE, str(script)], capture_output=True, text=True, check=True).stdout)
    assert np.array(js["Q"]) == pytest.approx(q, rel=1e-12)
    assert js["constant"] == pytest.approx(const, rel=1e-12) and js["penalty"] == pytest.approx(pen, rel=1e-12)


# --- small real simulations ---------------------------------------------------------------------------

def _prices(symbols, n=300, seed=1):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2025-01-02", periods=n)
    rets = rng.normal(0.0005, 0.018, (n, len(symbols))) + rng.normal(0, 0.008, (n, 1))
    return pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=idx, columns=symbols)


@pytest.fixture
def small(monkeypatch):
    pytest.importorskip("qiskit_finance")
    pytest.importorskip("qiskit_optimization")
    monkeypatch.setattr(qw, "OPTION_QUBITS", 3)
    monkeypatch.setattr(qw, "VAR_QUBITS", 3)
    monkeypatch.setattr(qw, "MC_PATHS", 20_000)


def test_option_pricing_by_amplitude_estimation(small):
    item = qw.price_option(spot=100.0, vol=0.3, rate=0.04, days=90, epsilon=0.01)
    item.pop("_problem"), item.pop("_result")
    lo, hi = item["qae"]["ci"]
    assert lo <= item["qae"]["price"] <= hi
    assert abs(item["qae"]["price"] - item["circuit_exact"]) < 3 * (hi - lo)  # estimates what the circuit encodes
    assert item["bs"] == pytest.approx(qw.black_scholes(100, 100, 90 / 365, 0.04, 0.3))
    assert item["grid_exact"] == pytest.approx(item["bs"], rel=0.2)  # 8 prices: a coarse grid
    assert sum(item["grid_probs"]) == pytest.approx(1, abs=1e-5)  # each rounded to 6 places
    json.dumps(item)  # serialisable


def test_var_and_qaoa_jobs(small):
    px = _prices(sorted(set(qw.VAR_BASKET + qw.QAOA_BASKET)))
    var = qw.job_var(px)
    assert var["tail"]["exact"] == pytest.approx(sum(var["probs"][:var["tail"]["threshold_index"]]), abs=1e-5)
    assert abs(var["tail"]["qae"] - var["tail"]["exact"]) < 0.02
    assert var["bisection"]["var_qae"] > 0
    qa = qw.job_qaoa(px)
    assert qa["best_sampled"]["fval"] >= qa["brute_force"]["fval"] - 1e-9  # nothing beats the exact optimum
    assert len(qa["brute_force"]["picks"]) == qw.QAOA_K
    assert 0 <= qa["p_optimum"] <= 1 and 0 <= qa["approximation_ratio"] <= 1
    json.dumps({"var": var, "qaoa": qa}, allow_nan=False)
