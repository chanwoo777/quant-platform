"""Fama-French factor returns from Kenneth R. French's data library (free, public).

    https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html

Daily Mkt-RF, SMB, HML and RF come from the 3-factor file, MOM from the momentum
file. ``pandas-datareader``'s famafrench reader is tried first; if it fails the
zipped CSVs are downloaded and parsed directly. The library is rebuilt from CRSP
roughly monthly, so the latest factor date usually trails today by 1-2 months.
"""

from __future__ import annotations

import io
import logging
import zipfile
from datetime import date, timedelta

import numpy as np
import pandas as pd
import requests
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from quant.db import upsert
from quant.ingestion.http import TOOL_USER_AGENT, make_session
from quant.models import FactorReturn

log = logging.getLogger(__name__)

FRENCH_FTP = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/{name}_CSV.zip"
DATASETS = ("F-F_Research_Data_Factors_daily", "F-F_Momentum_Factor_daily")
COLUMNS = {"mkt-rf": "mkt_rf", "smb": "smb", "hml": "hml", "rf": "rf", "mom": "mom"}
REVISION_WINDOW = timedelta(days=60)


def parse_french_csv(text: str) -> pd.DataFrame:
    """First table of a French-library CSV, in decimals, indexed by date.

    The files open with free-text notes, then a header row starting with a comma
    (",Mkt-RF,SMB,HML,RF"), then YYYYMMDD rows; monthly files append further
    tables (e.g. annual) after a blank line. Missing values are coded -99.99.
    """
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(","))
    end = next((i for i in range(start + 1, len(lines)) if not lines[i].strip()), len(lines))
    table = pd.read_csv(io.StringIO("\n".join(lines[start:end])), index_col=0, skipinitialspace=True)
    table.index = pd.to_datetime(table.index.astype(str).str.strip(), format="%Y%m%d")
    table.columns = [COLUMNS.get(c.strip().lower(), c.strip().lower()) for c in table.columns]
    table = table.apply(pd.to_numeric, errors="coerce").replace([-99.99, -999.0], np.nan)
    return table / 100.0


def _via_datareader(name: str, start: date) -> pd.DataFrame:
    import pandas_datareader.data as web  # deferred: import itself may fail

    table = web.DataReader(name, "famafrench", start=start)[0]
    index = table.index
    table.index = index.to_timestamp() if isinstance(index, pd.PeriodIndex) else pd.DatetimeIndex(index)
    table.columns = [COLUMNS.get(c.strip().lower(), c.strip().lower()) for c in table.columns]
    return table.replace([-99.99, -999.0], np.nan) / 100.0


def _via_zip(name: str, start: date, session: requests.Session, timeout: float) -> pd.DataFrame:
    resp = session.get(FRENCH_FTP.format(name=name), timeout=timeout)
    resp.raise_for_status()
    archive = zipfile.ZipFile(io.BytesIO(resp.content))
    table = parse_french_csv(archive.read(archive.namelist()[0]).decode("latin-1"))
    return table[table.index >= pd.Timestamp(start)]


def fetch_factors(start: date, timeout: float = 30.0) -> tuple[pd.DataFrame, str]:
    """All daily factors since ``start``; returns (frame, backend used)."""
    session = make_session(TOOL_USER_AGENT)
    frames, backend = [], "pandas-datareader"
    for name in DATASETS:
        try:
            frames.append(_via_datareader(name, start))
        except Exception as exc:
            log.info("famafrench reader failed for %s (%s); downloading the CSV", name, exc)
            frames.append(_via_zip(name, start, session, timeout))
            backend = "French library CSV"
    return pd.concat(frames, axis=1, sort=True), backend


def update_factors(session: Session, default_start: date, timeout: float = 30.0) -> tuple[int, str]:
    last = session.scalar(select(func.max(FactorReturn.date)))
    start = max(default_start, last - REVISION_WINDOW) if last else default_start
    table, backend = fetch_factors(start, timeout)
    cols = [c for c in COLUMNS.values() if c in table]
    rows = [
        {"date": ts.date(), **{c: (None if pd.isna(row[c]) else float(row[c])) for c in cols}}
        for ts, row in table.iterrows()
    ]
    return upsert(session, FactorReturn, rows, ["date"]), backend


def load_factors(session: Session, start: date | None = None) -> pd.DataFrame:
    """Daily factor returns (decimals), indexed by date."""
    stmt = select(FactorReturn).order_by(FactorReturn.date)
    if start:
        stmt = stmt.where(FactorReturn.date >= start)
    cols = ["mkt_rf", "smb", "hml", "rf", "mom"]
    records = [{"date": f.date, **{c: getattr(f, c) for c in cols}} for f in session.scalars(stmt)]
    if not records:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], name="date"))
    frame = pd.DataFrame.from_records(records)
    frame.index = pd.DatetimeIndex(frame.pop("date"))
    return frame.astype(float)
