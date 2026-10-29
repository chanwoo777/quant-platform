"""Korean / English (docs/assets/i18n.js, i18n.ko.js): the dictionary keeps every placeholder, values and
codes stay values, and text the page translator can't reach (alerts, toasts) goes through tr()."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ASSETS = Path(__file__).resolve().parent.parent / "docs" / "assets"
DOCS = ASSETS.parent
NODE = shutil.which("node")
PLACEHOLDER = re.compile(r"\{\d+\}|<\d+/>")


def korean() -> dict:
    text = (ASSETS / "i18n.ko.js").read_text(encoding="utf-8")
    return json.loads(re.search(r"D\.ko = Object\.assign\(D\.ko \|\| \{\}, (\{.*\})\);", text, re.S).group(1))


def test_every_entry_keeps_its_placeholders_and_is_translated():
    ko = korean()
    assert len(ko) > 1500
    for en, kr in ko.items():
        assert sorted(PLACEHOLDER.findall(en)) == sorted(PLACEHOLDER.findall(kr)), en
        assert kr.strip(), en


def test_core_interface_is_in_korean():
    ko = korean()
    for en in ("Global", "Markets", "Compare", "Start here", "Data status", "Daily brief", "Your watchlist ★", "▲ BUY",
               "Research and education only, not investment advice.", "Glossary", "How this is calculated"):
        assert re.search(r"[가-힣]", ko[en]), en


def test_text_outside_the_page_goes_through_tr():
    """alert(), confirm() and prompt() never reach the page translator, so their text must use tr()."""
    for f in ASSETS.glob("*.js"):
        for m in re.finditer(r"\b(alert|confirm|prompt)\(", f.read_text(encoding="utf-8")):
            after = f.read_text(encoding="utf-8")[m.end():m.end() + 3]
            assert after.startswith("tr("), f"{f.name}: {m.group(1)}(...) without tr()"


def test_every_page_loads_the_translator_and_has_the_toggle():
    for page in ("index.html", "about.html", "privacy.html"):
        html = (DOCS / page).read_text(encoding="utf-8")
        # i18n.js loads i18n.ko.js itself, only for a visitor reading in Korean.
        assert 'src="assets/i18n.js"' in html and 'i18n.ko.js' not in html and 'id="lang"' in html, page


@pytest.mark.skipif(NODE is None, reason="needs Node.js")
def test_translation_engine(tmp_path):
    script = tmp_path / "run.js"
    script.write_text(f"""
      globalThis.localStorage = {{ getItem: () => "ko" }};
      require({json.dumps(str(ASSETS / "i18n.ko.js"))});
      const I = require({json.dumps(str(ASSETS / "i18n.js"))});
      const out = {{
        lang: I.lang,
        key: I.keyOf("{{0}}".replace("{{0}}", "8,641 stocks ≥ $1B in 21 markets")),
        tickers: I.keyOf("AAPL, 005930.KS, ^GSPC and BTC-USD rose 75.6% on 2026-10-27 (x0.05)").key,
        buy: I.tText("▲ Positive"),
        date: I.localToken("2026-10-27"), money: [I.localToken("$5.1T"), I.localToken("$1.3B"), I.localToken("-$250M")],
        sentence: I.tText("Prices 2026-10-27 · updated 2026-10-28 13:00 UTC"),
        why: I.tText("Buy candidate: value 99/100; 12-1 momentum +56% (88/100). New buys paused: Korea is in a Bear regime."),
        unknown: I.tText("Something with no entry 42"),
      }};
      process.stdout.write(JSON.stringify(out));""", encoding="utf-8")
    out = json.loads(subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    assert out["lang"] == "ko"
    assert out["key"] == {"key": "{0} stocks ≥ {1} in {2} markets", "tokens": ["8,641", "$1B", "21"]}
    assert out["tickers"] == "{0}, {1}, {2} and {3} rose {4} on {5} ({6})"
    assert out["buy"] == "▲ 긍정"
    assert out["date"] == "2026. 10. 27." and out["money"] == ["5.1조 달러", "13억 달러", "−2.5억 달러"]
    assert out["sentence"] == "가격 2026. 10. 27. 기준 · 2026. 10. 28. 13:00 UTC 갱신"
    assert out["why"].startswith("긍정 신호: 가치 99/100; 12-1 모멘텀 +56% (88/100).") and "한국이(가) 약세 국면입니다" in out["why"]
    assert out["unknown"] == "Something with no entry 42"  # stays English, and is reported as missing
