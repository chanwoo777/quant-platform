"""No credential reaches the published site: the website code, the static pages and (when present) the
exported data are scanned for key-shaped strings. CI also runs gitleaks over the full history."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "OpenAI/Anthropic-style key": re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b"),
    "Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "literal token parameter": re.compile(r"""[?&](?:token|apikey|api_key|key)=[A-Za-z0-9]{16,}"""),
    "Finnhub key literal": re.compile(r"""finnhubKey["']?\s*[:=]\s*["'][a-z0-9]{20}["']"""),
}


def _files():
    yield from (p for p in (ROOT / "docs").rglob("*") if p.is_file() and p.suffix in {".html", ".js", ".css", ".json", ".xml", ".txt", ".webmanifest"})
    site = ROOT / "data" / "site"
    if site.exists():
        yield from (p for p in site.rglob("*") if p.is_file() and p.suffix in {".html", ".js", ".json", ".xml", ".txt"})


def test_no_key_shaped_strings_in_site_or_exports():
    hits = []
    for p in _files():
        text = p.read_text(encoding="utf-8", errors="ignore")
        hits += [f"{p.relative_to(ROOT)}: {name}" for name, rx in PATTERNS.items() if rx.search(text)]
    assert not hits, hits


def test_env_example_holds_placeholders_only():
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert not any(rx.search(text) for rx in PATTERNS.values())
    assert re.search(r"^SEC_USER_AGENT=Your Name your\.email@example\.com$", text, re.M)


def test_gitignore_keeps_local_secrets_out():
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").split()
    for entry in (".env", "*.key", "*.pem", ".streamlit/secrets.toml"):
        assert entry in ignored, entry
