"""Discover the global universe from free public sources.

  Stocks  Yahoo Finance screener, one query per market x sector (which also tags
          the sector), filtered to a USD market-cap floor converted to each
          market's currency. Cross-listings are de-duplicated by company name,
          keeping the most liquid listing.
  ETFs    Nasdaq Trader's symbol directory (every US-listed ETF/ETN); liquidity is
          filtered later from price history.
  Crypto  CoinGecko's /coins/markets (top N by market cap), minus stablecoins and
          wrapped / staked / bridged duplicates; prices come from Yahoo (SYM-USD).
"""

from __future__ import annotations

import io
import logging
import re
import time
from collections.abc import Iterable

import pandas as pd
import yfinance as yf
from yfinance import EquityQuery

from quant.ingestion.http import TOOL_USER_AGENT, make_session

log = logging.getLogger(__name__)

# Yahoo region -> (peer market used for ranking, main currency)
REGIONS: dict[str, tuple[str, str]] = {
    "us": ("US", "USD"), "ca": ("Canada", "CAD"),
    "gb": ("Europe", "GBP"), "de": ("Europe", "EUR"), "fr": ("Europe", "EUR"), "nl": ("Europe", "EUR"),
    "ch": ("Europe", "CHF"), "it": ("Europe", "EUR"), "es": ("Europe", "EUR"), "se": ("Europe", "SEK"),
    "dk": ("Europe", "DKK"), "fi": ("Europe", "EUR"), "no": ("Europe", "NOK"), "be": ("Europe", "EUR"),
    "jp": ("Japan", "JPY"), "kr": ("Korea", "KRW"), "cn": ("China/HK", "CNY"), "hk": ("China/HK", "HKD"),
    "tw": ("Taiwan", "TWD"), "in": ("India", "INR"), "au": ("Australia", "AUD"),
}
SECTORS = ("Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy",
           "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities")
# Secondary venues that only duplicate primary listings: US OTC, German regional
# exchanges, LSE's international order book, India's BSE (NSE is kept), Canadian ATSs.
SECONDARY_VENUES = {"PNK", "OQB", "OQX", "OEM", "OBB", "OTC", "FRA", "STU", "BER", "MUN", "DUS", "HAM", "HAN",
                    "IOB", "BSE", "NEO", "CNQ", "CXE", "AQS", "DXE", "TLO"}
# LSE international order book lines for foreign companies look like 0R2V.L (Apple).
FOREIGN_LINE = re.compile(r"^0[A-Z0-9]{3}\.L$")
# Quote currencies in minor units. Yahoo quotes these prices in minor units but
# market caps in the major currency (AstraZeneca: price in pence, cap in pounds).
MINOR_UNITS = {"GBp": ("GBP", 100.0), "GBX": ("GBP", 100.0), "ILA": ("ILS", 100.0), "ZAc": ("ZAR", 100.0)}

NASDAQ_DIR = "https://www.nasdaqtrader.com/dynamic/symdir/{name}"
COINGECKO_MARKETS = "https://api.coingecko.com/api/v3/coins/markets"
STABLECOINS = {"usdt", "usdc", "dai", "fdusd", "usde", "tusd", "pyusd", "usdd", "usds", "usd1", "rlusd", "gusd",
               "lusd", "frax", "usdp", "busd", "eurc", "eurs", "usdy", "usdtb", "susds", "susde", "bfusd", "usdf",
               "usdg", "usd0", "crvusd", "gho", "dola", "ousg", "buidl", "usdx", "usdb", "usyc", "syrupusdc"}
DERIVATIVE_WORDS = ("wrapped", "staked", "bridged", "binance-peg", "peg ", "liquid staking", "restaked")
# Tokenized funds, T-bills and private credit: securities on a blockchain, not crypto assets.
RWA_NAME = re.compile(r"\b(fund|treasury|t-bills?|money market|heloc|clo|reinsurance|warrants?|financing|lender|"
                      r"securities|bonds?|tradable|liquidstone)\b")
FIAT_CODE = re.compile(r"usd|^(eur|jpy|gbp|chf|krw|sgd|aud|cad|cny|try|brl|mxn|xsgd)|(eur|jpy|gbp|chf|krw|sgd)(c|t|s)?$")

_LEGAL = {"INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "AG", "SA", "NV",
          "SE", "ASA", "AB", "OYJ", "SPA", "HOLDINGS", "HOLDING", "GROUP", "THE", "ADR", "ADS", "CLASS", "A", "B",
          "C", "ORD", "SHS", "TBK", "BHD", "KK", "PCL", "NPV", "REIT"}


# --- FX -------------------------------------------------------------------------------

def usd_per_unit(currencies: Iterable[str]) -> dict[str, float]:
    """USD value of one unit of each quote currency (minor units such as GBp handled)."""
    majors = {MINOR_UNITS.get(c, (c, 1.0))[0] for c in currencies if c} - {"USD"}
    pairs = {c: f"{c}=X" for c in majors}  # Yahoo quotes "KRW=X" as KRW per 1 USD
    rates: dict[str, float] = {"USD": 1.0}
    if pairs:
        data = yf.download(list(pairs.values()), period="5d", interval="1d", progress=False, auto_adjust=False)
        closes = data["Close"] if isinstance(data.columns, pd.MultiIndex) else data[["Close"]].rename(
            columns={"Close": next(iter(pairs.values()))})
        for c, sym in pairs.items():
            series = closes[sym].dropna() if sym in closes else pd.Series(dtype=float)
            if len(series) and series.iloc[-1] > 0:
                rates[c] = 1.0 / float(series.iloc[-1])
    out = dict(rates)
    for minor, (major, div) in MINOR_UNITS.items():
        if major in rates:
            out[minor] = rates[major] / div
    return out


def to_usd(value, currency: str | None, fx: dict[str, float]) -> float | None:
    if value is None or currency is None or currency not in fx or pd.isna(value):
        return None
    return float(value) * fx[currency]


# --- stocks ------------------------------------------------------------------------------

def normalize_name(name: str | None) -> str:
    """'Samsung Electronics Co., Ltd.' and 'SAMSUNG ELECTRONICS CO LTD' -> 'SAMSUNG ELECTRONICS'."""
    if not isinstance(name, str) or not name.strip():
        return ""
    tokens = re.sub(r"[^A-Z0-9 ]+", " ", name.upper()).split()
    while tokens and tokens[-1] in _LEGAL:
        tokens.pop()
    return " ".join(t for t in tokens if t not in {"THE"})


def _screen_all(query, pause: float = 0.25, retries: int = 3) -> list[dict]:
    quotes, offset, total = [], 0, None
    while total is None or offset < total:
        for attempt in range(retries + 1):
            try:
                res = yf.screen(query, offset=offset, size=250, sortField="intradaymarketcap", sortAsc=False)
                break
            except Exception as exc:  # rate limits, transient errors
                if attempt == retries:
                    raise
                log.warning("screener retry after %s", exc)
                time.sleep(5 * (attempt + 1))
        page = res.get("quotes", [])
        total = res.get("total", 0)
        if not page:
            break
        quotes += page
        offset += len(page)
        time.sleep(pause)
    return quotes


def screen_region(region: str, min_cap_usd: float, fx: dict[str, float]) -> list[dict]:
    """All stocks in one Yahoo region at or above the USD market-cap floor, tagged by sector."""
    market, currency = REGIONS[region]
    local_floor = min_cap_usd / fx.get(currency, 1.0)
    rows = []
    for sector in SECTORS:
        query = EquityQuery("and", [EquityQuery("eq", ["region", region]), EquityQuery("eq", ["sector", sector]),
                                    EquityQuery("gte", ["intradaymarketcap", local_floor])])
        for q in _screen_all(query):
            q["_sector"], q["_region"], q["_market"] = sector, region, market
            rows.append(q)
    return rows


def _rating(text) -> tuple[float | None, str | None]:
    """'1.8 - Buy' -> (1.8, 'Buy')."""
    if not isinstance(text, str) or " - " not in text:
        return None, None
    num, label = text.split(" - ", 1)
    try:
        return float(num), label.strip()
    except ValueError:
        return None, label.strip()


def stock_rows(quotes: list[dict], fx: dict[str, float], min_cap_usd: float) -> pd.DataFrame:
    """Screener quotes -> instrument rows, dropping secondary venues and cross-listings."""
    recs = []
    for q in quotes:
        if q.get("quoteType") != "EQUITY" or q.get("exchange") in SECONDARY_VENUES or FOREIGN_LINE.match(q["symbol"]):
            continue
        cur = q.get("currency")
        cap_cur = MINOR_UNITS.get(cur, (cur, 1.0))[0]
        rating, label = _rating(q.get("averageAnalystRating"))
        price = q.get("regularMarketPrice")
        adv = (q.get("averageDailyVolume3Month") or 0) * (price or 0)
        recs.append({
            "symbol": q["symbol"], "name": q.get("longName") or q.get("shortName"), "asset_class": "stock",
            "region": q["_region"], "market": q["_market"], "exchange": q.get("exchange"), "currency": cur,
            "sector": q["_sector"], "market_cap_usd": to_usd(q.get("marketCap"), cap_cur, fx), "price": price,
            "change_pct": q.get("regularMarketChangePercent"),
            "fifty_two_week_change": q.get("fiftyTwoWeekChangePercent"),
            "dividend_yield": q.get("dividendYield"), "pe_current_year": q.get("priceEpsCurrentYear"),
            "analyst_rating": rating, "analyst_label": label,
            "_adv_usd": to_usd(adv, cur, fx) or 0.0,
        })
    df = pd.DataFrame(recs)
    if df.empty:
        return df
    df = df[df.market_cap_usd.fillna(0) >= min_cap_usd * 0.95]
    # Same company listed in several places (ADR + home listing, dual classes):
    # keep the most liquid listing and remember the others.
    keys = df["name"].map(normalize_name)
    df["_key"] = keys.where(keys != "", df["symbol"])  # nameless rows dedupe on their own symbol
    df = df.sort_values("_adv_usd", ascending=False)
    others = df.groupby("_key").symbol.apply(lambda s: ", ".join(s.iloc[1:]) if len(s) > 1 else None)
    df = df.drop_duplicates("_key", keep="first").drop_duplicates("symbol")
    df["also_listed"] = df["_key"].map(others)
    return df.drop(columns=["_key", "_adv_usd"]).reset_index(drop=True)


def discover_stocks(min_cap_usd: float = 1e9, regions: Iterable[str] | None = None) -> pd.DataFrame:
    regions = list(regions or REGIONS)
    fx = usd_per_unit({REGIONS[r][1] for r in regions} | set(MINOR_UNITS))
    quotes = []
    for region in regions:
        started = time.perf_counter()
        part = screen_region(region, min_cap_usd, fx)
        log.info("screened %s: %d quotes in %.0fs", region, len(part), time.perf_counter() - started)
        quotes += part
    fx = usd_per_unit({q.get("currency") for q in quotes} | set(fx))  # any extra quote currencies
    return stock_rows(quotes, fx, min_cap_usd)


# --- ETFs --------------------------------------------------------------------------------

def parse_nasdaq_directory(text: str, symbol_col: str) -> pd.DataFrame:
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("File Creation Time")]
    df = pd.read_csv(io.StringIO("\n".join(lines)), sep="|", dtype=str)
    df = df[(df["ETF"] == "Y") & (df["Test Issue"] == "N")]
    sym = df[symbol_col].str.strip()
    ok = ~sym.str.contains(r"[\$=\^]", regex=True, na=True)
    return pd.DataFrame({"symbol": sym[ok].str.replace(".", "-", regex=False), "name": df["Security Name"][ok]})


def discover_us_etfs(timeout: float = 30.0) -> pd.DataFrame:
    """Every US-listed ETF/ETN (Nasdaq, NYSE, NYSE Arca, Cboe...) from Nasdaq Trader."""
    session = make_session(TOOL_USER_AGENT)
    frames = []
    for name, col in (("nasdaqlisted.txt", "Symbol"), ("otherlisted.txt", "ACT Symbol")):
        resp = session.get(NASDAQ_DIR.format(name=name), timeout=timeout)
        resp.raise_for_status()
        frames.append(parse_nasdaq_directory(resp.text, col))
    df = pd.concat(frames).drop_duplicates("symbol")
    df["name"] = df["name"].str.replace(r"\s+", " ", regex=True).str.strip()
    return df.assign(asset_class="etf", region="us", market="US ETFs", currency="USD").reset_index(drop=True)


# --- crypto ------------------------------------------------------------------------------

def is_derivative_coin(symbol: str, name: str, price: float | None) -> bool:
    s, n = (symbol or "").lower(), (name or "").lower()
    if s in STABLECOINS or FIAT_CODE.search(s):
        return True
    if price is not None and abs(price - 1.0) < 0.03 and re.search(r"usd|dollar|stable", n):
        return True
    return any(word in n for word in DERIVATIVE_WORDS) or bool(RWA_NAME.search(n))


def _last_closes(symbols: list[str]) -> dict[str, float]:
    if not symbols:
        return {}
    data = yf.download(symbols, period="5d", interval="1d", auto_adjust=True, progress=False, group_by="column",
                       threads=True)
    if data.empty:
        return {}
    close = data["Close"] if isinstance(data.columns, pd.MultiIndex) else data[["Close"]].set_axis(symbols, axis=1)
    return {k: float(v) for k, v in close.ffill().iloc[-1].dropna().items()}


def _same_price(yahoo: float | None, gecko: float | None, tolerance: float = 0.15) -> bool:
    return bool(yahoo and gecko and abs(yahoo / gecko - 1) <= tolerance)


def search_yahoo_crypto(base: str, name: str) -> list[str]:
    """Yahoo tickers for a coin: 'UNI-USD' is not Uniswap on Yahoo, 'UNI7083-USD' is."""
    pattern = re.compile(rf"^{re.escape(base.upper())}\d*-USD$")
    try:
        quotes = yf.Search(name, max_results=10, news_count=0).quotes
    except Exception as exc:
        log.warning("Yahoo search failed for %s: %s", name, exc)
        return []
    return [q["symbol"] for q in quotes if q.get("quoteType") == "CRYPTOCURRENCY" and pattern.match(q.get("symbol", ""))]


def resolve_yahoo_symbols(coins: pd.DataFrame, cache_path=None, recheck_days: int = 7) -> pd.Series:
    """Yahoo ticker per coin (indexed like ``coins``), verified against CoinGecko's price.

    The plain SYM-USD ticker is tried first; when it is missing or prices a different
    coin (ticker collisions), Yahoo's search finds the suffixed ticker. Results are
    cached by CoinGecko id; coins Yahoo doesn't carry are searched again weekly.
    """
    import json

    if cache_path is None:
        from quant.universe.prices import store_dir

        cache_path = store_dir() / "crypto_symbols.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    today = pd.Timestamp.today().normalize()
    base = coins.symbol.str.removesuffix("-USD")
    first = {i: (cache.get(cid) or {}).get("symbol") or f"{b}-USD" for i, cid, b in zip(coins.index, coins.coingecko_id, base)}
    last = _last_closes(sorted(set(first.values())))
    out, searched = {}, 0
    for i, row in coins.iterrows():
        cid, entry = row.coingecko_id, cache.get(row.coingecko_id) or {}
        if _same_price(last.get(first[i]), row.price):
            out[i] = first[i]
            cache[cid] = {"symbol": first[i], "checked": f"{today:%Y-%m-%d}"}
            continue
        recent = entry.get("checked") and (today - pd.Timestamp(entry["checked"])).days < recheck_days
        if entry.get("symbol") is None and recent:
            out[i] = f"{base[i]}-USD"  # Yahoo didn't carry it last week; no price history
            continue
        found = search_yahoo_crypto(base[i], row["name"])
        last.update(_last_closes([s for s in found if s not in last]))
        searched += 1
        candidates = dict.fromkeys([*found, first[i]])  # the cached or plain ticker stays in the running
        match = next((s for s in candidates if _same_price(last.get(s), row.price)), None)
        out[i] = match or f"{base[i]}-USD"
        cache[cid] = {"symbol": match, "checked": f"{today:%Y-%m-%d}"}
        time.sleep(0.3)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, indent=0, sort_keys=True), encoding="utf-8")
    log.info("crypto tickers: %d of %d priced on Yahoo (%d searched)",
             sum(_same_price(last.get(s), p) for s, p in zip(out.values(), coins.price)), len(coins), searched)
    return pd.Series(out).reindex(coins.index)


def discover_crypto(top_n: int = 250, timeout: float = 30.0, resolve: bool = True) -> pd.DataFrame:
    """Top coins by market cap, minus stablecoins, wrapped/staked/bridged copies and tokenized
    funds, with each coin's Yahoo ticker resolved."""
    session = make_session(TOOL_USER_AGENT)
    coins, page = [], 1
    while len(coins) < top_n + 60:  # fetch extra to make up for the exclusions
        resp = session.get(COINGECKO_MARKETS, timeout=timeout, params={
            "vs_currency": "usd", "order": "market_cap_desc", "per_page": 250, "page": page,
            "price_change_percentage": "24h,1y"})
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        coins += batch
        page += 1
        time.sleep(2.5)  # CoinGecko's free tier allows ~30 calls/minute
    recs = []
    for c in coins:
        if is_derivative_coin(c["symbol"], c["name"], c.get("current_price")):
            continue
        recs.append({
            "symbol": f"{c['symbol'].upper()}-USD", "name": c["name"], "asset_class": "crypto", "region": "crypto",
            "market": "Crypto", "exchange": "CCC", "currency": "USD", "sector": None,
            "market_cap_usd": c.get("market_cap"), "price": c.get("current_price"),
            "change_pct": c.get("price_change_percentage_24h"),
            "fifty_two_week_change": c.get("price_change_percentage_1y_in_currency"),
            "coingecko_id": c["id"], "rank": c.get("market_cap_rank"),
        })
    df = pd.DataFrame(recs).drop_duplicates("symbol").head(top_n)  # shared tickers: keep the larger coin
    if resolve:
        df["symbol"] = resolve_yahoo_symbols(df)
    return df.drop_duplicates("symbol").reset_index(drop=True)


def frame_to_rows(df: pd.DataFrame, columns: Iterable[str]) -> list[dict]:
    """DataFrame -> list of dicts with NaN as None (for upserts)."""
    out = df.reindex(columns=list(columns))
    out = out.astype(object).where(out.notna(), None)
    return out.to_dict("records")
