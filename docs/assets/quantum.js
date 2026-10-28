/* Quantum page (#/quantum): how quantum algorithms work, for beginners, applied to stock
 * investing with a classical baseline next to every quantum number.
 *
 * Quantum results come from data/quantum.json (python -m quant.web.quantum: Qiskit on a
 * simulator, run nightly) or from the small state-vector simulator below. Every one carries the
 * SIM label. The page still works without quantum.json: the quantum panels say so instead.
 * The maths (QX) touches no DOM and is exported for Node, where tests/test_quantum_js.py checks
 * it against Python and Qiskit's conventions.
 */
(function (root) {
  "use strict";
  const TD = 252;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  function std(a) {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  }

  // ==============================================================================================
  // Maths (no DOM)
  // ==============================================================================================
  /** Seeded uniform generator (mulberry32), so every simulation on the page is repeatable. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Standard normal draws from a uniform generator (Box-Muller, keeping the second draw). */
  function gaussian(u) {
    let spare = null;
    return () => {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let a = 0;
      while (a === 0) a = u();
      const r = Math.sqrt(-2 * Math.log(a)), th = 2 * Math.PI * u();
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    };
  }

  // --- state-vector simulator: real amplitudes are enough for H, X, Z and CNOT -------------------
  // Basis index i holds qubit q in bit q (little-endian, as in Qiskit: |q2 q1 q0>).
  function applyGate(state, g) {
    const n = state.length, m = 1 << g.t;
    if (g.g === "H") {
      for (let i = 0; i < n; i++) if (!(i & m)) { const a = state[i], b = state[i | m]; state[i] = (a + b) * Math.SQRT1_2; state[i | m] = (a - b) * Math.SQRT1_2; }
    } else if (g.g === "X") {
      for (let i = 0; i < n; i++) if (!(i & m)) { const a = state[i]; state[i] = state[i | m]; state[i | m] = a; }
    } else if (g.g === "Z") {
      for (let i = 0; i < n; i++) if (i & m) state[i] = -state[i];
    } else if (g.g === "CNOT") {
      const c = 1 << g.c;
      for (let i = 0; i < n; i++) if ((i & c) && !(i & m)) { const a = state[i]; state[i] = state[i | m]; state[i | m] = a; }
    }
    return state;
  }
  function simulate(nQubits, gates) {
    const s = new Float64Array(1 << nQubits);
    s[0] = 1;
    gates.forEach((g) => applyGate(s, g));
    return s;
  }
  const probabilities = (state) => Array.from(state, (a) => a * a);
  /** Measure `shots` times: counts per basis state, drawn from the probabilities. */
  function sampleCounts(probs, shots, seed) {
    const u = rng(seed), cdf = [];
    let acc = 0;
    for (const p of probs) cdf.push((acc += p));
    const counts = new Array(probs.length).fill(0);
    for (let k = 0; k < shots; k++) {
      const x = u() * acc;
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
      counts[lo]++;
    }
    return counts;
  }

  // --- Grover search over N items, one of them marked --------------------------------------------
  /** Amplitudes after each half step: start, then oracle (sign flip) and diffusion (reflection
   * about the mean) for each iteration. */
  function groverSteps(N, marked, iterations) {
    let a = new Array(N).fill(1 / Math.sqrt(N));
    const out = [{ step: "start", k: 0, amps: a.slice() }];
    for (let k = 1; k <= iterations; k++) {
      a[marked] = -a[marked];
      const m = mean(a);
      out.push({ step: "oracle", k, amps: a.slice(), mean: m });
      a = a.map((x) => 2 * m - x);
      out.push({ step: "diffusion", k, amps: a.slice() });
    }
    return out;
  }
  /** P(marked) after k iterations: sin²((2k+1)θ) with sin θ = 1/√N. */
  const groverProbability = (N, k) => Math.sin((2 * k + 1) * Math.asin(1 / Math.sqrt(N))) ** 2;
  const groverOptimal = (N) => Math.floor((Math.PI / 4) * Math.sqrt(N));

  // --- Monte Carlo error, measured -----------------------------------------------------------------
  /** RMS error of the sample mean of N standard normals (true mean 0, σ = 1), over many trials. */
  function mcErrorCurve(seed = 7, plan = [[10, 400], [100, 200], [1e3, 100], [1e4, 40], [1e5, 16], [1e6, 6]]) {
    const g = gaussian(rng(seed));
    return plan.map(([n, trials]) => {
      let se = 0;
      for (let t = 0; t < trials; t++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += g();
        se += (s / n) ** 2;
      }
      return { n, rms: Math.sqrt(se / trials) };
    });
  }

  // --- option pricing --------------------------------------------------------------------------------
  /** erfc with fractional error below 1.2e-7 (Numerical Recipes' Chebyshev fit). */
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807
      + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);
  /** European option under Black-Scholes: S spot, K strike, T years, r continuous rate, vol annual. */
  function blackScholes(S, K, T, r, vol, kind = "call") {
    const sq = vol * Math.sqrt(T), d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / sq, d2 = d1 - sq, disc = Math.exp(-r * T);
    const price = kind === "call" ? S * normCdf(d1) - K * disc * normCdf(d2) : K * disc * normCdf(-d2) - S * normCdf(-d1);
    return { price, d1, d2, delta: kind === "call" ? normCdf(d1) : normCdf(d1) - 1 };
  }
  /** Monte Carlo price from lognormal terminal prices, with a 95% interval and running estimates
   * at the `checkpoints` (path counts) for a convergence chart. */
  function mcOption({ S, K, T, r, vol, kind = "call", n = 100000, seed = 1, checkpoints = [] }) {
    const g = gaussian(rng(seed)), drift = (r - (vol * vol) / 2) * T, sd = vol * Math.sqrt(T), disc = Math.exp(-r * T);
    const cps = checkpoints.filter((x) => x >= 2 && x <= n).sort((a, b) => a - b), path = [];
    let s1 = 0, s2 = 0, c = 0;
    for (let i = 1; i <= n; i++) {
      const st = S * Math.exp(drift + sd * g());
      const p = disc * Math.max(kind === "call" ? st - K : K - st, 0);
      s1 += p; s2 += p * p;
      if (c < cps.length && i === cps[c]) {
        const m = s1 / i;
        path.push({ n: i, price: m, half: 1.96 * Math.sqrt(Math.max(s2 - i * m * m, 0) / (i - 1) / i) });
        c++;
      }
    }
    const m = s1 / n, se = Math.sqrt(Math.max(s2 - n * m * m, 0) / (n - 1) / n);
    return { price: m, se, ci: [m - 1.96 * se, m + 1.96 * se], n, path };
  }
  /** Annualised volatility of the last `window` daily log returns (as quant/web/quantum.py). */
  function annualVol(values, window = 126) {
    const v = values.filter(isNum), lr = [];
    for (let i = Math.max(1, v.length - window); i < v.length; i++) lr.push(Math.log(v[i] / v[i - 1]));
    return std(lr) * Math.sqrt(TD);
  }
  /** The lognormal model the quantum circuit discretizes: log-space mean and variance, ±3σ bounds. */
  function lognormalBounds(S, T, r, vol) {
    const mu = Math.log(S) + (r - (vol * vol) / 2) * T, s2 = vol * vol * T;
    const m = Math.exp(mu + s2 / 2), sd = Math.sqrt((Math.exp(s2) - 1) * Math.exp(2 * mu + s2));
    return { mu, sigma2: s2, low: Math.max(0, m - 3 * sd), high: m + 3 * sd };
  }
  /** Risk-free rate: FRED's 3-month T-bill yield from market.json, else Fed funds, else the nightly
   * run's. Returns the percent yield and its continuously compounded equivalent. */
  function riskFree(market, q) {
    let src = null;
    if (market && market.rf && isNum(market.rf.value)) src = { series: market.rf.id, label: market.rf.label || "3-Month Treasury yield", pct: market.rf.value, date: market.rf.date };
    const dff = !src && market && (market.fred || []).find((t) => t.id === "DFF" && isNum(t.value));
    if (dff) src = { series: "DFF", label: "Effective federal funds rate", pct: dff.value, date: dff.date };
    if (!src && q && q.rate && isNum(q.rate.percent)) src = { series: q.rate.series, label: q.rate.label, pct: q.rate.percent, date: q.rate.date };
    if (!src) src = { series: null, label: "an assumed rate (no FRED data loaded)", pct: 4, date: null };
    return Object.assign(src, { r: Math.log(1 + src.pct / 100) });
  }

  // --- risk: VaR and CVaR -----------------------------------------------------------------------------
  /** Quantile with linear interpolation (numpy's default). */
  function quantile(a, p) {
    const s = Float64Array.from(a).sort(), h = (s.length - 1) * p, lo = Math.floor(h);
    return s[lo] + (h - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]);
  }
  /** VaR and CVaR at `level` (0.95, 0.99) as positive loss fractions, from a sample of returns. */
  function varCvar(returns, level) {
    const v = -quantile(returns, 1 - level);
    return { var: v, cvar: -mean(returns.filter((x) => x <= -v)) };
  }
  /** Simple daily returns of aligned prices: values[i][t] -> rows[t][i]. */
  function returnRows(values) {
    const T = values[0].length, rows = [];
    for (let t = 1; t < T; t++) rows.push(values.map((v) => v[t] / v[t - 1] - 1));
    return rows;
  }
  const portfolio = (rows, w) => rows.map((r) => r.reduce((s, x, i) => s + w[i] * x, 0));
  /** Overlapping h-day compounded returns. */
  function horizon(daily, h) {
    const out = [];
    for (let t = h - 1; t < daily.length; t++) {
      let g = 1;
      for (let s = t - h + 1; s <= t; s++) g *= 1 + daily[s];
      out.push(g - 1);
    }
    return out;
  }
  function meanCov(rows) {
    const n = rows[0].length, T = rows.length, mu = new Array(n).fill(0);
    rows.forEach((r) => r.forEach((x, i) => { mu[i] += x / T; }));
    const cov = mu.map(() => new Array(n).fill(0));
    rows.forEach((r) => { for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) cov[i][j] += ((r[i] - mu[i]) * (r[j] - mu[j])) / (T - 1); });
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) cov[j][i] = cov[i][j];
    return { mu, cov };
  }
  function cholesky(A) {
    const n = A.length, L = A.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-18)) : s / L[j][j];
      }
    }
    return L;
  }
  /** Monte Carlo portfolio returns over `h` days: assets' log returns drawn from a multivariate
   * normal fitted to history (mean h·μ, covariance h·Σ), weights fixed over the horizon. */
  function mcPortfolio(rows, w, { h = 1, n = 20000, seed = 11 } = {}) {
    const logs = rows.map((r) => r.map((x) => Math.log(1 + x)));
    const { mu, cov } = meanCov(logs), L = cholesky(cov), g = gaussian(rng(seed)), k = mu.length, sh = Math.sqrt(h), out = new Float64Array(n);
    const z = new Array(k);
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < k; i++) z[i] = g();
      let rp = 0;
      for (let i = 0; i < k; i++) {
        let x = h * mu[i];
        for (let j = 0; j <= i; j++) x += sh * L[i][j] * z[j];
        rp += w[i] * Math.expm1(x);
      }
      out[s] = rp;
    }
    return Array.from(out);
  }

  // --- portfolios: mean-variance on the simplex, and the cardinality QUBO ------------------------------
  const matVec = (M, v) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  function lambdaMax(M) {
    let v = M.map(() => 1), l = 0;
    for (let k = 0; k < 100; k++) {
      const u = matVec(M, v), norm = Math.hypot(...u) || 1;
      l = norm / (Math.hypot(...v) || 1);
      v = u.map((x) => x / norm);
    }
    return l;
  }
  /** Euclidean projection onto {w >= 0, sum w = 1} (Duchi et al., 2008). */
  function projectSimplex(v) {
    const u = [...v].sort((a, b) => b - a);
    let css = 0, theta = 0;
    for (let i = 0; i < u.length; i++) { css += u[i]; const t = (css - 1) / (i + 1); if (u[i] - t > 0) theta = t; }
    return v.map((x) => Math.max(x - theta, 0));
  }
  /** Long-only, fully invested: minimise w'Σw − λ μ'w by accelerated projected gradient (FISTA). */
  function meanVariance(cov, mu, lam, w0 = null, iters = 4000) {
    const n = mu.length, step = 1 / (2 * lambdaMax(cov) + 1e-12);
    let w = w0 ? w0.slice() : new Array(n).fill(1 / n), y = w.slice(), t = 1;
    for (let k = 0; k < iters; k++) {
      const g = matVec(cov, y).map((x, i) => 2 * x - lam * mu[i]);
      const next = projectSimplex(y.map((x, i) => x - step * g[i]));
      const t2 = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      let diff = 0;
      y = next.map((x, i) => { diff = Math.max(diff, Math.abs(x - w[i])); return x + ((t - 1) / t2) * (x - w[i]); });
      w = next; t = t2;
      if (diff < 1e-13) break;
    }
    return w;
  }
  const stats = (w, mu, cov, rf) => { const ret = dot(w, mu), vol = Math.sqrt(Math.max(dot(w, matVec(cov, w)), 0)); return { w, ret, vol, sharpe: (ret - rf) / vol }; };
  /** The long-only efficient frontier traced by λ, with the minimum-variance and maximum-Sharpe portfolios. */
  function frontier(mu, cov, rf = 0) {
    const lams = [0, ...Array.from({ length: 70 }, (_, i) => 10 ** (-3 + (4.5 * i) / 69))];
    let w = null;
    const pts = lams.map((lam) => { w = meanVariance(cov, mu, lam, w); return Object.assign({ lam }, stats(w, mu, cov, rf)); });
    let best = pts.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
    // Refine the maximum-Sharpe point between its grid neighbours (Sharpe is unimodal along the frontier).
    let lo = Math.log10(Math.max(best.lam, 1e-3) / 1.2), hi = Math.log10(Math.max(best.lam, 1e-3) * 1.2);
    for (let k = 0; k < 40; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      const sa = stats(meanVariance(cov, mu, 10 ** a, best.w), mu, cov, rf), sb = stats(meanVariance(cov, mu, 10 ** b, best.w), mu, cov, rf);
      if (sa.sharpe < sb.sharpe) lo = a; else hi = b;
    }
    const ref = Object.assign({ lam: 10 ** ((lo + hi) / 2) }, stats(meanVariance(cov, mu, 10 ** ((lo + hi) / 2), best.w), mu, cov, rf));
    if (ref.sharpe > best.sharpe) best = ref;
    return { points: pts, minVar: pts[0], maxSharpe: best };
  }
  /** x'Qx + constant = x'(Σ/K²)x − (λ/K) μ'x + P (Σx − K)² for binary x (each pick weighted 1/K).
   * The objective can't vary by more than the sum of its coefficients' sizes, so P 5% above that makes
   * every wrong-sized portfolio score worse than every valid one. Same matrix as quant/web/quantum.py. */
  function quboMatrix(mu, cov, K, lam) {
    const n = mu.length, risk = cov.map((row) => row.map((x) => x / (K * K))), ret = mu.map((m) => (lam * m) / K);
    const P = 1.05 * (sum(risk.map((row) => sum(row.map(Math.abs)))) + sum(ret.map(Math.abs)));
    const Q = risk.map((row, i) => row.map((x, j) => x - (i === j ? ret[i] : 0) + P * (1 - (i === j ? 2 * K : 0))));
    return { Q, constant: P * K * K, penalty: P, n };
  }
  function quboValue(Q, constant, mask) {
    let v = constant;
    for (let i = 0; i < Q.length; i++) if ((mask >> i) & 1) for (let j = 0; j < Q.length; j++) if ((mask >> j) & 1) v += Q[i][j];
    return v;
  }
  const bitCount = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
  /** Exact search over all 2^n portfolios: the best and worst with exactly K names, and the QUBO's
   * unconstrained minimum (which the penalty should make one of the valid ones). */
  function bruteForce(Q, constant, K) {
    const N = 1 << Q.length, valid = [];
    let global = null;
    for (let m = 0; m < N; m++) {
      const f = quboValue(Q, constant, m);
      if (!global || f < global.f) global = { mask: m, f };
      if (bitCount(m) === K) valid.push({ mask: m, f });
    }
    valid.sort((a, b) => a.f - b.f);
    return { best: valid[0], worst: valid[valid.length - 1], top: valid.slice(0, 5), valid: valid.length, all: N, global };
  }
  const bits = (mask, n) => Array.from({ length: n }, (_, i) => (mask >> i) & 1).join("");  // basket order, left to right

  const QX = { TD, mean, std, rng, gaussian, applyGate, simulate, probabilities, sampleCounts, groverSteps, groverProbability, groverOptimal, mcErrorCurve,
    erfc, normCdf, blackScholes, mcOption, annualVol, lognormalBounds, riskFree,
    quantile, varCvar, returnRows, portfolio, horizon, meanCov, cholesky, mcPortfolio,
    projectSimplex, meanVariance, frontier, quboMatrix, quboValue, bruteForce, bits };

  if (typeof module !== "undefined" && module.exports) { module.exports = QX; return; }
  root.QX = QX;

  // ==============================================================================================
  // Page. Uses app.js's shared helpers (load, esc, kpi, table, plot, layout, pal, ...).
  // ==============================================================================================
  const SIM = "Simulated on a classical computer — educational, not a trading signal";
  const simTag = () => `<span class="q-sim" title="No quantum hardware was used">⚛ ${SIM}</span>`;
  const SECTIONS = [];  // {id, n, title, html(ctx), init(root, ctx)} in page order
  const timers = [];  // stop functions for animations, run when the visitor leaves the page

  function basics() {
    const card = (title, body) => `<div class="card q-card"><h3>${title}</h3>${body}</div>`;
    return `
      <div class="grid g4 q-cards">
        ${card("Superposition", `<p>A bit is 0 or 1. A qubit holds two <b>amplitudes</b>, one for 0 and one for 1, such as 0.6 and 0.8.
          Square them to get probabilities: 36% and 64%. Three qubits hold 2³ = 8 amplitudes, 30 qubits about a billion.</p>`)}
        ${card("Measurement", `<p>Reading a qubit gives a plain 0 or 1, picked at random with those probabilities, and the amplitudes are gone
          (the state "collapses"). So a quantum program is run many times, called <b>shots</b>, and the answers are counted.</p>`)}
        ${card("Entanglement", `<p>Qubits can share one joint state that can't be split into separate parts. In the pair
          (|00⟩ + |11⟩)/√2, each qubit alone is a coin flip, yet the two always agree when measured.</p>`)}
        ${card("Interference", `<p>Amplitudes can be negative, and they add like waves: same signs reinforce, opposite signs cancel.
          Algorithms arrange the cancellations so wrong answers fade and the right one grows.</p>`)}
      </div>
      <div class="q-callout"><b>Myth: a quantum computer tries every answer at once.</b> It holds many amplitudes, but one measurement returns
        a single random answer. The speedup comes from steering interference so the right answer becomes likely; without that, you just get
        a random answer.</div>
      <div class="q-callout"><b>Why speedups need structure.</b> Quantum algorithms are judged by <b>queries</b>: how many times they consult an
        <b>oracle</b>, a black box that computes or checks something about the problem. A speedup comes from structure the algorithm can exploit
        (a hidden period for Shor, an average for amplitude estimation, a checkable answer for Grover); with no structure in the problem,
        there is no speedup.</div>`;
  }
  SECTIONS.push({ id: "basics", title: "Quantum basics", html: basics });

  // --- 2. Interactive qubit lab ---------------------------------------------------------------------
  const ket = (i, n) => `|${i.toString(2).padStart(n, "0")}⟩`;
  const fmtAmp = (a) => (Math.abs(a) < 5e-13 ? "0" : minus(a.toFixed(3)));
  function ampRows(state, n, { hideZero = false } = {}) {
    return Array.from(state, (a, i) => [a, i]).filter(([a]) => !hideZero || Math.abs(a) > 1e-12).map(([a, i]) => {
      const p = a * a;
      return `<div class="q-amp"><span class="k">${ket(i, n)}</span><span class="track"><span class="fill${a < -1e-12 ? " neg" : ""}" style="width:${(100 * p).toFixed(1)}%"></span></span>
        <span class="v">${fmtAmp(a)}</span><span class="p">${(100 * p).toFixed(1)}%</span></div>`;
    }).join("");
  }
  function stateText(state, n) {
    const terms = Array.from(state, (a, i) => [a, i]).filter(([a]) => Math.abs(a) > 1e-12);
    return "|ψ⟩ = " + terms.map(([a, i], k) => `${k ? (a < 0 ? " − " : " + ") : a < 0 ? "−" : ""}${Math.abs(a).toFixed(3)}${ket(i, n)}`).join("");
  }
  function circuitSvg(n, gates) {
    const W = 64 + 44 * Math.max(gates.length + 1, 7), H = 16 + 38 * n, y = (q) => 26 + 38 * q, x = (i) => 70 + 44 * i;
    const wires = Array.from({ length: n }, (_, q) => `<text class="q-lbl" x="6" y="${y(q) + 4}">q${q}</text><line class="q-wire" x1="40" x2="${W - 8}" y1="${y(q)}" y2="${y(q)}"/>`).join("");
    const body = gates.map((g, i) => g.g === "CNOT"
      ? `<line class="q-link" x1="${x(i)}" x2="${x(i)}" y1="${y(g.c)}" y2="${y(g.t)}"/><circle class="q-dot" cx="${x(i)}" cy="${y(g.c)}" r="5"/>
         <circle class="q-targ" cx="${x(i)}" cy="${y(g.t)}" r="10"/><line class="q-link" x1="${x(i) - 10}" x2="${x(i) + 10}" y1="${y(g.t)}" y2="${y(g.t)}"/>
         <line class="q-link" x1="${x(i)}" x2="${x(i)}" y1="${y(g.t) - 10}" y2="${y(g.t) + 10}"/>`
      : `<rect class="q-gate" x="${x(i) - 14}" y="${y(g.t) - 13}" width="28" height="26" rx="5"/><text class="q-gtext" x="${x(i)}" y="${y(g.t) + 5}">${g.g}</text>`).join("");
    return `<svg class="q-circ" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Circuit with ${gates.length} gates on ${n} qubits">${wires}${body}</svg>`;
  }
  const GROVER_ITEMS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "V", "XOM", "JNJ", "WMT", "PG", "MA", "HD", "KO"];
  const PRESETS = {
    bell: { label: "Entangled pair", n: 2, gates: [{ g: "H", t: 0 }, { g: "CNOT", c: 0, t: 1 }] },
    ghz: { label: "Three entangled qubits (GHZ)", n: 3, gates: [{ g: "H", t: 0 }, { g: "CNOT", c: 0, t: 1 }, { g: "CNOT", c: 1, t: 2 }] },
    all: { label: "All four outcomes", n: 2, gates: [{ g: "H", t: 0 }, { g: "H", t: 1 }] },
    interfere: { label: "Interference: H, Z, H", n: 1, gates: [{ g: "H", t: 0 }, { g: "Z", t: 0 }, { g: "H", t: 0 }] },
  };

  function lab() {
    return `
      <p class="soft">Three small simulators that run in your browser. They show amplitudes, which real hardware never lets you see:
        on a quantum computer you only get the measurement counts. ${simTag()}</p>
      <div class="q-lab">
        <div class="card">
          <h3>One qubit</h3>
          <p class="caption">It starts at |0⟩. <b>H</b> makes an equal superposition, <b>X</b> swaps 0 and 1, <b>Z</b> flips the sign of the |1⟩ amplitude.</p>
          <div class="row" id="q1-gates">${["H", "X", "Z"].map((g) => `<button type="button" class="btn q-gbtn" data-g="${g}">${g}</button>`).join("")}
            <button type="button" class="btn" data-g="reset">Reset</button></div>
          <div class="q-state" id="q1-state"></div>
          <div id="q1-amps"></div>
          <p class="caption" id="q1-hist"></p>
          <p class="caption">Bar length is the probability; red means a negative amplitude. Try <b>H, Z, H</b>: you end on |1⟩ every time.
            Z changed a sign that the probabilities can't show, and the second H turned it into interference.</p>
        </div>
        <div class="card">
          <h3>Circuit simulator</h3>
          <div class="controls q-ctl">
            <div class="control"><label for="qc-n">Qubits</label><select id="qc-n">${[1, 2, 3, 4, 5].map((k) => `<option>${k}</option>`).join("")}</select></div>
            <div class="control"><span class="label">Gate</span><div class="chips" id="qc-gate">${["H", "X", "Z", "CNOT"].map((g) => `<button type="button" class="chip" data-g="${g}">${g}</button>`).join("")}</div></div>
            <div class="control" id="qc-cwrap"><label for="qc-c">Control</label><select id="qc-c"></select></div>
            <div class="control"><label for="qc-t">Target</label><select id="qc-t"></select></div>
            <div class="row" style="margin:0"><button type="button" class="btn primary" id="qc-add">Add gate</button><button type="button" class="btn" id="qc-undo">Undo</button>
              <button type="button" class="btn" id="qc-clear">Clear</button></div>
          </div>
          <div class="row q-presets"><span class="caption" style="margin:0">Presets:</span>${Object.entries(PRESETS).map(([k, p]) =>
            `<button type="button" class="btn" data-preset="${k}">${esc(p.label)}</button>`).join("")}</div>
          <div class="q-svgwrap" id="qc-draw"></div>
          <div class="grid g2 q-out">
            <div><div class="chart-title">Amplitudes</div><div id="qc-amps"></div></div>
            <div><div class="chart-title">Measured 1,000 times <button type="button" class="btn q-small" id="qc-run">Run again</button></div><div id="qc-shots"></div></div>
          </div>
          <p class="caption">States are written |q${"…"}q1 q0⟩ with qubit 0 on the right, as in Qiskit. The entangled pair gives only 00 and 11: each qubit
            alone is random, but they always agree.</p>
        </div>
      </div>
      <div class="card q-grover-card">
        <h3>Grover search, step by step</h3>
        <p class="caption">One item in the list is "marked": a black-box oracle can recognise it but not point to it. Grover's algorithm makes it
          likely to be measured in about √N steps instead of N/2 guesses.</p>
        <div class="controls q-ctl">
          <div class="control"><span class="label">List size</span><div class="chips" id="gr-n"><button type="button" class="chip" data-n="8">8 items</button><button type="button" class="chip" data-n="16">16 items</button></div></div>
          <div class="control"><label for="gr-mark">Marked item</label><select id="gr-mark"></select></div>
          <div class="row" style="margin:0"><button type="button" class="btn primary" id="gr-step">Next step</button><button type="button" class="btn" id="gr-play">Play</button>
            <button type="button" class="btn" id="gr-reset">Reset</button></div>
        </div>
        <div class="q-grover" id="gr-bars"></div>
        <p class="q-explain" id="gr-explain"></p>
        <div class="q-pk" id="gr-pk"></div>
        <div class="q-callout"><b>Analogy only.</b> Labelling the items as stocks makes this look like a stock screener, but it isn't one. A real screener
          scans a table it already has, and loading that table into a quantum computer would take as long as scanning it. Grover's speedup is for
          black-box search; in finance its main use is as a building block of amplitude estimation (sections 4 to 6).</div>
      </div>`;
  }

  function initLab(sec) {
    // One qubit
    let one = Float64Array.from([1, 0]), hist = [];
    const drawOne = () => {
      $("#q1-state", sec).textContent = stateText(one, 1);
      $("#q1-amps", sec).innerHTML = ampRows(one, 1);
      $("#q1-hist", sec).textContent = hist.length ? `Gates so far: |0⟩ → ${hist.join(" → ")}` : "No gates yet.";
    };
    sec.querySelectorAll("#q1-gates [data-g]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.g === "reset") { one = Float64Array.from([1, 0]); hist = []; } else { applyGate(one, { g: b.dataset.g, t: 0 }); hist.push(b.dataset.g); }
      drawOne();
    }));
    drawOne();

    // Circuit simulator
    const C = Object.assign({ n: 2, gates: PRESETS.bell.gates.slice(), gate: "H", t: 0, c: 0, seed: 1 }, store.get("q:circuit", {}));
    C.n = Math.min(5, Math.max(1, C.n | 0));
    C.gates = (C.gates || []).filter((g) => g.t < C.n && (g.g !== "CNOT" || (g.c < C.n && g.c !== g.t)));
    const sel = (id, v, skip) => { $(id, sec).innerHTML = Array.from({ length: C.n }, (_, q) => `<option value="${q}"${q === v ? " selected" : ""}${q === skip ? " disabled" : ""}>q${q}</option>`).join(""); };
    const drawCirc = () => {
      store.set("q:circuit", { n: C.n, gates: C.gates });
      $("#qc-n", sec).value = String(C.n);
      sec.querySelectorAll("#qc-gate .chip").forEach((b) => b.classList.toggle("on", b.dataset.g === C.gate));
      if (C.t >= C.n) C.t = C.n - 1;
      if (C.c >= C.n || C.c === C.t) C.c = C.t === 0 ? Math.min(1, C.n - 1) : 0;
      const cnot = C.gate === "CNOT";
      $("#qc-cwrap", sec).style.display = cnot ? "" : "none";
      sel("#qc-t", C.t, cnot ? C.c : -1); sel("#qc-c", C.c, C.t);
      $("#qc-add", sec).disabled = cnot && C.n < 2;
      $("#qc-draw", sec).innerHTML = circuitSvg(C.n, C.gates);
      const state = simulate(C.n, C.gates);
      $("#qc-amps", sec).innerHTML = ampRows(state, C.n, { hideZero: C.n > 3 }) + (C.n > 3 ? '<p class="caption">States with amplitude 0 are hidden.</p>' : "");
      const counts = sampleCounts(probabilities(state), 1000, C.seed);
      $("#qc-shots", sec).innerHTML = counts.map((k, i) => [k, i]).filter(([k]) => k > 0).map(([k, i]) =>
        `<div class="q-amp"><span class="k">${ket(i, C.n)}</span><span class="track"><span class="fill shots" style="width:${k / 10}%"></span></span><span class="v">${k}</span><span class="p">${(k / 10).toFixed(1)}%</span></div>`).join("");
    };
    $("#qc-n", sec).addEventListener("change", (e) => { C.n = Number(e.target.value); C.gates = C.gates.filter((g) => g.t < C.n && (g.g !== "CNOT" || g.c < C.n)); drawCirc(); });
    sec.querySelectorAll("#qc-gate .chip").forEach((b) => b.addEventListener("click", () => { C.gate = b.dataset.g; drawCirc(); }));
    $("#qc-t", sec).addEventListener("change", (e) => { C.t = Number(e.target.value); drawCirc(); });
    $("#qc-c", sec).addEventListener("change", (e) => { C.c = Number(e.target.value); drawCirc(); });
    $("#qc-add", sec).addEventListener("click", () => {
      if (C.gates.length >= 24) return;
      C.gates.push(C.gate === "CNOT" ? { g: "CNOT", c: C.c, t: C.t } : { g: C.gate, t: C.t });
      drawCirc();
    });
    $("#qc-undo", sec).addEventListener("click", () => { C.gates.pop(); drawCirc(); });
    $("#qc-clear", sec).addEventListener("click", () => { C.gates = []; drawCirc(); });
    $("#qc-run", sec).addEventListener("click", () => { C.seed++; drawCirc(); });
    sec.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const p = PRESETS[b.dataset.preset];
      C.n = p.n; C.gates = p.gates.map((g) => Object.assign({}, g)); drawCirc();
    }));
    drawCirc();

    // Grover
    const G = { n: 16, marked: 6, steps: [], i: 0, timer: null };
    const stop = () => { if (G.timer) clearInterval(G.timer); G.timer = null; $("#gr-play", sec).textContent = "Play"; };
    const reset = () => {
      stop();
      G.steps = groverSteps(G.n, G.marked, 2 * groverOptimal(G.n) + 1);
      G.i = 0;
      sec.querySelectorAll("#gr-n .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === G.n));
      $("#gr-mark", sec).innerHTML = GROVER_ITEMS.slice(0, G.n).map((s, i) => `<option value="${i}"${i === G.marked ? " selected" : ""}>${s}</option>`).join("");
      drawGrover();
    };
    const drawGrover = () => {
      const st = G.steps[G.i], N = G.n, opt = groverOptimal(N);
      const pct1 = (x) => `${(100 * x).toFixed(1)}%`;
      const col = (a, i) => {
        const h = Math.abs(a) * 50;  // half the track per unit of amplitude
        return `<div class="q-gcol${i === G.marked ? " on" : ""}" title="${GROVER_ITEMS[i]}: amplitude ${a.toFixed(3)}, probability ${pct1(a * a)}">
          <div class="q-gtrack"><span class="q-gbar${a < 0 ? " neg" : ""}" style="height:${h}%;${a < 0 ? "top:50%" : `bottom:50%`}"></span></div>
          <span class="q-gname">${GROVER_ITEMS[i]}</span></div>`;
      };
      const meanLine = st.step === "oracle" ? `<span class="q-mean" style="bottom:${50 + st.mean * 50}%" title="Average amplitude ${st.mean.toFixed(3)}"></span>` : "";
      $("#gr-bars", sec).innerHTML = `<div class="q-gplot"><div class="q-gover"><span class="q-zero"></span>${meanLine}</div>${st.amps.map(col).join("")}</div>`;
      const pm = st.amps[G.marked] ** 2, name = GROVER_ITEMS[G.marked];
      $("#gr-explain", sec).innerHTML = st.step === "start"
        ? `<b>Start:</b> H gates give every item the same amplitude, 1/√${N} = ${(1 / Math.sqrt(N)).toFixed(3)}, so a measurement now picks ${name} only ${pct1(1 / N)} of the time.`
        : st.step === "oracle"
          ? `<b>Iteration ${st.k}, oracle:</b> the black box flips the sign of ${name}'s amplitude. The probabilities don't change yet. The dashed line is the average amplitude.`
          : `<b>Iteration ${st.k}, diffusion:</b> every amplitude is reflected about the average. ${name} jumps to ${st.amps[G.marked].toFixed(3)}, a ${pct1(pm)} chance;
            the others shrink.${st.k > opt ? " Past the best number of iterations, the probability falls again." : ""}`;
      const done = G.steps.filter((s, j) => j <= G.i && s.step === "diffusion").length;
      $("#gr-pk", sec).innerHTML = `P(${esc(name)}) after k iterations: ` + Array.from({ length: 2 * opt + 2 }, (_, k) =>
        `<span class="${k === done ? "on" : ""}${k === opt ? " best" : ""}">k=${k}: ${pct1(groverProbability(N, k))}${k === opt ? " (best)" : ""}</span>`).join("");
      $("#gr-step", sec).textContent = G.i + 1 < G.steps.length ? `Next: ${G.steps[G.i + 1].step}` : "Done";
      $("#gr-step", sec).disabled = G.i + 1 >= G.steps.length;
    };
    const next = () => { if (G.i + 1 < G.steps.length) { G.i++; drawGrover(); } else stop(); };
    $("#gr-step", sec).addEventListener("click", () => { stop(); next(); });
    $("#gr-play", sec).addEventListener("click", () => {
      if (G.timer) { stop(); return; }
      if (G.i + 1 >= G.steps.length) G.i = 0;
      G.timer = setInterval(next, 900);
      $("#gr-play", sec).textContent = "Pause";
    });
    $("#gr-reset", sec).addEventListener("click", reset);
    sec.querySelectorAll("#gr-n .chip").forEach((b) => b.addEventListener("click", () => { G.n = Number(b.dataset.n); G.marked = Math.min(G.marked, G.n - 1); reset(); }));
    $("#gr-mark", sec).addEventListener("change", (e) => { G.marked = Number(e.target.value); reset(); });
    timers.push(stop);
    reset();
  }
  SECTIONS.push({ id: "lab", title: "Interactive qubit lab", html: lab, init: initLab });

  // --- 3. Toolbox ----------------------------------------------------------------------------------
  const TOOLBOX = [
    ["Phase estimation / QFT", "Finds hidden periods (the phase of an operator)", "Exponential, as a component", "Inside Shor's algorithm and amplitude estimation"],
    ["Shor", "Factors large numbers, breaks discrete logarithms", "Exponential", "A threat to the encryption brokerages and banks use (section 11)"],
    ["Grover", "Searches an unsorted list for a marked item", "Quadratic", "The building block of amplitude estimation"],
    ["Amplitude estimation (QAE, iterative QAE)", "Estimates an average or a probability", "Quadratic vs Monte Carlo", "Option pricing, VaR, credit risk (sections 4 to 6)"],
    ["HHL / quantum linear algebra", "Solves Ax = b", "Exponential, under strict conditions", "Mean-variance portfolios (section 7)"],
    ["Block encoding / QRAM", "Loads matrices and data into qubits", "Enabling; often the bottleneck", "Every data-heavy use"],
    ["Variational (VQE, QAOA)", "A tunable circuit trained by a classical optimizer", "Heuristic, unproven", "Portfolio selection as a QUBO (section 7)"],
    ["Quantum ML (QNN, kernels)", "Classification and regression", "Unclear", "Stock prediction (speculative)"],
  ];
  function toolbox() {
    return `<p class="soft">The handful of building blocks almost every quantum algorithm is made of, and where each could matter for investors.</p>
      <div class="table-wrap q-table"><table><thead><tr><th>Building block</th><th>What it does</th><th>Speedup</th><th>Finance use</th></tr></thead>
      <tbody>${TOOLBOX.map((r) => `<tr><td><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join("")}</tbody></table></div>
      <p class="caption">A speedup counts queries or gates as the problem grows; it says nothing about today's hardware. "Quadratic" means about √N steps
        where a classical method needs N.</p>`;
  }
  SECTIONS.push({ id: "toolbox", title: "Quantum toolbox", html: toolbox });

  // --- 4. Monte Carlo vs amplitude estimation -------------------------------------------------------
  const big = (x) => Math.round(x).toLocaleString("en-US");
  const epsLabel = (e) => `${+(100 * e).toPrecision(2)}%`;
  function converge(ctx) {
    const cv = ctx.q && ctx.q.convergence;
    return `
      <p class="soft">Banks price derivatives and measure risk by Monte Carlo: simulate many scenarios and average them. The error shrinks like
        1/√N, so 10× more accuracy costs 100× more samples. Quantum amplitude estimation (QAE) estimates the same average with an error that
        shrinks like 1/N: 10× more accuracy for 10× more queries. That quadratic gap is the main reason finance cares about quantum computers.</p>
      <div class="q-formula"><span>error<sub>MC</sub> ≈ σ / √N</span><span>error<sub>QAE</sub> ≈ 1 / N</span></div>
      <div class="controls"><div class="control q-slider"><label for="cv-eps">Target error: <b id="cv-eps-v"></b></label>
        <input type="range" id="cv-eps" min="0" max="200" step="1" value="100" aria-describedby="cv-eps-v"></div></div>
      <div class="grid g3" id="cv-kpis"></div>
      <div class="chart" id="cv-chart"></div>
      <p class="caption">Lines: the two scaling laws with constants set to 1 (σ = 1). Blue dots: Monte Carlo measured in your browser.
        ${cv ? `Orange dots: iterative QAE on the nightly option circuit (${esc(cv.ticker)}, ${esc(cv.maturity_days)} days), error ÷ σ of one sample so it
        shares the scale, averaged over ${esc(cv.runs_per_point)} runs. ${simTag()}` : "The nightly QAE runs aren't published yet, so only the theory is shown for QAE."}</p>
      <p class="caption">Constants matter. In the option runs (section 5) the payoff encoding magnifies amplitude errors several times, so at that precision
        QAE needs about as many queries as Monte Carlo needs samples. Its advantage grows as the target error shrinks, and every query has to run on
        error-corrected hardware (section 10).</p>`;
  }
  async function initConverge(sec, ctx) {
    const c = pal(), cv = ctx.q && ctx.q.convergence;
    const xs = Array.from({ length: 91 }, (_, i) => 10 ** (i / 10));
    let measured = null;
    const draw = () => {
      const eps = 10 ** (-2 - Number($("#cv-eps", sec).value) / 100);
      const nMc = 1 / eps ** 2, nQ = 1 / eps;
      $("#cv-eps-v", sec).textContent = epsLabel(eps);
      $("#cv-kpis", sec).innerHTML = kpi("Monte Carlo", `${big(nMc)}`, "samples for that error (1/ε²)")
        + kpi("Amplitude estimation", `${big(nQ)}`, "oracle queries (1/ε)")
        + kpi("Quantum saving", `${big(nMc / nQ)}×`, "fewer evaluations, before hardware overheads");
      const traces = [
        { x: xs, y: xs.map((n) => 1 / Math.sqrt(n)), name: "Monte Carlo: 1/√N", mode: "lines", line: { color: c.series[0], width: 2 }, hovertemplate: "N = %{x:,.0f}: error %{y:.2e}<extra></extra>" },
        { x: xs, y: xs.map((n) => 1 / n), name: "QAE: 1/N", mode: "lines", line: { color: c.series[1], width: 2 }, hovertemplate: "N = %{x:,.0f}: error %{y:.2e}<extra></extra>" },
        { x: [nMc, nQ], y: [eps, eps], name: "Target", mode: "markers", marker: { size: 11, color: c.ink, symbol: "diamond" }, hovertemplate: "%{x:,.0f} evaluations<extra></extra>" },
      ];
      if (measured) traces.push({ x: measured.map((p) => p.n), y: measured.map((p) => p.rms), name: "Monte Carlo, measured here", mode: "markers",
        marker: { size: 9, color: c.series[0], line: { color: c.surface, width: 1.5 } }, hovertemplate: "N = %{x:,.0f}: RMS error %{y:.2e}<extra></extra>" });
      if (cv) traces.push({ x: cv.points.map((p) => p.oracle_queries), y: cv.points.map((p) => p.abs_error / cv.mc_sigma), name: "Iterative QAE, simulated nightly",
        mode: "markers", marker: { size: 9, color: c.series[1], line: { color: c.surface, width: 1.5 } },
        hovertemplate: "%{x:,.0f} oracle queries: error %{y:.2e} (simulated)<extra></extra>" });
      plot($("#cv-chart", sec), traces, layout(400, { hovermode: "closest",
        xaxis: { type: "log", title: { text: "Samples (Monte Carlo) or oracle queries (QAE)", font: { size: 11 } }, exponentformat: "power", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
        yaxis: yaxis({ type: "log", exponentformat: "power", title: { text: "Error", font: { size: 11 } } }),
        shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: eps, y1: eps, line: { color: c.muted, width: 1, dash: "dot" } }] }));
    };
    $("#cv-eps", sec).addEventListener("input", draw);
    draw();
    await new Promise((r) => setTimeout(r, 30));  // let the page paint before ~10M random draws
    measured = mcErrorCurve();
    draw();
  }
  SECTIONS.push({ id: "converge", title: "Monte Carlo vs quantum: convergence", html: converge, init: initConverge });

  // --- 5. Stock option pricing lab ---------------------------------------------------------------------
  const WINDOWS = [[63, "3 months"], [126, "6 months"], [252, "12 months"]];
  const money2 = (x) => (isNum(x) ? minus(x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : "–");
  function options() {
    return `
      <p class="soft">Price a European option on any stock in the universe three ways: the Black-Scholes formula, classical Monte Carlo, and quantum
        amplitude estimation from the nightly simulator. Spot and volatility come from about two years of daily prices that your browser loads from
        CNBC (Binance for coins); the volatility is annualised from daily log returns. Dividends are ignored.</p>
      <div class="controls">
        <div class="control"><span class="label">Stock</span><div class="q-pick"><b id="op-sym"></b><div id="op-search">${searchBox("Change stock")}</div></div></div>
        <div class="control"><span class="label">Volatility window</span><div class="chips" id="op-win">${WINDOWS.map(([w, l]) => `<button type="button" class="chip" data-v="${w}">${l}</button>`).join("")}</div></div>
        <div class="control"><span class="label">Maturity</span><div class="chips" id="op-days">${[30, 90, 180].map((d) => `<button type="button" class="chip" data-v="${d}">${d} days</button>`).join("")}</div></div>
        <div class="control"><span class="label">Type</span><div class="chips" id="op-kind"><button type="button" class="chip" data-v="call">Call</button><button type="button" class="chip" data-v="put">Put</button></div></div>
        <div class="control"><label for="op-k">Strike</label><div class="row" style="margin:0"><input type="number" id="op-k" step="0.01" min="0.01" style="width:110px">
          <button type="button" class="btn" id="op-atm">At the money</button></div></div>
        <div class="control"><label for="op-n">Monte Carlo paths</label><select id="op-n">${[1e3, 1e4, 1e5, 1e6].map((n) => `<option value="${n}">${big(n)}</option>`).join("")}</select></div>
      </div>
      <p class="caption" id="op-msg"></p>
      <div class="grid g4" id="op-inputs"></div>
      <div class="grid g3 q-compare" id="op-out"></div>
      <div class="chart-title">Monte Carlo converging to Black-Scholes as paths increase</div>
      <div class="chart" id="op-conv"></div>
      <h3 class="q-h3">How amplitude estimation prices this option</h3>
      <div class="q-steps" id="op-steps"></div>`;
  }

  async function initOptions(sec, ctx) {
    const O = Object.assign({ sym: "AAPL", win: 126, days: 90, kind: "call", n: 1e5 }, store.get("q:opt", {}), { strike: null, seed: 1, step: 0 });
    const rf = riskFree(ctx.market, ctx.q);
    let data = null, name = "";
    const items = (ctx.q && ctx.q.options.items) || [];
    const loadSym = async (sym) => {
      let h;
      try { h = await priceHistory(sym); } catch (e) { $("#op-msg", sec).textContent = e.message; return false; }
      if (h.close.length < 70) { $("#op-msg", sec).textContent = `${sym}: not enough price history.`; return false; }
      const row = await rowFor(sym);
      O.sym = sym; data = h; name = (row && row.n) || ""; $("#op-msg", sec).textContent = "";
      return true;
    };
    if (!(await loadSym(O.sym)) && !(await loadSym("AAPL"))) throw new Error("no price data");
    const chipsOn = (id, v) => sec.querySelectorAll(`#${id} .chip`).forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));

    const draw = () => {
      store.set("q:opt", { sym: O.sym, win: O.win, days: O.days, kind: O.kind, n: O.n });
      shareLab("options", { sym: O.sym, days: O.days, kind: O.kind, win: O.win, n: O.n });
      chipsOn("op-win", O.win); chipsOn("op-days", O.days); chipsOn("op-kind", O.kind);
      $("#op-n", sec).value = String(O.n);
      $("#op-sym", sec).innerHTML = `${esc(O.sym)}${name ? ` <span class="soft">${esc(name)}</span>` : ""}`;
      const S = data.values[data.values.length - 1], vol = annualVol(data.values, O.win), T = O.days / 365, r = rf.r;
      if (!isNum(O.strike) || O.strike <= 0) O.strike = Math.round(S * 100) / 100;
      $("#op-k", sec).value = O.strike.toFixed(2);
      const K = O.strike;
      $("#op-inputs", sec).innerHTML = kpi("Spot price", money2(S), `last close, ${esc(data.dates[data.dates.length - 1])} · ${esc(data.source)}`)
        + kpi("Volatility", pct(vol, 1, false), `annualised, last ${WINDOWS.find((w) => w[0] === O.win)[1]} of daily log returns`)
        + kpi("Risk-free rate", pct(rf.pct / 100, 2, false), `${esc(rf.label)}${rf.series ? ` (FRED ${esc(rf.series)})` : ""}${rf.date ? `, ${esc(rf.date)}` : ""}; continuous ${pct(r, 2, false)}`)
        + kpi("Time to expiry", `${O.days} days`, `T = ${O.days}/365 = ${T.toFixed(3)} years`);
      const bs = blackScholes(S, K, T, r, vol, O.kind);
      const mc = mcOption({ S, K, T, r, vol, kind: O.kind, n: O.n, seed: O.seed, checkpoints: [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6] });
      const item = items.find((it) => it.ticker === O.sym && it.maturity_days === O.days);
      $("#op-out", sec).innerHTML = `
        <div class="card q-res"><div class="q-res-h">Black-Scholes <span class="badge">formula</span>${mq("q-black-scholes")}</div>
          <div class="q-big">${money2(bs.price)}</div>
          <div class="sub">d₁ ${num(bs.d1, 3)} · d₂ ${num(bs.d2, 3)} · delta ${num(bs.delta, 3)}</div>
          <p class="caption">Exact if prices are lognormal with constant volatility. The reference for the other two.</p></div>
        <div class="card q-res"><div class="q-res-h">Monte Carlo <span class="badge">classical</span>${mq("q-monte-carlo")}</div>
          <div class="q-big">${money2(mc.price)}</div>
          <div class="sub">95% interval ${money2(mc.ci[0])} – ${money2(mc.ci[1])} · ${big(mc.n)} paths · ${num(mc.price - bs.price, 3, true)} vs Black-Scholes</div>
          <div class="row"><button type="button" class="btn q-small" id="op-rerun">Run again with new random numbers</button></div></div>
        ${quantumCard(item, { S, K, vol, r, kind: O.kind })}`;
      $("#op-rerun", sec).addEventListener("click", () => { O.seed++; draw(); });
      const useBtn = $("#op-use", sec);
      if (useBtn) useBtn.addEventListener("click", () => { O.win = ctx.q.options.vol_window; O.kind = "call"; O.strike = item.strike; draw(); });
      sec.querySelectorAll("[data-op-sym]").forEach((b) => b.addEventListener("click", async () => {
        if (await loadSym(b.dataset.opSym)) { O.strike = null; O.days = Number(b.dataset.opDays) || O.days; draw(); }
      }));
      const c = pal(), xs = mc.path.map((p) => p.n);
      plot($("#op-conv", sec), [
        { x: xs, y: mc.path.map((p) => p.price + p.half), mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
        { x: xs, y: mc.path.map((p) => p.price - p.half), mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: "rgba(42,120,214,0.15)", name: "95% interval", hoverinfo: "skip" },
        { x: xs, y: mc.path.map((p) => p.price), mode: "lines+markers", name: "Monte Carlo estimate", line: { color: c.series[0], width: 2 }, hovertemplate: "%{x:,} paths: %{y:.3f}<extra></extra>" },
        { x: [xs[0], xs[xs.length - 1]], y: [bs.price, bs.price], mode: "lines", name: "Black-Scholes", line: { color: c.ink, width: 1.5, dash: "dash" }, hovertemplate: "%{y:.3f}<extra>Black-Scholes</extra>" },
      ], layout(300, { hovermode: "closest", xaxis: { type: "log", title: { text: "Paths", font: { size: 11 } }, showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
        yaxis: yaxis({ title: { text: "Price", font: { size: 11 } } }) }));
      drawSteps({ S, K, vol, r, T, item });
    };

    function quantumCard(item, cur) {
      const head = `<div class="q-res-h">Amplitude estimation <span class="badge warn">quantum, simulated</span>${mq("q-qae")}</div>`;
      if (!ctx.q) return `<div class="card q-res">${head}<p class="soft">Not available yet: the nightly simulation results (data/quantum.json) haven't been published.
        The classical prices beside this don't need them.</p></div>`;
      if (!item) {
        const tick = [...new Set(items.map((it) => it.ticker))], days = [...new Set(items.map((it) => it.maturity_days))];
        return `<div class="card q-res">${head}<p class="soft"><b>Not precomputed</b> for ${esc(O.sym)} at ${O.days} days. Each night the simulator prices
          at-the-money calls on ${esc(tick.join(", "))} at ${esc(days.join(", "))} days.</p>
          <div class="row">${tick.map((t) => `<button type="button" class="btn q-small" data-op-sym="${esc(t)}" data-op-days="${days.includes(O.days) ? O.days : days[0]}">Use ${esc(t)}</button>`).join("")}</div></div>`;
      }
      const T = item.maturity_days / 365, disc = Math.exp(-item.rate * T);
      const parity = (x) => x - item.spot + item.strike * disc;  // put from the simulated call
      const put = cur.kind === "put", f = put ? parity : (x) => x;
      // The nightly run uses the platform's own price store and the page uses CNBC's, so allow a little vendor noise.
      const same = Math.abs(cur.K / item.strike - 1) < 0.002 && Math.abs(cur.vol - item.vol) < 0.002 && Math.abs(cur.S / item.spot - 1) < 0.002
        && Math.abs(cur.r - item.rate) < 5e-5;
      const qae = item.qae, bsNightly = put ? parity(item.bs) : item.bs, nq = ctx.q.options.uncertainty_qubits;
      return `<div class="card q-res">${head}
        <div class="q-big">${money2(f(qae.price))}</div>
        <div class="sub">95% interval ${money2(f(qae.ci[0]))} – ${money2(f(qae.ci[1]))} · ${big(qae.oracle_queries)} oracle queries · ${esc(nq)} price qubits,
          ${esc(ctx.q.options.circuit.state_preparation.qubits)} in all</div>
        ${simTag()}
        <p class="caption">Nightly run on prices of ${esc(ctx.q.prices_as_of)}: ${put ? "a call, turned into this put by put-call parity; " : ""}spot ${money2(item.spot)},
          strike ${money2(item.strike)}, volatility ${pct(item.vol, 1, false)} (6 months), rate ${pct(item.rate, 2, false)}.${same ? ""
            : ` <b>Your inputs differ</b>, so compare it with Black-Scholes on the nightly inputs: ${money2(bsNightly)}.`}</p>
        ${same ? "" : '<div class="row"><button type="button" class="btn q-small" id="op-use">Use the nightly inputs</button></div>'}
        <table class="q-mini"><tbody>
          <tr><td>QAE estimate</td><td class="r">${money2(f(qae.price))}</td><td>± the measurements' sampling error</td></tr>
          <tr><td>Circuit's exact value</td><td class="r">${money2(f(item.circuit_exact))}</td><td>what QAE is estimating</td></tr>
          <tr><td>Exact on the ${2 ** nq}-price grid</td><td class="r">${money2(f(item.grid_exact))}</td><td>gap above: the payoff's approximate encoding</td></tr>
          <tr><td>Black-Scholes, same inputs</td><td class="r">${money2(bsNightly)}</td><td>gap above: only ${2 ** nq} prices, cut at ±3σ</td></tr>
        </tbody></table></div>`;
    }

    function drawSteps({ S, K, vol, r, T, item }) {
      const nq = ctx.q ? ctx.q.options.uncertainty_qubits : 5, lb = lognormalBounds(S, T, r, vol);
      const powers = item ? item.qae.grover_powers.join(", ") : "0, 1, 4, 26, …";
      const steps = [
        ["Define the payoff and the model", `A call pays max(S<sub>T</sub> − K, 0) at expiry. As in Black-Scholes, the price at expiry S<sub>T</sub> is lognormal: here
          S₀ = ${money2(S)}, volatility ${pct(vol, 1, false)}, rate ${pct(r, 2, false)}, T = ${T.toFixed(3)} years, strike K = ${money2(K)}.`],
        ["Load the price distribution into qubits", `Cut the lognormal into 2<sup>n</sup> prices (${nq} qubits give ${2 ** nq} prices from ${money2(lb.low)} to
          ${money2(lb.high)}, ±3 standard deviations) and prepare a state whose squared amplitudes are their probabilities. One circuit now holds the whole distribution.`],
        ["Encode the payoff in one qubit", `A comparator checks whether the price is above the strike, and controlled rotations turn each price's payoff into a
          small rotation of one extra <b>objective qubit</b>. The probability of reading that qubit as 1 then tracks the average payoff.`],
        ["Amplify, Grover style", `The Grover operator Q turns that probability around a circle by a fixed angle each time. Iterative amplitude estimation runs
          the circuit with Q repeated ${esc(powers)} times and narrows down the angle from the counts (Grinko et al., 2019).`],
        ["Measure and convert to a price", `The estimated probability maps back to an average payoff. Discounting by e<sup>−rT</sup> gives the price, with a
          95% interval from the measurement statistics.${item ? ` Tonight's simulated result for the call: ${money2(item.qae.price)}.` : ""}`],
        ["Compare with Monte Carlo", `Monte Carlo needs about 1/ε² samples for error ε; amplitude estimation needs about 1/ε queries (section 4). This circuit
          is small enough for a PC to simulate in seconds. A real speedup needs error-corrected hardware that doesn't exist yet (section 10).`],
      ];
      const box = $("#op-steps", sec), redraw = () => drawSteps({ S, K, vol, r, T, item });
      box.innerHTML = `<div class="q-step-tabs">${steps.map((st, i) => `<button type="button" class="${i === O.step ? "on" : ""}" data-step="${i}"><span>${i + 1}</span>${esc(st[0])}</button>`).join("")}</div>
        <div class="q-step-body"><b>Step ${O.step + 1} of 6. ${esc(steps[O.step][0])}.</b> ${steps[O.step][1]}
          <div class="row"><button type="button" class="btn q-small" data-move="-1"${O.step ? "" : " disabled"}>Back</button><button type="button" class="btn q-small" data-move="1"${O.step < 5 ? "" : " disabled"}>Next</button></div></div>`;
      box.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { O.step = Number(b.dataset.step); redraw(); }));
      box.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => { O.step = Math.min(5, Math.max(0, O.step + Number(b.dataset.move))); redraw(); }));
    }

    bindSearch($("#op-search", sec), async (sym) => { if (await loadSym(sym)) { O.strike = null; draw(); } });
    sec.querySelectorAll("#op-win .chip").forEach((b) => b.addEventListener("click", () => { O.win = Number(b.dataset.v); draw(); }));
    sec.querySelectorAll("#op-days .chip").forEach((b) => b.addEventListener("click", () => { O.days = Number(b.dataset.v); draw(); }));
    sec.querySelectorAll("#op-kind .chip").forEach((b) => b.addEventListener("click", () => { O.kind = b.dataset.v; draw(); }));
    $("#op-n", sec).addEventListener("change", (e) => { O.n = Number(e.target.value); draw(); });
    $("#op-k", sec).addEventListener("change", (e) => { const k = Number(e.target.value); if (k > 0) { O.strike = k; draw(); } });
    $("#op-atm", sec).addEventListener("click", () => { O.strike = null; draw(); });
    draw();
  }
  SECTIONS.push({ id: "options", title: "Stock option pricing lab", html: options, init: initOptions });

  // --- 6. Stock risk lab: VaR and CVaR -------------------------------------------------------------------
  function risk(ctx) {
    return `
      <p class="soft">Value at risk (VaR) is the loss a portfolio shouldn't exceed on 95% (or 99%) of days. Conditional VaR (CVaR, or expected shortfall)
        is the average loss on the days that do exceed it. Pick up to 10 stocks; weights are equal unless you change them.</p>
      ${basketHtml("rk")}
      <div class="controls">
        <div class="control"><span class="label">History</span><div class="chips" id="rk-look"><button type="button" class="chip" data-v="252">1 year</button><button type="button" class="chip" data-v="500">2 years</button></div></div>
        <div class="control"><label for="rk-amt">Portfolio value ($)</label><input type="number" id="rk-amt" min="1000" step="1000" style="width:140px"></div>
      </div>
      <p class="caption">VaR and CVaR methods ${mq("q-var")}</p>
      <div id="rk-out"></div>
      <div class="chart-title">Daily returns of this basket, with the historical VaR lines</div><div class="chart" id="rk-hist"></div>
      <h3 class="q-h3">The quantum angle ${mq("q-qae-var")}</h3>
      <div id="rk-q"></div>
      <div class="q-callout"><b>Why this is the most credible near-term use.</b> Banks already run enormous Monte Carlo simulations every night to measure
        market risk (VaR, CVaR) and the capital they must hold against credit losses. Those are exactly the averages and tail probabilities amplitude
        estimation targets, with quadratically fewer samples for the same accuracy (Woerner &amp; Egger on market risk, Egger et al. on credit risk).
        The catch is the same as everywhere else: it needs error-corrected hardware and a cheap way to load the return distribution.</div>`;
  }
  async function initRisk(sec, ctx) {
    const qv = ctx.q && ctx.q.var;
    const saved = store.get("q:risk", {});
    const B = { syms: Array.isArray(saved.syms) && saved.syms.length ? saved.syms : (qv ? qv.basket.slice() : ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]) };
    B.w = Array.isArray(saved.w) && saved.w.length === B.syms.length ? saved.w : B.syms.map(() => 1 / B.syms.length);
    const R = { look: saved.look || 500, amt: saved.amt || 1e6, run: 0 };
    const chipsOn = () => sec.querySelectorAll("#rk-look .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === R.look));
    $("#rk-amt", sec).value = R.amt;
    const compute = async () => {
      const run = ++R.run;
      store.set("q:risk", { syms: B.syms, w: B.w, look: R.look, amt: R.amt });
      shareLab("risk", { syms: B.syms, w: B.w.map((x) => +(100 * x).toFixed(2)), look: R.look, amt: R.amt });
      chipsOn();
      const out = $("#rk-out", sec);
      if (!B.syms.length) { out.innerHTML = '<div class="empty">Add at least one stock.</div>'; return; }
      const px = await basketPrices(B.syms, R.look);
      if (run !== R.run) return;  // a newer edit is already computing
      const tw = sum(B.w) || 1, w = B.w.map((x) => x / tw);
      const rows = returnRows(px.values), daily = portfolio(rows, w), ten = horizon(daily, 10);
      const mc1 = mcPortfolio(rows, w, { h: 1 }), mc10 = mcPortfolio(rows, w, { h: 10, seed: 12 });
      const res = [["Historical simulation", "1 day", daily], ["Historical simulation", "10 days", ten], ["Monte Carlo (normal fit)", "1 day", mc1], ["Monte Carlo (normal fit)", "10 days", mc10]]
        .map(([m, h, r]) => ({ m, h, a: varCvar(r, 0.95), b: varCvar(r, 0.99) }));
      const cell = (x) => `${pct(x, 2, false)}<div class="q-dollar">${money(x * R.amt)}</div>`;
      out.innerHTML = `<div class="table-wrap q-risk"><table><thead><tr><th>Method</th><th>Horizon</th><th class="r">VaR 95%</th><th class="r">CVaR 95%</th><th class="r">VaR 99%</th><th class="r">CVaR 99%</th></tr></thead>
        <tbody>${res.map((x) => `<tr><td>${x.m}</td><td>${x.h}</td><td class="r">${cell(x.a.var)}</td><td class="r">${cell(x.a.cvar)}</td><td class="r">${cell(x.b.var)}</td><td class="r">${cell(x.b.cvar)}</td></tr>`).join("")}</tbody></table></div>
        <p class="caption">${esc(B.syms.join(", "))} · ${daily.length} trading days, ${esc(px.dates[1])} to ${esc(px.dates[px.dates.length - 1])} · rebalanced daily to the weights.
          10-day historical figures use overlapping 10-day windows, so they rest on few independent observations. Monte Carlo draws 20,000 scenarios from a
          normal fit, which understates fat tails; compare its 99% figures with the historical ones.</p>`;
      const c = pal(), v95 = res[0].a.var, v99 = res[0].b.var;
      plot($("#rk-hist", sec), [{ type: "histogram", x: daily, nbinsx: 60, marker: { color: c.series[0], line: { color: c.surface, width: 1 } }, hovertemplate: "%{x}: %{y} days<extra></extra>", name: "Days" }],
        layout(280, { showlegend: false, hovermode: "closest", bargap: 0.02, xaxis: { tickformat: ".0%", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
          yaxis: yaxis({ title: { text: "Days", font: { size: 11 } } }),
          shapes: [[v95, c.series[3]], [v99, c.bad]].map(([v, col]) => ({ type: "line", x0: -v, x1: -v, yref: "paper", y0: 0, y1: 1, line: { color: col, width: 2, dash: "dash" } })),
          annotations: [[v95, "VaR 95%"], [v99, "VaR 99%"]].map(([v, t]) => ({ x: -v, y: 1, yref: "paper", text: t, showarrow: false, xanchor: "right", yanchor: "top", xshift: -4, font: { size: 11, color: c.muted } })) }));
      drawQuantum(B.syms, w, res[0].a.var, R.look);
    };
    const drawQuantum = (syms, w, histVar, look) => {
      const box = $("#rk-q", sec);
      if (!qv) { box.innerHTML = `<p class="soft">Not available yet: the nightly simulation results (data/quantum.json) haven't been published.</p>`; return; }
      const mine = sameSet(syms, qv.basket) && w.every((x) => Math.abs(x - 1 / syms.length) < 1e-6) && look === qv.sessions;
      const t = qv.tail, bi = qv.bisection;
      box.innerHTML = `
        <p class="soft">Each night the simulator loads this basket's daily return distribution into ${esc(qv.qubits_distribution)} qubits (${2 ** qv.qubits_distribution} return bins)
          and uses amplitude estimation to measure the probability of a loss beyond a threshold, the quantity VaR is built from.</p>
        <div class="grid g3 q-compare">
          ${kpi("Nightly basket", esc(qv.basket.join(", ")), `equal weights · ${esc(qv.sessions)} days to ${esc(qv.to)}`)}
          ${kpi("Tail probability, exact", pct(t.exact, 2, false), `P(return &lt; ${pct(t.threshold, 2)}) on the ${2 ** qv.qubits_distribution}-bin distribution; classical`)}
          ${kpi("Tail probability, QAE", pct(t.qae, 2, false), `95% interval ${pct(t.ci[0], 2, false)} – ${pct(t.ci[1], 2, false)} · ${big(t.oracle_queries)} oracle queries`)}
        </div>
        ${simTag()}
        <p class="caption">The threshold ${pct(t.threshold, 2)} is the bin edge nearest the basket's historical 1-day VaR 95% of ${pct(qv.classical.var, 2, false)}
          (CVaR ${pct(qv.classical.cvar, 2, false)}). VaR itself, found by bisection over ${bi.steps.length} QAE estimates: <b>${pct(bi.var_qae, 2, false)}</b>,
          against ${pct(bi.var_binned_exact, 2, false)} computed exactly on the same bins. Finer answers need more qubits.
          ${mine ? `This is your basket: the page's own historical VaR above is ${pct(histVar, 2, false)}.` : ""}</p>
        ${mine ? "" : '<div class="row"><button type="button" class="btn q-small" id="rk-load">Load the nightly basket</button></div>'}
        <details><summary>Bisection steps</summary>${table([
          { h: "Threshold (return)", r: 1, f: (s) => pct(s.edge, 2) }, { h: "Tail probability, QAE", r: 1, f: (s) => pct(s.tail_qae, 2, false) },
          { h: "Exact", r: 1, f: (s) => pct(s.tail_exact, 2, false) }, { h: "Next", f: (s) => (s.tail_qae >= qv.alpha ? "go lower" : "go higher") },
        ], bi.steps)}</details>`;
      const load = $("#rk-load", sec);
      if (load) load.addEventListener("click", () => { B.syms = qv.basket.slice(); B.w = B.syms.map(() => 1 / B.syms.length); R.look = qv.sessions; redraw(); compute().catch(fail); });
    };
    const fail = (e) => { console.error(e); $("#rk-out", sec).innerHTML = `<div class="empty">${esc(e.message)}</div>`; };
    const redraw = bindBasket(sec, "rk", B, { min: 1, max: 10, weights: true, onChange: () => compute().catch(fail) });
    sec.querySelectorAll("#rk-look .chip").forEach((b) => b.addEventListener("click", () => { R.look = Number(b.dataset.v); compute().catch(fail); }));
    $("#rk-amt", sec).addEventListener("change", (e) => { R.amt = Math.max(1000, Number(e.target.value) || 1e6); compute().catch(fail); });
    await compute();
  }
  SECTIONS.push({ id: "risk", title: "Stock risk lab: VaR and CVaR", html: risk, init: initRisk });

  // --- 7. Portfolio optimization lab -----------------------------------------------------------------------
  const pickNames = (syms, mask) => syms.filter((_, i) => (mask >> i) & 1);
  function portfolioSec() {
    return `
      <p class="soft">Two ways to choose a portfolio, each with a classical answer you can trust and the quantum route researchers are exploring.
        Pick 3 to 15 stocks; expected returns and the covariance matrix are estimated from about two years of daily prices that your browser loads
        from CNBC, and annualised.</p>
      ${basketHtml("pf")}
      <div class="controls"><div class="control"><span class="label">History</span><div class="chips" id="pf-look"><button type="button" class="chip" data-v="252">1 year</button>
        <button type="button" class="chip" data-v="500">2 years</button></div></div></div>
      <h3 class="q-h3">a) Mean-variance (Markowitz) ${mq("q-frontier")}</h3>
      <p class="soft">Long only and fully invested: weights are at least 0 and add up to 100%. The efficient frontier is the best return for each level of risk.</p>
      <div class="controls">
        <div class="control"><span class="label">Portfolio to show</span><div class="chips" id="pf-pick"><button type="button" class="chip" data-v="sharpe">Maximum Sharpe</button>
          <button type="button" class="chip" data-v="minvar">Minimum variance</button><button type="button" class="chip" data-v="lam">Choose risk aversion</button></div></div>
        <div class="control q-slider" id="pf-lamwrap"><label for="pf-lam">Return weight λ: <b id="pf-lam-v"></b></label><input type="range" id="pf-lam" min="0" max="100" step="1"></div>
      </div>
      <div class="q-two"><div class="chart" id="pf-front"></div><div id="pf-weights"></div></div>
      <p class="caption" id="pf-note"></p>
      <div id="pf-corr"></div>
      <div class="q-callout"><b>The quantum route.</b> Kerenidis, Prakash and Szilágyi (2019) write constrained portfolio optimization as a second-order cone program
        and solve it with a quantum interior-point method, whose inner steps solve linear systems with HHL-style quantum linear algebra. The claimed speedup
        is polynomial, not exponential, and it depends on the condition numbers of those systems, on how precisely the weights must be read out, and on
        loading the covariance matrix into qubits. For 15 stocks the classical solver above takes milliseconds.</div>
      <h3 class="q-h3">b) Hold at most K stocks (cardinality) ${mq("q-qubo")}</h3>
      <p class="soft">Choosing exactly K names out of n is a yes/no decision per stock, which makes the problem combinatorial, the kind QAOA targets.
        Each chosen stock gets weight 1/K, and x<sub>i</sub> = 1 means "hold stock i".</p>
      <div class="controls">
        <div class="control q-slider" style="min-width:200px"><label for="pf-k">K, stocks to hold: <b id="pf-k-v"></b></label><input type="range" id="pf-k" min="1" max="14" step="1"></div>
        <div class="control q-slider" style="min-width:200px"><label for="pf-ql">Return weight λ: <b id="pf-ql-v"></b></label><input type="range" id="pf-ql" min="0" max="40" step="1"></div>
      </div>
      <div class="q-formula"><span>minimise&nbsp; x′(Σ/K²)x − (λ/K)·μ′x + P·(Σx<sub>i</sub> − K)²&nbsp; = x′Qx + c,&nbsp; x<sub>i</sub> ∈ {0, 1}</span></div>
      <p class="caption" id="pf-qnote"></p>
      <div id="pf-qubo"></div>
      <div id="pf-brute"></div>
      <h3 class="q-h3">QAOA on the nightly basket ${mq("q-qaoa")}</h3>
      <div id="pf-qaoa"></div>`;
  }
  async function initPortfolio(sec, ctx) {
    const qa = ctx.q && ctx.q.qaoa, rf = riskFree(ctx.market, ctx.q).pct / 100;
    const saved = store.get("q:pf", {});
    const B = { syms: Array.isArray(saved.syms) && saved.syms.length >= 3 ? saved.syms : ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "JPM", "XOM"] };
    const P = { look: saved.look || 500, pick: saved.pick || "sharpe", lam: saved.lam ?? 50, K: saved.K || 3, ql: saved.ql ?? 10, run: 0 };
    let est = null;
    const lamOf = (v) => (v <= 0 ? 0 : 10 ** (-3 + (4.5 * v) / 100));
    const chipsOn = (id, v) => sec.querySelectorAll(`#${id} .chip`).forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
    const fail = (e) => { console.error(e); $("#pf-weights", sec).innerHTML = `<div class="empty">${esc(e.message)}</div>`; };

    const estimate = async () => {
      const run = ++P.run;
      store.set("q:pf", { syms: B.syms, look: P.look, pick: P.pick, lam: P.lam, K: P.K, ql: P.ql });
      shareLab("portfolio", { syms: B.syms, look: P.look, pick: P.pick, lam: P.lam, K: P.K, ql: P.ql });
      chipsOn("pf-look", P.look);
      const px = await basketPrices(B.syms, P.look);
      if (run !== P.run) return;
      const { mu, cov } = meanCov(returnRows(px.values));
      est = { syms: B.syms.slice(), mu: mu.map((x) => x * TD), cov: cov.map((r) => r.map((x) => x * TD)), from: px.dates[1], to: px.dates[px.dates.length - 1], n: px.dates.length - 1 };
      est.front = frontier(est.mu, est.cov, rf);
      drawFrontier(); drawQubo();
      if (typeof drawCorrelationPanel === "function") drawCorrelationPanel($("#pf-corr", sec), est.syms);  // shared with Compare
    };

    const drawFrontier = () => {
      chipsOn("pf-pick", P.pick);
      $("#pf-lamwrap", sec).style.display = P.pick === "lam" ? "" : "none";
      $("#pf-lam", sec).value = P.lam;
      const lam = lamOf(P.lam);
      $("#pf-lam-v", sec).textContent = num(lam, lam < 0.1 ? 3 : 2);
      const f = est.front, chosen = P.pick === "minvar" ? f.minVar : P.pick === "lam" ? stats(meanVariance(est.cov, est.mu, lam, f.minVar.w), est.mu, est.cov, rf) : f.maxSharpe;
      const eq = stats(est.syms.map(() => 1 / est.syms.length), est.mu, est.cov, rf);
      const c = pal(), vols = est.syms.map((_, i) => Math.sqrt(est.cov[i][i]));
      plot($("#pf-front", sec), [
        { x: f.points.map((p) => p.vol), y: f.points.map((p) => p.ret), mode: "lines", name: "Efficient frontier", line: { color: c.series[0], width: 2.5 }, hovertemplate: "risk %{x:.1%}, return %{y:.1%}<extra></extra>" },
        { x: vols, y: est.mu, mode: "markers+text", text: est.syms, textposition: "top center", textfont: { size: 10, color: c.muted }, name: "Single stocks",
          marker: { size: 7, color: c.muted }, hovertemplate: "%{text}: risk %{x:.1%}, return %{y:.1%}<extra></extra>" },
        { x: [eq.vol], y: [eq.ret], mode: "markers", name: "Equal weight", marker: { size: 10, color: c.series[2], symbol: "square" }, hovertemplate: "Equal weight: risk %{x:.1%}, return %{y:.1%}<extra></extra>" },
        { x: [chosen.vol], y: [chosen.ret], mode: "markers", name: "Chosen portfolio", marker: { size: 16, color: c.series[1], symbol: "star", line: { color: c.surface, width: 1 } },
          hovertemplate: "Chosen: risk %{x:.1%}, return %{y:.1%}<extra></extra>" },
      ], layout(380, { hovermode: "closest", xaxis: { tickformat: ".0%", title: { text: "Risk (annualised volatility)", font: { size: 11 } }, showgrid: false, linecolor: c.axis, tickfont: { color: c.muted }, rangemode: "tozero" },
        yaxis: yaxis({ tickformat: ".0%", title: { text: "Expected return (historical mean)", font: { size: 11 } } }) }));
      const rows = est.syms.map((s, i) => ({ s, w: chosen.w[i] })).sort((a, b) => b.w - a.w);
      $("#pf-weights", sec).innerHTML = `<div class="grid g3 q-tight">${kpi("Return", pct(chosen.ret, 1), "a year, historical mean")}${kpi("Risk", pct(chosen.vol, 1, false), "volatility")}
        ${kpi("Sharpe", num(chosen.sharpe, 2), `vs ${pct(rf, 2, false)} T-bills`)}</div>` + table([
        { h: "Stock", f: (x) => `<b>${esc(x.s)}</b>` }, { h: "Weight", f: (x) => bar(100 * x.w) },
      ], rows);
      $("#pf-note", sec).textContent = `${est.n} trading days, ${est.from} to ${est.to}. Historical average returns are very noisy estimates of future returns, `
        + "so the frontier looks far more precise than it is; that is a classical problem no quantum algorithm fixes.";
    };

    const drawQubo = () => {
      const n = est.syms.length;
      $("#pf-k", sec).max = String(n - 1);
      P.K = Math.min(Math.max(1, P.K), n - 1);
      $("#pf-k", sec).value = P.K; $("#pf-ql", sec).value = P.ql;
      const lam = P.ql / 20;
      $("#pf-k-v", sec).textContent = String(P.K); $("#pf-ql-v", sec).textContent = num(lam, 2);
      const qb = quboMatrix(est.mu, est.cov, P.K, lam);
      $("#pf-qnote", sec).textContent = `Σ and μ are this basket's annualised covariance and mean returns. Penalty P = ${num(qb.penalty, 4)}, constant c = ${num(qb.constant, 4)}.`;
      $("#pf-qubo", sec).innerHTML = matrixTable(qb.Q, est.syms);
      const bf = bruteForce(qb.Q, qb.constant, P.K);
      const desc = (m) => { const w = est.syms.map((_, i) => ((m >> i) & 1) / P.K), s = stats(w, est.mu, est.cov, rf); return `return ${pct(s.ret, 1)}, risk ${pct(s.vol, 1, false)}`; };
      $("#pf-brute", sec).innerHTML = `<div class="grid g3 q-compare">
          ${kpi("Classical: exact brute force", esc(pickNames(est.syms, bf.best.mask).join(", ")), `objective ${num(bf.best.f, 4)} · ${desc(bf.best.mask)}`)}
          ${kpi("Portfolios checked", big(bf.all), `${big(bf.valid)} of them hold exactly ${P.K}`)}
          ${kpi("Penalty works", bf.global.mask === bf.best.mask ? "Yes" : "No", "the QUBO's overall minimum is a valid portfolio")}
        </div>
        ${table([{ h: "Rank", r: 1, f: (x) => x.rank }, { h: "Portfolio", f: (x) => esc(pickNames(est.syms, x.mask).join(", ")) }, { h: "x", f: (x) => `<code>${bits(x.mask, n)}</code>` },
          { h: "Objective", r: 1, f: (x) => num(x.f, 4) }, { h: "Return / risk", f: (x) => desc(x.mask) }], bf.top.map((x, i) => Object.assign({ rank: i + 1 }, x)))}
        <p class="caption">Brute force checks all 2<sup>n</sup> choices, which doubles with every stock: fine for 15, hopeless for 500. Real solvers use branch and bound,
          which handles hundreds of stocks; that is the bar QAOA would have to clear.</p>`;
    };

    const matrixTable = (Q, syms) => {
      const maxAbs = Math.max(...Q.flat().map(Math.abs)) || 1;
      const color = (v) => `background:${v < 0 ? `rgba(227,73,72,${(0.5 * Math.abs(v)) / maxAbs})` : `rgba(42,120,214,${(0.5 * v) / maxAbs})`}`;
      return `<div class="table-wrap q-matrix"><table><thead><tr><th>Q</th>${syms.map((s) => `<th class="r">${esc(s)}</th>`).join("")}</tr></thead><tbody>
        ${Q.map((row, i) => `<tr><th>${esc(syms[i])}</th>${row.map((v) => `<td class="r" style="${color(v)}">${num(v, 4)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <p class="caption">Diagonal: each stock's own risk and return, plus the penalty's −2K·P + P. Off the diagonal: covariances plus P. Red is negative, blue positive.</p>`;
    };

    const drawQaoa = () => {
      const box = $("#pf-qaoa", sec);
      if (!qa) { box.innerHTML = `<p class="soft">Not available yet: the nightly simulation results (data/quantum.json) haven't been published.</p>`; return; }
      const n = qa.basket.length, mine = bruteForce(qa.q, qa.constant, qa.k), agree = bits(mine.best.mask, n) === qa.brute_force.x;
      const top = qa.top_samples.slice(0, 8), maxP = Math.max(...top.map((s) => s.probability));
      box.innerHTML = `
        <p class="soft">Each night QAOA (${esc(qa.reps)} layers, ${esc(qa.optimizer)}, ${big(qa.shots)} shots) solves the QUBO for <b>${esc(qa.basket.join(", "))}</b> with K = ${esc(qa.k)}
          and λ = ${esc(qa.lambda)}: ${esc(n)} qubits, one per stock. <span class="badge warn">Results so far are mixed against good classical solvers</span></p>
        <div class="grid g4 q-compare">
          ${kpi("QAOA's best sample", esc(qa.best_sampled.picks.join(", ")), `objective ${num(qa.best_sampled.fval, 4)}`)}
          ${kpi("Brute-force optimum", esc(qa.brute_force.picks.join(", ")), `objective ${num(qa.brute_force.fval, 4)} · your browser agrees: ${agree ? "yes" : "no"}`)}
          ${kpi("Chance of sampling the optimum", pct(qa.p_optimum, 1, false), `a random valid pick: ${pct(qa.p_random, 1, false)}`)}
          ${kpi("Valid portfolios sampled", pct(qa.p_feasible, 0, false), `at random: ${pct(qa.p_feasible_random, 0, false)} · approximation ratio ${num(qa.approximation_ratio, 2)} (random ${num(qa.approximation_ratio_random, 2)})`)}
        </div>
        ${simTag()}
        <div class="chart-title">QAOA's most frequent answers</div>
        ${top.map((s) => `<div class="q-amp q-samp"><span class="k">${esc(s.x)}</span><span class="track"><span class="fill${s.x === qa.brute_force.x ? "" : " shots"}" style="width:${(100 * s.probability) / maxP}%"></span></span>
          <span class="v">${pct(s.probability, 1, false)}</span><span class="p">${esc(qa.basket.filter((_, i) => s.x[i] === "1").join(" "))}</span></div>`).join("")}
        <p class="caption">Blue bar: the optimum. Bits are in basket order (${esc(qa.basket.join(", "))}). QAOA learned the "hold exactly ${esc(qa.k)}" rule much better than chance, but
          among valid portfolios it does about as well as picking at random (approximation ratio: 1 means it always finds the optimum, 0 the worst valid portfolio).
          Its best sample is the optimum only because ${big(qa.shots)} shots cover all ${2 ** n} answers, which is not a speedup.</p>
        <details><summary>The nightly QUBO matrix (${esc(n)} × ${esc(n)})</summary>${matrixTable(qa.q, qa.basket)}</details>
        ${sameSet(B.syms, qa.basket) ? "" : '<div class="row"><button type="button" class="btn q-small" id="pf-load">Load the nightly basket into the lab</button></div>'}`;
      const load = $("#pf-load", sec);
      if (load) load.addEventListener("click", () => { B.syms = qa.basket.slice(); P.K = qa.k; P.ql = Math.round(qa.lambda * 20); redraw(); estimate().then(drawQaoa).catch(fail); });
    };

    const redraw = bindBasket(sec, "pf", B, { min: 3, max: 15, onChange: () => estimate().then(drawQaoa).catch(fail) });
    sec.querySelectorAll("#pf-look .chip").forEach((b) => b.addEventListener("click", () => { P.look = Number(b.dataset.v); estimate().catch(fail); }));
    sec.querySelectorAll("#pf-pick .chip").forEach((b) => b.addEventListener("click", () => { P.pick = b.dataset.v; store.set("q:pf", Object.assign(store.get("q:pf", {}), { pick: P.pick }));
      shareLab("portfolio", { syms: B.syms, look: P.look, pick: P.pick, lam: P.lam, K: P.K, ql: P.ql }); drawFrontier(); }));
    $("#pf-lam", sec).addEventListener("input", (e) => { P.lam = Number(e.target.value); drawFrontier(); });
    $("#pf-k", sec).addEventListener("input", (e) => { P.K = Number(e.target.value); drawQubo(); });
    $("#pf-ql", sec).addEventListener("input", (e) => { P.ql = Number(e.target.value); drawQubo(); });
    await estimate();
    drawQaoa();
  }
  SECTIONS.push({ id: "portfolio", title: "Portfolio optimization lab", html: portfolioSec, init: initPortfolio });

  // --- 8. Quantum readiness scorecard ----------------------------------------------------------------------
  const CHECKS = ["One output number?", "Classical baseline?", "Quantum-friendly structure?", "Data loading affordable?", "Small simulation runs?",
    "Full-size resource estimate", "Honest decision"];
  const SCORE = [
    ["Option pricing (section 5)", "Promising", ["Yes: the option's price, an average payoff", "Yes: Black-Scholes and Monte Carlo",
      "An average → amplitude estimation", "Yes: a lognormal model loads with a small circuit", "Yes: 5 price qubits, every night",
      "Thousands of logical qubits; T-depth in the tens of millions (published estimates, approximate)", "Wait for error-corrected hardware; stay classical today"]],
    ["VaR and CVaR (section 6)", "Promising", ["Yes: a tail probability, or the VaR level", "Yes: historical simulation and Monte Carlo",
      "A probability → amplitude estimation", "Manageable for a fitted model; costly for raw scenario data", "Yes: a 32-bin distribution, every night",
      "Similar to option pricing; more for many risk factors (approximate)", "Wait; prototype now, as banks do"]],
    ["Mean-variance portfolio (section 7a)", "Open question", ["Partly: a vector of weights, read out piece by piece", "Yes: a quadratic program solves 15 stocks in milliseconds",
      "A linear system → HHL / quantum interior point", "Costly: the covariance matrix needs QRAM or block encodings", "Not here: HHL needs error correction to mean anything",
      "Depends on condition numbers and precision; the speedup is polynomial at best", "Stay classical; follow the research"]],
    ["Hold K stocks (section 7b)", "Open question", ["Yes: the objective of the best portfolio", "Yes: brute force here, branch and bound in practice",
      "A binary choice → QAOA", "Cheap: n² QUBO coefficients", "Yes: 6 qubits, every night",
      "Unknown: QAOA is a heuristic with no proven speedup", "Stay classical; experiment if curious"]],
    ["Stock price prediction with quantum ML", "Not yet useful", ["No: \"predict the stock\" isn't one well-defined number", "Yes, and hard to beat: daily returns are mostly noise",
      "None clear → stop here", "Costly: loading market history can cancel any gain", "Possible, but they show little",
      "No credible estimate", "Stay classical. Claimed speedups are often matched by \"quantum-inspired\" classical algorithms"]],
  ];
  function scorecard() {
    const tone = { Promising: "good", "Open question": "warn", "Not yet useful": "bad" };
    return `<p class="soft">A seven-step check to run before anyone spends money on a quantum project: is there one number to estimate, a classical baseline,
        structure a quantum algorithm can use, an affordable way to load the data, evidence from small simulations, a full-size resource estimate, and an
        honest decision?</p>
      <div class="table-wrap q-table q-score"><table><thead><tr><th>Use case</th>${CHECKS.map((c, i) => `<th>${i + 1}. ${esc(c)}</th>`).join("")}<th>Verdict</th></tr></thead>
        <tbody>${SCORE.map(([name, verdict, cells]) => `<tr><td><b>${esc(name)}</b></td>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}
          <td><span class="badge ${tone[verdict]}">${esc(verdict)}</span></td></tr>`).join("")}</tbody></table></div>
      <p class="caption">Promising = the maths fits and the remaining gap is hardware. Open question = the speedup depends on conditions not yet shown to hold for
        real portfolios. Not yet useful = no structure to exploit. Resource estimates are approximate and come from published studies.</p>`;
  }
  SECTIONS.push({ id: "scorecard", title: "Quantum readiness scorecard", html: scorecard });

  // --- 9. The nightly simulator run ---------------------------------------------------------------------
  function nightly(ctx) {
    const q = ctx.q;
    if (!q) {
      return `<p class="soft">The quantum numbers in sections 4 to 7 come from a nightly job, <code>python -m quant.web.quantum</code>, that runs Qiskit on a
        simulator. Its results aren't published yet, so those panels say so; everything classical on this page works without them.</p>`;
    }
    const o = q.options, v = q.var, a = q.qaoa, queries = o.items.map((it) => it.qae.oracle_queries);
    const when = new Date(q.generated_at);
    const jobs = [
      { job: "Option pricing", what: `${o.items.length} at-the-money calls (${[...new Set(o.items.map((i) => i.ticker))].join(", ")}; ${[...new Set(o.items.map((i) => i.maturity_days))].join("/")} days) by iterative amplitude estimation`,
        qubits: o.circuit.state_preparation.qubits, depth: o.circuit.deepest.depth, cx: o.circuit.deepest.cx,
        q: `${big(Math.min(...queries))}–${big(Math.max(...queries))}`, s: sum(o.items.map((i) => i.runtime_s)) },
      { job: "Tail risk (VaR)", what: `P(loss beyond the 95% VaR) for ${v.basket.join(", ")}, then VaR by bisection`, qubits: v.circuit.state_preparation.qubits,
        depth: v.circuit.deepest.depth, cx: v.circuit.deepest.cx, q: big(v.tail.oracle_queries), s: v.runtime_s },
      { job: "Portfolio choice (QAOA)", what: `Hold ${a.k} of ${a.basket.join(", ")}; ${a.reps} QAOA layers`, qubits: a.circuit.qubits, depth: a.circuit.depth, cx: a.circuit.cx,
        q: `${big(a.shots)} shots per evaluation`, s: a.runtime_s },
    ];
    const pre = (t) => `<pre class="q-pre">${esc(t)}</pre>`;
    return `<p class="soft">Every night, after the market data refresh, the PC that publishes this site runs three small quantum programs on a simulator and writes
        the results to <code>quantum.json</code>. It runs in its own process with a ${esc(Math.round(300 / 60))}-minute limit; if anything fails, yesterday's file stays.</p>
      <div class="grid g4">
        ${kpi("Last run", esc(when.toISOString().slice(0, 10)), `${esc(when.toISOString().slice(11, 16))} UTC, on prices of ${esc(q.prices_as_of)}`)}
        ${kpi("Runtime", `${num(q.runtime_s, 0)} s`, "all three jobs, on an ordinary PC")}
        ${kpi("Simulator", "Statevector", "exact amplitudes, read out with sampled shots")}
        ${kpi("Quantum hardware", "None", "no accounts, no API keys")}
      </div>
      ${simTag()}
      ${table([
        { h: "Job", f: (j) => `<b>${esc(j.job)}</b>` }, { h: "What it estimates", cls: "wrap-text", f: (j) => esc(j.what) },
        { h: "Qubits", r: 1, f: (j) => esc(j.qubits) }, { h: "Deepest circuit (layers)", r: 1, f: (j) => big(j.depth) },
        { h: "CX gates in it", r: 1, f: (j) => big(j.cx) }, { h: "Oracle queries", r: 1, f: (j) => esc(j.q) }, { h: "Runtime", r: 1, f: (j) => `${num(j.s, 1)} s` },
      ], jobs)}
      <p class="caption">Depth and gate counts are after compiling to the basic gates rz, sx, x and CX. The deepest option circuit repeats the Grover operator
        ${esc(o.circuit.deepest.grover_power)} times: ${big(o.circuit.deepest.depth)} layers, far more than today's noisy hardware can run before errors swamp
        the answer (section 10). A simulator has no noise, which is why these runs work.</p>
      <div class="q-two">
        <div>${table([{ h: "Package", f: (r) => esc(r[0]) }, { h: "Version", f: (r) => `<code>${esc(r[1] || "–")}</code>` }], Object.entries(q.versions))}</div>
        <div>
          <details><summary>Circuit: option pricing (${esc(o.circuit.ticker)}, ${esc(o.circuit.maturity_days)} days)</summary>${pre(o.circuit.diagram)}
            <p class="caption">P(X) loads the lognormal price distribution into 5 qubits; F encodes the call payoff into the objective qubit (q_5) using ancilla qubits.</p></details>
          <details><summary>Circuit: tail probability</summary>${pre(v.diagram)}
            <p class="caption">P(r) loads the basket's return histogram; r&lt;t flips the objective qubit (q_5) when the return is below the threshold.</p></details>
          <details><summary>Circuit: QAOA layers</summary>${pre(a.diagram)}
            <p class="caption">Each cost layer applies the QUBO as phases; each mixer layer lets bits flip. A classical optimizer tunes the angles γ and β.</p></details>
        </div>
      </div>`;
  }
  SECTIONS.push({ id: "nightly", title: "The nightly simulator run", html: nightly });

  // --- 10. Why it's not ready yet --------------------------------------------------------------------------
  function reality() {
    const card = (title, body) => `<div class="card q-card"><h3>${title}</h3><p>${body}</p></div>`;
    return `<p class="soft">The simulations above run on a PC because the circuits are tiny and a simulator has no noise. Four things stand between them and a
        real advantage.</p>
      <div class="grid g4 q-cards">
        ${card("Noise and error correction", `Today's best qubits make roughly one error per thousand operations (approximate), hopeless for the circuits in section 9.
          Error correction spreads one reliable <b>logical qubit</b> over many physical ones; with surface codes, around a thousand or more physical qubits per
          logical qubit (approximate; Fowler et al.).`)}
        ${card("Limited gate sets", `Hardware offers a few native gates. Any other rotation has to be approximated by sequences of them (the Solovay-Kitaev
          theorem), and on error-corrected machines the T gate those sequences need is expensive, so algorithms are costed in T gates.`)}
        ${card("Scale", `Published estimates for pricing a useful derivative faster than a classical computer need thousands of logical qubits, and so millions
          of physical ones, running for a long time (approximate). That is far beyond any machine built so far.`)}
        ${card("Data loading", `The speedups assume the data is already in qubits. Loading N arbitrary numbers takes about N steps, or a quantum RAM that
          doesn't exist yet, which can cancel a quadratic speedup. Option pricing escapes this only because its model is a formula.`)}
      </div>
      <div class="q-callout"><b>As of 2026, there is no proven practical quantum advantage on a real finance problem.</b> The algorithms in sections 4 to 7 are
        promising on paper; the hardware to run them at a useful size doesn't exist yet.</div>`;
  }
  SECTIONS.push({ id: "reality", title: "Why it's not ready yet", html: reality });

  // --- 11. Security note for investors ---------------------------------------------------------------------
  function security() {
    const nist = (n, name) => `<a href="https://csrc.nist.gov/pubs/fips/${n}/final" target="_blank" rel="noopener">FIPS ${n}</a> (${name})`;
    return `<div class="card q-sec-card">
        <p>The one quantum algorithm with a clear, proven threat today is <b>Shor's</b>: a large error-corrected quantum computer could factor the numbers and
          solve the discrete logarithms that RSA and elliptic-curve cryptography rely on. That public-key encryption protects logins, transfers and data in
          transit at brokerages and banks.</p>
        <p>The risk starts before such a machine exists: an attacker can record encrypted traffic now and decrypt it later (<b>"harvest now, decrypt later"</b>),
          so data that must stay secret for years is already exposed.</p>
        <p>In August 2024 NIST published the first post-quantum cryptography standards: ${nist(203, "ML-KEM, key encapsulation")}, ${nist(204, "ML-DSA, digital signatures")}
          and ${nist(205, "SLH-DSA, hash-based signatures")}. See NIST's
          <a href="https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards" target="_blank" rel="noopener">announcement</a>.
          For investors, the practical step is to ask your broker and bank whether they have a plan to migrate to these standards.</p>
      </div>`;
  }
  SECTIONS.push({ id: "security", title: "Security note for investors", html: security });

  // --- 12. Learn more --------------------------------------------------------------------------------------
  const GLOSSARY = [
    ["Qubit", "The quantum version of a bit: two amplitudes, one for 0 and one for 1, instead of a single value."],
    ["Superposition", "A state with nonzero amplitude on more than one outcome at once, such as (|0⟩ + |1⟩)/√2."],
    ["Amplitude", "A number attached to each possible outcome; its square is that outcome's probability. It can be negative."],
    ["Measurement", "Reading qubits: it returns one outcome at random, by the squared amplitudes, and destroys the superposition."],
    ["Entanglement", "Qubits sharing one joint state, so their measurements are correlated in ways no separate states can produce."],
    ["Interference", "Amplitudes adding like waves: equal signs reinforce, opposite signs cancel. Algorithms use it to boost right answers."],
    ["Oracle", "A black box an algorithm queries, for example one that marks the item being searched for. Speedups count queries to it."],
    ["Gate", "One operation on one or a few qubits, such as H, X, Z or CNOT. The quantum version of a logic gate."],
    ["Circuit", "A sequence of gates applied to qubits, followed by measurements: a quantum program."],
    ["QAE", "Quantum amplitude estimation: estimates a probability or an average with error about 1/N in N queries, against 1/√N for Monte Carlo."],
    ["QAOA", "Quantum approximate optimization algorithm: alternating cost and mixer layers whose angles a classical optimizer tunes."],
    ["QUBO", "Quadratic unconstrained binary optimization: minimize x′Qx over 0/1 vectors x. Constraints become penalty terms."],
    ["HHL", "The Harrow-Hassidim-Lloyd algorithm for linear systems Ax = b; exponentially faster only under strict conditions."],
    ["Logical qubit", "A reliable qubit built from many noisy physical qubits by error correction."],
    ["VaR", "Value at risk: the loss a portfolio shouldn't exceed on, say, 95% of days."],
    ["CVaR", "Conditional VaR, or expected shortfall: the average loss on the days beyond VaR."],
  ];
  const PATH = [
    ["Weeks 1-2", "Foundations", "Qubits, gates, measurement and linear algebra (vectors and matrices). Install Qiskit (pip install qiskit) and rebuild the entangled pair from section 2."],
    ["Weeks 3-4", "Grover, phase estimation, Shor", "How interference finds a marked item, how phase estimation reads a hidden period, and why that breaks RSA."],
    ["Weeks 5-6", "Amplitude estimation and option pricing", "Monte Carlo vs QAE, then price a European call with Qiskit as in section 5."],
    ["Weeks 7-8", "Portfolio optimization and QAOA", "Markowitz, QUBOs, and a QAOA demo on a 4-6 stock basket; compare with brute force."],
    ["Week 9", "Error correction and readiness", "Surface codes, T-gate costs and resource estimates; apply the scorecard in section 8 to a problem of your own."],
  ];
  const REFS = [
    ["Andrew Childs", "Lecture Notes on Quantum Algorithms", "https://www.cs.umd.edu/~amchilds/qa/qa.pdf"],
    ["Muhammad Faryad", "Lecture Notes on Quantum Algorithms", "https://arxiv.org/abs/2507.11565"],
    ["Lov Grover", "A fast quantum mechanical algorithm for database search", "https://arxiv.org/abs/quant-ph/9605043"],
    ["Peter Shor", "Polynomial-time algorithms for prime factorization and discrete logarithms on a quantum computer", "https://arxiv.org/abs/quant-ph/9508027"],
    ["Harrow, Hassidim and Lloyd", "Quantum algorithm for solving linear systems of equations (HHL)", "https://arxiv.org/abs/0811.3171"],
    ["Grinko et al.", "Iterative quantum amplitude estimation", "https://arxiv.org/abs/1912.05559"],
    ["Stamatopoulos et al.", "Option pricing using quantum computers", "https://arxiv.org/abs/1905.02666"],
    ["Kerenidis, Prakash and Szilágyi", "Quantum algorithms for portfolio optimization", "https://arxiv.org/abs/1908.08040"],
    ["Woerner and Egger", "Quantum risk analysis", "https://arxiv.org/abs/1806.06893"],
    ["Egger et al.", "Credit risk analysis using quantum computers", "https://arxiv.org/abs/1907.03044"],
    ["Gilyén et al.", "Quantum singular value transformation and beyond", "https://arxiv.org/abs/1806.01838"],
    ["Fowler et al.", "Surface codes: towards practical large-scale quantum computation", "https://arxiv.org/abs/1208.0928"],
    ["Daniel Gottesman", "Stabilizer codes and quantum error correction", "https://arxiv.org/abs/quant-ph/9705052"],
    ["Dawson and Nielsen", "The Solovay-Kitaev algorithm", "https://arxiv.org/abs/quant-ph/0505030"],
    ["Alessandro Luongo", "Quantum algorithms for data analysis", "https://quantumalgorithms.org/quantumalgorithms.pdf"],
    ["McKinsey", "How quantum computing could change financial services", "https://www.mckinsey.com/~/media/mckinsey/industries/financial%20services/our%20insights/how%20quantum%20computing%20could%20change%20financial%20services/how-quantum-computing-could-change-financial-services.pdf"],
    ["NSW Chief Scientist & Engineer", "Quantum algorithms and applications study", "https://www.chiefscientist.nsw.gov.au/__data/assets/pdf_file/0017/1682/Quantum-Algorithms-and-Applications-Study-FINAL.pdf"],
  ];
  function learn() {
    return `<div class="q-two q-learn">
        <div><h3>Glossary</h3><dl class="q-gloss">${GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("")}</dl></div>
        <div><h3>A 9-week beginner path</h3><ol class="q-path">${PATH.map(([w, t, d]) => `<li><span class="badge info">${esc(w)}</span> <b>${esc(t)}.</b> ${esc(d)}</li>`).join("")}</ol>
          <h3>References</h3><ul class="q-refs">${REFS.map(([who, title, url]) => `<li>${esc(who)}, <a href="${esc(url)}" target="_blank" rel="noopener">${esc(title)}</a></li>`).join("")}</ul></div>
      </div>
      <p class="caption">${simTag()} applies to every quantum number on this page.</p>`;
  }
  SECTIONS.push({ id: "learn", title: "Learn more: glossary, path and references", html: learn });

  // Freshness badges per section: the nightly Qiskit run, prices loaded in the browser, or a simulation run here.
  // Sections of explanation only have no data, so no badge.
  const SIM_HERE = { provider: "Simulated in your browser", live: true };
  const PRICES_HERE = { provider: "CNBC / Binance", label: "Prices loaded in your browser", live: true };
  const SECTION_SOURCES = { lab: [SIM_HERE], converge: [SIM_HERE], options: ["quantum", PRICES_HERE], risk: ["quantum", PRICES_HERE],
    portfolio: ["quantum", PRICES_HERE], nightly: ["quantum"] };

  // --- lab state in the link: #/quantum/options?sym=AAPL&days=90, #/quantum/risk?syms=..., #/quantum/portfolio?syms=...
  let labsReady = false;  // the labs save their state while they first draw; only changes after that rewrite the link
  function shareLab(section, params) { if (labsReady) setPageParams("quantum", params, section); }
  /** A link's lab settings win over this browser's saved ones (each value checked before use). */
  function applyLabLink(section, p) {
    if (!Object.keys(p || {}).length) return;
    const tickers = (s) => Util.listParam(s).filter(Util.isTicker).slice(0, 15);
    if (section === "options") {
      store.set("q:opt", Object.assign(store.get("q:opt", {}), {
        sym: Util.isTicker(p.sym || "") ? p.sym : "AAPL", days: Util.oneOf(Number(p.days), [30, 90, 180], 90), kind: Util.oneOf(p.kind, ["call", "put"], "call"),
        win: Util.oneOf(Number(p.win), WINDOWS.map((w) => w[0]), 126), n: Util.numParam(p.n, 1e5, 1e3, 1e6) }));
    } else if (section === "risk") {
      const syms = tickers(p.syms), w = Util.listParam(p.w).map(Number);
      store.set("q:risk", { syms, w: w.length === syms.length && w.every((x) => x >= 0) ? w.map((x) => x / 100) : syms.map(() => 1 / syms.length),
        look: Util.oneOf(Number(p.look), [252, 500], 500), amt: Util.numParam(p.amt, 1e6, 1, 1e12) });
    } else if (section === "portfolio") {
      store.set("q:pf", { syms: tickers(p.syms), look: Util.oneOf(Number(p.look), [252, 500], 500), pick: Util.oneOf(p.pick, ["sharpe", "minvar", "lam"], "sharpe"),
        lam: Util.numParam(p.lam, 50, 0, 100), K: Util.numParam(p.K, 3, 1, 15) | 0, ql: Util.numParam(p.ql, 10, 0, 40) });
    }
  }

  function view(el, arg) {
    return render(el, arg);
  }

  async function render(el, arg) {
    labsReady = false;
    applyLabLink(arg, pageParams());
    const [doc, market] = await Promise.all([load("quantum.json").catch(() => null), load("market.json").catch(() => null)]);
    const ctx = { q: doc && doc.options && Array.isArray(doc.options.items) ? doc : null, market };
    SECTIONS.forEach((s, i) => { s.n = i + 1; });
    el.innerHTML = `
      <h1>Quantum computing for investors</h1>
      <p class="soft q-lede">How quantum algorithms work, explained from zero, and where they might one day help with stocks: pricing options,
        measuring risk and choosing portfolios. Every quantum result sits next to the classical method it would have to beat.</p>
      <div class="q-banner">⚛ Every quantum number on this page comes from a simulator: Qiskit, run nightly on an ordinary PC, or a small simulator
        in your browser. No quantum hardware is used. <b>${SIM}.</b></div>
      <nav class="q-toc" aria-label="Sections">${SECTIONS.map((s) => `<button type="button" class="chip" data-go="${s.id}">${s.n} · ${esc(s.title)}</button>`).join("")}</nav>
      ${SECTIONS.map((s) => { const src = SECTION_SOURCES[s.id];
        return `<section class="q-sec" id="q-${s.id}"${src ? "" : " data-nofresh"}><h2><span class="q-n">${s.n}</span>${esc(s.title)}${src ? fresh(src) : ""}</h2>${s.html(ctx)}</section>`; }).join("")}`;
    timers.splice(0).forEach((stop) => stop());
    window.onRouteCleanup(() => timers.splice(0).forEach((stop) => stop()));
    el.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go, true)));
    for (const s of SECTIONS) {
      if (!s.init) continue;
      try { await s.init($(`#q-${s.id}`, el), ctx); } catch (e) {
        console.error(e);
        $(`#q-${s.id}`, el).insertAdjacentHTML("beforeend", `<div class="empty">This section couldn't load (${esc(e.message)}).</div>`);
      }
    }
    labsReady = true;
    if (arg) go(arg, false);
  }

  function go(id, remember) {
    const target = document.getElementById(`q-${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: remember ? "smooth" : "auto", block: "start" });
    if (remember) setPageParams("quantum", {}, id);  // a deep link that doesn't re-render
  }

  root.QUANTUM = { view };
})(typeof window !== "undefined" ? window : globalThis);
