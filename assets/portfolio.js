/* Portfolio tracker (#/portfolio): holdings the visitor enters, saved only in this browser (qp:v1:portfolio).
 * Prices come live from CNBC or Binance (live.js quotes, refreshed every minute while the page is open),
 * converted to US dollars with CNBC's FX quotes; sectors, markets and signal labels come from the nightly
 * screener. The sums are Q.portfolioSummary / Q.exposure / Q.portfolioHistory in quant.js
 * (tests/test_lab_js.py).
 */
(function () {
  "use strict";
  const KEY = "portfolio", MAX = 200, EVERY = 60000;
  const EXAMPLE = [{ sym: "AAPL", qty: 10, cost: 180 }, { sym: "MSFT", qty: 6, cost: 400 }, { sym: "NVDA", qty: 12, cost: 120 },
    { sym: "005930.KS", qty: 30, cost: 60000 }, { sym: "XOM", qty: 15, cost: 105 }, { sym: "BTC-USD", qty: 0.05, cost: 60000 }];
  const BY = { sec: "Sector", cls: "Asset class", m: "Market", cur: "Currency" };
  const P = { by: new Set(["sec"]), timer: null, quotes: {}, fx: { USD: 1 }, checked: null, error: "" };

  /** Saved holdings, checked: tickers only, finite positive quantities, costs >= 0 or empty, at most MAX. */
  function holdings() {
    const doc = store.get(KEY, null), list = doc && Array.isArray(doc.holdings) ? doc.holdings : [];
    return list.filter((h) => h && Util.isTicker(String(h.sym)) && Number.isFinite(h.qty) && h.qty > 0
      && (h.cost === null || h.cost === undefined || (Number.isFinite(h.cost) && h.cost >= 0))).slice(0, MAX)
      .map((h) => ({ sym: String(h.sym), qty: h.qty, cost: Number.isFinite(h.cost) ? h.cost : null }));
  }
  const save = (list) => store.set(KEY, { version: 1, holdings: list.slice(0, MAX) });
  function upsert(sym, qty, cost) {
    const list = holdings(), i = list.findIndex((h) => h.sym === sym);
    if (i >= 0) {  // a second purchase: add the shares and average the cost
      const h = list[i], q = h.qty + qty;
      list[i] = { sym, qty: q, cost: ok(h.cost) && ok(cost) ? (h.cost * h.qty + cost * qty) / q : ok(h.cost) ? h.cost : cost };
    } else if (list.length < MAX) list.push({ sym, qty, cost: ok(cost) ? cost : null });
    save(list);
  }

  async function view(root) {
    root.innerHTML = `<h1>Portfolio tracker</h1>
      <p class="soft">Log what you hold and see its value, profit and loss, allocation and sector exposure, with live prices.
        Your holdings stay in this browser: nothing is sent anywhere, and "Clear my saved data" at the bottom of the page removes them.</p>
      <div class="controls" id="pt-add">
        <div class="control" style="width:min(300px,100%)"><span class="label">Stock, ETF or coin</span><div id="pt-sym">${searchBox("Search, e.g. AAPL, 005930.KS, BTC")}</div></div>
        <div class="control"><label for="pt-qty">Quantity</label><input id="pt-qty" type="number" min="0" step="any" inputmode="decimal" placeholder="10"></div>
        <div class="control"><label for="pt-cost">Cost per share (optional)</label><input id="pt-cost" type="number" min="0" step="any" inputmode="decimal" placeholder="in its own currency"></div>
        <button class="btn" type="button" id="pt-addbtn">Add</button>
        <span class="caption" id="pt-picked"></span>
      </div>
      <div class="controls" style="margin-top:0">
        <button class="btn" type="button" id="pt-example">Load an example portfolio</button>
        <button class="btn" type="button" id="pt-export">Download CSV</button>
        <label class="btn" for="pt-import">Import CSV</label><input id="pt-import" type="file" accept=".csv,text/csv" hidden>
        <button class="btn" type="button" id="pt-clear">Remove all</button>
      </div>
      <div id="pt-out"></div>${riskNote()}`;
    let picked = null;
    bindSearch($("#pt-sym", root), (sym) => { picked = String(sym).toUpperCase(); $("#pt-picked", root).textContent = tr(`Selected: ${picked}`); $("#pt-qty", root).focus(); });
    $("#pt-addbtn", root).addEventListener("click", async () => {
      const qty = parseFloat($("#pt-qty", root).value), cost = $("#pt-cost", root).value === "" ? null : parseFloat($("#pt-cost", root).value);
      if (!picked || !Util.isTicker(picked)) { toast("Pick a stock, ETF or coin from the search first."); return; }
      if (!(qty > 0)) { toast("Enter a quantity above zero."); return; }
      if (cost !== null && !(cost >= 0)) { toast("The cost per share can't be negative."); return; }
      if (!(await rowFor(picked))) toast(`${picked} isn't in the platform's universe; it's added, but sector and signal won't show.`);
      upsert(picked, qty, cost);
      picked = null; $("#pt-picked", root).textContent = ""; $("#pt-qty", root).value = ""; $("#pt-cost", root).value = "";
      refresh(root, true);
    });
    $("#pt-example", root).addEventListener("click", () => {
      if (holdings().length && !confirm(tr("Replace your holdings with the example portfolio?"))) return;
      save(EXAMPLE); refresh(root, true);
    });
    $("#pt-clear", root).addEventListener("click", () => {
      if (!holdings().length || !confirm(tr("Remove every holding from this browser?"))) return;
      save([]); refresh(root, true);
    });
    $("#pt-export", root).addEventListener("click", () => {
      const list = holdings();
      if (!list.length) { toast("Nothing to download yet."); return; }
      const csv = Util.toCsv(["Free Quant Platform portfolio", `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, Util.DISCLAIMER],
        ["symbol", "quantity", "cost_per_share"], list.map((h) => [h.sym, h.qty, h.cost]));
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: Util.fileName("portfolio", new Date().toISOString().slice(0, 10), "csv") });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $("#pt-import", root).addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 100 * 1024) { toast("That file is larger than 100 KB; a portfolio CSV is much smaller."); return; }
      const rows = parseCsv(await file.text());
      if (!rows.length) { toast("No rows with a symbol and a quantity were found. Columns: symbol, quantity, cost_per_share."); return; }
      if (holdings().length && !confirm(tr(`Replace your holdings with the ${rows.length} rows in this file?`))) return;
      save(rows); refresh(root, true);
    });
    window.onRouteCleanup(stop);
    document.addEventListener("visibilitychange", onVisible);
    await refresh(root, true);
  }
  /** symbol,quantity[,cost] rows; comment (#) and header lines skipped; anything else malformed is dropped. */
  function parseCsv(text) {
    const out = [];
    for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
      const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, "").replace(/^'/, ""));
      if (!cells[0] || cells[0].startsWith("#") || /^symbol$/i.test(cells[0])) continue;
      const sym = cells[0].toUpperCase(), qty = parseFloat(cells[1]), cost = cells[2] === undefined || cells[2] === "" ? null : parseFloat(cells[2]);
      if (Util.isTicker(sym) && qty > 0 && (cost === null || cost >= 0)) out.push({ sym, qty, cost });
      if (out.length >= MAX) break;
    }
    return out;
  }
  function stop() {
    clearTimeout(P.timer); P.timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }
  function onVisible() {
    if (document.hidden) { clearTimeout(P.timer); P.timer = null; return; }
    const root = $("#view");
    if ($("#pt-out", root)) refresh(root, false);
  }

  async function refresh(root, full) {
    clearTimeout(P.timer);
    const out = $("#pt-out", root), list = holdings();
    if (!out) return;
    if (!list.length) {
      out.innerHTML = '<div class="empty">No holdings yet. Add one above, or load the example portfolio to see how the page works.</div>';
      return;
    }
    if (full) out.innerHTML = '<div class="loading">Loading live prices…</div>';
    await need("live");
    const rows = await Promise.all(list.map(async (h) => Object.assign({}, h, { row: await rowFor(h.sym).catch(() => null) })));
    try {
      const [q, fx] = await Promise.all([window.LIVE.quotes(list.map((h) => h.sym)),
        window.LIVE.fxRates(rows.map((r) => (r.row && r.row.cur) || "USD"))]);
      Object.assign(P.quotes, q); P.fx = fx; P.error = "";
    } catch (e) { console.warn("portfolio quotes", e); P.error = "Live prices are unavailable right now; showing the last prices loaded or the nightly close."; }
    P.checked = new Date();
    if (!out.isConnected) return;
    const input = rows.map((r) => {
      const q = P.quotes[r.sym], cur = (r.row && r.row.cur) || "USD", live = q && !q.error && ok(q.price);
      return { sym: r.sym, qty: r.qty, cost: r.cost, cur, fx: P.fx[cur], price: live ? q.price : r.row ? r.row.px : NaN, prev: live ? q.prev : NaN,
        source: live ? q.source : r.row && ok(r.row.px) ? "nightly close" : "no price", name: r.row ? r.row.n : "", sig: r.row ? r.row.sig : "N/A",
        sec: r.row ? (r.row.a === "s" ? r.row.sec || "Other" : CLASS_NAME[r.row.a] || "Other") : "Not in universe", cls: r.row ? CLASS_NAME[r.row.a] || r.row.a : "Unknown",
        m: r.row ? r.row.m : "Unknown" };
    });
    const sum = Q.portfolioSummary(input);
    draw(root, out, sum, full);
    if (!document.hidden) P.timer = setTimeout(() => refresh(root, false), EVERY);
  }

  function draw(root, out, s, full) {
    const c = pal(), stamp = P.checked ? P.checked.toLocaleTimeString() : "";
    const live = { provider: "CNBC / Binance live quotes", label: "Prices loaded in your browser", live: true, error: P.error || undefined };
    const missingFx = s.rows.filter((r) => !ok(r.fx) && r.cur !== "USD").map((r) => r.cur);
    const effN = s.hhi > 0 ? 1 / s.hhi : NaN;
    const body = `
      <div class="grid g5">
        ${kpi("Value (USD)", money(s.total, 2), s.unpriced ? `${s.unpriced} holding${s.unpriced > 1 ? "s" : ""} without a price` : `${s.rows.length} holdings`)}
        ${kpi("Today", `<span class="${tone(s.day)}">${money(s.day, 2)}</span>`, pct(s.dayPct, 2))}
        ${kpi("Unrealised profit / loss", `<span class="${tone(s.pnl)}">${money(s.pnl, 2)}</span>`, pct(s.pnlPct, 1), "Value minus what you paid, for holdings with a cost per share")}
        ${kpi("Largest holding", s.largest ? esc(s.largest.sym) : "–", s.largest ? pct(s.largest.weight, 1, false) : "", "Its share of the portfolio's value")}
        ${kpi("Diversification", ok(effN) ? num(effN, 1) : "–", "effective number of holdings", "1 / sum of squared weights (inverse Herfindahl): 1 means everything is in one holding")}
      </div>
      ${s.largest && s.largest.weight > 0.25 ? `<p class="risk-note" role="note">${esc(s.largest.sym)} is ${pct(s.largest.weight, 0, false)} of the portfolio: one holding's moves dominate its value.</p>` : ""}
      ${P.error ? `<p class="caption">${esc(P.error)}</p>` : ""}
      ${missingFx.length ? `<p class="caption">No exchange rate for ${esc([...new Set(missingFx)].join(", "))}, so those holdings are left out of the US-dollar totals.</p>` : ""}
      <h2>Holdings${fresh(live)}</h2>
      <div id="pt-table">${table([
        { h: "Symbol", f: (r) => routeLink("stock", r.sym) }, { h: "Name", cls: "clip", f: (r) => raw(r.name || "") },
        { h: "Signal", f: (r) => SIGNAL[r.sig] || "–" },
        { h: "Quantity", r: 1, f: (r) => `<input class="pt-edit" type="number" min="0" step="any" value="${esc(String(r.qty))}" data-sym="${esc(r.sym)}" data-k="qty" aria-label="${esc(tr(`Quantity of ${r.sym}`))}">` },
        { h: "Cost / share", r: 1, f: (r) => `<input class="pt-edit" type="number" min="0" step="any" value="${ok(r.cost) ? esc(String(r.cost)) : ""}" data-sym="${esc(r.sym)}" data-k="cost" aria-label="${esc(tr(`Cost per share of ${r.sym}`))}">` },
        { h: "Price", r: 1, f: (r) => `${ok(r.price) ? num(r.price, r.price >= 1000 ? 0 : 2) : "–"} <span class="muted">${esc(r.cur)}</span>` },
        { h: "Today", r: 1, f: (r) => `<span class="${tone(r.dayPct)}">${pct(r.dayPct, 2)}</span>` },
        { h: "Value (USD)", r: 1, f: (r) => money(r.value, 0) }, { h: "Weight", r: 1, f: (r) => pct(r.weight, 1, false) },
        { h: "Profit / loss", r: 1, f: (r) => `<span class="${tone(r.pnl)}">${money(r.pnl, 0)}</span>` },
        { h: "P/L %", r: 1, f: (r) => `<span class="${tone(r.pnlPct)}">${pct(r.pnlPct, 1)}</span>` },
        { h: "Price from", cls: "clip", f: (r) => `<span class="muted">${esc(r.source)}</span>` },
        { h: "", f: (r) => `<button class="btn q-small" type="button" data-del="${esc(r.sym)}" aria-label="${esc(tr(`Remove ${r.sym}`))}">✕</button>` },
      ], s.rows.slice().sort((a, b) => (ok(b.value) ? b.value : -1) - (ok(a.value) ? a.value : -1)), { tall: true })}</div>
      <p class="caption">Prices checked ${esc(stamp)}, every minute while this tab is open. Costs are in each listing's own currency; values and
        profit are in US dollars at today's exchange rate, so a currency move shows up as profit or loss too. ${SIGNAL_NOTE}</p>
      <div class="grid g2">
        <div><h2>Allocation${fresh(live)}</h2><div class="chart" id="pt-pie" style="min-height:320px"></div></div>
        <div><h2>Exposure${fresh(live, "scores")}</h2>
          <div class="controls" style="margin-top:0">${chips("by", Object.entries(BY), P.by, false)}</div>
          <div class="chart" id="pt-exp" style="min-height:280px"></div></div>
      </div>
      <h2>If you had held these for the past year <span id="pt-hist-fresh"></span></h2>
      <div class="grid g4" id="pt-risk"></div>
      <div class="chart" id="pt-hist" style="min-height:320px"><div class="loading">Loading a year of prices…</div></div>
      <p class="caption">Today's quantities priced at each past close and today's exchange rates, against the S&P 500 scaled to the same
        starting value: a look at how this mix behaved, not your actual past returns (it ignores when you bought and sold).</p>`;
    if (full || !$("#pt-table", out)) {
      out.innerHTML = body;
      bindChips(out, "by", P.by, false, () => drawExposure(out, s));
      history(out, s);
    } else {
      const tmp = document.createElement("div"); tmp.innerHTML = body;  // a quote refresh: swap the numbers, keep the charts
      for (const id of ["pt-table"]) $(`#${id}`, out).replaceWith($(`#${id}`, tmp));
      out.querySelector(".grid.g5").replaceWith(tmp.querySelector(".grid.g5"));
    }
    out.querySelectorAll(".pt-edit").forEach((inp) => inp.addEventListener("change", () => {
      const list = holdings(), h = list.find((x) => x.sym === inp.dataset.sym), v = inp.value === "" ? null : parseFloat(inp.value);
      if (!h) return;
      if (inp.dataset.k === "qty") { if (!(v > 0)) { toast("Enter a quantity above zero, or remove the holding."); inp.value = h.qty; return; } h.qty = v; }
      else { if (v !== null && !(v >= 0)) { toast("The cost per share can't be negative."); inp.value = h.cost ?? ""; return; } h.cost = v; }
      save(list); refresh(root, true);
    }));
    out.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      save(holdings().filter((h) => h.sym !== b.dataset.del)); refresh(root, true);
    }));
    const priced = s.rows.filter((r) => ok(r.value) && r.value > 0);
    plot($("#pt-pie", out), [{ type: "pie", hole: 0.55, labels: priced.map((r) => r.sym), values: priced.map((r) => r.value), sort: true, direction: "clockwise",
      textinfo: "label+percent", hovertemplate: "%{label}: $%{value:,.0f} (%{percent})<extra></extra>", marker: { colors: c.series }, name: "Allocation" }],
    layout(320, { showlegend: false, margin: { l: 8, r: 8, t: 8, b: 8 } }));
    drawExposure(out, s);
    csvFor($("#pt-table", out), () => ({ cols: ["symbol", "name", "quantity", "cost_per_share", "currency", "price", "price_source", "value_usd", "weight", "pnl_usd", "pnl_pct"],
      rows: s.rows.map((r) => [r.sym, r.name, r.qty, r.cost, r.cur, r.price, r.source, r.value, r.weight, r.pnl, r.pnlPct]) }));
  }
  function drawExposure(out, s) {
    const field = [...P.by][0], ex = Q.exposure(s.rows, field).slice(0, 12).reverse();
    plot($("#pt-exp", out), [{ type: "bar", orientation: "h", x: ex.map((e) => e.weight), y: ex.map((e) => tr(String(e.key))), marker: { color: pal().series[0] },
      text: ex.map((e) => `${(e.weight * 100).toFixed(1)}%`), textposition: "outside", hovertemplate: "%{y}: %{x:.1%}<extra></extra>", name: BY[field] }],
    layout(Math.max(220, 34 * ex.length + 60), { showlegend: false, xaxis: { tickformat: ".0%", showgrid: false, automargin: true }, yaxis: yaxis({ showgrid: false }) }));
  }
  async function history(out, s) {
    const el = $("#pt-hist", out), priced = s.rows.filter((r) => ok(r.value) && ok(r.fx));
    if (!el) return;
    if (!priced.length) { el.innerHTML = '<div class="empty">No priced holdings to chart.</div>'; return; }
    try {
      const hs = await Promise.all([...priced.map((r) => priceHistory(r.sym).catch(() => null)), priceHistory("^GSPC").catch(() => null)]);
      const spx = hs.pop(), got = priced.map((r, k) => ({ r, h: hs[k] })).filter((x) => x.h && x.h.dates.length > 30);
      if (!got.length || !spx) { el.innerHTML = errorBox("Price histories couldn't be loaded right now.", () => history(out, s)); return; }
      const al = Q.align([...got.map((x) => ({ dates: x.h.dates, values: x.h.close })), { dates: spx.dates, values: spx.close }]);
      const start = Q.shiftIso(al.dates[al.dates.length - 1], { years: 1 }), i0 = Math.max(0, al.dates.findIndex((d) => d >= start));
      const dates = al.dates.slice(i0), closes = al.values.slice(0, got.length).map((v) => v.slice(i0)), idx = al.values[got.length].slice(i0);
      const value = Q.portfolioHistory(closes, got.map((x) => x.r.qty), got.map((x) => x.r.fx));
      const bench = idx.map((v) => (v / idx[0]) * value[0]);
      const pr = Q.returns(value).slice(1), br = Q.returns(idx).slice(1), st = Q.riskStats(pr, { bench: br });
      const total = value[value.length - 1] / value[0] - 1, btotal = idx[idx.length - 1] / idx[0] - 1;
      $("#pt-risk", out).innerHTML = `${kpi("1-year return", `<span class="${tone(total)}">${pct(total)}</span>`, `S&P 500: ${pct(btotal)}`)}
        ${kpi("Volatility", pct(st.vol, 1, false), "annualised", "Standard deviation of daily returns × √252", "cmp-volatility")}
        ${kpi("Beta to the S&P 500", num(st.beta, 2), "1 = moves with the market", "", "cmp-beta")}
        ${kpi("Max drawdown", pct(Q.maxDrawdown(value)), `S&P 500: ${pct(Q.maxDrawdown(idx))}`, "", "cmp-drawdown")}`;
      $("#pt-hist-fresh", out).innerHTML = fresh(...got.map((x) => pxSrc(x.h)).slice(0, 1), pxSrc(spx));
      plot(el, [{ type: "scatter", mode: "lines", name: "This portfolio", x: dates, y: value, line: { color: pal().series[0], width: 2.2 } },
        { type: "scatter", mode: "lines", name: "S&P 500, same start", x: dates, y: bench, line: { color: pal().muted, dash: "dot", width: 1.5 } }],
      layout(320, { xaxis: dateAxis(), yaxis: yaxis({ tickprefix: "$", tickformat: ",.0f" }) }));
      if (got.length < priced.length) el.insertAdjacentHTML("afterend", `<p class="caption">${priced.length - got.length} holding(s) had no price history and are left out of this chart.</p>`);
    } catch (e) { console.error(e); el.innerHTML = errorBox(e.message, () => history(out, s)); }
  }

  window.PORTFOLIO = { view, parseCsv };
})();
