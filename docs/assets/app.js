/* Free Quant Platform: static web dashboard.
 * Reads the JSON written by `python -m quant.web.export` (data/) and renders the five
 * pages of the Streamlit dashboard with Plotly. Hash routes: #/global, #/markets,
 * #/stock/AAPL, #/financials/AAPL, #/bot/paper.
 */
"use strict";

// --- data -----------------------------------------------------------------------------------------
const cache = new Map();
function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch("data/" + path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

// --- formatting -----------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);
const minus = (s) => s.replace(/^-/, "−");
function pct(x, d = 1, sign = true) {
  if (!ok(x)) return "–";
  return minus((sign && x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
}
function num(x, d = 2, sign = false) {
  if (!ok(x)) return "–";
  return minus((sign && x > 0 ? "+" : "") + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
}
function money(x, d = 0) {
  if (!ok(x)) return "–";
  for (const [u, v] of [["T", 1e12], ["B", 1e9], ["M", 1e6]]) {
    if (Math.abs(x) >= v) return minus("$" + (x / v).toFixed(Math.max(d, 1)) + u);
  }
  return minus("$" + x.toLocaleString("en-US", { maximumFractionDigits: d }));
}
const tone = (x) => (!ok(x) ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "");
const toneMark = { bullish: "▲ bullish", bearish: "▼ bearish", neutral: "● neutral" };
const SIGNAL = { BUY: "▲ BUY", HOLD: "● HOLD", AVOID: "▼ AVOID", "N/A": "–" };

function kpi(label, value, sub = "", help = "") {
  return `<div class="card kpi"><div class="label"${help ? ` title="${esc(help)}"` : ""}>${esc(label)}${help ? " ⓘ" : ""}</div>
    <div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}
function bar(v, max = 100) {
  if (!ok(v)) return "–";
  const w = Math.max(0, Math.min(100, (100 * v) / max));
  return `<div class="bar-cell"><div class="track"><div class="fill" style="width:${w}%"></div></div><span class="num">${v.toFixed(0)}</span></div>`;
}
function spark(points, w = 90, h = 24, color) {
  if (!points || points.length < 2) return "";
  const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
  const xy = points.map((p, i) => `${((i / (points.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - ((p - lo) / span) * (h - 2)).toFixed(1)}`);
  const up = points[points.length - 1] >= points[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${color || (up ? pal().up : pal().down)}" stroke-width="1.5" points="${xy.join(" ")}"/></svg>`;
}
function chips(name, options, selected, multi = true) {
  return `<div class="chips" data-chips="${name}" data-multi="${multi}">${options.map(([v, label]) =>
    `<button type="button" class="chip${selected.has(v) ? " on" : ""}" data-v="${esc(v)}">${esc(label)}</button>`).join("")}</div>`;
}
function bindChips(root, name, selected, multi, onChange) {
  root.querySelectorAll(`[data-chips="${name}"] .chip`).forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.v;
    if (multi) { selected.has(v) ? selected.delete(v) : selected.add(v); } else { selected.clear(); selected.add(v); }
    root.querySelectorAll(`[data-chips="${name}"] .chip`).forEach((x) => x.classList.toggle("on", selected.has(x.dataset.v)));
    onChange();
  }));
}
function table(cols, rows, opts = {}) {
  if (!rows.length) return `<div class="empty">${esc(opts.empty || "Nothing to show.")}</div>`;
  const head = cols.map((c) => `<th class="${c.r ? "r" : ""}${c.sort ? " sortable" : ""}" ${c.sort ? `data-sort="${c.sort}"` : ""}>${esc(c.h)}${c.mark || ""}</th>`).join("");
  const body = rows.map((r, i) => `<tr${opts.click ? ` class="clickable" data-i="${i}"` : ""}>${cols.map((c) =>
    `<td class="${c.r ? "r" : ""}${c.cls ? " " + c.cls : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap${opts.tall ? " tall" : ""}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const link = (url, text = "Open") => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : "–");

// --- theme and charts -----------------------------------------------------------------------------
const PAL = {
  light: { ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", surface: "#fcfcfb",
    up: "#2a78d6", down: "#e34948", ma50: "#6250d6", ma200: "#1baf7a",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] },
  dark: { ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", surface: "#1a1a19",
    up: "#3987e5", down: "#e66767", ma50: "#9085e9", ma200: "#199e70",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] },
};
const STANCE = { "Risk-On": "#0ca30c", Neutral: "#fab219", "Risk-Off": "#d03b3b" };
function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}
const pal = () => (isDark() ? PAL.dark : PAL.light);
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function layout(height, extra = {}) {
  const c = pal();
  const axis = { showgrid: false, linecolor: c.axis, tickfont: { color: c.muted }, zeroline: false, automargin: true };
  return Object.assign({
    height, margin: { l: 8, r: 52, t: 36, b: 28 }, hovermode: "x unified", paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)", font: { family: FONT, color: c.ink2, size: 12 },
    hoverlabel: { font: { family: FONT } }, showlegend: true,
    legend: { orientation: "h", yanchor: "bottom", y: 1.01, xanchor: "left", x: 0, font: { color: c.ink2 } },
    xaxis: Object.assign({}, axis), yaxis: Object.assign({}, axis, { showgrid: true, gridcolor: c.grid }),
  }, extra);
}
function yaxis(extra = {}) {
  const c = pal();
  return Object.assign({ showgrid: true, gridcolor: c.grid, linecolor: c.axis, tickfont: { color: c.muted }, zeroline: false, automargin: true }, extra);
}
function plot(el, traces, lay) {
  if (!el) return;
  if (!window.Plotly) { el.innerHTML = '<div class="empty">Charts are loading… (needs cdn.jsdelivr.net)</div>'; return; }
  if (!el.classList.contains("js-plotly-plot")) el.innerHTML = "";  // drop any "Loading…" placeholder
  Plotly.react(el, traces, lay, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}
function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v ?? 0; count += v == null ? 0 : 1;
    if (i >= n) { const old = values[i - n]; sum -= old ?? 0; count -= old == null ? 0 : 1; }
    if (i >= n - 1 && count === n) out[i] = sum / n;
  }
  return out;
}
function missingWeekdays(dates) {
  // Plotly rangebreaks for holidays: weekdays between the first and last bar with no bar.
  if (!dates.length) return [];
  const have = new Set(dates), out = [];
  const d = new Date(dates[0] + "T00:00:00Z"), end = new Date(dates[dates.length - 1] + "T00:00:00Z");
  while (d <= end) {
    const day = d.getUTCDay(), iso = d.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !have.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function startFor(lastIso, span) {
  const months = { "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120 }[span];
  if (!months) return null;
  const d = new Date(lastIso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// --- saved names (per visitor, in this browser) -----------------------------------------------------
const saved = new Set((() => { try { return JSON.parse(localStorage.getItem("saved") || "[]"); } catch (e) { return []; } })());
function toggleSaved(sym) {
  saved.has(sym) ? saved.delete(sym) : saved.add(sym);
  try { localStorage.setItem("saved", JSON.stringify([...saved])); } catch (e) { /* private mode */ }
}

// ====================================================================================================
// Global Overview
// ====================================================================================================
const G = { classes: new Set(["s", "e", "c"]), signals: new Set(), market: "", sector: "", q: "", min: 0, cap: "",
  unusual: false, sort: "sc", dir: -1, page: 0, tab: "screener" };
const PAGE = 50;
let screener = null;

async function viewGlobal(view) {
  const g = await load("global.json");
  if (!screener) {
    const idx = Object.fromEntries(g.cols.map((c, i) => [c, i]));
    screener = g.rows.map((r) => { const o = {}; for (const c in idx) o[c] = r[idx[c]]; return o; });
  }
  const markets = [...new Set(screener.map((r) => r.m))].sort();
  const sectors = [...new Set(screener.filter((r) => r.sec).map((r) => r.sec))].sort();
  const regimes = g.regimes.map((r) => {
    const color = { Bull: "good", Bear: "bad", Sideways: "warn" }[r.trend] || "";
    return `<div class="card regime" title="${esc(`${r.regime} · ${r.index} ${num(r.level, 0)} · ${pct(r.drawdown_52w, 0)} from its 52-week high · as of ${r.as_of}`)}">
      <div class="name">${esc(r.market)}</div>
      <div class="line"><span class="badge ${color}">${esc(r.trend)}</span><span class="badge">${esc(r.volatility)}</span></div>
      <div class="line"><span class="${tone(r.ret_1m)}">${pct(r.ret_1m)}</span> 1M · ${esc(r.stance)}</div></div>`;
  }).join("");
  const counts = { s: 0, e: 0, c: 0 };
  screener.forEach((r) => counts[r.a]++);

  view.innerHTML = `
    <h1>Global Overview</h1>
    <p class="caption">${counts.s.toLocaleString()} stocks ≥ $1B in 21 markets · ${counts.e.toLocaleString()} liquid US-listed ETFs ·
      ${counts.c.toLocaleString()} coins · scored ${esc(g.scored_at.slice(0, 16).replace("T", " "))} UTC. Click a row for its chart and the reasons behind its signal.</p>
    <h2>Market regimes</h2>
    <div class="grid g6">${regimes}</div>
    <div class="controls">
      <div class="control"><span class="label">Asset class</span>${chips("cls", [["s", "Stocks"], ["e", "ETFs"], ["c", "Crypto"]], G.classes)}</div>
      <div class="control"><span class="label">Signal</span>${chips("sig", [["BUY", "BUY"], ["HOLD", "HOLD"], ["AVOID", "AVOID"]], G.signals)}</div>
      <div class="control"><label for="g-market">Market</label><select id="g-market"><option value="">All markets</option>${markets.map((m) => `<option${m === G.market ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
      <div class="control"><label for="g-sector">Sector</label><select id="g-sector"><option value="">All sectors</option>${sectors.map((s) => `<option${s === G.sector ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
      <div class="control"><label for="g-q">Search</label><input id="g-q" type="search" placeholder="Name or symbol" value="${esc(G.q)}"></div>
      <div class="control"><label for="g-min">Min score</label><input id="g-min" type="number" min="0" max="100" step="5" value="${G.min}"></div>
      <div class="control"><label for="g-cap">Size</label><select id="g-cap"><option value="">Any</option><option value="10"${G.cap === "10" ? " selected" : ""}>≥ $10B</option><option value="100"${G.cap === "100" ? " selected" : ""}>≥ $100B</option></select></div>
      <label class="toggle"><input id="g-unusual" type="checkbox"${G.unusual ? " checked" : ""}> Unusual moves only</label>
    </div>
    <div class="grid g4" id="g-kpis"></div>
    <div class="subtabs" id="g-tabs">
      <button type="button" data-tab="screener">Screener</button><button type="button" data-tab="movers">Unusual movers today</button><button type="button" data-tab="saved">Saved ★</button>
    </div>
    <div id="g-body"></div>`;

  const refresh = () => { G.page = 0; drawGlobal(); };
  bindChips(view, "cls", G.classes, true, refresh);
  bindChips(view, "sig", G.signals, true, refresh);
  $("#g-market", view).addEventListener("change", (e) => { G.market = e.target.value; refresh(); });
  $("#g-sector", view).addEventListener("change", (e) => { G.sector = e.target.value; refresh(); });
  $("#g-q", view).addEventListener("input", (e) => { G.q = e.target.value; refresh(); });
  $("#g-min", view).addEventListener("input", (e) => { G.min = Number(e.target.value) || 0; refresh(); });
  $("#g-cap", view).addEventListener("change", (e) => { G.cap = e.target.value; refresh(); });
  $("#g-unusual", view).addEventListener("change", (e) => { G.unusual = e.target.checked; refresh(); });
  view.querySelectorAll("#g-tabs button").forEach((b) => b.addEventListener("click", () => { G.tab = b.dataset.tab; refresh(); }));
  drawGlobal();
}

function filtered() {
  const q = G.q.trim().toLowerCase();
  const cap = G.cap ? Number(G.cap) : 0;
  return screener.filter((r) => G.classes.has(r.a)
    && (!G.signals.size || G.signals.has(r.sig))
    && (!G.market || r.m === G.market)
    && (!G.sector || r.sec === G.sector)
    && (!G.min || (ok(r.sc) && r.sc >= G.min))
    && (!cap || (ok(r.cap) && r.cap >= cap))
    && (!G.unusual || r.u)
    && (!q || r.s.toLowerCase().includes(q) || (r.n || "").toLowerCase().includes(q)));
}

const SCREEN_COLS = [
  { h: "★", f: (r) => `<button class="star${saved.has(r.s) ? " on" : ""}" data-star="${esc(r.s)}" title="Save in this browser">${saved.has(r.s) ? "★" : "☆"}</button>` },
  { h: "Symbol", sort: "s", f: (r) => `<b>${esc(r.s)}</b>` },
  { h: "Name", cls: "clip", f: (r) => esc(r.n) },
  { h: "Market", f: (r) => esc(r.m) },
  { h: "Sector", cls: "clip", f: (r) => esc(r.sec || { e: "ETF", c: "Crypto" }[r.a] || "–") },
  { h: "Signal", f: (r) => `<span class="sig-${esc(r.sig)}">${SIGNAL[r.sig] || "–"}</span>` },
  { h: "Score", sort: "sc", f: (r) => bar(r.sc) },
  { h: "Trend", sort: "t", r: 1, f: (r) => num(r.t, 0) },
  { h: "Mom.", sort: "mo", r: 1, f: (r) => num(r.mo, 0) },
  { h: "Value", sort: "v", r: 1, f: (r) => num(r.v, 0) },
  { h: "Quality", sort: "q", r: 1, f: (r) => num(r.q, 0) },
  { h: "Risk", sort: "r", r: 1, f: (r) => num(r.r, 0) },
  { h: "1D", sort: "r1d", r: 1, f: (r) => `<span class="${tone(r.r1d)}">${pct(r.r1d)}</span>` },
  { h: "1M", sort: "r1m", r: 1, f: (r) => `<span class="${tone(r.r1m)}">${pct(r.r1m)}</span>` },
  { h: "YTD", sort: "ytd", r: 1, f: (r) => `<span class="${tone(r.ytd)}">${pct(r.ytd)}</span>` },
  { h: "12-1", sort: "m121", r: 1, f: (r) => pct(r.m121, 0) },
  { h: "Fwd P/E", sort: "fpe", r: 1, f: (r) => num(r.fpe, 1) },
  { h: "Mkt cap $B", sort: "cap", r: 1, f: (r) => num(r.cap, r.cap >= 100 ? 0 : 1) },
  { h: "6M", cls: "spark-cell", f: (r) => spark(r.sp) },
  { h: "Why", cls: "wrap-text", f: (r) => `<div class="clamp" title="${esc(r.why)}">${esc(r.why)}</div>` },
];

function drawGlobal() {
  const view = $("#view");
  const rows = filtered();
  const buy = rows.filter((r) => r.sig === "BUY").length, avoid = rows.filter((r) => r.sig === "AVOID").length;
  $("#g-kpis", view).innerHTML = kpi("Matching", rows.length.toLocaleString()) +
    kpi("Buy candidates", buy.toLocaleString(), "", "Up-trend + composite ≥ 60 + market not in a Bear regime") +
    kpi("Avoid", avoid.toLocaleString(), "", "Down-trend + composite ≤ 40") +
    kpi("Unusual move today", rows.filter((r) => r.u).length.toLocaleString(), "", "≥ 8% (crypto 20%), or ≥ 3 robust σ and ≥ 2% (crypto 5%)");
  view.querySelectorAll("#g-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === G.tab));

  let list = rows, cols = SCREEN_COLS;
  if (G.tab === "movers") {
    list = rows.filter((r) => r.u).sort((a, b) => Math.abs(b.r1d || 0) - Math.abs(a.r1d || 0));
    cols = [SCREEN_COLS[0], SCREEN_COLS[1], SCREEN_COLS[2], SCREEN_COLS[3],
      { h: "1D", r: 1, f: (r) => `<span class="${tone(r.r1d)}">${pct(r.r1d)}</span>` },
      { h: "z", r: 1, f: (r) => num(r.z, 1) }, SCREEN_COLS[5], SCREEN_COLS[6], SCREEN_COLS[19]];
  } else {
    if (G.tab === "saved") list = rows.filter((r) => saved.has(r.s));
    const k = G.sort, dir = G.dir;
    list = [...list].sort((a, b) => {
      const x = a[k], y = b[k];
      if (typeof x === "string" || typeof y === "string") return dir * String(x ?? "").localeCompare(String(y ?? ""));
      if (!ok(x)) return 1;
      if (!ok(y)) return -1;
      return dir * (x - y);
    });
  }
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  G.page = Math.min(G.page, pages - 1);
  const pageRows = list.slice(G.page * PAGE, (G.page + 1) * PAGE);
  const marked = cols.map((c) => Object.assign({}, c, { mark: c.sort && c.sort === G.sort && G.tab !== "movers" ? (G.dir < 0 ? " ↓" : " ↑") : "" }));
  const empty = G.tab === "saved" ? "No saved names yet: click ☆ on any row to keep it here (stored in this browser only)." : "No matches. Try loosening the filters.";
  $("#g-body", view).innerHTML = table(marked, pageRows, { click: true, empty }) + (list.length > PAGE ? `
    <div class="pager"><span>${(G.page * PAGE + 1).toLocaleString()}–${Math.min(list.length, (G.page + 1) * PAGE).toLocaleString()} of ${list.length.toLocaleString()}</span>
      <button class="btn" id="g-prev"${G.page ? "" : " disabled"}>← Previous</button><button class="btn" id="g-next"${G.page < pages - 1 ? "" : " disabled"}>Next →</button></div>` : "");
  const body = $("#g-body", view);
  body.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    G.dir = G.sort === k ? -G.dir : (k === "s" ? 1 : -1);
    G.sort = k; G.page = 0; drawGlobal();
  }));
  body.querySelectorAll("[data-star]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); toggleSaved(b.dataset.star);
    b.classList.toggle("on", saved.has(b.dataset.star)); b.textContent = saved.has(b.dataset.star) ? "★" : "☆";
  }));
  body.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openDetail(pageRows[Number(tr.dataset.i)])));
  const prev = $("#g-prev", body), next = $("#g-next", body);
  if (prev) prev.addEventListener("click", () => { G.page--; drawGlobal(); body.scrollIntoView({ block: "start" }); });
  if (next) next.addEventListener("click", () => { G.page++; drawGlobal(); body.scrollIntoView({ block: "start" }); });
}

// FNV-1a over UTF-8, identical to quant/web/export.py, picks the price bucket.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
async function closes(sym) {
  const b = (fnv1a(sym) % 256).toString(16).padStart(2, "0");
  const bucketData = await load(`px/${b}.json`).catch(() => ({}));
  const rec = bucketData[sym];
  if (!rec) return null;
  const [start, gaps, values] = rec;
  const d = new Date(start + "T00:00:00Z"), dates = [d.toISOString().slice(0, 10)];
  for (const g of gaps) { d.setUTCDate(d.getUTCDate() + g); dates.push(d.toISOString().slice(0, 10)); }
  return { dates, values };
}

async function openDetail(r, span = "1Y") {
  const drawer = $("#drawer"), back = $("#drawer-back");
  const meta = await load("meta.json");
  const deep = meta.deep.some((x) => x.ticker === r.s);
  const yahoo = `https://finance.yahoo.com/quote/${encodeURIComponent(r.s)}`;
  const pill = (label, v) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${ok(v) ? v.toFixed(0) : "–"}</div></div>`;
  drawer.innerHTML = `
    <div class="head"><div><h2>${esc(r.s)} · ${esc(r.n || "")}</h2>
      <div class="caption">${esc(r.m)} · ${esc(r.sec || { e: "ETF", c: "Crypto" }[r.a] || "")}${r.also ? ` · also listed: ${esc(r.also)}` : ""} · last ${num(r.px, 2)} ${esc(r.cur || "")}</div></div>
      <button class="btn close" id="d-close">Close ✕</button></div>
    <p><span class="badge ${r.sig === "BUY" ? "good" : r.sig === "AVOID" ? "bad" : ""}">${SIGNAL[r.sig] || "–"}</span>
      <span class="soft">${esc(r.why || "")}</span></p>
    <div class="chips" id="d-span">${["6M", "1Y", "All"].map((s) => `<button class="chip${s === span ? " on" : ""}" data-v="${s}">${s}</button>`).join("")}</div>
    <div class="chart" id="d-chart" style="min-height:320px"><div class="loading">Loading prices…</div></div>
    <div class="pillars">${pill("Score", r.sc)}${pill("Trend", r.t)}${pill("Momentum", r.mo)}${pill("Risk", r.r)}${pill("Value", r.v)}${pill("Quality", r.q)}${pill("Analysts", r.an)}${pill(r.a === "e" ? "Cost" : "RSI (14)", r.a === "e" ? r.co : r.rsi)}</div>
    <div class="grid g4" style="margin-top:12px">
      ${kpi("1 month", `<span class="${tone(r.r1m)}">${pct(r.r1m)}</span>`)}${kpi("Year to date", `<span class="${tone(r.ytd)}">${pct(r.ytd)}</span>`)}
      ${kpi("Momentum 12-1", pct(r.m121, 0))}${kpi("vs 200-day MA", pct(r.d200))}
      ${kpi("Fwd P/E", num(r.fpe, 1))}${kpi("ROE", pct(r.roe, 0, false))}${kpi("Dividend yield", ok(r.dy) ? num(r.dy, 2) + "%" : "–")}${kpi("Mkt cap", ok(r.cap) ? money(r.cap * 1e9) : "–")}
    </div>
    <p class="caption">Pillars are percentiles among peers (stocks: same market, and same sector for value and quality; ETFs and coins within their class). ${r.lab ? `Analyst consensus: ${esc(r.lab)}.` : ""}</p>
    <p>${link(yahoo, "Yahoo Finance page ↗")}${deep ? ` · <a href="#/stock/${encodeURIComponent(r.s)}" id="d-deep">Full deep dive →</a>` : ""}</p>`;
  drawer.classList.add("open"); back.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  const close = () => { drawer.classList.remove("open"); back.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); };
  $("#d-close").onclick = close; back.onclick = close;
  const deepLink = $("#d-deep"); if (deepLink) deepLink.onclick = close;
  document.onkeydown = (e) => { if (e.key === "Escape") close(); };
  drawer.querySelectorAll("#d-span .chip").forEach((b) => b.addEventListener("click", () => openDetail(r, b.dataset.v)));

  const px = await closes(r.s);
  const el = $("#d-chart");
  if (!px) { el.innerHTML = '<div class="empty">No price history for this symbol.</div>'; return; }
  const ma50 = sma(px.values, 50), ma200 = sma(px.values, 200);
  const start = span === "All" ? px.dates[0] : startFor(px.dates[px.dates.length - 1], span);
  const i0 = Math.max(0, px.dates.findIndex((d) => d >= start));
  const c = pal(), x = px.dates.slice(i0);
  plot(el, [
    { x, y: px.values.slice(i0), name: "Close", line: { color: c.ink, width: 1.5 }, hovertemplate: "%{y:,.4~f}" },
    { x, y: ma50.slice(i0), name: "50-day MA", line: { color: c.ma50, width: 2 }, hovertemplate: "%{y:,.4~f}" },
    { x, y: ma200.slice(i0), name: "200-day MA", line: { color: c.ma200, width: 2 }, hovertemplate: "%{y:,.4~f}" },
  ], layout(340, { xaxis: { type: "date", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } } }));
}

// ====================================================================================================
// Markets
// ====================================================================================================
const M = { span: new Set(["3Y"]), scope: new Set(["All"]) };

async function viewMarkets(view) {
  const m = await load("market.json");
  const reg = m.regime;
  const stanceClass = { "Risk-On": "good", Neutral: "warn", "Risk-Off": "bad" }[reg.stance] || "";
  const tiles = m.fred.map((t) => {
    if (!ok(t.value)) return kpi(t.label, "–");
    const unit = t.unit === "%" ? "%" : t.unit === "pp" ? "pp" : t.unit;
    const deltaUnit = t.unit === "%" ? "pp" : t.unit;
    const dcls = !ok(t.delta) || !t.inverse ? "muted" : t.delta > 0 ? "neg" : t.delta < 0 ? "pos" : "muted";
    return `<div class="card kpi tile" title="${esc(t.help)} · latest ${esc(t.date)}"><div class="label">${esc(t.label)}</div>
      <div class="value">${num(t.value, t.digits)}${esc(unit)}</div>
      <div class="sub ${dcls}">${ok(t.delta) ? `${num(t.delta, t.digits, true)}${esc(deltaUnit)} vs 1M ago` : ""}</div>
      <div class="spark">${spark(t.spark, 200, 34, pal().series[0])}</div></div>`;
  }).join("");
  view.innerHTML = `
    <h1>Market Overview</h1>
    <div class="grid g2">
      <div><div class="grid g3">
        ${kpi("Market regime", esc(reg.label), "", "S&P 500 trend (50/200-day MA, 20% drawdown rule) + VIX level")}
        ${kpi("Stance", esc(reg.stance), `<span class="badge ${stanceClass}">${esc(reg.stance)} · as of ${esc(reg.as_of)}</span>`, "From the 0-1 risk score: trend, volatility, credit, labour, curve, inflation")}
        ${kpi("Risk score", num(reg.risk_score, 2), "0 = benign · 1 = stressed", "Risk-On < 0.33, Risk-Off > 0.6")}
      </div></div>
      <div class="card"><h3>Why</h3><ul class="reasons">${(reg.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
    </div>
    <div class="controls"><div class="control"><span class="label">Range</span>${chips("span", [["1Y", "1Y"], ["3Y", "3Y"], ["5Y", "5Y"], ["10Y", "10Y"]], M.span, false)}</div></div>
    <div class="chart-title">S&amp;P 500 with regime stance</div>
    <div class="chart" id="m-spx"></div>
    <h2>Economic indicators (FRED)</h2>
    <div class="grid g5">${tiles}</div>
    <div class="grid g2" style="margin-top:8px">
      <div><h2>Watchlist</h2><div id="m-movers"></div></div>
      <div><h2>Breaking news</h2><div class="controls" style="margin-top:0">${chips("scope", [["All", "All"], ["Watchlist", "Watchlist"], ["Market-wide", "Market-wide"]], M.scope, false)}</div><div id="m-news"></div></div>
    </div>`;

  const drawSpx = () => {
    const span = [...M.span][0];
    const start = startFor(m.spx.d[m.spx.d.length - 1], span);
    const i0 = Math.max(0, m.spx.d.findIndex((d) => d >= start));
    const c = pal(), x = m.spx.d.slice(i0);
    const shapes = m.stance_runs.filter(([, end]) => end >= x[0]).map(([s, e, stance]) => ({
      type: "rect", xref: "x", yref: "paper", x0: s < x[0] ? x[0] : s, x1: e, y0: 0, y1: 1, line: { width: 0 },
      fillcolor: STANCE[stance], opacity: 0.1, layer: "below" }));
    const legend = Object.entries(STANCE).map(([s, col]) => ({ x: [x[x.length - 1]], y: [null], mode: "markers", name: `${s} (shading)`,
      hoverinfo: "skip", marker: { symbol: "square", size: 10, color: col, opacity: 0.4 } }));
    plot($("#m-spx"), [
      { x, y: m.spx.c.slice(i0), name: "S&P 500", line: { color: c.ink, width: 1.5 }, hovertemplate: "%{y:,.0f}" },
      { x, y: m.spx.ma50.slice(i0), name: "50-day MA", line: { color: c.ma50, width: 2 }, hovertemplate: "%{y:,.0f}" },
      { x, y: m.spx.ma200.slice(i0), name: "200-day MA", line: { color: c.ma200, width: 2 }, hovertemplate: "%{y:,.0f}" },
      ...legend,
    ], layout(380, { shapes, xaxis: { type: "date", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
      yaxis: yaxis({ tickformat: ",.0f" }) }));
  };
  const drawNews = () => {
    const scope = [...M.scope][0];
    const news = m.news.filter((n) => scope === "All" || (scope === "Watchlist" ? n.ticker : !n.ticker)).slice(0, 40);
    $("#m-news").innerHTML = table([
      { h: "Time (ET)", f: (n) => esc(n.t.slice(5)) },
      { h: "Ticker", f: (n) => esc(n.ticker || "Market") },
      { h: "Headline", cls: "wrap-text", f: (n) => link(n.url, n.title) },
      { h: "Source", cls: "clip", f: (n) => esc(n.src || "") },
      { h: "Tone", f: (n) => toneMark[n.tone] || "–" },
      { h: "FinBERT", r: 1, f: (n) => num(n.score, 2, true) },
    ], news, { tall: true, empty: "No headlines." });
  };
  $("#m-movers").innerHTML = table([
    { h: "Ticker", f: (r) => `<a href="#/stock/${esc(r.ticker)}"><b>${esc(r.ticker)}</b></a>` },
    { h: "Close", r: 1, f: (r) => num(r.close, 2) },
    { h: "1D", r: 1, f: (r) => `<span class="${tone(r.r1d)}">${pct(r.r1d)}</span>` },
    { h: "1M", r: 1, f: (r) => `<span class="${tone(r.r1m)}">${pct(r.r1m)}</span>` },
    { h: "YTD", r: 1, f: (r) => `<span class="${tone(r.ytd)}">${pct(r.ytd)}</span>` },
    { h: "Trend", f: (r) => (r.golden ? "▲ golden" : "▼ death") },
    { h: "RSI", r: 1, f: (r) => num(r.rsi, 0) },
    { h: "Factor score", f: (r) => bar(r.score) },
  ], [...m.movers].sort((a, b) => (b.r1d ?? -9) - (a.r1d ?? -9)));
  bindChips(view, "span", M.span, false, drawSpx);
  bindChips(view, "scope", M.scope, false, drawNews);
  drawSpx(); drawNews();
}

// ====================================================================================================
// Stock Deep Dive
// ====================================================================================================
const S = { span: new Set(["6M"]), layers: new Set(["News", "Unusual moves"]) };

async function tickerPicker(meta, current, route) {
  return `<div class="control"><label for="pick">Ticker</label><select id="pick">${meta.deep.map((t) =>
    `<option value="${esc(t.ticker)}"${t.ticker === current ? " selected" : ""}>${esc(t.ticker)} · ${esc(t.name)}</option>`).join("")}</select></div>`;
}
function bindPicker(route) {
  $("#pick").addEventListener("change", (e) => { location.hash = `#/${route}/${encodeURIComponent(e.target.value)}`; });
}

async function viewStock(view, arg) {
  const meta = await load("meta.json");
  const ticker = arg && meta.deep.some((t) => t.ticker === arg) ? arg : (localStorage.getItem("ticker") || meta.deep[0].ticker);
  try { localStorage.setItem("ticker", ticker); } catch (e) { /* ignore */ }
  const d = await load(`deep/${ticker.replace("^", "_")}.json`);
  const n = d.c.length, snap = d.snapshot;
  const chg = d.c[n - 1] / d.c[n - 2] - 1;
  const spread = snap.sma_200 ? snap.sma_50 / snap.sma_200 - 1 : null;
  const rsi = snap.rsi_14;
  view.innerHTML = `
    <h1>Stock Deep Dive</h1>
    <div class="controls">
      ${await tickerPicker(meta, ticker)}
      <div class="control"><span class="label">Range</span>${chips("span", ["3M", "6M", "1Y", "3Y", "All"].map((s) => [s, s]), S.span, false)}</div>
      <div class="control"><span class="label">Overlays</span>${chips("layers", ["News", "Unusual moves", "Bollinger"].map((s) => [s, s]), S.layers)}</div>
    </div>
    <p class="caption">${esc(d.name)}${d.sic ? " · " + esc(d.sic) : ""}${d.exchange ? " · " + esc(d.exchange) : ""}</p>
    <div class="grid g5">
      ${kpi("Close", num(snap.close, 2), `<span class="${tone(chg)}">${pct(chg, 2)}</span> · ${esc(snap.date)}`)}
      ${kpi("50 vs 200-day MA", pct(spread), spread > 0 ? '<span class="pos">golden-cross alignment</span>' : '<span class="neg">death-cross alignment</span>')}
      ${kpi("RSI (14)", num(rsi, 0), rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral")}
      ${kpi("Momentum 12-1", d.score ? pct(d.score.momentum_12_1, 0) : "–", "", "Return from 12 months to 1 month ago (Jegadeesh & Titman 1993)")}
      ${kpi("Factor score", d.score ? `${num(d.score.composite, 0)}/100` : "–", d.score ? `rank ${d.score.rank} of ${d.score.of}` : "")}
    </div>
    <div class="chart-title" id="s-title"></div>
    <div class="chart" id="s-chart" style="min-height:640px"></div>
    <p class="caption">Candles: blue up, red down. ▲ / ▼ / ● news markers = bullish / bearish / neutral FinBERT average of on-topic headlines,
      placed on the session they first affected. ★ = unusual move; hover for the explanation.</p>
    <details><summary>Indicator readings</summary><ul class="reasons">${(snap.readings || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>
    <div class="grid g2">
      <div><h2>Unusual moves</h2>${table([
        { h: "When", f: (m) => esc(m.d) },
        { h: "Move", r: 1, f: (m) => `<span class="${tone(m.ret)}">${pct(m.ret)}</span>` },
        { h: "z", r: 1, f: (m) => num(m.z, 1) },
        { h: "Driver", f: (m) => esc(m.driver) },
        { h: "Explanation", cls: "wrap-text", f: (m) => esc(m.why) },
        { h: "Catalyst", f: (m) => link(m.url) },
      ], [...d.moves].reverse(), { tall: true, empty: "No unusual moves in the last three years." })}</div>
      <div><h2>Headlines</h2>${table([
        { h: "Time (ET)", f: (h) => esc(h.t.slice(5)) },
        { h: "Headline", cls: "wrap-text", f: (h) => link(h.url, h.title) },
        { h: "Source", cls: "clip", f: (h) => esc(h.src || "") },
        { h: "Tone", f: (h) => toneMark[h.tone] || "–" },
        { h: "FinBERT", r: 1, f: (h) => num(h.score, 2, true) },
        { h: "1h reaction", r: 1, f: (h) => pct(h.react, 2) },
      ], d.news, { tall: true, empty: "No on-topic headlines for this ticker yet." })}</div>
    </div>`;
  bindPicker("stock");
  const draw = () => drawStockChart(d);
  bindChips(view, "span", S.span, false, draw);
  bindChips(view, "layers", S.layers, true, draw);
  draw();
}

function drawStockChart(d) {
  const c = pal(), span = [...S.span][0];
  const start = span === "All" ? d.d[0] : startFor(d.d[d.d.length - 1], span);
  const i0 = Math.max(0, d.d.findIndex((x) => x >= start));
  const sl = (a) => (a ? a.slice(i0) : []);
  const x = sl(d.d), hi = sl(d.h), lo = sl(d.l), open = sl(d.o), close = sl(d.c);
  const inRange = new Set(x), at = new Map(x.map((v, i) => [v, i]));
  const traces = [
    { type: "candlestick", x, open, high: hi, low: lo, close, name: "Price", xaxis: "x", yaxis: "y",
      increasing: { line: { color: c.up, width: 1 }, fillcolor: c.up }, decreasing: { line: { color: c.down, width: 1 }, fillcolor: c.down } },
    { x, y: sl(d.ma50), name: "50-day MA", line: { color: c.ma50, width: 2 }, hovertemplate: "%{y:.2f}" },
    { x, y: sl(d.ma200), name: "200-day MA", line: { color: c.ma200, width: 2 }, hovertemplate: "%{y:.2f}" },
  ];
  if (S.layers.has("Bollinger") && d.bbu) {
    traces.push({ x, y: sl(d.bbu), name: "Bollinger (20, 2)", line: { color: c.muted, width: 1 }, hoverinfo: "skip" });
    traces.push({ x, y: sl(d.bbl), showlegend: false, line: { color: c.muted, width: 1 }, fill: "tonexty", fillcolor: "rgba(137,135,129,0.08)", hoverinfo: "skip" });
  }
  if (S.layers.has("News")) {
    const pts = d.markers.filter((m) => inRange.has(m.d));
    for (const [label, symbol, color] of [["bullish", "triangle-up", c.up], ["bearish", "triangle-down", c.down], ["neutral", "circle", c.muted]]) {
      const p = pts.filter((m) => m.tone === label);
      if (!p.length) continue;
      traces.push({ x: p.map((m) => m.d), y: p.map((m) => hi[at.get(m.d)] * 1.02), mode: "markers", name: `News: ${label}`,
        marker: { symbol, size: 11, color, line: { color: c.surface, width: 2 } },
        customdata: p.map((m) => [m.n, ok(m.score) ? m.score.toFixed(2) : "–", m.titles.map((t) => "• " + esc(t).slice(0, 90)).join("<br>")]),
        hovertemplate: "%{customdata[0]} headline(s), FinBERT %{customdata[1]}<br>%{customdata[2]}<extra></extra>" });
    }
  }
  if (S.layers.has("Unusual moves")) {
    const mv = d.moves.filter((m) => inRange.has(m.d));
    if (mv.length) {
      traces.push({ x: mv.map((m) => m.d), y: mv.map((m) => (m.ret > 0 ? hi[at.get(m.d)] * 1.045 : lo[at.get(m.d)] * 0.96)),
        mode: "markers", name: "Unusual move", marker: { symbol: "star", size: 14, color: c.ink, line: { color: c.surface, width: 2 } },
        customdata: mv.map((m) => (m.why || "").replace(/(.{1,70})(\s|$)/g, "$1<br>")), hovertemplate: "%{customdata}<extra></extra>" });
    }
  }
  traces.push({ type: "bar", x, y: sl(d.v), name: "Volume", yaxis: "y2", showlegend: false, hovertemplate: "%{y:,.0f}",
    marker: { color: close.map((v, i) => (v >= open[i] ? c.up : c.down)), opacity: 0.5 } });
  traces.push({ x, y: sl(d.rsi), name: "RSI (14)", yaxis: "y3", showlegend: false, line: { color: c.ink2, width: 1.5 }, hovertemplate: "%{y:.0f}" });
  const lows = lo.filter(ok), highs = hi.filter(ok);
  $("#s-title").textContent = `${d.ticker} · ${span} daily`;
  plot($("#s-chart"), traces, layout(640, {
    xaxis: { type: "date", rangeslider: { visible: false }, showgrid: false, linecolor: c.axis, tickfont: { color: c.muted },
      rangebreaks: [{ bounds: ["sat", "mon"] }, { values: missingWeekdays(x) }] },
    yaxis: yaxis({ domain: [0.37, 1], range: [Math.min(...lows) * 0.95, Math.max(...highs) * 1.06] }),
    yaxis2: yaxis({ domain: [0.24, 0.35], title: { text: "Volume", font: { size: 11 } } }),
    yaxis3: yaxis({ domain: [0, 0.21], range: [0, 100], tickvals: [30, 70], title: { text: "RSI", font: { size: 11 } } }),
    shapes: [30, 70].map((y) => ({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y3", y0: y, y1: y, line: { color: c.axis, width: 1 } })),
  }));
}

// ====================================================================================================
// Financials & Research
// ====================================================================================================
const F = { model: new Set(["FF3"]) };
const FACTOR = { mkt_rf: "Market β", smb: "Size β (SMB)", hml: "Value β (HML)", mom: "Momentum β" };

async function viewFinancials(view, arg) {
  const meta = await load("meta.json");
  const ticker = arg && meta.deep.some((t) => t.ticker === arg) ? arg : (localStorage.getItem("ticker") || meta.deep[0].ticker);
  try { localStorage.setItem("ticker", ticker); } catch (e) { /* ignore */ }
  const [d, research] = await Promise.all([load(`deep/${ticker.replace("^", "_")}.json`), load("research.json")]);
  const model = [...F.model][0];
  const fin = d.fin;
  let sec = '<div class="empty">No SEC filings stored for this ticker (indices, ETFs and foreign filers have none).</div>';
  if (fin) {
    const t = fin.ttm, gr = fin.growth || {};
    sec = `
      <p class="caption">Latest filing: ${link(fin.latest.url, `${fin.latest.form} for the period ended ${fin.latest.period}`)}, filed ${esc(fin.latest.filed)}
        · CIK ${esc(d.cik || "–")}. Trailing-twelve-month figures use ${esc(fin.basis || "n/a")} (Q4 = annual − Q1–Q3).</p>
      <div class="grid g6">
        ${kpi("Revenue (TTM)", money(t.revenue), ok(gr.revenue_yoy) ? `<span class="${tone(gr.revenue_yoy)}">${pct(gr.revenue_yoy, 0)}</span> y/y latest qtr` : "")}
        ${kpi("Net income (TTM)", money(t.net_income), ok(gr.net_income_yoy) ? `<span class="${tone(gr.net_income_yoy)}">${pct(gr.net_income_yoy, 0)}</span> y/y latest qtr` : "")}
        ${kpi("Net margin", ok(t.revenue) && t.revenue ? pct(t.net_income / t.revenue, 1, false) : "–")}
        ${kpi("Free cash flow (TTM)", money(t.fcf), "", "Operating cash flow − capex")}
        ${kpi("EPS (TTM, diluted)", num(t.eps, 2))}
        ${kpi("Debt / equity", num(t.de, 2))}
      </div>
      <div class="grid g2">
        <div><div class="chart-title">Quarterly revenue and net income</div><div class="chart" id="f-rev"></div></div>
        <div><div class="chart-title">Quarterly margins</div><div class="chart" id="f-margin"></div></div>
      </div>
      <details><summary>Filings (10-K / 10-Q)</summary>${table([
        { h: "Form", f: (r) => esc(r.form) }, { h: "Period end", f: (r) => esc(r.period) }, { h: "Filed", f: (r) => esc(r.filed) },
        { h: "Revenue", r: 1, f: (r) => money(r.revenue) }, { h: "Net income", r: 1, f: (r) => money(r.net_income) },
        { h: "EPS (diluted)", r: 1, f: (r) => num(r.eps, 2) }, { h: "Debt/equity", r: 1, f: (r) => num(r.de, 2) },
        { h: "Operating CF", r: 1, f: (r) => money(r.ocf) }, { h: "CF period (days)", r: 1, f: (r) => esc(r.cf_days ?? "–") },
        { h: "Filing", f: (r) => link(r.url, "SEC") },
      ], fin.filings, { tall: true })}</details>`;
  }
  const exps = research.exposures[model] || [];
  const e = exps.find((x) => x.ticker === ticker);
  let ff = '<div class="empty">Not enough overlapping price and factor history for this ticker.</div>';
  if (e) {
    const betaTiles = Object.entries(e.betas).map(([f, b]) => {
      const t = e.t_stats[f];
      return kpi(FACTOR[f] || f, num(b, 2), `t = ${num(t, 1)}${Math.abs(t) >= 2 ? " · significant" : ""}`);
    }).join("");
    ff = `
      <p class="caption">Daily excess returns, ${esc(e.start)} to ${esc(e.end)} (${e.n_obs} days; the French library lags 1-2 months).
        Newey-West t-statistics; |t| ≥ 2 is significant.</p>
      <div class="grid g6">${kpi("Alpha / year", pct(e.alpha_annual), `t = ${num(e.alpha_t, 1)}`, "Return not explained by the factors")}${betaTiles}
        ${kpi("R²", num(e.r_squared, 2), `driven by ${esc(e.dominant_driver)}`)}</div>
      ${e.tilts && e.tilts.length ? `<p><b>Reading:</b> ${esc(e.tilts.join(", "))}.</p>` : ""}
      <div class="grid g2">
        <div><div class="chart-title">Where the annual return came from</div><div class="chart" id="f-waterfall"></div>
          <p class="caption">Annualised: risk-free rate + β × each factor's average premium + alpha.</p></div>
        <div><div class="chart-title">Rolling 1-year betas</div><div class="chart" id="f-rolling"></div></div>
      </div>`;
  }
  view.innerHTML = `
    <h1>Financials &amp; Research</h1>
    <div class="controls">${await tickerPicker(meta, ticker)}
      <div class="control"><span class="label" title="Fama & French (1993) three factors; Carhart (1997) adds momentum">Factor model ⓘ</span>${chips("model", [["FF3", "FF3"], ["Carhart", "Carhart"]], F.model, false)}</div></div>
    <h2>SEC financials · ${esc(d.name)}</h2>${sec}
    <h2>Fama-French ${esc(model)} analysis</h2>${ff}
    <h3 style="margin-top:22px">Watchlist factor exposures</h3>
    ${table([
      { h: "Ticker", f: (x) => `<a href="#/financials/${esc(x.ticker)}"><b>${esc(x.ticker)}</b></a>` },
      { h: "Alpha/yr", r: 1, f: (x) => pct(x.alpha_annual) }, { h: "Alpha t", r: 1, f: (x) => num(x.alpha_t, 1) },
      ...Object.keys(FACTOR).filter((f) => exps.some((x) => f in x.betas)).map((f) => ({ h: FACTOR[f], r: 1, f: (x) => num(x.betas[f], 2) })),
      { h: "R²", r: 1, f: (x) => num(x.r_squared, 2) },
      { h: "Stock-specific variance", f: (x) => bar(100 * (x.variance_share?.idiosyncratic ?? NaN)) },
      { h: "Driven by", f: (x) => esc(x.dominant_driver) }, { h: "Tilts", cls: "wrap-text", f: (x) => esc((x.tilts || []).join(", ")) },
    ], exps)}
    <h2>Composite factor scores</h2>
    <p class="caption">Each metric is ranked across the watchlist (0 = worst, 100 = best) and averaged into pillars: Value (E/P, FCF/P, B/M, S/P),
      Quality (ROE, cash ROA, low leverage, low accruals), Momentum (12-1, 6-1).</p>
    ${table([
      { h: "Rank", r: 1, f: (s) => esc(s.rank ?? "–") }, { h: "Ticker", f: (s) => `<b>${esc(s.ticker)}</b>` },
      { h: "Composite", f: (s) => bar(s.composite) }, { h: "Value", f: (s) => bar(s.value) }, { h: "Quality", f: (s) => bar(s.quality) },
      { h: "Momentum", f: (s) => bar(s.momentum) }, { h: "E/P", r: 1, f: (s) => pct(s.ep, 1, false) }, { h: "FCF/P", r: 1, f: (s) => pct(s.fcfp, 1, false) },
      { h: "B/M", r: 1, f: (s) => num(s.bm, 2) }, { h: "ROE", r: 1, f: (s) => pct(s.roe, 0, false) }, { h: "D/E", r: 1, f: (s) => num(s.de, 2) },
      { h: "Mom 12-1", r: 1, f: (s) => pct(s.m121, 0) }, { h: "Fundamentals as of", f: (s) => esc((s.asof || "").slice(0, 10)) },
    ], research.scores)}
    <details><summary>Academic strategy backtests (momentum and reversal)</summary>${table([
      { h: "Strategy", f: (s) => esc(s.strategy) }, { h: "Paper", cls: "clip", f: (s) => esc(s.paper) },
      { h: "CAGR", r: 1, f: (s) => pct(s.cagr, 1, false) }, { h: "Vol", r: 1, f: (s) => pct(s.vol, 1, false) },
      { h: "Sharpe", r: 1, f: (s) => num(s.sharpe, 2) }, { h: "Max drawdown", r: 1, f: (s) => pct(s.mdd, 1, false) },
      { h: "Turnover/yr", r: 1, f: (s) => num(s.turnover, 1) + "x" }, { h: "Carhart alpha", r: 1, f: (s) => pct(s.alpha) },
      { h: "Alpha t", r: 1, f: (s) => num(s.alpha_t, 1) }, { h: "Momentum β", r: 1, f: (s) => num(s.mom_beta, 2) },
    ], research.strategies)}<p class="caption">${esc(research.note)} Net of 5 bps per unit of turnover.</p></details>`;
  bindPicker("financials");
  bindChips(view, "model", F.model, false, () => viewFinancials(view, ticker));

  const c = pal();
  if (fin) {
    const q = fin.quarters;
    plot($("#f-rev"), [
      { type: "bar", x: q.labels, y: q.revenue.map((v) => (ok(v) ? v / 1e9 : null)), name: "Revenue", marker: { color: c.series[0] },
        customdata: q.revenue.map((v) => money(v)), hovertemplate: "%{x}: %{customdata}<extra>Revenue</extra>" },
      { type: "bar", x: q.labels, y: q.net_income.map((v) => (ok(v) ? v / 1e9 : null)), name: "Net income", marker: { color: c.series[1] },
        customdata: q.net_income.map((v) => money(v)), hovertemplate: "%{x}: %{customdata}<extra>Net income</extra>" },
    ], layout(330, { barmode: "group", bargap: 0.3, bargroupgap: 0.08, hovermode: "closest", yaxis: yaxis({ tickprefix: "$", ticksuffix: "B", tickformat: ",.0f" }) }));
    const margin = q.revenue.map((r, i) => (ok(r) && ok(q.net_income[i]) && r ? q.net_income[i] / r : null));
    const fcf = q.revenue.map((r, i) => (ok(r) && ok(q.ocf[i]) && ok(q.capex[i]) && r ? (q.ocf[i] - q.capex[i]) / r : null));
    plot($("#f-margin"), [
      { x: q.labels, y: margin, name: "Net margin", mode: "lines+markers", line: { color: c.series[0], width: 2 }, marker: { size: 8 } },
      { x: q.labels, y: fcf, name: "Free-cash-flow margin", mode: "lines+markers", line: { color: c.series[1], width: 2 }, marker: { size: 8 } },
    ], layout(330, { yaxis: yaxis({ tickformat: ".0%" }), shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: c.axis, width: 1 } }] }));
  }
  if (e) {
    const attr = e.return_attribution;
    const steps = [["Risk-free", attr.risk_free], ...Object.keys(e.betas).map((f) => [(FACTOR[f] || f).split(" ")[0], attr[f]]), ["Alpha", attr.alpha]];
    const total = steps.reduce((s, [, v]) => s + (v || 0), 0);
    plot($("#f-waterfall"), [{ type: "waterfall", x: [...steps.map((s) => s[0]), "Total"], y: [...steps.map((s) => s[1]), total],
      measure: [...steps.map(() => "relative"), "total"], increasing: { marker: { color: c.up } }, decreasing: { marker: { color: c.down } },
      totals: { marker: { color: c.ink2 } }, connector: { line: { color: c.axis, width: 1 } }, texttemplate: "%{y:+.1%}", textposition: "outside", cliponaxis: false,
      hovertemplate: "%{x}: %{y:+.2%}<extra></extra>" }], layout(340, { showlegend: false, hovermode: "closest", yaxis: yaxis({ tickformat: ".0%" }) }));
    const roll = d.rolling[model];
    if (roll) {
      plot($("#f-rolling"), Object.keys(e.betas).map((f, i) => ({ x: roll.d, y: roll[f], name: FACTOR[f] || f, line: { color: c.series[i], width: 2 }, hovertemplate: "%{y:.2f}" })),
        layout(340, { xaxis: { type: "date", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
          shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: c.axis, width: 1 } }] }));
    }
  }
}

// ====================================================================================================
// Paper-trading bot
// ====================================================================================================
const B = { side: new Set(), reason: new Set(), ticker: "" };

async function viewBot(view, arg) {
  const data = await load("bot.json");
  const names = Object.keys(data.portfolios);
  if (!names.length) { view.innerHTML = '<h1>Paper-trading bot</h1><div class="empty">No portfolio yet.</div>'; return; }
  const name = names.includes(arg) ? arg : names.includes("paper") ? "paper" : names[0];
  const p = data.portfolios[name], info = p.info, params = p.params || {};
  const label = { paper: "Paper (live)", backtest: "Backtest 2018-" };
  const lastClose = Object.fromEntries(p.positions.map((x) => [x.ticker, x.last]));
  const equity = p.equity, ret = equity / info.initial_cash - 1;
  let spyRet = null;
  if (p.curve && p.curve.spy.length > 1) {
    const s = p.curve.spy.filter(ok);
    spyRet = s.length > 1 ? s[s.length - 1] / s[0] - 1 : null;
  }
  const closed = p.trades.filter((t) => ok(t.ret)).map((t) => t.ret);
  const wins = closed.filter((r) => r > 0), losses = closed.filter((r) => r <= 0);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const payoff = wins.length && losses.length ? avg(wins) / Math.abs(avg(losses)) : null;
  const pos = p.positions.map((x) => Object.assign({}, x, { value: x.shares * x.last }));

  view.innerHTML = `
    <h1>Paper-trading bot</h1>
    <div class="controls"><div class="control"><span class="label">Portfolio</span><div class="chips">${names.map((n) =>
      `<a class="chip${n === name ? " on" : ""}" href="#/bot/${esc(n)}">${esc(label[n] || n)}</a>`).join("")}</div></div></div>
    <div class="grid g6">
      ${kpi("Equity", money(equity), `started with ${money(info.initial_cash)}`)}
      ${kpi("Total return", `<span class="${tone(ret)}">${pct(ret, 2)}</span>`, spyRet === null ? "" : `SPY ${pct(spyRet, 2)} same period`)}
      ${kpi("Cash", pct(info.cash / equity, 0, false))}
      ${kpi("Open positions", String(pos.length), `max ${esc(params.max_positions ?? "?")} names, ${pct(params.max_weight, 0, false)} each`)}
      ${kpi("Closed trades", String(closed.length), `${p.trades.length} fills in total`)}
      ${kpi("Win rate", closed.length ? pct(wins.length / closed.length, 0, false) : "–", payoff ? `payoff ${payoff.toFixed(2)}` : "", "Payoff = average win / average loss")}
    </div>
    <p class="caption">Last session processed: ${esc(info.last_run_date || "–")} · sizing: ${esc(params.sizing || "vol_parity")} · stops ${esc(params.atr_multiple ?? "?")}x ATR,
      max loss ${pct(params.max_loss, 0, false)} · market-on-close fills with 5 bps slippage. Paper trading, not investment advice.</p>
    <h2>Equity vs SPY</h2>
    ${p.curve && p.curve.d.length >= 2 ? '<div class="chart" id="b-equity"></div>' : `<div class="empty">The equity curve appears after the bot has processed a second session (so far: ${p.curve ? p.curve.d.length : 0}).</div>`}
    <h2>Open positions</h2>
    ${table([
      { h: "Ticker", f: (x) => `<b>${esc(x.ticker)}</b>` }, { h: "Shares", r: 1, f: (x) => num(x.shares, 0) },
      { h: "Avg cost", r: 1, f: (x) => num(x.avg_cost, 2) }, { h: "Last", r: 1, f: (x) => num(x.last, 2) },
      { h: "Value", r: 1, f: (x) => money(x.value) }, { h: "Weight", f: (x) => bar(100 * x.value / equity, 100 * (params.max_weight || 0.2)) },
      { h: "P&L ($)", r: 1, f: (x) => `<span class="${tone(x.last - x.avg_cost)}">${num((x.last - x.avg_cost) * x.shares, 0, true)}</span>` },
      { h: "P&L %", r: 1, f: (x) => `<span class="${tone(x.last - x.avg_cost)}">${pct(x.last / x.avg_cost - 1)}</span>` },
      { h: "Stop", r: 1, f: (x) => num(x.stop, 2) }, { h: "To stop", r: 1, f: (x) => pct(x.stop / x.last - 1) },
      { h: "Since", f: (x) => esc(x.since) },
    ], pos.sort((a, b) => b.value - a.value), { empty: "No open positions." })}
    <h2>Latest signals</h2>
    ${p.signals.length ? `<p class="caption">Signals for ${esc(p.signals[0].date)}: each bar is a component's weighted contribution; the black tick is the total score.
      BUY needs score ≥ the buy line and an up-trend.</p><div class="chart" id="b-signals"></div>${table([
      { h: "Ticker", f: (s) => `<b>${esc(s.ticker)}</b>` }, { h: "Action", f: (s) => `<span class="sig-${s.action === "SELL" ? "AVOID" : s.action}">${esc(s.action)}</span>` },
      { h: "Score", r: 1, f: (s) => num(s.score, 2, true) }, { h: "Rationale", cls: "wrap-text", f: (s) => esc(s.rationale) },
    ], p.signals)}` : '<div class="empty">Signals are stored for the live portfolio only.</div>'}
    <h2>Trade ledger</h2>
    <div class="controls">
      <div class="control"><label for="b-ticker">Ticker</label><select id="b-ticker"><option value="">All</option>${[...new Set(p.trades.map((t) => t.ticker))].sort().map((t) => `<option${t === B.ticker ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      <div class="control"><span class="label">Side</span>${chips("side", [["BUY", "BUY"], ["SELL", "SELL"]], B.side)}</div>
      <div class="control"><span class="label">Reason</span>${chips("reason", [...new Set(p.trades.map((t) => t.reason))].sort().map((r) => [r, r]), B.reason)}</div>
      <button class="btn" id="b-csv">Download ledger (CSV)</button>
    </div>
    <div id="b-ledger"></div>
    ${closed.length >= 5 ? `<h2>Closed trades</h2><div class="grid g2"><div class="chart" id="b-hist"></div><div id="b-reasons"></div></div>` : ""}`;

  const c = pal();
  const ledgerRows = () => p.trades.filter((t) => (!B.ticker || t.ticker === B.ticker) && (!B.side.size || B.side.has(t.side)) && (!B.reason.size || B.reason.has(t.reason)));
  const drawLedger = () => {
    $("#b-ledger").innerHTML = table([
      { h: "Date", f: (t) => esc(t.date) }, { h: "Side", f: (t) => esc(t.side) }, { h: "Ticker", f: (t) => `<b>${esc(t.ticker)}</b>` },
      { h: "Shares", r: 1, f: (t) => num(t.shares, 0) }, { h: "Price", r: 1, f: (t) => num(t.price, 2) }, { h: "Value", r: 1, f: (t) => money(t.value) },
      { h: "Reason", f: (t) => esc(t.reason) }, { h: "Round-trip return", r: 1, f: (t) => `<span class="${tone(t.ret)}">${pct(t.ret)}</span>` },
      { h: "Rationale", cls: "wrap-text", f: (t) => esc(t.rationale) },
    ], ledgerRows(), { tall: true, empty: "No trades match." });
  };
  $("#b-ticker").addEventListener("change", (e) => { B.ticker = e.target.value; drawLedger(); });
  bindChips(view, "side", B.side, true, drawLedger);
  bindChips(view, "reason", B.reason, true, drawLedger);
  $("#b-csv").addEventListener("click", () => {
    const cols = ["date", "side", "ticker", "shares", "price", "value", "reason", "ret", "rationale"];
    const quote = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.join(","), ...ledgerRows().map((t) => cols.map((k) => quote(t[k])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${name}_ledger.csv`; a.click(); URL.revokeObjectURL(a.href);
  });
  drawLedger();

  if (p.curve && p.curve.d.length >= 2) {
    const eq = p.curve.equity, spy = p.curve.spy, x = p.curve.d;
    const firstSpy = spy.find(ok);
    let peak = -Infinity;
    const dd = eq.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
    const bot = eq.map((v) => (100 * v) / eq[0]), spyIdx = spy.map((v) => (ok(v) ? (100 * v) / firstSpy : null));
    plot($("#b-equity"), [
      { x, y: bot, name: "Bot", line: { color: c.series[0], width: 2 }, hovertemplate: "%{y:.1f}" },
      { x, y: spyIdx, name: "SPY", line: { color: c.series[1], width: 2 }, hovertemplate: "%{y:.1f}" },
      { x, y: dd, name: "Bot drawdown", yaxis: "y2", fill: "tozeroy", showlegend: false, line: { color: c.series[0], width: 1 }, hovertemplate: "%{y:.1%}" },
    ], layout(460, {
      xaxis: { type: "date", showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
      yaxis: yaxis({ domain: [0.32, 1], title: { text: "Growth of 100", font: { size: 11 } } }),
      yaxis2: yaxis({ domain: [0, 0.26], tickformat: ".0%", title: { text: "Drawdown", font: { size: 11 } } }),
      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 100, y1: 100, line: { color: c.axis, width: 1 } }],
    }));
  }
  if (p.signals.length) {
    const weights = { trend: params.w_trend ?? 0.25, fundamentals: params.w_fundamentals ?? 0.25, valuation: params.w_valuation ?? 0.25, sentiment: params.w_sentiment ?? 0.25 };
    const sig = [...p.signals].sort((a, b) => a.score - b.score);
    const traces = Object.entries(weights).map(([k, w], i) => ({ type: "bar", orientation: "h", y: sig.map((s) => s.ticker), x: sig.map((s) => w * (s[k] ?? 0)),
      name: `${k[0].toUpperCase() + k.slice(1)} (${Math.round(w * 100)}%)`, marker: { color: c.series[i], line: { color: c.surface, width: 1 } },
      hovertemplate: `%{y}: %{x:+.2f}<extra>${k}</extra>` }));
    traces.push({ y: sig.map((s) => s.ticker), x: sig.map((s) => s.score), mode: "markers", name: "Score",
      marker: { symbol: "line-ns-open", size: 16, color: c.ink, line: { width: 2 } }, hovertemplate: "%{y}: score %{x:+.2f}<extra></extra>" });
    const lines = [[params.buy_threshold ?? 0.25, "buy"], [params.sell_threshold ?? -0.1, "sell"]];
    plot($("#b-signals"), traces, layout(70 + 34 * sig.length, { barmode: "relative", bargap: 0.35, hovermode: "closest",
      shapes: lines.map(([xv]) => ({ type: "line", xref: "x", x0: xv, x1: xv, yref: "paper", y0: 0, y1: 1, line: { color: c.muted, width: 1 } })),
      annotations: lines.map(([xv, text]) => ({ x: xv, y: 1, xref: "x", yref: "paper", text, showarrow: false, yanchor: "bottom", font: { color: c.muted, size: 11 } })) }));
  }
  if (closed.length >= 5) {
    const r = closed.map((v) => 100 * v);
    const lo = Math.floor(Math.min(...r) / 2) * 2, hi = Math.ceil(Math.max(...r) / 2) * 2 + 2;
    const mids = [], counts = [];
    for (let e = lo; e < hi; e += 2) { mids.push(e + 1); counts.push(r.filter((v) => v >= e && v < e + 2).length); }
    plot($("#b-hist"), [{ type: "bar", x: mids, y: counts, marker: { color: mids.map((m) => (m > 0 ? c.up : c.down)), line: { color: c.surface, width: 2 } },
      hovertemplate: "%{x:+.0f}% ±1: %{y} trades<extra></extra>" }],
      layout(300, { showlegend: false, hovermode: "closest", xaxis: { ticksuffix: "%", title: { text: "Round-trip return", font: { size: 11 } }, showgrid: false, linecolor: c.axis, tickfont: { color: c.muted } },
        yaxis: yaxis({ title: { text: "Trades", font: { size: 11 } } }) }));
    const by = {};
    p.trades.filter((t) => ok(t.ret)).forEach((t) => { (by[t.reason] = by[t.reason] || []).push(t.ret); });
    $("#b-reasons").innerHTML = `<h3>How positions closed</h3>` + table([
      { h: "Reason", f: (x) => esc(x[0]) }, { h: "Trades", r: 1, f: (x) => x[1].length },
      { h: "Win rate", r: 1, f: (x) => pct(x[1].filter((v) => v > 0).length / x[1].length, 0, false) },
      { h: "Avg return", r: 1, f: (x) => pct(avg(x[1])) },
    ], Object.entries(by)) + `<p class="caption">Average win ${pct(avg(wins))}, average loss ${pct(losses.length ? avg(losses) : NaN)}. Blue = gains, red = losses.</p>`;
  }
}

// ====================================================================================================
// Router and shell
// ====================================================================================================
const ROUTES = { global: viewGlobal, markets: viewMarkets, stock: viewStock, financials: viewFinancials, bot: viewBot };

async function render() {
  const [, name = "global", arg] = location.hash.replace(/^#/, "").split("/");
  const route = ROUTES[name] ? name : "global";
  document.querySelectorAll("nav.tabs a[data-route]").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  const view = $("#view");
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await ROUTES[route](view, arg ? decodeURIComponent(arg) : undefined);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<h1>Data not available</h1><p class="soft">This page couldn't load its data (${esc(e.message)}).
      The site is refreshed once a day; if this persists, the latest export may not have been published.</p>`;
  }
}

async function shell() {
  try {
    const meta = await load("meta.json");
    const updated = new Date(meta.generated_at);
    $("#asof").textContent = `Prices ${meta.prices_as_of} · updated ${updated.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  } catch (e) { /* the page shows its own error */ }
  $("#theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
    render();
  });
  window.addEventListener("hashchange", () => { $("#drawer").classList.remove("open"); $("#drawer-back").classList.remove("open"); render(); });
  render();
}
shell();
