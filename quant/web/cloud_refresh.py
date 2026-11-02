"""Refresh the published site's headlines and deep-tier prices without the local database.

    python -m quant.web.cloud_refresh --site <checkout of the gh-pages branch>

GitHub Actions runs this every 3 hours (.github/workflows/refresh.yml), so the site keeps updating while the
laptop that runs the nightly cycle is off. It starts from the files already published and patches them:

  deep/<T>.json   snapshot (close, moving averages, RSI, readings), headlines and news markers
  market.json     watchlist movers and headlines
  meta.json       generated_at (browsers refetch the data), prices_as_of, latest_headline_et
  status.json     the news and deep-tier price sources' dates

Everything else (the screener, fundamentals, factors, research, quantum, the track record) stays as the
nightly cycle published it. Each source has a second way in: daily bars from CNBC when Yahoo fails
(market_data.update_daily), Bing News when the RSS feeds come back empty (news_scraper.collect_news), and the
lexicon scorer when FinBERT can't load (sentiment.get_scorer). A source that fails entirely leaves its part of
the site as it was; a run where both fail exits non-zero so the workflow shows red.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import re
import tempfile
from pathlib import Path

import pandas as pd

from quant.web.export import _news_markers, _tone, sig, write

log = logging.getLogger("quant.web.refresh")

ET = "America/New_York"
SESSION_SETTLED = dt.time(17, 0)  # ET: before this on a weekday, today's daily bar may still be moving
DEEP_NEWS, MARKET_NEWS = 150, 120  # as many headlines as export_deep and export_market publish
_KEY_RE = re.compile(r"[^a-z0-9]+")


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def to_et(utc_naive: pd.Series) -> pd.Series:
    return pd.to_datetime(utc_naive).dt.tz_localize("UTC").dt.tz_convert(ET).dt.tz_localize(None)


def title_key(title: str | None) -> str:
    return _KEY_RE.sub(" ", (title or "").lower()).strip()


def settled(bars: pd.DataFrame, now: pd.Timestamp | None = None) -> pd.DataFrame:
    """Drop today's bar while the US session may still be trading: the site shows closes, not live quotes."""
    now = now or pd.Timestamp.now(tz=ET)
    if bars.empty or now.weekday() >= 5 or now.time() >= SESSION_SETTLED:
        return bars
    return bars[bars.index.normalize() < pd.Timestamp(now.date())]


# --- prices -------------------------------------------------------------------------------------

def fetch_prices(engine, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """Two years of daily bars per ticker with indicators, Yahoo first and CNBC when Yahoo fails."""
    from quant import analytics as an
    from quant.db import session_scope
    from quant.ingestion import market_data

    out = {}
    for t in tickers:
        try:
            with session_scope(engine) as s:
                market_data.update_daily(s, t, history_period="2y")
                bars = settled(market_data.load_bars(s, t, "1d"))
            if len(bars) < 30:
                raise RuntimeError(f"only {len(bars)} daily bars")
            out[t] = an.add_indicators(bars)
        except Exception as exc:
            log.warning("%s: prices not refreshed (%s: %s)", t, type(exc).__name__, exc)
    return out


def mover(ticker: str, b: pd.DataFrame, score) -> dict:
    """One row of market.json's movers, as export_market computes it."""
    px = b.adj_close.dropna()
    ytd = px.loc[str(px.index[-1].year)]
    return {"ticker": ticker, "close": b.close.iloc[-1], "r1d": px.iloc[-1] / px.iloc[-2] - 1,
            "r1m": px.iloc[-1] / px.iloc[-22] - 1, "ytd": px.iloc[-1] / ytd.iloc[0] - 1,
            "golden": bool(b.sma_50.iloc[-1] > b.sma_200.iloc[-1]), "rsi": b.rsi_14.iloc[-1], "score": score}


def snapshot(b: pd.DataFrame) -> dict:
    from quant import analytics as an

    snap = an.indicator_snapshot(b)
    return {k: snap.get(k) for k in ("date", "close", "sma_50", "sma_200", "rsi_14", "readings")}


# --- news ---------------------------------------------------------------------------------------

def fetch_news(engine, deep: list[dict]) -> pd.DataFrame:
    """Fresh headlines for the deep tier and the market, filtered for relevance and scored for sentiment.
    Columns as dashboard.common.headlines returns them (published_et in US/Eastern)."""
    from sqlalchemy import select

    from quant.config import DEFAULT_ALIASES, get_settings
    from quant.db import session_scope
    from quant.ingestion import news_scraper
    from quant.ingestion.http import BROWSER_USER_AGENT, make_session
    from quant.ingestion.relevance import RELEVANCE_THRESHOLD, build_aliases, is_research_firm
    from quant.ingestion.sentiment import get_scorer
    from quant.models import NewsArticle

    settings = get_settings()
    tickers = [d["ticker"] for d in deep]
    articles = news_scraper.collect_news(make_session(BROWSER_USER_AGENT), tickers, settings.news_lookback_days,
                                         settings.http_timeout)
    aliases = {d["ticker"]: build_aliases(d["ticker"], d.get("name"), DEFAULT_ALIASES.get(d["ticker"], ())) for d in deep}
    firms = {d["ticker"] for d in deep if is_research_firm(d.get("sic_code"))}
    scorer = get_scorer(settings.sentiment_model, settings.use_finbert)
    with session_scope(engine) as s:
        news_scraper.store_articles(s, articles)
        news_scraper.score_relevance(s, aliases, firms)
        news_scraper.score_unscored_articles(s, scorer)
        rows = s.execute(select(NewsArticle.ticker, NewsArticle.title, NewsArticle.publisher, NewsArticle.url,
                                NewsArticle.published_at, NewsArticle.sentiment_score, NewsArticle.relevance)
                         .order_by(NewsArticle.published_at.desc())).all()
    df = pd.DataFrame(rows, columns=["ticker", "title", "publisher", "url", "published_at", "sentiment_score", "relevance"])
    df = df[df.ticker.isna() | (df.relevance.fillna(0) >= RELEVANCE_THRESHOLD)].copy()
    df["published_et"] = to_et(df.published_at)
    log.info("news: %d headlines collected, %d kept after the relevance filter (sentiment: %s)",
             len(articles), len(df), scorer.name)
    return df


def merge_news(old: list[dict], new: list[dict], limit: int, ticker_key: bool = False) -> list[dict]:
    """Newest first, one copy per headline; an already-published copy wins (it keeps its price reaction)."""
    def key(r):
        return (r.get("ticker") if ticker_key else None, title_key(r["title"]))

    items = {key(r): r for r in new}
    items.update({key(r): r for r in old})
    return sorted((r for k, r in items.items() if k[1]), key=lambda r: r["t"], reverse=True)[:limit]


def news_item(r, with_ticker: bool = False) -> dict:
    """A headline as export_deep (with "react") or export_market (with "ticker") publishes it."""
    item = {"t": f"{r.published_et:%Y-%m-%d %H:%M}"}
    if with_ticker:
        item["ticker"] = r.ticker if isinstance(r.ticker, str) else None
    item |= {"title": r.title, "src": r.publisher, "score": sig(r.sentiment_score, 3), "tone": _tone(r.sentiment_score)}
    return item | ({"url": r.url} if with_ticker else {"react": None, "url": r.url})


def merge_markers(old: list[dict], daily: pd.DataFrame | None, news: list[dict]) -> list[dict]:
    """Recompute the chart's news markers from the published headlines. The oldest session they reach may be
    cut off by the 150-headline limit, so it and everything before keep the nightly cycle's markers."""
    if daily is None or not news:
        return old
    df = pd.DataFrame([{"published_et": pd.Timestamp(r["t"]), "title": r["title"], "sentiment_score": r["score"]}
                       for r in news]).astype({"sentiment_score": float})
    fresh = _news_markers(daily, df)
    if len(fresh) < 2:
        return old
    cut = fresh[0]["d"]
    return [m for m in old if m["d"] <= cut] + [m for m in fresh if m["d"] > cut]


# --- the run ------------------------------------------------------------------------------------

def refresh(site: Path, now: dt.datetime | None = None) -> dict:
    from quant.db import init_db, make_engine

    data = site / "data"
    meta = read(data / "meta.json")
    market = read(data / "market.json")
    status = read(data / "status.json")
    tickers = [d["ticker"] for d in meta["deep"]]
    docs = {t: read(data / "deep" / f"{t.replace('^', '_')}.json") for t in tickers}
    deep = [{"ticker": t, "name": docs[t].get("name"), "sic_code": docs[t].get("sic_code")} for t in tickers]
    now = now or dt.datetime.now(dt.timezone.utc)

    with tempfile.TemporaryDirectory() as tmp:
        engine = init_db(make_engine(f"sqlite:///{(Path(tmp) / 'refresh.db').as_posix()}"))
        bars = fetch_prices(engine, tickers)
        try:
            news = fetch_news(engine, deep)
        except Exception:
            log.exception("news not refreshed")
            news = None
        engine.dispose()
    if not bars and news is None:  # leave the published files exactly as they were
        raise RuntimeError("neither prices nor headlines could be refreshed")

    # deep/<T>.json
    for t, doc in docs.items():
        if t in bars:
            doc["snapshot"] = snapshot(bars[t])
        if news is not None:
            fresh = [news_item(r) for r in news[news.ticker == t].itertuples(index=False)]
            doc["news"] = merge_news(doc.get("news") or [], fresh, DEEP_NEWS)
            doc["markers"] = merge_markers(doc.get("markers") or [], bars.get(t), doc["news"])
        write(data / "deep" / f"{t.replace('^', '_')}.json", doc)

    # market.json
    scores = {m["ticker"]: m.get("score") for m in market.get("movers", [])}
    market["movers"] = [mover(t, bars[t], scores.get(t)) if t in bars else next(
        (m for m in market.get("movers", []) if m["ticker"] == t), None) for t in tickers]
    market["movers"] = [m for m in market["movers"] if m]
    if news is not None:
        fresh = [news_item(r, with_ticker=True) for r in news.drop_duplicates("title").itertuples(index=False)]
        market["news"] = merge_news(market.get("news") or [], fresh, MARKET_NEWS, ticker_key=True)
    write(data / "market.json", market)

    # meta.json and status.json
    stamp = now.isoformat(timespec="seconds")
    latest_bar = max((b.index[-1] for b in bars.values()), default=None)
    if latest_bar is not None and f"{latest_bar:%Y-%m-%d}" > (meta.get("prices_as_of") or ""):
        meta["prices_as_of"] = f"{latest_bar:%Y-%m-%d}"
    headlines = [r["t"] for r in market.get("news", [])] + [r["t"] for d in docs.values() for r in d.get("news", [])[:1]]
    if headlines:
        meta["latest_headline_et"] = max(headlines)
    meta["generated_at"] = stamp
    write(data / "meta.json", meta)

    for src in status.get("sources", []):
        if src["id"] == "news" and news is not None and len(news):
            latest = news.published_at.max()
            src.update(last_success=stamp, as_of=f"{now:%Y-%m-%d}", age=0,
                       latest_headline=f"{pd.Timestamp(latest):%Y-%m-%dT%H:%M:%S}+00:00")
        if src["id"] == "deep-prices" and len(bars) == len(tickers):
            src.update(last_success=stamp, as_of=meta["prices_as_of"])
    write(data / "status.json", status)

    result = {"prices": f"{len(bars)}/{len(tickers)} tickers", "prices_as_of": meta["prices_as_of"],
              "headlines": None if news is None else int(len(news)), "generated_at": stamp}
    log.info("refresh done: %s", result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh the published site's headlines and deep-tier prices.")
    parser.add_argument("--site", type=Path, required=True, help="checkout of the published site (gh-pages)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("yfinance", "urllib3", "peewee", "httpx", "transformers"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    try:
        print(json.dumps(refresh(args.site)))
    except Exception:
        log.exception("refresh failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
