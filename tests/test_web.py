"""Static website export and publishing (offline)."""

from __future__ import annotations

import json
import shutil
import subprocess

import numpy as np
import pandas as pd
import pytest

from quant.web import export, publish


def test_fnv1a_matches_reference_values():
    # The site's app.js computes the same 32-bit FNV-1a over UTF-8 bytes to find a symbol's bucket.
    assert export.fnv1a("") == 0x811C9DC5
    assert export.fnv1a("a") == 0xE40C292C
    assert export.fnv1a("foobar") == 0xBF9CF968
    assert export.bucket("AAPL") == f"{export.fnv1a('AAPL') % 256:02x}"
    assert len(export.bucket("币安人生-USD")) == 2


def test_clean_and_sig_make_strict_json():
    obj = {"a": np.float32(1.23456789), "b": float("nan"), "c": [np.int64(3), np.inf, pd.NaT],
           "d": pd.Timestamp("2026-10-22"), "e": np.bool_(True), "f": None}
    out = export.clean(obj)
    text = json.dumps(out, allow_nan=False)  # raises on NaN / inf
    assert json.loads(text) == {"a": 1.23457, "b": None, "c": [3, None, None], "d": "2026-10-22T00:00:00",
                                "e": True, "f": None}
    assert export.sig(123456.789, 4) == 123500.0 and export.sig("x") is None


def test_export_global_writes_screener_and_price_buckets(tmp_path, monkeypatch):
    from quant.universe import prices, scoring

    idx = pd.bdate_range("2025-01-01", periods=30)
    close = pd.DataFrame({"AAA": np.linspace(10, 12, 30), "BTC-USD": np.linspace(50, 60, 30)}, index=idx)
    close.loc[idx[5], "AAA"] = np.nan  # a holiday for one market
    base = {c: np.nan for c in ["sector", "category", "trend", "momentum", "value", "quality", "risk", "analysts", "cost",
                                "ret_1d", "ret_1w", "ret_1m", "ret_3m", "ret_ytd", "mom_12_1", "pe_current_year", "trailing_pe",
                                "price_to_book", "dividend_yield", "return_on_equity", "market_cap_usd", "zscore_1d",
                                "last_close", "rsi_14", "dist_200", "also_listed", "analyst_label"]}
    scores = pd.DataFrame([
        base | {"symbol": "AAA", "name": "Aaa Corp", "asset_class": "stock", "market": "US", "sector": "Technology",
                "signal": "BUY", "composite": 71.234, "unusual": True, "currency": "USD", "rationale": "Buy candidate: x",
                "sparkline": [1.0, 2.0, 3.0], "market_cap_usd": 2.5e9, "scored_at": pd.Timestamp("2026-10-23")},
        base | {"symbol": "BTC-USD", "name": "Bitcoin", "asset_class": "crypto", "market": "Crypto", "signal": "HOLD",
                "composite": 50.0, "unusual": False, "currency": "USD", "rationale": "Hold", "sparkline": None,
                "scored_at": pd.Timestamp("2026-10-23")},
    ])
    regimes = pd.DataFrame({"index": ["^GSPC"], "trend": ["Bull"]}, index=pd.Index(["US"], name="market"))
    monkeypatch.setattr(scoring, "load_scores", lambda: scores)
    monkeypatch.setattr(scoring, "load_regimes", lambda: regimes)
    monkeypatch.setattr(prices, "load", lambda field: close)
    stats = export.export_global(tmp_path)
    g = json.loads((tmp_path / "global.json").read_text(encoding="utf-8"))
    rows = [dict(zip(g["cols"], r)) for r in g["rows"]]
    assert stats["symbols"] == 2 and rows[0]["s"] == "AAA" and rows[0]["a"] == "s" and rows[0]["sc"] == 71.2
    assert rows[0]["u"] == 1 and rows[0]["cap"] == 2.5 and rows[0]["sp"] == [0, 50, 99] and rows[1]["sp"] is None
    assert g["regimes"][0]["market"] == "US"
    bucket = json.loads((tmp_path / "px" / f"{export.bucket('AAA')}.json").read_text(encoding="utf-8"))
    start, gaps, values = bucket["AAA"]
    assert start == "2025-01-01" and len(values) == 29 and 3 in gaps  # the holiday spans a weekend + 1 day


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_publish_force_pushes_a_single_commit(tmp_path):
    def git(*args, cwd):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                              encoding="utf-8").stdout.strip()

    remote = tmp_path / "remote.git"
    git("init", "-q", "--bare", str(remote), cwd=tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    git("init", "-q", cwd=repo)
    git("remote", "add", "origin", str(remote), cwd=repo)
    git("config", "user.name", "tester", cwd=repo)
    git("config", "user.email", "tester@example.com", cwd=repo)
    site = tmp_path / "site"
    (site / "data").mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html>v1", encoding="utf-8")
    publish.publish(site, repo=repo)
    (site / "index.html").write_text("<!doctype html>v2", encoding="utf-8")
    publish.publish(site, repo=repo)
    log = git("log", "--format=%an %s", "gh-pages", cwd=remote).splitlines()
    assert len(log) == 1 and log[0].startswith("tester Site snapshot")  # history replaced, not appended
    assert git("show", "gh-pages:index.html", cwd=remote) == "<!doctype html>v2"
    assert git("show", "gh-pages:.nojekyll", cwd=remote) == ""
