"""status.json (quant/web/status.py): states, fail-soft sources, and a missing source turning red."""

import datetime as dt

import numpy as np
import pandas as pd
import pytest

from quant.web import status

WED = dt.date(2026, 10, 28)


def test_age_counts_weekdays_like_the_site():
    assert status.age_days("2026-10-27", WED) == 1  # Tuesday's close, seen on Wednesday
    assert status.age_days("2026-10-23", WED) == 3  # Friday -> Wednesday: Fri, Mon, Tue
    assert status.age_days("2026-10-24", WED, calendar=True) == 4
    assert status.age_days(None, WED) is None


@pytest.mark.parametrize("age,expect,state", [(1, 1, "green"), (2, 1, "amber"), (3, 1, "amber"), (4, 1, "red"), (40, 45, "green"), (None, 1, "red")])
def test_state_thresholds(age, expect, state):
    assert status.state_for({"rows": 10, "age": age, "expect_days": expect}) == state


def test_failing_and_missing_sources_are_red_and_do_not_raise():
    b = status.Builder(WED)
    b.add("ok", "Fine", "x", 1, lambda: {"rows": 5, "as_of": "2026-10-27"})
    b.add("gone", "Deleted file", "x", 1, lambda: (_ for _ in ()).throw(FileNotFoundError(2, "No such file", "data/universe/close.parquet")))
    b.add("boom", "Broken", "x", 1, lambda: 1 / 0)
    b.add("empty", "Empty", "x", 1, lambda: {"rows": 0, "as_of": "2026-10-27"})
    doc = b.to_dict({"global": {"ok": True}})
    by = {s["id"]: s for s in doc["sources"]}
    assert by["ok"]["state"] == "green"
    assert by["gone"]["state"] == "red" and "close.parquet" in by["gone"]["error"]
    assert by["boom"]["state"] == "red" and by["boom"]["error"].startswith("ZeroDivisionError")
    assert by["empty"]["state"] == "red"
    assert doc["overall"] == "red"


def test_a_failed_export_step_turns_its_sources_red():
    b = status.Builder(WED)
    b.add("fred", "FRED", "x", 1, lambda: {"rows": 5, "as_of": "2026-10-27"}, feeds="market")
    b.add("quantum", "Quantum", "x", 1, lambda: {"rows": 5, "as_of": "2026-10-27"}, feeds="quantum")
    doc = b.to_dict({"market": {"ok": False, "error": "KeyError: 'DGS10'"}, "quantum": {"ok": True}})
    by = {s["id"]: s for s in doc["sources"]}
    assert by["fred"]["state"] == "red" and "export step 'market' failed" in by["fred"]["error"]
    assert by["quantum"]["state"] == "green"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    from quant.config import get_settings

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'q.db').as_posix()}")
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


def test_collect_with_a_deleted_price_file_reports_red(data_dir):
    from quant.universe import prices

    idx = pd.bdate_range("2026-01-01", "2026-10-27")
    close = pd.DataFrame({"AAA": np.linspace(10, 20, len(idx)), "BBB": np.linspace(5, 6, len(idx))}, index=idx)
    prices.save("close", close)
    prices.save("volume", close * 0 + 1000)
    ok = {s["id"]: s for s in status.collect(data_dir, [], today=WED).sources}
    assert ok["yahoo-prices"]["state"] == "green" and ok["yahoo-prices"]["rows"] == close.size
    (data_dir / "universe" / "close.parquet").unlink()  # the acceptance check: delete a source file
    gone = {s["id"]: s for s in status.collect(data_dir, [], today=WED).sources}
    assert gone["yahoo-prices"]["state"] == "red" and "close.parquet" in gone["yahoo-prices"]["error"]
    assert gone["scores"]["state"] == "red" and gone["quantum"]["state"] == "red"  # never written here
