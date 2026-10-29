"""The daily brief on the Global page: a few sentences written by rules from tonight's data, no AI.

    data/briefs/brief_<date>.json   one brief per price date (rewritten if the night is re-run)
    briefs.json (site)              the latest 30, newest first

What it says, each from data the export already has:
  movers   the 5 largest 1-day moves among stocks worth $10B or more (scores.parquet)
  sectors  the best and worst sector by cap-weighted 1-day move, sectors with 10+ such stocks
  factors  factor ETFs (momentum, value, quality, low volatility, small caps) against the S&P 500 ETF;
           a gap of 0.5 percentage points or more is "notable"
  vix      the VIX's 1-day change in points (the price store)
  rates    the 10-year and 2-year Treasury yields and their change in basis points (FRED)
Every sentence is written in English and Korean; tickers and numbers are the same in both.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("quant.web")

MIN_CAP_USD = 10e9
TOP_MOVERS = 5
MIN_SECTOR_NAMES = 10
FACTOR_ETFS = {"MTUM": ("Momentum", "모멘텀"), "VLUE": ("Value", "가치"), "QUAL": ("Quality", "퀄리티"),
               "USMV": ("Low volatility", "저변동성"), "IWM": ("Small caps", "소형주")}
BENCH_ETF = "SPY"
NOTABLE_PP = 0.5
KEEP = 30
SECTOR_KO = {"Technology": "기술", "Financial Services": "금융", "Healthcare": "헬스케어", "Consumer Cyclical": "경기소비재",
             "Consumer Defensive": "필수소비재", "Industrials": "산업재", "Energy": "에너지", "Basic Materials": "소재",
             "Real Estate": "부동산", "Utilities": "유틸리티", "Communication Services": "커뮤니케이션 서비스"}


def _pct(x: float, digits: int = 1) -> str:
    return f"{x * 100:+.{digits}f}%".replace("-", "−")


def _last_two(s: pd.Series):
    s = s.dropna()
    return (s.iloc[-1], s.iloc[-2], s.index[-1]) if len(s) >= 2 else None


def movers(scores: pd.DataFrame) -> dict | None:
    big = scores[(scores.asset_class == "stock") & (scores.market_cap_usd >= MIN_CAP_USD) & scores.ret_1d.notna()]
    if big.empty:
        return None
    top = big.reindex(big.ret_1d.abs().sort_values(ascending=False).index).head(TOP_MOVERS)
    names = [{"symbol": r.symbol, "name": r.name, "ret_1d": float(r.ret_1d), "market": r.market} for r in top.itertuples()]
    listed = ", ".join(f"{n['name']} ({n['symbol']}) {_pct(n['ret_1d'])}" for n in names)
    return {"kind": "movers", "data": {"names": names, "universe": int(len(big))},
            "en": f"Biggest moves among the {len(big):,} stocks worth $10B or more: {listed}.",
            "ko": f"시가총액 100억 달러 이상 {len(big):,}개 종목 중 가장 크게 움직인 종목: {listed}."}


def sectors(scores: pd.DataFrame) -> dict | None:
    s = scores[(scores.asset_class == "stock") & scores.sector.notna() & scores.ret_1d.notna() & (scores.market_cap_usd > 0)]
    g = s.groupby("sector").filter(lambda x: len(x) >= MIN_SECTOR_NAMES).groupby("sector")
    if not len(g):
        return None
    moves = g.apply(lambda x: float(np.average(x.ret_1d, weights=x.market_cap_usd)), include_groups=False).sort_values()
    best, worst = moves.index[-1], moves.index[0]
    data = {"best": {"sector": best, "ret_1d": float(moves[best])}, "worst": {"sector": worst, "ret_1d": float(moves[worst])}, "sectors": int(len(moves))}
    return {"kind": "sectors", "data": data,
            "en": f"Best sector: {best} {_pct(moves[best], 2)}; worst: {worst} {_pct(moves[worst], 2)} (cap-weighted, {len(moves)} sectors worldwide).",
            "ko": f"가장 강한 업종은 {SECTOR_KO.get(best, best)} {_pct(moves[best], 2)}, 가장 약한 업종은 {SECTOR_KO.get(worst, worst)} "
                  f"{_pct(moves[worst], 2)}입니다 (시가총액 가중, 전 세계 {len(moves)}개 업종)."}


def factors(close: pd.DataFrame) -> dict | None:
    bench = _last_two(close[BENCH_ETF]) if BENCH_ETF in close else None
    if bench is None:
        return None
    b_ret = bench[0] / bench[1] - 1
    rows = []
    for sym, (en, ko) in FACTOR_ETFS.items():
        lt = _last_two(close[sym]) if sym in close else None
        if lt is not None:
            r = lt[0] / lt[1] - 1
            rows.append({"symbol": sym, "factor": en, "factor_ko": ko, "ret_1d": float(r), "vs_spy_pp": float((r - b_ret) * 100)})
    if not rows:
        return None
    notable = sorted([r for r in rows if abs(r["vs_spy_pp"]) >= NOTABLE_PP], key=lambda r: -abs(r["vs_spy_pp"]))
    data = {"etfs": rows, "spy_ret_1d": float(b_ret), "notable_pp": NOTABLE_PP}
    if not notable:
        return {"kind": "factors", "data": data,
                "en": f"Factor ETFs moved with the S&P 500 (SPY {_pct(b_ret, 2)}): none was {NOTABLE_PP} percentage points ahead or behind.",
                "ko": f"팩터 ETF는 S&P 500(SPY {_pct(b_ret, 2)})과 비슷하게 움직였습니다. {NOTABLE_PP}%p 이상 앞서거나 뒤처진 팩터는 없습니다."}
    en = "; ".join(f"{r['factor']} ({r['symbol']}) {'beat' if r['vs_spy_pp'] > 0 else 'trailed'} the S&P 500 by {abs(r['vs_spy_pp']):.1f} pp" for r in notable[:3])
    ko = ", ".join(f"{r['factor_ko']}({r['symbol']}) S&P 500 대비 {r['vs_spy_pp']:+.1f}%p".replace("-", "−") for r in notable[:3])
    return {"kind": "factors", "data": data, "en": f"Notable factor moves: {en} (SPY {_pct(b_ret, 2)}).", "ko": f"눈에 띄는 팩터 움직임: {ko} (SPY {_pct(b_ret, 2)})."}


def vix(close: pd.DataFrame) -> dict | None:
    lt = _last_two(close["^VIX"]) if "^VIX" in close else None
    if lt is None:
        return None
    last, prev, when = lt
    chg = last - prev
    data = {"level": float(last), "change": float(chg), "date": f"{when:%Y-%m-%d}"}
    if not round(chg, 1):
        return {"kind": "vix", "data": data, "en": f"The VIX was unchanged at {last:.1f}.", "ko": f"VIX는 {last:.1f}로 변동이 없었습니다."}
    up = chg > 0
    return {"kind": "vix", "data": data,
            "en": f"The VIX {'rose' if up else 'fell'} {abs(chg):.1f} points to {last:.1f}.",
            "ko": f"VIX는 {abs(chg):.1f}포인트 {'올라' if up else '내려'} {last:.1f}을(를) 기록했습니다."}


def rates(macro: pd.DataFrame) -> dict | None:
    parts, data = [], {}
    for sid, label, label_ko in (("DGS10", "10-year", "10년물"), ("DGS2", "2-year", "2년물")):
        if sid not in macro:
            continue
        lt = _last_two(macro[sid])
        if lt is None:
            continue
        last, prev, when = lt
        bp = round((last - prev) * 100)
        data[sid] = {"yield": float(last), "change_bp": int(bp), "date": f"{when:%Y-%m-%d}"}
        parts.append((label, label_ko, last, bp, when))
    if not parts:
        return None
    bp_txt = lambda bp: (f"{bp:+d} bp" if bp else "0 bp").replace("-", "−")  # noqa: E731
    en = ", ".join(f"{label} {y:.2f}% ({bp_txt(bp)})" for label, _, y, bp, _ in parts)
    ko = ", ".join(f"{k} {y:.2f}% ({bp_txt(bp)})" for _, k, y, bp, _ in parts)
    when = max(p[4] for p in parts)
    return {"kind": "rates", "data": data, "en": f"Treasury yields: {en}, as of {when:%Y-%m-%d} (FRED).",
            "ko": f"미 국채 금리: {ko}, {when:%Y-%m-%d} 기준 (FRED)."}


def build(scores: pd.DataFrame, close: pd.DataFrame, macro: pd.DataFrame, as_of: str) -> dict:
    """Tonight's brief. Each rule runs on its own: one that fails or has no data is skipped and noted."""
    items, skipped = [], []
    for name, fn in (("movers", lambda: movers(scores)), ("sectors", lambda: sectors(scores)), ("factors", lambda: factors(close)),
                     ("vix", lambda: vix(close)), ("rates", lambda: rates(macro))):
        try:
            item = fn()
        except Exception as exc:  # a broken rule leaves its line out, never the whole brief
            log.exception("brief: %s failed", name)
            skipped.append({"kind": name, "reason": f"{type(exc).__name__}: {exc}"})
            continue
        if item is None:
            skipped.append({"kind": name, "reason": "no data"})
        else:
            items.append(item)
    return {"date": as_of, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "items": items, "skipped": skipped}


def archive(data_dir: Path, brief: dict, keep: int = KEEP) -> list[dict]:
    """Save tonight's brief and return the latest `keep`, newest first."""
    folder = data_dir / "briefs"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"brief_{brief['date']}.json").write_text(json.dumps(brief, ensure_ascii=False), encoding="utf-8")
    files = sorted(folder.glob("brief_*.json"), reverse=True)[:keep]
    return [json.loads(f.read_text(encoding="utf-8")) for f in files]
