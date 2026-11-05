"""The research agent's sector news digest is web-sourced text written by a model, so nothing reaches the site
without passing quant/web/digest.py: known sectors, plain text, https links, written in the last 36 hours."""
import datetime as dt
import json

import pytest

from quant.universe.sources import SECTORS
from quant.web import digest

NOW = dt.datetime(2026, 11, 5, 12, 0, tzinfo=dt.timezone.utc)


def doc(**over):
    base = {"generated_at": "2026-11-05T11:30:00Z", "sectors": [
        {"sector": "Technology", "summary": "Chip makers rose after earnings.",
         "items": [{"title": "Chip stocks climb", "src": "Example News", "url": "https://example.com/chips", "date": "2026-11-05"}]},
        {"sector": "Energy", "summary": "Oil slipped on supply news.",
         "items": [{"title": "Oil falls", "src": "Example Wire", "url": "https://example.com/oil"}]},
    ]}
    return base | over


def test_sectors_match_the_screener():
    assert digest.SECTORS == SECTORS


def test_valid_digest_is_published_in_sector_order():
    out = digest.validate(doc(), NOW)
    assert [s["sector"] for s in out["sectors"]] == ["Energy", "Technology"]
    assert out["generated_at"] == "2026-11-05T11:30:00+00:00" and out["skipped"] == []
    assert out["sectors"][0]["items"][0] == {"title": "Oil falls", "src": "Example Wire", "url": "https://example.com/oil", "date": None}


@pytest.mark.parametrize("bad", [
    {"sector": "Crypto", "summary": "x", "items": [{"title": "t", "src": "s", "url": "https://e.com"}]},
    {"sector": "Utilities", "summary": "<script>alert(1)</script>", "items": [{"title": "t", "src": "s", "url": "https://e.com"}]},
    {"sector": "Utilities", "summary": "ok", "items": [{"title": "t", "src": "s", "url": "javascript:alert(1)"}]},
    {"sector": "Utilities", "summary": "ok", "items": [{"title": "t", "src": "s", "url": "http://e.com"}]},
    {"sector": "Utilities", "summary": "ok", "items": []},
    {"sector": "Utilities", "summary": "x" * 601, "items": [{"title": "t", "src": "s", "url": "https://e.com"}]},
    {"sector": "Technology", "summary": "repeat", "items": [{"title": "t", "src": "s", "url": "https://e.com"}]},
])
def test_a_sector_that_breaks_a_rule_is_left_out(bad):
    d = doc()
    d["sectors"].append(bad)
    out = digest.validate(d, NOW)
    assert len(out["sectors"]) == 2 and len(out["skipped"]) == 1


def test_hidden_characters_are_removed():
    d = doc()
    d["sectors"][0]["summary"] = "Chips\u202e rose\u200b  today"
    assert digest.validate(d, NOW)["sectors"][1]["summary"] == "Chips rose today"


@pytest.mark.parametrize("when, problem", [("2026-11-03T23:00:00Z", "older than 36 hours"), ("2026-11-05T13:00:00Z", "in the future"),
                                           ("2026-11-05T11:30:00", "time zone"), ("yesterday", "ISO")])
def test_stale_or_undated_digest_is_rejected(when, problem):
    with pytest.raises(digest.DigestError, match=problem):
        digest.validate(doc(generated_at=when), NOW)


def test_digest_with_no_valid_sector_is_rejected():
    with pytest.raises(digest.DigestError, match="no valid sector"):
        digest.validate(doc(sectors=[{"sector": "Crypto"}]), NOW)


def test_cli_check(tmp_path, capsys):
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    fresh = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    good.write_text(json.dumps(doc(generated_at=fresh)), encoding="utf-8")
    bad.write_text(json.dumps(doc(generated_at="2020-01-01T00:00:00Z")), encoding="utf-8")
    assert digest.main([str(good)]) == 0 and "2 sectors" in capsys.readouterr().out
    assert digest.main([str(bad)]) == 1 and "rejected" in capsys.readouterr().out
