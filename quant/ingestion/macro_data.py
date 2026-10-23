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


class FredClient:
    def __init__(self, timeout: float = 20.0):
        self.timeout = timeout
        self.session = make_session(TOOL_USER_AGENT)
        self._datareader_ok: bool | None = None  # unknown until first attempt

    @property
    def backend(self) -> str:
        return {True: "pandas-datareader", False: "FRED CSV endpoint", None: "n/a"}[self._datareader_ok]

    def fetch(self, series_id: str, start: date) -> pd.Series:
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
