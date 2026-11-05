"""The sector news digest: a short summary per sector with links to the source articles, written every few hours
by a scheduled Claude agent (a cloud routine) from public news and pushed to the claude/news-digest branch as
digest/sector-news.json. The refresh job (quant/web/cloud_refresh.py) and the nightly export read it from there
as data only, check it with validate() and publish it as data/sector-news.json for the Market Overview page.

    python -m quant.web.digest digest/sector-news.json     # check a digest; exit 1 with the problems

Standard library only, so the agent can run the check before it pushes. Anything that fails a rule is left out:
the site shows only plain text (no HTML), https links, the eleven sectors of the screener, and a digest written
in the last 36 hours.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

SECTORS = ("Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy",
           "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities")
BRANCH, PATH = "claude/news-digest", "digest/sector-news.json"
MAX_AGE = dt.timedelta(hours=36)
LIMITS = {"summary": 600, "title": 220, "src": 80, "items": 5}
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DigestError(ValueError):
    pass


def text(value, limit: int, field: str) -> str:
    if not isinstance(value, str):
        raise DigestError(f"{field}: expected text")
    value = " ".join(_CONTROL_RE.sub("", value).split())
    if not value:
        raise DigestError(f"{field}: empty")
    if "<" in value or ">" in value:
        raise DigestError(f"{field}: no HTML or angle brackets")
    if len(value) > limit:
        raise DigestError(f"{field}: longer than {limit} characters")
    return value


def https_url(value, field: str) -> str:
    u = urlparse(value if isinstance(value, str) else "")
    if u.scheme != "https" or not u.netloc or any(c in value for c in ' "<>`'):
        raise DigestError(f"{field}: not an https link")
    return value


def validate(doc, now: dt.datetime | None = None) -> dict:
    """The digest as the site publishes it, or DigestError. A sector or article that breaks a rule is dropped
    (and named in "skipped"); a digest that is stale, malformed or left with no sector raises."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(doc, dict):
        raise DigestError("expected a JSON object")
    try:
        written = dt.datetime.fromisoformat(str(doc.get("generated_at")).replace("Z", "+00:00"))
    except ValueError:
        raise DigestError("generated_at: not an ISO timestamp") from None
    if written.tzinfo is None:
        raise DigestError("generated_at: needs a time zone (use Z for UTC)")
    if written > now + dt.timedelta(minutes=10):
        raise DigestError("generated_at: in the future")
    if now - written > MAX_AGE:
        raise DigestError(f"generated_at: older than {MAX_AGE.total_seconds() / 3600:.0f} hours")
    sectors, skipped, seen = [], [], set()
    for i, entry in enumerate(doc.get("sectors") or []):
        try:
            if not isinstance(entry, dict) or entry.get("sector") not in SECTORS or entry["sector"] in seen:
                raise DigestError("unknown or repeated sector")
            items = []
            for j, item in enumerate((entry.get("items") or [])[: LIMITS["items"]]):
                where = f"{entry['sector']} item {j + 1}"
                if not isinstance(item, dict):
                    raise DigestError(f"{where}: expected an object")
                day = item.get("date")
                if day is not None and not (isinstance(day, str) and _DATE_RE.match(day)):
                    raise DigestError(f"{where}: date must be YYYY-MM-DD")
                items.append({"title": text(item.get("title"), LIMITS["title"], f"{where} title"),
                              "src": text(item.get("src"), LIMITS["src"], f"{where} src"),
                              "url": https_url(item.get("url"), f"{where} url"), "date": day})
            if not items:
                raise DigestError(f"{entry['sector']}: no source articles")
            sectors.append({"sector": entry["sector"], "summary": text(entry.get("summary"), LIMITS["summary"], f"{entry['sector']} summary"),
                            "items": items})
            seen.add(entry["sector"])
        except (DigestError, KeyError, TypeError) as exc:
            skipped.append(f"sector {i + 1}: {exc}")
    if not sectors:
        raise DigestError("no valid sector" + (f" ({'; '.join(skipped)})" if skipped else ""))
    sectors.sort(key=lambda s: SECTORS.index(s["sector"]))
    return {"generated_at": written.astimezone(dt.timezone.utc).isoformat(timespec="seconds"),
            "author": "Claude (scheduled research agent)", "sectors": sectors, "skipped": skipped}


def load(path: Path, now: dt.datetime | None = None) -> dict:
    return validate(json.loads(Path(path).read_text(encoding="utf-8")), now)


def from_branch(repo: Path, now: dt.datetime | None = None) -> dict:
    """Read the digest from the claude/news-digest branch with git, as data: nothing from the branch runs."""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    run = dict(cwd=repo, capture_output=True, check=True, timeout=120, stdin=subprocess.DEVNULL, creationflags=flags)
    subprocess.run(["git", "fetch", "-q", "origin", f"+refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}"], **run)
    raw = subprocess.run(["git", "show", f"origin/{BRANCH}:{PATH}"], **run).stdout
    return validate(json.loads(raw.decode("utf-8")), now)


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print("usage: python -m quant.web.digest <digest.json>")
        return 2
    try:
        doc = load(Path(args[0]))
    except (OSError, ValueError) as exc:
        print(f"digest rejected: {exc}")
        return 1
    print(f"digest ok: {len(doc['sectors'])} sectors, {sum(len(s['items']) for s in doc['sectors'])} articles")
    for problem in doc["skipped"]:
        print(f"  left out: {problem}")
    return 1 if doc["skipped"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
