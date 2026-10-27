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

  const QX = { TD, mean, std, rng, gaussian, applyGate, simulate, probabilities, sampleCounts, groverSteps, groverProbability, groverOptimal, mcErrorCurve };

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
