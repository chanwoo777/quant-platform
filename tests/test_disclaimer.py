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


def test_csv_headers_use_the_same_words():
    assert f'const DISCLAIMER = "{TEXT}";' in (DOCS / "assets" / "app.js").read_text(encoding="utf-8")


def test_no_other_disclaimer_wording():
    for f in [*DOCS.glob("*.html"), *(DOCS / "assets").glob("*.js")]:
        text = BLOCK.sub("", f.read_text(encoding="utf-8"))
        text = re.sub(r'<meta [^>]*>', "", text).replace(f'const DISCLAIMER = "{TEXT}";', "")
        assert not re.search(r"investment advice", text, re.I), f.name
