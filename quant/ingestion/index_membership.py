"""Point-in-time S&P 500 membership, reconstructed from free public Wikipedia tables.

Sources (fetched as HTML, cached for a day, parsed with ``pandas.read_html``):
  * "List of S&P 500 companies"             today's constituents and the date each joined
  * "Historical components of the S&P 500"  dated additions and removals since 1976
    (until August 2026 this was the "Selected changes" table of the first article)

Reconstruction walks the change log backwards from today's list. Undoing an
addition on date D means the stock was not a member before D; undoing a removal
means it was. Each stint in the index becomes one row (ticker, added, removed):
``added`` is inclusive, ``removed`` exclusive, and NULL means "before the change
log starts" or "still a member". Changes take effect before the open of their
effective date, so a stock removed on D is not a member on session D.

Tickers are stored in Yahoo's format (BRK.B -> BRK-B) and under the symbol the
company trades as *today*, because Yahoo files a renamed company's whole price
history under its current symbol (Facebook's 2016 prices live under META).
Renames are date-aware: "Q" before 15 Nov 2017 is QuintilesIMS (now IQV), while
"Q" today is Qnity Electronics. ``RENAMES`` lists the renames that matter for
the change log since 2010; rows that only record a symbol change are dropped.

Known gaps (see README): the change log is complete only from about 2010 (stated
counts stay within 503-508 names since 2014); Yahoo has no prices for most
acquired or bankrupt companies, so those member-days drop out of research.
"""

from __future__ import annotations

import io
import logging
import re
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pandas as pd
import requests
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from quant.models import IndexMember

log = logging.getLogger(__name__)

SP500 = "sp500"
CURRENT_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
CHANGES_URL = "https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500"
CACHE_MAX_AGE = 24 * 3600
# The change log is sparse before this year (a handful of "selected" changes a
# year), so membership earlier than this is not reliable.
RELIABLE_SINCE = date(2010, 1, 1)


@dataclass(frozen=True)
class Rename:
    old: str
    new: str
    effective: date  # first session under the new symbol
    since: date | None = None  # first use of ``old`` by this company, when the symbol was reused before


def _d(text: str) -> date:
    return date.fromisoformat(text)


# Symbol changes of S&P 500 companies whose old symbol appears in the change log
# since 2010. Chains are followed (CBS -> VIAC -> PARA -> PSKY -> SKYD).
RENAMES: tuple[Rename, ...] = (
    Rename("UA", "UAA", _d("2016-04-08")),  # class A took UAA when the class C shares got UA
    Rename("PCLN", "BKNG", _d("2018-02-27")),
    Rename("HCN", "WELL", _d("2018-02-28")),
    Rename("CBG", "CBRE", _d("2018-03-19")),
    Rename("LUK", "JEF", _d("2018-05-24")),
    Rename("WYN", "WYND", _d("2018-06-01")),
    Rename("DPS", "KDP", _d("2018-07-09")),
    Rename("KORS", "CPRI", _d("2019-01-02")),
    Rename("DWDP", "DD", _d("2019-06-03")),
    Rename("HRS", "LHX", _d("2019-07-01")),
    Rename("TMK", "GL", _d("2019-08-08")),
    Rename("SYMC", "NLOK", _d("2019-11-05")),
    Rename("HCP", "PEAK", _d("2019-11-05")),
    Rename("CBS", "VIAC", _d("2019-12-05")),
    Rename("BBT", "TFC", _d("2019-12-09")),
    Rename("JEC", "J", _d("2019-12-10")),
    Rename("ARNC", "HWM", _d("2020-04-01")),
    Rename("UTX", "RTX", _d("2020-04-03")),
    Rename("CTL", "LUMN", _d("2020-09-18")),
    Rename("WYND", "TNL", _d("2021-02-17")),
    Rename("LB", "BBWI", _d("2021-08-03")),
    Rename("COG", "CTRA", _d("2021-10-01")),
    Rename("WLTW", "WTW", _d("2022-01-10")),
    Rename("VIAC", "PARA", _d("2022-02-16")),
    Rename("HFC", "DINO", _d("2022-03-14")),
    Rename("ADS", "BFH", _d("2022-03-23")),
    Rename("DISCA", "WBD", _d("2022-04-11")),
    Rename("BLL", "BALL", _d("2022-05-04")),
    Rename("FB", "META", _d("2022-06-09")),
    Rename("ANTM", "ELV", _d("2022-06-28")),
    Rename("NLOK", "GEN", _d("2022-11-08")),
    Rename("FBHS", "FBIN", _d("2022-12-20")),  # renamed 15 Dec; the log still says FBHS on 19 Dec
    Rename("PKI", "RVTY", _d("2023-05-16")),
    Rename("RE", "EG", _d("2023-07-10")),
    Rename("ABC", "COR", _d("2023-08-30")),
    Rename("CDAY", "DAY", _d("2024-02-01")),
    Rename("PEAK", "DOC", _d("2024-03-04")),
    Rename("FLT", "CPAY", _d("2024-03-25")),
    Rename("GPS", "GAP", _d("2024-08-01")),  # after its Feb 2022 removal; exact date immaterial
    Rename("PARA", "PSKY", _d("2025-08-07")),
    Rename("SATS", "ECHO", _d("2026-06-24")),
    Rename("PSKY", "SKYD", _d("2026-10-06")),
    Rename("Q", "IQV", _d("2017-11-15"), since=_d("2016-10-03")),  # "Q" was Qwest until 2011
    Rename("TSO", "ANDV", _d("2017-08-01")),
)


# =============================================================================
# Parsing
# =============================================================================

def normalize_ticker(symbol) -> str | None:
    """Wikipedia / S&P symbol -> Yahoo symbol ("BRK.B" -> "BRK-B"); None for blanks."""
    if symbol is None or (isinstance(symbol, float) and pd.isna(symbol)):
        return None
    text = re.sub(r"\[.*?\]", "", str(symbol)).upper()  # drop footnote markers
    text = re.sub(r"[^A-Z0-9.\-]", "", text).strip(".-")  # stray wiki markup ("ALLE |"), spaces
    if not text or text == "NAN":
        return None
    return text.replace(".", "-")


def _parse_date(value) -> date | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = re.sub(r"\[.*?\]|\(.*?\)", "", str(value)).strip()
    ts = pd.to_datetime(text, errors="coerce", format="mixed")
    return None if pd.isna(ts) else ts.date()


def _flatten(columns) -> list[str]:
    out = []
    for col in columns:
        parts = col if isinstance(col, tuple) else (col,)
        seen = []
        for part in parts:
            part = str(part).strip()
            if part and part not in seen:
                seen.append(part)
        out.append(" ".join(seen).lower())
    return out


def parse_current(html: str) -> pd.DataFrame:
    """Today's constituents: ticker, name, date_added (None when unparseable)."""
    for table in pd.read_html(io.StringIO(html)):
        cols = _flatten(table.columns)
        if "symbol" in cols and "security" in cols:
            table.columns = cols
            out = pd.DataFrame({
                "ticker": table["symbol"].map(normalize_ticker),
                "name": table["security"].astype(str).str.strip(),
                "date_added": table["date added"].map(_parse_date) if "date added" in cols else None,
            })
            return out.dropna(subset=["ticker"]).drop_duplicates("ticker").reset_index(drop=True)
    raise ValueError("no constituents table (Symbol / Security columns) found")


def parse_changes(html: str) -> pd.DataFrame:
    """Dated changes: date, added, added_name, removed, removed_name, reason (newest first)."""
    for table in pd.read_html(io.StringIO(html)):
        cols = _flatten(table.columns)
        if any("added" in c and "ticker" in c for c in cols) and any("removed" in c and "ticker" in c for c in cols):
            table.columns = cols

            def col(*words):
                return next(c for c in cols if all(w in c for w in words))

            out = pd.DataFrame({
                "date": table[col("date")].map(_parse_date),
                "added": table[col("added", "ticker")].map(normalize_ticker),
                "added_name": table[col("added", "security")],
                "removed": table[col("removed", "ticker")].map(normalize_ticker),
                "removed_name": table[col("removed", "security")],
                "reason": table[col("reason")] if any("reason" in c for c in cols) else None,
            })
            out = out.dropna(subset=["date"])
            out = out[out.added.notna() | out.removed.notna()]
            return out.sort_values("date", ascending=False, kind="stable").reset_index(drop=True)
    raise ValueError("no changes table (Added / Removed ticker columns) found")


# =============================================================================
# Reconstruction
# =============================================================================

def resolve_symbol(ticker: str | None, when: date, renames: tuple[Rename, ...] = RENAMES) -> str | None:
    """The symbol a stock known as ``ticker`` on ``when`` trades under today."""
    if ticker is None:
        return None
    by_old = {}
    for r in renames:
        by_old.setdefault(r.old, []).append(r)
    seen = set()
    while ticker in by_old and ticker not in seen:
        seen.add(ticker)
        later = sorted((r for r in by_old[ticker] if when < r.effective and (r.since is None or when >= r.since)),
                       key=lambda r: r.effective)
        if not later:
            break
        ticker, when = later[0].new, later[0].effective
    return ticker


def apply_renames(changes: pd.DataFrame, renames: tuple[Rename, ...] = RENAMES) -> pd.DataFrame:
    """Drop rows that only record a symbol change and put every other ticker on its
    current symbol, as of the row's date."""
    pairs = {(r.old, r.new) for r in renames}
    rows = []
    for r in changes.itertuples(index=False):
        if (r.removed, r.added) in pairs:
            continue  # e.g. "WTW added, WLTW removed": the same company changed symbol
        rows.append({**r._asdict(), "added": resolve_symbol(r.added, r.date, renames),
                     "removed": resolve_symbol(r.removed, r.date, renames)})
    out = pd.DataFrame(rows, columns=changes.columns).astype({"added": object, "removed": object})
    out[["added", "removed"]] = out[["added", "removed"]].where(out[["added", "removed"]].notna(), None)
    same = out.added.notna() & (out.added == out.removed)
    return out[~same].reset_index(drop=True)


@dataclass
class Reconstruction:
    intervals: pd.DataFrame  # ticker, name, added, removed
    issues: list[str]  # change-log rows that contradict the walk (missing changes or renames)


def reconstruct(current: pd.DataFrame, changes: pd.DataFrame, renames: tuple[Rename, ...] = RENAMES) -> Reconstruction:
    """Membership stints from today's list and the change log (see module docstring)."""
    changes = apply_renames(changes, renames)
    # Open stints, walking back in time: ticker -> (removed date or None, name)
    open_: dict[str, tuple[date | None, str | None]] = {r.ticker: (None, r.name) for r in current.itertuples()}
    date_added = dict(zip(current.ticker, current.date_added))
    closed: list[dict] = []
    issues: list[str] = []

    for d, grp in changes.groupby("date", sort=False):  # newest first (parse_changes order)
        for r in grp.itertuples(index=False):
            if r.added is not None:
                if r.added in open_:
                    removed, name = open_.pop(r.added)
                    closed.append({"ticker": r.added, "name": name, "added": d, "removed": removed})
                else:
                    issues.append(f"{d} {r.added} added but not a member afterwards ({r.added_name})")
            if r.removed is not None:
                if r.removed in open_:
                    issues.append(f"{d} {r.removed} removed but already a member before ({r.removed_name})")
                else:
                    name = r.removed_name if isinstance(r.removed_name, str) else None
                    open_[r.removed] = (d, name)

    for ticker, (removed, name) in open_.items():
        # Still-open stints began before the log; today's list may know when.
        start = date_added.get(ticker) if removed is None else None
        closed.append({"ticker": ticker, "name": name, "added": start, "removed": removed})

    intervals = _merge_stints(pd.DataFrame(closed, columns=["ticker", "name", "added", "removed"]))
    return Reconstruction(intervals, issues)


def _merge_stints(df: pd.DataFrame) -> pd.DataFrame:
    """Join stints of the same ticker that touch or overlap (e.g. after resolving renames)."""
    lo, hi = pd.Timestamp.min.date(), pd.Timestamp.max.date()
    rows = []
    for ticker, grp in df.groupby("ticker", sort=True):
        spans = sorted(((a or lo, b or hi, n) for a, b, n in zip(grp.added, grp.removed, grp.name)), key=lambda x: x[0])
        cur = [ticker, *spans[0]]
        for a, b, n in spans[1:]:
            if a <= cur[2]:
                cur[2] = max(cur[2], b)
            else:
                rows.append(cur)
                cur = [ticker, a, b, n]
        rows.append(cur)
    out = pd.DataFrame(rows, columns=["ticker", "added", "removed", "name"])
    out["added"] = out["added"].map(lambda x: None if x == lo else x)
    out["removed"] = out["removed"].map(lambda x: None if x == hi else x)
    return out[["ticker", "name", "added", "removed"]].sort_values(["ticker", "added"], na_position="first").reset_index(drop=True)


# =============================================================================
# Queries on the intervals
# =============================================================================

def _bounds(intervals: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    added = pd.to_datetime(intervals["added"]).fillna(pd.Timestamp.min)
    removed = pd.to_datetime(intervals["removed"]).fillna(pd.Timestamp.max)
    return added, removed


def members_on(intervals: pd.DataFrame, when) -> list[str]:
    """Index members on session ``when`` (added <= when < removed)."""
    when = pd.Timestamp(when)
    added, removed = _bounds(intervals)
    return sorted(set(intervals.loc[(added <= when) & (when < removed), "ticker"]))


def universe_tickers(intervals: pd.DataFrame, since=None) -> list[str]:
    """Every ticker that was a member on or after ``since`` (all of them when None)."""
    if since is None:
        return sorted(set(intervals["ticker"]))
    _, removed = _bounds(intervals)
    return sorted(set(intervals.loc[removed > pd.Timestamp(since), "ticker"]))


def membership_mask(intervals: pd.DataFrame, dates: pd.DatetimeIndex, tickers: list[str]) -> pd.DataFrame:
    """Boolean frame (dates x tickers): True where the ticker was a member that session."""
    mask = pd.DataFrame(False, index=dates, columns=list(tickers))
    added, removed = _bounds(intervals)
    values = dates.values
    for ticker, a, b in zip(intervals["ticker"], added, removed):
        if ticker in mask.columns:
            mask[ticker] |= (values >= a.to_datetime64()) & (values < b.to_datetime64())
    return mask


def member_counts(intervals: pd.DataFrame, dates: pd.DatetimeIndex) -> pd.Series:
    tickers = sorted(set(intervals["ticker"]))
    return membership_mask(intervals, dates, tickers).sum(axis=1)


# =============================================================================
# Fetch, store, load
# =============================================================================

def _cached_get(http: requests.Session, url: str, cache: Path, timeout: float) -> str:
    if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_MAX_AGE:
        return cache.read_text(encoding="utf-8")
    resp = http.get(url, timeout=timeout)
    resp.raise_for_status()
    cache.write_text(resp.text, encoding="utf-8")
    return resp.text


def fetch_sp500(http: requests.Session, cache_dir: Path, timeout: float = 20.0) -> tuple[pd.DataFrame, pd.DataFrame]:
    current = parse_current(_cached_get(http, CURRENT_URL, cache_dir / "sp500_current.html", timeout))
    changes = parse_changes(_cached_get(http, CHANGES_URL, cache_dir / "sp500_changes.html", timeout))
    return current, changes


def store_membership(session: Session, intervals: pd.DataFrame, index_name: str = SP500) -> int:
    """Replace the stored membership of ``index_name`` (it is fully derived from the sources)."""
    session.execute(delete(IndexMember).where(IndexMember.index_name == index_name))
    rows = [IndexMember(index_name=index_name, ticker=r.ticker, name=r.name if isinstance(r.name, str) else None,
                        added=r.added, removed=r.removed)
            for r in intervals.itertuples(index=False)]
    session.add_all(rows)
    return len(rows)


def load_membership(session: Session, index_name: str = SP500) -> pd.DataFrame:
    rows = session.execute(
        select(IndexMember.ticker, IndexMember.name, IndexMember.added, IndexMember.removed)
        .where(IndexMember.index_name == index_name)
    ).all()
    return pd.DataFrame(rows, columns=["ticker", "name", "added", "removed"])


def update_membership(session: Session, http: requests.Session, cache_dir: Path, timeout: float = 20.0,
                      since: date = RELIABLE_SINCE) -> tuple[int, str, list[str]]:
    """Fetch both Wikipedia tables, rebuild the membership table. Returns (rows, summary, issues since ``since``)."""
    current, changes = fetch_sp500(http, cache_dir, timeout)
    rec = reconstruct(current, changes)
    n = store_membership(session, rec.intervals)
    recent = [i for i in rec.issues if date.fromisoformat(i[:10]) >= since]
    for issue in recent:
        log.warning("S&P 500 change log: %s", issue)
    counts = member_counts(rec.intervals, pd.bdate_range(since, date.today(), freq="BME"))
    summary = (f"{len(current)} members today, {n} stints of {rec.intervals.ticker.nunique()} tickers; "
               f"{counts.min()}-{counts.max()} members per month-end since {since.year}; "
               f"{len(recent)} unresolved log conflicts since {since.year}")
    return n, summary, recent
