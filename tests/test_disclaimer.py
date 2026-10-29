"""One disclaimer block, word for word, on every page of the site, and no other variants."""

import re
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs"
TEXT = "Research and education only, not investment advice. Data may be delayed or wrong. Past performance does not predict future results."
BLOCK = re.compile(r'<div class="disclaimer" role="note">(.*?)</div>', re.S)


def plain(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html)).strip()


def test_every_page_has_the_same_block():
    for page in sorted(DOCS.glob("*.html")):
        blocks = BLOCK.findall(page.read_text(encoding="utf-8"))
        assert [plain(b) for b in blocks] == [TEXT], page.name


def test_downloads_use_the_same_words():
    # util.js holds the one copy: CSV headers, PNG footers and the watchlist JSON all read it
    assert f'const DISCLAIMER = "{TEXT}";' in (DOCS / "assets" / "util.js").read_text(encoding="utf-8")
    assert "const DISCLAIMER = Util.DISCLAIMER;" in (DOCS / "assets" / "app.js").read_text(encoding="utf-8")


def test_no_other_disclaimer_wording():
    for f in [*DOCS.glob("*.html"), *(DOCS / "assets").glob("*.js")]:
        if f.name.startswith("i18n."):  # the dictionary translates the block itself, keyed by its English
            continue
        text = BLOCK.sub("", f.read_text(encoding="utf-8"))
        text = re.sub(r'<meta [^>]*>', "", text).replace(f'const DISCLAIMER = "{TEXT}";', "")
        assert not re.search(r"investment advice", text, re.I), f.name


def test_no_trading_instructions_in_the_interface():
    # The data keeps BUY / HOLD / AVOID as codes; the page shows Positive / Neutral / Negative and never tells anyone to trade.
    banned = re.compile(r"▲ BUY|● HOLD|▼ AVOID|Buy candidate|BUY / HOLD / AVOID labels|\byou should\b|\bbuy now\b|\bsell now\b", re.I)
    for f in [*DOCS.glob("*.html"), *(DOCS / "assets").glob("*.js")]:
        if f.name.startswith("i18n."):
            continue
        hits = banned.findall(f.read_text(encoding="utf-8"))
        assert not hits, (f.name, hits)


def test_risk_and_delay_notes_are_shown():
    app = (DOCS / "assets" / "app.js").read_text(encoding="utf-8")
    assert app.count("${riskNote()}") >= 3 and "riskNote()" in (DOCS / "assets" / "trust.js").read_text(encoding="utf-8")
    assert 'class="delay-note"' in app and 'class="delay-note"' in (DOCS / "assets" / "live.js").read_text(encoding="utf-8")
    assert "not a trading signal" in (DOCS / "assets" / "quantum.js").read_text(encoding="utf-8")
