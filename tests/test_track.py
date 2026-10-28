"""Signal track record (quant/web/track.py): the log is append-only and forward returns are right."""

import hashlib

import numpy as np
import pandas as pd

from quant.web import track


def scores(signals, closes, scored="2026-01-05 22:00"):
    return pd.DataFrame({"symbol": list(signals), "market": "US", "asset_class": "stock", "signal": list(signals.values()),
                         "composite": [70.0, 50.0, 30.0][: len(signals)], "last_close": closes, "scored_at": pd.Timestamp(scored)})


def snapshot(folder):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir())}


def test_rerun_never_rewrites_history(tmp_path):
    first = scores({"AAA": "BUY", "BBB": "HOLD", "CCC": "AVOID"}, [10, 20, 30])
    assert track.append(tmp_path, first, "2026-01-05")["logged"]
    before = snapshot(track.log_dir(tmp_path))
    changed = scores({"AAA": "AVOID", "BBB": "AVOID", "CCC": "BUY"}, [11, 21, 31])  # a rerun with different numbers
    again = track.append(tmp_path, changed, "2026-01-05")
    assert not again["logged"] and again["reason"] == "already logged"
    assert snapshot(track.log_dir(tmp_path)) == before  # same files, same bytes, same manifest
    older = track.append(tmp_path, changed, "2026-01-02")  # no backfilling before the last logged date
    assert not older["logged"] and "older" in older["reason"]
    assert snapshot(track.log_dir(tmp_path)) == before
    assert track.load(tmp_path).set_index("symbol").signal.to_dict() == {"AAA": "BUY", "BBB": "HOLD", "CCC": "AVOID"}


def test_new_days_append_and_the_hash_chain_detects_edits(tmp_path):
    track.append(tmp_path, scores({"AAA": "BUY"}, [10]), "2026-01-05")
    track.append(tmp_path, scores({"AAA": "HOLD"}, [11]), "2026-01-06")
    v = track.verify(tmp_path)
    assert v == {"entries": 2, "ok": True, "problems": []}
    f = track.log_dir(tmp_path) / "signals_2026-01-05.parquet"
    f.write_bytes(f.read_bytes() + b"x")  # someone edits an old day
    v = track.verify(tmp_path)
    assert not v["ok"] and v["problems"] == ["2026-01-05: file changed after it was logged"]


def test_forward_returns_enter_next_session_and_beat_the_benchmark():
    idx = pd.bdate_range("2026-01-05", periods=80)
    close = pd.DataFrame({"AAA": 100 * 1.01 ** np.arange(80), "^GSPC": 100 * 1.002 ** np.arange(80)}, index=idx)
    log = pd.DataFrame({"date": [idx[0]], "symbol": ["AAA"], "signal": ["BUY"], "market": ["US"]})
    fr = track.forward_returns(log, close, {"US": "^GSPC"}).set_index("horizon")
    assert set(fr.index) == {5, 20, 60}
    assert fr.loc[5, "entry"] == idx[1] and fr.loc[5, "exit"] == idx[6]  # next session's close, then 5 sessions
    assert np.isclose(fr.loc[20, "ret"], 1.01 ** 20 - 1) and np.isclose(fr.loc[20, "bench"], 1.002 ** 20 - 1)
    assert fr.loc[60, "excess"] > 0


def test_summary_labels_too_few_observations(tmp_path):
    idx = pd.bdate_range("2026-01-05", periods=40)
    close = pd.DataFrame({"AAA": np.linspace(10, 14, 40), "BBB": np.linspace(20, 18, 40), "^GSPC": np.linspace(100, 101, 40)}, index=idx)
    for i in range(3):
        track.append(tmp_path, scores({"AAA": "BUY", "BBB": "AVOID"}, [close.AAA.iloc[i], close.BBB.iloc[i]]), f"{idx[i]:%Y-%m-%d}")
    doc = track.summarize(tmp_path, close, {"US": "^GSPC"})
    assert doc["start"] == "2026-01-05" and doc["days_logged"] == 3
    buy5, avoid5 = doc["horizons"]["5"]["BUY"], doc["horizons"]["5"]["AVOID"]
    assert buy5["observations"] == 3 and not buy5["enough"] and buy5["hit_rate"] == 1.0
    assert avoid5["hit_rate"] == 1.0  # AVOID counts as a hit when it trails the benchmark
    assert doc["horizons"]["60"]["BUY"]["observations"] == 0  # 60 sessions haven't passed yet
