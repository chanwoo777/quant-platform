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

  const QX = { TD, mean, std, rng, gaussian, applyGate, simulate, probabilities, sampleCounts, groverSteps, groverProbability, groverOptimal, mcErrorCurve,
    erfc, normCdf, blackScholes, mcOption, annualVol, lognormalBounds, riskFree,
    quantile, varCvar, returnRows, portfolio, horizon, meanCov, cholesky, mcPortfolio };

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
        amplitude estimation from the nightly simulator. Spot and volatility come from the site's daily prices; the volatility is annualised from daily
        log returns. Dividends are ignored.</p>
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
      const sd = await symbolData(sym);
      if (!sd || !sd.px || sd.px.values.length < 70) { $("#op-msg", sec).textContent = `${sym}: not enough price history on this site.`; return false; }
      const row = await rowFor(sym);
      O.sym = sym; data = sd.px; name = (row && row.n) || ""; $("#op-msg", sec).textContent = "";
      return true;
    };
    if (!(await loadSym(O.sym)) && !(await loadSym("AAPL"))) throw new Error("no price data");
    const chipsOn = (id, v) => sec.querySelectorAll(`#${id} .chip`).forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));

    const draw = () => {
      store.set("q:opt", { sym: O.sym, win: O.win, days: O.days, kind: O.kind, n: O.n });
      chipsOn("op-win", O.win); chipsOn("op-days", O.days); chipsOn("op-kind", O.kind);
      $("#op-n", sec).value = String(O.n);
      $("#op-sym", sec).innerHTML = `${esc(O.sym)}${name ? ` <span class="soft">${esc(name)}</span>` : ""}`;
      const S = data.values[data.values.length - 1], vol = annualVol(data.values, O.win), T = O.days / 365, r = rf.r;
      if (!isNum(O.strike) || O.strike <= 0) O.strike = Math.round(S * 100) / 100;
      $("#op-k", sec).value = O.strike.toFixed(2);
      const K = O.strike;
      $("#op-inputs", sec).innerHTML = kpi("Spot price", money2(S), `last close, ${esc(data.dates[data.dates.length - 1])}`)
        + kpi("Volatility", pct(vol, 1, false), `annualised, last ${WINDOWS.find((w) => w[0] === O.win)[1]} of daily log returns`)
        + kpi("Risk-free rate", pct(rf.pct / 100, 2, false), `${esc(rf.label)}${rf.series ? ` (FRED ${esc(rf.series)})` : ""}${rf.date ? `, ${esc(rf.date)}` : ""}; continuous ${pct(r, 2, false)}`)
        + kpi("Time to expiry", `${O.days} days`, `T = ${O.days}/365 = ${T.toFixed(3)} years`);
      const bs = blackScholes(S, K, T, r, vol, O.kind);
      const mc = mcOption({ S, K, T, r, vol, kind: O.kind, n: O.n, seed: O.seed, checkpoints: [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6] });
      const item = items.find((it) => it.ticker === O.sym && it.maturity_days === O.days);
      $("#op-out", sec).innerHTML = `
        <div class="card q-res"><div class="q-res-h">Black-Scholes <span class="badge">formula</span></div>
          <div class="q-big">${money2(bs.price)}</div>
          <div class="sub">d₁ ${num(bs.d1, 3)} · d₂ ${num(bs.d2, 3)} · delta ${num(bs.delta, 3)}</div>
          <p class="caption">Exact if prices are lognormal with constant volatility. The reference for the other two.</p></div>
        <div class="card q-res"><div class="q-res-h">Monte Carlo <span class="badge">classical</span></div>
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
      const head = `<div class="q-res-h">Amplitude estimation <span class="badge warn">quantum, simulated</span></div>`;
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
      const same = Math.abs(cur.K - item.strike) < 0.005 && Math.abs(cur.vol - item.vol) < 5e-4 && Math.abs(cur.S - item.spot) < 0.005
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

  // --- shared: a basket of stocks picked from the universe ---------------------------------------------
  const basketHtml = (p) => `<div class="q-basket"><div class="q-chips" id="${p}-chips"></div><div class="q-add" id="${p}-add">${searchBox("Add a stock")}</div></div>
    <p class="caption" id="${p}-msg"></p>`;
  /** Wire a basket editor. B = {syms, w?}; onChange() runs after every edit. */
  function bindBasket(sec, p, B, { min, max, weights = false, onChange }) {
    const msg = (t) => { $(`#${p}-msg`, sec).textContent = t; };
    const draw = () => {
      $(`#${p}-chips`, sec).innerHTML = B.syms.map((s, i) => `<span class="chip q-chip"><b>${esc(s)}</b>${weights
        ? `<input type="number" class="q-w" data-i="${i}" value="${+(100 * B.w[i]).toFixed(1)}" min="0" max="100" step="1" aria-label="Weight of ${esc(s)}, percent">%` : ""}
        <button type="button" data-rm="${i}" aria-label="Remove ${esc(s)}"${B.syms.length <= min ? " disabled" : ""}>✕</button></span>`).join("")
        + (weights ? `<button type="button" class="btn q-small" id="${p}-eq">Equal weights</button>` : "");
      sec.querySelectorAll(`#${p}-chips [data-rm]`).forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.rm);
        B.syms.splice(i, 1); if (B.w) B.w.splice(i, 1);
        if (weights) B.w = B.w.map(() => 1 / B.syms.length);
        msg(""); draw(); onChange();
      }));
      sec.querySelectorAll(`#${p}-chips .q-w`).forEach((inp) => inp.addEventListener("change", () => {
        B.w[Number(inp.dataset.i)] = Math.max(0, Number(inp.value) || 0) / 100;
        msg(Math.abs(sum(B.w) - 1) > 1e-6 ? "Weights are scaled to add up to 100%." : ""); onChange();
      }));
      const eq = $(`#${p}-eq`, sec);
      if (eq) eq.addEventListener("click", () => { B.w = B.syms.map(() => 1 / B.syms.length); msg(""); draw(); onChange(); });
    };
    bindSearch($(`#${p}-add`, sec), async (sym) => {
      if (B.syms.includes(sym)) { msg(`${sym} is already in the basket.`); return; }
      if (B.syms.length >= max) { msg(`At most ${max} stocks.`); return; }
      const sd = await symbolData(sym);
      if (!sd || !sd.px || sd.px.values.length < 130) { msg(`${sym}: not enough price history on this site.`); return; }
      B.syms.push(sym);
      if (weights) B.w = B.syms.map(() => 1 / B.syms.length);
      msg(""); draw(); onChange();
    });
    draw();
    return draw;
  }
  /** Aligned closes of a basket over the last `sessions` returns. */
  async function basketPrices(syms, sessions) {
    const hist = await Promise.all(syms.map(async (s) => [s, await symbolData(s)]));
    const missing = hist.filter(([, h]) => !h || !h.px).map(([s]) => s);
    if (missing.length) throw new Error(`no price history for ${missing.join(", ")}`);
    const al = Q.align(hist.map(([, h]) => h.px));
    const start = Math.max(0, al.dates.length - sessions - 1);
    return { dates: al.dates.slice(start), values: al.values.map((v) => v.slice(start)) };
  }
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

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
      <div id="rk-out"></div>
      <div class="chart-title">Daily returns of this basket, with the historical VaR lines</div><div class="chart" id="rk-hist"></div>
      <h3 class="q-h3">The quantum angle</h3>
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

  function view(el, arg) {
    return render(el, arg);
  }

  async function render(el, arg) {
    const [doc, market] = await Promise.all([load("quantum.json").catch(() => null), load("market.json").catch(() => null)]);
    const ctx = { q: doc && doc.options && Array.isArray(doc.options.items) ? doc : null, market };
    SECTIONS.forEach((s, i) => { s.n = i + 1; });
    el.innerHTML = `
      <h1>Quantum computing for investors</h1>
      <p class="soft q-lede">How quantum algorithms work, explained from zero, and where they might one day help with stocks: pricing options,
        measuring risk and choosing portfolios. Every quantum result sits next to the classical method it would have to beat.</p>
      <div class="q-banner">⚛ Every quantum number on this page comes from a simulator: Qiskit, run nightly on an ordinary PC, or a small simulator
        in your browser. No quantum hardware is used. <b>${SIM}.</b> Not investment advice.</div>
      <nav class="q-toc" aria-label="Sections">${SECTIONS.map((s) => `<button type="button" class="chip" data-go="${s.id}">${s.n} · ${esc(s.title)}</button>`).join("")}</nav>
      ${SECTIONS.map((s) => `<section class="q-sec" id="q-${s.id}"><h2><span class="q-n">${s.n}</span>${esc(s.title)}</h2>${s.html(ctx)}</section>`).join("")}`;
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
    if (arg) go(arg, false);
  }

  function go(id, remember) {
    const target = document.getElementById(`q-${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: remember ? "smooth" : "auto", block: "start" });
    if (remember) history.replaceState(null, "", `#/quantum/${id}`);  // a deep link that doesn't re-render
  }

  root.QUANTUM = { view };
})(typeof window !== "undefined" ? window : globalThis);
