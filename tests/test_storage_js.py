"""docs/assets/boot.js under Node.js: storage keys move to the qp:v1: namespace once, other sites' keys on the
shared github.io origin are left alone, and clearAll removes only this site's data."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

BOOT = Path(__file__).resolve().parents[1] / "docs" / "assets" / "boot.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")

HARNESS = r"""
function fakeStorage(init) {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => { m.delete(k); m.set(k, String(v)); }, removeItem: (k) => m.delete(k), dump: () => Object.fromEntries(m) };
}
global.localStorage = fakeStorage(INIT);
global.sessionStorage = fakeStorage({ finnhubKey: "abc", "qp:v1:finnhubKey": "def", other: "x" });
global.window = global; global.self = global; global.top = global;
global.document = { documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, classList: { add() {} } }, addEventListener() {} };
require(BOOT);
const migrated = localStorage.dump(), theme = document.documentElement.attrs["data-theme"];
require.cache[require.resolve(BOOT)] && delete require.cache[require.resolve(BOOT)];
localStorage.setItem("watchlist", "[\"NEW\"]");  // written by an old tab after migration: not moved again, but cleared
const n = window.QP_STORAGE.clearAll();
process.stdout.write(JSON.stringify({ migrated, theme, n, after: localStorage.dump(), session: sessionStorage.dump() }));
"""


def test_namespace_migration_and_clear(tmp_path):
    init = {"theme": "dark", "lang": "ko", "watchlist": '["AAPL"]', "pc:draw:AAPL": "[]", "pc:interval:binance": '"15m"',
            "qp:v1:compare": '["MSFT"]', "other-site": "keep", "alertsX": "keep"}
    script = tmp_path / "run.js"
    script.write_text(HARNESS.replace("INIT", json.dumps(init)).replace("BOOT", json.dumps(str(BOOT))), encoding="utf-8")
    out = json.loads(subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    m = out["migrated"]
    assert {k for k in m if k.startswith("qp:v1:")} == {"qp:v1:theme", "qp:v1:lang", "qp:v1:watchlist", "qp:v1:pc:draw:AAPL",
                                                       "qp:v1:pc:interval:binance", "qp:v1:compare", "qp:v1:migrated"}
    assert m["other-site"] == "keep" and m["alertsX"] == "keep" and "theme" not in m and "watchlist" not in m
    assert out["theme"] == "dark"
    assert out["after"] == {"other-site": "keep", "alertsX": "keep"} and out["session"] == {"other": "x"}
    assert out["n"] == 9  # 6 namespaced local keys + the stray old one + 2 session keys
