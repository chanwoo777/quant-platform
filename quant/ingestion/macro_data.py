"""Macroeconomic series from FRED (Federal Reserve Bank of St. Louis).

``pandas-datareader`` is tried first, as the classic interface. It has not been
released since 2021 and fails to import on Python 3.12+ / pandas 3, so the
module transparently falls back to FRED's public ``fredgraph.csv`` endpoint -
the same URL pandas-datareader calls internally. Neither path needs an API key.
"""

from __future__ import annotations

import io
import logging
from datetime import date, timedelta

import pandas as pd
import requests
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from quant.db import upsert
from quant.ingestion.http import TOOL_USER_AGENT, make_session
from quant.models import MacroObservation, MacroSeries, utcnow

log = logging.getLogger(__name__)

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
# Re-pull this much history on each run so revised prints (CPI, payrolls) get updated.
REVISION_WINDOW = timedelta(days=120)


def parse_fred_csv(text: str, series_id: str) -> pd.Series:
    """Parse fredgraph.csv output; FRED marks missing values with '.'."""
    df = pd.read_csv(io.StringIO(text), na_values=["."])
    if df.shape[1] < 2 or df.columns[0].lower() not in {"date", "observation_date"}:
        raise ValueError(f"unexpected FRED response for {series_id}: {text[:120]!r}")
    values = pd.to_numeric(df.iloc[:, 1], errors="coerce")
    series = pd.Series(values.to_numpy(), index=pd.to_datetime(df.iloc[:, 0]), name=series_id)
    return series.dropna()


def _fetch_via_datareader(series_id: str, start: date) -> pd.Series:
    import pandas_datareader.data as web  # deferred: import itself may fail

    frame = web.DataReader(series_id, "fred", start=start)
    return frame[series_id].dropna()


def _fetch_via_csv(series_id: str, start: date, session: requests.Session, timeout: float) -> pd.Series:
    resp = session.get(FRED_CSV_URL, params={"id": series_id, "cosd": start.isoformat()}, timeout=timeout)
    resp.raise_for_status()
    series = parse_fred_csv(resp.text, series_id)
    return series[series.index >= pd.Timestamp(start)]


# --- when FRED itself is down: the same numbers from their original publishers (no keys) -------------------
TREASURY_CSV_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
                    "{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
TREASURY_COLUMNS = {"DGS3MO": "3 Mo", "DGS2": "2 Yr", "DGS10": "10 Yr"}
NYFED_EFFR_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
ALTERNATIVES = {"DGS3MO": "U.S. Treasury", "DGS2": "U.S. Treasury", "DGS10": "U.S. Treasury", "T10Y2Y": "U.S. Treasury",
                "DFF": "New York Fed", "VIXCLS": "CBOE via CNBC"}
FRED_TRIP = 2  # consecutive connection failures after which FRED counts as down for the rest of the run


def parse_treasury_csv(text: str) -> pd.DataFrame:
    """Treasury's daily par yield curve CSV -> frame indexed by date, one column per maturity (percent)."""
    frame = pd.read_csv(io.StringIO(text))
    frame["Date"] = pd.to_datetime(frame["Date"], format="%m/%d/%Y")
    return frame.set_index("Date").sort_index()


def parse_nyfed_effr(doc: dict) -> pd.Series:
    rows = {pd.Timestamp(r["effectiveDate"]): float(r["percentRate"]) for r in (doc or {}).get("refRates", [])
            if r.get("type") == "EFFR" and r.get("percentRate") is not None}
    return pd.Series(rows, dtype=float).sort_index()


class FredClient:
    def __init__(self, timeout: float = 20.0):
        self.timeout = timeout
        self.session = make_session(TOOL_USER_AGENT)
        self._datareader_ok: bool | None = None  # unknown until first attempt
        self._fred_fails = 0
        self._treasury: dict[int, pd.DataFrame] = {}
        self.fallbacks: dict[str, str] = {}  # series -> publisher used instead of FRED in this run

    @property
    def backend(self) -> str:
        name = {True: "pandas-datareader", False: "FRED CSV endpoint", None: "n/a"}[self._datareader_ok]
        if self.fallbacks:
            used = sorted(set(self.fallbacks.values()))
            name += f" ({len(self.fallbacks)} from {', '.join(used)} while FRED was unavailable)"
        return name

    @property
    def fred_down(self) -> bool:
        return self._fred_fails >= FRED_TRIP

    def _from_fred(self, series_id: str, start: date) -> pd.Series:
        if self._datareader_ok is not False:
            try:
                series = _fetch_via_datareader(series_id, start)
                self._datareader_ok = True
                return series
            except Exception as exc:
                if self._datareader_ok is None:
                    log.info("pandas-datareader unavailable (%s: %s); using FRED CSV endpoint",
                             type(exc).__name__, exc)
                self._datareader_ok = False
        return _fetch_via_csv(series_id, start, self.session, self.timeout)

    def _treasury_year(self, year: int) -> pd.DataFrame:
        if year not in self._treasury:
            resp = self.session.get(TREASURY_CSV_URL.format(year=year), timeout=max(self.timeout, 60))
            resp.raise_for_status()
            self._treasury[year] = parse_treasury_csv(resp.text)
        return self._treasury[year]

    def _from_alternative(self, series_id: str, start: date) -> pd.Series:
        if series_id in TREASURY_COLUMNS or series_id == "T10Y2Y":
            years = range(start.year, date.today().year + 1)
            curve = pd.concat([self._treasury_year(y) for y in years]).sort_index()
            curve = curve[curve.index >= pd.Timestamp(start)]
            if series_id == "T10Y2Y":
                return (curve["10 Yr"] - curve["2 Yr"]).dropna().round(2)
            return curve[TREASURY_COLUMNS[series_id]].dropna()
        if series_id == "DFF":
            resp = self.session.get(NYFED_EFFR_URL, params={"startDate": start.isoformat(), "endDate": date.today().isoformat()},
                                    timeout=self.timeout)
            resp.raise_for_status()
            return parse_nyfed_effr(resp.json())
        if series_id == "VIXCLS":
            from quant.ingestion.market_data import fetch_cnbc_daily

            bars = fetch_cnbc_daily("^VIX", timeout=self.timeout)
            series = bars.set_index("timestamp")["close"]
            return series[series.index >= pd.Timestamp(start)]
        raise LookupError(f"no source other than FRED for {series_id}")

    def fetch(self, series_id: str, start: date) -> pd.Series:
        """FRED first; if FRED fails (or failed twice in a row already), the original publisher where there is one:
        Treasury yields from the U.S. Treasury, the fed funds rate from the New York Fed, the VIX from CNBC.
        Series without another free source (CPI, payrolls, claims, spreads) keep their stored values until FRED is back."""
        problem = None
        if not self.fred_down:
            try:
                series = self._from_fred(series_id, start)
                self._fred_fails = 0
                return series
            except requests.RequestException as exc:
                self._fred_fails += 1
                problem = exc
                if self.fred_down:
                    log.warning("FRED failed %d times in a row; using other publishers where possible for the rest of this run", FRED_TRIP)
            except Exception as exc:
                problem = exc
        if series_id in ALTERNATIVES:
            series = self._from_alternative(series_id, start)
            if not series.empty:
                self.fallbacks[series_id] = ALTERNATIVES[series_id]
                log.info("FRED %s: %d observations from %s instead", series_id, len(series), ALTERNATIVES[series_id])
                return series
        raise problem or RuntimeError(f"FRED is unavailable and {series_id} has no other free source")


def _last_observation(session: Session, series_id: str) -> date | None:
    return session.scalar(select(func.max(MacroObservation.date)).where(MacroObservation.series_id == series_id))


def update_series(
    session: Session, client: FredClient, series_id: str, title: str, category: str, default_start: date
) -> int:
    last = _last_observation(session, series_id)
    start = max(default_start, last - REVISION_WINDOW) if last else default_start
    series = client.fetch(series_id, start)

    upsert(
        session,
        MacroSeries,
        [{"series_id": series_id, "title": title, "category": category, "last_updated": utcnow()}],
        ["series_id"],
    )
    rows = [
        {"series_id": series_id, "date": ts.date(), "value": float(val)}
        for ts, val in series.items()
    ]
    return upsert(session, MacroObservation, rows, ["series_id", "date"])


def load_macro(session: Session, series_ids: list[str] | None = None, start: date | None = None) -> pd.DataFrame:
    """Wide frame: one column per series, indexed by date (mixed frequencies -> NaNs)."""
    stmt = select(MacroObservation.series_id, MacroObservation.date, MacroObservation.value)
    if series_ids:
        stmt = stmt.where(MacroObservation.series_id.in_(series_ids))
    if start:
        stmt = stmt.where(MacroObservation.date >= start)
    df = pd.DataFrame(session.execute(stmt).all(), columns=["series_id", "date", "value"])
    if df.empty:
        return df
    return df.pivot(index="date", columns="series_id", values="value").sort_index()
