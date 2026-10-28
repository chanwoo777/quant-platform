/* Research tools: Compare (#/compare/AAPL,MSFT,NVDA).
 * Prices load in the visitor's browser (priceHistory: CNBC, or Binance for coins); scores,
 * fundamentals, Fama-French factors and the 3-month T-bill history come from the nightly export.
 * The maths lives in quant.js (Q.riskStats, Q.returnSince, Q.factorRegression, ...), where
 * tests/test_research_js.py checks it against hand calculations.
 */
"use strict";

const CMP = { syms: null, years: 2, model: "FF3" };
const CMP_DEFAULT = ["AAPL", "MSFT", "NVDA"];
let weeklyFactorCache = null;

/** Everything Compare needs about one symbol; prices may fail per symbol (shown as n/a). */
async function compareData(sym) {
  const [row, sd, deep] = await Promise.all([rowFor(sym), symbolData(sym), isDeep(sym)]);
  const [d, daily, weekly] = await Promise.all([
    deep ? load(`deep/${sym.replace("^", "_")}.json`).catch(() => null) : null,
    priceHistory(sym).catch((e) => ({ error: e.message })),
    priceHistory(sym, { weekly: true }).catch((e) => ({ error: e.message })),
  ]);
  return { sym, row: row || {}, info: (sd && sd.info) || {}, fin: d && d.fin, name: (d && d.name) || (row && row.n) || sym, daily, weekly };
}

/** Per-period risk-free rates from FRED DGS3MO's daily history (annual %), as of each date. */
function rfRates(market, dates, ppy) {
  const rf = market && market.rf;
  if (!rf) return { rates: dates.map(() => 0), label: "none (no FRED data in this export)" };
  const h = rf.history;
  if (!h || !h.d || !h.d.length) return { rates: dates.map(() => rf.value / 100 / ppy), label: `FRED ${rf.id}, latest value ${num(rf.value, 2)}% for every period` };
  return { rates: dates.map((d) => { const v = Q.valueAt(h.d, h.v, d); return (ok(v) ? v : rf.value) / 100 / ppy; }),
    label: `FRED ${rf.id} (3-month T-bill), daily, to ${h.d[h.d.length - 1]}` };
}

/** Simple returns of bars from `start` (ISO), keyed by date (daily) or by weekKey (weekly). */
function periodReturns(h, start, weekly) {
  const out = { dates: [], returns: [], keys: [] };
  for (let i = 1; i < h.close.length; i++) {
    if (h.dates[i] < start) continue;
    out.dates.push(h.dates[i]);
    out.keys.push(weekly ? Q.weekKey(h.dates[i]) : h.dates[i]);
    out.returns.push(h.close[i] / h.close[i - 1] - 1);
  }
  return out;
}

/** Window metrics for one symbol: risk vs the benchmark, drawdown and a factor regression. */
function windowMetrics(t, bench, ctx) {
  const weekly = CMP.years > 2, h = weekly ? t.weekly : t.daily, b = weekly ? bench.weekly : bench.daily;
  if (!h || h.error) return { error: (h && h.error) || "no prices" };
  const end = h.dates[h.dates.length - 1], start = Q.shiftIso(end, { years: CMP.years }), ppy = weekly ? 52 : Q.TD;
  const pr = periodReturns(h, start, weekly);
  if (pr.returns.length < (weekly ? 52 : 120)) return { error: `only ${pr.returns.length} ${weekly ? "weeks" : "days"} of prices in the window` };
  const out = { start: pr.dates[0], end, n: pr.returns.length, ppy, weekly };
  const rf = rfRates(ctx.market, pr.dates, ppy);
  out.rfLabel = rf.label;
  let benchRets = null;
  if (b && !b.error) {
    const br = periodReturns(b, start, weekly), bm = new Map(br.keys.map((k, i) => [k, br.returns[i]]));
    const pairs = pr.keys.map((k, i) => [pr.returns[i], bm.get(k)]).filter((p) => ok(p[1]));
    if (pairs.length >= (weekly ? 40 : 100)) out.beta = Q.riskStats(pairs.map((p) => p[0]), { bench: pairs.map((p) => p[1]), ppy }).beta;
  }
  Object.assign(out, Q.riskStats(pr.returns, { rf: rf.rates, ppy }), { beta: out.beta ?? NaN });
  out.mdd = Q.maxDrawdown(h.close.filter((_, i) => h.dates[i] >= start));
  if (t.row.a === "s" || (!t.row.a && t.fin)) {
    try {
      const factors = weekly ? (weeklyFactorCache || (weeklyFactorCache = Q.weeklyFactors(ctx.factors))) : ctx.factors;
      const e = Q.factorRegression({ dates: pr.keys, returns: pr.returns }, factors, CMP.model, { window: 1e9, minObs: weekly ? 60 : 120 });
      out.ff = Object.assign(e, { alpha: e.alpha_annual * (weekly ? 52 / Q.TD : 1) });
    } catch (err) { out.ffError = err.message; }
  } else out.ffError = "not estimated for ETFs, coins and indices";
  return out;
}

/** Fundamentals with their source: SEC EDGAR for the deep tier, else Yahoo via the nightly export. */
function fundamentals(t, ctx) {
  const i = t.info, sec = t.fin, rs = (ctx.research.scores || []).find((s) => s.ticker === t.sym);
  const v = (value, src) => ({ value: ok(value) ? value : NaN, src: ok(value) ? src : "" });
  const last = t.daily && !t.daily.error ? t.daily.close[t.daily.close.length - 1] : t.row.px;
  const eps = sec && sec.ttm && sec.ttm.eps;
  return {
    revenue_growth: sec && sec.growth && ok(sec.growth.revenue_yoy) ? v(sec.growth.revenue_yoy, "SEC") : v(i.rg, "Yahoo"),
    gross_margin: v(i.gm, "Yahoo"), operating_margin: v(i.om, "Yahoo"),
    net_margin: sec && sec.ttm && sec.ttm.revenue ? v(sec.ttm.net_income / sec.ttm.revenue, "SEC") : v(i.pm, "Yahoo"),
    roe: rs && ok(rs.roe) ? v(rs.roe, "SEC") : v(i.roe ?? t.row.roe, "Yahoo"),
    debt_to_equity: sec && sec.ttm && ok(sec.ttm.de) ? v(sec.ttm.de, "SEC") : v(ok(i.de) ? i.de / 100 : NaN, "Yahoo"),
    pe: ok(eps) && eps > 0 && ok(last) ? v(last / eps, "SEC EPS") : v(i.tpe, "Yahoo"),
  };
}

// Table rows: [group, label, key, value(t), format, better (+1 higher, -1 lower, 0 none), methodology id]
function compareRows(ctx) {
  const yrs = `${CMP.years}y`, f = (t) => t.m || {}, ff = (t) => (f(t).ff || {}), fu = (t) => t.fu;
  const pct1 = (x) => pct(x, 1), pct1u = (x) => pct(x, 1, false), r2 = (x) => num(x, 2);
  const rows = [
    ["Returns", "1 month", "r1m", (t) => t.ret.m1, pct1, 1, "cmp-returns"],
    ["Returns", "3 months", "r3m", (t) => t.ret.m3, pct1, 1, "cmp-returns"],
    ["Returns", "Year to date", "ytd", (t) => t.ret.ytd, pct1, 1, "cmp-returns"],
    ["Returns", "1 year", "r1y", (t) => t.ret.y1, pct1, 1, "cmp-returns"],
    ["Returns", "3 years, annualised", "r3y", (t) => t.ret.y3, pct1, 1, "cmp-returns"],
    ["Risk", `Volatility (annualised, ${yrs})`, "vol", (t) => f(t).vol, pct1u, -1, "cmp-volatility"],
    ["Risk", `Max drawdown (${yrs})`, "mdd", (t) => f(t).mdd, pct1, 1, "cmp-drawdown"],
    ["Risk", `Sharpe ratio (${yrs})`, "sharpe", (t) => f(t).sharpe, r2, 1, "cmp-sharpe"],
    ["Risk", `Sortino ratio (${yrs})`, "sortino", (t) => f(t).sortino, r2, 1, "cmp-sortino"],
    ["Risk", `Beta vs S&P 500 (${yrs})`, "beta", (t) => f(t).beta, r2, 0, "cmp-beta"],
    ["Factors", `Alpha a year (${CMP.model}, ${yrs})`, "alpha", (t) => ff(t).alpha, pct1, 0, "cmp-factors"],
    ...Q.MODELS[CMP.model].map((c) => ["Factors", FACTOR[c], `b_${c}`, (t) => ({ value: (ff(t).betas || {})[c], t: (ff(t).t_stats || {})[c] }), r2, 0, "cmp-factors"]),
    ["Factors", "R²", "r2", (t) => ff(t).r_squared, r2, 0, "cmp-factors"],
    ["Fundamentals", "Revenue growth (y/y)", "rev_growth", (t) => fu(t).revenue_growth, pct1, 1, "cmp-fundamentals"],
    ["Fundamentals", "Gross margin", "gross_margin", (t) => fu(t).gross_margin, pct1u, 1, "cmp-fundamentals"],
    ["Fundamentals", "Operating margin", "operating_margin", (t) => fu(t).operating_margin, pct1u, 1, "cmp-fundamentals"],
    ["Fundamentals", "Net margin", "net_margin", (t) => fu(t).net_margin, pct1u, 1, "cmp-fundamentals"],
    ["Fundamentals", "Return on equity", "roe", (t) => fu(t).roe, pct1u, 1, "cmp-fundamentals"],
    ["Fundamentals", "Debt / equity", "de", (t) => fu(t).debt_to_equity, r2, -1, "cmp-fundamentals"],
    ["Fundamentals", "P/E (trailing)", "pe", (t) => fu(t).pe, (x) => num(x, 1), 0, "cmp-fundamentals"],
    ["Scores", "Composite score", "score", (t) => t.row.sc, (x) => num(x, 0), 1, "composite"],
    ["Scores", "Signal", "signal", (t) => t.row.sig || null, (x) => (x ? SIGNAL[x] || x : "n/a"), 0, "signal"],
  ];
  return rows;
}
const cellValue = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);

async function viewCompare(view, arg) {
  const meta = await load("meta.json");
  const fromUrl = arg ? arg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  CMP.syms = (fromUrl && fromUrl.length ? fromUrl : CMP.syms || store.get("compare", CMP_DEFAULT)).slice(0, 5);
  view.innerHTML = `
    <h1>Compare</h1>
    <p class="soft">Put 2 to 5 stocks, ETFs, coins or indices side by side: returns, risk, factor exposures and fundamentals. Prices load in your browser;
      everything else comes from the nightly export. The link in the address bar shares this comparison.</p>
    ${basketHtml("cmp", "Add a ticker")}
    <div class="controls">
      <div class="control"><span class="label">Risk and factor window</span><div class="chips" id="cmp-years">${[1, 2, 3].map((y) => `<button type="button" class="chip" data-v="${y}">${y} year${y > 1 ? "s" : ""}</button>`).join("")}</div></div>
      <div class="control"><span class="label">Factor model</span><div class="chips" id="cmp-model">${Object.keys(Q.MODELS).map((m) => `<button type="button" class="chip" data-v="${m}">${m}</button>`).join("")}</div></div>
      <button type="button" class="btn" id="cmp-csv">Download CSV</button>
    </div>
    <div id="cmp-out"><div class="loading">Loading prices…</div></div>
    <div id="cmp-corr"></div>`;
  const B = { syms: CMP.syms };
  let run = 0, last = null;
  const chipsOn = () => {
    view.querySelectorAll("#cmp-years .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === CMP.years));
    view.querySelectorAll("#cmp-model .chip").forEach((b) => b.classList.toggle("on", b.dataset.v === CMP.model));
  };
  const draw = async () => {
    const my = ++run;
    CMP.syms = B.syms.slice();
    store.set("compare", CMP.syms);
    history.replaceState(null, "", `#/compare/${CMP.syms.map(encodeURIComponent).join(",")}`);
    chipsOn();
    const out = $("#cmp-out", view);
    if (CMP.syms.length < 2) { out.innerHTML = '<div class="empty">Add at least two tickers.</div>'; return; }
    out.innerHTML = '<div class="loading">Loading prices…</div>';
    const [items, bench, factors, market, research] = await Promise.all([
      Promise.all(CMP.syms.map(compareData)),
      Promise.all([priceHistory("^GSPC").catch((e) => ({ error: e.message })), priceHistory("^GSPC", { weekly: true }).catch((e) => ({ error: e.message }))])
        .then(([daily, weekly]) => ({ daily, weekly })),
      load("factors.json"), load("market.json").catch(() => null), load("research.json").catch(() => ({ scores: [] })),
    ]);
    if (my !== run) return;
    const ctx = { factors, market, research };
    for (const t of items) {
      const d = t.daily && !t.daily.error ? t.daily : null, w = t.weekly && !t.weekly.error ? t.weekly : null;
      const endD = d ? d.dates[d.dates.length - 1] : null;
      t.ret = {
        m1: d ? Q.returnSince(d.dates, d.close, Q.shiftIso(endD, { months: 1 })) : NaN,
        m3: d ? Q.returnSince(d.dates, d.close, Q.shiftIso(endD, { months: 3 })) : NaN,
        ytd: d ? Q.returnSince(d.dates, d.close, `${Number(endD.slice(0, 4)) - 1}-12-31`) : NaN,
        y1: d ? Q.returnSince(d.dates, d.close, Q.shiftIso(endD, { years: 1 })) : NaN,
        y3: w ? Q.returnSince(w.dates, w.close, Q.shiftIso(w.dates[w.dates.length - 1], { years: 3 }), 3) : NaN,
      };
      t.m = windowMetrics(t, bench, ctx);
      t.fu = fundamentals(t, ctx);
    }
    last = { items, ctx };
    const rows = compareRows(ctx);
    const head = `<tr><th>Metric</th>${items.map((t) => `<th class="r"><a href="#/stock/${encodeURIComponent(t.sym)}">${esc(t.sym)}</a><div class="cmp-name">${esc(t.name)}</div></th>`).join("")}</tr>`;
    let group = "";
    const body = rows.map(([g, label, , get, fmt, better, mid]) => {
      const vals = items.map((t) => get(t)), nums = vals.map(cellValue);
      const finite = nums.filter((x) => ok(x));
      const hi = better && finite.length >= 2 ? Math.max(...finite) : null, lo = better && finite.length >= 2 ? Math.min(...finite) : null;
      const groupRow = g !== group ? `<tr class="cmp-group"><th colspan="${items.length + 1}">${esc(g)}</th></tr>` : "";
      group = g;
      return groupRow + `<tr><td>${esc(label)} ${mq(mid)}</td>${vals.map((x, k) => {
        const n = nums[k], src = x && typeof x === "object" && x.src ? `<span class="cmp-src">${esc(x.src)}</span>` : "";
        const cls = ok(n) && hi !== null && hi !== lo ? (n === (better > 0 ? hi : lo) ? " cmp-best" : n === (better > 0 ? lo : hi) ? " cmp-worst" : "") : "";
        const tstat = x && typeof x === "object" && ok(x.t) ? ` <span class="muted">t ${num(x.t, 1)}</span>` : "";
        const text = typeof n === "string" ? fmt(n) : ok(n) ? fmt(n) : "n/a";
        return `<td class="r${cls}">${text}${tstat}${src}</td>`;
      }).join("")}</tr>`;
    }).join("");
    const winNote = items.map((t) => t.m.error ? `${esc(t.sym)}: ${esc(t.m.error)}` : t.m.ffError && t.row.a === "s" ? `${esc(t.sym)} factors: ${esc(t.m.ffError)}` : "").filter(Boolean);
    const rfLabel = (items.find((t) => t.m.rfLabel) || { m: {} }).m.rfLabel || "FRED DGS3MO";
    const ffAny = items.find((t) => t.m.ff);
    const pxParts = items.map((t) => pxSrc(CMP.years > 2 ? t.weekly : t.daily));
    out.innerHTML = `
      <div class="chart-title">Growth of 100 over ${CMP.years} year${CMP.years > 1 ? "s" : ""} ${mq("cmp-rebased")}${fresh(pxParts)}</div>
      <div class="chart" id="cmp-chart"></div>
      <p class="caption">Rebased to 100 on the first date the charted tickers share; ${CMP.years > 2 ? "weekly" : "daily"} closes to ${esc((items.find((t) => t.daily && !t.daily.error) || { daily: { dates: ["–"] } }).daily.dates.slice(-1)[0])}. Prices: CNBC (Binance for coins), loaded in your browser.</p>
      <div class="chart-title">Side by side${fresh(pxParts, "scores", "yahoo-fundamentals", "french", "fred", items.some((t) => t.fin) ? "sec" : null)}</div>
      <div class="table-wrap cmp-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <p class="caption">Blue: best in the row, red: worst (no colours where higher isn't simply better).
        ${CMP.years > 2 ? "The 3-year window uses weekly prices and weekly-compounded factors, because the browser loads two years of daily prices." : ""}
        Risk-free rate: ${esc(rfLabel)}. Beta against the S&amp;P 500 (CNBC).
        Factors: Kenneth R. French Data Library (${esc(CMP.model)}), daily to ${esc(meta.factors_as_of || "–")}${ffAny ? `; regression window ${esc(ffAny.m.ff.start)} to ${esc(ffAny.m.ff.end)} for ${esc(ffAny.sym)}` : ""}, t-statistics with Newey-West errors.
        Fundamentals: SEC EDGAR filings for deep-tier names, otherwise Yahoo Finance via the nightly export of ${esc(meta.generated_at.slice(0, 10))};
        gross and operating margins are Yahoo's for every name (trailing twelve months), refreshed on a rolling basis, so a few may still show n/a.
        Scores: nightly export, prices as of ${esc(meta.prices_as_of)}.
        ${SIGNAL_NOTE} Not investment advice.</p>
      ${winNote.length ? `<p class="caption">${winNote.join(" · ")}</p>` : ""}`;
    drawCompareChart(items);
    if (typeof window.drawCorrelationPanel === "function") window.drawCorrelationPanel($("#cmp-corr", view), CMP.syms);
  };
  bindBasket(view, "cmp", B, { min: 2, max: 5, minBars: 60, onChange: () => draw().catch(fail) });
  const fail = (e) => { console.error(e); $("#cmp-out", view).innerHTML = `<div class="empty">${esc(e.message)}</div>`; };
  view.querySelectorAll("#cmp-years .chip").forEach((b) => b.addEventListener("click", () => { CMP.years = Number(b.dataset.v); draw().catch(fail); }));
  view.querySelectorAll("#cmp-model .chip").forEach((b) => b.addEventListener("click", () => { CMP.model = b.dataset.v; draw().catch(fail); }));
  $("#cmp-csv", view).addEventListener("click", () => {
    if (!last) return;
    const rows = compareRows(last.ctx);
    const cols = ["metric", ...last.items.map((t) => t.sym)];
    const data = rows.map(([, label, , get]) => Object.fromEntries([["metric", label], ...last.items.map((t) => { const x = cellValue(get(t)); return [t.sym, ok(x) || typeof x === "string" ? x : ""]; })]));
    downloadCsv(`compare_${last.items.map((t) => t.sym).join("_")}.csv`, cols, data);
  });
  await draw().catch(fail);
}

function drawCompareChart(items) {
  const weekly = CMP.years > 2;
  const series = items.map((t) => [t, weekly ? t.weekly : t.daily]).filter(([, h]) => h && !h.error);
  const el = $("#cmp-chart");
  if (series.length < 1) { el.innerHTML = '<div class="empty">No prices to chart.</div>'; return; }
  const keyed = series.map(([t, h]) => ({ dates: h.dates.map((d) => (weekly ? Q.weekKey(d) : d)), values: h.close }));
  const al = Q.align(keyed);
  const end = al.dates[al.dates.length - 1], start = Q.shiftIso(end, { years: CMP.years });
  const i0 = Math.max(0, al.dates.findIndex((d) => d >= start));
  const c = pal(), x = al.dates.slice(i0);
  plot(el, series.map(([t], k) => {
    const v = al.values[k].slice(i0);
    return { x, y: v.map((p) => (100 * p) / v[0]), name: t.sym, line: { color: c.series[k], width: 2 }, hovertemplate: `${esc(t.sym)} %{y:.1f}<extra></extra>` };
  }), layout(360, { hovermode: "x unified", xaxis: dateAxis(), yaxis: yaxis({ title: { text: "Growth of 100", font: { size: 11 } } }) }));
}

function downloadCsv(filename, cols, rows) {
  const quote = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => quote(r[k])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- correlation heatmap (Compare and the Quantum portfolio lab share it) -----------------------------
const CORR = { win: "1Y", order: "cluster" };
const CORR_WINDOWS = { "3M": { months: 3 }, "6M": { months: 6 }, "1Y": { years: 1 }, "3Y": { years: 3, weekly: true } };

/** Correlation of daily returns (weekly for 3Y) for `syms`, drawn into `el` with its own controls. */
async function drawCorrelationPanel(el, syms) {
  if (!el) return;
  const run = (el.corrRun = (el.corrRun || 0) + 1);
  el.innerHTML = `
    <h2 data-nofresh class="corr-title">Correlation of returns ${mq("correlation")}</h2>
    <div class="controls" style="margin-top:0">
      <div class="control"><span class="label">Window</span><div class="chips" data-corr="win">${Object.keys(CORR_WINDOWS).map((w) =>
        `<button type="button" class="chip${w === CORR.win ? " on" : ""}" data-v="${w}">${w}</button>`).join("")}</div></div>
      <div class="control"><span class="label">Order</span><div class="chips" data-corr="order">${[["cluster", "Clustered"], ["alpha", "Alphabetical"]].map(([v, l]) =>
        `<button type="button" class="chip${v === CORR.order ? " on" : ""}" data-v="${v}">${l}</button>`).join("")}</div></div>
    </div>
    <div class="corr-body"><div class="loading">Loading prices…</div></div>`;
  el.querySelectorAll("[data-corr] .chip").forEach((b) => b.addEventListener("click", () => {
    CORR[b.parentElement.dataset.corr] = b.dataset.v;
    drawCorrelationPanel(el, syms);
  }));
  const body = $(".corr-body", el);
  if (syms.length < 2) { body.innerHTML = '<div class="empty">Add at least two tickers.</div>'; return; }
  const w = CORR_WINDOWS[CORR.win], weekly = !!w.weekly;
  const hist = await Promise.all(syms.map((s) => priceHistory(s, { weekly }).catch((e) => ({ error: e.message }))));
  if (run !== el.corrRun) return;  // the basket or a control changed meanwhile
  const have = syms.map((s, i) => [s, hist[i]]).filter(([, h]) => !h.error);
  $(".corr-title", el).insertAdjacentHTML("beforeend", fresh(hist.map(pxSrc)));
  const missing = syms.filter((_, i) => hist[i].error);
  if (have.length < 2) { body.innerHTML = `<div class="empty">Need prices for at least two tickers${missing.length ? ` (none for ${esc(missing.join(", "))})` : ""}.</div>`; return; }
  const al = Q.align(have.map(([, h]) => ({ dates: weekly ? h.dates.map(Q.weekKey) : h.dates, values: h.close })));
  const end = al.dates[al.dates.length - 1], start = Q.shiftIso(end, w);
  const i0 = Math.max(0, al.dates.findIndex((d) => d >= start) - 1);
  const cols = al.values.map((v) => v.slice(i0).slice(1).map((p, t) => p / v[i0 + t] - 1));
  const n = cols[0].length;
  if (n < (weekly ? 26 : 40)) { body.innerHTML = `<div class="empty">Only ${n} shared ${weekly ? "weeks" : "days"} of prices in this window.</div>`; return; }
  const names = have.map(([s]) => s), C = Q.correlationMatrix(cols);
  const order = CORR.order === "cluster" ? Q.clusterOrder(C) : names.map((_, i) => i).sort((a, b) => names[a].localeCompare(names[b]));
  const st = Q.pairStats(C, names);
  const color = (r) => (r >= 0 ? `rgba(42,120,214,${(0.12 + 0.68 * r).toFixed(3)})` : `rgba(227,73,72,${(0.12 + 0.68 * -r).toFixed(3)})`);
  body.innerHTML = `
    <div class="grid g3 corr-kpis">
      ${kpi("Average pairwise correlation", num(st.average, 2), `${st.pairs} pairs`)}
      ${kpi("Most correlated", `${esc(st.most.a)} · ${esc(st.most.b)}`, num(st.most.rho, 2))}
      ${kpi("Least correlated", `${esc(st.least.a)} · ${esc(st.least.b)}`, num(st.least.rho, 2))}
    </div>
    <div class="table-wrap corr-wrap"><table class="corr"><thead><tr><th></th>${order.map((j) => `<th>${esc(names[j])}</th>`).join("")}</tr></thead>
      <tbody>${order.map((i) => `<tr><th>${esc(names[i])}</th>${order.map((j) => `<td style="background:${color(C[i][j])}"
        title="${esc(names[i])} vs ${esc(names[j])}: ${C[i][j].toFixed(3)} over ${n} ${weekly ? "weeks" : "days"}">${C[i][j].toFixed(2)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="caption">Pearson correlation of ${weekly ? "weekly" : "daily"} returns on the ${n} ${weekly ? "weeks" : "trading days"} all ${names.length} share,
      ${esc(al.dates[i0 + 1] || "")} to ${esc(end)}. Blue: move together; red: move opposite. ${CORR.order === "cluster" ? "Clustered: average linkage on 1 − correlation, so similar assets sit together." : ""}
      Prices: CNBC (Binance for coins), loaded in your browser.${missing.length ? ` No prices for ${esc(missing.join(", "))}.` : ""}</p>`;
}
