"""Daily financial news from free RSS feeds, cleaned with BeautifulSoup, and
mapped onto the intraday chart.

Feeds (no API keys):
  * Google News RSS search   - per ticker and market-wide (Google Finance's news
                               pane is powered by Google News; it has no RSS of its own)
  * Yahoo Finance RSS        - per ticker headlines
  * CNBC Top News RSS        - market-wide
  * MarketWatch Top Stories  - market-wide
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
import time
import warnings
from collections.abc import Iterable
from datetime import datetime, timedelta
from urllib.parse import quote_plus

import feedparser
import numpy as np
import pandas as pd
import requests
from bs4 import BeautifulSoup, MarkupResemblesLocatorWarning
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from quant.config import DEFAULT_ALIASES
from quant.db import session_scope, upsert
from quant.ingestion.market_data import load_bars
from quant.ingestion.relevance import (
    BOILERPLATE_RE,
    clean_company_name,
    RELEVANCE_THRESHOLD,
    build_aliases,
    is_research_firm,
    relevance_score,
)
from quant.models import Company, NewsArticle, utcnow

log = logging.getLogger(__name__)
warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)

GOOGLE_NEWS_URL = "https://news.google.com/rss/search?q={query}+when:{days}d&hl=en-US&gl=US&ceid=US:en"
TICKER_FEEDS = {
    "google_news": GOOGLE_NEWS_URL.replace("{query}", "{ticker}+stock"),
    "yahoo_finance": "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US",
}
MARKET_FEEDS = {
    "google_news": GOOGLE_NEWS_URL.replace("{query}", "stock+market"),
    "cnbc": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "marketwatch": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
}
FEED_PUBLISHERS = {"yahoo_finance": "Yahoo Finance", "cnbc": "CNBC", "marketwatch": "MarketWatch"}

_WS_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9 ]+")


def clean_html(text: str | None) -> str:
    """Strip tags/entities from an RSS field and collapse whitespace."""
    if not text:
        return ""
    if "<" in text or "&" in text:
        text = BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    return _WS_RE.sub(" ", html.unescape(text)).strip()


def article_key(ticker: str | None, title: str) -> str:
    normalized = _WS_RE.sub(" ", _NON_ALNUM_RE.sub(" ", title.lower())).strip()
    return hashlib.sha1(f"{ticker or 'MARKET'}|{normalized}".encode()).hexdigest()


def parse_feed(
    content: bytes | str,
    source: str,
    ticker: str | None,
    now: datetime,
    lookback: timedelta,
    max_items: int = 40,
) -> list[dict]:
    """Parse one RSS payload into NewsArticle rows (dicts)."""
    parsed = feedparser.parse(content)
    articles = []
    for entry in parsed.entries[:max_items]:
        title = clean_html(entry.get("title"))
        source_tag = entry.get("source") or {}
        publisher = source_tag.get("title") or FEED_PUBLISHERS.get(source)
        # Google News appends " - Publisher" to every headline.
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].rstrip()
        # Skip quote/forecast pages and 13F / ETF-flow notices: about a company, but not news.
        if not title or BOILERPLATE_RE.search(title):
            continue

        stamp = entry.get("published_parsed") or entry.get("updated_parsed")
        if not stamp:
            continue
        published = datetime(*stamp[:6])  # feedparser normalises to UTC
        if not (now - lookback <= published <= now + timedelta(hours=1)):
            continue

        summary = clean_html(entry.get("summary"))
        # Google's "summary" is just the headline again plus the publisher.
        if not summary or summary.startswith(title) or title.startswith(summary):
            summary = None

        articles.append(
            {
                "article_key": article_key(ticker, title),
                "ticker": ticker,
                "source": source,
                "publisher": publisher,
                "title": title,
                "summary": summary[:1000] if summary else None,
                "url": entry.get("link", ""),
                "published_at": published,
                "fetched_at": now,
            }
        )
    return articles


def fetch_feed(session: requests.Session, url: str, timeout: float) -> bytes | None:
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.content
    except requests.RequestException as exc:
        log.warning("feed %s failed: %s", url, exc)
        return None


def collect_news(
    session: requests.Session,
    tickers: list[str],
    lookback_days: int = 7,
    timeout: float = 20.0,
    include_market: bool = True,
    pause: float = 0.3,
) -> list[dict]:
    """Scrape ticker-specific and market-wide feeds; returns de-duplicated rows."""
    now = utcnow()
    lookback = timedelta(days=lookback_days)
    names = universe_names(tickers)
    jobs = []
    for t in tickers:
        for src, tmpl in TICKER_FEEDS.items():
            if src == "google_news" and t in names:
                # Non-US listings: search by company name ("Samsung Electronics"), not "005930.KS stock".
                query = quote_plus(f'"{clean_company_name(names[t]) or names[t]}"')
                url = GOOGLE_NEWS_URL.format(query=query, days=lookback_days)
            else:
                url = tmpl.format(ticker=quote_plus(t), days=lookback_days)
            jobs.append((src, url, t))
    if include_market:
        jobs += [(src, tmpl.format(days=lookback_days), None) for src, tmpl in MARKET_FEEDS.items()]

    by_key: dict[str, dict] = {}
    for source, url, ticker in jobs:
        content = fetch_feed(session, url, timeout)
        if content:
            for article in parse_feed(content, source, ticker, now, lookback):
                by_key.setdefault(article["article_key"], article)  # first feed wins
        time.sleep(pause)
    return list(by_key.values())


def store_articles(session: Session, articles: list[dict]) -> int:
    # Keep the first-seen copy (and any sentiment/chart mapping already computed).
    return upsert(session, NewsArticle, articles, ["article_key"], update_cols=["fetched_at"])


# --- Relevance -------------------------------------------------------------

def universe_names(tickers: Iterable[str]) -> dict[str, str]:
    """Company names from the global universe for non-US listings (SEC knows only US filers)."""
    wanted = [t for t in tickers if t and "." in t]
    if not wanted:
        return {}
    try:
        from quant.universe.models import Instrument

        with session_scope() as s:
            rows = s.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_(wanted))).all()
    except Exception:  # universe tables not created yet
        return {}
    return {sym: name for sym, name in rows if name}


def company_aliases(
    session: Session, tickers: Iterable[str], curated: dict[str, tuple[str, ...]] = DEFAULT_ALIASES
) -> dict[str, tuple[str, ...]]:
    """Headline aliases per ticker: curated names plus the cleaned SEC registrant name."""
    tickers = list(tickers)
    names = dict(session.execute(select(Company.ticker, Company.name).where(Company.ticker.in_(tickers))).all())
    names = {**universe_names(tickers), **{t: n for t, n in names.items() if n}}  # SEC name wins
    return {t: build_aliases(t, names.get(t), curated.get(t, ())) for t in tickers}


def research_firms(session: Session, tickers: Iterable[str]) -> set[str]:
    """Tickers of banks/brokers, whose names headlines often cite as the research source."""
    rows = session.execute(select(Company.ticker, Company.sic).where(Company.ticker.in_(list(tickers))))
    return {t for t, sic in rows if is_research_firm(sic)}


def score_relevance(
    session: Session,
    aliases: dict[str, tuple[str, ...]],
    firms: set[str] = frozenset(),
    rescore: bool = False,
) -> tuple[int, int]:
    """Score ticker-tagged headlines for company relevance. Returns (scored, relevant)."""
    stmt = select(NewsArticle.id, NewsArticle.ticker, NewsArticle.title, NewsArticle.summary).where(
        NewsArticle.ticker.in_(list(aliases))
    )
    if not rescore:
        stmt = stmt.where(NewsArticle.relevance.is_(None))
    updates = [
        {"id": r.id, "relevance": relevance_score(r.title, r.summary, r.ticker, aliases[r.ticker], r.ticker in firms)}
        for r in session.execute(stmt)
    ]
    if updates:
        session.execute(update(NewsArticle), updates)
    return len(updates), sum(u["relevance"] >= RELEVANCE_THRESHOLD for u in updates)


# --- Sentiment -------------------------------------------------------------

def article_text(title: str, summary: str | None) -> str:
    return f"{title}. {summary[:300]}" if summary else title


def score_unscored_articles(session: Session, scorer, batch_size: int = 64) -> int:
    """Run the sentiment model over every article that has no score yet."""
    pending = session.execute(
        select(NewsArticle.id, NewsArticle.title, NewsArticle.summary).where(NewsArticle.sentiment_score.is_(None))
    ).all()
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        results = scorer.score([article_text(r.title, r.summary) for r in batch])
        session.execute(
            update(NewsArticle),
            [
                {
                    "id": row.id,
                    "sentiment_label": res.label,
                    "sentiment_score": res.score,
                    "sentiment_confidence": res.confidence,
                    "sentiment_model": scorer.name,
                }
                for row, res in zip(batch, results)
            ],
        )
    return len(pending)


# --- Chart mapping ---------------------------------------------------------

def compute_price_reactions(
    published: list[datetime], bars: pd.DataFrame, bar_minutes: int, window_minutes: int
) -> list[tuple[datetime, float, float] | None]:
    """Align each publication time with the intraday chart.

    For every article returns ``(aligned_bar_start, price_before, reaction)``:
    the first bar still trading after publication (the next session's open for
    overnight news), the last close before publication, and the return from
    that close to the end of the reaction window. ``None`` when the needed bars
    are not available yet (e.g. the news is too fresh).
    """
    if bars.empty:
        return [None] * len(published)
    starts = bars.index.to_numpy(dtype="datetime64[us]")
    ends = starts + np.timedelta64(bar_minutes, "m")
    closes = bars["close"].to_numpy(dtype=float)
    n_bars = max(1, window_minutes // bar_minutes)

    out: list[tuple[datetime, float, float] | None] = []
    for pub in published:
        i = int(np.searchsorted(ends, np.datetime64(pub, "us"), side="right"))
        last = i + n_bars - 1
        if i == 0 or last >= len(starts):
            out.append(None)
            continue
        base = closes[i - 1]
        out.append((pd.Timestamp(starts[i]).to_pydatetime(), float(base), float(closes[last] / base - 1.0)))
    return out


def map_news_to_intraday(
    session: Session,
    ticker: str | None,
    interval: str,
    bar_minutes: int,
    window_minutes: int,
    bars_ticker: str | None = None,
) -> int:
    """Fill aligned_bar_ts / price_at_publish / reaction_return for a ticker's news.

    Market-wide news (``ticker=None``) is mapped against ``bars_ticker``, e.g. SPY.
    """
    ticker_filter = NewsArticle.ticker.is_(None) if ticker is None else NewsArticle.ticker == ticker
    pending = session.execute(
        select(NewsArticle.id, NewsArticle.published_at).where(ticker_filter, NewsArticle.reaction_return.is_(None))
    ).all()
    if not pending:
        return 0
    earliest = min(r.published_at for r in pending) - timedelta(days=5)
    bars = load_bars(session, bars_ticker or ticker, interval, start=earliest)
    reactions = compute_price_reactions([r.published_at for r in pending], bars, bar_minutes, window_minutes)

    updates = [
        {"id": row.id, "aligned_bar_ts": res[0], "price_at_publish": res[1], "reaction_return": res[2]}
        for row, res in zip(pending, reactions)
        if res is not None
    ]
    if updates:
        session.execute(update(NewsArticle), updates)
    return len(updates)
