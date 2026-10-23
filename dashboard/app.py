"""Free Quant Platform dashboard (Phase 5).

    streamlit run dashboard/app.py

Four pages share one cached, point-in-time view of the database that the
pipeline (Phase 1) and the bot (Phase 4) keep up to date.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st  # noqa: E402

st.set_page_config(page_title="Free Quant Platform", page_icon=":material/monitoring:", layout="wide")

PAGES = Path(__file__).parent / "pages"
nav = st.navigation(
    {
        "Markets": [
            st.Page(PAGES / "global_overview.py", title="Global Overview", icon=":material/travel_explore:",
                    default=True),
            st.Page(PAGES / "market_overview.py", title="Market Overview", icon=":material/public:"),
            st.Page(PAGES / "stock_deep_dive.py", title="Stock Deep Dive", icon=":material/candlestick_chart:"),
        ],
        "Research": [
            st.Page(PAGES / "financials_research.py", title="Financials & Research", icon=":material/science:"),
        ],
        "Trading": [
            st.Page(PAGES / "trading_bot.py", title="Live Trading Bot", icon=":material/smart_toy:"),
        ],
    }
)

from dashboard.common import sidebar  # noqa: E402

sidebar()
nav.run()
