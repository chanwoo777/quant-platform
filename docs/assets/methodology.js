/* Methodology page (#/methodology/<id>): how every score, signal and metric on the site is
 * calculated, written from the code that computes it (file and function named in each entry).
 * Formulas are MathML, which browsers render natively. Every "?" link on the dashboard (mq() in
 * app.js) points at one of these ids.
 */
(function () {
  "use strict";
  // --- MathML helpers ---------------------------------------------------------------------------
  const mi = (x) => `<mi>${x}</mi>`, mn = (x) => `<mn>${x}</mn>`, mo = (x) => `<mo>${x}</mo>`, mt = (x) => `<mtext>${x}</mtext>`;
  const row = (...a) => `<mrow>${a.join("")}</mrow>`;
  const frac = (a, b) => `<mfrac>${row(a)}${row(b)}</mfrac>`;
  const sub = (a, b) => `<msub>${row(a)}${row(b)}</msub>`;
  const sup = (a, b) => `<msup>${row(a)}${row(b)}</msup>`;
  const subsup = (a, b, c) => `<msubsup>${row(a)}${row(b)}${row(c)}</msubsup>`;
  const sqrt = (a) => `<msqrt>${row(a)}</msqrt>`;
  const paren = (...a) => row(mo("("), ...a, mo(")"));
  const math = (...a) => `<math display="block">${row(...a)}</math>`;
  const P = (t) => sub(mi("P"), t);
  const sum = (lo, hi) => (hi ? `<munderover>${mo("∑")}${row(lo)}${row(hi)}</munderover>` : `<munder>${mo("∑")}${row(lo)}</munder>`);
  const mean = (x) => row(mt("mean"), paren(x)), sd = (x) => row(mt("sd"), paren(x));

  const SCHEDULE = "Nightly: the PC that publishes the site refreshes the data after the US close (07:30 KST) and republishes it.";
  const BROWSER = "In your browser, each time the page draws.";

  // [id, group, title, what, formula (MathML or ""), inputs, window, updated, limits, code]
  const E = [
    // ---- Global screener --------------------------------------------------------------------------
    ["returns", "Global screener", "Returns: 1 day, 1 week, 1 month, 3 months, year to date",
      "The change in price over a lookback. Lookbacks count calendar days so stocks and coins (which trade 7 days a week) compare like for like.",
      math(sub(mi("R"), mi("k")), mo("="), frac(P(mi("t")), P(row(mi("t"), mo("−"), mi("k")))), mo("−"), mn("1")),
      "Daily closes in the platform's price store (Yahoo Finance). P<sub>t−k</sub> is the last close on or before k calendar days ago.",
      "1 day (last two closes), 1 week (k = 7), 1 month (30), 3 months (91); year to date from the last close of the previous year.",
      SCHEDULE, "n/a when the history doesn't reach back far enough. Prices are the store's closes, not intraday quotes.", "quant/universe/scoring.py · series_metrics"],
    ["momentum", "Global screener", "Momentum 12-1 and 6-1",
      "The return from 12 (or 6) months ago up to 1 month ago, skipping the latest month (Jegadeesh & Titman, 1993).",
      math(mt("Mom 12-1"), mo("="), frac(P(row(mi("t"), mo("−"), mn("30"), mt(" days"))), P(row(mi("t"), mo("−"), mn("365"), mt(" days")))), mo("−"), mn("1")),
      "Daily closes (Yahoo Finance). 6-1 uses 182 days instead of 365.", "365 or 182 calendar days, skipping the last 30.", SCHEDULE,
      "Calendar days, not trading days; the deep-tier factor score's momentum uses 252 and 21 trading days instead.", "quant/universe/scoring.py · series_metrics"],
    ["moving-averages", "Global screener", "Moving averages, MA spread, distance to the 200-day and crosses",
      "Simple averages of the last 50 and 200 closes. The spread says whether the 50-day is above the 200-day; the alignment needs the price on the same side.",
      math(mt("spread"), mo("="), frac(sub(mt("SMA"), mn("50")), sub(mt("SMA"), mn("200"))), mo("−"), mn("1"), mspace(), mt("dist"), mo("="), frac(P(mi("t")), sub(mt("SMA"), mn("200"))), mo("−"), mn("1")),
      "Daily closes (Yahoo Finance).", "50 and 200 closes; the last golden or death cross is the latest sign change of SMA50 − SMA200 in the stored history.",
      SCHEDULE, "Needs 200 closes (201 for crosses); younger listings show n/a. Alignment: +1 when spread > 0 and price > SMA200, −1 when both are below, else 0.",
      "quant/universe/scoring.py · series_metrics"],
    ["volatility", "Global screener", "Volatility",
      "How much the price swings: the standard deviation of daily returns, annualised.",
      math(mi("σ"), mo("="), sd(row(sub(mi("r"), mi("t")), mo(","), mo("…"), mo(","), sub(mi("r"), row(mi("t"), mo("−"), mn("59"))))), mo("×"), sqrt(mn("252"))),
      "Daily returns from closes (Yahoo Finance); √365 for coins.", "The last 60 daily returns (about three months).", SCHEDULE,
      "Needs 20 returns. The Stock and Financials pages used to label this \"1y\"; it is a 60-day measure.", "quant/universe/scoring.py · series_metrics"],
    ["max-drawdown", "Global screener", "Max drawdown (1 year)",
      "The worst fall from a running peak within the last year.",
      math(mt("MDD"), mo("="), sub(mt("min"), mi("t")), paren(frac(P(mi("t")), row(sub(mt("max"), row(mi("s"), mo("≤"), mi("t"))), P(mi("s")))), mo("−"), mn("1"))),
      "Daily closes (Yahoo Finance).", "Closes in the last 365 calendar days.", SCHEDULE, "A single number; the timing of the fall isn't shown.", "quant/universe/scoring.py · series_metrics"],
    ["rsi", "Global screener", "RSI (14)",
      "Wilder's relative strength index: average gains against average losses over 14 days.",
      math(mt("RSI"), mo("="), mn("100"), mo("−"), frac(mn("100"), row(mn("1"), mo("+"), frac(mi("G"), mi("L")))), mspace(),
        sub(mi("G"), mi("t")), mo("="), frac(row(mn("13"), sub(mi("G"), row(mi("t"), mo("−"), mn("1"))), mo("+"), sub(mi("g"), mi("t"))), mn("14"))),
      "Daily closes (Yahoo Finance); g and l are the day's gain and loss.", "Seeded with the plain average of the first 14 changes among the last 210 closes, then smoothed.",
      SCHEDULE, "Starting from 210 closes rather than the full history, it can differ slightly from the Stock page's RSI, which is computed in your browser from the prices it loads.",
      "quant/universe/scoring.py · _rsi"],
    ["unusual", "Global screener", "Unusual move and its z-score",
      "Flags a day whose move is large in absolute terms, or large for that instrument. The scale is a robust volatility, so one crash doesn't hide the next big move.",
      math(mover(mi("σ"), mo("^")), mo("="), mn("1.4826"), mo("×"), mt("median"), paren(row(mo("|"), sub(mi("r"), mi("i")), mo("−"), mt("median"), paren(mi("r")), mo("|"))), mspace(),
        mi("z"), mo("="), frac(sub(mi("r"), mi("t")), mover(mi("σ"), mo("^")))),
      "Daily returns (Yahoo Finance).", "The 60 returns before today. Unusual if |r| ≥ 8% (coins 20%), or |z| ≥ 3 and |r| ≥ 2% (coins 5%).",
      SCHEDULE, "Needs 31 returns. A rule, not a test: about 9 flags per stock a year in calibration.", "quant/universe/scoring.py · series_metrics"],
    ["pillars", "Global screener", "Pillar scores (trend, momentum, risk, value, quality, analysts, cost)",
      "Each input is ranked against the instrument's peers; a pillar is the average of its inputs' percentiles, from 0 (worst) to 100 (best).",
      math(mi("p"), mo("="), frac(row(mt("rank"), mo("−"), mn("1")), row(mi("n"), mo("−"), mn("1"))), mspace(), mt("pillar"), mo("="), mn("100"), mo("×"), mean(sub(mi("p"), mi("j")))),
      "Trend: MA spread, distance to the 200-day. Momentum: 12-1, 6-1. Risk: volatility (lower better), 1-year drawdown. Value: 1/forward P/E, 1/trailing P/E, 1/P-B, 1/(EV/EBITDA), dividend yield. " +
        "Quality: ROE, profit margin, debt/equity (lower better), revenue and earnings growth. Analysts: the consensus rating (published only as this percentile). Cost (ETFs): expense ratio (lower better). " +
        "Fundamentals and ratings: Yahoo Finance.",
      "Peers: stocks within their market (value and quality within market × sector, falling back to the sector worldwide, then to everyone, when fewer than 15 peers have data); ETFs among ETFs; coins among coins.",
      SCHEDULE, "Ranks, not levels: a stock can rank high in a weak market. Ties get average ranks.", "quant/universe/scoring.py · score_frame, peer_pct"],
    ["composite", "Global screener", "Composite score",
      "The plain average of the pillars that are available.",
      math(mt("composite"), mo("="), frac(row(sum(mi("k")), sub(mt("pillar"), mi("k"))), mt("number of pillars"))),
      "The pillar scores above.", "Needs at least 3 pillars for a stock, 2 for an ETF or coin; otherwise n/a.", SCHEDULE,
      "Equal weights. Backtests in the README found it doesn't predict the next month's return.", "quant/universe/scoring.py · score_frame"],
    ["signal", "Global screener", "Signal: BUY / HOLD / AVOID, and the reason",
      "A mechanical label combining the trend with the composite. It is not a recommendation or a prediction.",
      math(mt("BUY"), mo("⟺"), mt("alignment = +1"), mo("∧"), mt("composite ≥ 60"), mo("∧"), mt("market not in a Bear regime")),
      "MA alignment, the composite score and the market regime.",
      "AVOID: alignment = −1 and composite ≤ 40. HOLD: everything else; N/A without a composite. The reason lists the four pillars furthest from 50 in the signal's direction, plus any unusual move; on this site the analyst phrase shows the Analysts percentile instead of the rating.",
      SCHEDULE, "Not investment advice. A Bear regime pauses BUY labels for the whole market.", "quant/universe/scoring.py · add_signals; quant/web/export.py · public_reason"],
    ["regimes-global", "Global screener", "Market regime cards",
      "One regime per market, from its main index: trend from the moving averages and drawdown, volatility from the VIX (US) or the index's own realised volatility.",
      math(mt("realised vol"), mo("="), sd(row(mt("20 daily returns"))), mo("×"), sqrt(mn("252")), mo("×"), mn("100")),
      "Index closes (Yahoo Finance): S&P 500, TSX, STOXX 600, Nikkei, KOSPI, Hang Seng, TAIEX, Nifty 50, ASX 200, bitcoin; the VIX for the US.",
      "Trend and volatility as in the Markets regime (below), with the same 16 / 24 thresholds applied to realised volatility outside the US. Stance: Risk-On if Bull and not Volatile, Risk-Off if Bear, or Volatile and not Bull, else Neutral.",
      SCHEDULE, "These cards' stance uses only trend and volatility; the Markets page's stance also uses macro data, so the two can differ for the US.", "quant/universe/scoring.py · market_regimes"],
    ["sector-map", "Global screener", "Sector heatmap",
      "The day's moves by sector as a treemap. Tile area is market cap; colour is the change.",
      math(sub(mi("r"), mt("sector")), mo("="), frac(row(sum(mi("i")), sub(mt("cap"), mi("i")), sub(mi("r"), mi("i"))), row(sum(mi("i")), sub(mt("cap"), mi("i"))))),
      "1-day change and market cap (US dollars) of each stock, and its sector field (Yahoo Finance), from the nightly export.",
      "The latest nightly close. Drill-down shows a sector's largest 150 stocks, each coloured by its own change.",
      SCHEDULE + " Not live intraday data.", "Stocks without a change are left out of the average and drawn grey (n/a); without caps, tiles are equal-sized.",
      "docs/assets/quant.js · groupMoves, squarify; docs/assets/app.js · drawSectorMap"],
    // ---- Markets ---------------------------------------------------------------------------------
    ["market-regime", "Markets", "Market regime (S&P 500)",
      "The S&P 500's trend from its moving averages and drawdown, and the market's volatility from the VIX.",
      math(mt("DD"), mo("="), frac(P(mi("t")), row(mt("max"), paren(row(mt("last 252 closes"))))), mo("−"), mn("1")),
      "S&P 500 daily bars and the VIX (Yahoo Finance).",
      "Bull: spread > +1% and price above the 200-day. Bear: (spread < −1% or DD ≤ −20%) and price below the 200-day. Otherwise Sideways. VIX < 16 Calm, ≥ 24 Volatile, else Normal. Labels turn riskier at once but calmer only after 5 days in a row.",
      SCHEDULE, "Thresholds were tuned on 1990–2026 data and can lag turning points.", "quant/analytics.py · classify_regimes, RegimeParams"],
    ["risk-score", "Markets", "Risk score (0 = benign, 1 = stressed)",
      "A weighted average of six stress components; missing components are left out and the weights renormalised.",
      math(mt("risk"), mo("="), frac(row(sum(mi("k")), sub(mi("w"), mi("k")), sub(mi("c"), mi("k"))), row(sum(mt("k known")), sub(mi("w"), mi("k"))))),
      "Trend (Bull 0, Sideways 0.5, Bear 1; weight 0.30), volatility (Calm 0, Normal 0.4, Volatile 1; 0.25), credit stress (Baa − 10y spread ≥ 3.0 or widened ≥ 0.5 pp in 3 months; 0.15), " +
        "labour (Sahm gap ≥ 0.5 pp; 0.15), inverted curve (10y − 2y < 0; 0.075), hot inflation (core CPI ≥ 3% y/y; 0.075). FRED data.",
      "Each macro series counts from its publication date (monthly releases lag 45 days, weekly 7).", SCHEDULE, "Flags are on/off, so the score moves in steps.", "quant/analytics.py · market_regime_history"],
    ["stance", "Markets", "Stance (Risk-On / Neutral / Risk-Off)",
      "The risk score cut into three bands.",
      math(mt("Risk-On"), mo(":"), mt(" risk < 0.33"), mspace(), mt("Risk-Off"), mo(":"), mt(" risk > 0.6")),
      "The risk score.", "Like the trend, the stance turns riskier at once but calmer only after 5 days in a row.", SCHEDULE,
      "Differs from the Global page's per-market stance, which has no macro data.", "quant/analytics.py · market_regime_history"],
    ["fred-tiles", "Markets", "Economic indicator tiles (FRED)",
      "The latest value of each FRED series and its change from a month earlier.",
      math(mi("Δ"), mo("="), sub(mi("x"), mt("latest")), mo("−"), sub(mi("x"), mt("last obs. ≥ 1 month earlier"))),
      "FRED: 10y and 2y Treasury, 10y − 2y, Fed funds, 10y breakeven, core CPI (shown as y/y %), unemployment, jobless claims (thousands), VIX, Baa spread.",
      "Sparklines: two years.", SCHEDULE, "Colours treat a rise as bad for inflation, unemployment, claims, VIX and spreads.", "quant/web/export.py · export_market"],
    // ---- Stock and Financials --------------------------------------------------------------------
    ["indicators", "Stock and Financials pages", "Chart indicators and the Stock page readings",
      "Moving averages, RSI, MACD, Bollinger Bands and the rest follow TradingView's Pine Script built-ins, computed in your browser from the prices it loads.",
      math(sub(mt("EMA"), mi("t")), mo("="), mi("α"), sub(mi("x"), mi("t")), mo("+"), paren(row(mn("1"), mo("−"), mi("α"))), sub(mt("EMA"), row(mi("t"), mo("−"), mn("1"))), mo(","), mspace(), mi("α"), mo("="), frac(mn("2"), row(mi("n"), mo("+"), mn("1")))),
      "About two years of daily bars loaded in your browser from CNBC (Binance for coins). Deep-tier readings (\"Indicator readings\") come from the nightly export, computed with the ta library.",
      "Each indicator's own inputs (for example RSI 14, MACD 12/26/9, Bollinger 20/2 with the population standard deviation).", BROWSER,
      "Two years of history: a 200-day average only covers the later part of the chart. Tested against the ta library in tests/test_site_js.py.", "docs/assets/quant.js · INDICATORS, STUDIES; quant/analytics.py · add_indicators"],
    ["news-sentiment", "Stock and Financials pages", "News tone (FinBERT) and the 1-hour reaction",
      "Each on-topic headline gets a tone score; markers average them per trading session.",
      math(mi("s"), mo("="), mi("P"), paren(mt("positive")), mo("−"), mi("P"), paren(mt("negative")), mo("∈"), mo("["), mo("−"), mn("1"), mo(","), mn("1"), mo("]")),
      "Headlines from news RSS (Google News, Yahoo Finance, CNBC, MarketWatch), scored by FinBERT (a finance lexicon if the model is unavailable).",
      "Markers: headlines after 16:00 ET count for the next session; bullish > 0.15, bearish < −0.15. 1-hour reaction: from the last close before publication to the close one hour into the first bar that trades after it.",
      SCHEDULE, "Headline tone isn't the article's meaning, and the reaction includes everything else that moved the price in that hour.", "quant/ingestion/sentiment.py; quant/web/export.py · _news_markers; quant/ingestion/news_scraper.py · compute_price_reactions"],
    ["explained-moves", "Stock and Financials pages", "Unusual moves and their likely catalyst",
      "Big daily moves of deep-tier stocks, split into market-driven and stock-specific, with the headline that best explains them.",
      math(mt("score"), mo("="), mt("relevance"), mo("×"), mt("timing"), mo("×"), paren(row(mn("0.7"), mo("+"), mn("0.3"), mi("s"), mo("·"), mt("sign"), paren(mi("r"))))),
      "Daily adjusted closes, the S&P 500, and the news archive.",
      "Flag: |r| ≥ 8%, or |z| ≥ 3 and |r| ≥ 2% (robust σ over 60 days, lagged a day). Market-driven when the market move times β (252 days) has the same sign and at least half the size; timing weight 1 during the move, e^(−hours/6) before, 0.6·e^(−hours/12) after.",
      SCHEDULE, "A catalyst is a likely candidate, not proof; headlines must name the company (relevance ≥ 0.4).", "quant/analytics.py · detect_anomalies, match_news, explain"],
    ["deep-scores", "Stock and Financials pages", "Deep-tier factor scores (value, quality, momentum)",
      "Ten metrics from SEC filings and prices, each ranked across the deep-tier stocks, averaged into three pillars and an equal-weighted composite.",
      math(mt("composite"), mo("="), frac(row(sum(mi("k")), sub(mi("w"), mi("k")), sub(mt("pillar"), mi("k"))), row(sum(mt("k known")), sub(mi("w"), mi("k")))), mo(","), mspace(), sub(mi("w"), mi("k")), mo("="), frac(mn("1"), mn("3"))),
      "Value: earnings, FCF, book and sales yields (TTM ÷ market cap). Quality: ROE, cash ROA, low leverage, low accruals. Momentum: 12-1 and 6-1 (252 and 126 trading days, skipping 21). SEC EDGAR and daily prices.",
      "Point in time: only filings public on the date. Banks and insurers (SIC 6000–6799) skip the cash-flow and leverage metrics.",
      SCHEDULE, "Ranked within a small group, so scores are relative to the deep tier only.", "quant/quant_models.py · raw_metrics, composite_scores"],
    ["factor-model", "Stock and Financials pages", "Fama-French factor model and rolling betas",
      "How much of a stock's return comes from the market, size, value (and momentum, profitability, investment) factors.",
      math(sub(mi("r"), mi("t")), mo("−"), sub(mi("rf"), mi("t")), mo("="), mi("α"), mo("+"), sum(mi("k")), sub(mi("β"), mi("k")), sub(mi("f"), row(mi("k"), mo(","), mi("t"))), mo("+"), sub(mi("ε"), mi("t"))),
      "Daily factors and the risk-free rate from the Kenneth R. French Data Library; the stock's daily returns from prices loaded in your browser (the Python table uses the nightly store).",
      "Up to 3 years of overlapping days (at least 120). Rolling betas: windows of min(252, half the sample) days, stepping 21. Alpha a year = α × 252.",
      BROWSER + " The deep-tier table is computed nightly.", "OLS with Newey-West errors (5 lags, no small-sample correction); |t| ≥ 2 counts as significant. The factor library lags 1–2 months, so the window ends there.",
      "docs/assets/quant.js · factorRegression, rollingExposures; quant/quant_models.py · factor_regression"],
    ["strategy-backtests", "Stock and Financials pages", "Academic strategy backtests",
      "Momentum and short-term reversal strategies on the deep tier: equal weight in the top 3 (and short the bottom 3) by the signal.",
      math(mt("Sharpe"), mo("="), frac(row(mean(row(mi("r"), mo("−"), mi("rf"))), mo("×"), mn("252")), row(sd(mi("r")), mo("×"), sqrt(mn("252"))))),
      "Adjusted closes and the French library's risk-free rate.", "Rebalanced every 21 trading days (5 for weekly reversal); costs 5 bps per unit of turnover; weights apply from the next day.",
      SCHEDULE, "Survivorship bias: tested on stocks picked today. The point-in-time S&P 500 results in the README remove most of the edge.", "quant/quant_models.py · backtest_cross_sectional, performance_stats"],
    ["sec-financials", "Stock and Financials pages", "SEC financial statements",
      "Trailing-twelve-month figures from 10-K and 10-Q filings.",
      math(sub(mt("TTM"), mi("x")), mo("="), sum(row(mt("last 4 quarters"))), sub(mi("x"), mi("q")), mo(","), mspace(), sub(mi("x"), mt("Q4")), mo("="), sub(mi("x"), mt("year")), mo("−"), sub(mi("x"), mt("Q1–Q3"))),
      "SEC EDGAR XBRL filings.", "Growth: the latest quarter against the same quarter a year earlier. FCF = operating cash flow − capital expenditure.",
      SCHEDULE, "Deep-tier, US filers only.", "quant/quant_models.py · quarterly_flows, ttm_snapshot"],
    // ---- Compare ---------------------------------------------------------------------------------
    ["cmp-returns", "Compare", "Returns (Compare)",
      "Price change since a date; 3 years is annualised.",
      math(sub(mi("R"), mt("3y")), mo("="), sup(paren(frac(P(mi("t")), P(row(mi("t"), mo("−"), mt("3y"))))), frac(mn("1"), mn("3"))), mo("−"), mn("1")),
      "Daily closes (about two years) and weekly closes (ten years) loaded in your browser from CNBC, or Binance for coins.",
      "1 and 3 months, year to date and 1 year from daily closes; 3 years from weekly closes.", BROWSER,
      "n/a when the history is too short or no source has the symbol (Tokyo and Hong Kong). CNBC's prices may not include dividends.", "docs/assets/quant.js · returnSince"],
    ["cmp-volatility", "Compare", "Volatility (Compare)",
      "The standard deviation of returns over the window, annualised.",
      math(mi("σ"), mo("="), sd(mi("r")), mo("×"), sqrt(mi("m")), mo(","), mspace(), mi("m"), mo("="), mn("252"), mt(" daily, "), mn("52"), mt(" weekly")),
      "Daily returns (1- and 2-year windows) or weekly returns (3 years) from prices loaded in your browser.", "1, 2 or 3 years back from each ticker's last price.", BROWSER,
      "Unlike the screener's 60-day volatility, this uses the whole window.", "docs/assets/quant.js · riskStats"],
    ["cmp-drawdown", "Compare", "Max drawdown (Compare)",
      "The worst fall from a running peak within the window.",
      math(mt("MDD"), mo("="), sub(mt("min"), mi("t")), paren(frac(P(mi("t")), row(sub(mt("max"), row(mi("s"), mo("≤"), mi("t"))), P(mi("s")))), mo("−"), mn("1"))),
      "Closes in the window.", "1, 2 or 3 years.", BROWSER, "Weekly closes for 3 years miss intra-week lows.", "docs/assets/quant.js · maxDrawdown"],
    ["cmp-sharpe", "Compare", "Sharpe ratio",
      "Average return above the risk-free rate, per unit of its volatility, annualised.",
      math(mt("Sharpe"), mo("="), frac(mean(row(mi("r"), mo("−"), mi("rf"))), sd(row(mi("r"), mo("−"), mi("rf")))), mo("×"), sqrt(mi("m"))),
      "Returns as above; the risk-free rate is FRED DGS3MO (3-month T-bill yield) as of each date, ÷ 100 ÷ m.", "The chosen window.", BROWSER,
      "Arithmetic and annualised by √m, so it is noisy over short windows.", "docs/assets/quant.js · riskStats"],
    ["cmp-sortino", "Compare", "Sortino ratio",
      "Like Sharpe, but only falls below the risk-free rate count as risk.",
      math(mt("Sortino"), mo("="), frac(row(mean(mi("x")), mo("×"), mi("m")), row(sqrt(row(mean(sup(row(mt("min"), paren(row(mi("x"), mo(","), mn("0")))), mn("2"))))), mo("×"), sqrt(mi("m")))), mo(","), mspace(), mi("x"), mo("="), mi("r"), mo("−"), mi("rf")),
      "As for Sharpe.", "The chosen window.", BROWSER, "Few down periods make it unstable.", "docs/assets/quant.js · riskStats"],
    ["cmp-beta", "Compare", "Beta vs the S&P 500",
      "How strongly the ticker moves with the S&P 500.",
      math(mi("β"), mo("="), frac(row(mt("cov"), paren(row(mi("r"), mo(","), sub(mi("r"), mi("m"))))), row(mt("var"), paren(sub(mi("r"), mi("m")))))),
      "The ticker's returns and the S&P 500's (CNBC), on the dates both have.", "The chosen window; at least 100 days (40 weeks).", BROWSER,
      "Markets that close before New York opens show muted daily betas.", "docs/assets/quant.js · riskStats"],
    ["cmp-factors", "Compare", "Factor exposures (Compare)",
      "The Fama-French regression above, for the chosen model and window.",
      math(sub(mi("f"), mt("week")), mo("="), row(`<munder>${mo("∏")}${row(mt("days in week"))}</munder>`), paren(row(mn("1"), mo("+"), sub(mi("f"), mt("day")))), mo("−"), mn("1")),
      "As for the factor model; weekly factors are compounded from the daily ones.", "1 or 2 years of daily returns, or 3 years of weekly returns (at least 120 days or 60 weeks), ending where the factor library ends.",
      BROWSER, "Stocks only. Alpha a year = α × 252 (daily) or × 52 (weekly).", "docs/assets/quant.js · factorRegression, weeklyFactors"],
    ["cmp-fundamentals", "Compare", "Fundamentals (Compare)",
      "Each cell names its source: SEC filings for the deep tier, Yahoo Finance otherwise.",
      math(mt("P/E"), mo("="), frac(mt("last price"), mt("TTM diluted EPS")), mspace(), mt("net margin"), mo("="), frac(mt("TTM net income"), mt("TTM revenue"))),
      "SEC: revenue growth (latest quarter y/y), net margin, ROE (TTM net income ÷ equity), debt ÷ equity, P/E. Yahoo: revenue growth, gross margin, operating margin, profit margin, ROE, debt/equity (÷ 100), trailing P/E.",
      "Latest filing or the latest nightly export.", SCHEDULE, "Gross and operating margins come from Yahoo for every name, deep tier included; the nightly refresh cycles through the universe over several days, so a name not refreshed yet shows n/a rather than a guess.", "docs/assets/research.js · fundamentals; quant/universe/fundamentals.py"],
    ["cmp-rebased", "Compare", "Growth of 100",
      "Each ticker rebased to 100 on the first date they all share.",
      math(sub(mi("G"), mi("t")), mo("="), mn("100"), mo("×"), frac(P(mi("t")), P(sub(mi("t"), mn("0"))))), "Prices loaded in your browser.", "The chosen window; daily, or weekly for 3 years.", BROWSER,
      "Price only, without dividends.", "docs/assets/research.js · drawCompareChart"],
    ["correlation", "Compare", "Correlation heatmap",
      "How closely each pair's returns move together, from −1 to +1. Clustering puts similar assets next to each other.",
      math(sub(mi("ρ"), row(mi("i"), mi("j"))), mo("="), frac(row(mt("cov"), paren(row(sub(mi("r"), mi("i")), mo(","), sub(mi("r"), mi("j"))))), row(sub(mi("σ"), mi("i")), sub(mi("σ"), mi("j"))))),
      "Returns on the dates every selected asset shares, from prices loaded in your browser.",
      "3 and 6 months and 1 year of daily returns, or 3 years of weekly returns. Order: average-linkage clustering on 1 − ρ, or alphabetical. Average: the mean over all pairs.",
      BROWSER, "Correlations change over time and rise in crashes; a short window is noisy.", "docs/assets/quant.js · correlationMatrix, clusterOrder, pairStats"],
    // ---- Live --------------------------------------------------------------------------------
    ["live-studies", "Live", "Live chart indicators and investor playbooks",
      "The Pro chart's 26 studies follow Pine Script's built-ins, with your inputs; playbooks are preset combinations.",
      math(sub(mt("RMA"), mi("t")), mo("="), frac(row(paren(row(mi("n"), mo("−"), mn("1"))), sub(mt("RMA"), row(mi("t"), mo("−"), mn("1"))), mo("+"), sub(mi("x"), mi("t"))), mi("n"))),
      "Live bars: Binance (WebSocket), CNBC (polled every 15 s), Finnhub ticks with your key.", "Each study's inputs.", BROWSER,
      "Heikin Ashi candles are drawn from real bars; studies use the real bars too.", "docs/assets/quant.js · STUDIES, PLAYBOOKS; docs/assets/live.js"],
    ["alerts", "Live", "Price alerts",
      "Checks your alerts against the latest price and fires each one once.",
      math(mt("up x%"), mo(":"), mspace(), mn("100"), mo("×"), paren(row(frac(mi("p"), sub(mi("p"), mt("prev"))), mo("−"), mn("1"))), mo("≥"), mi("x")),
      "Stocks, ETFs and indices: CNBC's quote (last price and previous close), or its 1-day chart where there's no quote. Coins: Binance's trading-day ticker (change since 00:00 UTC).",
      "Every 15 seconds while the tab is open, on any page of the site.", BROWSER,
      "Only while the tab is open; background tabs may be checked less often. % alerts need a previous close, which CNBC's 1-day chart doesn't give.", "docs/assets/quant.js · alertHit; docs/assets/live.js · checkAlerts"],
    // ---- Quantum -------------------------------------------------------------------------------
    ["q-black-scholes", "Quantum", "Black-Scholes price and its inputs",
      "The textbook price of a European option on a lognormal stock.",
      math(mi("C"), mo("="), mi("S"), mi("N"), paren(sub(mi("d"), mn("1"))), mo("−"), mi("K"), sup(mi("e"), row(mo("−"), mi("r"), mi("T"))), mi("N"), paren(sub(mi("d"), mn("2"))), mo(","), mspace(),
        sub(mi("d"), mn("1")), mo("="), frac(row(mt("ln"), paren(frac(mi("S"), mi("K"))), mo("+"), paren(row(mi("r"), mo("+"), frac(sup(mi("σ"), mn("2")), mn("2")))), mi("T")), row(mi("σ"), sqrt(mi("T"))))),
      "S: last close; σ: standard deviation of the last 63, 126 or 252 daily log returns × √252 (prices loaded in your browser); r = ln(1 + DGS3MO/100); T = days ÷ 365.",
      "Puts by the mirror formula; d₂ = d₁ − σ√T.", BROWSER, "Assumes constant volatility and no dividends. N(x) uses a Chebyshev erfc fit (error < 1.2 × 10⁻⁷).", "docs/assets/quantum.js · blackScholes, annualVol"],
    ["q-monte-carlo", "Quantum", "Monte Carlo option price",
      "Simulates many terminal prices and averages the discounted payoff.",
      math(sub(mi("S"), mi("T")), mo("="), mi("S"), sup(mi("e"), row(paren(row(mi("r"), mo("−"), frac(sup(mi("σ"), mn("2")), mn("2")))), mi("T"), mo("+"), mi("σ"), sqrt(mi("T")), mi("Z"))), mo(","), mspace(), mt("95% CI"), mo("="), mover(mi("C"), mo("^")), mo("±"), mn("1.96"), frac(mi("s"), sqrt(mi("N")))),
      "The same inputs as Black-Scholes; Z standard normal from a seeded generator.", "1,000 to 1,000,000 paths.", BROWSER, "Error shrinks like 1/√N.", "docs/assets/quantum.js · mcOption"],
    ["q-qae", "Quantum", "Quantum amplitude estimation (nightly, simulated)",
      "Iterative QAE on a 5-qubit lognormal model of the price at expiry; the payoff is encoded in one qubit's probability.",
      math(mover(mi("C"), mo("^")), mo("="), sup(mi("e"), row(mo("−"), mi("r"), mi("T"))), mo("·"), mt("post-process"), paren(mover(mi("a"), mo("^")))),
      "Spot, 6-month volatility and DGS3MO from the platform's own store; strike at the money; 30, 90 and 180 days for AAPL, MSFT and NVDA.",
      "32 prices within ±3 standard deviations; rescaling 0.1; ε = 0.001, α = 0.05, 200 shots per circuit.", SCHEDULE,
      "Simulated on a classical computer, educational, not a trading signal. The error budget separates sampling, payoff encoding and the 32-point grid.", "quant/web/quantum.py · price_option"],
    ["q-var", "Quantum", "VaR and CVaR",
      "The loss not exceeded on 95% (or 99%) of days, and the average loss beyond it.",
      math(mt("VaR"), mo("="), mo("−"), sub(mi("q"), row(mn("1"), mo("−"), mi("α"))), paren(sub(mi("r"), mi("p"))), mo(","), mspace(), mt("CVaR"), mo("="), mo("−"), mean(row(sub(mi("r"), mi("p")), mo("|"), sub(mi("r"), mi("p")), mo("≤"), mo("−"), mt("VaR")))),
      "Daily returns of the basket (weights rebalanced daily) from prices loaded in your browser. Quantile with linear interpolation.",
      "1 or 2 years. 10 days: overlapping 10-day compounded windows; Monte Carlo: 20,000 scenarios from a multivariate normal fitted to log returns (h-day mean hμ, covariance hΣ).",
      BROWSER, "Historical windows are short; the normal fit understates fat tails.", "docs/assets/quantum.js · varCvar, horizon, mcPortfolio"],
    ["q-qae-var", "Quantum", "Tail probability by amplitude estimation (nightly, simulated)",
      "The basket's return histogram is loaded into 5 qubits; a comparator marks returns below a threshold, and QAE estimates that probability.",
      math(mi("P"), paren(row(mi("r"), mo("&lt;"), mi("t"))), mo("="), sum(row(mi("i"), mo("&lt;"), mi("t"))), sub(mi("p"), mi("i"))),
      "500 days of equal-weight returns for AAPL, MSFT, NVDA, AMZN, GOOGL (platform store), in 32 bins.",
      "Threshold: the bin edge nearest the historical 95% VaR (ε = 0.002). VaR by bisection over bin edges (ε = 0.005).", SCHEDULE,
      "Simulated; the 32 bins limit precision.", "quant/web/quantum.py · job_var, tail_problem"],
    ["q-frontier", "Quantum", "Efficient frontier",
      "Long-only, fully invested portfolios with the best return for each level of risk.",
      math(sub(mt("min"), mi("w")), sup(mi("w"), mi("⊤")), mi("Σ"), mi("w"), mo("−"), mi("λ"), sup(mi("μ"), mi("⊤")), mi("w"), mspace(), mt("s.t."), mspace(), mi("w"), mo("≥"), mn("0"), mo(","), sum(mi("i")), sub(mi("w"), mi("i")), mo("="), mn("1")),
      "μ and Σ: mean and covariance of daily simple returns × 252, from prices loaded in your browser.", "λ from 0 to 10^1.5; max Sharpe refined between grid points; Sharpe uses DGS3MO.",
      BROWSER, "Historical means are noisy, so the frontier looks more precise than it is.", "docs/assets/quantum.js · meanVariance, frontier"],
    ["q-qubo", "Quantum", "Hold-K-stocks QUBO and brute force",
      "Choose exactly K stocks, each weighted 1/K, trading risk against return; the constraint becomes a penalty.",
      math(sup(mi("x"), mi("⊤")), paren(frac(mi("Σ"), sup(mi("K"), mn("2")))), mi("x"), mo("−"), frac(mi("λ"), mi("K")), sup(mi("μ"), mi("⊤")), mi("x"), mo("+"), mi("P"), sup(paren(row(sum(mi("i")), sub(mi("x"), mi("i")), mo("−"), mi("K"))), mn("2"))),
      "μ, Σ as for the frontier; x ∈ {0, 1}ⁿ.", "P = 1.05 × (Σ|Σᵢⱼ|/K² + Σ|λμᵢ/K|), enough that every wrong-sized portfolio scores worse than every valid one. Brute force checks all 2ⁿ.",
      BROWSER, "Equal weights only; brute force is fine for 15 stocks, not for 500.", "docs/assets/quantum.js · quboMatrix, bruteForce"],
    ["q-qaoa", "Quantum", "QAOA result (nightly, simulated)",
      "QAOA with 2 layers samples portfolios; the page compares it with the exact optimum.",
      math(mt("ratio"), mo("="), frac(row(sub(mi("f"), mt("worst")), mo("−"), mi("E"), mo("["), mi("f"), mo("|"), mt("valid"), mo("]")), row(sub(mi("f"), mt("worst")), mo("−"), sub(mi("f"), mt("best"))))),
      "The QUBO of AAPL, MSFT, NVDA, AMZN, GOOGL, META (K = 3, λ = 0.5) from the platform store.", "COBYLA (300 iterations, fixed start), 4,096 shots.",
      SCHEDULE, "Simulated. Compare P(optimum) with 1/C(n, K) and P(valid) with C(n, K)/2ⁿ, what random guessing gives.", "quant/web/quantum.py · job_qaoa"],
  ];
  function mspace() { return '<mspace width="1.2em"/>'; }
  function mover(a, b) { return `<mover>${row(a)}${row(b)}</mover>`; }

  const ids = E.map((e) => e[0]);
  const groups = [...new Set(E.map((e) => e[1]))];

  function view(el, arg) {
    el.innerHTML = `
      <h1>Methodology</h1>
      <p class="soft q-lede">How every score, signal and metric on this site is calculated, written from the code that computes it. Each entry names the
        file and function, its inputs and their source, the window, how often it updates, and what it can't tell you. A <span class="mq">?</span> next to a number
        on the dashboard links here. Research only, not investment advice.</p>
      <nav class="m-toc" aria-label="Methodology contents">${groups.map((g) => `<div><b>${esc(g)}</b>${E.filter((e) => e[1] === g).map((e) =>
        `<a href="#/methodology/${e[0]}">${esc(e[2])}</a>`).join("")}</div>`).join("")}</nav>
      ${groups.map((g) => `<h2>${esc(g)}</h2>${E.filter((e) => e[1] === g).map(([id, , title, what, formula, inputs, windowText, updated, limits, code]) => `
        <section class="card m-entry" id="m-${id}">
          <h3>${esc(title)}</h3>
          <p>${esc(what)}</p>
          ${formula ? `<div class="m-formula">${formula}</div>` : ""}
          <dl>
            <dt>Inputs and source</dt><dd>${inputs}</dd>
            <dt>Window</dt><dd>${esc(windowText)}</dd>
            <dt>Updated</dt><dd>${esc(updated)}</dd>
            <dt>Limitations</dt><dd>${esc(limits)}</dd>
            <dt>Code</dt><dd><code>${esc(code)}</code></dd>
          </dl>
        </section>`).join("")}`).join("")}`;
    if (arg) {
      const target = document.getElementById(`m-${arg}`);
      if (target) { target.classList.add("m-target"); target.scrollIntoView({ block: "start" }); }
    }
    // In-page contents links move the hash, which re-renders and scrolls to the entry.
  }
  window.METHOD = { view, ids };
})();
