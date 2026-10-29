"""Browser hardening that GitHub Pages can't do with headers: one Content-Security-Policy and referrer policy on
every page, no inline scripts or handlers (so the CSP needs no 'unsafe-inline' for scripts), Subresource
Integrity on the CDN libraries, and noopener noreferrer on every link that opens a new tab."""
import re
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs"
PAGES = sorted(DOCS.glob("*.html"))
CSP = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">')


def test_every_page_has_the_same_strict_csp_and_referrer_policy():
    policies = {p.name: CSP.findall(p.read_text(encoding="utf-8")) for p in PAGES}
    assert all(len(v) == 1 for v in policies.values()), policies
    csp = policies["index.html"][0]
    assert len({v[0] for v in policies.values()}) == 1
    directives = dict(d.strip().split(" ", 1) if " " in d.strip() else (d.strip(), "") for d in csp.split(";"))
    assert directives["default-src"] == "'self'" and directives["object-src"] == "'none'" and directives["frame-src"] == "'none'"
    assert directives["script-src"] == "'self' https://cdn.jsdelivr.net"  # no 'unsafe-inline', no 'unsafe-eval'
    assert "unsafe-eval" not in csp and "*" not in csp
    assert set(directives["connect-src"].split()) == {"'self'", "https://data-api.binance.vision", "wss://data-stream.binance.vision",
                                                      "https://ts-api.cnbc.com", "https://quote.cnbc.com", "https://finnhub.io", "wss://ws.finnhub.io"}
    for p in PAGES:
        assert '<meta name="referrer" content="strict-origin-when-cross-origin">' in p.read_text(encoding="utf-8"), p.name


def test_no_inline_scripts_or_handlers():
    for p in PAGES:
        html = p.read_text(encoding="utf-8")
        assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), p.name
        assert not re.search(r"\son[a-z]+=", html), p.name
        assert "javascript:" not in html, p.name


def test_cdn_scripts_carry_integrity():
    app = (DOCS / "assets" / "app.js").read_text(encoding="utf-8")
    live = (DOCS / "assets" / "live.js").read_text(encoding="utf-8")
    assert re.search(r'PLOTLY_URL = "https://cdn\.jsdelivr\.net/npm/plotly\.js-finance-dist-min@\d+\.\d+\.\d+/', app)
    assert re.search(r'PLOTLY_SRI = "sha384-[A-Za-z0-9+/]{64}"', app) and "PLOTLY_SRI));" in app
    assert re.search(r'LWC_URL = "https://cdn\.jsdelivr\.net/npm/lightweight-charts@\d+\.\d+\.\d+/', live)
    assert re.search(r'LWC_SRI = "sha384-[A-Za-z0-9+/]{64}"', live) and "s.integrity = LWC_SRI" in live
    for f in [*PAGES, *(DOCS / "assets").glob("*.js")]:
        text = f.read_text(encoding="utf-8")
        cdn = re.findall(r'<script[^>]+src="https://[^"]+"[^>]*>', text)
        assert all("integrity=" in s for s in cdn), (f.name, cdn)


def test_new_tab_links_have_noopener_noreferrer():
    for f in [*PAGES, *(DOCS / "assets").glob("*.js")]:
        if f.name.startswith("i18n"):
            continue
        for tag in re.findall(r'<a [^>]*target="_blank"[^>]*>', f.read_text(encoding="utf-8")):
            assert 'rel="noopener noreferrer"' in tag, (f.name, tag[:120])


def test_framing_guard_runs_first():
    for p in PAGES:
        if p.name == "404.html":
            continue
        html = p.read_text(encoding="utf-8")
        assert html.index('src="assets/boot.js"') < html.index("</head>"), p.name
    assert "window.top !== window.self" in (DOCS / "assets" / "boot.js").read_text(encoding="utf-8")
