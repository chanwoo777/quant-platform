"""Daily brief (quant/web/brief.py): each rule on small synthetic data, both languages, and the archive."""

import numpy as np
import pandas as pd

from quant.web import brief


def scores():
    rows = []
    for i in range(30):
        sector = "Technology" if i < 15 else "Energy"
        rows.append({"symbol": f"S{i}", "name": f"Stock {i}", "asset_class": "stock", "market": "US", "sector": sector,
                     "market_cap_usd": 20e9 + i * 1e9, "ret_1d": (0.01 if sector == "Technology" else -0.02) + i * 0.0001})
    rows.append({"symbol": "BIG", "name": "Big Mover", "asset_class": "stock", "market": "Korea", "sector": "Technology", "market_cap_usd": 50e9, "ret_1d": 0.12})
    rows.append({"symbol": "TINY", "name": "Tiny", "asset_class": "stock", "market": "US", "sector": "Energy", "market_cap_usd": 2e9, "ret_1d": 0.50})
    return pd.DataFrame(rows)


def close():
    idx = pd.bdate_range("2026-10-26", periods=2)
    return pd.DataFrame({"SPY": [100, 101], "MTUM": [100, 102.5], "VLUE": [100, 101.1], "QUAL": [100, 101], "USMV": [100, 100.2],
                         "IWM": [100, 101.2], "^VIX": [18.0, 19.8]}, index=idx)


def test_rules_write_both_languages():
    macro = pd.DataFrame({"DGS10": [4.10, 4.13], "DGS2": [3.60, 3.60]}, index=pd.to_datetime(["2026-10-26", "2026-10-27"]))
    b = brief.build(scores(), close(), macro, "2026-10-27")
    by = {i["kind"]: i for i in b["items"]}
    assert set(by) == {"movers", "sectors", "factors", "vix", "rates"} and b["skipped"] == []
    m = by["movers"]
    assert m["data"]["names"][0]["symbol"] == "BIG" and "TINY" not in m["en"] and len(m["data"]["names"]) == 5
    assert "Big Mover (BIG) +12.0%" in m["en"] and "BIG" in m["ko"] and "시가총액" in m["ko"]
    assert by["sectors"]["data"]["best"]["sector"] == "Technology" and "기술" in by["sectors"]["ko"] and "에너지" in by["sectors"]["ko"]
    f = by["factors"]
    assert f["en"].startswith("Notable factor moves: Momentum (MTUM) beat the S&P 500 by 1.5 pp") and "USMV" in f["en"]
    assert "모멘텀(MTUM) S&P 500 대비 +1.5%p" in f["ko"]
    assert by["vix"]["en"] == "The VIX rose 1.8 points to 19.8." and "올라" in by["vix"]["ko"]
    assert by["rates"]["en"] == "Treasury yields: 10-year 4.13% (+3 bp), 2-year 3.60% (0 bp), as of 2026-10-27 (FRED)."


def test_quiet_factors_and_missing_inputs_are_skipped_not_fatal():
    c = close().assign(MTUM=[100, 101.1], USMV=[100, 101], QUAL=[100, 101.2], VLUE=[100, 101], IWM=[100, 101])
    b = brief.build(scores(), c.drop(columns=["^VIX"]), pd.DataFrame(), "2026-10-27")
    by = {i["kind"]: i for i in b["items"]}
    assert "none was 0.5 percentage points ahead or behind" in by["factors"]["en"]
    assert {s["kind"] for s in b["skipped"]} == {"vix", "rates"}


def test_archive_keeps_the_latest_30(tmp_path):
    for d in pd.bdate_range("2026-08-03", periods=35):
        brief.archive(tmp_path, {"date": f"{d:%Y-%m-%d}", "items": []})
    kept = brief.archive(tmp_path, {"date": "2026-10-28", "items": [{"kind": "x"}]})
    assert len(kept) == 30 and kept[0]["date"] == "2026-10-28" and kept[0]["items"] == [{"kind": "x"}]
    assert [k["date"] for k in kept] == sorted((k["date"] for k in kept), reverse=True)
    assert np.all([(tmp_path / "briefs" / f"brief_{k['date']}.json").exists() for k in kept])
