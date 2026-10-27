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
  const QX = { TD, mean, std };

  if (typeof module !== "undefined" && module.exports) { module.exports = QX; return; }
  root.QX = QX;

  // ==============================================================================================
  // Page. Uses app.js's shared helpers (load, esc, kpi, table, plot, layout, pal, ...).
  // ==============================================================================================
  const SIM = "Simulated on a classical computer — educational, not a trading signal";
  const simTag = () => `<span class="q-sim" title="No quantum hardware was used">⚛ ${SIM}</span>`;
  const SECTIONS = [];  // {id, n, title, html(ctx), init(root, ctx)} in page order

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
