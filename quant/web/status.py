"""status.json: what the nightly job loaded, from where, how fresh it is and what failed.

One entry per source: when it last ran successfully, the date its data runs to, row counts, missing
tickers, stale series, outliers flagged for review and the quality checks (quant.web.quality). Every
source is read in its own try block, so a missing file or table gives that source a red state and an
error message instead of stopping the export. The site's Data status page (#/status) renders this
file, and every panel's freshness badge takes its colour from it.

State: red when the source is missing, empty or failed, or its data is more than 3x its expected age;
amber when it is older than expected; green otherwise. Ages count weekdays (calendar days for coins).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from quant.web import quality

log = logging.getLogger("quant.web")
SAMPLE = 50  # tickers listed per "missing" or "stale" list (counts are exact)


def age_days(as_of, today: dt.date, calendar: bool = False) -> int | None:
    """Weekdays (or calendar days) from the data's date to today; 0 = today, 1 = yesterday's close."""
    if as_of is None:
        return None
    d = pd.Timestamp(as_of).date()
    if calendar:
        return max(0, (today - d).days)
    return max(0, int(np.busday_count(d, today)))


def state_for(src: dict) -> str:
    if src.get("error") or src.get("missing_file") or not src.get("rows"):
        return "red"
    age, expect = src.get("age"), src.get("expect_days") or 1
    if age is None:
        return "red"
    if age > 3 * expect:
        return "red"
    return "amber" if age > expect else "green"


def _iso(ts) -> str | None:
    if ts is None or (isinstance(ts, float) and np.isnan(ts)) or pd.isna(ts):
        return None
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")  # the database stores naive UTC
    return t.isoformat(timespec="seconds")


def _mtime(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat(timespec="seconds")


def _sample(items) -> dict:
    items = sorted(map(str, items))
    return {"count": len(items), "sample": items[:SAMPLE]}


def _quality(q: dict) -> dict:
    """The parts of a quality.check_prices result that belong in status.json."""
    return {"checks": q.get("checks", {}), "stale": {"count": q.get("stale", {}).get("count"), "sample": q.get("stale", {}).get("failed", [])[:SAMPLE],
                                                      "error": q.get("stale", {}).get("error")},
            "outliers": q.get("outliers", {"count": None, "failed": [], "error": "not run"})}


class Builder:
    def __init__(self, today: dt.date | None = None):
        self.today = today or dt.datetime.now(dt.timezone.utc).date()
        self.sources: list[dict] = []
        self.flags: dict[str, list[str]] = {}

    def add(self, sid: str, label: str, provider: str, expect_days: int, fn, calendar: bool = False, feeds: str = "") -> dict:
        """fn() returns the source's fields (rows, as_of, last_success, ...); exceptions become a red entry."""
        src = {"id": sid, "label": label, "provider": provider, "expect_days": expect_days, "calendar": calendar, "feeds": feeds}
        try:
            src.update(fn() or {})
        except FileNotFoundError as exc:
            src.update(missing_file=str(exc.filename or exc), error=f"missing file: {exc.filename or exc}")
        except Exception as exc:
            log.exception("status: source %s failed", sid)
            src["error"] = f"{type(exc).__name__}: {exc}"
        src["age"] = age_days(src.get("as_of"), self.today, calendar)
        src["state"] = state_for(src)
        self.sources.append(src)
        return src

    def to_dict(self, export_steps: dict) -> dict:
        failed_steps = {k: v for k, v in export_steps.items() if not v.get("ok")}
        for src in self.sources:  # a failed export step turns the sources it publishes red
            hit = [k for k in failed_steps if k in (src.get("feeds") or "").split(",")]
            if hit:
                src["state"] = "red"
                src["error"] = (src.get("error") + "; " if src.get("error") else "") + "; ".join(
                    f"export step '{k}' failed: {failed_steps[k].get('error')}" for k in hit)
        states = [s["state"] for s in self.sources]
        overall = "red" if "red" in states else "amber" if "amber" in states else "green"
        return {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "today": self.today.isoformat(), "overall": overall, "sources": self.sources,
                "export_steps": export_steps, "thresholds": {
                    "amber": "older than the source's expected age", "red": "missing, failed, or older than 3x the expected age",
                    "outlier_sigma": quality.OUTLIER_SIGMA, "outlier_sessions": quality.OUTLIER_SESSIONS, "gap_sessions": quality.GAP_SESSIONS,
                    "unit_jump": quality.UNIT_JUMP, "stale_sessions": quality.STALE_SESSIONS}}


def collect(data_dir: Path, deep_tickers: list[str], today: dt.date | None = None) -> Builder:
    """Read every nightly source. The Builder's .flags maps symbol -> quality flag codes for the screener
    and symbol pages; add the export's own sources with .add(), then .to_dict(export_steps)."""
    from sqlalchemy import func, select

    from quant.db import init_db, session_scope
    from quant.models import Company, FactorReturn, Fundamental, MacroObservation, MacroSeries, NewsArticle, PriceBar
    from quant.universe.models import Instrument, InstrumentFundamentals

    b = Builder(today)
    uni = data_dir / "universe"
    engine = init_db()
    flags: dict[str, set] = {}

    def remember(q: dict):
        for sym, codes in q.get("flags", {}).items():
            flags.setdefault(sym, set()).update(codes)

    def active_instruments() -> pd.DataFrame:
        with session_scope(engine) as s:
            rows = s.execute(select(Instrument.symbol, Instrument.asset_class, Instrument.market).where(Instrument.active.is_(True))).all()
        return pd.DataFrame(rows, columns=["symbol", "asset_class", "market"])

    inst = active_instruments()
    market_of = dict(zip(inst.symbol, inst.market))
    from quant.universe.scoring import BENCHMARKS

    for market, sym in BENCHMARKS.items():  # indices keep their own market's holidays
        market_of.setdefault(sym, market)

    def universe_prices():
        path = uni / "close.parquet"
        if not path.exists():
            raise FileNotFoundError(2, "No such file", str(path))
        from quant.universe import prices

        close, volume = prices.load("close"), prices.load("volume")
        q = quality.check_prices(close, volume, market_of)
        remember(q)
        have = set(close.columns[close.notna().any()])
        return {"rows": int(close.notna().sum().sum()), "series": int(close.shape[1]),
                "as_of": f"{close.index.max():%Y-%m-%d}" if len(close) else None, "last_success": _mtime(path),
                "missing": _sample(set(inst.symbol) - have), **_quality(q),
                "file": "data/universe/close.parquet, volume.parquet"}

    def universe_scores():
        path = uni / "scores.parquet"
        if not path.exists():
            raise FileNotFoundError(2, "No such file", str(path))
        s = pd.read_parquet(path)
        unscored = s.symbol[s.composite.isna()]
        dups = quality.duplicate_symbols(s.symbol)
        for d in dups:
            flags.setdefault(d["symbol"], set()).add("duplicate")
        last_close = pd.read_parquet(uni / "close.parquet").index.max() if (uni / "close.parquet").exists() else None
        return {"rows": int(len(s)), "as_of": f"{pd.Timestamp(last_close):%Y-%m-%d}" if last_close is not None else None,
                "last_success": _iso(s.scored_at.max()), "missing": _sample(set(inst.symbol) - set(s.symbol)),
                "unscored": _sample(unscored), "checks": {"duplicates": {"count": len(dups), "failed": dups[:quality.LIST_LIMIT], "error": None}},
                "file": "data/universe/scores.parquet"}

    def universe_fundamentals():
        with session_scope(engine) as s:
            n, last, errors = s.execute(select(func.count(), func.max(InstrumentFundamentals.fetched_at),
                                               func.sum(InstrumentFundamentals.error.isnot(None)))).one()
            last_ok = s.execute(select(func.max(InstrumentFundamentals.fetched_at)).where(InstrumentFundamentals.error.is_(None))).scalar()
            fetched = dict(s.execute(select(InstrumentFundamentals.symbol, InstrumentFundamentals.fetched_at)).all())
        stocks = set(inst.symbol[inst.asset_class == "stock"])
        cutoff = pd.Timestamp(b.today) - pd.Timedelta(days=14)
        old = [sym for sym in stocks if sym in fetched and pd.Timestamp(fetched[sym]) < cutoff]
        return {"rows": int(n or 0), "as_of": f"{pd.Timestamp(last_ok):%Y-%m-%d}" if last_ok else None, "last_success": _iso(last_ok),
                "errors": int(errors or 0), "missing": _sample(stocks - set(fetched)),
                "stale": {"count": len(old), "sample": [{"symbol": x, "date": f"{pd.Timestamp(fetched[x]):%Y-%m-%d}", "detail": "not refreshed in 14 days"}
                                                        for x in sorted(old)[:SAMPLE]], "error": None},
                "file": "database table universe_fundamentals"}

    def deep_prices():
        with session_scope(engine) as s:
            rows = s.execute(select(PriceBar.ticker, PriceBar.timestamp, PriceBar.close, PriceBar.volume)
                             .where(PriceBar.interval == "1d", PriceBar.ticker.in_(deep_tickers))).all()
            total = s.execute(select(func.count()).where(PriceBar.interval == "1d")).scalar()
        df = pd.DataFrame(rows, columns=["ticker", "timestamp", "close", "volume"])
        if df.empty:
            return {"rows": 0, "missing": _sample(deep_tickers)}
        close = df.pivot_table(index="timestamp", columns="ticker", values="close", aggfunc="last")
        volume = df.pivot_table(index="timestamp", columns="ticker", values="volume", aggfunc="last")
        dup = df.duplicated(["ticker", "timestamp"]).sum()
        q = quality.check_prices(close, volume)
        if dup:
            q["checks"]["duplicates"]["count"] += int(dup)
            q["checks"]["duplicates"]["failed"].append({"symbol": None, "date": None, "detail": f"{int(dup)} repeated (ticker, date) bars"})
        remember(q)
        return {"rows": int(total or 0), "series": int(close.shape[1]), "as_of": f"{close.index.max():%Y-%m-%d}",
                "last_success": None, "missing": _sample(set(deep_tickers) - set(close.columns)), **_quality(q),
                "file": "database table price_bars (1d)"}

    def fred():
        with session_scope(engine) as s:
            series = s.execute(select(MacroSeries.series_id, MacroSeries.last_updated)).all()
            obs = s.execute(select(MacroObservation.series_id, MacroObservation.date)).all()
        if not obs:
            return {"rows": 0}
        df = pd.DataFrame(obs, columns=["series_id", "date"])
        stale = []
        for sid, g in df.groupby("series_id"):
            d = pd.DatetimeIndex(sorted(g.date))
            spacing = (d[-10:].to_series().diff().dt.days.median() if len(d) > 2 else 1) or 1
            allowed = 5 if spacing <= 3 else 12 if spacing <= 8 else 50 if spacing <= 32 else 140
            lag = int(np.busday_count(d[-1].date(), b.today))
            if lag > allowed:
                stale.append({"symbol": sid, "date": f"{d[-1]:%Y-%m-%d}", "detail": f"{lag} weekdays old; expected within {allowed}"})
        last = max((u for _, u in series if u), default=None)
        return {"rows": int(len(df)), "series": int(df.series_id.nunique()), "as_of": f"{pd.Timestamp(last):%Y-%m-%d}" if last else None,
                "last_success": _iso(last), "data_through": f"{df.date.max():%Y-%m-%d}",
                "stale": {"count": len(stale), "sample": stale, "error": None}, "file": "database tables macro_series, macro_observations"}

    def french():
        with session_scope(engine) as s:
            n, last = s.execute(select(func.count(), func.max(FactorReturn.date))).one()
        return {"rows": int(n or 0), "as_of": f"{last:%Y-%m-%d}" if last else None, "last_success": None,
                "note": "The library publishes monthly, one to two months behind.", "file": "database table factor_returns"}

    def sec():
        with session_scope(engine) as s:
            n, last, filed = s.execute(select(func.count(), func.max(Fundamental.fetched_at), func.max(Fundamental.filing_date))).one()
            companies = {t for (t,) in s.execute(select(Company.ticker)).all()}
        us = [t for t in deep_tickers if "." not in t and not t.startswith("^") and not t.endswith("-USD")]
        return {"rows": int(n or 0), "as_of": f"{pd.Timestamp(last):%Y-%m-%d}" if last else None, "last_success": _iso(last),
                "latest_filing": f"{pd.Timestamp(filed):%Y-%m-%d}" if filed else None, "missing": _sample(set(us) - companies),
                "note": "New 10-K and 10-Q filings are stored when they appear, so quiet weeks are normal.",
                "file": "database tables companies, fundamentals"}

    def news():
        with session_scope(engine) as s:
            n, last, published = s.execute(select(func.count(), func.max(NewsArticle.fetched_at), func.max(NewsArticle.published_at))).one()
            week = s.execute(select(func.count()).where(NewsArticle.published_at >= pd.Timestamp(b.today) - pd.Timedelta(days=7))).scalar()
        return {"rows": int(n or 0), "last_7_days": int(week or 0), "as_of": f"{pd.Timestamp(last):%Y-%m-%d}" if last else None,
                "last_success": _iso(last), "latest_headline": _iso(published), "file": "database table news_articles"}

    def coins():
        with session_scope(engine) as s:
            n, last = s.execute(select(func.count(), func.max(Instrument.updated_at)).where(Instrument.asset_class == "crypto", Instrument.active.is_(True))).one()
        return {"rows": int(n or 0), "as_of": f"{pd.Timestamp(last):%Y-%m-%d}" if last else None, "last_success": _iso(last),
                "file": "database table universe_instruments (crypto)"}

    def quantum():
        path = data_dir / "quantum.json"
        if not path.exists():
            raise FileNotFoundError(2, "No such file", str(path))
        doc = json.loads(path.read_text(encoding="utf-8"))
        return {"rows": 1 + len((doc.get("options") or {}).get("items", [])), "as_of": (doc.get("generated_at") or "")[:10] or None,
                "last_success": doc.get("generated_at"), "prices_as_of": doc.get("prices_as_of"), "file": "data/quantum.json"}

    b.add("yahoo-prices", "Daily prices, global universe", "Yahoo Finance", 1, universe_prices, feeds="global")
    b.add("scores", "Scores and signals, global universe", "Calculated from Yahoo Finance data", 1, universe_scores, feeds="global")
    b.add("yahoo-fundamentals", "Company fundamentals, global universe", "Yahoo Finance quote summary", 1, universe_fundamentals, feeds="global")
    b.add("deep-prices", "Daily bars, deep tier", "Yahoo Finance", 1, deep_prices, feeds="deep,market,research")
    b.add("fred", "Economic indicators", "FRED (St. Louis Fed)", 1, fred, feeds="market")
    b.add("french", "Fama-French factors", "Kenneth R. French Data Library", 45, french, feeds="factors,research")
    b.add("sec", "Financial statements, deep tier", "SEC EDGAR", 10, sec, feeds="deep")
    b.add("news", "Headlines with FinBERT sentiment", "News RSS feeds", 1, news, feeds="deep,market")
    b.add("coingecko", "Coin list", "CoinGecko", 1, coins, calendar=True, feeds="global")
    b.add("quantum", "Quantum simulations", "Qiskit simulator (nightly job)", 1, quantum, feeds="quantum")
    b.flags = {s: sorted(c) for s, c in flags.items()}
    return b
