"""Smoke test: every dashboard page renders without an exception against the local database.

Skipped when the database hasn't been filled by the pipeline yet. Slower than the
other tests (~30 s) because it loads the real market context.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "quant.db"
PAGES = ["global_overview", "market_overview", "stock_deep_dive", "financials_research", "trading_bot"]


def _has_data() -> bool:
    if not DB.exists():
        return False
    try:
        with sqlite3.connect(DB) as conn:
            return conn.execute("select count(*) from price_bars").fetchone()[0] > 0
    except sqlite3.Error:
        return False


@pytest.mark.skipif(not _has_data(), reason="run the ingestion pipeline first")
@pytest.mark.parametrize("page", PAGES)
def test_page_renders(page):
    from streamlit.testing.v1 import AppTest

    at = AppTest.from_file(str(ROOT / "dashboard" / "pages" / f"{page}.py"), default_timeout=180)
    at.run()
    assert not at.exception, [e.value for e in at.exception]
    assert at.title[0].value  # the page drew its heading
