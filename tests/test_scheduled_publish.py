"""The nightly task runs under pythonw (no console handles): the publish gate must give its test run a stdin of
its own, and the daily cycle re-checks the deep-tier daily bars before publishing."""
import subprocess

import pytest

from quant import scheduler
from quant.web import publish


def test_gate_runs_tests_with_their_own_stdin(monkeypatch):
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(kw)
        return subprocess.CompletedProcess(cmd, 0, stdout="55 passed in 1s\n", stderr="")

    monkeypatch.setattr(publish.subprocess, "run", fake_run)
    publish.check_calculations()
    assert seen["stdin"] is subprocess.DEVNULL and seen["capture_output"] is True


def test_gate_failure_blocks_the_publish(monkeypatch):
    monkeypatch.setattr(publish.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, stdout="1 failed\n", stderr=""))
    with pytest.raises(RuntimeError, match="not published"):
        publish.check_calculations()


def test_daily_cycle_catches_up_daily_bars_before_publishing(monkeypatch):
    order = []
    monkeypatch.setattr(scheduler, "_deep_tier", lambda: (["AAPL"], ["AAPL"]))
    monkeypatch.setattr(scheduler, "run_pipeline", lambda settings: [])
    monkeypatch.setattr(scheduler, "print_summary", lambda results: None)
    monkeypatch.setattr(scheduler.bot, "run_live", lambda *a, **k: [])
    monkeypatch.setattr(scheduler, "init_db", lambda: None)
    monkeypatch.setattr(scheduler, "heal_yfinance_cache", lambda: None)

    class _Session:
        def __enter__(self): return None
        def __exit__(self, *a): return False

    monkeypatch.setattr(scheduler, "session_scope", lambda engine: _Session())
    monkeypatch.setattr(scheduler, "universe_refresh", lambda: order.append("universe"))
    monkeypatch.setattr(scheduler, "catch_up_daily", lambda tickers: order.append(("catch_up", tickers[0])))
    monkeypatch.setattr(scheduler, "site_publish", lambda: order.append("publish"))
    scheduler.daily_cycle(publish_site=True)
    assert order == ["universe", ("catch_up", "AAPL"), "publish"]


def test_corrupt_yfinance_cache_is_removed(tmp_path, monkeypatch):
    import yfinance.cache as yfc

    bad, good = tmp_path / "tkr-tz.db", tmp_path / "cookies.db"
    bad.write_bytes(b"SQLite format 3\x00" + b"\xff" * 4000)  # a header and garbage: not a usable database
    import sqlite3
    with sqlite3.connect(good) as con:
        con.execute("create table t (x)")
    monkeypatch.setattr(yfc._TzDBManager, "get_location", classmethod(lambda cls: str(tmp_path)))
    scheduler.heal_yfinance_cache()
    assert not bad.exists() and good.exists()
