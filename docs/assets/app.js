/* Free Quant Platform: static web dashboard.
 * Reads the JSON written by `python -m quant.web.export` (data/) and renders the pages with
 * Plotly; quant.js (window.Q) does the in-browser statistics, live.js the WebSocket charts and
 * quantum.js the Quantum page. Hash routes: #/global, #/markets, #/stock/<ticker>,
 * #/financials/<ticker>, #/compare/<A,B,C>, #/quantum/<section>, #/live/<symbol> (#/bot, the retired paper bot,
 * redirects to #/global). Pretty paths (/stock/AAPL) redirect via 404.html.
 */
"use strict";

// --- data -----------------------------------------------------------------------------------------
const cache = new Map();
function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch("data/" + path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { cache.delete(path); e.dataPath = path; throw e; }));  // dataPath: the page says which file is missing
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
const SIGNAL_NOTE = "BUY / HOLD / AVOID are mechanical labels from ranking past data against peers: not recommendations, and not predictions of returns.";
const CLASS_NAME = { s: "Stock", e: "ETF", c: "Crypto", i: "Index" };
const signed = (x, d = 2) => `<span class="${tone(x)}">${pct(x, d)}</span>`;
/** A small "?" link to a metric's section on the Methodology page (nothing until that page is loaded). */
const mq = (id) => (window.METHOD ? `<a class="mq" href="#/methodology/${id}" title="How this is calculated" aria-label="How this is calculated">?</a>` : "");

function kpi(label, value, sub = "", help = "", q = "") {
  return `<div class="card kpi"><div class="label"${help ? ` title="${esc(help)}"` : ""}>${esc(label)}${help ? " ⓘ" : ""}${q ? mq(q) : ""}</div>
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

// --- data status (status.json, written by the nightly job: quant/web/status.py) ---------------------
/** Weekdays from an ISO date to today (UTC), like numpy.busday_count in status.py: 1 = yesterday's close.
 * calendar: count every day (coins trade at weekends). */
function ageDays(iso, calendar = false, now = new Date()) {
  if (!iso) return null;
  const a = Date.parse(String(iso).slice(0, 10) + "T00:00:00Z"), b = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(a)) return null;
  if (calendar) return Math.max(0, Math.round((b - a) / 864e5));
  let n = 0;
  for (let t = a; t < b; t += 864e5) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
/** green, amber when older than expected, red beyond three times that (the same rule as status.py). */
const ageState = (age, expect = 1) => (age === null || age === undefined ? "red" : age > 3 * expect ? "red" : age > expect ? "amber" : "green");
const STATE_RANK = { green: 0, amber: 1, red: 2 };
const worstState = (states) => states.reduce((w, s) => (STATE_RANK[s] > STATE_RANK[w] ? s : w), "green");
const STATE_TEXT = { green: "fresh", amber: "older than expected", red: "missing or stale" };
let statusDoc;  // status.json once loaded; null when it isn't published
async function dataStatus() {
  if (statusDoc === undefined) statusDoc = await load("status.json").catch(() => null);
  return statusDoc;
}
/** A status.json source with its age and state recomputed for today: never better than the nightly state,
 * so a site that stopped updating turns amber, then red, on its own. */
function sourceState(id) {
  const s = statusDoc && (statusDoc.sources || []).find((x) => x.id === id);
  if (!s) return { id, label: id, provider: "", asOf: null, age: null, expect: 1, state: "red",
    error: statusDoc ? `no "${id}" source in status.json` : "status.json is missing from this export" };
  const age = ageDays(s.as_of, s.calendar);
  return { id, label: s.label, provider: s.provider, asOf: s.as_of, age, expect: s.expect_days || 1, error: s.error,
    state: worstState([s.state || "red", s.error ? "red" : "green", ageState(age, s.expect_days || 1)]) };
}
// --- freshness badges: every panel names its source and as-of date, coloured by age -------------------
/** A part loaded in the browser, or a per-symbol date: {provider, label, asOf, expect?, calendar?, live?, error?}. */
function partState(p) {
  const asOf = p.live ? new Date().toISOString().slice(0, 10) : p.asOf, expect = p.expect || 1;
  const age = ageDays(asOf, p.calendar);
  return { label: p.label || p.provider, provider: p.provider || "", asOf, age, expect, calendar: !!p.calendar, error: p.error,
    state: p.error ? "red" : p.state || ageState(age, expect) };
}
/** Badge for prices loaded in the browser (priceHistory), or for the error that stopped them. */
const pxSrc = (h) => (h && !h.error && h.dates && h.dates.length
  ? { provider: h.source, label: `${h.weekly ? "Weekly" : "Daily"} prices loaded in your browser`, asOf: h.dates[h.dates.length - 1], calendar: h.source === "Binance", expect: h.weekly ? 5 : 1 }
  : { provider: "CNBC / Binance", label: "Prices loaded in your browser", error: (h && h.error) || "no prices" });
/** The freshness badge: status.json source ids and/or browser parts. Shows the providers and the oldest
 * as-of date; green, amber (older than expected) or red (missing, failed or 3x too old); links to #/status. */
function fresh(...parts) {
  const infos = parts.flat().filter(Boolean).map((p) => (typeof p === "string" ? sourceState(p) : partState(p)));
  if (!infos.length) return "";
  const state = worstState(infos.map((i) => i.state)), oldest = infos.map((i) => i.asOf).filter(Boolean).sort()[0];
  const names = [...new Set(infos.map((i) => i.provider || i.label))].join(" + ");
  const src = infos.map((i) => `${i.label}${i.provider && i.provider !== i.label ? ` (${i.provider})` : ""}, ${i.asOf ? `as of ${i.asOf}` : "no date"}`).join("; ");
  const tip = infos.map((i) => `${i.label}${i.provider && i.provider !== i.label ? ` · ${i.provider}` : ""}: ${i.asOf
    ? `as of ${i.asOf}, ${i.age} ${i.calendar ? "days" : "weekdays"} old (expected ≤ ${i.expect})` : "no data"} · ${STATE_TEXT[i.state]}${i.error ? ` · ${i.error}` : ""}`).join("\n");
  return ` <a class="fresh ${state}" href="#/status" data-src="${esc(src)}" data-asof="${esc(oldest || "")}" title="${esc(tip + "\nData status →")}"><i></i>${esc(names)} · ${oldest ? esc(oldest) : "missing"}</a>`;
}
// Each route's default source, given to any panel heading the view didn't label itself (null: no data panels).
const PAGE_SOURCES = { global: ["scores"], markets: ["deep-prices"], stock: ["scores"], financials: ["yahoo-fundamentals"], compare: ["scores"],
  quantum: [{ provider: "Simulated in your browser", live: true }], "track-record": ["track"], live: null, methodology: null, status: null, changelog: null };
let pageSources = null;
/** Give every h2 and chart title in the view (and the drawer) a badge, unless it has one or opts out (data-nofresh). */
function decorate(root) {
  if (!pageSources) return;
  root.querySelectorAll("h2, .chart-title").forEach((h) => {
    if (h.querySelector(".fresh") || h.closest("[data-nofresh]") || !h.textContent.trim()) return;
    h.insertAdjacentHTML("beforeend", fresh(pageSources));
    h.lastElementChild.dataset.default = "1";
  });
}
// --- CSV downloads: every table and chart, with its source and as-of date in the file's header -------
const DISCLAIMER = "Research and education only, not investment advice. Data may be delayed or wrong. Past performance does not predict future results.";
const csvExtra = new WeakMap();  // element -> () => {cols, rows}, for panels that aren't a <table> or a Plotly chart
function csvFor(el, fn) { if (el) { csvExtra.set(el, fn); el.dataset.csv = "1"; } }
const csvQuote = (v) => { const s = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v); return /[",\n#]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function cellText(c) {
  const x = c.cloneNode(true);
  x.querySelectorAll(".mq, .fresh, button, .cmp-src, summary").forEach((n) => n.remove());
  x.querySelectorAll("div, br, li").forEach((n) => n.before(" "));  // keep nested lines apart
  return x.textContent.replace(/\s+/g, " ").trim();
}
/** The last element matching `sel` before `el` in the page (its panel's heading or badge). */
function before(el, sel) {
  let found = null;
  for (const n of document.querySelectorAll(sel)) { if (n !== el && n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !n.contains(el)) found = n; }
  return found;
}
function panelData(el) {
  if (csvExtra.has(el)) return csvExtra.get(el)();
  const tbl = el.querySelector("table");
  if (tbl) {
    const rows = [...tbl.rows].map((tr) => [...tr.cells].map(cellText));
    return { cols: rows[0] || [], rows: rows.slice(1).filter((r) => r.some(Boolean)) };
  }
  const rows = [];
  for (const t of el.data || []) {
    const name = t.name || t.type || "series";
    if (t.type === "candlestick") (t.x || []).forEach((x, i) => rows.push([name, x, t.open[i], t.high[i], t.low[i], t.close[i]]));
    else if (t.type === "heatmap") (t.z || []).forEach((zr, i) => zr.forEach((z, j) => rows.push([name, `${(t.x || [])[j] ?? j} / ${(t.y || [])[i] ?? i}`, z])));
    else { const n = Math.max((t.x || []).length, (t.y || []).length); for (let i = 0; i < n; i++) rows.push([name, t.x ? t.x[i] : i, t.y ? t.y[i] : ""]); }
  }
  const candles = (el.data || []).some((t) => t.type === "candlestick");
  return { cols: candles ? ["series", "x", "open/y", "high", "low", "close"] : ["series", "x", "y"], rows };
}
function downloadPanel(el) {
  const { cols, rows } = panelData(el);
  const head = before(el, "#view h1, #view h2, #view h3, #view .chart-title, #drawer h2, #drawer .chart-title, #view .panel-meta");
  const badge = el.closest("[data-fresh-src]") || before(el, ".fresh");
  const title = head ? cellText(head) : document.title;
  const asOf = badge ? badge.dataset.asof || "" : "";
  const lines = [`# Free Quant Platform: ${title}`, `# Source: ${badge ? badge.dataset.src : "see the page"}`, `# As of: ${asOf || "n/a"}`,
    `# Downloaded: ${new Date().toISOString()} from ${location.href}`, `# ${DISCLAIMER}`,
    cols.map(csvQuote).join(","), ...rows.map((r) => r.map(csvQuote).join(","))];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" }));
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "data"}${asOf ? "_" + asOf : ""}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/** A "CSV" button above every table, chart and registered panel that has data. */
function addDownloads(root) {
  root.querySelectorAll(".table-wrap, .chart.js-plotly-plot, [data-csv]").forEach((el) => {
    if (el.parentElement.closest(".table-wrap, [data-csv]")) return;
    const prev = el.previousElementSibling;
    if (prev && prev.classList.contains("dl-row")) return;
    el.insertAdjacentHTML("beforebegin", '<div class="dl-row"><button type="button" class="dl" title="Download this panel as CSV, with its source and as-of date">⤓ CSV</button></div>');
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button.dl");
  if (b) downloadPanel(b.parentElement.nextElementSibling);
});
function watchPanels() {
  let timer = null;
  const run = () => { timer = null; for (const r of [$("#view"), $("#drawer")]) { decorate(r); addDownloads(r); } };
  const obs = new MutationObserver((records) => {
    if (records.every((r) => r.target.closest && r.target.closest(".js-plotly-plot, .pc-stage"))) return;  // chart internals
    if (!timer) timer = setTimeout(run, 60);
  });
  obs.observe($("#view"), { childList: true, subtree: true });
  obs.observe($("#drawer"), { childList: true, subtree: true });
}

// Quality flags from the nightly checks (quant/web/quality.py), published per symbol as "dq".
const DQ_LABEL = { duplicate: "repeated rows", gap: "3+ missing sessions", negative: "a close at or below zero", zero_volume: "zero volume on 5+ of 20 sessions",
  unit_change: "a 20x one-day jump (a unit change?)", stale: "no price for 5+ sessions", outlier: "a move beyond 5 standard deviations (flagged for review)" };
const dqCodes = (s) => (s ? String(s).split(",").filter(Boolean) : []);
/** ⚠ next to a symbol whose series failed a check (outliers alone are only for review, so no mark). */
function dqMark(dq) {
  const codes = dqCodes(dq).filter((c) => c !== "outlier");
  return codes.length ? ` <a class="dq" href="#/status" title="Data check failed: ${esc(codes.map((c) => DQ_LABEL[c] || c).join("; "))}. Numbers from this series may be wrong.">⚠</a>` : "";
}
function dqNote(dq) {
  const codes = dqCodes(dq);
  if (!codes.length) return "";
  const review = codes.length === 1 && codes[0] === "outlier";
  return `<div class="note ${review ? "" : "dq-note"}"><b>${review ? "Flagged for review" : "Data check failed"}:</b> tonight's checks found ${esc(codes.map((c) => DQ_LABEL[c] || c).join("; "))}
    in this symbol's price series. ${review ? "The move may be real; it is listed for review." : "Scores and returns from it may be wrong."} <a href="#/status">Data status</a></div>`;
}

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
  if (el.parentElement) addDownloads(el.parentElement);  // the CSV button (chart redraws don't reach the panel observer)
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
/** {info: fundamentals} from the symbol's bucket. The site publishes no price history: see priceHistory. */
async function symbolData(sym) {
  const b = (fnv1a(sym) % 256).toString(16).padStart(2, "0");
  const bucketData = await load(`sym/${b}.json`).catch(() => ({}));
  const rec = bucketData[sym];
  return rec ? { info: rec.i || {} } : null;
}
async function isDeep(sym) { return (await load("meta.json")).deep.some((t) => t.ticker === sym); }
/** About two years of daily bars {dates, open, high, low, close, volume, values (= close), source}, loaded in
 * the visitor's browser from CNBC or Binance (live.js), since the site doesn't republish price history.
 * {weekly: true} gives ten years of weekly bars. Throws with a readable message when no source has the symbol. */
async function priceHistory(sym, opts) {
  if (!window.LIVE) throw new Error("Price history couldn't load (live.js is missing)");
  const h = await window.LIVE.dailyHistory(sym, opts);
  return Object.assign({ values: h.close }, h);
}
const ohlcv = (h) => ({ time: h.dates, open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume });
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
  window.dispatchEvent(new CustomEvent("watchchange", { detail: { sym, on: inWatch(sym) } }));
  return inWatch(sym);
}
/** ☆ / ★ toggle for any ticker, anywhere: one click handler (below) serves every star on the page. */
const starBtn = (sym) => `<button type="button" class="star${inWatch(sym) ? " on" : ""}" data-star="${esc(sym)}" aria-pressed="${inWatch(sym)}"
  title="Add ${esc(sym)} to or remove it from your watchlist (saved in this browser)" aria-label="Watchlist: ${esc(sym)}">${inWatch(sym) ? "★" : "☆"}</button>`;
document.addEventListener("click", async (e) => {  // capture phase, so a star inside a clickable row doesn't open the row
  const b = e.target.closest && e.target.closest("[data-star]");
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  await toggleWatch(b.dataset.star);
}, true);
window.addEventListener("watchchange", (e) => {
  const { sym, on } = e.detail;
  document.querySelectorAll("[data-star]").forEach((x) => {
    if (x.dataset.star !== sym) return;
    x.classList.toggle("on", on); x.textContent = on ? "★" : "☆"; x.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll("[data-watch-panel]").forEach((p) => watchPanel(p));
});
/** The watchlist as a card: each name with its 1-day move, links to `route`, ★ to remove, export and import. */
async function watchPanel(el) {
  if (!el || !el.isConnected) return;
  const route = el.dataset.watchPanel || "stock", list = await watchlist();
  const rows = await Promise.all(list.map(async (s) => (await rowFor(s).catch(() => null)) || { s }));
  el.innerHTML = `<div class="card wl-panel">
      <div class="wl-head"><h3>Your watchlist ★</h3><span class="caption">${list.length} name${list.length === 1 ? "" : "s"}, saved in this browser</span>
        <span class="wl-actions"><button type="button" class="btn q-small" data-wl="export">Export JSON</button>
        <label class="btn q-small">Import JSON<input type="file" accept="application/json,.json" data-wl="import" hidden></label></span></div>
      <div class="wl-chips">${rows.length ? rows.map((r) => `<span class="wl-chip">${starBtn(r.s)}<a href="#/${route}/${encodeURIComponent(r.s)}"><b>${esc(r.s)}</b></a>
        <span class="${tone(r.r1d)}">${ok(r.r1d) ? pct(r.r1d, 1) : ""}</span></span>`).join("") : '<span class="muted">Star any ticker (☆) to add it here.</span>'}</div>
      <p class="caption wl-msg" aria-live="polite"></p></div>`;
  const msg = (t) => { $(".wl-msg", el).textContent = t; };
  $("[data-wl=export]", el).addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([Util.exportWatchlist(list)], { type: "application/json" }));
    a.download = `watchlist_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("[data-wl=import]", el).addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const { list: incoming, skipped } = Util.parseWatchlist(await file.text());
      const before = (await watchlist()).length;
      setWatchlist([...(await watchlist()), ...incoming]);
      const added = watchCache.length - before;
      document.querySelectorAll("[data-watch-panel]").forEach((p) => watchPanel(p));
      setTimeout(() => document.querySelectorAll(".wl-msg").forEach((m) => { m.textContent = `Imported: ${added} added, ${incoming.length - added} already there${skipped ? `, ${skipped} skipped` : ""}.`; }), 50);
    } catch (err) { msg(`Couldn't import ${file.name}: ${err.message}.`); }
  });
}

// --- basket picker (Quantum labs, Compare, correlations) ------------------------------------------
const basketHtml = (p, placeholder = "Add a stock") => `<div class="q-basket"><div class="q-chips" id="${p}-chips"></div><div class="q-add" id="${p}-add">${searchBox(placeholder)}</div></div>
  <p class="caption" id="${p}-msg"></p>`;
/** Wire a basket editor. B = {syms, w?}; onChange() runs after every edit. Each added symbol must have
 * at least `minBars` daily bars in the browser's price history. */
function bindBasket(sec, p, B, { min, max, weights = false, minBars = 130, onChange }) {
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
      msg(Math.abs(B.w.reduce((t, x) => t + x, 0) - 1) > 1e-6 ? "Weights are scaled to add up to 100%." : ""); onChange();
    }));
    const eq = $(`#${p}-eq`, sec);
    if (eq) eq.addEventListener("click", () => { B.w = B.syms.map(() => 1 / B.syms.length); msg(""); draw(); onChange(); });
  };
  bindSearch($(`#${p}-add`, sec), async (sym) => {
    if (B.syms.includes(sym)) { msg(`${sym} is already in the basket.`); return; }
    if (B.syms.length >= max) { msg(`At most ${max} at a time.`); return; }
    let h;
    try { h = await priceHistory(sym); } catch (e) { msg(e.message); return; }
    if (h.close.length < minBars) { msg(`${sym}: not enough price history.`); return; }
    B.syms.push(sym);
    if (weights) B.w = B.syms.map(() => 1 / B.syms.length);
    msg(""); draw(); onChange();
  });
  draw();
  return draw;
}
/** Aligned closes of a basket over the last `sessions` returns, loaded in the browser (priceHistory). */
async function basketPrices(syms, sessions) {
  const hist = await Promise.all(syms.map(async (s) => [s, await priceHistory(s).catch((e) => ({ error: e.message }))]));
  const missing = hist.filter(([, h]) => h.error);
  if (missing.length) throw new Error(missing.map(([, h]) => h.error).join(" · "));
  const al = Q.align(hist.map(([, h]) => h));
  const start = Math.max(0, al.dates.length - sessions - 1);
  return { dates: al.dates.slice(start), values: al.values.map((v) => v.slice(start)) };
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

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
// The key is a credential, so by default it lives in sessionStorage and is gone when the tab closes;
// "Remember on this device" moves it to localStorage. It is only ever sent to finnhub.io.
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: keep nothing */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const FH = {
  key: () => session.get("finnhubKey") || store.get("finnhubKey", ""),
  remembered: () => !!store.get("finnhubKey", ""),
  save(key, remember) {
    if (remember) { store.set("finnhubKey", key); session.del("finnhubKey"); } else { session.set("finnhubKey", key); store.del("finnhubKey"); }
  },
  forget() { store.del("finnhubKey"); session.del("finnhubKey"); },
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
const G_TABS = ["screener", "sectors", "movers", "watch"];
const gDefaults = () => ({ classes: new Set(["s", "e", "c"]), signals: new Set(), market: "", sector: "", q: "", min: 0, cap: "", unusual: false,
  sort: "sc", dir: -1, page: 0, tab: "screener" });
function globalFromUrl(p) {
  if (!Object.keys(p).length) return;  // a plain #/global keeps this session's filters
  Object.assign(G, gDefaults());
  if (p.cls !== undefined) G.classes = new Set(Util.listParam(p.cls).filter((c) => ["s", "e", "c"].includes(c)));
  if (p.sig) G.signals = new Set(Util.listParam(p.sig).filter((s) => ["BUY", "HOLD", "AVOID"].includes(s)));
  Object.assign(G, { market: p.mkt || "", sector: p.sec || "", q: p.q || "", min: Util.numParam(p.min, 0, 0, 100), cap: Util.oneOf(p.cap, ["10", "100"], ""),
    unusual: p.unu === "1", sort: Util.oneOf(p.sort, SCREEN_COLS.map((c) => c.sort).filter(Boolean), "sc"), dir: p.dir === "1" ? 1 : -1,
    page: Math.floor(Util.numParam(p.page, 1, 1, 1e4)) - 1, tab: Util.oneOf(p.tab, G_TABS, "screener") });
  GS.sector = p.hm || null;
}
function globalToUrl() {
  const cls = ["s", "e", "c"].filter((c) => G.classes.has(c));
  setPageParams("global", { tab: G.tab === "screener" ? "" : G.tab, cls: cls.length === 3 ? "" : cls.join(",") || "none", sig: [...G.signals].join(","),
    mkt: G.market, sec: G.sector, q: G.q, min: G.min || "", cap: G.cap, unu: G.unusual ? 1 : "", sort: G.sort === "sc" ? "" : G.sort, dir: G.dir === 1 ? 1 : "",
    page: G.page ? G.page + 1 : "", hm: G.tab === "sectors" ? GS.sector : "" });
}

async function viewGlobal(view) {
  const [g, rows, meta] = [await load("global.json"), await screenerRows(), await load("meta.json")];
  globalFromUrl(pageParams());
  G.asOf = { scored: g.scored_at, prices: meta.prices_as_of };
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
      ${counts.c.toLocaleString()} coins · scored ${esc(g.scored_at.slice(0, 16).replace("T", " "))} UTC. Click a row for its chart and the reasons behind its signal.
      ${SIGNAL_NOTE}</p>
    <div id="g-watch" data-watch-panel="stock"></div>
    <h2>Market regimes ${mq("regimes-global")}${fresh("scores", "yahoo-prices")}</h2>
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
      <button type="button" data-tab="screener">Screener</button><button type="button" data-tab="sectors">Sector heatmap</button><button type="button" data-tab="movers">Unusual movers today</button><button type="button" data-tab="watch">Watchlist ★</button>
    </div>
    <div class="panel-meta" id="g-meta"></div>
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
  const onWatch = () => { if (G.tab === "watch" && $("#g-body")) drawGlobal(); };
  window.addEventListener("watchchange", onWatch);
  window.onRouteCleanup(() => window.removeEventListener("watchchange", onWatch));
  watchPanel($("#g-watch", view));
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

const starCell = { h: "★", f: (r) => starBtn(r.s) };
const SCREEN_COLS = [
  starCell,
  { h: "Symbol", sort: "s", f: (r) => `<b>${esc(r.s)}</b>${dqMark(r.dq)}` },
  { h: "Name", cls: "clip", f: (r) => esc(r.n) },
  { h: "Market", f: (r) => esc(r.m) },
  { h: "Sector", cls: "clip", f: (r) => esc(r.sec || { e: "ETF", c: "Crypto" }[r.a] || "–") },
  { h: "Signal", q: "signal", f: (r) => `<span class="sig-${esc(r.sig)}">${SIGNAL[r.sig] || "–"}</span>` },
  { h: "Score", sort: "sc", q: "composite", f: (r) => bar(r.sc) },
  { h: "Trend", sort: "t", q: "pillars", r: 1, f: (r) => num(r.t, 0) },
  { h: "Mom.", sort: "mo", q: "pillars", r: 1, f: (r) => num(r.mo, 0) },
  { h: "Value", sort: "v", q: "pillars", r: 1, f: (r) => num(r.v, 0) },
  { h: "Quality", sort: "q", q: "pillars", r: 1, f: (r) => num(r.q, 0) },
  { h: "Risk", sort: "r", q: "pillars", r: 1, f: (r) => num(r.r, 0) },
  { h: "1D", sort: "r1d", q: "returns", r: 1, f: (r) => signed(r.r1d, 1) },
  { h: "1M", sort: "r1m", q: "returns", r: 1, f: (r) => signed(r.r1m, 1) },
  { h: "YTD", sort: "ytd", q: "returns", r: 1, f: (r) => signed(r.ytd, 1) },
  { h: "12-1", sort: "m121", q: "momentum", r: 1, f: (r) => pct(r.m121, 0) },
  { h: "Fwd P/E", sort: "fpe", r: 1, f: (r) => num(r.fpe, 1) },
  { h: "Mkt cap $B", sort: "cap", r: 1, f: (r) => num(r.cap, r.cap >= 100 ? 0 : 1) },
  { h: "6M", cls: "spark-cell", f: (r) => spark(r.sp) },
  { h: "Why", cls: "wrap-text", f: (r) => `<div class="clamp" title="${esc(r.why)}">${esc(r.why)}</div>` },
];

// --- sector heatmap (Global, "Sector heatmap" tab) -----------------------------------------------
const GS = { sector: null };
function moveColor(x, scale) {
  if (!ok(x)) return { bg: "var(--bg-soft)", fg: "var(--text-faint)" };
  const a = 0.15 + 0.75 * Math.min(1, Math.abs(x) / scale);
  return { bg: x >= 0 ? `rgba(42,120,214,${a.toFixed(3)})` : `rgba(227,73,72,${a.toFixed(3)})`, fg: a > 0.55 ? "#fff" : "var(--text)" };
}
/** Sectors as a treemap (size: market cap, colour: the day's move); a click drills into the stocks. */
function drawSectorMap(body, rows) {
  const stocks = rows.filter((r) => r.a === "s");
  if (GS.sector && !stocks.some((r) => r.sec === GS.sector)) GS.sector = null;
  const W = Math.max(300, body.clientWidth || 900), H = W < 600 ? 460 : 540;
  let tiles, scale, crumb;
  if (!GS.sector) {
    const groups = Q.groupMoves(stocks, "sec");
    const byCap = groups.length && groups.every((t) => ok(t.cap) && t.cap > 0);
    tiles = groups.map((t) => ({ label: t.key, sub: `${t.n.toLocaleString()} stocks`, size: byCap ? t.cap : 1, change: t.change, sector: t.key,
      tip: `${t.key}: ${ok(t.change) ? pct(t.change, 2) : "n/a"} (cap-weighted) · ${t.n} stocks · ${ok(t.cap) ? money(t.cap * 1e9) : "cap n/a"}${t.missing ? ` · ${t.missing} without a 1-day change` : ""}` }));
    scale = 0.03;
    crumb = `<b>All sectors</b> · ${stocks.length.toLocaleString()} stocks${byCap ? "" : " (equal-sized: market caps missing)"}. Click a sector for its stocks.`;
  } else {
    const members = stocks.filter((r) => r.sec === GS.sector).sort((a, b) => (b.cap || 0) - (a.cap || 0)), shown = members.slice(0, 150);
    const caps = shown.map((r) => r.cap).filter((c) => ok(c) && c > 0).sort((a, b) => a - b), median = caps.length ? caps[Math.floor(caps.length / 2)] : 1;
    tiles = shown.map((r) => ({ label: r.s, sub: r.n || "", size: ok(r.cap) && r.cap > 0 ? r.cap : median, change: r.r1d, row: r,
      tip: `${r.s} · ${r.n || ""}: ${ok(r.r1d) ? pct(r.r1d, 2) : "n/a"} · ${ok(r.cap) ? money(r.cap * 1e9) : "cap n/a"} · ${r.m}` }));
    scale = 0.05;
    crumb = `<button type="button" class="btn q-small" id="sm-back">← All sectors</button> <b>${esc(GS.sector)}</b> · ${members.length.toLocaleString()} stocks${members.length > shown.length ? `, the largest ${shown.length} shown` : ""}. Click a stock for its details.`;
  }
  const rects = Q.squarify(tiles.map((t) => t.size), 0, 0, W, H);
  setTimeout(() => csvFor($(".sm-map", body), () => ({ cols: ["tile", "detail", "size", "change_1d"], rows: tiles.map((t) => [t.label, t.sub, t.size, t.change]) })));
  const cell = (r) => {
    const t = tiles[r.i], col = moveColor(t.change, scale), area = r.w * r.h;
    const big = area > 9000 && r.w > 70, mid = area > 2500 && r.w > 44;
    return `<button type="button" class="sm-tile" data-i="${r.i}" title="${esc(t.tip)}" style="left:${(100 * r.x) / W}%;top:${(100 * r.y) / H}%;width:${(100 * r.w) / W}%;height:${(100 * r.h) / H}%;background:${col.bg};color:${col.fg}">
      ${mid ? `<b>${esc(t.label)}</b><span>${ok(t.change) ? pct(t.change, GS.sector ? 1 : 2) : "n/a"}</span>${big ? `<em>${esc(t.sub)}</em>` : ""}` : ""}</button>`;
  };
  body.innerHTML = `
    <div class="sm-asof">Latest nightly close: prices as of <b>${esc(G.asOf.prices)}</b>, scored ${esc(G.asOf.scored.slice(0, 16).replace("T", " "))} UTC.
      This is not live intraday data. ${mq("sector-map")}${fresh("scores", "yahoo-prices")}</div>
    <div class="sm-crumb">${crumb}</div>
    <div class="sm-map" style="height:${H}px">${rects.map(cell).join("")}</div>
    <div class="sm-legend"><span>${pct(-scale, 0)}</span><span class="sm-scale"></span><span>${pct(scale, 0)}</span><span class="sm-na">n/a</span></div>
    <p class="caption">Tile size: market cap in US dollars; colour: the 1-day close-to-close change (sector tiles: cap-weighted average). Sector: the sector field
      from Yahoo Finance in the nightly export. Stocks only; the filters above apply. Grey tiles have no 1-day change in the export.</p>`;
  body.querySelectorAll(".sm-tile").forEach((b) => b.addEventListener("click", () => {
    const t = tiles[Number(b.dataset.i)];
    if (t.sector) { GS.sector = t.sector; drawGlobal(); } else if (t.row) openDetail(t.row);
  }));
  const back = $("#sm-back", body);
  if (back) back.addEventListener("click", () => { GS.sector = null; drawGlobal(); });
}

function drawGlobal() {
  const view = $("#view");
  globalToUrl();
  const rows = filtered();
  const buy = rows.filter((r) => r.sig === "BUY").length, avoid = rows.filter((r) => r.sig === "AVOID").length;
  $("#g-kpis", view).innerHTML = kpi("Matching", rows.length.toLocaleString()) +
    kpi("Buy candidates", buy.toLocaleString(), "", "Up-trend + composite ≥ 60 + market not in a Bear regime", "signal") +
    kpi("Avoid", avoid.toLocaleString(), "", "Down-trend + composite ≤ 40", "signal") +
    kpi("Unusual move today", rows.filter((r) => r.u).length.toLocaleString(), "", "≥ 8% (crypto 20%), or ≥ 3 robust σ and ≥ 2% (crypto 5%)", "unusual");
  view.querySelectorAll("#g-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === G.tab));

  $("#g-meta", view).innerHTML = G.tab === "sectors" ? "" : `${{ screener: "Screener", movers: "Unusual movers today", watch: "Watchlist" }[G.tab]}: nightly scores and fundamentals${fresh("scores", "yahoo-prices", "yahoo-fundamentals")}`;
  if (G.tab === "sectors") { drawSectorMap($("#g-body", view), rows); return; }
  let list = rows, cols = SCREEN_COLS;
  if (G.tab === "movers") {
    list = rows.filter((r) => r.u).sort((a, b) => Math.abs(b.r1d || 0) - Math.abs(a.r1d || 0));
    cols = [SCREEN_COLS[0], SCREEN_COLS[1], SCREEN_COLS[2], SCREEN_COLS[3],
      { h: "1D", r: 1, q: "returns", f: (r) => signed(r.r1d, 1) }, { h: "z", r: 1, q: "unusual", f: (r) => num(r.z, 1) }, SCREEN_COLS[5], SCREEN_COLS[6], SCREEN_COLS[19]];
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
  const marked = cols.map((c) => Object.assign({}, c, { mark: (c.q ? mq(c.q) : "") + (c.sort && c.sort === G.sort && G.tab !== "movers" ? (G.dir < 0 ? " ↓" : " ↑") : "") }));
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
  csvFor($(".table-wrap", body), () => ({  // every matching row, not just this page of 50
    cols: ["symbol", "name", "class", "market", "sector", "signal", "score", "trend", "momentum", "value", "quality", "risk", "analysts",
      "ret_1d", "ret_1m", "ret_ytd", "mom_12_1", "fwd_pe", "mkt_cap_usd_bn", "unusual", "data_checks", "why"],
    rows: list.map((r) => [r.s, r.n, CLASS_NAME[r.a] || r.a, r.m, r.sec, r.sig, r.sc, r.t, r.mo, r.v, r.q, r.r, r.an, r.r1d, r.r1m, r.ytd, r.m121, r.fpe, r.cap,
      r.u ? 1 : 0, r.dq || "", r.why]) }));
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
  const pill = (label, v) => `<div class="card kpi"><div class="label">${label}${mq(label === "Score" ? "composite" : label.startsWith("RSI") ? "rsi" : "pillars")}</div>
    <div class="value">${ok(v) ? v.toFixed(0) : "–"}</div></div>`;
  drawer.innerHTML = `
    <div class="head"><div><h2>${esc(r.s)} · ${esc(r.n || "")}</h2>
      <div class="caption">${esc(r.m)} · ${esc(r.sec || { e: "ETF", c: "Crypto" }[r.a] || "")}${r.also ? ` · also listed: ${esc(r.also)}` : ""} · last ${num(r.px, 2)} ${esc(r.cur || "")}</div></div>
      <button class="btn close" id="d-close">Close ✕</button></div>
    <p><span class="badge ${r.sig === "BUY" ? "good" : r.sig === "AVOID" ? "bad" : ""}">${SIGNAL[r.sig] || "–"}</span>
      <span class="soft">${esc(r.why || "")}</span></p><p class="caption">${SIGNAL_NOTE}</p>
    <div class="chips" id="d-span">${["6M", "1Y", "All"].map((s) => `<button class="chip${s === span ? " on" : ""}" data-v="${s}">${s}</button>`).join("")}</div>
    <div class="chart-title" id="d-title" data-nofresh>Price, 50 and 200-day averages</div>
    <div class="chart" id="d-chart" style="min-height:320px"><div class="loading">Loading prices…</div></div>
    <div class="chart-title">Pillars and returns${fresh("scores", "yahoo-prices")}</div>
    <div class="pillars">${pill("Score", r.sc)}${pill("Trend", r.t)}${pill("Momentum", r.mo)}${pill("Risk", r.r)}${pill("Value", r.v)}${pill("Quality", r.q)}${pill("Analysts", r.an)}${pill(r.a === "e" ? "Cost" : "RSI (14)", r.a === "e" ? r.co : r.rsi)}</div>
    <div class="grid g4" style="margin-top:12px">
      ${kpi("1 month", signed(r.r1m, 1))}${kpi("Year to date", signed(r.ytd, 1))}
      ${kpi("Momentum 12-1", pct(r.m121, 0), "", "", "momentum")}${kpi("vs 200-day MA", pct(r.d200), "", "", "moving-averages")}
      ${kpi("Fwd P/E", num(r.fpe, 1))}${kpi("ROE", pct(r.roe, 0, false))}${kpi("Dividend yield", ok(r.dy) ? num(r.dy, 2) + "%" : "–")}${kpi("Mkt cap", ok(r.cap) ? money(r.cap * 1e9) : "–")}
    </div>
    <p class="caption">Pillars are percentiles among peers (stocks: same market, and same sector for value and quality; ETFs and coins within their class).</p>
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

  const el = $("#d-chart");
  let h;
  try { h = await priceHistory(r.s); priceChart(el, h, span, { height: 340 }); }
  catch (e) { h = { error: e.message }; el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  const t = $("#d-title");
  if (t) t.insertAdjacentHTML("beforeend", fresh(pxSrc(h)));
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

// --- indicator charts (Stock pages): any mix of TradingView-style overlays and oscillator panes ---
const S_IND = new Set(store.get("stockIndicators", ["sma", "volume", "rsi"]));
let shareIndicators = () => {};  // the page on screen sets this to rewrite its link when indicators change
const PANE_VOLUME = { id: "volume", name: "Volume", kind: "pane" };
const colorOf = (key) => { const c = pal(); return { s0: c.series[0], s1: c.series[1], s2: c.series[2], s3: c.series[3], s4: c.series[4], s5: c.series[5], s6: c.series[6], s7: c.series[7] }[key] || c[key] || key; };
function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function indicatorChipsHtml(d) {
  const fit = (i) => (i.id === "volume" ? !!d.volume : Q.indicatorFits(i, d));
  return [["Overlays", "overlay"], ["Oscillators", "pane"]].map(([label, kind]) => `<div class="control"><span class="label">${label}</span>
    <div class="chips" data-ind="${kind}">${[...(kind === "pane" ? [PANE_VOLUME] : []), ...Q.INDICATORS.filter((i) => i.kind === kind && !i.intraday)].map((i) =>
      `<button type="button" class="chip${S_IND.has(i.id) && fit(i) ? " on" : ""}" data-v="${i.id}"${fit(i) ? ""
        : ' disabled style="opacity:.45" title="Needs high/low prices or volume, which are kept for the deep-tier stocks; open the Live chart for TradingView\'s version"'}>${esc(i.name)}</button>`).join("")}</div></div>`).join("");
}
function bindIndicatorChips(root, redraw) {
  root.querySelectorAll("[data-ind] .chip").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.v;
    S_IND.has(id) ? S_IND.delete(id) : S_IND.add(id);
    store.set("stockIndicators", [...S_IND]);
    shareIndicators();
    b.classList.toggle("on", S_IND.has(id));
    redraw();
  }));
}
/** Price chart with the selected indicators. d = {time, open?, high?, low?, close, volume?} over the
 * full history (indicators warm up on it), drawn from `span`. extra(x) adds traces on the price axis. */
function indicatorChart(el, d, span, { candles = false, height = 560, extra = null, rangebreaks = false, shapes = [] } = {}) {
  const c = pal();
  const start = span === "All" ? d.time[0] : startFor(d.time[d.time.length - 1], span);
  const i0 = Math.max(0, d.time.findIndex((t) => t >= start));
  const sl = (a) => (a ? a.slice(i0) : []);
  const x = sl(d.time), active = Q.INDICATORS.filter((i) => S_IND.has(i.id) && Q.indicatorFits(i, d) && !i.intraday);
  const panes = [...(S_IND.has("volume") && d.volume ? [PANE_VOLUME] : []), ...active.filter((i) => i.kind === "pane")];
  const traces = [];
  if (candles) {
    traces.push({ type: "candlestick", x, open: sl(d.open), high: sl(d.high), low: sl(d.low), close: sl(d.close), name: "Price",
      increasing: { line: { color: c.up, width: 1 }, fillcolor: c.up }, decreasing: { line: { color: c.down, width: 1 }, fillcolor: c.down } });
  } else traces.push({ x, y: sl(d.close), name: "Close", line: { color: c.ink, width: 1.5 }, hovertemplate: "%{y:,.4~f}" });
  for (const ind of active.filter((i) => i.kind === "overlay")) {
    const out = ind.calc(d), order = out.fill ? [out.fill[0], out.fill[1], ...out.lines.keys()].filter((k, j, a) => a.indexOf(k) === j) : [...out.lines.keys()];
    for (const k of order) {
      const ln = out.lines[k], col = colorOf(ln.color);
      const t = { x, y: sl(ln.values), name: ln.name, legendgroup: ind.id, line: { color: col, width: 1.5, dash: ln.dash ? "dot" : "solid" }, hovertemplate: "%{y:,.4~f}" };
      if (ln.dots) Object.assign(t, { mode: "markers", marker: { size: 3.5, color: col } });
      if (out.fill && k === out.fill[1]) Object.assign(t, { fill: "tonexty", fillcolor: withAlpha(col.startsWith("#") ? col : "#898781", 0.08) });
      traces.push(t);
    }
  }
  if (extra) traces.push(...extra(x));
  const n = panes.length, paneH = n ? Math.min(0.2, 0.56 / n) : 0, total = paneH * n;
  const lay = { xaxis: dateAxis({ rangeslider: { visible: false }, ...(rangebreaks ? { rangebreaks: [{ bounds: ["sat", "mon"] }, { values: missingWeekdays(x) }] } : {}) }),
    yaxis: yaxis({ domain: [total + (n ? 0.03 : 0), 1] }), shapes: [...shapes] };
  if (candles) {
    const lows = sl(d.low).filter(ok), highs = sl(d.high).filter(ok);
    lay.yaxis.range = [Math.min(...lows) * 0.95, Math.max(...highs) * 1.06];
  }
  panes.forEach((p, j) => {
    const ax = `y${j + 2}`, key = `yaxis${j + 2}`, top = total - j * paneH, bottom = top - paneH;
    lay[key] = yaxis({ domain: [bottom + 0.012, top - 0.006], title: { text: p.id === "volume" ? "Volume" : p.name.split(" ")[0], font: { size: 10 } } });
    if (p.id === "volume") {
      const o = sl(d.open || d.close), cl = sl(d.close);
      traces.push({ type: "bar", x, y: sl(d.volume), yaxis: ax, name: "Volume", showlegend: false, hovertemplate: "%{y:,.0f}",
        marker: { color: cl.map((v, i) => (v >= o[i] ? c.up : c.down)), opacity: 0.5 } });
      return;
    }
    const out = p.calc(d);
    if (out.hist) traces.push({ type: "bar", x, y: sl(out.hist), yaxis: ax, name: `${p.name.split(" ")[0]} histogram`, showlegend: false,
      marker: { color: sl(out.hist).map((v) => (v >= 0 ? withAlpha(c.up, 0.55) : withAlpha(c.down, 0.55))) }, hovertemplate: "%{y:.3f}" });
    out.lines.forEach((ln) => traces.push({ x, y: sl(ln.values), yaxis: ax, name: ln.name, legendgroup: p.id, line: { color: colorOf(ln.color), width: 1.5 }, hovertemplate: "%{y:.2f}" }));
    if (out.range) lay[key].range = out.range;
    (out.levels || []).forEach((lv) => lay.shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: ax, y0: lv, y1: lv, line: { color: c.axis, width: 1, dash: "dot" } }));
  });
  plot(el, traces, layout(height + 95 * Math.max(0, n - 1), lay));
}

// ====================================================================================================
// Markets (with the customizable watchlist)
// ====================================================================================================
const M = { span: new Set(["1Y"]), scope: new Set(["All"]) };

async function viewMarkets(view) {
  const p = pageParams();
  if (p.span) setOne(M.span, Util.oneOf(p.span, ["6M", "1Y", "2Y", "10Y"], "1Y"));
  if (p.news) setOne(M.scope, Util.oneOf(p.news, ["All", "Watchlist", "Market-wide"], "All"));
  indicatorsFromUrl(p);
  const toUrl = () => setPageParams("markets", { span: [...M.span][0], news: [...M.scope][0] === "All" ? "" : [...M.scope][0], ind: indicatorsParam() });
  shareIndicators = toUrl;
  const [m, spx] = await Promise.all([load("market.json"), priceHistory("^GSPC").catch((e) => ({ error: e.message }))]);
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
        ${kpi("Market regime", esc(reg.label), "", "S&P 500 trend (50/200-day MA, 20% drawdown rule) + VIX level", "market-regime")}
        ${kpi("Stance", esc(reg.stance), `<span class="badge ${stanceClass}">${esc(reg.stance)} · as of ${esc(reg.as_of)}</span>`, "From the 0-1 risk score: trend, volatility, credit, labour, curve, inflation", "stance")}
        ${kpi("Risk score", num(reg.risk_score, 2), "0 = benign · 1 = stressed", "Risk-On < 0.33, Risk-Off > 0.6", "risk-score")}
      </div></div>
      <div class="card"><h3>Why${fresh("deep-prices", "fred")}</h3><ul class="reasons">${(reg.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
    </div>
    <h2>Your watchlist${fresh("scores", "yahoo-prices")}</h2>
    <div class="controls" style="margin-top:0">
      <div class="control" style="width:min(360px,100%)"><span class="label">Add a stock, ETF, coin or index</span><div id="w-add">${searchBox("Search to add (e.g. 005930.KS, BTC, ^N225)")}</div></div>
      <button class="btn" id="w-reset" type="button">Reset to default</button>
      <span class="caption">Saved in this browser. ★ on the Global screener adds names too.</span>
    </div>
    <div id="w-table"></div>
    <div class="controls"><div class="control"><span class="label">Range</span>${chips("span", [["6M", "6M"], ["1Y", "1Y"], ["2Y", "2Y"], ["10Y", "10Y (weekly)"]], M.span, false)}</div></div>
    <div class="controls" style="margin-top:0">${indicatorChipsHtml(spx.error ? { close: [] } : ohlcv(spx))}</div>
    <div class="chart-title">S&amp;P 500 with regime stance ${mq("stance")}${fresh(pxSrc(spx), "deep-prices")}</div>
    <div class="chart" id="m-spx">${spx.error ? `<div class="empty">${esc(spx.error)}</div>` : ""}</div>
    <p class="caption">Prices load in your browser from CNBC: daily bars for two years, weekly bars for ten (indicator lengths then count weeks).</p>
    <h2>Economic indicators (FRED) ${mq("fred-tiles")}${fresh("fred")}</h2>
    <div class="grid g5" id="m-fred">${tiles}</div>
    <h2>Breaking news${fresh("news")}</h2><div class="controls" style="margin-top:0">${chips("scope", [["All", "All"], ["Watchlist", "Watchlist"], ["Market-wide", "Market-wide"]], M.scope, false)}</div><div id="m-news"></div>`;

  const drawSpx = async () => {
    toUrl();
    const span = [...M.span][0], el = $("#m-spx");
    let h = spx;
    if (span === "10Y") try { h = await priceHistory("^GSPC", { weekly: true }); } catch (e) { h = { error: e.message }; }
    if (h.error) { el.innerHTML = `<div class="empty">${esc(h.error)}</div>`; return; }
    const d = ohlcv(h), start = startFor(d.time[d.time.length - 1], span);
    const i0 = Math.max(0, d.time.findIndex((t) => t >= start));
    const c = pal(), x = d.time.slice(i0);
    const shapes = m.stance_runs.filter(([, end]) => end >= x[0]).map(([s, e, stance]) => ({
      type: "rect", xref: "x", yref: "paper", x0: s < x[0] ? x[0] : s, x1: e, y0: 0, y1: 1, line: { width: 0 },
      fillcolor: STANCE[stance], opacity: 0.1, layer: "below" }));
    const legend = Object.entries(STANCE).map(([s, col]) => ({ x: [x[x.length - 1]], y: [null], mode: "markers", name: `${s} (shading)`,
      hoverinfo: "skip", marker: { symbol: "square", size: 10, color: col, opacity: 0.4 } }));
    indicatorChart(el, d, span, { height: 400, extra: () => legend, shapes });
  };
  const drawNews = () => {
    toUrl();
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
  csvFor($("#m-fred", view), () => ({ cols: ["series", "label", "value", "unit", "date", "change_vs_1m"],
    rows: m.fred.map((t) => [t.id, t.label, t.value, t.unit, t.date, t.delta]) }));
  bindChips(view, "span", M.span, false, drawSpx);
  bindIndicatorChips(view, drawSpx);
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
/** Every symbol has a Live page: TradingView's real-time chart where its free widget carries the
 * market, Binance for coins, and the nightly daily bars elsewhere (live.js decides). */
const liveSymbolFor = (sym) => sym;

async function viewStock(view, arg) {
  const meta = await load("meta.json");
  await watchlist();
  const sym = arg || store.get("ticker", meta.deep[0].ticker);
  store.set("ticker", sym);
  indicatorsFromUrl(pageParams());
  if (meta.deep.some((t) => t.ticker === sym)) return viewStockDeep(view, sym);
  const row = await rowFor(sym);
  if (!row) return viewUnknown(view, sym, "stock");
  return viewStockUniverse(view, sym, row);
}

const LAYER_KEYS = { News: "news", "Unusual moves": "moves" };
async function viewStockDeep(view, ticker) {
  const p = pageParams();
  if (p.span) setOne(S.span, Util.oneOf(p.span, ["3M", "6M", "1Y", "All"], "6M"));
  if (p.layers !== undefined) { S.layers.clear(); Object.entries(LAYER_KEYS).forEach(([k, v]) => { if (Util.listParam(p.layers).includes(v)) S.layers.add(k); }); }
  const toUrl = () => setPageParams("stock", { span: [...S.span][0], layers: [...S.layers].map((k) => LAYER_KEYS[k]).join(",") || "none", ind: indicatorsParam() }, ticker);
  shareIndicators = toUrl;
  const [d, h] = await Promise.all([load(`deep/${ticker.replace("^", "_")}.json`), priceHistory(ticker).catch((e) => ({ error: e.message }))]);
  Object.assign(d, h.error ? { d: [], o: [], h: [], l: [], c: [], v: null } : { d: h.dates, o: h.open, h: h.high, l: h.low, c: h.close, v: h.volume, src: h.source });
  const n = d.c.length, snap = d.snapshot;
  const chg = n > 1 ? d.c[n - 1] / d.c[n - 2] - 1 : null;
  const spread = snap.sma_200 ? snap.sma_50 / snap.sma_200 - 1 : null;
  const rsi = snap.rsi_14;
  view.innerHTML = `
    ${assetHeader(ticker, d.name, `${esc(d.sic || "")}${d.exchange ? " · " + esc(d.exchange) : ""} · deep tier: candlesticks, news and explained moves`, "stock")}
    <div class="controls">
      <div class="control"><span class="label">Range</span>${chips("span", ["3M", "6M", "1Y", "All"].map((s) => [s, s]), S.span, false)}</div>
      <div class="control"><span class="label">Annotations</span>${chips("layers", ["News", "Unusual moves"].map((s) => [s, s]), S.layers)}</div>
    </div>
    <div class="controls" style="margin-top:0">${indicatorChipsHtml(deepSeries(d))}</div>
    <div class="grid g5">
      ${kpi("Close", num(snap.close, 2), `${signed(chg, 2)} · ${esc(snap.date)}`)}
      ${kpi("50 vs 200-day MA", pct(spread), spread > 0 ? '<span class="pos">golden-cross alignment</span>' : '<span class="neg">death-cross alignment</span>')}
      ${kpi("RSI (14)", num(rsi, 0), rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral", "", "indicators")}
      ${kpi("Momentum 12-1", d.score ? pct(d.score.momentum_12_1, 0) : "–", "", "Return from 12 months to 1 month ago (Jegadeesh & Titman 1993)", "deep-scores")}
      ${kpi("Factor score", d.score ? `${num(d.score.composite, 0)}/100` : "–", d.score ? `rank ${d.score.rank} of ${d.score.of}` : "", "", "deep-scores")}
    </div>
    <div class="chart-title" id="s-title" data-nofresh></div>
    <div class="chart" id="s-chart" style="min-height:640px">${h.error ? `<div class="empty">${esc(h.error)}</div>` : ""}</div>
    <p class="caption">Candles: blue up, red down. ▲ / ▼ / ● news markers = bullish / bearish / neutral FinBERT average of on-topic headlines,
      placed on the session they first affected. ★ = unusual move; hover for the explanation. ${h.error ? "" : `About two years of daily bars, loaded in your browser from ${esc(h.source)}.`}</p>
    <details><summary>Indicator readings ${mq("indicators")}</summary><ul class="reasons">${(snap.readings || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>
    <div class="grid g2">
      <div><h2>Unusual moves ${mq("explained-moves")}${fresh("deep-prices", "news")}</h2>${table([
        { h: "When", f: (m) => esc(m.d) },
        { h: "Move", r: 1, f: (m) => signed(m.ret, 1) },
        { h: "z", r: 1, f: (m) => num(m.z, 1) },
        { h: "Driver", f: (m) => esc(m.driver) },
        { h: "Explanation", cls: "wrap-text", f: (m) => esc(m.why) },
        { h: "Catalyst", f: (m) => link(m.url) },
      ], [...d.moves].reverse(), { tall: true, empty: "No unusual moves in the last three years." })}</div>
      <div><h2>Headlines ${mq("news-sentiment")}${fresh("news")}</h2>${table([
        { h: "Time (ET)", f: (h) => esc(h.t.slice(5)) },
        { h: "Headline", cls: "wrap-text", f: (h) => link(h.url, h.title) },
        { h: "Source", cls: "clip", f: (h) => esc(h.src || "") },
        { h: "Tone", f: (h) => toneMark[h.tone] || "–" },
        { h: "FinBERT", r: 1, f: (h) => num(h.score, 2, true) },
        { h: "1h reaction", r: 1, f: (h) => pct(h.react, 2) },
      ], d.news, { tall: true, empty: "No on-topic headlines for this ticker yet." })}</div>
    </div>`;
  bindAssetHeader(view, ticker, "stock");
  const draw = () => { toUrl(); if (!h.error) drawStockChart(d); };
  bindChips(view, "span", S.span, false, draw);
  bindChips(view, "layers", S.layers, true, draw);
  bindIndicatorChips(view, draw);
  draw();
}

const deepSeries = (d) => ({ time: d.d, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v });
function drawStockChart(d) {
  const c = pal(), span = [...S.span][0];
  const extra = (x) => {
    const i0 = d.d.indexOf(x[0]), hi = d.h.slice(i0), lo = d.l.slice(i0);
    const inRange = new Set(x), at = new Map(x.map((v, i) => [v, i])), out = [];
    if (S.layers.has("News")) {
      const pts = d.markers.filter((m) => inRange.has(m.d));
      for (const [label, symbol, color] of [["bullish", "triangle-up", c.up], ["bearish", "triangle-down", c.down], ["neutral", "circle", c.muted]]) {
        const p = pts.filter((m) => m.tone === label);
        if (!p.length) continue;
        out.push({ x: p.map((m) => m.d), y: p.map((m) => hi[at.get(m.d)] * 1.02), mode: "markers", name: `News: ${label}`,
          marker: { symbol, size: 11, color, line: { color: c.surface, width: 2 } },
          customdata: p.map((m) => [m.n, ok(m.score) ? m.score.toFixed(2) : "–", m.titles.map((t) => "• " + esc(t).slice(0, 90)).join("<br>")]),
          hovertemplate: "%{customdata[0]} headline(s), FinBERT %{customdata[1]}<br>%{customdata[2]}<extra></extra>" });
      }
    }
    if (S.layers.has("Unusual moves")) {
      const mv = d.moves.filter((m) => inRange.has(m.d));
      if (mv.length) out.push({ x: mv.map((m) => m.d), y: mv.map((m) => (m.ret > 0 ? hi[at.get(m.d)] * 1.045 : lo[at.get(m.d)] * 0.96)),
        mode: "markers", name: "Unusual move", marker: { symbol: "star", size: 14, color: c.ink, line: { color: c.surface, width: 2 } },
        customdata: mv.map((m) => (m.why || "").replace(/(.{1,70})(\s|$)/g, "$1<br>")), hovertemplate: "%{customdata}<extra></extra>" });
    }
    return out;
  };
  $("#s-title").innerHTML = `${esc(d.ticker)} · ${esc(span)} daily${fresh(pxSrc({ source: d.src, dates: d.d }), "news", "deep-prices")}`;
  indicatorChart($("#s-chart"), deepSeries(d), span, { candles: true, height: 560, extra, rangebreaks: true });
}

const U = { span: new Set(["1Y"]), bollinger: new Set() };
async function viewStockUniverse(view, sym, row) {
  const p = pageParams();
  if (p.span) setOne(U.span, Util.oneOf(p.span, ["3M", "6M", "1Y", "All"], "1Y"));
  const toUrl = () => setPageParams("stock", { span: [...U.span][0], ind: indicatorsParam() }, sym);
  shareIndicators = toUrl;
  const [sd, px] = await Promise.all([symbolData(sym), priceHistory(sym).catch((e) => ({ error: e.message }))]);
  const info = (sd && sd.info) || {}, err = px.error;
  const vals = err ? [] : px.close;
  const n = vals.length;
  const ma50 = Q.sma(vals, 50), ma200 = Q.sma(vals, 200), rsi = Q.rsi(vals, 14);
  const last = n ? vals[n - 1] : null, chg = n > 1 ? vals[n - 1] / vals[n - 2] - 1 : null;
  const spread = n && ma200[n - 1] ? ma50[n - 1] / ma200[n - 1] - 1 : null;
  const sub = [row.m, row.sec || CLASS_NAME[row.a], info.ind, info.ex, row.cur].filter(Boolean).map(esc).join(" · ");
  view.innerHTML = `
    ${assetHeader(sym, row.n, sub, "stock")}
    <div class="controls">
      <div class="control"><span class="label">Range</span>${chips("uspan", ["3M", "6M", "1Y", "All"].map((s) => [s, s]), U.span, false)}</div>
    </div>
    <div class="controls" style="margin-top:0">${indicatorChipsHtml(err ? { close: [] } : ohlcv(px))}</div>
    <div class="grid g5">
      ${kpi("Last close", num(last ?? row.px, (last ?? row.px) >= 1000 ? 0 : 2), `${signed(chg ?? row.r1d, 2)}${err ? "" : " · " + esc(px.dates[n - 1])}`)}
      ${kpi("50 vs 200-day MA", pct(spread), spread == null ? "" : spread > 0 ? '<span class="pos">golden-cross alignment</span>' : '<span class="neg">death-cross alignment</span>')}
      ${kpi("RSI (14)", num(rsi[n - 1], 0), ok(rsi[n - 1]) ? (rsi[n - 1] >= 70 ? "overbought" : rsi[n - 1] <= 30 ? "oversold" : "neutral") : "", "", "indicators")}
      ${kpi("Momentum 12-1", pct(row.m121, 0), "", "Return from 12 months to 1 month ago", "momentum")}
      ${kpi("Composite score", ok(row.sc) ? `${num(row.sc, 0)}/100` : "–", `<span class="sig-${esc(row.sig)}">${SIGNAL[row.sig] || "–"}</span>`)}
    </div>
    <div class="chart-title">${esc(sym)} · daily${err ? "" : ` · ${esc(px.source)}, loaded in your browser`}${fresh(pxSrc(px))}</div>
    <div class="chart" id="u-chart" style="min-height:460px">${err ? `<div class="empty">${esc(err)}</div>` : ""}</div>
    ${dqNote(row.dq)}
    ${row.why ? `<div class="note"><b>Why ${SIGNAL[row.sig] || ""}:</b> ${esc(row.why)} <span class="muted">${SIGNAL_NOTE}</span></div>` : ""}
    <div class="grid g2">
      <div><h2>Returns and risk ${mq("returns")}${fresh("scores", "yahoo-prices")}</h2>${table([{ h: "Measure", f: (x) => esc(x[0]) + (x[2] ? mq(x[2]) : "") }, { h: "Value", r: 1, f: (x) => x[1] }], [
        ["1 day", signed(row.r1d, 2)], ["1 week", signed(row.r1w, 2)], ["1 month", signed(row.r1m, 1)], ["3 months", signed(row.r3m, 1)],
        ["Year to date", signed(row.ytd, 1)], ["52 weeks", ok(info.w52) ? signed(info.w52 / 100, 1) : "–"], ["Momentum 12-1", pct(row.m121, 1), "momentum"],
        ["Momentum 6-1", pct(info.m61, 1), "momentum"], ["Distance to 200-day MA", pct(row.d200, 1), "moving-averages"],
        ["Volatility (60-day, annualised)", pct(info.vol ?? row.vol, 1, false), "volatility"],
        ["Max drawdown (1y)", pct(info.mdd ?? row.mdd, 1), "max-drawdown"], ["Last MA cross", info.cross ? `${esc(info.cross)} cross, ${info.cross_ago} sessions ago` : "–", "moving-averages"],
      ])}</div>
      <div><h2>Peer percentiles ${mq("pillars")}${fresh("scores")}</h2>${row.a === "i" ? '<div class="empty">Indices are not scored.</div>' : table([{ h: "Pillar", f: (x) => esc(x[0]) }, { h: "Percentile among peers", f: (x) => bar(x[1]) }], [
        ["Composite", row.sc], ["Trend", row.t], ["Momentum", row.mo], ["Risk (low is better)", row.r], ["Value", row.v], ["Quality", row.q],
        ["Analysts", row.an], ...(row.a === "e" ? [["Cost", row.co]] : []),
      ])}
      <p class="caption">${await isDeep(sym) ? "" : "News markers and explained unusual moves are kept for the deep-tier names; add this one to the deep tier from the local dashboard to get them."}</p></div>
    </div>`;
  bindAssetHeader(view, sym, "stock");
  const draw = () => { toUrl(); if (!err) indicatorChart($("#u-chart"), ohlcv(px), [...U.span][0], { candles: true, height: 460, rangebreaks: row.a !== "c" }); };
  bindChips(view, "uspan", U.span, false, draw);
  bindIndicatorChips(view, draw);
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
  const p = pageParams();
  if (p.model) setOne(F.model, Util.oneOf(p.model, ["FF3", "Carhart", "FF5"], "FF3"));
  setPageParams("financials", { model: [...F.model][0] }, sym);
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
      ${kpi("Signal", `<span class="sig-${esc(r.sig)}">${SIGNAL[r.sig] || "–"}</span>`, ok(r.sc) ? `composite ${num(r.sc, 0)}/100` : "", "", "signal")}
      ${kpi("Year to date", signed(r.ytd, 1))}
      ${kpi("Momentum 12-1", pct(r.m121, 0), "", "", "momentum")}
      ${kpi("Volatility (60-day)", pct(info.vol, 0, false), "", "", "volatility")}
    </div>
    ${dqNote(r.dq || info.dq)}
    <h2>Fundamentals${r.a === "c" ? fresh("coingecko") : r.a === "i" ? fresh("scores") : fresh({ provider: "Yahoo Finance quote summary", label: "This symbol's fundamentals",
      asOf: info.fa, expect: 7, error: info.fa ? null : "not read yet by the rolling refresh" })}</h2>${fundamentalsHtml(r, info)}
    <div class="grid g2">
      <div><h2>Analysts ${mq("pillars")}${fresh("scores")}</h2>${analystHtml(r, sym)}<div id="fh-reco"></div></div>
      <div><h2>Peers${fresh("scores")}</h2><div id="peers"><div class="loading">Loading peers…</div></div></div>
    </div>
    <h2>Financial statements ${mq("sec-financials")}${d && d.fin ? fresh("sec") : usTicker(sym) && FH.key() ? fresh({ provider: "Finnhub", label: "Reported statements, loaded with your key", live: true }) : fresh({ provider: "SEC EDGAR", label: "Statements", error: "kept for the deep tier only" })}</h2><div id="statements"></div>
    <h2 data-nofresh id="ff-title">Factor model ${mq("factor-model")}</h2>
    <div class="controls" style="margin-top:0"><div class="control"><span class="label" title="${esc(MODEL_HELP)}">Model ⓘ</span>
      ${chips("model", [["FF3", "FF3"], ["Carhart", "Carhart"], ["FF5", "FF5"]], F.model, false)}</div></div>
    <div id="ff"><div class="loading">Running the regression…</div></div>
    <details${deep ? " open" : ""}><summary>Watchlist research: factor exposures, composite scores and strategy backtests</summary><div id="wl-research"></div></details>`;
  bindAssetHeader(view, sym, "financials");
  bindChips(view, "model", F.model, false, () => { NOW.params = { model: [...F.model][0] }; viewFinancials(view, sym); });

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
  drawFactorModel(sym, r, model).catch((e) => {
    const el = $("#ff"), title = $("#ff-title");
    if (title && !title.querySelector(".fresh")) title.insertAdjacentHTML("beforeend", fresh(e.dataPath ? "french" : { provider: "Factor model", error: e.message }));
    if (el) el.innerHTML = e.dataPath ? `<div class="unavail"><span class="state red">● missing</span> <code>data/${esc(e.dataPath)}</code> isn't in the published site, so the
      regression isn't drawn. <a href="#/status">Data status</a></div>` : `<div class="empty">${esc(e.message)}</div>`;
  });
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

/** Analyst ratings are licensed data, so the site shows only the calculated Analysts pillar (the
 * consensus ranked against peers) and, with the visitor's own Finnhub key, Finnhub's trends. */
function analystHtml(r, sym) {
  const fh = usTicker(sym) && FH.key();
  return `<div class="card">${ok(r.an)
    ? `<div class="kpi"><div class="label">Analysts pillar</div><div class="value">${num(r.an, 0)}/100</div>
        <div class="sub">The analyst consensus, as a percentile among peers (100 = most favourable)</div></div>`
    : '<div class="empty">No analyst coverage for this name.</div>'}
    <p class="caption">Individual analyst ratings are licensed by data providers, so the site publishes only the calculated Analysts pillar.
      ${fh ? "Recommendation trends from your Finnhub key are below." : "With a free Finnhub key (⚙), US stocks also show Finnhub's recommendation trends."}</p></div>`;
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
    { h: "★", f: (x) => starBtn(x.s) }, { h: "Symbol", f: (x) => routeLink("financials", x.s) }, { h: "Name", cls: "clip", f: (x) => esc(x.n || "") },
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
      <div><div class="chart-title">Quarterly revenue and net income${fresh("sec")}</div><div class="chart" id="f-rev"></div></div>
      <div><div class="chart-title">Quarterly margins${fresh("sec")}</div><div class="chart" id="f-margin"></div></div>
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
  let hist;
  const title0 = $("#ff-title");
  try { hist = await priceHistory(sym); } catch (e) {
    if (title0) title0.insertAdjacentHTML("beforeend", fresh("french", pxSrc({ error: e.message })));
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return;
  }
  const factors = factorData || (factorData = await load("factors.json"));
  const fb = fresh("french", pxSrc(hist)), title = $("#ff-title");
  if (title && !title.querySelector(".fresh")) title.insertAdjacentHTML("beforeend", fb);
  const stock = { dates: hist.dates, returns: Q.returns(hist.values) };
  const e = Q.factorRegression(stock, factors, model);
  const roll = Q.rollingExposures(stock, factors, model, { window: Math.min(Q.TD, Math.floor(e.n_obs / 2)) });
  const cols = Q.MODELS[model];
  const nonUS = r.m && !["US", "US ETFs"].includes(r.m);
  el.innerHTML = `
    <p class="caption">Daily excess returns on the ${esc(model)} factors from Kenneth French's library, ${esc(e.start)} to ${esc(e.end)} (${e.n_obs} days;
      the library lags 1-2 months). About two years of daily prices, loaded in your browser from ${esc(hist.source)}; they may not be adjusted for
      dividends, which lowers alpha by about the dividend yield. Newey-West (5-lag) t-statistics, computed in your browser with the same method as
      the Python models. |t| ≥ 2 is significant.</p>
    ${nonUS ? '<div class="note">These are US factors. For a non-US stock the loadings mix in currency and local-market effects, and markets that close before New York opens show muted same-day betas, so read them as approximate.</div>' : ""}
    <div class="grid g6">${kpi("Alpha / year", pct(e.alpha_annual), `t = ${num(e.alpha_t, 1)}${Math.abs(e.alpha_t) >= 2 ? " · significant" : ""}`, "Return not explained by the factors")}
      ${cols.map((f) => kpi(FACTOR[f], num(e.betas[f], 2), `t = ${num(e.t_stats[f], 1)}${Math.abs(e.t_stats[f]) >= 2 ? " · significant" : ""}`)).join("")}
      ${kpi("R²", num(e.r_squared, 2), `driven by ${esc(e.dominant_driver)}`)}</div>
    ${e.tilts.length ? `<p><b>Reading:</b> ${esc(e.tilts.join(", "))}.</p>` : ""}
    <div class="grid g2">
      <div><div class="chart-title">Factor loadings with 95% confidence intervals${fb}</div><div class="chart" id="f-coef"></div></div>
      <div><div class="chart-title">Where the annual return came from${fb}</div><div class="chart" id="f-waterfall"></div>
        <p class="caption">Annualised: risk-free rate + β × each factor's average premium + alpha.</p></div>
    </div>
    <div class="chart-title">Rolling betas (${roll.d.length ? Math.min(Q.TD, Math.floor(e.n_obs / 2)) : 0}-day window, monthly steps)${fb}</div><div class="chart" id="f-rolling"></div>`;
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
  return `<h3 style="margin-top:12px">Deep-tier factor exposures (${esc(model)}, Python) ${mq("factor-model")}${fresh("deep-prices", "french")}</h3>${table([
      { h: "Ticker", f: (x) => routeLink("financials", x.ticker) },
      { h: "Alpha/yr", r: 1, f: (x) => pct(x.alpha_annual) }, { h: "Alpha t", r: 1, f: (x) => num(x.alpha_t, 1) },
      ...cols.map((f) => ({ h: FACTOR[f], r: 1, f: (x) => num(x.betas[f], 2) })),
      { h: "R²", r: 1, f: (x) => num(x.r_squared, 2) },
      { h: "Stock-specific variance", f: (x) => bar(100 * (x.variance_share?.idiosyncratic ?? NaN)) },
      { h: "Tilts", cls: "wrap-text", f: (x) => esc((x.tilts || []).join(", ")) },
    ], exps)}
    <h3 style="margin-top:18px">Composite factor scores ${mq("deep-scores")}${fresh("deep-prices", "sec")}</h3>
    <p class="caption">Each metric is ranked across the deep tier (0 = worst, 100 = best) and averaged into pillars: Value (E/P, FCF/P, B/M, S/P),
      Quality (ROE, cash ROA, low leverage, low accruals), Momentum (12-1, 6-1).</p>
    ${table([
      { h: "Rank", r: 1, f: (s) => esc(s.rank ?? "–") }, { h: "Ticker", f: (s) => routeLink("financials", s.ticker) },
      { h: "Composite", f: (s) => bar(s.composite) }, { h: "Value", f: (s) => bar(s.value) }, { h: "Quality", f: (s) => bar(s.quality) },
      { h: "Momentum", f: (s) => bar(s.momentum) }, { h: "E/P", r: 1, f: (s) => pct(s.ep, 1, false) }, { h: "FCF/P", r: 1, f: (s) => pct(s.fcfp, 1, false) },
      { h: "B/M", r: 1, f: (s) => num(s.bm, 2) }, { h: "ROE", r: 1, f: (s) => pct(s.roe, 0, false) }, { h: "D/E", r: 1, f: (s) => num(s.de, 2) },
      { h: "Mom 12-1", r: 1, f: (s) => pct(s.m121, 0) },
    ], research.scores)}
    <h3 style="margin-top:18px">Academic strategy backtests ${mq("strategy-backtests")}${fresh("deep-prices", "french")}</h3>${table([
      { h: "Strategy", f: (s) => esc(s.strategy) }, { h: "Paper", cls: "clip", f: (s) => esc(s.paper) },
      { h: "CAGR", r: 1, f: (s) => pct(s.cagr, 1, false) }, { h: "Vol", r: 1, f: (s) => pct(s.vol, 1, false) },
      { h: "Sharpe", r: 1, f: (s) => num(s.sharpe, 2) }, { h: "Max drawdown", r: 1, f: (s) => pct(s.mdd, 1, false) },
      { h: "Turnover/yr", r: 1, f: (s) => num(s.turnover, 1) + "x" }, { h: "Carhart alpha", r: 1, f: (s) => pct(s.alpha) },
      { h: "Alpha t", r: 1, f: (s) => num(s.alpha_t, 1) },
    ], research.strategies)}<p class="caption">${esc(research.note)} Net of 5 bps per unit of turnover.</p>`;
}

// ====================================================================================================
// Router and shell
// ====================================================================================================
const ROUTES = { global: viewGlobal, markets: viewMarkets, stock: viewStock, financials: viewFinancials,
  compare: (view, arg) => viewCompare(view, arg),
  methodology: (view, arg) => (window.METHOD ? window.METHOD.view(view, arg) : (view.innerHTML = '<div class="empty">The Methodology page failed to load.</div>')),
  status: (view, arg) => (window.TRUST ? window.TRUST.status(view, arg) : (view.innerHTML = '<div class="empty">The Data status page failed to load.</div>')),
  changelog: (view, arg) => (window.TRUST ? window.TRUST.changelog(view, arg) : (view.innerHTML = '<div class="empty">The Changelog page failed to load.</div>')),
  "track-record": (view, arg) => (window.TRUST ? window.TRUST.trackRecord(view, arg) : (view.innerHTML = '<div class="empty">The Track record page failed to load.</div>')),
  quantum: (view, arg) => (window.QUANTUM ? window.QUANTUM.view(view, arg) : (view.innerHTML = '<div class="empty">The Quantum page failed to load.</div>')),
  live: (view, arg) => (window.LIVE ? window.LIVE.view(view, arg) : (view.innerHTML = '<div class="empty">Live charts failed to load.</div>')) };
const MOVED = { bot: "#/global" };  // retired routes: old links land somewhere useful
// --- page state in the URL (util.js parseHash / buildHash): a copied link reproduces the view --------
const NOW = { route: "global", params: {} };
/** The "?key=value" state of the link that opened this page. */
const pageParams = () => NOW.params;
/** Write a view's state into the address bar (no reload, no history entry). Ignored when the visitor has
 * already moved to another route, so a slow page can't overwrite the next page's link. */
function setPageParams(route, params, arg) {
  if ((Util.parseHash(location.hash).route || "global") !== route && !(route === "global" && !location.hash.replace(/^#\/?/, ""))) return;
  NOW.params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v === undefined || v === null ? "" : String(v)]).filter(([, v]) => v !== ""));
  const h = Util.buildHash(route, arg, params);
  if (h !== location.hash) history.replaceState(null, "", h);
}
/** Indicator chips from a link (?ind=sma,rsi; "none" = all off); a link never changes the visitor's saved choice. */
function indicatorsFromUrl(p) {
  if (p.ind === undefined) return;
  const known = new Set(["volume", ...Q.INDICATORS.map((i) => i.id)]);
  S_IND.clear();
  Util.listParam(p.ind).filter((id) => known.has(id)).forEach((id) => S_IND.add(id));
}
const indicatorsParam = () => [...S_IND].join(",") || "none";
function setOne(set, value) { set.clear(); set.add(value); }
let cleanup = null;
window.onRouteCleanup = (fn) => { cleanup = fn; };

async function render() {
  const parsed = Util.parseHash(location.hash), name = parsed.route || "global", arg = parsed.arg;
  if (MOVED[name]) { location.replace(MOVED[name]); return; }
  const route = ROUTES[name] ? name : "global";
  Object.assign(NOW, { route, params: parsed.params });
  shareIndicators = () => {};
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  closeDrawer();
  await dataStatus();
  pageSources = PAGE_SOURCES[route] === undefined ? null : PAGE_SOURCES[route];
  document.querySelectorAll("nav.tabs a[data-route]").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  const view = $("#view");
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await ROUTES[route](view, arg);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<h1>Data not available</h1>${e.dataPath
      ? `<div class="unavail"><span class="state red">● missing</span> <code>data/${esc(e.dataPath)}</code> isn't in the published site (${esc(e.message)}),
          so this page shows nothing rather than a partial chart. <a href="#/status">Data status</a> shows which nightly source or export step failed.</div>`
      : `<p class="soft">This page couldn't load its data (${esc(e.message)}).</p>`}
      <p class="soft">The site is refreshed once a day; if this persists, the latest export may not have been published.</p>`;
  }
}

/** Copy the address (the view's state included) to the clipboard, with a fallback for older browsers. */
async function copyLink() {
  const url = location.href;
  let done = false;
  try { await navigator.clipboard.writeText(url); done = true; } catch (e) {
    const ta = Object.assign(document.createElement("textarea"), { value: url });
    document.body.appendChild(ta); ta.select();
    try { done = document.execCommand("copy"); } catch (e2) { done = false; }
    ta.remove();
  }
  toast(done ? "Link copied: it opens this exact view." : `Copy this link: ${url}`);
}
function toast(text) {
  let t = $("#toast");
  if (!t) { t = Object.assign(document.createElement("div"), { id: "toast", className: "toast" }); t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = text; t.classList.add("show");
  clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove("show"), 3200);
}

function settingsDialog() {
  const back = $("#settings-back"), input = $("#fh-key"), status = $("#fh-status"), remember = $("#fh-remember");
  const where = () => (FH.remembered() ? "saved on this device until you remove it" : "kept until you close this tab");
  const open = () => {
    input.value = FH.key(); remember.checked = FH.remembered();
    status.textContent = FH.key() ? `A key is ${where()}.` : "No key saved.";
    back.classList.add("open"); input.focus();
  };
  const close = () => back.classList.remove("open");
  $("#settings").addEventListener("click", open);
  $("#settings-close").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  $("#fh-remove").addEventListener("click", () => { FH.forget(); input.value = ""; remember.checked = false; status.textContent = "Key removed from this browser."; });
  remember.addEventListener("change", () => { if (FH.key()) { FH.save(FH.key(), remember.checked); status.textContent = `The key is ${where()}.`; } });
  $("#fh-save").addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) { status.textContent = "Paste a key first."; return; }
    FH.save(key, remember.checked);
    status.textContent = "Testing…";
    try {
      const q = await FH.get("quote", { symbol: "AAPL" });
      status.textContent = q && q.c ? `Works: AAPL ${q.c}. The key is ${where()}.` : `The test quote came back empty. The key is ${where()}.`;
    } catch (e) { status.textContent = `${e.message}. The key is ${where()}; remove it if it's wrong.`; }
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
  $("#share").addEventListener("click", copyLink);
  $("#theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
    render();
  });
  window.addEventListener("hashchange", render);
  watchPanels();
  render();
}
// Deferred scripts (quant.js, app.js, live.js) all run before DOMContentLoaded, so every route exists by then.
if (document.readyState === "complete") shell(); else window.addEventListener("DOMContentLoaded", shell);
