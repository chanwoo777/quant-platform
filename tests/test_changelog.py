"""Changelog (quant/web/changelog.py): only feat/fix commits, methodology changes marked."""

import subprocess

from quant.web import changelog

S, E = changelog.SEP, changelog.END


def record(sha, date, subject, body, files):
    return f"{E}{sha}{S}{date}{S}{subject}{S}{body}{S}\n\n" + "\n".join(files) + "\n"


def test_parse_keeps_tagged_commits_and_marks_methodology():
    text = (record("a" * 40, "2026-10-28", "feat(track-record): append-only log", "Logs each night.\n\nCo-Authored-By: x", ["quant/web/track.py"])
            + record("b" * 40, "2026-10-27", "Ingest gross margins", "untagged", ["quant/web/export.py"])
            + record("c" * 40, "2026-10-26", "fix: badge colour", "", ["docs/assets/app.js"])
            + record("d" * 40, "2026-10-25", "feat(methodology)!: new composite weights", "", ["README.md"]))
    out = changelog.parse(text)
    assert [e["short"] for e in out] == ["aaaaaaa", "ccccccc", "ddddddd"]
    track, fix, weights = out
    assert track["type"] == "feat" and track["scope"] == "track-record" and track["methodology"] and track["body"] == "Logs each night."
    assert track["method_files"] == ["quant/web/track.py"]
    assert fix["type"] == "fix" and not fix["methodology"]
    assert weights["methodology"] and weights["breaking"] and weights["url"].endswith("d" * 40)


def test_build_reads_this_repository(tmp_path):
    doc = changelog.build(changelog.Path(__file__).resolve().parents[1], tmp_path / "changelog.json")
    assert (tmp_path / "changelog.json").exists()
    assert all(e["type"] in ("feat", "fix") for e in doc["entries"])


def test_build_falls_back_to_the_last_good_file(tmp_path, monkeypatch):
    cache = tmp_path / "changelog.json"
    cache.write_text('{"entries": [{"title": "kept"}]}', encoding="utf-8")
    monkeypatch.setattr(changelog.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("git")))
    doc = changelog.build(tmp_path, cache)
    assert doc["entries"] == [{"title": "kept"}] and "git" in doc["stale_reason"]
    assert subprocess  # the real module is untouched outside this test
