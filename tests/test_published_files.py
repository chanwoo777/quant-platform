"""What GitHub Pages serves is docs/ plus the export: no scripts, notebooks, raw dumps or drafts, no image
metadata, and no personal data."""
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
ALLOWED = {".html", ".js", ".css", ".png", ".webp", ".svg", ".ico", ".webmanifest", ".nojekyll", ""}


def test_docs_holds_only_site_files():
    odd = [str(p.relative_to(DOCS)) for p in DOCS.rglob("*") if p.is_file() and (p.suffix or p.name) not in ALLOWED]
    assert not odd, odd


def test_images_carry_no_metadata():
    for p in DOCS.rglob("*"):
        if p.suffix.lower() in {".png", ".webp", ".jpg", ".jpeg"}:
            with Image.open(p) as im:
                assert not im.getexif(), f"{p.name} has EXIF"
                assert not {"XML:com.adobe.xmp", "xmp", "icc_profile", "comment", "parameters"} & set(im.info), f"{p.name}: {set(im.info)}"


def test_no_personal_data_in_published_code():
    personal = re.compile(r"[A-Za-z0-9._%+-]+@(?!example\.com|users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z.]{2,}"
                          r"|\b01[016789]-\d{3,4}-\d{4}\b|[A-Z]:\\Users\\|/home/[a-z]+/")
    hits = []
    for p in DOCS.rglob("*"):
        if p.suffix in {".html", ".js", ".css"}:
            hits += [f"{p.name}: {m.group(0)}" for m in personal.finditer(p.read_text(encoding="utf-8"))]
    assert not hits, hits


def test_images_have_alt_text_and_sources_are_credited():
    for p in DOCS.glob("*.html"):
        for tag in re.findall(r"<img\b[^>]*>", p.read_text(encoding="utf-8")):
            assert re.search(r'\balt="[^"]{3,}"', tag), (p.name, tag[:80])
    for f in (DOCS / "about.html", DOCS / "assets" / "methodology.js"):
        text = f.read_text(encoding="utf-8")
        assert "Federal Reserve Bank of St. Louis" in text and "Kenneth R. French Data Library" in text and "CoinGecko" in text, f.name
    app = (DOCS / "assets" / "app.js").read_text(encoding="utf-8")
    assert 'a.setAttribute("aria-label", a.getAttribute("data-title")' in app  # chart toolbar buttons have names
