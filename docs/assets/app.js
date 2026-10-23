/* Free Quant Platform: static web dashboard.
 * Reads the JSON written by `python -m quant.web.export` (data/) and renders the pages with
 * Plotly; quant.js (window.Q) does the in-browser statistics, live.js the WebSocket charts.
 * Hash routes: #/global, #/markets, #/stock/<ticker>, #/financials/<ticker>,
 * #/bot/<paper|backtest|lab>, #/live/<symbol>. Pretty paths (/stock/AAPL) redirect via 404.html.
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
const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: keep in memory only */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

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
const CLASS_NAME = { s: "Stock", e: "ETF", c: "Crypto", i: "Index" };
const signed = (x, d = 2) => `<span class="${tone(x)}">${pct(x, d)}</span>`;

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
  const body = rows.map((r, i) => `<tr class="${opts.click ? "clickable" : ""}${opts.rowClass ? " " + opts.rowClass(r) : ""}" data-i="${i}">${cols.map((c) =>
    `<td class="${c.r ? "r" : ""}${c.cls ? " " + c.cls : ""}"${c.style ? ` style="${c.style(r)}"` : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap${opts.tall ? " tall" : ""}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const link = (url, text = "Open") => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : "–");
const routeLink = (route, sym, text) => `<a href="#/${route}/${encodeURIComponent(sym)}">${text ?? `<b>${esc(sym)}</b>`}</a>`;

// --- theme and charts -----------------------------------------------------------------------------
const PAL = {
  light: { ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", surface: "#fcfcfb",
    up: "#2a78d6", down: "#e34948", ma50: "#6250d6", ma200: "#1baf7a", good: "#0f7b3f", bad: "#c22f2e",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] },
  dark: { ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", surface: "#1a1a19",
    up: "#3987e5", down: "#e66767", ma50: "#9085e9", ma200: "#199e70", good: "#4cc97f", bad: "#ef7c7b",
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
const dateAxis = (extra = {}) => Object.assign({ type: "date", showgrid: false, linecolor: pal().axis, tickfont: { color: pal().muted } }, extra);
function plot(el, traces, lay) {
  if (!el) return;
  if (!window.Plotly) { el.innerHTML = '<div class="empty">Charts are loading… (needs cdn.jsdelivr.net)</div>'; return; }
  if (!el.classList.contains("js-plotly-plot")) el.innerHTML = "";  // drop any "Loading…" placeholder
  Plotly.react(el, traces, lay, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
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
  const months = { "3M": 3, "6M": 6, "1Y": 12, "2Y": 24, "3Y": 36, "5Y": 60, "10Y": 120 }[span];
  if (!months) return null;
  const d = new Date(lastIso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// --- universe lookups -----------------------------------------------------------------------------
let screener = null, screenerBySym = null;
async function screenerRows() {
  if (!screener) {
    const g = await load("global.json");
    const idx = Object.fromEntries(g.cols.map((c, i) => [c, i]));
    screener = g.rows.map((r) => { const o = {}; for (const c in idx) o[c] = r[idx[c]]; return o; });
    screenerBySym = new Map(screener.map((r) => [r.s, r]));
  }
  return screener;
}
/** Screener row, or an index row shaped like one, or null. */
async function rowFor(sym) {
  await screenerRows();
  if (screenerBySym.has(sym)) return screenerBySym.get(sym);
  const idx = await load("indices.json").catch(() => []);
  const i = idx.find((x) => x.s === sym);
  return i ? Object.assign({ sig: "N/A", why: "", sec: "Index" }, i) : null;
}
// FNV-1a over UTF-8, identical to quant/web/export.py, picks the symbol's data bucket.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** {px: {dates, values} (adjusted daily closes), info: fundamentals} from the symbol's bucket. */
async function symbolData(sym) {
  const b = (fnv1a(sym) % 256).toString(16).padStart(2, "0");
  const bucketData = await load(`sym/${b}.json`).catch(() => ({}));
  const rec = bucketData[sym];
  if (!rec) return null;
  let px = null;
  if (rec.p) {
    const [start, gaps, values] = rec.p;
    const d = new Date(start + "T00:00:00Z"), dates = [d.toISOString().slice(0, 10)];
    for (const g of gaps) { d.setUTCDate(d.getUTCDate() + g); dates.push(d.toISOString().slice(0, 10)); }
    px = { dates, values };
  }
  return { px, info: rec.i || {} };
}
async function isDeep(sym) { return (await load("meta.json")).deep.some((t) => t.ticker === sym); }
/** Longest adjusted price history available: 10 years for deep-tier names, ~2 years otherwise. */
async function priceHistory(sym) {
  if (await isDeep(sym)) {
    const d = await load(`deep/${sym.replace("^", "_")}.json`);
    return { dates: d.d, values: d.ac || d.c, source: "deep" };
  }
  const sd = await symbolData(sym);
  return sd && sd.px ? Object.assign({ source: "universe" }, sd.px) : null;
}
const isUSListed = (r) => r && (r.m === "US" || r.m === "US ETFs");
const usTicker = (sym) => /^[A-Z][A-Z0-9-]{0,6}$/.test(sym) && !sym.endsWith("-USD");

// --- watchlist (per visitor, in this browser) -------------------------------------------------------
let watchCache = null;
async function watchlist() {
  if (watchCache) return watchCache;
  let list = store.get("watchlist");
  if (!Array.isArray(list)) {
    const meta = await load("meta.json");
    list = [...meta.deep.map((t) => t.ticker), "^GSPC"];
    for (const s of store.get("saved", [])) if (!list.includes(s)) list.push(s);  // stars from the first version
    store.set("watchlist", list);
  }
  watchCache = list;
  return list;
}
function setWatchlist(list) { watchCache = [...new Set(list)]; store.set("watchlist", watchCache); }
const inWatch = (sym) => (watchCache || []).includes(sym);
async function toggleWatch(sym) {
  const list = await watchlist();
  setWatchlist(list.includes(sym) ? list.filter((s) => s !== sym) : [...list, sym]);
  return inWatch(sym);
}

// --- search with autocomplete ---------------------------------------------------------------------
function matchSymbols(syms, q) {
  const Q = q.toUpperCase(), ql = q.toLowerCase(), out = [];
  for (const s of syms) {
    const sym = s[0].toUpperCase(), name = (s[1] || "").toLowerCase();
    const sc = sym === Q ? 0 : sym.startsWith(Q) ? 1 : sym.split(/[.\-]/)[0] === Q ? 1 : name.startsWith(ql) ? 2
      : name.includes(" " + ql) ? 3 : sym.includes(Q) ? 4 : name.includes(ql) ? 5 : -1;
    if (sc >= 0) out.push([sc, sym.length, s]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}
function searchBox(placeholder = "Search any ticker or company") {
  return `<div class="search"><input type="search" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"
    aria-label="${esc(placeholder)}" role="combobox" aria-autocomplete="list" aria-expanded="false"><div class="results" role="listbox" hidden></div></div>`;
}
/** Wire a searchBox inside `root`; onPick(symbol) gets an exact universe symbol or the typed text. */
function bindSearch(root, onPick) {
  const input = $("input", root), box = $(".results", root);
  let items = [], active = -1;
  const close = () => { box.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const draw = () => {
    box.innerHTML = items.length ? items.map((s, i) => `<div class="opt${i === active ? " on" : ""}" role="option" data-i="${i}">
        <b>${esc(s[0])}</b><span>${esc(s[1] || "")}</span><em>${esc(CLASS_NAME[s[2]] || s[2])} · ${esc(s[3])}</em></div>`).join("")
      : `<div class="none">Not in the universe. Press Enter to look it up anyway.</div>`;
    box.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  const update = async () => {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const syms = await load("symbols.json");
    if (input.value.trim() !== q) return;  // a newer keystroke won
    items = matchSymbols(syms, q).slice(0, 12); active = items.length ? 0 : -1; draw();
  };
  const pick = (sym) => { close(); input.value = ""; input.blur(); onPick(sym); };
  input.addEventListener("input", update);
  input.addEventListener("focus", () => { if (input.value.trim()) update(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && items.length) { active = (active + 1) % items.length; draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && items.length) { active = (active - 1 + items.length) % items.length; draw(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); const q = input.value.trim(); if (q) pick(items[active] ? items[active][0] : q.toUpperCase()); }
    else if (e.key === "Escape") close();
  });
  box.addEventListener("mousedown", (e) => { const o = e.target.closest(".opt"); if (o) { e.preventDefault(); pick(items[Number(o.dataset.i)][0]); } });
  input.addEventListener("blur", () => setTimeout(close, 120));
}

// --- Finnhub (optional, the visitor's own free key) -----------------------------------------------
const FH = {
  key: () => store.get("finnhubKey", ""),
  async get(path, params = {}) {
    const key = FH.key();
    if (!key) throw new Error("No Finnhub key: add one in ⚙ settings");
    const r = await fetch(`https://finnhub.io/api/v1/${path}?${new URLSearchParams(Object.assign({}, params, { token: key }))}`);
    if (r.status === 401 || r.status === 403) throw new Error("Finnhub refused the request (invalid key, or this data needs a paid plan)");
    if (r.status === 429) throw new Error("Finnhub rate limit reached (60 calls a minute on the free plan); try again shortly");
    if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
    return r.json();
  },
};

// ====================================================================================================
// Global Overview
// ====================================================================================================
const G = { classes: new Set(["s", "e", "c"]), signals: new Set(), market: "", sector: "", q: "", min: 0, cap: "",
  unusual: false, sort: "sc", dir: -1, page: 0, tab: "screener" };
const PAGE = 50;

async function viewGlobal(view) {
  const [g, rows] = [await load("global.json"), await screenerRows()];
  await watchlist();
  const markets = [...new Set(rows.map((r) => r.m))].sort();
  const sectors = [...new Set(rows.filter((r) => r.sec).map((r) => r.sec))].sort();
  const regimes = g.regimes.map((r) => {
    const color = { Bull: "good", Bear: "bad", Sideways: "warn" }[r.trend] || "";
    return `<div class="card regime" title="${esc(`${r.regime} · ${r.index} ${num(r.level, 0)} · ${pct(r.drawdown_52w, 0)} from its 52-week high · as of ${r.as_of}`)}">
      <div class="name">${esc(r.market)}</div>
      <div class="line"><span class="badge ${color}">${esc(r.trend)}</span><span class="badge">${esc(r.volatility)}</span></div>
      <div class="line"><span class="${tone(r.ret_1m)}">${pct(r.ret_1m)}</span> 1M · ${esc(r.stance)}</div></div>`;
  }).join("");
  const counts = { s: 0, e: 0, c: 0 };
  rows.forEach((r) => counts[r.a]++);

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
      <div class="control"><label for="g-q">Filter</label><input id="g-q" type="search" placeholder="Name or symbol" value="${esc(G.q)}"></div>
      <div class="control"><label for="g-min">Min score</label><input id="g-min" type="number" min="0" max="100" step="5" value="${G.min}"></div>
      <div class="control"><label for="g-cap">Size</label><select id="g-cap"><option value="">Any</option><option value="10"${G.cap === "10" ? " selected" : ""}>≥ $10B</option><option value="100"${G.cap === "100" ? " selected" : ""}>≥ $100B</option></select></div>
      <label class="toggle"><input id="g-unusual" type="checkbox"${G.unusual ? " checked" : ""}> Unusual moves only</label>
    </div>
    <div class="grid g4" id="g-kpis"></div>
    <div class="subtabs" id="g-tabs">
      <button type="button" data-tab="screener">Screener</button><button type="button" data-tab="movers">Unusual movers today</button><button type="button" data-tab="watch">Watchlist ★</button>
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

const starCell = { h: "★", f: (r) => `<button class="star${inWatch(r.s) ? " on" : ""}" data-star="${esc(r.s)}" title="Add to or remove from your watchlist">${inWatch(r.s) ? "★" : "☆"}</button>` };
const SCREEN_COLS = [
  starCell,
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
  { h: "1D", sort: "r1d", r: 1, f: (r) => signed(r.r1d, 1) },
  { h: "1M", sort: "r1m", r: 1, f: (r) => signed(r.r1m, 1) },
  { h: "YTD", sort: "ytd", r: 1, f: (r) => signed(r.ytd, 1) },
  { h: "12-1", sort: "m121", r: 1, f: (r) => pct(r.m121, 0) },
  { h: "Fwd P/E", sort: "fpe", r: 1, f: (r) => num(r.fpe, 1) },
  { h: "Mkt cap $B", sort: "cap", r: 1, f: (r) => num(r.cap, r.cap >= 100 ? 0 : 1) },
  { h: "6M", cls: "spark-cell", f: (r) => spark(r.sp) },
  { h: "Why", cls: "wrap-text", f: (r) => `<div class="clamp" title="${esc(r.why)}">${esc(r.why)}</div>` },
];
function bindStars(root, onChange) {
  root.querySelectorAll("[data-star]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const on = await toggleWatch(b.dataset.star);
    b.classList.toggle("on", on); b.textContent = on ? "★" : "☆";
    if (onChange) onChange();
  }));
}

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
      { h: "1D", r: 1, f: (r) => signed(r.r1d, 1) }, { h: "z", r: 1, f: (r) => num(r.z, 1) }, SCREEN_COLS[5], SCREEN_COLS[6], SCREEN_COLS[19]];
  } else {
    if (G.tab === "watch") list = rows.filter((r) => inWatch(r.s));
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
  const empty = G.tab === "watch" ? "Your watchlist has no names matching these filters. Click ☆ on any row to add it (saved in this browser)." : "No matches. Try loosening the filters.";
  const body = $("#g-body", view);
  body.innerHTML = table(marked, pageRows, { click: true, empty }) + (list.length > PAGE ? `
    <div class="pager"><span>${(G.page * PAGE + 1).toLocaleString()}–${Math.min(list.length, (G.page + 1) * PAGE).toLocaleString()} of ${list.length.toLocaleString()}</span>
      <button class="btn" id="g-prev"${G.page ? "" : " disabled"}>← Previous</button><button class="btn" id="g-next"${G.page < pages - 1 ? "" : " disabled"}>Next →</button></div>` : "");
  body.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    G.dir = G.sort === k ? -G.dir : (k === "s" ? 1 : -1);
    G.sort = k; G.page = 0; drawGlobal();
  }));
  bindStars(body, () => { if (G.tab === "watch") drawGlobal(); });
  body.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openDetail(pageRows[Number(tr.dataset.i)])));
  const prev = $("#g-prev", body), next = $("#g-next", body);
  if (prev) prev.addEventListener("click", () => { G.page--; drawGlobal(); body.scrollIntoView({ block: "start" }); });
  if (next) next.addEventListener("click", () => { G.page++; drawGlobal(); body.scrollIntoView({ block: "start" }); });
}

function closeDrawer() {
  $("#drawer").classList.remove("open"); $("#drawer-back").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true");
}
async function openDetail(r, span = "1Y") {
  const drawer = $("#drawer"), back = $("#drawer-back");
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
      ${kpi("1 month", signed(r.r1m, 1))}${kpi("Year to date", signed(r.ytd, 1))}
      ${kpi("Momentum 12-1", pct(r.m121, 0))}${kpi("vs 200-day MA", pct(r.d200))}
      ${kpi("Fwd P/E", num(r.fpe, 1))}${kpi("ROE", pct(r.roe, 0, false))}${kpi("Dividend yield", ok(r.dy) ? num(r.dy, 2) + "%" : "–")}${kpi("Mkt cap", ok(r.cap) ? money(r.cap * 1e9) : "–")}
    </div>
    <p class="caption">Pillars are percentiles among peers (stocks: same market, and same sector for value and quality; ETFs and coins within their class). ${r.lab ? `Analyst consensus: ${esc(r.lab)}.` : ""}</p>
    <div class="asset-actions">
      ${routeLink("stock", r.s, "Stock page →")} · ${routeLink("financials", r.s, "Research →")} · ${link(yahoo, "Yahoo Finance ↗")}
      <button class="btn${inWatch(r.s) ? " on" : ""}" id="d-watch" type="button">${inWatch(r.s) ? "★ In watchlist" : "☆ Add to watchlist"}</button>
    </div>`;
  drawer.classList.add("open"); back.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  $("#d-close").onclick = closeDrawer; back.onclick = closeDrawer;
  drawer.querySelectorAll("a[href^='#/']").forEach((a) => (a.onclick = closeDrawer));
  document.onkeydown = (e) => { if (e.key === "Escape") closeDrawer(); };
  drawer.querySelectorAll("#d-span .chip").forEach((b) => b.addEventListener("click", () => openDetail(r, b.dataset.v)));
  $("#d-watch").onclick = async () => { const on = await toggleWatch(r.s); $("#d-watch").classList.toggle("on", on); $("#d-watch").textContent = on ? "★ In watchlist" : "☆ Add to watchlist"; };

  const sd = await symbolData(r.s);
  const el = $("#d-chart");
  if (!sd || !sd.px) { el.innerHTML = '<div class="empty">No price history for this symbol.</div>'; return; }
  priceChart(el, sd.px, span, { height: 340 });
}

/** Line chart of closes with 50/200-day MAs (and optional Bollinger + RSI panel). */
function priceChart(el, px, span, { height = 360, bollinger = false, rsiPanel = false } = {}) {
  const c = pal(), ma50 = Q.sma(px.values, 50), ma200 = Q.sma(px.values, 200);
  const start = span === "All" ? px.dates[0] : startFor(px.dates[px.dates.length - 1], span);
  const i0 = Math.max(0, px.dates.findIndex((d) => d >= start));
  const x = px.dates.slice(i0), sl = (a) => a.slice(i0);
  const traces = [
    { x, y: sl(px.values), name: "Close", line: { color: c.ink, width: 1.5 }, hovertemplate: "%{y:,.4~f}" },
    { x, y: sl(ma50), name: "50-day MA", line: { color: c.ma50, width: 2 }, hovertemplate: "%{y:,.4~f}" },
    { x, y: sl(ma200), name: "200-day MA", line: { color: c.ma200, width: 2 }, hovertemplate: "%{y:,.4~f}" },
  ];
  if (bollinger) {
    const bb = Q.bollinger(px.values, 20, 2);
    traces.push({ x, y: sl(bb.upper), name: "Bollinger (20, 2)", line: { color: c.muted, width: 1 }, hoverinfo: "skip" });
    traces.push({ x, y: sl(bb.lower), showlegend: false, line: { color: c.muted, width: 1 }, fill: "tonexty", fillcolor: "rgba(137,135,129,0.08)", hoverinfo: "skip" });
  }
  const lay = { xaxis: dateAxis() };
  if (rsiPanel) {
    traces.push({ x, y: sl(Q.rsi(px.values, 14)), name: "RSI (14)", yaxis: "y2", showlegend: false, line: { color: c.ink2, width: 1.5 }, hovertemplate: "%{y:.0f}" });
    Object.assign(lay, { yaxis: yaxis({ domain: [0.3, 1] }), yaxis2: yaxis({ domain: [0, 0.22], range: [0, 100], tickvals: [30, 70], title: { text: "RSI", font: { size: 11 } } }),
      shapes: [30, 70].map((y) => ({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y2", y0: y, y1: y, line: { color: c.axis, width: 1 } })) });
  }
  plot(el, traces, layout(height, lay));
}

// ====================================================================================================
// Markets (with the customizable watchlist)
// ====================================================================================================
const M = { span: new Set(["3Y"]), scope: new Set(["All"]) };

async function viewMarkets(view) {
  const m = await load("market.json");
  const reg = m.regime;
  const stanceClass = { "Risk-On": "good", Neutral: "warn", "Risk-Off": "bad" }[reg.stance] || "";
  const tiles = m.fred.map((t) => {
    if (!ok(t.value)) return kpi(t.label, "–");
    const deltaUnit = t.unit === "%" ? "pp" : t.unit;
    const dcls = !ok(t.delta) || !t.inverse ? "muted" : t.delta > 0 ? "neg" : t.delta < 0 ? "pos" : "muted";
    return `<div class="card kpi tile" title="${esc(t.help)} · latest ${esc(t.date)}"><div class="label">${esc(t.label)}</div>
      <div class="value">${num(t.value, t.digits)}${esc(t.unit)}</div>
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
    <h2>Your watchlist</h2>
    <div class="controls" style="margin-top:0">
      <div class="control" style="width:min(360px,100%)"><span class="label">Add a stock, ETF, coin or index</span><div id="w-add">${searchBox("Search to add (e.g. 005930.KS, BTC, ^N225)")}</div></div>
      <button class="btn" id="w-reset" type="button">Reset to default</button>
      <span class="caption">Saved in this browser. ★ on the Global screener adds names too.</span>
    </div>
    <div id="w-table"></div>
    <div class="controls"><div class="control"><span class="label">Range</span>${chips("span", [["1Y", "1Y"], ["3Y", "3Y"], ["5Y", "5Y"], ["10Y", "10Y"]], M.span, false)}</div></div>
    <div class="chart-title">S&amp;P 500 with regime stance</div>
    <div class="chart" id="m-spx"></div>
    <h2>Economic indicators (FRED)</h2>
    <div class="grid g5">${tiles}</div>
    <h2>Breaking news</h2><div class="controls" style="margin-top:0">${chips("scope", [["All", "All"], ["Watchlist", "Watchlist"], ["Market-wide", "Market-wide"]], M.scope, false)}</div><div id="m-news"></div>`;

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
    ], layout(380, { shapes, xaxis: dateAxis(), yaxis: yaxis({ tickformat: ",.0f" }) }));
  };
  const drawNews = () => {
    const scope = [...M.scope][0];
    const news = m.news.filter((n) => scope === "All" || (scope === "Watchlist" ? n.ticker : !n.ticker)).slice(0, 40);
    $("#m-news").innerHTML = table([
      { h: "Time (ET)", f: (n) => esc(n.t.slice(5)) },
      { h: "Ticker", f: (n) => (n.ticker ? routeLink("stock", n.ticker) : "Market") },
      { h: "Headline", cls: "wrap-text", f: (n) => link(n.url, n.title) },
      { h: "Source", cls: "clip", f: (n) => esc(n.src || "") },
      { h: "Tone", f: (n) => toneMark[n.tone] || "–" },
      { h: "FinBERT", r: 1, f: (n) => num(n.score, 2, true) },
    ], news, { tall: true, empty: "No headlines." });
  };
  bindSearch($("#w-add", view), async (sym) => {
    if (!(await rowFor(sym))) { alert(`${sym} isn't in the platform's universe, so there is no data to show for it.`); return; }
    setWatchlist([...(await watchlist()), sym]); drawWatchlist();
  });
  $("#w-reset", view).addEventListener("click", async () => {
    store.del("watchlist"); store.del("saved"); watchCache = null; await watchlist(); drawWatchlist();
  });
  bindChips(view, "span", M.span, false, drawSpx);
  bindChips(view, "scope", M.scope, false, drawNews);
  await drawWatchlist();
  drawSpx(); drawNews();
}

async function drawWatchlist() {
  const list = await watchlist();
  const rows = await Promise.all(list.map(async (s) => (await rowFor(s)) || { s, n: "(no longer in the universe)", missing: true }));
  const el = $("#w-table");
  if (!el) return;
  el.innerHTML = table([
    { h: "Symbol", f: (r) => routeLink("stock", r.s) },
    { h: "Name", cls: "clip", f: (r) => esc(r.n || "") },
    { h: "Class", f: (r) => esc(CLASS_NAME[r.a] || "–") },
    { h: "Last", r: 1, f: (r) => num(r.px, r.px >= 1000 ? 0 : 2) },
    { h: "1D", r: 1, f: (r) => signed(r.r1d, 1) },
    { h: "1M", r: 1, f: (r) => signed(r.r1m, 1) },
    { h: "YTD", r: 1, f: (r) => signed(r.ytd, 1) },
    { h: "vs 200d", r: 1, f: (r) => (ok(r.d200) ? `${r.d200 > 0 ? "▲" : "▼"} ${pct(r.d200, 1)}` : "–") },
    { h: "RSI", r: 1, f: (r) => num(r.rsi, 0) },
    { h: "Score", f: (r) => bar(r.sc) },
    { h: "Signal", f: (r) => `<span class="sig-${esc(r.sig)}">${SIGNAL[r.sig] || "–"}</span>` },
    { h: "6M", cls: "spark-cell", f: (r) => spark(r.sp) },
    { h: "", f: (r) => `<button class="btn" data-remove="${esc(r.s)}" title="Remove from watchlist" aria-label="Remove ${esc(r.s)}">✕</button>` },
  ], rows, { empty: "Your watchlist is empty. Search above to add names." });
  el.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    setWatchlist((await watchlist()).filter((s) => s !== b.dataset.remove)); drawWatchlist();
  }));
}

// ====================================================================================================
// Stock pages: full deep dive for deep-tier names, data-driven deep dive for every other symbol
// ====================================================================================================
const S = { span: new Set(["6M"]), layers: new Set(["News", "Unusual moves"]) };

function assetHeader(sym, name, sub, route) {
  return `
    <div class="asset-head"><h1>${esc(sym)}</h1><span class="soft">${esc(name || "")}</span></div>
    <p class="caption">${sub}</p>
    <div class="asset-actions">
      <div style="width:min(320px,100%)" id="asset-search">${searchBox(route === "financials" ? "Research another ticker" : "Open another ticker")}</div>
      <button class="btn${inWatch(sym) ? " on" : ""}" id="watch-btn" type="button">${inWatch(sym) ? "★ In watchlist" : "☆ Add to watchlist"}</button>
      ${route === "financials" ? `<a class="btn" href="#/stock/${encodeURIComponent(sym)}">Stock page</a>` : `<a class="btn" href="#/financials/${encodeURIComponent(sym)}">Research</a>`}
      ${liveSymbolFor(sym) ? `<a class="btn" href="#/live/${encodeURIComponent(liveSymbolFor(sym))}">Live chart</a>` : ""}
    </div>`;
}
function bindAssetHeader(view, sym, route) {
  bindSearch($("#asset-search", view), (s) => { location.hash = `#/${route}/${encodeURIComponent(s)}`; });
  $("#watch-btn", view).addEventListener("click", async () => {
    const on = await toggleWatch(sym), b = $("#watch-btn", view);
    b.classList.toggle("on", on); b.textContent = on ? "★ In watchlist" : "☆ Add to watchlist";
  });
}
/** Symbol for the Live page: Binance USDT pairs for coins, Finnhub for US listings. */
function liveSymbolFor(sym) {
  if (/-USD$/.test(sym)) return sym.replace(/\d*-USD$/, "").replace(/[^A-Z0-9]/g, "") + "USDT";
  return usTicker(sym) ? sym : null;
}

async function viewStock(view, arg) {
  const meta = await load("meta.json");
  await watchlist();
  const sym = arg || store.get("ticker", meta.deep[0].ticker);
  store.set("ticker", sym);
  if (meta.deep.some((t) => t.ticker === sym)) return viewStockDeep(view, sym);
  const row = await rowFor(sym);
  if (!row) return viewUnknown(view, sym, "stock");
  return viewStockUniverse(view, sym, row);
}

async function viewStockDeep(view, ticker) {
  const d = await load(`deep/${ticker.replace("^", "_")}.json`);
  const n = d.c.length, snap = d.snapshot;
  const chg = d.c[n - 1] / d.c[n - 2] - 1;
  const spread = snap.sma_200 ? snap.sma_50 / snap.sma_200 - 1 : null;
  const rsi = snap.rsi_14;
  view.innerHTML = `
    ${assetHeader(ticker, d.name, `${esc(d.sic || "")}${d.exchange ? " · " + esc(d.exchange) : ""} · deep tier: candlesticks, news and explained moves`, "stock")}
    <div class="controls">
      <div class="control"><span class="label">Range</span>${chips("span", ["3M", "6M", "1Y", "3Y", "All"].map((s) => [s, s]), S.span, false)}</div>
      <div class="control"><span class="label">Overlays</span>${chips("layers", ["News", "Unusual moves", "Bollinger"].map((s) => [s, s]), S.layers)}</div>
    </div>
    <div class="grid g5">
      ${kpi("Close", num(snap.close, 2), `${signed(chg, 2)} · ${esc(snap.date)}`)}
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
        { h: "Move", r: 1, f: (m) => signed(m.ret, 1) },
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
  bindAssetHeader(view, ticker, "stock");
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
    xaxis: dateAxis({ rangeslider: { visible: false }, rangebreaks: [{ bounds: ["sat", "mon"] }, { values: missingWeekdays(x) }] }),
    yaxis: yaxis({ domain: [0.37, 1], range: [Math.min(...lows) * 0.95, Math.max(...highs) * 1.06] }),
    yaxis2: yaxis({ domain: [0.24, 0.35], title: { text: "Volume", font: { size: 11 } } }),
    yaxis3: yaxis({ domain: [0, 0.21], range: [0, 100], tickvals: [30, 70], title: { text: "RSI", font: { size: 11 } } }),
    shapes: [30, 70].map((y) => ({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y3", y0: y, y1: y, line: { color: c.axis, width: 1 } })),
  }));
}

const U = { span: new Set(["1Y"]), bollinger: new Set() };
async function viewStockUniverse(view, sym, row) {
  const sd = await symbolData(sym);
  const info = (sd && sd.info) || {}, px = sd && sd.px;
  const vals = px ? px.values : [];
  const n = vals.length;
  const ma50 = Q.sma(vals, 50), ma200 = Q.sma(vals, 200), rsi = Q.rsi(vals, 14);
  const last = n ? vals[n - 1] : null, chg = n > 1 ? vals[n - 1] / vals[n - 2] - 1 : null;
  const spread = n && ma200[n - 1] ? ma50[n - 1] / ma200[n - 1] - 1 : null;
  const sub = [row.m, row.sec || CLASS_NAME[row.a], info.ind, info.ex, row.cur].filter(Boolean).map(esc).join(" · ");
  view.innerHTML = `
    ${assetHeader(sym, row.n, sub, "stock")}
    <div class="controls">
      <div class="control"><span class="label">Range</span>${chips("uspan", ["3M", "6M", "1Y", "All"].map((s) => [s, s]), U.span, false)}</div>
      <div class="control"><span class="label">Overlays</span>${chips("ubb", [["bb", "Bollinger"]], U.bollinger)}</div>
    </div>
    <div class="grid g5">
      ${kpi("Last close", num(last, last >= 1000 ? 0 : 2), `${signed(chg, 2)}${px ? " · " + esc(px.dates[n - 1]) : ""}`)}
      ${kpi("50 vs 200-day MA", pct(spread), spread == null ? "" : spread > 0 ? '<span class="pos">golden-cross alignment</span>' : '<span class="neg">death-cross alignment</span>')}
      ${kpi("RSI (14)", num(rsi[n - 1], 0), ok(rsi[n - 1]) ? (rsi[n - 1] >= 70 ? "overbought" : rsi[n - 1] <= 30 ? "oversold" : "neutral") : "")}
      ${kpi("Momentum 12-1", pct(row.m121, 0), "", "Return from 12 months to 1 month ago")}
      ${kpi("Composite score", ok(row.sc) ? `${num(row.sc, 0)}/100` : "–", `<span class="sig-${esc(row.sig)}">${SIGNAL[row.sig] || "–"}</span>`)}
    </div>
    <div class="chart-title">${esc(sym)} · daily close</div>
    <div class="chart" id="u-chart" style="min-height:460px">${px ? "" : '<div class="empty">No price history for this symbol.</div>'}</div>
    ${row.why ? `<div class="note"><b>Why ${SIGNAL[row.sig] || ""}:</b> ${esc(row.why)}</div>` : ""}
    <div class="grid g2">
      <div><h2>Returns and risk</h2>${table([{ h: "Measure", f: (x) => esc(x[0]) }, { h: "Value", r: 1, f: (x) => x[1] }], [
        ["1 day", signed(row.r1d, 2)], ["1 week", signed(row.r1w, 2)], ["1 month", signed(row.r1m, 1)], ["3 months", signed(row.r3m, 1)],
        ["Year to date", signed(row.ytd, 1)], ["52 weeks", ok(info.w52) ? signed(info.w52 / 100, 1) : "–"], ["Momentum 12-1", pct(row.m121, 1)],
        ["Momentum 6-1", pct(info.m61, 1)], ["Distance to 200-day MA", pct(row.d200, 1)], ["Volatility (1y, annualised)", pct(info.vol ?? row.vol, 1, false)],
        ["Max drawdown (1y)", pct(info.mdd ?? row.mdd, 1)], ["Last MA cross", info.cross ? `${esc(info.cross)} cross, ${info.cross_ago} sessions ago` : "–"],
      ])}</div>
      <div><h2>Peer percentiles</h2>${row.a === "i" ? '<div class="empty">Indices are not scored.</div>' : table([{ h: "Pillar", f: (x) => esc(x[0]) }, { h: "Percentile among peers", f: (x) => bar(x[1]) }], [
        ["Composite", row.sc], ["Trend", row.t], ["Momentum", row.mo], ["Risk (low is better)", row.r], ["Value", row.v], ["Quality", row.q],
        ["Analysts", row.an], ...(row.a === "e" ? [["Cost", row.co]] : []),
      ])}
      <p class="caption">${await isDeep(sym) ? "" : "Candlesticks, news and explained unusual moves are kept for the deep-tier names; add this one to the deep tier from the local dashboard to get them."}</p></div>
    </div>`;
  bindAssetHeader(view, sym, "stock");
  const draw = () => { if (px) priceChart($("#u-chart"), px, [...U.span][0], { height: 460, bollinger: U.bollinger.has("bb"), rsiPanel: true }); };
  bindChips(view, "uspan", U.span, false, draw);
  bindChips(view, "ubb", U.bollinger, true, draw);
  draw();
}

/** A ticker outside the universe: suggestions, plus a live lookup when a Finnhub key is set. */
async function viewUnknown(view, sym, route) {
  const sugg = matchSymbols(await load("symbols.json"), sym.split(/[.\-]/)[0]).slice(0, 8);
  view.innerHTML = `
    <div class="asset-head"><h1>${esc(sym)}</h1></div>
    <p class="soft">${esc(sym)} isn't in the platform's universe (stocks ≥ $1B in 21 markets, liquid US-listed ETFs, the top 250 coins and the main indices).</p>
    <div style="width:min(360px,100%)" id="asset-search">${searchBox("Search the universe")}</div>
    ${sugg.length ? `<h3 style="margin-top:20px">Did you mean</h3><p>${sugg.map((s) => `${routeLink(route, s[0])} <span class="muted">${esc(s[1] || "")}</span>`).join(" · ")}</p>` : ""}
    <div id="fh-lookup"></div>`;
  bindSearch($("#asset-search", view), (s) => { location.hash = `#/${route}/${encodeURIComponent(s)}`; });
  const box = $("#fh-lookup", view);
  if (!usTicker(sym)) return;
  if (!FH.key()) { box.innerHTML = `<div class="note">For a US-listed ticker outside the universe, add a free Finnhub key in ⚙ settings to look it up live.</div>`; return; }
  box.innerHTML = '<div class="loading">Looking it up on Finnhub…</div>';
  try {
    const [q, prof, met] = await Promise.all([FH.get("quote", { symbol: sym }), FH.get("stock/profile2", { symbol: sym }), FH.get("stock/metric", { symbol: sym, metric: "all" })]);
    if (!q || !q.c) { box.innerHTML = `<div class="empty">Finnhub has no quote for ${esc(sym)}.</div>`; return; }
    const m = (met && met.metric) || {};
    box.innerHTML = `<h2>Live lookup · Finnhub</h2>
      <p class="caption">${esc(prof.name || sym)}${prof.exchange ? " · " + esc(prof.exchange) : ""}${prof.finnhubIndustry ? " · " + esc(prof.finnhubIndustry) : ""}</p>
      <div class="grid g6">${kpi("Price", num(q.c, 2), `${signed(q.dp / 100, 2)} today`)}${kpi("Market cap", money((prof.marketCapitalization || NaN) * 1e6))}
        ${kpi("52-week high", num(m["52WeekHigh"], 2))}${kpi("52-week low", num(m["52WeekLow"], 2))}${kpi("Beta", num(m.beta, 2))}${kpi("P/E (TTM)", num(m.peTTM ?? m.peBasicExclExtraTTM, 1))}</div>
      <p><a class="btn" href="#/live/${encodeURIComponent(sym)}">Live chart</a></p>`;
  } catch (e) { box.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
}

// ====================================================================================================
// Financials & Research (any ticker)
// ====================================================================================================
const F = { model: new Set(["FF3"]) };
const FACTOR = { mkt_rf: "Market β", smb: "Size β (SMB)", smb5: "Size β (SMB)", hml: "Value β (HML)", mom: "Momentum β",
  rmw: "Profitability β (RMW)", cma: "Investment β (CMA)" };
const MODEL_HELP = "FF3: Fama & French (1993) market, size and value. Carhart (1997) adds momentum. FF5: Fama & French (2015) add profitability (RMW) and investment (CMA).";

async function viewFinancials(view, arg) {
  const meta = await load("meta.json");
  await watchlist();
  const sym = arg || store.get("ticker", meta.deep[0].ticker);
  store.set("ticker", sym);
  const row = await rowFor(sym);
  const deep = meta.deep.some((t) => t.ticker === sym);
  if (!row && !deep) return viewUnknown(view, sym, "financials");
  const [sd, research] = [await symbolData(sym), await load("research.json")];
  const d = deep ? await load(`deep/${sym.replace("^", "_")}.json`) : null;
  const info = (sd && sd.info) || {}, r = row || {};
  const name = (d && d.name) || r.n || sym;
  const sub = [r.m, r.sec || CLASS_NAME[r.a], info.ind, info.ex, r.cur].filter(Boolean).map(esc).join(" · ");
  const model = [...F.model][0];

  view.innerHTML = `
    ${assetHeader(sym, name, sub, "financials")}
    <div class="grid g6">
      ${kpi("Last", num(r.px, r.px >= 1000 ? 0 : 2), `${signed(r.r1d, 2)} 1D · ${esc(r.cur || "")}`)}
      ${kpi("Market cap", ok(r.cap) ? money(r.cap * 1e9) : "–")}
      ${kpi("Signal", `<span class="sig-${esc(r.sig)}">${SIGNAL[r.sig] || "–"}</span>`, ok(r.sc) ? `composite ${num(r.sc, 0)}/100` : "")}
      ${kpi("Year to date", signed(r.ytd, 1))}
      ${kpi("Momentum 12-1", pct(r.m121, 0))}
      ${kpi("Volatility (1y)", pct(info.vol, 0, false))}
    </div>
    <h2>Fundamentals</h2>${fundamentalsHtml(r, info)}
    <div class="grid g2">
      <div><h2>Analyst consensus</h2>${analystHtml(r, info)}<div id="fh-reco"></div></div>
      <div><h2>Peers</h2><div id="peers"><div class="loading">Loading peers…</div></div></div>
    </div>
    <h2>Financial statements</h2><div id="statements"></div>
    <h2>Factor model</h2>
    <div class="controls" style="margin-top:0"><div class="control"><span class="label" title="${esc(MODEL_HELP)}">Model ⓘ</span>
      ${chips("model", [["FF3", "FF3"], ["Carhart", "Carhart"], ["FF5", "FF5"]], F.model, false)}</div></div>
    <div id="ff"><div class="loading">Running the regression…</div></div>
    <details${deep ? " open" : ""}><summary>Watchlist research: factor exposures, composite scores and strategy backtests</summary><div id="wl-research"></div></details>`;
  bindAssetHeader(view, sym, "financials");
  bindChips(view, "model", F.model, false, () => viewFinancials(view, sym));

  peersHtml(sym, r).then((h) => { const el = $("#peers"); if (el) el.innerHTML = h; });
  // Financial statements: SEC filings for the deep tier, Finnhub's reported statements otherwise.
  const st = $("#statements");
  if (d && d.fin) {
    st.innerHTML = secHtml(d);
    drawSecCharts(d.fin);
  } else if (usTicker(sym) && FH.key()) {
    st.innerHTML = '<div class="loading">Loading reported statements from Finnhub…</div>';
    finnhubStatements(sym).then((h) => { st.innerHTML = h; }).catch((e) => { st.innerHTML = `<div class="note">${esc(e.message)}</div>`; });
  } else {
    const yahooFin = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/financials`;
    st.innerHTML = `<div class="note">Full statements are stored for the deep-tier names (SEC 10-K / 10-Q).
      ${usTicker(sym) ? "For this US-listed company, add a free Finnhub key in ⚙ settings to load its reported income statement, balance sheet and cash flow here, or open " : "Open "}
      ${link(yahooFin, "Yahoo Finance's financials")}${usTicker(sym) ? ` or ${link(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(sym)}&type=10-K`, "SEC EDGAR")}` : ""}.</div>`;
  }
  if (usTicker(sym) && FH.key()) finnhubReco(sym).then((h) => { const el = $("#fh-reco"); if (el) el.innerHTML = h; }).catch(() => {});
  drawFactorModel(sym, r, model).catch((e) => { const el = $("#ff"); if (el) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  $("#wl-research").innerHTML = watchlistResearchHtml(research, model);
}

function fundamentalsHtml(r, i) {
  const pctPoints = (x) => (ok(x) ? num(x, 2) + "%" : "–");  // Yahoo reports dividend yield in percent
  if (r.a === "c") return `<div class="grid g4">${kpi("Market cap", ok(r.cap) ? money(r.cap * 1e9) : "–")}${kpi("Market-cap rank", i.rank ? "#" + i.rank : "–")}
    ${kpi("Max drawdown (1y)", pct(i.mdd, 0))}${kpi("Avg daily volume", money(i.adv))}</div>
    <p class="caption">Coins have no financial statements. Ranks and caps from CoinGecko.</p>`;
  if (r.a === "i") return '<div class="empty">Indices have no fundamentals.</div>';
  if (r.a === "e") return `<div class="grid g4">${kpi("Expense ratio", ok(i.er) ? num(i.er, 2) + "%" : "–")}${kpi("Assets (AUM)", money(i.aum))}
    ${kpi("Category", esc(i.cat || "–"))}${kpi("Dividend yield", pctPoints(i.dy ?? r.dy))}</div>`;
  return `<div class="grid g5">
    ${kpi("Forward P/E", num(i.fpe ?? r.fpe, 1))}${kpi("Trailing P/E", num(i.tpe, 1))}${kpi("Price / book", num(i.pb, 2))}
    ${kpi("EV / EBITDA", num(i.eve, 1))}${kpi("Dividend yield", pctPoints(i.dy ?? r.dy))}
    ${kpi("Return on equity", pct(i.roe ?? r.roe, 1, false))}${kpi("Profit margin", pct(i.pm, 1, false))}${kpi("Revenue growth", pct(i.rg, 1))}
    ${kpi("Earnings growth", pct(i.eg, 1))}${kpi("Debt / equity", ok(i.de) ? num(i.de / 100, 2) : "–", "", "Yahoo reports debt/equity in percent; shown here as a ratio")}
  </div><p class="caption">From Yahoo Finance's quote summary, refreshed on a rolling basis (a few days old at most once the backlog clears). Blank tiles: not reported yet.</p>`;
}

function analystHtml(r, i) {
  const rating = i.ar;
  if (!ok(rating)) return '<div class="empty">No analyst consensus reported.</div>';
  const posPct = ((rating - 1) / 4) * 100;
  return `<div class="card"><div class="kpi"><div class="label">Consensus (1 = strong buy … 5 = strong sell)</div>
      <div class="value">${num(rating, 1)} · ${esc(i.al || r.lab || "")}</div></div>
    <div class="gauge"><div class="needle" style="left:${posPct}%"></div></div>
    <div class="gauge-labels"><span>Strong buy</span><span>Buy</span><span>Hold</span><span>Sell</span><span>Strong sell</span></div>
    <p class="caption">Mean of the analysts covering it, via Yahoo Finance. The Analysts pillar (${ok(r.an) ? num(r.an, 0) + "th percentile" : "–"}) ranks this against peers.</p></div>`;
}

async function peersHtml(sym, r) {
  if (!r.a || r.a === "i") return '<div class="empty">No peer group.</div>';
  const rows = await screenerRows();
  const peers = rows.filter((x) => x.a === r.a && x.m === r.m && (r.a !== "s" || x.sec === r.sec) && ok(x.cap))
    .sort((a, b) => b.cap - a.cap);
  const top = peers.slice(0, 12);
  if (!top.some((x) => x.s === sym)) top.push(r);
  const med = (k) => { const v = peers.map((x) => x[k]).filter(ok).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  return table([
    { h: "Symbol", f: (x) => routeLink("financials", x.s) }, { h: "Name", cls: "clip", f: (x) => esc(x.n || "") },
    { h: "Mkt cap $B", r: 1, f: (x) => num(x.cap, x.cap >= 100 ? 0 : 1) }, { h: "Fwd P/E", r: 1, f: (x) => num(x.fpe, 1) },
    { h: "ROE", r: 1, f: (x) => pct(x.roe, 0, false) }, { h: "YTD", r: 1, f: (x) => signed(x.ytd, 0) }, { h: "Score", f: (x) => bar(x.sc) },
  ], top, { rowClass: (x) => (x.s === sym ? "me" : "") }) +
    `<p class="caption">${peers.length} peers in ${esc(r.m)}${r.a === "s" ? " · " + esc(r.sec || "") : ""}, largest first. Peer medians: forward P/E ${num(med("fpe"), 1)}, ROE ${pct(med("roe"), 0, false)}, YTD ${pct(med("ytd"), 0)}.</p>`;
}

function secHtml(d) {
  const fin = d.fin, t = fin.ttm, gr = fin.growth || {};
  return `
    <p class="caption">SEC filings · latest: ${link(fin.latest.url, `${fin.latest.form} for the period ended ${fin.latest.period}`)}, filed ${esc(fin.latest.filed)}
      · CIK ${esc(d.cik || "–")}. Trailing-twelve-month figures use ${esc(fin.basis || "n/a")} (Q4 = annual − Q1–Q3).</p>
    <div class="grid g6">
      ${kpi("Revenue (TTM)", money(t.revenue), ok(gr.revenue_yoy) ? `${signed(gr.revenue_yoy, 0)} y/y latest qtr` : "")}
      ${kpi("Net income (TTM)", money(t.net_income), ok(gr.net_income_yoy) ? `${signed(gr.net_income_yoy, 0)} y/y latest qtr` : "")}
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
function drawSecCharts(fin) {
  const c = pal(), q = fin.quarters;
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

async function finnhubStatements(sym) {
  const res = await FH.get("stock/financials-reported", { symbol: sym, freq: "annual" });
  const reports = (res.data || []).filter((x) => x.report).sort((a, b) => b.year - a.year).slice(0, 4);
  if (!reports.length) return `<div class="empty">Finnhub has no reported statements for ${esc(sym)}.</div>`;
  const section = (key, title) => {
    const base = reports[0].report[key] || [];
    if (!base.length) return "";
    const years = reports.map((r) => r.year);
    const rows = base.slice(0, 40).map((line) => ({ label: line.label || line.concept, unit: line.unit || "",
      vals: reports.map((r) => ((r.report[key] || []).find((x) => x.concept === line.concept) || {}).value) }));
    const fmt = (v, unit) => (!ok(v) ? "–" : /share/i.test(unit) ? num(v, 2) : money(v));
    return `<h3 style="margin-top:18px">${title}</h3>` + table([{ h: "Line item", cls: "wrap-text", f: (x) => esc(x.label) },
      ...years.map((y, k) => ({ h: `FY${y}`, r: 1, f: (x) => fmt(x.vals[k], x.unit) }))], rows, { tall: true });
  };
  return `<p class="caption">As reported to the SEC (via Finnhub, annual filings ${esc(reports[reports.length - 1].year)}–${esc(reports[0].year)}).
    ${link(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(sym)}&type=10-K`, "Filings on SEC EDGAR")}</p>`
    + section("ic", "Income statement") + section("bs", "Balance sheet") + section("cf", "Cash flow");
}
async function finnhubReco(sym) {
  const reco = (await FH.get("stock/recommendation", { symbol: sym })) || [];
  if (!reco.length) return "";
  const rows = [...reco].sort((a, b) => (a.period < b.period ? -1 : 1)).slice(-6);
  setTimeout(() => {
    const c = pal(), x = rows.map((r) => r.period.slice(0, 7));
    const parts = [["strongBuy", "Strong buy", c.good], ["buy", "Buy", "#8bc34a"], ["hold", "Hold", c.muted], ["sell", "Sell", "#f0a23b"], ["strongSell", "Strong sell", c.bad]];
    plot($("#reco-chart"), parts.map(([k, name, color]) => ({ type: "bar", x, y: rows.map((r) => r[k] || 0), name, marker: { color } })),
      layout(260, { barmode: "stack", hovermode: "x unified" }));
  });
  return `<div class="chart-title">Recommendation trends (Finnhub)</div><div class="chart" id="reco-chart"></div>`;
}

let factorData = null;
async function drawFactorModel(sym, r, model) {
  const el = $("#ff");
  if (!el) return;
  if (r.a === "c" || r.a === "i") { el.innerHTML = '<div class="empty">Factor models describe stock returns; they are not estimated for coins and indices.</div>'; return; }
  const [hist, factors] = [await priceHistory(sym), factorData || (factorData = await load("factors.json"))];
  if (!hist) { el.innerHTML = '<div class="empty">No price history for this symbol.</div>'; return; }
  const stock = { dates: hist.dates, returns: Q.returns(hist.values) };
  const e = Q.factorRegression(stock, factors, model);
  const roll = Q.rollingExposures(stock, factors, model, { window: Math.min(Q.TD, Math.floor(e.n_obs / 2)) });
  const cols = Q.MODELS[model];
  const nonUS = r.m && !["US", "US ETFs"].includes(r.m);
  el.innerHTML = `
    <p class="caption">Daily excess returns on the ${esc(model)} factors from Kenneth French's library, ${esc(e.start)} to ${esc(e.end)} (${e.n_obs} days;
      the library lags 1-2 months${hist.source === "universe" ? "; about two years of history for names outside the deep tier" : ""}). Newey-West (5-lag) t-statistics, computed in your browser with
      the same method as the Python models. |t| ≥ 2 is significant.</p>
    ${nonUS ? '<div class="note">These are US factors. For a non-US stock the loadings mix in currency and local-market effects, and markets that close before New York opens show muted same-day betas, so read them as approximate.</div>' : ""}
    <div class="grid g6">${kpi("Alpha / year", pct(e.alpha_annual), `t = ${num(e.alpha_t, 1)}${Math.abs(e.alpha_t) >= 2 ? " · significant" : ""}`, "Return not explained by the factors")}
      ${cols.map((f) => kpi(FACTOR[f], num(e.betas[f], 2), `t = ${num(e.t_stats[f], 1)}${Math.abs(e.t_stats[f]) >= 2 ? " · significant" : ""}`)).join("")}
      ${kpi("R²", num(e.r_squared, 2), `driven by ${esc(e.dominant_driver)}`)}</div>
    ${e.tilts.length ? `<p><b>Reading:</b> ${esc(e.tilts.join(", "))}.</p>` : ""}
    <div class="grid g2">
      <div><div class="chart-title">Factor loadings with 95% confidence intervals</div><div class="chart" id="f-coef"></div></div>
      <div><div class="chart-title">Where the annual return came from</div><div class="chart" id="f-waterfall"></div>
        <p class="caption">Annualised: risk-free rate + β × each factor's average premium + alpha.</p></div>
    </div>
    <div class="chart-title">Rolling betas (${roll.d.length ? Math.min(Q.TD, Math.floor(e.n_obs / 2)) : 0}-day window, monthly steps)</div><div class="chart" id="f-rolling"></div>`;
  const c = pal();
  const labels = cols.map((f) => FACTOR[f]);
  plot($("#f-coef"), [{ type: "scatter", mode: "markers", y: labels, x: cols.map((f) => e.betas[f]), name: "β",
    marker: { size: 11, color: cols.map((f) => (Math.abs(e.t_stats[f]) >= 2 ? c.up : c.muted)) },
    error_x: { type: "data", array: cols.map((f) => 1.96 * e.se[f]), color: c.ink2, thickness: 1.5, width: 6 },
    customdata: cols.map((f) => [e.t_stats[f], 1.96 * e.se[f]]), hovertemplate: "%{y}: %{x:.2f} ± %{customdata[1]:.2f} (t = %{customdata[0]:.1f})<extra></extra>" }],
  layout(300, { showlegend: false, hovermode: "closest", margin: { l: 8, r: 24, t: 16, b: 28 }, yaxis: yaxis({ autorange: "reversed", showgrid: false }),
    shapes: [0, 1].map((x0) => ({ type: "line", xref: "x", x0, x1: x0, yref: "paper", y0: 0, y1: 1, line: { color: x0 ? c.grid : c.axis, width: 1, dash: x0 ? "dot" : "solid" } })) }));
  const attr = e.return_attribution;
  const steps = [["Risk-free", attr.risk_free], ...cols.map((f) => [FACTOR[f].split(" ")[0], attr[f]]), ["Alpha", attr.alpha]];
  const total = steps.reduce((s, [, v]) => s + (v || 0), 0);
  plot($("#f-waterfall"), [{ type: "waterfall", x: [...steps.map((s) => s[0]), "Total"], y: [...steps.map((s) => s[1]), total],
    measure: [...steps.map(() => "relative"), "total"], increasing: { marker: { color: c.up } }, decreasing: { marker: { color: c.down } },
    totals: { marker: { color: c.ink2 } }, connector: { line: { color: c.axis, width: 1 } }, texttemplate: "%{y:+.1%}", textposition: "outside", cliponaxis: false,
    hovertemplate: "%{x}: %{y:+.2%}<extra></extra>" }], layout(300, { showlegend: false, hovermode: "closest", margin: { l: 8, r: 24, t: 24, b: 28 }, yaxis: yaxis({ tickformat: ".0%" }) }));
  plot($("#f-rolling"), cols.map((f, i) => ({ x: roll.d, y: roll[f], name: FACTOR[f], line: { color: c.series[i], width: 2 }, hovertemplate: "%{y:.2f}" })),
    layout(320, { xaxis: dateAxis(), shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: c.axis, width: 1 } }] }));
}

function watchlistResearchHtml(research, model) {
  const exps = research.exposures[model] || [];
  const cols = Q.MODELS[model];
  return `<h3 style="margin-top:12px">Deep-tier factor exposures (${esc(model)}, Python)</h3>${table([
      { h: "Ticker", f: (x) => routeLink("financials", x.ticker) },
      { h: "Alpha/yr", r: 1, f: (x) => pct(x.alpha_annual) }, { h: "Alpha t", r: 1, f: (x) => num(x.alpha_t, 1) },
      ...cols.map((f) => ({ h: FACTOR[f], r: 1, f: (x) => num(x.betas[f], 2) })),
      { h: "R²", r: 1, f: (x) => num(x.r_squared, 2) },
      { h: "Stock-specific variance", f: (x) => bar(100 * (x.variance_share?.idiosyncratic ?? NaN)) },
      { h: "Tilts", cls: "wrap-text", f: (x) => esc((x.tilts || []).join(", ")) },
    ], exps)}
    <h3 style="margin-top:18px">Composite factor scores</h3>
    <p class="caption">Each metric is ranked across the deep tier (0 = worst, 100 = best) and averaged into pillars: Value (E/P, FCF/P, B/M, S/P),
      Quality (ROE, cash ROA, low leverage, low accruals), Momentum (12-1, 6-1).</p>
    ${table([
      { h: "Rank", r: 1, f: (s) => esc(s.rank ?? "–") }, { h: "Ticker", f: (s) => routeLink("financials", s.ticker) },
      { h: "Composite", f: (s) => bar(s.composite) }, { h: "Value", f: (s) => bar(s.value) }, { h: "Quality", f: (s) => bar(s.quality) },
      { h: "Momentum", f: (s) => bar(s.momentum) }, { h: "E/P", r: 1, f: (s) => pct(s.ep, 1, false) }, { h: "FCF/P", r: 1, f: (s) => pct(s.fcfp, 1, false) },
      { h: "B/M", r: 1, f: (s) => num(s.bm, 2) }, { h: "ROE", r: 1, f: (s) => pct(s.roe, 0, false) }, { h: "D/E", r: 1, f: (s) => num(s.de, 2) },
      { h: "Mom 12-1", r: 1, f: (s) => pct(s.m121, 0) },
    ], research.scores)}
    <h3 style="margin-top:18px">Academic strategy backtests</h3>${table([
      { h: "Strategy", f: (s) => esc(s.strategy) }, { h: "Paper", cls: "clip", f: (s) => esc(s.paper) },
      { h: "CAGR", r: 1, f: (s) => pct(s.cagr, 1, false) }, { h: "Vol", r: 1, f: (s) => pct(s.vol, 1, false) },
      { h: "Sharpe", r: 1, f: (s) => num(s.sharpe, 2) }, { h: "Max drawdown", r: 1, f: (s) => pct(s.mdd, 1, false) },
      { h: "Turnover/yr", r: 1, f: (s) => num(s.turnover, 1) + "x" }, { h: "Carhart alpha", r: 1, f: (s) => pct(s.alpha) },
      { h: "Alpha t", r: 1, f: (s) => num(s.alpha_t, 1) },
    ], research.strategies)}<p class="caption">${esc(research.note)} Net of 5 bps per unit of turnover.</p>`;
}

// ====================================================================================================
// Paper-trading bot: portfolios with an institutional risk dashboard, plus the strategy lab
// ====================================================================================================
const B = { side: new Set(), reason: new Set(), ticker: "" };

function rfFor(dates, factors) {
  // Daily T-bill rate per date; after the factor library's last date, carry the last known rate.
  const m = new Map(factors.d.map((d, i) => [d, factors.rf[i]]));
  let last = 0;
  const firstF = factors.d[0];
  return dates.map((d) => { if (m.has(d) && ok(m.get(d))) last = m.get(d); return d < firstF ? 0 : last; });
}

function metricsGrid(mt, { benchName = "S&P 500" } = {}) {
  const enough = mt.n >= 60;
  const v = (x, f) => (enough ? f(x) : "–");
  return `<div class="grid g6">
    ${kpi("Total return", signed(mt.total, 1), `${esc(mt.start)} → ${esc(mt.end)}`)}
    ${kpi("CAGR", v(mt.cagr, (x) => pct(x, 1)))}
    ${kpi("Volatility", v(mt.vol, (x) => pct(x, 1, false)), "annualised")}
    ${kpi("Sharpe ratio", v(mt.sharpe, (x) => num(x, 2)), "excess over T-bills", "Mean daily excess return ÷ its standard deviation × √252")}
    ${kpi("Sortino ratio", v(mt.sortino, (x) => num(x, 2)), "downside risk only")}
    ${kpi("Max drawdown", pct(mt.mdd, 1), mt.mdd < 0 ? `${esc(mt.mdd_from)} → ${esc(mt.mdd_to)}` : "")}
    ${kpi("Calmar ratio", v(mt.calmar, (x) => num(x, 2)), "CAGR ÷ max drawdown")}
    ${kpi(`Alpha vs ${benchName}`, v(mt.alpha, (x) => pct(x, 1)), ok(mt.alpha_t) && enough ? `t = ${num(mt.alpha_t, 1)}, annualised` : "", "Intercept of daily excess returns regressed on the benchmark's (Newey-West t)")}
    ${kpi("Beta", v(mt.beta, (x) => num(x, 2)), ok(mt.information_ratio) && enough ? `information ratio ${num(mt.information_ratio, 2)}` : "")}
    ${kpi("Win rate", pct(mt.win_rate, 0, false), `${mt.trades} closed trades`)}
    ${kpi("Win/loss ratio", num(mt.win_loss_ratio, 2), ok(mt.avg_win) ? `avg win ${pct(mt.avg_win, 1)} · loss ${pct(mt.avg_loss, 1)}` : "", "Average winning trade ÷ average losing trade")}
    ${kpi("Profit factor", num(mt.profit_factor, 2), ok(mt.expectancy) ? `expectancy ${pct(mt.expectancy, 2)}/trade` : "", "Sum of winning trade returns ÷ sum of losing ones")}
  </div>${enough ? "" : '<p class="caption">Ratios need at least 60 sessions of history; this portfolio has fewer.</p>'}`;
}

async function viewBot(view, arg) {
  if (arg === "lab") return viewLab(view);
  const [data, factors] = [await load("bot.json"), factorData || (factorData = await load("factors.json"))];
  const names = Object.keys(data.portfolios);
  const label = { paper: "Paper (live)", backtest: "Backtest 2018-" };
  const tabs = (current) => `<div class="controls"><div class="control"><span class="label">Portfolio</span><div class="chips">${[...names, "lab"].map((n) =>
    `<a class="chip${n === current ? " on" : ""}" href="#/bot/${esc(n)}">${esc(label[n] || (n === "lab" ? "Strategy lab" : n))}</a>`).join("")}</div></div></div>`;
  if (!names.length) { view.innerHTML = `<h1>Paper-trading bot</h1>${tabs("")}<div class="empty">No portfolio yet.</div>`; return; }
  const name = names.includes(arg) ? arg : names.includes("paper") ? "paper" : names[0];
  const p = data.portfolios[name], info = p.info, params = p.params || {};
  const equity = p.equity, ret = equity / info.initial_cash - 1;
  let spyRet = null;
  if (p.curve && p.curve.spy.length > 1) {
    const s = p.curve.spy.filter(ok);
    spyRet = s.length > 1 ? s[s.length - 1] / s[0] - 1 : null;
  }
  const closed = p.trades.filter((t) => ok(t.ret)).map((t) => t.ret);
  const wins = closed.filter((r) => r > 0), losses = closed.filter((r) => r <= 0);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pos = p.positions.map((x) => Object.assign({}, x, { value: x.shares * x.last }));
  let mt = null;
  if (p.curve && p.curve.d.length >= 2) {
    const rets = Q.returns(p.curve.equity), bench = Q.returns(p.curve.spy);
    mt = Q.metrics({ dates: p.curve.d.slice(1), rets: rets.slice(1), bench: bench.slice(1), rf: rfFor(p.curve.d, factors).slice(1),
      trades: p.trades.filter((t) => ok(t.ret)).map((t) => ({ ret: t.ret, days: NaN })) });
  }

  view.innerHTML = `
    <h1>Paper-trading bot</h1>
    ${tabs(name)}
    <div class="grid g6">
      ${kpi("Equity", money(equity), `started with ${money(info.initial_cash)}`)}
      ${kpi("Total return", signed(ret, 2), spyRet === null ? "" : `SPY ${pct(spyRet, 2)} same period`)}
      ${kpi("Cash", pct(info.cash / equity, 0, false))}
      ${kpi("Open positions", String(pos.length), `max ${esc(params.max_positions ?? "?")} names, ${pct(params.max_weight, 0, false)} each`)}
      ${kpi("Closed trades", String(closed.length), `${p.trades.length} fills in total`)}
      ${kpi("Win rate", closed.length ? pct(wins.length / closed.length, 0, false) : "–", wins.length && losses.length ? `payoff ${(avg(wins) / Math.abs(avg(losses))).toFixed(2)}` : "", "Payoff = average win / average loss")}
    </div>
    <p class="caption">Last session processed: ${esc(info.last_run_date || "–")} · sizing: ${esc(params.sizing || "vol_parity")} · stops ${esc(params.atr_multiple ?? "?")}x ATR,
      max loss ${pct(params.max_loss, 0, false)} · market-on-close fills with 5 bps slippage. Paper trading, not investment advice.</p>
    <h2>Risk and performance</h2>
    ${mt ? metricsGrid(mt, { benchName: "SPY" }) : '<div class="empty">Needs at least two sessions.</div>'}
    <h2>Equity vs SPY</h2>
    ${p.curve && p.curve.d.length >= 2 ? '<div class="chart" id="b-equity"></div>' : `<div class="empty">The equity curve appears after the bot has processed a second session (so far: ${p.curve ? p.curve.d.length : 0}).</div>`}
    <h2>Open positions</h2>
    ${table([
      { h: "Ticker", f: (x) => routeLink("stock", x.ticker) }, { h: "Shares", r: 1, f: (x) => num(x.shares, 0) },
      { h: "Avg cost", r: 1, f: (x) => num(x.avg_cost, 2) }, { h: "Last", r: 1, f: (x) => num(x.last, 2) },
      { h: "Value", r: 1, f: (x) => money(x.value) }, { h: "Weight", f: (x) => bar(100 * x.value / equity, 100 * (params.max_weight || 0.2)) },
      { h: "P&L ($)", r: 1, f: (x) => `<span class="${tone(x.last - x.avg_cost)}">${num((x.last - x.avg_cost) * x.shares, 0, true)}</span>` },
      { h: "P&L %", r: 1, f: (x) => signed(x.last / x.avg_cost - 1, 1) },
      { h: "Stop", r: 1, f: (x) => num(x.stop, 2) }, { h: "To stop", r: 1, f: (x) => pct(x.stop / x.last - 1) },
      { h: "Since", f: (x) => esc(x.since) },
    ], pos.sort((a, b) => b.value - a.value), { empty: "No open positions." })}
    <h2>Latest signals</h2>
    ${p.signals.length ? `<p class="caption">Signals for ${esc(p.signals[0].date)}: each bar is a component's weighted contribution; the black tick is the total score.
      BUY needs score ≥ the buy line and an up-trend.</p><div class="chart" id="b-signals"></div>${table([
      { h: "Ticker", f: (s) => routeLink("stock", s.ticker) }, { h: "Action", f: (s) => `<span class="sig-${s.action === "SELL" ? "AVOID" : s.action}">${esc(s.action)}</span>` },
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
      { h: "Reason", f: (t) => esc(t.reason) }, { h: "Round-trip return", r: 1, f: (t) => signed(t.ret, 1) },
      { h: "Rationale", cls: "wrap-text", f: (t) => esc(t.rationale) },
    ], ledgerRows(), { tall: true, empty: "No trades match." });
  };
  $("#b-ticker").addEventListener("change", (e) => { B.ticker = e.target.value; drawLedger(); });
  bindChips(view, "side", B.side, true, drawLedger);
  bindChips(view, "reason", B.reason, true, drawLedger);
  $("#b-csv").addEventListener("click", () => downloadCsv(`${name}_ledger.csv`, ["date", "side", "ticker", "shares", "price", "value", "reason", "ret", "rationale"], ledgerRows()));
  drawLedger();

  if (p.curve && p.curve.d.length >= 2) {
    const eq = p.curve.equity, spy = p.curve.spy, x = p.curve.d;
    const firstSpy = spy.find(ok);
    const dd = Q.drawdowns(eq).dd;
    plot($("#b-equity"), [
      { x, y: eq.map((v) => (100 * v) / eq[0]), name: "Bot", line: { color: c.series[0], width: 2 }, hovertemplate: "%{y:.1f}" },
      { x, y: spy.map((v) => (ok(v) ? (100 * v) / firstSpy : null)), name: "SPY", line: { color: c.series[1], width: 2 }, hovertemplate: "%{y:.1f}" },
      { x, y: dd, name: "Bot drawdown", yaxis: "y2", fill: "tozeroy", showlegend: false, line: { color: c.series[0], width: 1 }, hovertemplate: "%{y:.1%}" },
    ], layout(460, {
      xaxis: dateAxis(),
      yaxis: yaxis({ domain: [0.32, 1], title: { text: "Growth of 100", font: { size: 11 } } }),
      yaxis2: yaxis({ domain: [0, 0.26], tickformat: Math.min(...dd) > -0.05 ? ".1%" : ".0%", title: { text: "Drawdown", font: { size: 11 } } }),
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
      annotations: lines.map(([xv, text]) => ({ x: xv, y: 1, xref: "x", yref: "paper", text, showarrow: false, yanchor: "top", xanchor: "left", xshift: 4, font: { color: c.muted, size: 11 } })) }));
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

function downloadCsv(filename, cols, rows) {
  const quote = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(","), ...rows.map((t) => cols.map((k) => quote(t[k])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Strategy lab ---------------------------------------------------------------------------------
const L = { symbols: null, strategy: "momentum", params: {}, cost: 5 };

async function viewLab(view) {
  const meta = await load("meta.json");
  if (!L.symbols) L.symbols = store.get("labSymbols", meta.deep.map((t) => t.ticker));
  const strat = Q.STRATEGIES.find((s) => s.id === L.strategy) || Q.STRATEGIES[0];
  const p = Object.assign(Object.fromEntries(strat.params.map((x) => [x.key, x.def])), L.params[strat.id] || {});
  const label = { paper: "Paper (live)", backtest: "Backtest 2018-" };
  const names = Object.keys((await load("bot.json")).portfolios);
  view.innerHTML = `
    <h1>Paper-trading bot</h1>
    <div class="controls"><div class="control"><span class="label">Portfolio</span><div class="chips">${[...names, "lab"].map((n) =>
      `<a class="chip${n === "lab" ? " on" : ""}" href="#/bot/${esc(n)}">${esc(label[n] || (n === "lab" ? "Strategy lab" : n))}</a>`).join("")}</div></div></div>
    <h2 style="margin-top:8px">Strategy lab</h2>
    <p class="soft">Backtest classic quant strategies on any assets, in your browser. Signals use only data up to each day's close and trade
      on the next day's return; costs are charged on every change in weights, and idle cash earns the T-bill rate.</p>
    <div class="lab-grid">
      <div class="card">
        <h3>Assets</h3>
        <div class="asset-chips" id="lab-assets"></div>
        <div id="lab-add" style="max-width:360px">${searchBox("Add a stock, ETF, coin or index")}</div>
        <div class="row"><button class="btn" id="lab-watch" type="button">Use my watchlist</button><button class="btn" id="lab-deep" type="button">Use the 10 deep-tier stocks</button></div>
        <p class="caption">Deep-tier names have 10 years of history, everything else about two years. The test uses the dates all selected assets share.</p>
      </div>
      <div class="card">
        <h3>Strategy</h3>
        <select id="lab-strategy" style="width:100%">${Q.STRATEGIES.map((s) => `<option value="${s.id}"${s.id === strat.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        <p class="caption">${esc(strat.blurb)}</p>
        <div class="params" id="lab-params">${strat.params.map((x) => x.type === "bool"
          ? `<label class="toggle"><input type="checkbox" data-p="${x.key}"${p[x.key] ? " checked" : ""}> ${esc(x.label)}</label>`
          : `<label>${esc(x.label)}<input type="number" data-p="${x.key}" value="${p[x.key]}" min="${x.min}" max="${x.max}" step="${x.step}"></label>`).join("")}
          <label>Trading cost (bps per unit of turnover)<input type="number" id="lab-cost" value="${L.cost}" min="0" max="200" step="1"></label>
        </div>
        <div class="row"><button class="btn primary" id="lab-run" type="button">Run backtest</button><span class="caption" id="lab-msg"></span></div>
      </div>
    </div>
    <div id="lab-out"></div>`;

  const drawAssets = () => {
    $("#lab-assets").innerHTML = L.symbols.map((s) => `<span class="chip">${esc(s)}<button type="button" data-rm="${esc(s)}" aria-label="Remove ${esc(s)}">✕</button></span>`).join("")
      || '<span class="caption">No assets yet.</span>';
    view.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { L.symbols = L.symbols.filter((s) => s !== b.dataset.rm); store.set("labSymbols", L.symbols); drawAssets(); }));
  };
  drawAssets();
  bindSearch($("#lab-add", view), async (sym) => {
    if (!(await rowFor(sym)) && !(await isDeep(sym))) { $("#lab-msg").textContent = `${sym} isn't in the universe.`; return; }
    if (!L.symbols.includes(sym)) L.symbols.push(sym);
    store.set("labSymbols", L.symbols); drawAssets();
  });
  $("#lab-watch").addEventListener("click", async () => { L.symbols = [...(await watchlist())]; store.set("labSymbols", L.symbols); drawAssets(); });
  $("#lab-deep").addEventListener("click", () => { L.symbols = meta.deep.map((t) => t.ticker); store.set("labSymbols", L.symbols); drawAssets(); });
  $("#lab-strategy").addEventListener("change", (e) => { L.strategy = e.target.value; viewLab(view); });
  const readParams = () => {
    const out = {};
    view.querySelectorAll("[data-p]").forEach((el) => { out[el.dataset.p] = el.type === "checkbox" ? el.checked : Number(el.value); });
    L.params[strat.id] = out; L.cost = Number($("#lab-cost").value) || 0;
    return out;
  };
  $("#lab-run").addEventListener("click", async () => {
    const msg = $("#lab-msg");
    try {
      msg.textContent = "Loading prices…";
      await runLab(strat, readParams());
      msg.textContent = "";
    } catch (e) { console.error(e); msg.textContent = e.message; }
  });
}

async function runLab(strat, params) {
  const syms = L.symbols.slice(0, strat.maxAssets || 50);
  if (syms.length < strat.minAssets) throw new Error(`${strat.name} needs at least ${strat.minAssets} asset${strat.minAssets > 1 ? "s" : ""}.`);
  const hist = await Promise.all(syms.map(async (s) => [s, await priceHistory(s)]));
  const missing = hist.filter(([, h]) => !h).map(([s]) => s);
  if (missing.length) throw new Error(`No price history for ${missing.join(", ")}.`);
  const [market, factors] = [await load("market.json"), factorData || (factorData = await load("factors.json"))];
  const al = Q.align([...hist.map(([, h]) => ({ dates: h.dates, values: h.values })), { dates: market.spx.d, values: market.spx.c }]);
  if (al.dates.length < 60) throw new Error(`Only ${al.dates.length} shared trading days; pick assets with overlapping history.`);
  const P = al.dates.map((_, t) => syms.map((_, i) => al.values[i][t]));
  const spx = al.values[syms.length];
  const rf = rfFor(al.dates, factors);
  const res = Q.backtest({ dates: al.dates, symbols: syms, P, strategy: strat, params, costBps: L.cost, rf });
  const bh = Q.backtest({ dates: al.dates, symbols: syms, P, strategy: Q.STRATEGIES[0], params: {}, costBps: L.cost, rf });
  const bench = Q.returns(spx);
  const mt = Q.metrics({ dates: al.dates.slice(1), rets: res.rets.slice(1), bench: bench.slice(1), rf: rf.slice(1), trades: res.trades });
  const bhm = Q.metrics({ dates: al.dates.slice(1), rets: bh.rets.slice(1), bench: bench.slice(1), rf: rf.slice(1) });
  const months = Q.monthlyReturns(al.dates.slice(1), res.rets.slice(1));
  const out = $("#lab-out");
  const pairInfo = res.info && ok(res.info.adf_t) ? `
    <h2>Pair diagnostics</h2>
    <div class="grid g4">${kpi("Hedge ratio β", num(res.info.hedge_ratio, 3), "full-sample log-price regression")}
      ${kpi("Engle-Granger ADF t", num(res.info.adf_t, 2), res.info.adf_t < -3.37 ? '<span class="pos">below −3.37: cointegrated at 5%</span>' : '<span class="neg">above −3.37: no evidence of cointegration</span>', "ADF regression of the spread's daily change on its lagged level")}
      ${kpi("Half-life", ok(res.info.half_life) ? num(res.info.half_life, 1) + " days" : "∞", "of spread deviations")}
      ${kpi("Return correlation", num(res.info.correlation, 2))}</div>
    <div class="chart-title">Spread z-score</div><div class="chart" id="lab-z"></div>` : "";
  out.innerHTML = `
    <h2>Results · ${esc(strat.name)}</h2>
    <p class="caption">${esc(syms.join(", "))} · ${al.dates.length} shared sessions, ${esc(al.dates[0])} to ${esc(al.dates[al.dates.length - 1])} ·
      ${L.cost} bps costs · exposure ${pct(res.exposure, 0, false)} of days · turnover ${num(res.turnover_per_year, 1)}× a year.
      Equal-weight buy-and-hold of the same assets: CAGR ${pct(bhm.cagr, 1)}, Sharpe ${num(bhm.sharpe, 2)}, max drawdown ${pct(bhm.mdd, 1)}.</p>
    ${metricsGrid(mt)}
    <div class="chart-title">Growth of 100</div><div class="chart" id="lab-equity"></div>
    ${pairInfo}
    <div class="grid g2">
      <div><h2>Monthly returns</h2>${monthlyTable(months)}</div>
      <div><h2>Trades</h2>${table([
        { h: "Book", f: (t) => esc(t.book) }, { h: "Side", f: (t) => esc(t.side) }, { h: "Entry", f: (t) => esc(t.entry) },
        { h: "Exit", f: (t) => (t.open ? "open" : esc(t.exit)) }, { h: "Days", r: 1, f: (t) => t.days }, { h: "Return", r: 1, f: (t) => signed(t.ret, 1) },
      ], res.trades.slice(0, 300), { tall: true, empty: "No trades." })}
      <div class="row"><button class="btn" id="lab-csv" type="button">Download trades (CSV)</button></div></div>
    </div>
    <p class="note">Backtests on assets chosen today are survivorship-biased, and a strategy tuned on this window will look better here than it will
      going forward. See the README's point-in-time S&amp;P 500 results. Research only, not investment advice.</p>`;
  $("#lab-csv").addEventListener("click", () => downloadCsv(`${strat.id}_trades.csv`, ["book", "side", "entry", "exit", "days", "ret", "open"], res.trades));
  const c = pal(), x = al.dates.slice(1);
  const grow = (rets) => { let e = 100; return rets.slice(1).map((r) => (e *= 1 + r)); };
  const spxIdx = spx.slice(1).map((v) => (100 * v) / spx[0]);
  const dd = Q.drawdowns(mt.equity).dd;
  plot($("#lab-equity"), [
    { x, y: grow(res.rets), name: strat.name, line: { color: c.series[0], width: 2 }, hovertemplate: "%{y:.1f}" },
    { x, y: grow(bh.rets), name: "Equal-weight buy and hold", line: { color: c.series[2], width: 1.5 }, hovertemplate: "%{y:.1f}" },
    { x, y: spxIdx, name: "S&P 500 (price)", line: { color: c.series[1], width: 1.5 }, hovertemplate: "%{y:.1f}" },
    { x, y: dd, name: "Drawdown", yaxis: "y2", fill: "tozeroy", showlegend: false, line: { color: c.series[0], width: 1 }, hovertemplate: "%{y:.1%}" },
  ], layout(480, { xaxis: dateAxis(), yaxis: yaxis({ domain: [0.32, 1], type: "log", title: { text: "Growth of 100 (log)", font: { size: 11 } } }),
    yaxis2: yaxis({ domain: [0, 0.26], tickformat: ".0%", title: { text: "Drawdown", font: { size: 11 } } }) }));
  if (pairInfo) {
    const pz = params;
    plot($("#lab-z"), [{ x: al.dates, y: res.info.z, name: "z", line: { color: c.series[0], width: 1.5 }, hovertemplate: "%{y:.2f}" }],
      layout(280, { showlegend: false, xaxis: dateAxis(), shapes: [pz.entry, -pz.entry, pz.exit, -pz.exit, 0].map((y, k) => ({ type: "line", xref: "paper", x0: 0, x1: 1, y0: y, y1: y,
        line: { color: k < 2 ? c.bad : k < 4 ? c.muted : c.axis, width: 1, dash: k < 4 ? "dot" : "solid" } })) }));
  }
}

function monthlyTable(months) {
  const years = [...new Set(months.map((m) => m.month.slice(0, 4)))].sort().reverse();
  const by = new Map(months.map((m) => [m.month, m.ret]));
  const color = (r) => {
    if (!ok(r)) return "";
    const a = Math.min(1, Math.abs(r) / 0.1) * 0.55;
    return `background:${r >= 0 ? `rgba(42,120,214,${a})` : `rgba(227,73,72,${a})`}`;
  };
  const cols = [{ h: "Year", f: (y) => esc(y) }, ...Array.from({ length: 12 }, (_, k) => ({ h: "JFMAMJJASOND"[k], cls: "heat",
    f: (y) => pct(by.get(`${y}-${String(k + 1).padStart(2, "0")}`), 1), style: (y) => color(by.get(`${y}-${String(k + 1).padStart(2, "0")}`)) })),
    { h: "Year", cls: "heat", f: (y) => { const v = months.filter((m) => m.month.startsWith(y)).reduce((g, m) => g * (1 + m.ret), 1) - 1; return `<b>${pct(v, 1)}</b>`; } }];
  return table(cols, years);
}

// ====================================================================================================
// Router and shell
// ====================================================================================================
const ROUTES = { global: viewGlobal, markets: viewMarkets, stock: viewStock, financials: viewFinancials, bot: viewBot,
  live: (view, arg) => (window.LIVE ? window.LIVE.view(view, arg) : (view.innerHTML = '<div class="empty">Live charts failed to load.</div>')) };
let cleanup = null;
window.onRouteCleanup = (fn) => { cleanup = fn; };

async function render() {
  const [, name = "global", ...rest] = location.hash.replace(/^#/, "").split("/");
  const arg = rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  const route = ROUTES[name] ? name : "global";
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  closeDrawer();
  document.querySelectorAll("nav.tabs a[data-route]").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  const view = $("#view");
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await ROUTES[route](view, arg);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<h1>Data not available</h1><p class="soft">This page couldn't load its data (${esc(e.message)}).
      The site is refreshed once a day; if this persists, the latest export may not have been published.</p>`;
  }
}

function settingsDialog() {
  const back = $("#settings-back"), input = $("#fh-key"), status = $("#fh-status");
  const open = () => { input.value = FH.key(); status.textContent = FH.key() ? "A key is saved in this browser." : "No key saved."; back.classList.add("open"); input.focus(); };
  const close = () => back.classList.remove("open");
  $("#settings").addEventListener("click", open);
  $("#settings-close").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  $("#fh-remove").addEventListener("click", () => { store.del("finnhubKey"); input.value = ""; status.textContent = "Key removed from this browser."; });
  $("#fh-save").addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) { status.textContent = "Paste a key first."; return; }
    store.set("finnhubKey", key);
    status.textContent = "Testing…";
    try {
      const q = await FH.get("quote", { symbol: "AAPL" });
      status.textContent = q && q.c ? `Works: AAPL ${q.c}. Saved in this browser.` : "Saved, but the test quote came back empty.";
    } catch (e) { status.textContent = `${e.message}. The key is saved; remove it if it's wrong.`; }
  });
}

async function shell() {
  try {
    const meta = await load("meta.json");
    const updated = new Date(meta.generated_at);
    $("#asof").textContent = `Prices ${meta.prices_as_of} · updated ${updated.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  } catch (e) { /* the page shows its own error */ }
  $("#hsearch").innerHTML = searchBox("Search ticker or company");
  bindSearch($("#hsearch"), (sym) => { location.hash = `#/stock/${encodeURIComponent(sym)}`; });
  settingsDialog();
  $("#theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
    render();
  });
  window.addEventListener("hashchange", render);
  render();
}
// Deferred scripts (quant.js, app.js, live.js) all run before DOMContentLoaded, so every route exists by then.
if (document.readyState === "complete") shell(); else window.addEventListener("DOMContentLoaded", shell);
