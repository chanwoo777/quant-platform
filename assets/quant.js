/* Quant library for the website (no DOM): statistics, OLS with Newey-West errors, Fama-French
 * regressions (mirroring quant/quant_models.py) and indicators. Loaded as window.Q in the browser
 * and as a CommonJS module in Node (tests/test_site_js.py checks parity with the Python models).
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
  // ------------------------------------------------------------------------------------------
  // TradingView-style indicators. Each follows the Pine Script built-in of the same name, so
  // values match TradingView's charts once past the warm-up bars (tests/test_site_js.py).
  // ------------------------------------------------------------------------------------------
  /** ta.ema: alpha = 2/(n+1), seeded with the first value. */
  function ema(values, n) {
    const a = 2 / (n + 1), out = new Array(values.length).fill(null);
    let e = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) e = e === null ? v : a * v + (1 - a) * e;
      out[i] = e;
    }
    return out;
  }
  /** ta.rma (Wilder's smoothing): alpha = 1/n, seeded with the SMA of the first n values. */
  function rma(values, n) {
    const out = new Array(values.length).fill(null), seed = [];
    let r = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isNum(v)) {
        if (r === null) { seed.push(v); if (seed.length === n) r = mean(seed); }
        else r = (r * (n - 1) + v) / n;
      }
      out[i] = r;
    }
    return out;
  }
  function rolling(values, n, fn) {
    const out = new Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
      const w = values.slice(i - n + 1, i + 1);
      if (w.every(isNum)) out[i] = fn(w);
    }
    return out;
  }
  const highest = (v, n) => rolling(v, n, (w) => Math.max(...w));
  const lowest = (v, n) => rolling(v, n, (w) => Math.min(...w));
  /** ta.tr: true range; the first bar is high - low when handleNa, else missing. */
  function trueRange(h, l, c, handleNa = true) {
    return h.map((hi, i) => (i === 0 ? (handleNa ? hi - l[0] : null)
      : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  }
  const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c, true), n);
  function macd(c, fast = 12, slow = 26, signal = 9) {
    const f = ema(c, fast), s = ema(c, slow);
    const line = f.map((x, i) => (x === null || s[i] === null ? null : x - s[i]));
    const sig = ema(line, signal);
    return { macd: line, signal: sig, hist: line.map((x, i) => (x === null || sig[i] === null ? null : x - sig[i])) };
  }
  /** ta.stoch: 100 * (src - lowest(low, n)) / (highest(high, n) - lowest(low, n)). */
  function stoch(src, h, l, n) {
    const hh = highest(h, n), ll = lowest(l, n);
    return src.map((v, i) => (hh[i] === null || ll[i] === null || !isNum(v) ? null : hh[i] === ll[i] ? 0 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
  }
  function stochastic(h, l, c, n = 14, smoothK = 1, smoothD = 3) {
    const k = smoothK > 1 ? sma(stoch(c, h, l, n), smoothK) : stoch(c, h, l, n);
    return { k, d: sma(k, smoothD) };
  }
  function stochRsi(c, rsiLen = 14, stochLen = 14, smoothK = 3, smoothD = 3) {
    const r = rsi(c, rsiLen), k = sma(stoch(r, r, r, stochLen), smoothK);
    return { k, d: sma(k, smoothD) };
  }
  /** Directional Movement Index (TradingView's DMI script): +DI, -DI and ADX. */
  function dmi(h, l, c, diLen = 14, adxLen = 14) {
    const plusDM = h.map((x, i) => { if (!i) return null; const up = x - h[i - 1], dn = l[i - 1] - l[i]; return up > dn && up > 0 ? up : 0; });
    const minusDM = h.map((x, i) => { if (!i) return null; const up = x - h[i - 1], dn = l[i - 1] - l[i]; return dn > up && dn > 0 ? dn : 0; });
    const trur = rma(trueRange(h, l, c, false), diLen), pr = rma(plusDM, diLen), mr = rma(minusDM, diLen);
    const plus = pr.map((x, i) => (x === null || !trur[i] ? null : (100 * x) / trur[i]));
    const minus = mr.map((x, i) => (x === null || !trur[i] ? null : (100 * x) / trur[i]));
    const dx = plus.map((p, i) => (p === null || minus[i] === null ? null : Math.abs(p - minus[i]) / (p + minus[i] === 0 ? 1 : p + minus[i])));
    return { plus, minus, adx: rma(dx, adxLen).map((x) => (x === null ? null : 100 * x)) };
  }
  /** ta.supertrend(factor, atrPeriod) on hl2. direction -1 = up-trend (line below price). */
  function supertrend(h, l, c, period = 10, factor = 3) {
    const a = atr(h, l, c, period), n = c.length, line = new Array(n).fill(null), dir = new Array(n).fill(null);
    let prevUpper = null, prevLower = null, prevST = null;
    for (let i = 0; i < n; i++) {
      if (a[i] === null) continue;
      const src = (h[i] + l[i]) / 2;
      let upper = src + factor * a[i], lower = src - factor * a[i];
      const pl = prevLower ?? 0, pu = prevUpper ?? 0;
      lower = lower > pl || (i > 0 && c[i - 1] < pl) ? lower : pl;
      upper = upper < pu || (i > 0 && c[i - 1] > pu) ? upper : pu;
      let d;
      if (a[i - 1] === null || a[i - 1] === undefined) d = 1;
      else if (prevST === prevUpper) d = c[i] > upper ? -1 : 1;
      else d = c[i] < lower ? 1 : -1;
      line[i] = d === -1 ? lower : upper; dir[i] = d;
      prevUpper = upper; prevLower = lower; prevST = line[i];
    }
    return { line, dir };
  }
  /** ta.sar(start, inc, max): Wilder's parabolic stop-and-reverse (TradingView's reference code). */
  function psar(h, l, c, start = 0.02, inc = 0.02, max = 0.2) {
    const n = c.length, out = new Array(n).fill(null);
    let result = null, maxMin = null, acc = null, below = null;
    for (let i = 1; i < n; i++) {
      let first = false;
      if (i === 1) {
        if (c[1] > c[0]) { below = true; maxMin = h[1]; result = l[0]; } else { below = false; maxMin = l[1]; result = h[0]; }
        first = true; acc = start;
      }
      result += acc * (maxMin - result);
      if (below) {
        if (result > l[i]) { first = true; below = false; result = Math.max(h[i], maxMin); maxMin = l[i]; acc = start; }
      } else if (result < h[i]) { first = true; below = true; result = Math.min(l[i], maxMin); maxMin = h[i]; acc = start; }
      if (!first) {
        if (below) { if (h[i] > maxMin) { maxMin = h[i]; acc = Math.min(acc + inc, max); } }
        else if (l[i] < maxMin) { maxMin = l[i]; acc = Math.min(acc + inc, max); }
      }
      if (below) { result = Math.min(result, l[i - 1]); if (i > 1) result = Math.min(result, l[i - 2]); }
      else { result = Math.max(result, h[i - 1]); if (i > 1) result = Math.max(result, h[i - 2]); }
      out[i] = result;
    }
    return out;
  }
  /** Ichimoku Cloud (9, 26, 52, displacement 26). Leading spans are moved forward and the
   * lagging span back by displacement - 1 bars, as TradingView plots them; the part of the
   * cloud beyond the last bar is left out. */
  function ichimoku(h, l, c, conv = 9, base = 26, spanB = 52, disp = 26) {
    const mid = (n) => { const hh = highest(h, n), ll = lowest(l, n); return hh.map((x, i) => (x === null || ll[i] === null ? null : (x + ll[i]) / 2)); };
    const cl = mid(conv), bl = mid(base), b = mid(spanB), off = disp - 1;
    const a = cl.map((x, i) => (x === null || bl[i] === null ? null : (x + bl[i]) / 2));
    const fwd = (v) => v.map((_, i) => (i - off >= 0 ? v[i - off] : null));
    return { conversion: cl, base: bl, spanA: fwd(a), spanB: fwd(b), lagging: c.map((_, i) => (i + off < c.length ? c[i + off] : null)) };
  }
  /** Session VWAP of hlc3; sessionKey(i) changes where a new session starts. */
  function vwap(h, l, c, v, sessionKey) {
    const out = new Array(c.length).fill(null);
    let key = null, pv = 0, vol = 0;
    for (let i = 0; i < c.length; i++) {
      const k = sessionKey(i);
      if (k !== key) { key = k; pv = 0; vol = 0; }
      pv += ((h[i] + l[i] + c[i]) / 3) * (v[i] || 0); vol += v[i] || 0;
      out[i] = vol ? pv / vol : (h[i] + l[i] + c[i]) / 3;
    }
    return out;
  }
  function obv(c, v) {
    let s = 0;
    return c.map((x, i) => { if (i) s += Math.sign(x - c[i - 1]) * (v[i] || 0); return s; });
  }

  /**
   * Indicator catalogue shared by every chart on the site. `needs`: the data it requires
   * (close only, high/low/close, or volume too). `tv`: the matching studies of TradingView's
   * embeddable chart. `calc(d)` takes {time, open, high, low, close, volume} arrays and returns
   * lines (with palette colour keys), an optional histogram, and guide levels for panes.
   */
  const INDICATORS = [
    { id: "sma", name: "SMA 50/200", kind: "overlay", needs: "c", def: true,
      tv: [{ id: "MASimple@tv-basicstudies", inputs: { length: 50 } }, { id: "MASimple@tv-basicstudies", inputs: { length: 200 } }],
      calc: (d) => ({ lines: [{ name: "SMA 50", values: sma(d.close, 50), color: "ma50" }, { name: "SMA 200", values: sma(d.close, 200), color: "ma200" }] }) },
    { id: "ema", name: "EMA 9/21", kind: "overlay", needs: "c",
      tv: [{ id: "MAExp@tv-basicstudies", inputs: { length: 9 } }, { id: "MAExp@tv-basicstudies", inputs: { length: 21 } }],
      calc: (d) => ({ lines: [{ name: "EMA 9", values: ema(d.close, 9), color: "s3" }, { name: "EMA 21", values: ema(d.close, 21), color: "s1" }] }) },
    { id: "bb", name: "Bollinger 20,2", kind: "overlay", needs: "c", tv: ["BB@tv-basicstudies"],
      calc: (d) => { const b = bollinger(d.close, 20, 2); return { lines: [{ name: "BB upper", values: b.upper, color: "muted" }, { name: "BB basis", values: b.mid, color: "s4", dash: true }, { name: "BB lower", values: b.lower, color: "muted" }], fill: [0, 2] }; } },
    { id: "vwap", name: "VWAP", kind: "overlay", needs: "hlcv", intraday: true, tv: ["VWAP@tv-basicstudies"],
      calc: (d) => ({ lines: [{ name: "VWAP", values: vwap(d.high, d.low, d.close, d.volume, (i) => d.session(i)), color: "s4" }] }) },
    { id: "ichimoku", name: "Ichimoku", kind: "overlay", needs: "hlc", tv: ["IchimokuCloud@tv-basicstudies"],
      calc: (d) => { const k = ichimoku(d.high, d.low, d.close); return { lines: [{ name: "Conversion", values: k.conversion, color: "s0" },
        { name: "Base", values: k.base, color: "s7" }, { name: "Span A", values: k.spanA, color: "s2" }, { name: "Span B", values: k.spanB, color: "down" },
        { name: "Lagging", values: k.lagging, color: "muted" }], fill: [2, 3] }; } },
    { id: "supertrend", name: "Supertrend 10,3", kind: "overlay", needs: "hlc", tv: ["STD;Supertrend"],
      calc: (d) => { const s = supertrend(d.high, d.low, d.close, 10, 3);
        return { lines: [{ name: "Supertrend up", values: s.line.map((v, i) => (s.dir[i] === -1 ? v : null)), color: "good" },
          { name: "Supertrend down", values: s.line.map((v, i) => (s.dir[i] === 1 ? v : null)), color: "bad" }],
          segments: { name: "Supertrend", values: s.line, up: s.dir.map((x) => x === -1) } }; } },
    { id: "psar", name: "Parabolic SAR", kind: "overlay", needs: "hlc", tv: ["PSAR@tv-basicstudies"],
      calc: (d) => ({ lines: [{ name: "SAR", values: psar(d.high, d.low, d.close), color: "s0", dots: true }] }) },
    { id: "rsi", name: "RSI 14", kind: "pane", needs: "c", def: true, tv: ["RSI@tv-basicstudies"],
      calc: (d) => ({ lines: [{ name: "RSI 14", values: rsi(d.close, 14), color: "s6" }], levels: [30, 70], range: [0, 100] }) },
    { id: "macd", name: "MACD 12,26,9", kind: "pane", needs: "c", def: true, tv: ["MACD@tv-basicstudies"],
      calc: (d) => { const m = macd(d.close); return { lines: [{ name: "MACD", values: m.macd, color: "s0" }, { name: "Signal", values: m.signal, color: "s1" }], hist: m.hist, levels: [0] }; } },
    { id: "stochrsi", name: "Stoch RSI", kind: "pane", needs: "c", tv: ["StochasticRSI@tv-basicstudies"],
      calc: (d) => { const s = stochRsi(d.close); return { lines: [{ name: "StochRSI %K", values: s.k, color: "s0" }, { name: "StochRSI %D", values: s.d, color: "s1" }], levels: [20, 80], range: [0, 100] }; } },
    { id: "stoch", name: "Stochastic 14,3,3", kind: "pane", needs: "hlc", tv: ["Stochastic@tv-basicstudies"],
      calc: (d) => { const s = stochastic(d.high, d.low, d.close, 14, 3, 3); return { lines: [{ name: "Stoch %K", values: s.k, color: "s0" }, { name: "Stoch %D", values: s.d, color: "s1" }], levels: [20, 80], range: [0, 100] }; } },
    { id: "atr", name: "ATR 14", kind: "pane", needs: "hlc", tv: ["ATR@tv-basicstudies"],
      calc: (d) => ({ lines: [{ name: "ATR 14", values: atr(d.high, d.low, d.close, 14), color: "s7" }] }) },
    { id: "adx", name: "ADX / DMI 14", kind: "pane", needs: "hlc", tv: ["DM@tv-basicstudies"],
      calc: (d) => { const m = dmi(d.high, d.low, d.close); return { lines: [{ name: "ADX", values: m.adx, color: "ink2" }, { name: "+DI", values: m.plus, color: "good" }, { name: "−DI", values: m.minus, color: "bad" }], levels: [25] }; } },
    { id: "obv", name: "OBV", kind: "pane", needs: "cv", tv: ["STD;On_Balance_Volume"],
      calc: (d) => ({ lines: [{ name: "OBV", values: obv(d.close, d.volume), color: "s0" }] }) },
  ];
  // ------------------------------------------------------------------------------------------
  // More TradingView built-ins for the Pro chart (parametric studies below).
  // ------------------------------------------------------------------------------------------
  /** ta.wma: linearly weighted, the newest bar weighs n. */
  function wma(values, n) {
    const out = new Array(values.length).fill(null), den = (n * (n + 1)) / 2;
    for (let i = n - 1; i < values.length; i++) {
      let s = 0, okw = true;
      for (let k = 0; k < n; k++) { const v = values[i - k]; if (!isNum(v)) { okw = false; break; } s += v * (n - k); }
      if (okw) out[i] = s / den;
    }
    return out;
  }
  /** ta.hma: wma(2 * wma(src, n/2) - wma(src, n), floor(sqrt(n))). */
  function hma(values, n) {
    const half = wma(values, Math.max(1, Math.floor(n / 2))), full = wma(values, n);
    return wma(half.map((h, i) => (h === null || full[i] === null ? null : 2 * h - full[i])), Math.max(1, Math.floor(Math.sqrt(n))));
  }
  /** ta.vwma: sma(src * volume) / sma(volume). */
  function vwma(values, volume, n) {
    const pv = sma(values.map((v, i) => v * (volume[i] || 0)), n), vv = sma(volume.map((x) => x || 0), n);
    return pv.map((x, i) => (x === null || !vv[i] ? null : x / vv[i]));
  }
  function maOf(type, values, n, volume) {
    if (type === "EMA") return ema(values, n);
    if (type === "WMA") return wma(values, n);
    if (type === "HMA") return hma(values, n);
    if (type === "VWMA" && volume) return vwma(values, volume, n);
    if (type === "RMA") return rma(values, n);
    return sma(values, n);
  }
  /** Price source by name, as in TradingView's "Source" input. */
  function source(d, s = "close") {
    if (s === "hl2") return d.high.map((h, i) => (h + d.low[i]) / 2);
    if (s === "hlc3") return d.high.map((h, i) => (h + d.low[i] + d.close[i]) / 3);
    if (s === "ohlc4") return d.high.map((h, i) => (d.open[i] + h + d.low[i] + d.close[i]) / 4);
    return d[s] || d.close;
  }
  /** Keltner Channels (TradingView defaults: EMA 20, ATR 10, multiplier 2). */
  function keltner(h, l, c, length = 20, mult = 2, atrLength = 10) {
    const basis = ema(c, length), range = atr(h, l, c, atrLength);
    return { basis, upper: basis.map((b, i) => (b === null || range[i] === null ? null : b + mult * range[i])),
      lower: basis.map((b, i) => (b === null || range[i] === null ? null : b - mult * range[i])) };
  }
  function donchian(h, l, length = 20) {
    const upper = highest(h, length), lower = lowest(l, length);
    return { upper, lower, basis: upper.map((u, i) => (u === null || lower[i] === null ? null : (u + lower[i]) / 2)) };
  }
  /** Williams %R: -100..0. */
  function willr(h, l, c, length = 14) {
    const hh = highest(h, length), ll = lowest(l, length);
    return c.map((v, i) => (hh[i] === null || ll[i] === null || hh[i] === ll[i] ? null : (100 * (v - hh[i])) / (hh[i] - ll[i])));
  }
  /** Commodity Channel Index: (src - sma) / (0.015 * mean deviation). */
  function cci(src, length = 20) {
    const m = sma(src, length);
    return src.map((v, i) => {
      if (m[i] === null) return null;
      let dev = 0;
      for (let k = 0; k < length; k++) dev += Math.abs(src[i - k] - m[i]);
      dev /= length;
      return dev === 0 ? 0 : (v - m[i]) / (0.015 * dev);
    });
  }
  function roc(src, length = 9) {
    return src.map((v, i) => (i < length || !src[i - length] ? null : (100 * (v - src[i - length])) / src[i - length]));
  }
  /** Money Flow Index on hlc3 (TradingView's ta.mfi). */
  function mfi(h, l, c, v, length = 14) {
    const tp = h.map((x, i) => (x + l[i] + c[i]) / 3), out = new Array(c.length).fill(null);
    for (let i = length; i < c.length; i++) {
      let up = 0, down = 0;
      for (let k = i - length + 1; k <= i; k++) {
        const ch = tp[k] - tp[k - 1], flow = tp[k] * (v[k] || 0);
        if (ch > 0) up += flow; else if (ch < 0) down += flow;
      }
      out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
    }
    return out;
  }
  /** Highest high / lowest low over a calendar window (e.g. 52 weeks), whatever the bar size. */
  function rangeByTime(h, l, t, seconds) {
    const hi = new Array(t.length).fill(null), lo = new Array(t.length).fill(null);
    let start = 0;
    for (let i = 0; i < t.length; i++) {
      while (t[i] - t[start] > seconds) start++;
      let mx = -Infinity, mn = Infinity;
      for (let k = start; k <= i; k++) { if (h[k] > mx) mx = h[k]; if (l[k] < mn) mn = l[k]; }
      hi[i] = mx; lo[i] = mn;
    }
    return { high: hi, low: lo };
  }
  /** Classic floor-trader pivots from the previous period's high, low and close. */
  function pivots(h, l, c, periodKey) {
    const keys = h.map((_, i) => periodKey(i)), out = { P: [], R1: [], S1: [], R2: [], S2: [], R3: [], S3: [] };
    let prev = null, cur = null;
    for (let i = 0; i < h.length; i++) {
      if (!cur || keys[i] !== cur.key) { if (cur) prev = cur; cur = { key: keys[i], h: h[i], l: l[i], c: c[i] }; }
      else { cur.h = Math.max(cur.h, h[i]); cur.l = Math.min(cur.l, l[i]); cur.c = c[i]; }
      if (!prev) { Object.keys(out).forEach((k) => out[k].push(null)); continue; }
      const P = (prev.h + prev.l + prev.c) / 3, r = prev.h - prev.l;
      out.P.push(P); out.R1.push(2 * P - prev.l); out.S1.push(2 * P - prev.h); out.R2.push(P + r); out.S2.push(P - r);
      out.R3.push(prev.h + 2 * (P - prev.l)); out.S3.push(prev.l - 2 * (prev.h - P));
    }
    return out;
  }
  /** VWAP anchored at bar index `from` (hlc3 weighted by volume). */
  function anchoredVwap(h, l, c, v, from) {
    let pv = 0, vol = 0;
    return c.map((x, i) => {
      if (i < from) return null;
      const tp = (h[i] + l[i] + x) / 3;
      pv += tp * (v[i] || 0); vol += v[i] || 0;
      return vol ? pv / vol : tp;
    });
  }

  /**
   * Parametric studies for the Pro chart, modelled on TradingView's built-ins and their default
   * inputs. Each: id, name, group, kind (overlay | pane | volume), needs (c / hlc / hlcv / cv /
   * b = benchmark), params [{key, label, type: int|float|select|date, def, min, max, options}],
   * label(p) for the legend, calc(d, p) -> {lines: [{name, values, color, dash?, dots?, width?}],
   * hist?, levels?, range?, fill?: [lineIndexA, lineIndexB], segments?}. d holds aligned arrays
   * time (UTC seconds), open, high, low, close, volume, plus intraday, session(i), bench?.
   */
  const SRC = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];
  const MA_TYPES = ["SMA", "EMA", "WMA", "HMA", "VWMA", "RMA"];
  const P = {
    len: (def, label = "Length") => ({ key: "length", label, type: "int", def, min: 1, max: 1000 }),
    src: (def = "close") => ({ key: "source", label: "Source", type: "select", options: SRC, def }),
    mult: (def, label = "Multiplier") => ({ key: "mult", label, type: "float", def, min: 0.1, max: 10, step: 0.1 }),
  };
  const STUDIES = [
    // --- trend ---
    { id: "ma", name: "Moving Average", group: "Trend", kind: "overlay", needs: "c",
      params: [{ key: "type", label: "Type", type: "select", options: MA_TYPES, def: "EMA" }, P.len(20), P.src()],
      label: (p) => `${p.type} ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `${p.type} ${p.length}`, values: maOf(p.type, source(d, p.source), p.length, d.volume), color: "s0" }] }) },
    { id: "bb", name: "Bollinger Bands", group: "Volatility", kind: "overlay", needs: "c", params: [P.len(20), P.mult(2, "StdDev"), P.src()],
      label: (p) => `BB ${p.length} ${p.mult}`,
      calc: (d, p) => { const b = bollingerK(source(d, p.source), p.length, p.mult);
        return { lines: [{ name: "Upper", values: b.upper, color: "s0" }, { name: "Basis", values: b.mid, color: "s1" }, { name: "Lower", values: b.lower, color: "s0" }], fill: [0, 2] }; } },
    { id: "keltner", name: "Keltner Channels", group: "Volatility", kind: "overlay", needs: "hlc", params: [P.len(20), P.mult(2), { key: "atr", label: "ATR length", type: "int", def: 10, min: 1, max: 500 }],
      label: (p) => `KC ${p.length} ${p.mult}`,
      calc: (d, p) => { const k = keltner(d.high, d.low, d.close, p.length, p.mult, p.atr);
        return { lines: [{ name: "Upper", values: k.upper, color: "s0" }, { name: "Basis", values: k.basis, color: "s1" }, { name: "Lower", values: k.lower, color: "s0" }], fill: [0, 2] }; } },
    { id: "donchian", name: "Donchian Channels", group: "Trend", kind: "overlay", needs: "hlc", params: [P.len(20)],
      label: (p) => `DC ${p.length}`,
      calc: (d, p) => { const k = donchian(d.high, d.low, p.length);
        return { lines: [{ name: "Upper", values: k.upper, color: "s0" }, { name: "Basis", values: k.basis, color: "s3", dash: true }, { name: "Lower", values: k.lower, color: "s0" }], fill: [0, 2] }; } },
    { id: "vwap", name: "VWAP (session)", group: "Volume", kind: "overlay", needs: "hlcv", intraday: true, params: [],
      label: () => "VWAP",
      calc: (d) => ({ lines: [{ name: "VWAP", values: vwap(d.high, d.low, d.close, d.volume, (i) => d.session(i)), color: "s4", width: 2 }] }) },
    { id: "avwap", name: "Anchored VWAP", group: "Volume", kind: "overlay", needs: "hlcv",
      params: [{ key: "anchor", label: "Anchor date (YYYY-MM-DD, blank = start of year)", type: "date", def: "" }],
      label: (p) => `AVWAP ${p.anchor || "YTD"}`,
      calc: (d, p) => {
        const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
        const anchor = p.anchor || `${iso(d.time[d.time.length - 1]).slice(0, 4)}-01-01`;
        const from = Math.max(0, d.time.findIndex((t) => iso(t) >= anchor));
        return { lines: [{ name: `AVWAP ${anchor}`, values: anchoredVwap(d.high, d.low, d.close, d.volume, from), color: "s6", width: 2 }] };
      } },
    { id: "ichimoku", name: "Ichimoku Cloud", group: "Trend", kind: "overlay", needs: "hlc",
      params: [{ key: "conv", label: "Conversion", type: "int", def: 9, min: 1, max: 200 }, { key: "base", label: "Base", type: "int", def: 26, min: 1, max: 200 },
        { key: "spanB", label: "Leading span B", type: "int", def: 52, min: 1, max: 400 }, { key: "disp", label: "Displacement", type: "int", def: 26, min: 1, max: 200 }],
      label: (p) => `Ichimoku ${p.conv} ${p.base} ${p.spanB} ${p.disp}`,
      calc: (d, p) => { const k = ichimoku(d.high, d.low, d.close, p.conv, p.base, p.spanB, p.disp);
        return { lines: [{ name: "Span A", values: k.spanA, color: "s2" }, { name: "Span B", values: k.spanB, color: "s7" },
          { name: "Conversion", values: k.conversion, color: "s0" }, { name: "Base", values: k.base, color: "s1" }, { name: "Lagging", values: k.lagging, color: "muted" }], fill: [0, 1] }; } },
    { id: "supertrend", name: "Supertrend", group: "Trend", kind: "overlay", needs: "hlc", params: [{ key: "atr", label: "ATR length", type: "int", def: 10, min: 1, max: 500 }, P.mult(3, "Factor")],
      label: (p) => `Supertrend ${p.atr} ${p.mult}`,
      calc: (d, p) => { const s = supertrend(d.high, d.low, d.close, p.atr, p.mult);
        return { lines: [{ name: "Up trend", values: s.line.map((v, i) => (s.dir[i] === -1 ? v : null)), color: "good" }, { name: "Down trend", values: s.line.map((v, i) => (s.dir[i] === 1 ? v : null)), color: "bad" }],
          segments: { name: "Supertrend", values: s.line, up: s.dir.map((x) => x === -1) } }; } },
    { id: "psar", name: "Parabolic SAR", group: "Trend", kind: "overlay", needs: "hlc",
      params: [{ key: "start", label: "Start", type: "float", def: 0.02, min: 0.001, max: 1, step: 0.01 }, { key: "inc", label: "Increment", type: "float", def: 0.02, min: 0.001, max: 1, step: 0.01 },
        { key: "max", label: "Max", type: "float", def: 0.2, min: 0.01, max: 1, step: 0.01 }],
      label: (p) => `SAR ${p.start} ${p.inc} ${p.max}`,
      calc: (d, p) => ({ lines: [{ name: "SAR", values: psar(d.high, d.low, d.close, p.start, p.inc, p.max), color: "s0", dots: true }] }) },
    { id: "pivots", name: "Pivot Points (classic)", group: "Trend", kind: "overlay", needs: "hlc",
      params: [{ key: "period", label: "Period", type: "select", options: ["Auto", "Day", "Week", "Month"], def: "Auto" }],
      label: (p) => `Pivots ${p.period}`,
      calc: (d, p) => {
        const per = p.period === "Auto" ? (d.intraday ? "Day" : "Month") : p.period;
        const key = (i) => { const s = new Date(d.time[i] * 1000).toISOString(); if (per === "Day") return s.slice(0, 10); if (per === "Month") return s.slice(0, 7);
          const t = new Date(d.time[i] * 1000); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
        const k = pivots(d.high, d.low, d.close, key);
        return { lines: [["R3", "bad"], ["R2", "bad"], ["R1", "bad"], ["P", "s3"], ["S1", "good"], ["S2", "good"], ["S3", "good"]].map(([n, col]) => ({ name: n, values: k[n], color: col, dash: n !== "P", width: 1 })), step: true };
      } },
    { id: "hilo", name: "52-Week High/Low", group: "Trend", kind: "overlay", needs: "hlc", params: [{ key: "weeks", label: "Weeks", type: "int", def: 52, min: 1, max: 260 }],
      label: (p) => `${p.weeks}W high/low`,
      calc: (d, p) => { const r = rangeByTime(d.high, d.low, d.time, p.weeks * 7 * 86400);
        return { lines: [{ name: `${p.weeks}W high`, values: r.high, color: "good", dash: true, width: 1 }, { name: `${p.weeks}W low`, values: r.low, color: "bad", dash: true, width: 1 }] }; } },
    // --- momentum ---
    { id: "rsi", name: "Relative Strength Index", group: "Momentum", kind: "pane", needs: "c",
      params: [P.len(14), P.src(), { key: "ma", label: "Smoothing MA (0 = off)", type: "int", def: 0, min: 0, max: 500 },
        { key: "ob", label: "Overbought", type: "float", def: 70, min: 50, max: 100 }, { key: "os", label: "Oversold", type: "float", def: 30, min: 0, max: 50 }],
      label: (p) => `RSI ${p.length}`,
      calc: (d, p) => { const r = rsi(source(d, p.source), p.length);
        return { lines: [{ name: `RSI ${p.length}`, values: r, color: "s6" }, ...(p.ma ? [{ name: `MA ${p.ma}`, values: sma(r, p.ma), color: "s3" }] : [])], levels: [p.os, 50, p.ob], range: [0, 100] }; } },
    { id: "macd", name: "MACD", group: "Momentum", kind: "pane", needs: "c",
      params: [{ key: "fast", label: "Fast", type: "int", def: 12, min: 1, max: 500 }, { key: "slow", label: "Slow", type: "int", def: 26, min: 1, max: 500 },
        { key: "signal", label: "Signal", type: "int", def: 9, min: 1, max: 500 }, P.src()],
      label: (p) => `MACD ${p.fast} ${p.slow} ${p.signal}`,
      calc: (d, p) => { const m = macd(source(d, p.source), p.fast, p.slow, p.signal);
        return { lines: [{ name: "MACD", values: m.macd, color: "s0" }, { name: "Signal", values: m.signal, color: "s1" }], hist: m.hist, levels: [0] }; } },
    { id: "stoch", name: "Stochastic", group: "Momentum", kind: "pane", needs: "hlc",
      params: [{ key: "k", label: "%K length", type: "int", def: 14, min: 1, max: 500 }, { key: "smoothK", label: "%K smoothing", type: "int", def: 3, min: 1, max: 100 }, { key: "d", label: "%D smoothing", type: "int", def: 3, min: 1, max: 100 }],
      label: (p) => `Stoch ${p.k} ${p.smoothK} ${p.d}`,
      calc: (d, p) => { const s = stochastic(d.high, d.low, d.close, p.k, p.smoothK, p.d);
        return { lines: [{ name: "%K", values: s.k, color: "s0" }, { name: "%D", values: s.d, color: "s1" }], levels: [20, 80], range: [0, 100] }; } },
    { id: "stochrsi", name: "Stochastic RSI", group: "Momentum", kind: "pane", needs: "c",
      params: [{ key: "smoothK", label: "K", type: "int", def: 3, min: 1, max: 100 }, { key: "smoothD", label: "D", type: "int", def: 3, min: 1, max: 100 },
        { key: "rsiLen", label: "RSI length", type: "int", def: 14, min: 1, max: 500 }, { key: "stochLen", label: "Stochastic length", type: "int", def: 14, min: 1, max: 500 }],
      label: (p) => `Stoch RSI ${p.smoothK} ${p.smoothD} ${p.rsiLen} ${p.stochLen}`,
      calc: (d, p) => { const s = stochRsi(d.close, p.rsiLen, p.stochLen, p.smoothK, p.smoothD);
        return { lines: [{ name: "K", values: s.k, color: "s0" }, { name: "D", values: s.d, color: "s1" }], levels: [20, 80], range: [0, 100] }; } },
    { id: "willr", name: "Williams %R", group: "Momentum", kind: "pane", needs: "hlc", params: [P.len(14)],
      label: (p) => `%R ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `%R ${p.length}`, values: willr(d.high, d.low, d.close, p.length), color: "s6" }], levels: [-80, -50, -20], range: [-100, 0] }) },
    { id: "cci", name: "Commodity Channel Index", group: "Momentum", kind: "pane", needs: "hlc", params: [P.len(20), P.src("hlc3")],
      label: (p) => `CCI ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `CCI ${p.length}`, values: cci(source(d, p.source), p.length), color: "s0" }], levels: [-100, 0, 100] }) },
    { id: "roc", name: "Rate of Change", group: "Momentum", kind: "pane", needs: "c", params: [P.len(9), P.src()],
      label: (p) => `ROC ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `ROC ${p.length}`, values: roc(source(d, p.source), p.length), color: "s0" }], levels: [0] }) },
    { id: "mfi", name: "Money Flow Index", group: "Volume", kind: "pane", needs: "hlcv", params: [P.len(14)],
      label: (p) => `MFI ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `MFI ${p.length}`, values: mfi(d.high, d.low, d.close, d.volume, p.length), color: "s6" }], levels: [20, 80], range: [0, 100] }) },
    { id: "rs", name: "Relative Strength vs benchmark", group: "Momentum", kind: "pane", needs: "cb",
      params: [{ key: "mode", label: "Mode", type: "select", options: ["RS line", "Mansfield"], def: "RS line" }, { key: "length", label: "Mansfield MA (bars)", type: "int", def: 52, min: 2, max: 500 }],
      label: (p) => (p.mode === "Mansfield" ? `Mansfield RS ${p.length}` : "RS line"),
      calc: (d, p) => {
        const ratio = d.close.map((c, i) => (isNum(d.bench[i]) && d.bench[i] ? c / d.bench[i] : null));
        if (p.mode === "Mansfield") { const m = sma(ratio, p.length); return { lines: [{ name: "Mansfield RS", values: ratio.map((r, i) => (r === null || m[i] === null ? null : 100 * (r / m[i] - 1))), color: "s0" }], levels: [0] }; }
        const first = ratio.find((x) => x !== null);
        return { lines: [{ name: "RS line", values: ratio.map((r) => (r === null ? null : (100 * r) / first)), color: "s0" }] };
      } },
    // --- volatility / trend strength ---
    { id: "atr", name: "Average True Range", group: "Volatility", kind: "pane", needs: "hlc", params: [P.len(14)],
      label: (p) => `ATR ${p.length}`,
      calc: (d, p) => ({ lines: [{ name: `ATR ${p.length}`, values: atr(d.high, d.low, d.close, p.length), color: "s7" }] }) },
    { id: "adx", name: "ADX / DMI", group: "Trend", kind: "pane", needs: "hlc",
      params: [{ key: "di", label: "DI length", type: "int", def: 14, min: 1, max: 500 }, { key: "adx", label: "ADX smoothing", type: "int", def: 14, min: 1, max: 500 }],
      label: (p) => `DMI ${p.di} ${p.adx}`,
      calc: (d, p) => { const m = dmi(d.high, d.low, d.close, p.di, p.adx);
        return { lines: [{ name: "ADX", values: m.adx, color: "ink2", width: 2 }, { name: "+DI", values: m.plus, color: "good" }, { name: "−DI", values: m.minus, color: "bad" }], levels: [20, 25] }; } },
    { id: "bbpct", name: "Bollinger %B", group: "Volatility", kind: "pane", needs: "c", params: [P.len(20), P.mult(2, "StdDev")],
      label: (p) => `%B ${p.length} ${p.mult}`,
      calc: (d, p) => { const b = bollingerK(d.close, p.length, p.mult);
        return { lines: [{ name: "%B", values: d.close.map((c, i) => (b.upper[i] === null || b.upper[i] === b.lower[i] ? null : (c - b.lower[i]) / (b.upper[i] - b.lower[i]))), color: "s0" }], levels: [0, 1] }; } },
    { id: "bbw", name: "Bollinger BandWidth", group: "Volatility", kind: "pane", needs: "c", params: [P.len(20), P.mult(2, "StdDev")],
      label: (p) => `BBW ${p.length} ${p.mult}`,
      calc: (d, p) => { const b = bollingerK(d.close, p.length, p.mult);
        return { lines: [{ name: "BandWidth", values: b.mid.map((m, i) => (m === null ? null : (100 * (b.upper[i] - b.lower[i])) / m)), color: "s0" }] }; } },
    // --- volume ---
    { id: "volume", name: "Volume", group: "Volume", kind: "volume", needs: "cv", params: [{ key: "ma", label: "Volume MA (0 = off)", type: "int", def: 20, min: 0, max: 500 }],
      label: (p) => `Vol${p.ma ? ` · MA ${p.ma}` : ""}`,
      calc: (d, p) => ({ lines: p.ma ? [{ name: `Vol MA ${p.ma}`, values: sma(d.volume, p.ma), color: "s1", width: 1 }] : [], volume: true }) },
    { id: "obv", name: "On-Balance Volume", group: "Volume", kind: "pane", needs: "cv", params: [{ key: "ma", label: "Smoothing MA (0 = off)", type: "int", def: 0, min: 0, max: 500 }],
      label: () => "OBV",
      calc: (d, p) => { const o = obv(d.close, d.volume); return { lines: [{ name: "OBV", values: o, color: "s0" }, ...(p.ma ? [{ name: `MA ${p.ma}`, values: sma(o, p.ma), color: "s1" }] : [])] }; } },
  ];
  function bollingerK(values, n, k) {
    const mid = sma(values, n), sd = rollingStd(values, n, 0);
    return { mid, upper: mid.map((m, i) => (m === null ? null : m + k * sd[i])), lower: mid.map((m, i) => (m === null ? null : m - k * sd[i])) };
  }
  const studyFits = (s, d) => [...s.needs].every((k) => ({ h: !!d.high, l: !!d.low, c: !!d.close, v: !!d.volume, b: !!d.bench }[k]))
    && (!s.intraday || d.intraday);

  /**
   * Indicator playbooks of well-known traders and investors: the studies each is known for
   * (from their books and interviews), with their published settings. Fundamental investors
   * (Buffett, Lynch, Munger) don't use chart indicators, so they have none.
   */
  const s = (id, params = {}) => ({ id, params });
  const PLAYBOOKS = [
    { id: "ptj", name: "Paul Tudor Jones · 200-day rule", interval: "1d",
      about: "Treats the 200-day moving average as his line in the sand: get defensive when price closes below it.",
      studies: [s("ma", { type: "SMA", length: 200 }), s("volume")] },
    { id: "minervini", name: "Mark Minervini · Trend Template", interval: "1d",
      about: "Buys stage-2 leaders: price above the 50, 150 and 200-day averages (in that order), at least 30% above the 52-week low and within 25% of the high, with strong relative strength.",
      studies: [s("ma", { type: "SMA", length: 50 }), s("ma", { type: "SMA", length: 150 }), s("ma", { type: "SMA", length: 200 }), s("hilo", { weeks: 52 }), s("volume", { ma: 50 }), s("rs")] },
    { id: "oneil", name: "William O'Neil · CAN SLIM", interval: "1d",
      about: "Buys breakouts from sound bases on heavy volume (well above the 50-day average) with a rising relative strength line; sells below the 50-day line.",
      studies: [s("ma", { type: "SMA", length: 50 }), s("ma", { type: "SMA", length: 200 }), s("volume", { ma: 50 }), s("rs")] },
    { id: "weinstein", name: "Stan Weinstein · Stage Analysis", interval: "1w",
      about: "Weekly charts: buy stage-2 breakouts above a rising 30-week average on expanding volume, confirmed by positive Mansfield relative strength.",
      studies: [s("ma", { type: "SMA", length: 30 }), s("volume", { ma: 10 }), s("rs", { mode: "Mansfield", length: 52 })] },
    { id: "turtles", name: "Turtle Traders · Donchian breakouts", interval: "1d",
      about: "Richard Dennis's Turtles entered on 20 and 55-day breakouts, exited on 10 and 20-day opposite breakouts, and sized positions by 20-day ATR (N).",
      studies: [s("donchian", { length: 20 }), s("donchian", { length: 55 }), s("atr", { length: 20 })] },
    { id: "bollinger", name: "John Bollinger · Bands, %B, BandWidth", interval: "1d",
      about: "Bands at 20 periods and 2 standard deviations; %B locates price within them and BandWidth flags the squeeze that precedes big moves.",
      studies: [s("bb"), s("bbpct"), s("bbw")] },
    { id: "wilder", name: "J. Welles Wilder · RSI, ADX, SAR, ATR", interval: "1d",
      about: "The inventor of RSI, ADX/DMI, Parabolic SAR and ATR (New Concepts in Technical Trading Systems, 1978), with his original settings.",
      studies: [s("psar"), s("rsi"), s("adx"), s("atr")] },
    { id: "raschke", name: "Linda Raschke · Holy Grail & 3-10", interval: "1d",
      about: "Holy Grail: when ADX is above 30 and rising, buy pullbacks to the 20 EMA. Her 3-10 oscillator is a fast MACD (3, 10, 16); Keltner channels frame the trend.",
      studies: [s("ma", { type: "EMA", length: 20 }), s("keltner"), s("adx"), s("macd", { fast: 3, slow: 10, signal: 16 })] },
    { id: "connors", name: "Larry Connors · RSI(2)", interval: "1d",
      about: "Short-term mean reversion: above the 200-day average, buy when 2-period RSI drops below 10 and exit on a close above the 5-day average.",
      studies: [s("ma", { type: "SMA", length: 200 }), s("ma", { type: "SMA", length: 5 }), s("rsi", { length: 2, ob: 90, os: 10 })] },
    { id: "appel", name: "Gerald Appel · MACD", interval: "1d",
      about: "The creator of MACD (12, 26, 9): crossovers of the signal line and divergences with price.",
      studies: [s("ma", { type: "EMA", length: 12 }), s("ma", { type: "EMA", length: 26 }), s("macd")] },
    { id: "hosoda", name: "Goichi Hosoda · Ichimoku", interval: "1d",
      about: "Ichimoku Kinko Hyo with the original 9, 26, 52 settings: trend is up above the cloud, and conversion/base crosses time entries.",
      studies: [s("ichimoku")] },
    { id: "shannon", name: "Brian Shannon · VWAP & multiple timeframes", interval: "5m",
      about: "Intraday: trade with the session VWAP and the anchored VWAP from key events, using the 8/21 EMAs and volume to time entries.",
      studies: [s("vwap"), s("avwap"), s("ma", { type: "EMA", length: 8 }), s("ma", { type: "EMA", length: 21 }), s("volume")] },
    { id: "williams", name: "Larry Williams · %R", interval: "1d",
      about: "Williams %R (he created it), here with his 10-period setting for overbought/oversold timing.",
      studies: [s("willr", { length: 10 }), s("ma", { type: "SMA", length: 20 })] },
    { id: "granville", name: "Joseph Granville · OBV", interval: "1d",
      about: "On-Balance Volume, which he introduced in 1963: volume leads price, so OBV breakouts and divergences warn early.",
      studies: [s("obv", { ma: 20 }), s("ma", { type: "SMA", length: 200 })] },
    { id: "buffett", name: "Warren Buffett, Peter Lynch · no chart indicators", interval: "1w",
      about: "Fundamental investors who don't time trades with indicators. Use the Financials page (valuation, quality, peers) instead; this shows just a clean weekly chart.",
      studies: [] },
  ];

  /** Can this indicator run on data with these fields? */
  function indicatorFits(ind, d) {
    const has = { h: !!d.high, l: !!d.low, v: !!d.volume, c: !!d.close };
    return [...ind.needs].every((k) => has[k]) && (!ind.intraday || d.intraday);
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
  // Research tools (Compare page)
  // ------------------------------------------------------------------------------------------
  /** Sunday starting the UTC week of an ISO date: the key weekly bars and weekly factors share. */
  function weekKey(iso) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10);
  }
  /** Daily factor returns compounded into weeks keyed by weekKey, in factors.json's shape. */
  function weeklyFactors(factors) {
    const cols = Object.keys(factors).filter((k) => k !== "d" && Array.isArray(factors[k]));
    const out = { d: [] };
    cols.forEach((c) => { out[c] = []; });
    let key = null, acc = null;
    const flush = () => { if (key) { out.d.push(key); cols.forEach((c) => out[c].push(acc[c] - 1)); } };
    factors.d.forEach((d, i) => {
      const k = weekKey(d);
      if (k !== key) { flush(); key = k; acc = Object.fromEntries(cols.map((c) => [c, 1])); }
      cols.forEach((c) => { acc[c] = isNum(factors[c][i]) ? acc[c] * (1 + factors[c][i]) : NaN; });
    });
    flush();
    return out;
  }
  /** Annualised risk from periodic simple returns (ppy periods a year). rf: per-period risk-free
   * rates for the same periods; bench: the benchmark's returns for the same periods. */
  function riskStats(rets, { rf = null, bench = null, ppy = TD } = {}) {
    const ex = rets.map((r, i) => r - (rf ? rf[i] : 0));
    const downside = Math.sqrt(mean(ex.map((x) => Math.min(x, 0) ** 2)));
    return {
      n: rets.length, vol: std(rets) * Math.sqrt(ppy),
      sharpe: (mean(ex) / std(ex)) * Math.sqrt(ppy),
      sortino: downside > 0 ? (mean(ex) * ppy) / (downside * Math.sqrt(ppy)) : NaN,
      beta: bench ? covariance(rets, bench) / variance(bench) : NaN,
    };
  }
  function maxDrawdown(values) {
    let peak = -Infinity, mdd = 0;
    for (const v of values) { if (v > peak) peak = v; mdd = Math.min(mdd, v / peak - 1); }
    return mdd;
  }
  /** The value on or before an ISO date, or null when the dates start later. */
  function valueAt(dates, values, iso) {
    let lo = 0, hi = dates.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= iso) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 ? values[k] : null;
  }
  function shiftIso(iso, { days = 0, months = 0, years = 0 } = {}) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() - years);
    d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }
  /** Return from the last value on or before `from` to the latest value; annualised over
   * `years` when given. NaN when the history doesn't reach back to `from`. */
  function returnSince(dates, values, from, years = 0) {
    if (!dates.length || dates[0] > from) return NaN;
    const base = valueAt(dates, values, from), last = values[values.length - 1];
    if (!isNum(base) || base <= 0) return NaN;
    return years ? (last / base) ** (1 / years) - 1 : last / base - 1;
  }

  // --- correlations -------------------------------------------------------------------------
  /** Pearson correlations of aligned return columns (cols[i]: one asset's returns). Symmetric by
   * construction, with exactly 1 on the diagonal. */
  function correlationMatrix(cols) {
    const sd = cols.map((c) => std(c));
    return cols.map((a, i) => cols.map((b, j) => (i === j ? 1 : covariance(a, b) / (sd[i] * sd[j]))));
  }
  /** Leaf order of an average-linkage clustering on distance 1 - correlation: correlated assets end
   * up next to each other. */
  function clusterOrder(C) {
    let clusters = C.map((_, i) => [i]);
    const dist = (a, b) => mean(a.flatMap((i) => b.map((j) => 1 - C[i][j])));
    while (clusters.length > 1) {
      let best = [0, 1], bestD = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) { const d = dist(clusters[i], clusters[j]); if (d < bestD) { bestD = d; best = [i, j]; } }
      }
      const [i, j] = best, merged = [...clusters[i], ...clusters[j]];
      clusters = clusters.filter((_, k) => k !== i && k !== j).concat([merged]);
    }
    return clusters[0];
  }
  /** Average pairwise correlation and the most and least correlated pairs. */
  function pairStats(C, names) {
    const pairs = [];
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) pairs.push({ a: names[i], b: names[j], rho: C[i][j] });
    pairs.sort((x, y) => y.rho - x.rho);
    return { average: mean(pairs.map((p) => p.rho)), most: pairs[0], least: pairs[pairs.length - 1], pairs: pairs.length };
  }

  // --- sector map ----------------------------------------------------------------------------
  /** Squarified treemap (Bruls, Huizing & van Wijk 2000): one rectangle {i, x, y, w, h} per positive
   * value, areas proportional to the values, filling the w0 x h0 box. */
  function squarify(values, x0, y0, w0, h0) {
    const items = values.map((v, i) => ({ v: isNum(v) && v > 0 ? v : 0, i })).filter((d) => d.v > 0).sort((a, b) => b.v - a.v);
    const total = sum(items.map((d) => d.v)), out = [];
    if (!total) return out;
    items.forEach((d) => { d.a = (d.v * w0 * h0) / total; });
    let x = x0, y = y0, w = w0, h = h0, row = [];
    const worst = (r, side) => {
      const s = sum(r.map((d) => d.a)), mx = Math.max(...r.map((d) => d.a)), mn = Math.min(...r.map((d) => d.a));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };
    const place = (r) => {
      const s = sum(r.map((d) => d.a));
      if (w >= h) {
        const rw = s / h; let yy = y;
        r.forEach((d) => { out.push({ i: d.i, x, y: yy, w: rw, h: d.a / rw }); yy += d.a / rw; });
        x += rw; w -= rw;
      } else {
        const rh = s / w; let xx = x;
        r.forEach((d) => { out.push({ i: d.i, x: xx, y, w: d.a / rh, h: rh }); xx += d.a / rh; });
        y += rh; h -= rh;
      }
    };
    for (const d of items) {
      const side = Math.min(w, h);
      if (!row.length || worst([...row, d], side) <= worst(row, side)) row.push(d);
      else { place(row); row = [d]; }
    }
    if (row.length) place(row);
    return out;
  }
  /** Rows grouped by `key`: total market cap, the cap-weighted mean 1-day change (equal-weighted
   * when caps are missing) and counts. Missing changes are left out, never guessed. */
  function groupMoves(rows, key, { cap = "cap", change = "r1d" } = {}) {
    const groups = new Map();
    for (const r of rows) {
      const k = r[key] || "Unknown";
      if (!groups.has(k)) groups.set(k, { key: k, n: 0, cap: 0, capKnown: 0, wsum: 0, w: 0, plain: [], missing: 0 });
      const g = groups.get(k);
      g.n++;
      if (isNum(r[cap])) { g.cap += r[cap]; g.capKnown++; }
      if (!isNum(r[change])) { g.missing++; continue; }
      g.plain.push(r[change]);
      if (isNum(r[cap])) { g.wsum += r[cap] * r[change]; g.w += r[cap]; }
    }
    return [...groups.values()].map((g) => ({
      key: g.key, n: g.n, cap: g.capKnown ? g.cap : NaN, missing: g.missing,
      change: g.w > 0 ? g.wsum / g.w : g.plain.length ? mean(g.plain) : NaN,
    })).sort((a, b) => (isNum(b.cap) ? b.cap : 0) - (isNum(a.cap) ? a.cap : 0));
  }

  // --- price alerts (Live page) --------------------------------------------------------------
  /** Whether an alert's condition holds for a quote {price, prev}. Kinds: "above" / "below" a price,
   * "up" / "down" by at least `value` percent from the previous close. null: can't be checked. */
  function alertHit(alert, quote) {
    const p = quote && quote.price, prev = quote && quote.prev, v = Number(alert.value);
    if (!isNum(p) || !isNum(v)) return null;
    if (alert.kind === "above") return p >= v;
    if (alert.kind === "below") return p <= v;
    if (!isNum(prev) || prev <= 0) return null;
    const move = (p / prev - 1) * 100;
    return alert.kind === "up" ? move >= v : alert.kind === "down" ? move <= -v : null;
  }

  const Q = { TD, isNum, mean, std, variance, covariance, invert, ols, returns, sma, rollingStd, rsi, bollinger, align,
    weekKey, weeklyFactors, riskStats, maxDrawdown, valueAt, shiftIso, returnSince, correlationMatrix, clusterOrder, pairStats,
    squarify, groupMoves, alertHit,
    ema, rma, highest, lowest, trueRange, atr, macd, stoch, stochastic, stochRsi, dmi, supertrend, psar, ichimoku, vwap, obv,
    INDICATORS, indicatorFits, wma, hma, vwma, maOf, source, keltner, donchian, willr, cci, roc, mfi, rangeByTime, pivots, anchoredVwap,
    STUDIES, studyFits, PLAYBOOKS,
    MODELS, FACTOR_LABELS, factorRegression, rollingExposures };
  if (typeof module !== "undefined" && module.exports) module.exports = Q;
  else root.Q = Q;
})(typeof window !== "undefined" ? window : globalThis);
