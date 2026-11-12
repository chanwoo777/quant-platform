"""Publish the static website to GitHub Pages (the gh-pages branch of origin).

    python -m quant.web.publish               # export fresh data, then push data/site
    python -m quant.web.publish --no-export   # push what is already in data/site

The branch always holds a single commit, the latest snapshot: each publish starts a
new history and force-pushes it, so the daily data never accumulates in the
repository. The site's code is versioned on main under docs/; GitHub Pages serves
the gh-pages branch. Pushing uses your normal git credentials for origin (for
example the GitHub CLI's credential helper).
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

from quant.web.export import ROOT, build

log = logging.getLogger("quant.web")
BRANCH = "gh-pages"


def git(*args: str, cwd: Path) -> str:
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0  # no console flash under pythonw
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          creationflags=flags)
    if done.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout.strip()


def _force_remove(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)  # git marks pack files read-only on Windows
    func(path)


def publish(site_dir: Path, repo: Path = ROOT, branch: str = BRANCH) -> str:
    """Commit site_dir as a fresh one-commit history and force-push it to origin/<branch>."""
    if not (site_dir / "index.html").exists():
        raise FileNotFoundError(f"{site_dir} has no index.html; run the export first")
    remote = git("remote", "get-url", "origin", cwd=repo)
    name = git("config", "user.name", cwd=repo)
    email = git("config", "user.email", cwd=repo)
    shutil.rmtree(site_dir / ".git", onerror=_force_remove) if (site_dir / ".git").exists() else None
    git("init", "-q", "-b", branch, cwd=site_dir)
    for key, value in (("user.name", name), ("user.email", email), ("core.autocrlf", "false")):
        git("config", key, value, cwd=site_dir)
    (site_dir / ".nojekyll").touch()  # serve files as-is (no Jekyll build)
    git("add", "-A", cwd=site_dir)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    git("commit", "-q", "-m", f"Site snapshot {stamp}", cwd=site_dir)
    git("push", "-q", "--force", remote, f"{branch}:{branch}", cwd=site_dir)
    sha = git("rev-parse", "--short", "HEAD", cwd=site_dir)
    log.info("published site %s to %s (%s)", sha, branch, remote)
    return sha


# The deploy gate: these must pass before anything is pushed, so a broken calculation never reaches the
# live site (the same files run in GitHub Actions on every push).
CALCULATION_TESTS = ("tests/test_calculations.py", "tests/test_research_js.py", "tests/test_quantum_js.py",
                     "tests/test_site_js.py", "tests/test_lab_js.py", "tests/test_quant_models.py", "tests/test_track.py")


def console_python(exe: str = sys.executable) -> str:
    """python.exe next to pythonw.exe. The scheduled task runs pythonw, a windowless program: CREATE_NO_WINDOW
    doesn't give it a console, so the Node.js tests it starts either couldn't inherit console handles
    (OSError WinError 50, 29 October and 4 November) or got a console of their own that was closed under them
    (exit 0xC000013A, 5 November). python.exe with CREATE_NO_WINDOW gets a hidden console its children share."""
    path = Path(exe)
    console = path.with_name("python.exe")
    return str(console) if path.name.lower() == "pythonw.exe" and console.exists() else exe


def check_calculations(repo: Path = ROOT, attempts: int = 2) -> None:
    """Run the calculation tests; raise (and publish nothing) if any fails. A failed run is repeated once, so
    a one-off glitch in starting the test processes doesn't cost a day's publish; a real calculation error
    fails both runs."""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    for attempt in range(1, attempts + 1):
        done = subprocess.run([console_python(), "-m", "pytest", "-q", "-p", "no:cacheprovider", *CALCULATION_TESTS],
                              cwd=repo, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", creationflags=flags)
        summary = (done.stdout.strip().splitlines() or ["no output"])[-1]
        if not done.returncode:
            log.info("calculation tests passed: %s", summary)
            return
        log.warning("calculation tests failed (attempt %d of %d): %s", attempt, attempts, summary)
    raise RuntimeError(f"calculation tests failed, so the site was not published: {summary}\n{done.stdout[-3000:]}")


def run(export: bool = True, site_dir: Path | None = None, quantum: bool = True, track_log: bool = True) -> str:
    """quantum=False / track_log=False: the intraday refresh republishes the last simulations and doesn't
    append to the signal log (both stay once a night)."""
    from quant.config import get_settings

    site_dir = site_dir or get_settings().data_dir / "site"
    check_calculations()
    if export:
        stats = build(site_dir, quantum=quantum, track_log=track_log)
        log.info("site exported in %ss", stats["seconds"])
    return publish(site_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish the static site to GitHub Pages.")
    parser.add_argument("--no-export", action="store_true", help="push data/site as it is")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "httpx2", "streamlit"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    print(run(export=not args.no_export))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
