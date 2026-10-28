"""changelog.json for the site's Changelog page (#/changelog), generated from the git history.

Only commits whose subject starts with a Conventional Commits tag are listed: "feat: ..." or
"fix: ...", optionally with a scope ("feat(track-record): ...") or a "!" for a breaking change.
A commit counts as a methodology change, and is highlighted, when its scope is "methodology" or it
touches a file that defines how a number is calculated (METHOD_FILES). When git isn't available,
the last good changelog (data/changelog.json) is republished instead.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import subprocess
from pathlib import Path

log = logging.getLogger("quant.web")

REPO_URL = "https://github.com/chanwoo777/quant-platform"
TAG = re.compile(r"^(feat|fix)(?:\(([\w\-./ ]+)\))?(!)?:\s*(.+)$")
METHOD_FILES = ("quant/universe/scoring.py", "quant/quant_models.py", "quant/analytics.py", "quant/trading_bot.py",
                "quant/web/track.py", "quant/web/quality.py", "docs/assets/quant.js", "docs/assets/methodology.js")
SEP, END = "\x1f", "\x1e"


def parse(log_text: str) -> list[dict]:
    """Entries from `git log --name-only --format=<END>%H<SEP>%ad<SEP>%s<SEP>%b<SEP>`."""
    out = []
    for record in log_text.split(END):
        if not record.strip():
            continue
        parts = record.split(SEP)
        if len(parts) < 5:
            continue
        sha, date, subject, body, files = parts[0].strip(), parts[1].strip(), parts[2].strip(), parts[3].strip(), parts[4]
        m = TAG.match(subject)
        if not m:
            continue
        kind, scope, bang, title = m.groups()
        changed = [f.strip() for f in files.splitlines() if f.strip()]
        method_files = [f for f in changed if f in METHOD_FILES]
        paragraphs = [p.strip() for p in body.split("\n\n") if p.strip() and not p.strip().lower().startswith("co-authored-by")]
        out.append({"sha": sha, "short": sha[:7], "date": date, "type": kind, "scope": scope, "breaking": bool(bang),
                    "title": title, "body": paragraphs[0].replace("\n", " ") if paragraphs else "",
                    "methodology": scope == "methodology" or bool(method_files), "method_files": method_files,
                    "files": len(changed), "url": f"{REPO_URL}/commit/{sha}"})
    return out


def build(root: Path, cache: Path) -> dict:
    fmt = f"{END}%H{SEP}%ad{SEP}%s{SEP}%b{SEP}"
    try:
        done = subprocess.run(["git", "log", "--date=short", "--name-only", f"--format={fmt}"], cwd=root, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=60,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if done.returncode:
            raise RuntimeError(done.stderr.strip()[:300] or f"git exited {done.returncode}")
        entries = parse(done.stdout)
        doc = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "repo": REPO_URL,
               "entries": entries, "rule": "Commits tagged feat: or fix: (Conventional Commits). Methodology changes are highlighted.",
               "method_files": list(METHOD_FILES)}
        cache.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return doc
    except Exception as exc:
        log.warning("changelog: git log failed (%s); republishing the last good changelog", exc)
        if cache.exists():
            doc = json.loads(cache.read_text(encoding="utf-8"))
            doc["stale_reason"] = str(exc)
            return doc
        raise
