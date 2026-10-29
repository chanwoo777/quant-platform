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
                "signal": "BUY", "composite": 71.234, "unusual": True, "currency": "USD", "analysts": 91.4,
                "rationale": "Buy candidate: analysts Strong Buy (1.3); trend 80/100.", "analyst_label": "Strong Buy",
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
    extra = json.loads((tmp_path / "global-extra.json").read_text(encoding="utf-8"))
    assert rows[0]["u"] == 1 and rows[0]["cap"] == 2.5 and "sp" not in rows[0] and "why" not in rows[0]
    # The sparkline and the reason load later, from global-extra.json, in the same row order.
    assert extra["s"] == ["AAA", "BTC-USD"] and extra["sp"] == [[0, 50, 99], None]
    # Analyst ratings are licensed: no label column, and the reason names the calculated pillar instead.
    assert "lab" not in g["cols"] and rows[0]["an"] == 91
    assert extra["why"][0] == "Buy candidate: analysts 91/100; trend 80/100."
    assert g["regimes"][0]["market"] == "US" and g["counts"] == {"s": 1, "e": 0, "c": 1} and stats["head"]["counts"]["c"] == 1
    bucket = json.loads((tmp_path / "sym" / f"{export.bucket('AAA')}.json").read_text(encoding="utf-8"))
    # No price history is published (pages load it in the browser); every fundamental is NaN here, and
    # NaNs are left out.
    assert bucket["AAA"] == {"i": {}}
    symbols = json.loads((tmp_path / "symbols.json").read_text(encoding="utf-8"))
    assert symbols == [["AAA", "Aaa Corp", "s", "US"], ["BTC-USD", "Bitcoin", "c", "Crypto"]]


def test_stamp_assets_versions_scripts_and_styles(tmp_path):
    (tmp_path / "index.html").write_text('<html><head><link href="assets/app.css"><script src="assets/app.js" defer></script>'
                                         '<script src="https://cdn.example/x.js"></script></head></html>', encoding="utf-8")
    export.stamp_assets(tmp_path, "202610281200")
    html = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert 'href="assets/app.css?v=202610281200"' in html and 'src="assets/app.js?v=202610281200"' in html
    assert 'src="https://cdn.example/x.js"' in html and '<meta name="asset-version" content="202610281200">' in html


def test_route_pages_and_sitemap(tmp_path):
    (tmp_path / "index.html").write_text('<html><head><title>Free Quant Platform</title><meta name="description" content="x">'
                                         '<link rel="canonical" href="https://chanwoo777.github.io/quant-platform/"></head><body></body></html>', encoding="utf-8")
    urls = export.write_route_pages(tmp_path, "2026-10-29")
    page = (tmp_path / "markets" / "index.html").read_text(encoding="utf-8")
    assert '<base href="../">' in page and "<title>Market overview · Free Quant Platform</title>" in page
    assert 'href="https://chanwoo777.github.io/quant-platform/markets/"' in page and "FRED economic indicators" in page
    titles = {(tmp_path / r / "index.html").read_text(encoding="utf-8").split("<title>")[1].split("<")[0] for r in export.SEO_PAGES}
    assert len(titles) == len(export.SEO_PAGES)  # every page has its own title
    sitemap = (tmp_path / "sitemap.xml").read_text(encoding="utf-8")
    assert sitemap.count("<url>") == len(urls) == len(export.SEO_PAGES) + 3 and "<lastmod>2026-10-29</lastmod>" in sitemap


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
