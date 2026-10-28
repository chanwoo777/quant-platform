# Free Quant Platform

[![Tests](https://github.com/chanwoo777/quant-platform/actions/workflows/tests.yml/badge.svg)](https://github.com/chanwoo777/quant-platform/actions/workflows/tests.yml)

An autonomous stock-analysis and **paper-trading** platform built entirely on free,
public data: no Bloomberg, no paid APIs, no API keys.

| Source | Used for | Access |
|---|---|---|
| Yahoo Finance (`yfinance`) | Daily + 15-min OHLCV, VIX, indices, quotes | free, ~15 min delayed |
| FRED, St. Louis Fed | Inflation, Treasury yields, employment, credit spreads | `pandas-datareader`, falling back to FRED's public CSV |
| SEC EDGAR (`data.sec.gov`) | 10-K / 10-Q financials via XBRL | official free API |
| Google News, Yahoo Finance, CNBC, MarketWatch RSS | Headlines | `feedparser` + `BeautifulSoup` |
| FinBERT (`ProsusAI/finbert`, HuggingFace) | Financial sentiment | open-source model, runs locally |
| Kenneth R. French Data Library | Fama-French 3 factors + momentum, daily | `pandas-datareader`, falling back to the library's zipped CSVs |

> Paper trading only. Nothing here places real orders, and nothing here is investment advice.

## Project layout

```
quant-platform/
├── requirements.txt
├── requirements-quantum.txt   optional: pinned Qiskit for the website's quantum simulations
├── .env.example
├── quant/
│   ├── config.py              settings, watchlist, FRED series                 [P1]
│   ├── db.py                  engine, sessions, SQLite/Postgres upsert          [P1]
│   ├── models.py              ORM tables                                        [P1, extended in P4]
│   ├── ingestion/
│   │   ├── http.py            retrying HTTP sessions                            [P1]
│   │   ├── market_data.py     yfinance OHLCV + quotes                           [P1]
│   │   ├── macro_data.py      FRED                                              [P1]
│   │   ├── sec_edgar.py       EDGAR 10-K / 10-Q metrics                         [P1]
│   │   ├── news_scraper.py    RSS scraping, sentiment pass, news-to-chart map   [P1]
│   │   ├── sentiment.py       FinBERT with a lexicon fallback                   [P1]
│   │   ├── relevance.py       company-name relevance filter for headlines       [P2]
│   │   ├── factors.py         Fama-French factor returns                        [P3]
│   │   ├── index_membership.py point-in-time S&P 500 membership (Wikipedia)     [P6]
│   │   └── pipeline.py        orchestrator + CLI                                [P1]
│   ├── analytics.py           50/200 MA, RSI, MACD, Bollinger, regime, anomalies [P2]
│   ├── quant_models.py        Fama-French 3F, momentum, mean reversion, scoring [P3]
│   ├── trading_bot.py         signals, paper ledger, Kelly/vol sizing, stops    [P4]
│   ├── scheduler.py           APScheduler daily run                             [P4]
│   └── web/                   static website: export, publish, quantum simulations
├── dashboard/                 Streamlit + Plotly                                [P5]
│   ├── app.py                 entry point and navigation
│   ├── common.py              cached data access, palette, chart styling
│   └── pages/                 market_overview · stock_deep_dive · financials_research · trading_bot
├── data/                      quant.db (SQLite) and cache/
└── tests/
```

The dashboard is Streamlit + Plotly, so the whole platform is one Python codebase
reading one database.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
copy .env.example .env            # then set SEC_USER_AGENT to "Your Name you@email.com"
```

## Phase 1: running the ingestion engine

```bash
python -m quant.ingestion.pipeline                         # everything
python -m quant.ingestion.pipeline --steps prices macro    # a subset
python -m quant.ingestion.pipeline --tickers AAPL NVDA --no-finbert
python -m quant.ingestion.pipeline --steps fundamentals --refresh-fundamentals  # re-extract after adding a metric
python -m pytest                                           # offline tests
```

The first run backfills 10 years of daily bars and downloads FinBERT (~440 MB).
After that, each run fetches only what's new: recent bars, revised FRED prints,
filings it hasn't seen, and fresh headlines.

### What each step stores

| Table | Contents |
|---|---|
| `price_bars`, `stock_splits` | `1d` bars keyed by session date; `15m` bars keyed by UTC bar start; split history |
| `factor_returns` | Daily Fama-French Mkt-RF, SMB, HML, RF and momentum (decimals), lagging today by 1-2 months |
| `macro_series`, `macro_observations` | FRED metadata and values (daily, weekly or monthly, depending on the series) |
| `companies`, `fundamentals` | One row per 10-K / 10-Q (about 11 years): revenue, net income, EPS, diluted shares, assets, liabilities, equity, total debt, cash, operating cash flow, capex, FCF, D/E, net margin, link to the filing |
| `news_articles` | Headline, publisher, UTC time, FinBERT label/score, and its intraday chart alignment |
| `index_members` | One row per stint of a stock in the S&P 500: ticker, name, added, removed (only with `--universe sp500`; see the research-universe section) |

### Design notes

- **SEC metrics come from XBRL, not HTML scraping.** Every fact in EDGAR's
  `companyfacts` API carries the accession number of the filing that reported it,
  so metrics are matched to an exact 10-K / 10-Q. A 10-Q reports both quarterly and
  year-to-date figures; the parser takes the quarter for the income statement.
  Cash-flow statements in a 10-Q are year-to-date only, so `cash_flow_period_days`
  records the length. Total debt is approximated from the standard debt tags, with
  guards against double counting.
- **News-to-chart mapping.** Each headline is aligned to the first 15-minute bar
  that traded after publication. Overnight news aligns to the next open, so the gap
  is captured. `reaction_return` is the move from the last close before the headline
  to the end of a 60-minute trading window. Market-wide headlines are mapped
  onto SPY.
- **Sentiment score** = P(positive) − P(negative) from FinBERT, in [−1, 1]. If
  torch / transformers are missing, a finance lexicon scorer takes over, and the
  `sentiment_model` column records which scorer produced each score.
- **Resilience.** Each ticker and series runs in its own transaction, every write
  is an idempotent upsert, and HTTP calls retry with backoff. SEC requests are
  throttled below its 10 requests/second limit.
- **User agents matter.** Yahoo's RSS returns 429 to non-browser agents, while FRED
  stalls agents that claim to be browsers. `http.py` sets each one accordingly.

## Phase 2: analytics

```bash
python -m quant.analytics                       # current market regime
python -m quant.analytics AAPL JNJ              # + indicators and explained daily anomalies (90 days)
python -m quant.analytics TSLA --interval 15m   # intraday anomalies (30 days)
```

Everything is computed on demand from the database. The core functions in
`quant/analytics.py` take plain DataFrames, so later phases can reuse them for
backtests.

- **Indicators** (`add_indicators`, via the `ta` library): 50/200-day SMA with
  golden/death-cross events, RSI(14), MACD(12,26,9), Bollinger Bands(20,2), ATR(14)
  and 20-day realised volatility.
- **Market regime** (`market_regime_for`), computed for every day of history:
  - *Trend* uses the S&P 500. **Bull** when the 50-day MA is more than 1.0% above
    the 200-day and price is above the 200-day. **Bear** for the mirror image, or
    when price is under the 200-day and at least 20% below its 52-week high (this
    catches crashes before the lagging death cross). Otherwise **Sideways**.
  - *Volatility* uses the VIX: Calm below 16, Volatile at 24 or higher.
  - The resulting labels are Bull/Bear Trending, Bull/Bear Volatile, Sideways and
    Sideways Volatile.
  - *Fast to de-risk, slow to re-risk:* a label moves to a riskier state at once,
    but back to a calmer one only after 5 consecutive calmer days. This applies to
    trend, volatility and stance alike.
  - *Macro overlay* from FRED: inverted 10Y-2Y yield curve, the Sahm-rule
    recession signal, credit stress, and core CPI above 3%. Credit stress means the
    Baa-Treasury spread is at least 3.0% or has widened at least 0.5pp in 3 months.
    These feed a 0–1 risk score that sets the stance (Risk-On below 0.33, Risk-Off
    above 0.6). Each FRED series is shifted by its publication lag (45 days
    monthly, 7 days weekly), so the history never uses data before it was public.
- **Chart-to-news correlation** (`explain_anomalies`):
  - *Flagging:* a daily move of at least 8%, or one of at least 3σ and at least
    2%, where σ is a robust volatility estimate (scaled median absolute deviation)
    so one crash can't hide the aftershocks. That's about 9 markers per stock per
    year. Intraday 15-minute bars use 3% / 4σ / 1.25%, and the opening bar, which
    carries the overnight gap, is scored only against previous opens.
  - *Move window:* from the previous close to this close, so overnight earnings
    count.
  - *Driver:* each move is classed as market-driven or stock-specific, using beta
    against SPY.
  - *Ranking:* candidate headlines are ranked by relevance × timing (before,
    during or after the move) × FinBERT agreement with the direction of the move.
- **Relevance filter** (`ingestion/relevance.py`): scores each headline 0–1 for
  whether the company is its subject. It uses curated aliases plus the SEC
  registrant name, and catches name variants ("Johnson and Johnson").
  - *Demoted (0.4):* multi-company lists, week-ahead previews, market roundups, and
    headlines led by another company's stock.
  - *Named only in passing (0.15):* the company is the analyst ("…as J.P. Morgan
    puts it on negative watch") or a modifier ("Nvidia-backed CoreWeave…"). For
    banks and brokers it also catches research attributions ("…, J.P. Morgan
    says").
  - *Boilerplate (0, and skipped at ingestion):* quote, forecast and options-chain
    pages, plus 13F holding, ETF-flow and Form 4 notices.
  - *Accuracy* on 568 hand-labeled headlines (`tests/fixtures/relevance_labels.csv`)
    at the 0.5 threshold: 99.0% precision and 99.5% recall, up from 85.4% / 98.9%
    before tuning. These figures are in-sample; on 28 headlines fetched after
    tuning, the filter made 3 errors.
  - Scores are stored in `news_articles.relevance`. Anomaly matching requires the
    company to be named in the headline (score ≥ 0.4), and sentiment signals should
    use on-topic headlines only (score ≥ 0.5).

### Calibration

All Phase 2 thresholds are reproducible with `scripts/calibrate_phase2.py`. The goal
is robust settings (plateaus, stability, clear separation of forward risk), not
maximum backtest returns, so Phase 4 backtests on the same history aren't silently
overfit.

```bash
python scripts/calibrate_phase2.py regime          # trend band, drawdown rule, VIX cut-offs (1990-today)
python scripts/calibrate_phase2.py regime-confirm  # confirmation window: switches/yr vs detection lag
python scripts/calibrate_phase2.py regime-stance   # risk-score stance cut-offs, credit-stress input
python scripts/calibrate_phase2.py anomalies       # move rules vs SEC 8-K Item 2.02 earnings dates
python scripts/calibrate_phase2.py relevance       # headline filter vs the hand-labeled fixture
```

| Setting | Before | Tuned | Evidence (1990–2026 unless noted) |
|---|---|---|---|
| Trend band / confirmation | 1.5% / none | 1.0% / 5 days | trend switches 6.2 → 4.2/yr, median spell 8 → 22 days, bear detected 6 days sooner |
| VIX spike rule | on | removed | forward vol on spike days 16.7% vs 16.2% at the same VIX level (no signal) |
| Volatility confirmation | none | 5 days | switches 24 → 11/yr; Volatile still carries 2.2× Calm forward vol |
| Credit-stress input | HY OAS (3 yrs on FRED) | Baa−10Y spread | coverage 12% → 100% of days; stressed days' forward vol 20.7% vs 11.9% |
| Stance confirmation | none | 5 days | stance switches 7.0 → 4.2/yr; Risk-Off forward vol 23.3% vs 10.9% Risk-On |
| Daily anomaly rule | 5% / 3σ / 2% | 8% / 3σ / 2% | per stock 13.8 → 8.7 flags/yr; busiest/calmest 5.8× → 2.9× (2016–2026) |
| Intraday opening bar | shared σ | own σ | opening-gap flags 0.30 → 0.04 per ticker-day |
| Intraday minimum move | 1.0% | 1.25% | TSLA 16 → 3 flags in 30 sessions, others barely change (provisional: small sample) |
| Relevance filter | | 7 rule fixes | precision 85.4% → 99.0% (568 labels) |

## Phase 3: quant models

```bash
python -m quant.ingestion.pipeline --steps factors   # daily Fama-French factors
python -m quant.quant_models                         # exposures, backtests, signals, composite scores
python -m quant.quant_models --model carhart         # add the momentum factor to the regressions
python -m quant.quant_models --evaluate              # monthly score history + information coefficients
```

`quant/quant_models.py` loads prices, filings, splits and factors once into a
`Universe`, so scores can be recomputed cheaply for any past date. That is what
Phase 4 needs for backtests.

- **Fama-French exposures** (`factor_regression`):
  - *Model:* daily excess returns regressed on Mkt-RF, SMB and HML (Fama & French
    1993), optionally plus momentum (Carhart 1997). Window: 3 years, with
    Newey-West t-statistics.
  - *Variance shares:* each factor's share of return variance is
    β·cov(factor, return)/var(return). The shares sum to R², and the remainder is
    stock-specific.
  - *Return attribution:* the risk-free rate, plus alpha, plus β × each factor's
    average premium.
  - *Readout:* each stock gets a dominant driver and plain-English tilts (large-cap,
    growth/value, aggressive/defensive, significant alpha). `rolling_exposures`
    charts how betas drift over time.
- **Strategies** (`run_strategies`). Every strategy is rank-based on the watchlist,
  trades on the next day's returns (no look-ahead), and is charged 5 bps per unit
  of turnover:
  - Momentum 12-1, Jegadeesh & Titman (1993): long the top 3 / short the bottom 3
    by 12-month return excluding the latest month, plus a long-only version.
    Monthly rebalance.
  - Short-term reversal: 1-week (Lehmann 1990) and 1-month (Jegadeesh 1990). Long
    recent losers, short recent winners.
  - Every strategy is then regressed on the Carhart factors, to see whether it
    earns alpha or just repackages known factors.
  - `strategy_signals` gives today's momentum rank and leg, the 5-day reversal
    rank, and a Bollinger z-score (oversold/overbought).
- **Composite score** (`factor_scores`):
  - *Value:* earnings yield, FCF yield, book-to-market and sales yield (Basu 1977;
    Fama & French 1992).
  - *Quality:* ROE, cash ROA, leverage and accruals (Sloan 1996; Novy-Marx 2013;
    Asness, Frazzini & Pedersen 2019).
  - *Momentum:* 12-1 and 6-1 returns.
  - *Scoring:* each metric is ranked across the watchlist, because ranks resist
    outliers when there are only 10 stocks. Ranks are averaged into three 0–100
    pillars, then combined with equal weights. For banks, the cash-flow, sales and
    leverage ratios are skipped.
  - *Point in time:* trailing-twelve-month figures come from 10-Q/10-K filings,
    with Q4 = annual − Q1–Q3 and year-to-date cash flows differenced. A filing
    counts only from its SEC filing date. Share counts are converted to today's
    split basis so market cap matches split-adjusted prices (NVDA, AAPL, TSLA,
    GOOGL and AMZN all split during the decade).
- **Evaluation** (`--evaluate`): the Spearman rank IC of each pillar against the
  next 21-day return, over about 106 monthly cross-sections.

Read the results with two caveats. First, the watchlist is today's mega-caps,
chosen with hindsight, so backtests are survivorship-biased. Second, ranking
within 10 stocks is very noisy. On current data no pillar predicts next-month
returns (every |t| < 2), and 12-1 momentum adds return only in its long-only form.
Treat the score as a structured summary of value, quality and trend, not as a
proven edge. Phase 6 re-runs these tests on point-in-time S&P 500 members: the
momentum alpha disappears there, and the score still shows no predictive power.

## Phase 4: autonomous paper-trading bot

```bash
python -m quant.trading_bot signals             # today's BUY / SELL / HOLD with rationales (no trading)
python -m quant.trading_bot run                 # trade the latest session(s) in the "paper" portfolio
python -m quant.trading_bot status              # positions, P&L, stops, win rate, recent trades
python -m quant.trading_bot backtest --save     # walk-forward test since 2018 (also seeds Kelly stats)
python -m quant.scheduler                       # run everything automatically (APScheduler)
```

**Signals** (`make_signal`). Four components in [−1, 1] are blended into one score:

| Component | Weight | Built from |
|---|---|---|
| Trend | 35% | 50/200-day MA alignment (golden/death cross, price vs 200-day) 60%, plus the 12-1 momentum rank 40% |
| Fundamentals | 25% | SEC quality pillar 60%, plus latest-quarter net income growth year-on-year 40%. A TTM loss or negative operating cash flow caps it at −0.5 |
| Valuation | 20% | Fama-French-style value pillar (E/P, FCF/P, B/M, S/P) 75%, plus the FF3 alpha t-stat 25% |
| Sentiment | 20% | FinBERT score of on-topic headlines over the last 7 days, half-life 2 days, at least 2 headlines |

- **BUY:** score ≥ 0.25 *and* an up-trend, unless the market regime is Bear.
- **SELL:** a held stock's score falls to ≤ −0.10, or its trend breaks.
- Every signal is stored in `signals` with a rationale that leads with the reasons
  pointing the way of the action. For example: "Buy XOM (score +0.53): 50 MA 7.9%
  above 200 MA, …; value 89/100 (E/P 4.4%) …; bullish news sentiment (FinBERT +0.33,
  29 headlines); positive SEC earnings report (10-Q for 2026-06-30: net income
  +105% y/y) …".

**Risk management:**
- *Sizing:* volatility parity (weights ∝ 1/60-day vol). Alternatively `--sizing kelly`,
  where half Kelly (f = W − (1−W)/R, from closed round trips) sets the weight of a
  median-volatility position, scaled by vol. Until the live ledger has 20 closed
  trades, Kelly is bootstrapped from the saved backtest.
- *Limits:* at most 6 names and 20% per name. Gross exposure is 100% / 70% / 35% in
  Risk-On / Neutral / Risk-Off. Positions are resized only when 3+ points of equity
  off target.
- *Stops:* the initial stop is 3.5×ATR below entry, never more than 15% below it. A
  trailing stop follows at the highest close − 3.5×ATR and only moves up. A stop is
  checked against the session low and fills at the stop, or at the open after a gap
  down.

**Ledger** (SQLite or Postgres):
- `portfolios` holds cash, last session processed and parameters.
- `positions` holds holdings with their stop state.
- `trades` logs every fill with its reason (entry/add/trim/exit/stop), a
  plain-English rationale, the full signal JSON and round-trip P&L.
- `portfolio_snapshots` stores the daily equity curve.
- `signals` stores every day's signals.
- Runs are idempotent. After downtime, stops are replayed for every missed session,
  and new trades happen only on the latest one. Splits are applied to open positions.

**Conventions:** market-on-close fills with 5 bps slippage, whole shares, long only,
no leverage. News counts only up to the close.

**Automation** (`quant/scheduler.py`, US/Eastern):
- 17:30 Monday–Friday: ingest everything, then run the bot.
- Every 2 hours, 08:00–20:00: refresh the news.
- Saturday 10:00: refresh the backtest.
- Logs go to `data/logs/scheduler.log`. The scheduler only runs while the process is
  up. On a laptop, Windows Task Scheduler is more reliable.

**Windows scheduled task** (registered on this machine as *QuantPlatform daily cycle*):
- *When:* Tuesday–Saturday at **07:30 KST**. Korea has no daylight saving but New
  York does, so that is 17:30 New York in winter (EST) and 18:30 in summer (EDT).
  Either way it runs after the close.
- *Runs:* `.venv\Scripts\pythonw.exe -m quant.scheduler --run-now` in the project
  folder. `pythonw` means no console window; printed output goes to
  `data/logs/scheduler.out`.
- *Missed runs:* if the PC is off or asleep at 07:30, the run starts as soon as it is
  available. Market holidays are no-ops.
- *Failures:* the task's *Last Run Result* is 1 and the traceback is in
  `scheduler.log`.

```powershell
Get-ScheduledTaskInfo -TaskName "QuantPlatform daily cycle"     # last / next run, last result
Start-ScheduledTask -TaskName "QuantPlatform daily cycle"       # run now
Unregister-ScheduledTask -TaskName "QuantPlatform daily cycle"  # remove
```

**Backtest** (2018–2026, 10 stocks, signals weekly, stops daily):

| Sizing | CAGR | Vol | Sharpe | Max drawdown | Avg invested | Win rate | Payoff |
|---|---|---|---|---|---|---|---|
| Volatility parity (default) | 8.7% | 14.3% | 0.46 | −24.8% | 66% | 44% | 1.86 |
| Half-Kelly (full Kelly ≈ 14%) | 6.0% | 8.8% | 0.39 | −20.1% | 37% | 44% | 1.94 |
| SPY buy-and-hold | 14.4% | | | | 100% | | |

The bot is a risk-reduced trend follower. It cuts drawdowns but lags buy-and-hold in
this bull-market decade, and it shows **no edge** over SPY, even on a
survivorship-biased universe. On point-in-time S&P 500 members (Phase 6) it loses
money: −1.8% a year.

- *Stop width* (2.5–5×ATR) barely changed returns (8.7–9.9% CAGR), but tight stops
  multiplied turnover; see the notes in `trading_bot.BotParams`.
- *Exits:* nearly every exit comes from the trailing stop, so the score effectively
  governs entries.
- *Sentiment:* historical sentiment is neutral, because the news archive only starts
  in October 2026.

This is a research tool, not investment advice.

## Phase 6: point-in-time research universe (S&P 500)

Phases 3 and 4 were tested on today's 10 mega-caps, picked with hindsight. That
universe is survivorship-biased, and ranks over 10 names are mostly noise. Phase 6
adds an optional research universe: every stock that was in the S&P 500 at some
point in the price history, each one eligible only on the days it was actually in
the index. The watchlist still drives news, live signals, the paper portfolio and
the dashboard.

```bash
python -m quant.ingestion.pipeline --universe sp500 --steps universe prices fundamentals  # first run ~20 min
python -m quant.quant_models --evaluate --universe sp500           # deciles, point-in-time membership
python -m quant.quant_models --evaluate --universe sp500 --no-pit  # today's members back-filled (biased on purpose)
python -m quant.trading_bot backtest --universe sp500              # the Phase 4 rules on the same universe (~1 h)
python scripts/calibrate_phase2.py anomalies --universe sp500      # anomaly rules, member sessions only (~50 min)
```

To make the S&P 500 the default for these commands and for the daily pipeline, set
`RESEARCH_UNIVERSE=sp500` in `.env`. To extend headlines and FinBERT to the research
universe as well, set `NEWS_UNIVERSE=research`; it is slow, so it's off by default.

**Membership** (`quant/ingestion/index_membership.py`, table `index_members`):
- *Sources:* Wikipedia's "List of S&P 500 companies" (today's members and the date
  each joined) and "Historical components of the S&P 500" (dated additions and
  removals since 1976). Until August 2026 the latter was the "Selected changes"
  table on the first page. Both pages are cached for a day in `data/cache/`.
- *Reconstruction:* the change log is replayed backwards from today's list.
  Undoing an addition means the stock wasn't a member before that date; undoing a
  removal means it was. Each stint in the index is one row
  (`ticker, name, added, removed`): `added` is inclusive, `removed` exclusive, and
  NULL means "before the log starts" or "still a member". A change takes effect
  before the open, so a stock removed on day D is no longer a member on D.
- *Tickers:* stored in Yahoo's format (BRK.B → BRK-B) and under the symbol the
  company trades as today, because Yahoo files a renamed company's whole history
  under its new symbol (Facebook's 2016 prices live under META). `RENAMES` lists 44
  dated symbol changes from 2016 to 2026, so reused symbols resolve correctly ("Q"
  was QuintilesIMS until 2017 and is Qnity today). Rows that only record a symbol
  change (WLTW → WTW) are not counted as membership changes.
- *Checks:* the rebuilt index holds 489–504 names at every month-end since 2010.
  No row in the log contradicts the reconstruction after March 2015. The remaining
  conflicts (Allergan's symbol passing to Actavis in 2015; Delphi, Joy Global and
  Ingersoll-Rand in 2010–2012) predate the price history. A name check against
  SEC's current registrants found no symbol whose Yahoo history overlaps the stint
  of a different company.

**Ingestion** (`--universe sp500`):
- *Prices:* `market_data.update_daily_batch` downloads daily bars and split events
  for 100 tickers per Yahoo request: 682 tickers and 1.44 M bars in about 6 minutes.
  Later runs fetch only the last week and stop asking for delisted names.
  Intraday bars stay watchlist-only. Tickers Yahoo has no data for are remembered in
  `data/cache/yahoo_no_data.json` and re-tried monthly.
- *Fundamentals:* the same SEC client, at ≤ 6.7 requests/second (SEC allows 10):
  606 filers and 24,105 filings in about 10.5 minutes, then only new filings.
  Share classes of one filer (GOOG/GOOGL, FOX/FOXA, NWS/NWSA) are fetched once;
  the others reuse those filings through their shared CIK.
- *News:* headlines and FinBERT stay watchlist-only unless `NEWS_UNIVERSE=research`.

**Point in time in the models:**
- `Universe.eligible(date)`: index members on that date with a price that day. A
  plain watchlist (`members=None`) keeps every ticker eligible, so watchlist results
  are unchanged; they were checked byte for byte against the pre-change outputs.
- *Scores* (`factor_scores`, `score_history`, ICs) rank only the stocks eligible on
  each date.
- *Strategies* (`run_strategies`) mask non-members' signals. Each leg holds a
  decile of the stocks ranked that day (`--quantile`) instead of a fixed 3 names.
  The equal-weight benchmark holds the previous session's members.
- *Bot* (`trading_bot backtest`): signals and entries come only from members. A
  holding that leaves the index is sold at the last close. Live trading stays on the
  watchlist, and `--save` stores the run as `backtest_sp500`, so the `backtest`
  portfolio used for the Kelly bootstrap is not touched.

### Results: 10 hand-picked stocks vs point-in-time S&P 500

Same prices, same 2016–2026 window, net of 5 bps per unit of turnover. The middle
column (`--no-pit`) ranks today's 503 members over the whole history: the usual
survivorship-biased setup, kept only to measure the bias.

| Strategy: CAGR, Carhart alpha (t) | 10 mega-caps, top/bottom 3 (before) | Today's S&P 500, back-filled, deciles | **Point-in-time S&P 500, deciles** |
|---|---|---|---|
| Momentum 12-1, long only | 37.0%, +14.8% (2.6) | 28.3%, +8.8% (2.8) | **14.4%, −2.2% (−0.8)** |
| Momentum 12-1, long/short | 1.4%, −1.2% (−0.1) | 2.2%, −1.3% (−0.3) | **−3.7%, −5.8% (−1.4)** |
| Reversal 1-week, long/short | −10.5%, −8.9% (−0.9) | −1.6%, −2.8% (−0.4) | **−0.8%, −2.3% (−0.3)** |
| Reversal 1-month, long/short | −8.7%, −4.5% (−0.5) | −6.8%, −4.9% (−0.8) | **−2.0%, −0.4% (−0.1)** |
| Equal-weight universe | 28.9%, +10.3% (3.8) | 17.1%, +3.6% (2.6) | **12.1%, −0.5% (−0.4)** |

| Score IC vs next 21-day return (t) | 10 mega-caps | Today's S&P 500, back-filled | **Point-in-time S&P 500** |
|---|---|---|---|
| Stocks per monthly cross-section | 10 | 472–503 | **434–503** |
| Value | −0.056 (−1.27) | −0.003 (−0.14) | **+0.001 (+0.04)** |
| Quality | +0.033 (+0.86) | +0.018 (+1.55) | **+0.017 (+1.46)** |
| Momentum | −0.001 (−0.02) | −0.002 (−0.11) | **−0.006 (−0.29)** |
| Composite | −0.026 (−0.75) | +0.006 (+0.46) | **+0.006 (+0.43)** |

What changed:
- **The momentum edge was survivorship.** The 10-stock momentum result was mostly
  hindsight: knowing which companies would become mega-caps. Back-filling today's
  S&P 500 still shows +8.8% alpha (t 2.8). With point-in-time membership it
  disappears (−2.2%, t −0.8), and long-only momentum roughly matches the
  equal-weight index (14.4% vs 12.1%, at higher volatility). Even the equal-weight
  benchmark loses its "alpha" (+3.6% → −0.5%) once the index is not picked with
  hindsight.
- **The composite score still predicts nothing, now with real breadth.** About 480
  names per month make the IC far more precise than with 10 names: a standard error
  of about 0.014 against about 0.035 before. Quality comes closest (t 1.46), still
  below the usual bar of 2. Momentum's IC is about zero, which is no surprise: in
  the stored factor data, Fama-French momentum earned 0.1% a year in 2009–2026,
  against 9.7% in 2000–2008 (4.0% over this window).
- **Short-term reversal is no longer a big loser.** On 10 names its −9% to −11% was
  concentration noise. Across the index, one-month reversal is about flat (−2.0%,
  alpha t −0.1). One-week reversal turns over 175× a year, so 5 bps per trade costs
  about 9% a year.

**Bot backtest** (Phase 4 rules unchanged, volatility parity, 2018-01-03 to
2026-10-19; about an hour on the S&P 500, since it scores ~500 stocks every week):

| Universe | CAGR | Vol | Sharpe | Max drawdown | Round trips | Win rate | Payoff | Full Kelly |
|---|---|---|---|---|---|---|---|---|
| 10 mega-caps (before) | 8.7% | 14.3% | 0.46 | −24.8% | 292 | 44% | 1.86 | 14.2% |
| **Point-in-time S&P 500** | **−1.8%** | 15.6% | −0.22 | −49.1% | 385 | 35% | 1.62 | 0% |
| SPY buy-and-hold | 14.4% | | | | | | | |

The bot's modest result on 10 names came from trading only stocks already known
to be winners. Picking 6 names from ~500 by a score with no predictive power, and
exiting almost entirely on trailing stops (384 of 385 exits), loses about 0.5% per
round trip, and full Kelly is 0%, so Kelly sizing would invest nothing. Most of the
damage came in 2020 (−24.7%) and 2023 (−11.7%); 2024–2026 were positive (+8.5%,
+12.9%, +13.3%).

In the COVID crash the bot bought a fresh set of six names on three weekly signal
days in a row (26 Feb, 4 Mar and 11 Mar 2020). The 50/200-day trend filter lags,
and new buys are blocked only once the regime turns Bear. Each set was stopped out
within days, realizing −$21.7k on a $100k book in a month. The bot was then mostly
Risk-Off and only 37% invested during the rebound (+3.2% from March to August).
Tightening entries in fast drawdowns (blocking buys while the regime is Volatile,
or after a market stop-out) is the obvious next experiment, but it should be judged
on this universe, not on the 10 names. A trade-by-trade check found no data
artifacts: the worst round trip is −20.5% (Humana gapping below its stop in March
2020), and no fill is at an implausible price.

**Phase 2 anomaly rule** (`calibrate_phase2.py anomalies --universe sp500`). The
run covers 560 stocks with at least a year of member sessions (4,629 member-years,
19,698 earnings releases from 8-K Item 2.02 filings). The tuned daily rule holds
up, so it was not changed:

| Daily rule (abs / z / min) | Universe | Flags per stock-year | Spread across stocks | Earnings reactions caught | Flags on earnings days | Market-driven flags |
|---|---|---|---|---|---|---|
| 5% / 3σ / 2% (old) | 10 mega-caps | 13.8 | 5.8× busiest/calmest | 43% | 15% | 33% |
| 8% / 3σ / 2% (tuned) | 10 mega-caps | 8.7 | 2.9× busiest/calmest | 35% | 19% | 32% |
| 5% / 3σ / 2% (old) | point-in-time S&P 500 | 12.6 | 2.9× p90/p10 | 40% | 15% | 24% |
| 8% / 3σ / 2% (tuned) | point-in-time S&P 500 | 8.8 | 1.7× p90/p10 | 37% | 18% | 25% |

Across the index, a single busiest/calmest ratio is dominated by one outlier, so
the spread is shown as p90/p10. A reaction day moves 3.9× a normal day for the
median stock (1.1× the day before, 1.5× the day after), so the 8-K timing holds
beyond mega-caps. The intraday rules use 15-minute bars, which exist only for the
watchlist, so they are unchanged.

### Limitations

- **Missing prices: 7.4% of member-days since October 2016 can't be ranked.**
  Yahoo deletes the history of most companies that stop trading:
  - *Acquired or merged:* 77 companies, 6.0% of member-days (Twitter, Activision,
    Celgene, Xilinx, Discover, Juniper, Ansys, Hologic and others). Warner Bros.
    Discovery, AvalonBay and Electronic Arts, all acquired in 2026, survive only as
    a one-day stub. Takeovers usually end with a premium, so this gap leaves out
    gains.
  - *Removed from the index, then delisted:* 16 names, 1.1%. Chesapeake, Frontier
    and Mallinckrodt went bankrupt after leaving; Dish, Comerica, Nordstrom and
    others were acquired.
  - *Failed while in the index:* SVB, Signature Bank and First Republic, 0.2%.
    Their collapses are missing, which flatters long positions.
  - *Other, 0.2%:* the pre-2019 stints of 21st Century Fox class B and Dow
    Chemical, whose symbols now belong to their successors, plus the first three
    sessions of the window (the batch download started on 20 Oct 2016, the
    watchlist on 17 Oct).

  A stock without data is never ranked, so the screen still knows, with hindsight,
  which companies will vanish. Fixing this needs a delisting-aware price source
  such as CRSP or Norgate, and neither is free.
- **Membership comes from Wikipedia.** It is volunteer-maintained and cited to S&P
  press releases, but it is not S&P's official file. The symbol-change list
  (`RENAMES`) was compiled by hand. Effective dates are used, while index changes
  are announced about a week earlier.
- **History is short:** about 10 years of prices (2016–2026) and 44 filings per
  company. The Fama-French factors end on 2026-08-31, so alphas stop there.
- **Share classes double-count:** GOOG/GOOGL, FOX/FOXA and NWS/NWSA rank as two
  names with nearly identical scores, as they do in the index itself.
- **Splits:** for the research tickers, split history covers only the 10-year
  download window. A split between a stock's earliest filings (late 2015) and the
  start of the window (October 2016) would leave those filings' share counts on the
  wrong basis.
- **Same caveats as before:** 5 bps per unit of turnover, no borrow costs on shorts,
  and no historical news sentiment for the bot.

## Phase 5: web dashboard

```bash
streamlit run dashboard/app.py          # http://localhost:8501
```

There are four pages, all reading the same database the pipeline and the bot
update. The heavy point-in-time context is loaded once per process and cached for
15 minutes. Use **Reload data** in the sidebar after a pipeline run. The sidebar
also shows how fresh each source is.

| Page | What it shows |
|---|---|
| **Market Overview** | Regime, stance and risk score with the reasons behind them; the S&P 500 with its 50/200-day MAs and Risk-On / Neutral / Risk-Off shading; ten FRED indicator tiles with 2-year sparklines; watchlist movers with factor scores; breaking news with FinBERT tone and links |
| **Stock Deep Dive** | Daily or 15-minute candlesticks with the 50/200-day MAs, optional Bollinger bands, and separate volume and RSI panels; ▲/▼/● news markers on the bar each headline first affected; ★ unusual moves whose hover shows the Phase 2 explanation; tables of moves (with catalyst links) and headlines (with the 1-hour price reaction) |
| **Financials & Research** | TTM revenue, net income, margins, FCF, EPS and D/E from SEC XBRL; quarterly revenue, net income and margins (Q4 derived); the filings list with SEC links; Fama-French / Carhart exposures with t-stats; a return-attribution waterfall; rolling 1-year betas; the watchlist exposure table; composite factor scores; academic strategy backtests |
| **Live Trading Bot** | Paper or backtest portfolio: equity, return vs SPY, cash, win rate and payoff; equity vs SPY indexed to 100 with drawdown; open positions with weights and distance to stop; the latest signals as component-contribution bars with full rationales; the filterable trade ledger (CSV download); the distribution of closed-trade returns by exit reason |

Charts follow one validated palette. It was checked with a colorblind-safety
validator in light and dark mode, and dark mode uses its own steps rather than an
inversion.
- *Color:* candles are blue up / red down (not red/green). Regime shading uses status
  colors with labels.
- *Axes:* every chart has a single y-axis. Price, volume and RSI are separate panels,
  and the bot is compared with SPY indexed to 100.
- *Data:* every chart has a table or hover twin.

`tests/test_dashboard.py` renders every page headlessly with Streamlit's `AppTest`
(it is skipped until the pipeline has filled the database).

## Global universe: stocks, ETFs and crypto worldwide

```bash
python -m quant.universe.refresh                         # discover, prices, fundamentals, score (~30 min daily)
python -m quant.universe.refresh --steps score           # re-score only
python -m quant.universe.refresh --fund-limit 4000       # fetch more fundamentals in one run
```

The dashboard's **Global Overview** page (now the start page) screens the whole investable
universe with the same processes the deep tier uses. You can then promote picks to your
watchlist for the full treatment.

**Two tiers:**

| | Broad tier (Global Overview) | Deep tier (watchlist) |
|---|---|---|
| Coverage | ~8,700 stocks ≥ $1B in 21 markets, ~2–3k liquid US-listed ETFs, top 250 coins | The default 10 + anything you promote |
| Prices | 2 years daily, Parquet (`data/universe/`) | 10 years daily + 15-minute bars, database |
| Analysis | Trend (50/200 MA, crosses), momentum, risk, unusual moves, value, quality, analyst consensus, market regime per region; BUY / HOLD / AVOID with a rationale | Plus news with FinBERT sentiment and the relevance filter, explained moves, SEC filings (US), Fama-French, the paper-trading bot (USD-quoted names) |

**Sources** (all free, no keys):
- Yahoo Finance's screener supplies 250 quotes per request. It covers market cap,
  50/200-day averages, current-year P/E, dividend yield and analyst rating.
- Yahoo prices are downloaded in batches. Per-company ratios come from Yahoo's quote
  summary, refreshed for about 1,500 names per run.
- CoinGecko supplies the coin list. Nasdaq Trader's directory lists every US-listed ETF.
- Scraping sites like TradingView or Investing.com breaks their terms and breaks
  whenever their pages change, so they aren't used.

**How instruments are selected:**
- Markets are the US, Canada, the UK and Europe (DE, FR, NL, CH, IT, ES, SE, DK, FI, NO,
  BE), Japan, Korea, China, Hong Kong, Taiwan, India and Australia. The $1B floor is
  converted to each market's currency. UK prices are quoted in pence, but Yahoo reports
  UK market caps in pounds.
- Cross-listings (an ADR plus its home listing, dual share classes, foreign lines on
  Xetra or the LSE) are de-duplicated by company name, keeping the most liquid listing.
  The others are shown as "also listed".
- Crypto excludes stablecoins (including EUR and JPY coins), wrapped, staked or bridged
  copies, and tokenized funds, T-bills and private credit.
- Each coin's Yahoo ticker is checked against CoinGecko's price. Yahoo suffixes tickers
  that several coins share (Uniswap is `UNI7083-USD`), and a plain ticker can price a
  different coin (`ARB-USD` is not Arbitrum). Coins Yahoo doesn't carry are listed
  without technical scores. Results are cached in `data/universe/crypto_symbols.json`.
- ETFs must trade at least $1M a day on average.

**How instruments are scored** (`quant/universe/scoring.py`):
- *Pillars:* trend, momentum (12-1 and 6-1, on calendar days so crypto compares fairly),
  risk (volatility, 1-year drawdown), value (forward and trailing E/P, B/M, EBITDA/EV,
  dividend yield), quality (ROE, margin, low debt/equity, growth) and analysts. ETFs
  also get cost (expense ratio).
- *Peers:* each pillar is a percentile among peers. For stocks that means their market
  (and market × sector for value and quality); ETFs and coins rank within their class.
  The composite is the mean of the available pillars.
- *Signals:* **BUY candidate** = up-trend + composite ≥ 60 + the market isn't in a Bear
  regime. **AVOID** = down-trend + composite ≤ 40.
- *Market regimes:* each market's regime comes from its main index: S&P 500, TSX,
  STOXX 600, Nikkei 225, KOSPI, Hang Seng, TAIEX, Nifty 50, ASX 200, and Bitcoin for
  crypto. The US uses the VIX; elsewhere the index's realised volatility.
- *Unusual moves:* the Phase 2 rule, applied to every instrument every day.

**Watchlist → deep tier:**
- In Global Overview, select rows and click **Add to watchlist** (picked up by the next
  daily run), or **Add & analyse now**, which immediately fetches prices, SEC filings
  and news for stocks and ETFs.
- Non-US names get news by company name ("Samsung Electronics"), with that name as a
  relevance alias.
- The paper bot's ledger is in dollars, so it only trades USD-quoted names. Crypto stays
  in the broad tier.
- The scheduled daily cycle covers the deep tier, runs the bot, and then refreshes the
  global universe (`--no-universe` skips that).

**Limits:**
- Stock data is Yahoo's, so it's ~15 minutes delayed and corporate data can lag.
- Per-company ratios cover the universe only after about a week of daily runs. Yahoo
  rate-limits the per-company calls, and the fetch stops cleanly and resumes next run.
  Until then, value and quality scores rest on fewer inputs.
- Yahoo sometimes publishes a market's latest session late (for example, Monday's
  European bars on Tuesday morning in Asia). Those names score on the previous close,
  and the next refresh fills the gap.
- Analyst consensus stands in for news sentiment in the broad tier.
- Crypto in the broad tier updates on scheduled weekdays only.
- Rankings are relative to peers, not predictions; see the Phase 3 evaluation.

## Live website (GitHub Pages)

**https://chanwoo777.github.io/quant-platform/** is a static copy of the dashboard,
refreshed once a day, plus tools that run in the browser. GitHub Pages can't run
Python, so the PC that runs the pipeline exports the data as JSON and pushes it.

```bash
python -m quant.web.export                     # build the site in data/site (~1 min)
python -m quant.web.publish                    # export + push to the gh-pages branch
python -m quant.scheduler --run-now --publish-site   # daily cycle, then publish
```

| Page | What it does |
|---|---|
| **Global** | The screener (every stock ≥ $1B, liquid US ETF and top coin) with filters, per-symbol charts and signal reasons. ★ adds a name to your watchlist. |
| **Markets** | Regime and stance, the S&P 500 stance chart, FRED tiles and news. **Your watchlist**: search to add any stock, ETF, coin or index, ✕ to remove. It is saved in the browser (localStorage). |
| **Stock** (`#/stock/<ticker>`) | Any of ~11,400 symbols. Deep-tier names get candlesticks with news markers, explained moves and every indicator below. Everything else gets a close-price chart with the close-based indicators, plus returns, risk and peer percentiles. |
| **Financials** (`#/financials/<ticker>`) | A research view for any ticker: fundamentals, analyst consensus, a peer table, financial statements and the factor model. Statements come from SEC filings for the deep tier, or Finnhub's reported statements for US names when a key is set. |
| **Quantum** (`#/quantum`) | A beginner's guide to quantum algorithms for investors: basics, a qubit lab, option pricing, VaR/CVaR and portfolio labs with classical baselines, a readiness scorecard and the nightly simulator run. Details below. |
| **Live** (`#/live/<symbol>`) | The **Pro chart**: a TradingView-style chart drawn by the site, with every indicator and setting under your control. Details below. |

The header search autocompletes over the whole universe. Pretty links such as
`/quant-platform/stock/AAPL` also work: `404.html` turns them into the hash route.

**Factor models in the browser.** `docs/assets/quant.js` reimplements
`quant_models.factor_regression` and `rolling_exposures`: OLS with Newey-West
(5-lag) errors, variance shares, return attribution and tilts. So FF3, Carhart and
FF5 run for any stock, from `factors.json` and the symbol's adjusted closes. The
loadings chart shows 95% confidence intervals. `tests/test_site_js.py` runs the
JavaScript under Node.js against the Python models, on synthetic data with missing
values; they agree to about one part in a million. Fixes in this round:
- *Rolling betas:* the site's rolling-beta chart sampled an already monthly series
  a second time, leaving about 22 points over 9 years. It now keeps every monthly
  point.
- *FF5:* Fama & French (2015) is supported end to end. Ingestion stores the
  five-factor file's RMW, CMA and size factor (`smb5`, built from more sorts than
  SMB). `quant_models.FF5` and the Streamlit Financials page offer it, and the site
  estimates it per ticker.

**Indicators.** These are the popular TradingView indicators, implemented in
`quant.js` from the Pine Script built-ins:
- *Overlays:* SMA 50/200, EMA 9/21, Bollinger Bands (20, 2), VWAP (session),
  Ichimoku Cloud, Supertrend (10, 3) and Parabolic SAR.
- *Oscillators:* volume, RSI 14, MACD (12, 26, 9), Stoch RSI, Stochastic
  (14, 3, 3), ATR 14, ADX/DMI 14 and OBV.

They are drawn on the Stock pages and the Markets S&P 500 chart. Your choices are
remembered in the browser. `tests/test_site_js.py` checks each one under Node.js
against Python versions of the Pine definitions, and against the `ta` library where
it uses the same formulas. Indicators that need highs, lows or volume only appear
where those exist: the deep tier and the live feeds; the universe store keeps closes
only.

**Pro chart** (Live). A TradingView-style chart built on TradingView's open-source
Lightweight Charts v5, so indicators aren't limited the way an embedded widget is.
- *Toolbar:* symbol search, intervals from 1 minute to 1 month, and chart types
  (candles, hollow candles, bars, line, area, Heikin Ashi). Also log and percentage
  scales, screenshot and full screen.
- *Indicators:* a searchable dialog with 26 studies, each with TradingView's default
  inputs:
  - *Trend:* moving average (SMA, EMA, WMA, HMA, VWMA or RMA), Donchian, Ichimoku,
    Supertrend, Parabolic SAR, classic pivots, 52-week high/low and ADX/DMI.
  - *Momentum:* RSI, MACD, Stochastic, Stoch RSI, Williams %R, CCI, ROC and
    relative strength vs a benchmark (O'Neil RS line or Mansfield).
  - *Volatility:* Bollinger Bands, %B, BandWidth, Keltner Channels and ATR.
  - *Volume:* volume, VWAP, anchored VWAP, MFI and OBV.

  Add any study as often as you like. Each opens with editable inputs and colours
  (⚙ in the legend), can be hidden or removed, and oscillators get their own
  resizable pane.
- *Legend:* OHLC and every indicator value under the cursor, as on TradingView. It
  folds away on phones.
- *Drawing tools:* trend line, ray, horizontal and vertical lines, Fibonacci
  retracement, rectangle and a measure tool. Drawings are saved per symbol in the
  browser.
- *Shortcuts:* TradingView's own, such as `/` for indicators and typing `5`, `60`,
  `1D` or `W` then Enter for the interval. Also Alt+T, H, V and F for drawing
  tools, Alt+L for log scale, Alt+S for a screenshot, Esc, Delete and Ctrl+Z.
- *Investor playbooks:* the indicator sets well-known traders are known for, with
  their published settings and usual interval:
  - Paul Tudor Jones (200-day line)
  - Mark Minervini (Trend Template)
  - William O'Neil (CAN SLIM)
  - Stan Weinstein (stage analysis, weekly)
  - the Turtles (Donchian 20/55, ATR)
  - John Bollinger
  - Welles Wilder
  - Linda Raschke (Holy Grail, 3-10)
  - Larry Connors (RSI 2)
  - Gerald Appel (MACD)
  - Goichi Hosoda (Ichimoku)
  - Brian Shannon (VWAP)
  - Larry Williams (%R)
  - Joseph Granville (OBV)

  Fundamental investors like Buffett and Lynch don't use chart indicators, and the
  page says so rather than inventing a set.
- *Data:* every source is keyless and called from the visitor's browser:
  - *Crypto:* Binance public market data (REST history + WebSocket stream).
  - *Stocks, ETFs and indices:* CNBC's quote and chart service, which is
    unofficial. It covers the US, Korea, Europe, India, Taiwan, Australia, Canada
    and the major indices, including pre- and post-market bars. History loads
    first, then the chart polls every 15 s and backs off if CNBC throttles. US
    names get Finnhub tick streaming when the visitor has saved a free key.
  - *Fallback:* markets CNBC doesn't carry (Japan, Hong Kong) fall back to the
    nightly daily bars.

  The earlier version embedded TradingView's widget for US stocks; it is no longer
  used.

**Quantum tab** (`#/quantum`). A beginner's guide to quantum algorithms and
where they might help investors, with a classical baseline next to every quantum
number. Twelve sections:
1. *Basics:* superposition, measurement, entanglement and interference, the "tries
   every answer at once" myth, and why speedups need structure.
2. *Qubit lab:* a one-qubit widget (H, X, Z), a 1-5 qubit circuit simulator (H, X,
   Z, CNOT) with amplitudes and 1,000 measured shots, and an animated Grover search
   over 8 or 16 items. All of it runs in the browser.
3. *Toolbox:* eight building blocks, their speedups and finance uses.
4. *Monte Carlo vs QAE:* error against samples on a log-log chart (1/sqrt(N) vs 1/N),
   a target-error slider (0.1% means about 1,000,000 samples vs 1,000 queries),
   Monte Carlo measured in the browser, and the nightly QAE runs.
5. *Option pricing:* any stock in the universe. Spot and volatility (3, 6 or 12
   months of daily log returns) come from the site's prices; the rate is FRED's
   3-month T-bill yield (DGS3MO, now in `market.json`). The page shows
   Black-Scholes, Monte Carlo with a 95% interval and its convergence, and the
   nightly amplitude estimate with its error budget. A six-step explainer covers
   how QAE prices the option.
6. *Risk:* 1- and 10-day VaR and CVaR at 95% and 99% for a basket of up to 10
   stocks, by historical simulation and Monte Carlo. The nightly QAE estimate of
   one basket's tail probability, and VaR found by bisection.
7. *Portfolios:* a long-only efficient frontier for 3-15 stocks, and the "hold K
   stocks" QUBO with its matrix, an exact brute force, and the nightly QAOA result
   compared with the optimum.
8. *Readiness scorecard:* a seven-step check per use case, ending in Promising /
   Open question / Not yet useful.
9. *The nightly run:* date, runtime, package versions, qubits, circuit depth and
   circuit diagrams.
10. *Why it's not ready yet.*
11. *A security note for investors:* Shor's algorithm and NIST's post-quantum
    standards.
12. *Glossary, a 9-week study path and references.*

The maths in `docs/assets/quantum.js` is tested under Node.js
(`tests/test_quantum_js.py`):
- Black-Scholes against Hull's reference case and scipy;
- Monte Carlo converging at 1/sqrt(N);
- VaR, CVaR and the Monte Carlo VaR against numpy;
- the frontier against scipy's SLSQP;
- the QUBO and brute force against Python.

**Nightly quantum simulations** (`quant/web/quantum.py`). These use Qiskit's
statevector simulator only: no quantum hardware, no accounts and no keys.
- *Option pricing:* iterative amplitude estimation of at-the-money European calls
  on AAPL, MSFT and NVDA at 30, 90 and 180 days. It uses a 5-qubit lognormal model
  and reports the price, a 95% interval, oracle queries and circuit depth. These
  sit next to Black-Scholes, Monte Carlo, the circuit's exact value and the exact
  value on the 32-price grid.
- *Risk:* the tail probability of a 5-stock basket at its historical 95% VaR, with
  the return histogram loaded into 5 qubits, and VaR by bisection.
- *Portfolio choice:* QAOA (2 layers, COBYLA) on the cardinality QUBO for 6 stocks,
  with K = 3, compared with brute force.

The export runs it in a subprocess with a 5-minute limit; it takes about 2.5
minutes here. The module replaces `data/quantum.json` only when every job
succeeds. The export then copies the last good file into the site, so a failed or
timed-out run leaves the previous night's results online. With no file at all,
the page says the results aren't published yet, and every classical part still
works. `tests/test_quantum_job.py` covers the failure paths and runs small real
simulations.

```bash
pip install -r requirements-quantum.txt    # pinned: qiskit 2.6.1, qiskit-algorithms 0.4.0,
                                           # qiskit-finance 0.4.1, qiskit-optimization 0.7.0
python -m quant.web.quantum                # run the simulations alone (~2.5 min)
python -m quant.web.export --no-quantum    # export without re-running them
```

*Limits.* Every quantum number is labelled "Simulated on a classical computer -
educational, not a trading signal".
- The circuits are tiny: 32 price points and 6 stocks. The deepest option circuit
  has about 190,000 layers, far beyond today's noisy hardware.
- At this size QAE needs about as many queries as Monte Carlo needs samples, and
  QAOA does no better than a random valid portfolio.
- The page says plainly that no practical quantum advantage on a real finance
  problem has been shown as of 2026.

**Data sources and keys:**
- *No key needed:* prices, fundamentals and analytics come from the nightly
  export, and crypto charts stream from Binance's public market data
  (`data-api.binance.vision`, `data-stream.binance.vision`).
- *Optional Finnhub key:* entered in ⚙ on the site, it adds live US trades in
  Live, plus live quotes, recommendation trends and reported statements in
  Financials. It also enables lookups for US tickers outside the universe. The key
  stays in that visitor's browser and is sent only to finnhub.io. Nothing is
  stored in the repository, because anyone can read a key placed in a public site.
- *Yahoo:* Yahoo Finance has no browser API (no CORS), so symbols outside the
  universe can't be fetched from it live.

**How it works:**
- *Code:* the site's code is versioned on `main` under `docs/`:
  - `index.html`, `about.html`, `privacy.html` and `404.html`
  - `assets/app.js`: the pages
  - `assets/quant.js`: statistics, factor models and indicators
  - `assets/quantum.js`: the Quantum page and its maths (state-vector simulator,
    option pricing, VaR, frontier, QUBO)
  - `assets/live.js`: the Pro chart (Lightweight Charts v5, Binance and Finnhub
    WebSockets, CNBC polling, studies, drawings, shortcuts)
  - `assets/app.css`

  It is plain JavaScript, with Plotly and Lightweight Charts from jsDelivr and no
  build step.
- *Data:* `quant/web/export.py` calls the same functions as the Streamlit pages
  (`dashboard/common.py`), so both show the same numbers. It writes JSON to
  `data/site/data/`:
  - `meta`, `global` (the screener), `symbols` (search) and `indices`
  - `sym/<xx>`: about two years of adjusted closes plus fundamentals per symbol,
    in 256 FNV-1a buckets
  - `factors`, `market`, `deep/<T>`, `research` and `quantum`

  The total is about 60 MB raw; GitHub Pages compresses it.
- *Publishing:* `quant/web/publish.py` commits `data/site` as a fresh one-commit
  history and force-pushes it to `gh-pages`. Each day's snapshot replaces the last,
  so data never piles up in the repository. Pushing uses your normal git
  credentials (the GitHub CLI's credential helper here).
- *Schedule:* the Windows scheduled task runs `--run-now --publish-site`, so the site
  updates after each 07:30 KST cycle.

**What differs from the local dashboard:**
- The site is read-only. The watchlist lives in the visitor's browser. Promoting
  a name to the deep tier (news and SEC filings) still happens on the PC.
- Candlesticks, news markers and explained moves cover the deep tier. Other names
  get close-price charts, because the universe store keeps only closes and volume.
- There are no 15-minute bars.

The site republishes data from Yahoo Finance, whose terms allow personal use only.
Publishing it is the owner's decision. To take the site down, disable Pages in the
repository settings or delete the `gh-pages` branch.

## License, security and privacy

- **License:** the code is MIT-licensed ([LICENSE](LICENSE)). Market data, news and
  other third-party content keep their own terms; the website's
  [privacy and data-sources page](https://chanwoo777.github.io/quant-platform/privacy.html)
  lists each source and credits it.
- **Security:** report problems privately, as described in [SECURITY.md](SECURITY.md).
  No keys or secrets belong in the repository; local settings live in `.env`, which git
  ignores.
- **Privacy:** the website has no server, accounts, cookies or analytics. Settings stay
  in the visitor's browser, and the privacy page lets visitors clear them. The page also
  lists every service the browser contacts.
- **Tests on every push:** `.github/workflows/tests.yml` runs `python -m pytest` on
  Python 3.14 with Node.js 24, for every push to `main` and every pull request.
  - It installs `requirements.txt` without torch and transformers (the tests use the
    lexicon sentiment scorer, so CI never downloads FinBERT), plus
    `requirements-quantum.txt`.
  - The dashboard smoke tests skip there, because there is no local database.
  - The actions are pinned to commit SHAs, and the job can only read the repository.
- **Dependabot:** `.github/dependabot.yml` opens weekly pull requests for outdated
  Python packages (Qiskit grouped on its own) and actions, and the tests check each one.
  The JavaScript libraries loaded from jsDelivr (Plotly 2.35.2, Lightweight Charts 5.2.1)
  are pinned in the HTML and JS and updated by hand.
