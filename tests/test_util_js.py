"""docs/assets/util.js (window.U) under Node.js: watchlist files and URL state."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

UTIL_JS = Path(__file__).resolve().parent.parent / "docs" / "assets" / "util.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def js(tmp_path: Path, body: str):
    script = tmp_path / "run.js"
    script.write_text(f"const U = require({json.dumps(str(UTIL_JS))});\n"
                      f"const out = (() => {{ {body} }})();\nprocess.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


def test_watchlist_round_trip_and_validation(tmp_path):
    out = js(tmp_path, """
      const file = U.exportWatchlist(["AAPL", "005930.KS", "^GSPC", "BTC-USD"], new Date("2026-10-28T00:00:00Z"));
      const errors = ["not json", "{}", "[1, 2]"].map((t) => { try { U.parseWatchlist(t); return null; } catch (e) { return e.message; } });
      return { file: JSON.parse(file), back: U.parseWatchlist(file),
               bare: U.parseWatchlist('[" MSFT ", "MSFT", "<script>", "NVDA"]'), errors };""")
    assert out["file"]["format"] == "free-quant-platform/watchlist" and out["file"]["exported_at"].startswith("2026-10-28")
    assert out["back"] == {"list": ["AAPL", "005930.KS", "^GSPC", "BTC-USD"], "skipped": 0}
    assert out["bare"] == {"list": ["MSFT", "NVDA"], "skipped": 2}
    assert out["errors"] == ["the file isn't JSON", "expected a list of tickers, or a file exported from this page", "every entry must be a ticker in quotes"]


def test_watchlist_import_is_strict(tmp_path):
    out = js(tmp_path, """
      const err = (t) => { try { U.parseWatchlist(t); return null; } catch (e) { return e.message; } };
      const ok = U.exportWatchlist(["AAPL"]);
      return { big: err(JSON.stringify(Array(30000).fill("AAPL"))), extra: err(JSON.stringify(Object.assign(JSON.parse(ok), { evil: 1 }))),
               format: err(JSON.stringify(Object.assign(JSON.parse(ok), { format: "other" }))), version: err(JSON.stringify(Object.assign(JSON.parse(ok), { version: 2 }))),
               nested: err('{"format":"free-quant-platform/watchlist","version":1,"watchlist":[{"s":"AAPL"}]}'),
               xss: err('["<img src=x onerror=alert(1)>"]'), garbage: err("{]"), ok: U.parseWatchlist(ok).list };""")
    assert out["big"] == "the file is larger than 100 KB" and out["extra"] == 'unexpected field "evil"'
    assert out["format"] == out["version"] == "expected a list of tickers, or a file exported from this page"
    assert out["nested"] == "every entry must be a ticker in quotes" and out["xss"] == "no valid tickers in the file"
    assert out["garbage"] == "the file isn't JSON" and out["ok"] == ["AAPL"]


def test_hash_keeps_only_known_keys_and_safe_values(tmp_path):
    out = js(tmp_path, """
      const bad = '<img src=x onerror=alert(1)>';
      return { arg: U.parseHash("#/stock/" + encodeURIComponent(bad)), key: U.parseHash("#/global?" + encodeURIComponent(bad) + "=1&tab=movers"),
               val: U.parseHash("#/global?q=" + encodeURIComponent(bad) + "&sec=Consumer%20Defensive"), route: U.parseHash("#/<svg onload=alert(1)>"),
               fine: U.parseHash("#/compare/AAPL,MSFT?years=3&model=FF5") };""")
    assert out["arg"] == {"route": "stock", "params": {}, "rejected": True}
    assert out["key"]["params"] == {"tab": "movers"} and out["key"]["rejected"] is True
    assert out["val"]["params"] == {"sec": "Consumer Defensive"} and out["val"]["rejected"] is True
    assert out["route"]["route"] == "" and out["route"]["rejected"] is True
    assert out["fine"] == {"route": "compare", "arg": "AAPL,MSFT", "params": {"years": "3", "model": "FF5"}, "rejected": False}


def test_page_state_round_trips_through_the_hash(tmp_path):
    out = js(tmp_path, """
      const h = U.buildHash("compare", "005930.KS,^GSPC,BRK-B", { years: 3, model: "FF5", empty: "", none: null, list: [], q: "big tech & co" });
      const g = U.buildHash("global", undefined, { cls: ["s", "e"], sig: "BUY", page: 2 });
      return { h, back: U.parseHash(h), g, gback: U.parseHash(g), plain: U.parseHash("#/stock/AAPL"), root: U.parseHash(""),
               lists: [U.listParam("a,b,,c"), U.listParam("")], nums: [U.numParam("7", 1, 0, 5), U.numParam("x", 1), U.numParam(undefined, 2)],
               oneOf: [U.oneOf("FF3", ["FF3", "FF5"], "FF5"), U.oneOf("evil", ["FF3"], "FF3")] };""")
    assert out["h"] == "#/compare/005930.KS,^GSPC,BRK-B?years=3&model=FF5&q=big%20tech%20%26%20co"
    assert out["back"] == {"route": "compare", "arg": "005930.KS,^GSPC,BRK-B", "params": {"years": "3", "model": "FF5", "q": "big tech & co"}, "rejected": False}
    assert out["g"] == "#/global?cls=s,e&sig=BUY&page=2" and out["gback"].get("arg") is None and out["gback"]["params"]["cls"] == "s,e"
    assert out["plain"] == {"route": "stock", "arg": "AAPL", "params": {}, "rejected": False} and out["root"]["route"] == ""
    assert out["lists"] == [["a", "b", "c"], []] and out["nums"] == [5, 1, 2] and out["oneOf"] == ["FF3", "FF3"]
