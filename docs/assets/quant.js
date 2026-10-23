/* Quant library for the website (no DOM): statistics, OLS with Newey-West errors, Fama-French
 * regressions (mirroring quant/quant_models.py), indicators, performance metrics and a modular
 * backtesting engine with pluggable strategies. Loaded as window.Q in the browser and as a
 * CommonJS module in Node (tests/test_site_js.py checks parity with the Python models).
 */
(function (root) {
  "use strict";
  const TD = 252;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);

  // ------------------------------------------------------------------------------------------
  // Statistics and linear algebra
  // ------------------------------------------------------------------------------------------
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  function variance(a, ddof = 1) {
    if (a.length <= ddof) return NaN;
    const m = mean(a);
    return sum(a.map((x) => (x - m) ** 2)) / (a.length - ddof);
  }
  const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));
  function covariance(a, b, ddof = 1) {
    const ma = mean(a), mb = mean(b);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
    return s / (a.length - ddof);
  }
  function invert(M) {
    // Gauss-Jordan with partial pivoting; small dense matrices only.
    const n = M.length, A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-14) throw new Error("singular matrix");
      [A[c], A[p]] = [A[p], A[c]];
      const piv = A[c][c];
      for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map((row) => row.slice(n));
  }

  /** OLS of y on X (rows include the constant column). Newey-West (Bartlett) covariance with
   * `lags` lags and no small-sample correction, matching statsmodels' cov_type="HAC" defaults. */
  function ols(y, X, { lags = 5, hac = true } = {}) {
    const n = y.length, k = X[0].length;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
    for (let t = 0; t < n; t++) {
      const x = X[t];
      for (let i = 0; i < k; i++) {
        Xty[i] += x[i] * y[t];
        for (let j = 0; j < k; j++) XtX[i][j] += x[i] * x[j];
      }
    }
    const inv = invert(XtX);
    const coef = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
    const resid = y.map((v, t) => v - X[t].reduce((s, x, j) => s + x * coef[j], 0));
    const ym = mean(y), sst = sum(y.map((v) => (v - ym) ** 2)), sse = sum(resid.map((e) => e * e));
    let cov;
    if (hac) {
      const S = Array.from({ length: k }, () => new Array(k).fill(0));
      for (let t = 0; t < n; t++) {
        const u2 = resid[t] * resid[t], x = X[t];
        for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += u2 * x[i] * x[j];
      }
      for (let l = 1; l <= lags; l++) {
        const w = 1 - l / (lags + 1);
        for (let t = l; t < n; t++) {
          const uu = resid[t] * resid[t - l], a = X[t], b = X[t - l];
          for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += w * uu * (a[i] * b[j] + b[i] * a[j]);
        }
      }
      const corr = 1;
      const tmp = inv.map((row) => S[0].map((_, j) => row.reduce((s, v, m) => s + v * S[m][j], 0)));
      cov = tmp.map((row) => inv[0].map((_, j) => corr * row.reduce((s, v, m) => s + v * inv[m][j], 0)));
    } else {
      const s2 = sse / (n - k);
      cov = inv.map((row) => row.map((v) => v * s2));
    }
    const se = cov.map((row, i) => Math.sqrt(row[i]));
    return { coef, se, t: coef.map((c, i) => c / se[i]), r2: 1 - sse / sst, resid, n, k };
  }

  // ------------------------------------------------------------------------------------------
  // Series helpers
  // ------------------------------------------------------------------------------------------
  function returns(values) {
    const out = [NaN];
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1], b = values[i];
      out.push(isNum(a) && isNum(b) && a > 0 ? b / a - 1 : NaN);
    }
    return out;
  }
  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let s = 0, c = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) { s += v; c++; }
      if (i >= n) { const o = values[i - n]; if (isNum(o)) { s -= o; c--; } }
      if (i >= n - 1 && c === n) out[i] = s / n;
    }
    return out;
  }
  function rollingStd(values, n, ddof = 1) {
    const out = new Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
      const w = values.slice(i - n + 1, i + 1);
      if (w.every(isNum)) out[i] = std(w, ddof);
    }
    return out;
  }
  function rsi(values, n = 14) {
    // Wilder's smoothing (the same as quant/analytics.py).
    const out = new Array(values.length).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i < values.length; i++) {
      const d = values[i] - values[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i <= n) {
        gain += g / n; loss += l / n;
        if (i === n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      } else {
        gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    }
    return out;
  }
  function bollinger(values, n = 20, k = 2) {
    const mid = sma(values, n), sd = rollingStd(values, n, 0);  // population sd, like the `ta` library
    return { mid, upper: mid.map((m, i) => (m == null ? null : m + k * sd[i])), lower: mid.map((m, i) => (m == null ? null : m - k * sd[i])) };
  }
  /** Align several {dates, values} series on their common dates. */
  function align(seriesList) {
    const sets = seriesList.map((s) => new Map(s.dates.map((d, i) => [d, s.values[i]])));
    const dates = seriesList[0].dates.filter((d) => sets.every((m) => isNum(m.get(d))));
    return { dates, values: sets.map((m) => dates.map((d) => m.get(d))) };
  }

  // ------------------------------------------------------------------------------------------
  // Fama-French regressions (mirror quant/quant_models.py factor_regression / rolling_exposures)
  // ------------------------------------------------------------------------------------------
  const MODELS = { FF3: ["mkt_rf", "smb", "hml"], Carhart: ["mkt_rf", "smb", "hml", "mom"], FF5: ["mkt_rf", "smb5", "hml", "rmw", "cma"] };
  const FACTOR_LABELS = { mkt_rf: "market", smb: "size", smb5: "size", hml: "value", mom: "momentum", rmw: "profitability", cma: "investment", idiosyncratic: "stock-specific" };

  function tilts(betas, t, alphaT) {
    const out = [], mkt = betas.mkt_rf;
    if (mkt >= 1.2) out.push(`aggressive (market beta ${mkt.toFixed(2)})`);
    else if (mkt <= 0.8) out.push(`defensive (market beta ${mkt.toFixed(2)})`);
    const size = "smb5" in betas ? "smb5" : "smb";
    if (Math.abs(t[size]) >= 2) out.push(betas[size] < 0 ? "large-cap" : "small-cap");
    if (Math.abs(t.hml) >= 2) out.push(betas.hml < 0 ? "growth" : "value");
    if ("mom" in betas && Math.abs(t.mom) >= 2) out.push(betas.mom > 0 ? "momentum" : "anti-momentum");
    if ("rmw" in betas && Math.abs(t.rmw) >= 2) out.push(betas.rmw > 0 ? "robust profitability" : "weak profitability");
    if ("cma" in betas && Math.abs(t.cma) >= 2) out.push(betas.cma > 0 ? "conservative investment" : "aggressive investment");
    if (Math.abs(alphaT) >= 2) out.push(alphaT > 0 ? "significant positive alpha" : "significant negative alpha");
    return out;
  }

  /** Rows where the stock return and every model factor exist (inner join on date, NaNs dropped). */
  function joinFactors(stock, factors, cols) {
    const idx = new Map(factors.d.map((d, i) => [d, i]));
    const rows = [];
    for (let i = 0; i < stock.dates.length; i++) {
      const j = idx.get(stock.dates[i]);
      if (j === undefined) continue;
      const r = stock.returns[i], rf = factors.rf[j], f = cols.map((c) => factors[c][j]);
      if (isNum(r) && isNum(rf) && f.every(isNum)) rows.push({ d: stock.dates[i], r, rf, f });
    }
    return rows;
  }

  /** stock: {dates, returns} (simple daily returns); factors: factors.json (decimals). */
  function factorRegression(stock, factors, model = "FF3", { window = 3 * TD, minObs = 120 } = {}) {
    const cols = MODELS[model];
    const rows = joinFactors(stock, factors, cols).slice(-window);
    if (rows.length < minObs) throw new Error(`only ${rows.length} overlapping days (need ${minObs})`);
    const y = rows.map((x) => x.r - x.rf), X = rows.map((x) => [1, ...x.f]);
    const fit = ols(y, X, { lags: 5 });
    const betas = {}, tStats = {}, se = {}, shares = {}, attribution = { risk_free: mean(rows.map((x) => x.rf)) * TD, alpha: fit.coef[0] * TD };
    const vy = variance(y);
    cols.forEach((c, i) => {
      betas[c] = fit.coef[i + 1]; tStats[c] = fit.t[i + 1]; se[c] = fit.se[i + 1];
      const fc = rows.map((x) => x.f[i]);
      shares[c] = (betas[c] * covariance(fc, y)) / vy;
      attribution[c] = betas[c] * mean(fc) * TD;
    });
    shares.idiosyncratic = 1 - fit.r2;
    const dominant = Object.keys(shares).reduce((a, b) => (shares[b] > shares[a] ? b : a));
    return {
      model, start: rows[0].d, end: rows[rows.length - 1].d, n_obs: rows.length,
      alpha_annual: attribution.alpha, alpha_t: fit.t[0], alpha_se_annual: fit.se[0] * TD,
      betas, t_stats: tStats, se, r_squared: fit.r2, idio_vol_annual: std(fit.resid) * Math.sqrt(TD),
      variance_share: shares, return_attribution: attribution, dominant_driver: FACTOR_LABELS[dominant],
      tilts: tilts(betas, tStats, fit.t[0]),
    };
  }

  function rollingExposures(stock, factors, model = "FF3", { window = TD, step = 21 } = {}) {
    const cols = MODELS[model], rows = joinFactors(stock, factors, cols), out = { d: [], alpha_annual: [] };
    cols.forEach((c) => (out[c] = []));
    for (let end = window; end <= rows.length; end += step) {
      const w = rows.slice(end - window, end);
      const fit = ols(w.map((x) => x.r - x.rf), w.map((x) => [1, ...x.f]), { hac: false });
      out.d.push(w[w.length - 1].d); out.alpha_annual.push(fit.coef[0] * TD);
      cols.forEach((c, i) => out[c].push(fit.coef[i + 1]));
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Performance metrics
  // ------------------------------------------------------------------------------------------
  function drawdowns(equity) {
    let peak = -Infinity, peakI = 0, mdd = 0, from = 0, to = 0;
    const dd = equity.map((v, i) => {
      if (v > peak) { peak = v; peakI = i; }
      const x = v / peak - 1;
      if (x < mdd) { mdd = x; from = peakI; to = i; }
      return x;
    });
    return { dd, mdd, from, to };
  }

  /** Daily strategy returns -> institutional metrics. bench: benchmark daily returns (same dates),
   * rf: daily risk-free rates (same dates, 0 where unknown), trades: [{ret, days}]. */
  function metrics({ dates, rets, bench = null, rf = null, trades = [] }) {
    const n = rets.length, r = rets.map((x) => (isNum(x) ? x : 0)), rfs = r.map((_, i) => (rf && isNum(rf[i]) ? rf[i] : 0));
    const equity = []; let e = 1;
    r.forEach((x) => { e *= 1 + x; equity.push(e); });
    const days = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 864e5;
    const total = equity[n - 1] - 1, years = days / 365.25;
    const ex = r.map((x, i) => x - rfs[i]);
    const vol = std(r) * Math.sqrt(TD);
    const downside = Math.sqrt(mean(ex.map((x) => Math.min(x, 0) ** 2))) * Math.sqrt(TD);
    const { dd, mdd, from, to } = drawdowns(equity);
    const cagr = years > 0 ? (1 + total) ** (1 / years) - 1 : NaN;
    const out = {
      n, start: dates[0], end: dates[n - 1], total, cagr, vol,
      sharpe: (mean(ex) / std(ex)) * Math.sqrt(TD), sortino: (mean(ex) * TD) / downside,
      mdd, mdd_from: dates[from], mdd_to: dates[to], calmar: mdd < 0 ? cagr / -mdd : NaN,
      best_day: Math.max(...r), worst_day: Math.min(...r), pct_up_days: r.filter((x) => x > 0).length / n,
      equity, dd,
    };
    if (bench) {
      const pairs = r.map((x, i) => [x - rfs[i], bench[i] - rfs[i], x - bench[i]]).filter((p) => p.every(isNum));
      if (pairs.length >= 30) {
        const fit = ols(pairs.map((p) => p[0]), pairs.map((p) => [1, p[1]]), { lags: 5 });
        const active = pairs.map((p) => p[2]);
        Object.assign(out, { alpha: fit.coef[0] * TD, alpha_t: fit.t[0], beta: fit.coef[1], r2_bench: fit.r2,
          tracking_error: std(active) * Math.sqrt(TD), information_ratio: (mean(active) / std(active)) * Math.sqrt(TD) });
      }
    }
    const closed = trades.filter((t) => isNum(t.ret) && !t.open);
    const wins = closed.filter((t) => t.ret > 0), losses = closed.filter((t) => t.ret <= 0);
    const avgWin = wins.length ? mean(wins.map((t) => t.ret)) : NaN, avgLoss = losses.length ? mean(losses.map((t) => t.ret)) : NaN;
    Object.assign(out, {
      trades: closed.length, win_rate: closed.length ? wins.length / closed.length : NaN, avg_win: avgWin, avg_loss: avgLoss,
      win_loss_ratio: wins.length && losses.length ? avgWin / Math.abs(avgLoss) : NaN,
      profit_factor: losses.length ? sum(wins.map((t) => t.ret)) / Math.abs(sum(losses.map((t) => t.ret))) : NaN,
      expectancy: closed.length ? mean(closed.map((t) => t.ret)) : NaN,
      avg_hold: closed.length ? mean(closed.map((t) => t.days)) : NaN,
    });
    return out;
  }

  function monthlyReturns(dates, rets) {
    const months = new Map();
    dates.forEach((d, i) => {
      const k = d.slice(0, 7);
      months.set(k, (months.get(k) ?? 1) * (1 + (isNum(rets[i]) ? rets[i] : 0)));
    });
    return [...months].map(([k, g]) => ({ month: k, ret: g - 1 }));
  }

  // ------------------------------------------------------------------------------------------
  // Backtesting engine
  // ------------------------------------------------------------------------------------------
  /**
   * prices: P[t][i] aligned closes; strategy.weights(P, params) returns W[t][i], the target
   * weights decided at the close of day t with data up to t only. The engine rebalances to
   * W[t] at that close (paying cost on |ΔW|) and earns W[t]·R[t+1] the next day, so signals
   * never see the return they trade on. Cash (1 - Σw) earns the risk-free rate.
   */
  function backtest({ dates, symbols, P, strategy, params, costBps = 5, rf = null }) {
    const T = dates.length, N = symbols.length;
    const R = P.map((row, t) => row.map((p, i) => (t ? p / P[t - 1][i] - 1 : 0)));
    const { W, books = symbols.map((s, i) => ({ key: s, members: [i] })), info = {} } = strategy.weights(P, params, { dates, symbols });
    const rets = new Array(T).fill(0), gross = new Array(T).fill(0), turnover = new Array(T).fill(0);
    let prev = new Array(N).fill(0);
    for (let t = 0; t < T; t++) {
      const w = W[t] || prev;
      let r = 0;
      if (t > 0) {
        const held = W[t - 1] || new Array(N).fill(0);
        const net = sum(held);
        r = held.reduce((s, x, i) => s + x * R[t][i], 0) + (1 - net) * (rf && isNum(rf[t]) ? rf[t] : 0);
      }
      const tv = w.reduce((s, x, i) => s + Math.abs(x - prev[i]), 0);
      rets[t] = r - (costBps / 1e4) * tv;
      turnover[t] = tv; gross[t] = w.reduce((s, x) => s + Math.abs(x), 0);
      prev = w;
    }
    // Round trips per book: open while any member has a weight; return on gross exposure.
    const trades = [];
    for (const book of books) {
      let open = null;
      for (let t = 0; t < T; t++) {
        const w = book.members.map((i) => (W[t] ? W[t][i] : 0));
        const g = w.reduce((s, x) => s + Math.abs(x), 0), side = Math.sign(w[0] || w.find((x) => x) || 0);
        if (open && t > open.t0) {
          const held = book.members.map((i) => W[t - 1][i]), hg = held.reduce((s, x) => s + Math.abs(x), 0);
          if (hg > 0) open.growth *= 1 + held.reduce((s, x, k) => s + x * R[t][book.members[k]], 0) / hg;
        }
        const closeNow = open && (g === 0 || side !== open.side);
        if (closeNow) {
          trades.push({ book: book.key, side: open.side > 0 ? "long" : "short", entry: dates[open.t0], exit: dates[t], days: t - open.t0, ret: open.growth - 1 });
          open = null;
        }
        if (!open && g > 0) open = { t0: t, side, growth: 1 };
      }
      if (open) trades.push({ book: book.key, side: open.side > 0 ? "long" : "short", entry: dates[open.t0], exit: dates[T - 1], days: T - 1 - open.t0, ret: open.growth - 1, open: true });
    }
    trades.sort((a, b) => (a.entry < b.entry ? 1 : -1));
    const years = (Date.parse(dates[T - 1]) - Date.parse(dates[0])) / 864e5 / 365.25;
    return { dates, rets, gross, trades, info, turnover_per_year: years > 0 ? sum(turnover) / years : NaN,
      exposure: gross.filter((g) => g > 1e-9).length / T, W };
  }

  // ------------------------------------------------------------------------------------------
  // Strategies: each declares its parameters and returns target weights from data up to t.
  // ------------------------------------------------------------------------------------------
  const zeros = (n) => new Array(n).fill(0);
  const STRATEGIES = [
    {
      id: "buyhold", name: "Buy and hold (equal weight)", minAssets: 1,
      blurb: "Holds every selected asset at an equal weight. The baseline the other strategies have to beat.",
      params: [],
      weights(P) { const N = P[0].length; return { W: P.map(() => new Array(N).fill(1 / N)) }; },
    },
    {
      id: "momentum", name: "Cross-sectional momentum", minAssets: 2,
      blurb: "Every rebalance, ranks the assets by their return from `lookback` to `skip` days ago (Jegadeesh & Titman's 12-1 idea) and holds the top ones equally. Optionally shorts the bottom ones.",
      params: [
        { key: "lookback", label: "Lookback (days)", def: 126, min: 20, max: 504, step: 1 },
        { key: "skip", label: "Skip most recent (days)", def: 21, min: 0, max: 63, step: 1 },
        { key: "top", label: "Assets to hold", def: 3, min: 1, max: 50, step: 1 },
        { key: "rebalance", label: "Rebalance every (days)", def: 21, min: 1, max: 126, step: 1 },
        { key: "absolute", label: "Only positive momentum", type: "bool", def: true },
        { key: "longShort", label: "Short the weakest (long/short)", type: "bool", def: false },
      ],
      weights(P, p) {
        const T = P.length, N = P[0].length, W = [];
        let cur = zeros(N);
        for (let t = 0; t < T; t++) {
          if (t >= p.lookback && (t - p.lookback) % p.rebalance === 0) {
            const score = P[t].map((_, i) => P[t - p.skip][i] / P[t - p.lookback][i] - 1);
            const order = score.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
            const k = Math.min(p.top, p.longShort ? Math.floor(N / 2) : N);
            cur = zeros(N);
            const longs = order.slice(0, k).filter(([s]) => !p.absolute || s > 0);
            longs.forEach(([, i]) => (cur[i] = (p.longShort ? 0.5 : 1) / k));
            if (p.longShort) order.slice(-k).filter(([s]) => !p.absolute || s < 0).forEach(([, i]) => (cur[i] = -0.5 / k));
          }
          W.push(cur);
        }
        return { W };
      },
    },
    {
      id: "trend", name: "Trend following (moving-average crossover)", minAssets: 1,
      blurb: "Holds an asset while its fast moving average is above its slow one: the 50/200-day rule the platform's regimes use. Each asset gets 1/N of capital; the rest sits in cash.",
      params: [
        { key: "fast", label: "Fast MA (days)", def: 50, min: 5, max: 200, step: 1 },
        { key: "slow", label: "Slow MA (days)", def: 200, min: 20, max: 400, step: 1 },
      ],
      weights(P, p) {
        const N = P[0].length, cols = P[0].map((_, i) => P.map((row) => row[i]));
        const fast = cols.map((c) => sma(c, p.fast)), slow = cols.map((c) => sma(c, p.slow));
        return { W: P.map((_, t) => cols.map((_, i) => (fast[i][t] != null && slow[i][t] != null && fast[i][t] > slow[i][t] ? 1 / N : 0))) };
      },
    },
    {
      id: "meanrev", name: "Mean reversion (Bollinger z-score)", minAssets: 1,
      blurb: "Buys an asset when it closes `entry` standard deviations below its `window`-day average and sells when it reverts to within `exit` of the mean or after `max hold` days. Optionally shorts the mirror case.",
      params: [
        { key: "window", label: "Window (days)", def: 20, min: 5, max: 120, step: 1 },
        { key: "entry", label: "Entry z", def: 2, min: 0.5, max: 4, step: 0.1, type: "float" },
        { key: "exit", label: "Exit z", def: 0, min: -1, max: 2, step: 0.1, type: "float" },
        { key: "maxHold", label: "Max hold (days)", def: 15, min: 1, max: 120, step: 1 },
        { key: "allowShort", label: "Also short stretched rallies", type: "bool", def: false },
      ],
      weights(P, p) {
        const T = P.length, N = P[0].length, cols = P[0].map((_, i) => P.map((row) => row[i]));
        const mid = cols.map((c) => sma(c, p.window)), sd = cols.map((c) => rollingStd(c, p.window));
        const pos = zeros(N), age = zeros(N), W = [];
        for (let t = 0; t < T; t++) {
          for (let i = 0; i < N; i++) {
            if (mid[i][t] == null || !sd[i][t]) { pos[i] = 0; continue; }
            const z = (cols[i][t] - mid[i][t]) / sd[i][t];
            if (pos[i] !== 0) {
              age[i]++;
              const reverted = pos[i] > 0 ? z >= -p.exit : z <= p.exit;
              if (reverted || age[i] >= p.maxHold) pos[i] = 0;
            } else if (z <= -p.entry) { pos[i] = 1; age[i] = 0; } else if (p.allowShort && z >= p.entry) { pos[i] = -1; age[i] = 0; }
          }
          W.push(pos.map((s) => s / N));
        }
        return { W };
      },
    },
    {
      id: "pairs", name: "Statistical arbitrage (pairs trading)", minAssets: 2, maxAssets: 2,
      blurb: "Trades the spread log(A) − β·log(B), with β from a rolling regression. It goes long the spread when its z-score falls below −entry and short above +entry, then exits near the mean or at the stop. Dollar-neutral. Uses the first two selected assets.",
      params: [
        { key: "lookback", label: "Lookback (days)", def: 60, min: 20, max: 252, step: 1 },
        { key: "entry", label: "Entry |z|", def: 2, min: 0.5, max: 4, step: 0.1, type: "float" },
        { key: "exit", label: "Exit |z|", def: 0.5, min: 0, max: 2, step: 0.1, type: "float" },
        { key: "stop", label: "Stop |z|", def: 4, min: 1, max: 8, step: 0.1, type: "float" },
      ],
      weights(P, p) {
        const T = P.length, N = P[0].length, la = P.map((r) => Math.log(r[0])), lb = P.map((r) => Math.log(r[1]));
        const W = [], zs = new Array(T).fill(null);
        let pos = 0, beta = 1;
        for (let t = 0; t < T; t++) {
          let w = zeros(N);
          if (t >= p.lookback) {
            const a = la.slice(t - p.lookback + 1, t + 1), b = lb.slice(t - p.lookback + 1, t + 1);
            const bNow = covariance(a, b) / variance(b);
            const hedge = pos === 0 ? bNow : beta;  // freeze the hedge ratio while a trade is open
            const spread = a.map((x, k) => x - hedge * b[k]);
            const z = (spread[spread.length - 1] - mean(spread)) / std(spread);
            zs[t] = z;
            if (pos !== 0 && (Math.abs(z) <= p.exit || Math.abs(z) >= p.stop || Math.sign(z) === pos)) pos = 0;
            if (pos === 0 && Math.abs(z) >= p.entry && Math.abs(z) < p.stop) { pos = z < 0 ? 1 : -1; beta = bNow; }
            if (pos !== 0) { const g = 1 + Math.abs(beta); w[0] = pos / g; w[1] = (-pos * beta) / g; }
          }
          W.push(w);
        }
        // Diagnostics: Engle-Granger ADF t-stat on the full-sample spread, and its half-life.
        const bAll = covariance(la, lb) / variance(lb), spread = la.map((x, k) => x - bAll * lb[k]);
        const ds = spread.slice(1).map((x, k) => x - spread[k]), lag = spread.slice(0, -1);
        const fit = ols(ds, lag.map((x) => [1, x]), { hac: false });
        const rA = returns(P.map((r) => r[0])).slice(1), rB = returns(P.map((r) => r[1])).slice(1);
        return { W, books: [{ key: "pair", members: [0, 1] }], info: {
          hedge_ratio: bAll, adf_t: fit.t[1], half_life: fit.coef[1] < 0 ? -Math.log(2) / Math.log(1 + fit.coef[1]) : Infinity,
          correlation: covariance(rA, rB) / (std(rA) * std(rB)), z: zs } };
      },
    },
  ];

  const Q = { TD, isNum, mean, std, variance, covariance, invert, ols, returns, sma, rollingStd, rsi, bollinger, align,
    MODELS, FACTOR_LABELS, factorRegression, rollingExposures, drawdowns, metrics, monthlyReturns, backtest, STRATEGIES };
  if (typeof module !== "undefined" && module.exports) module.exports = Q;
  else root.Q = Q;
})(typeof window !== "undefined" ? window : globalThis);
