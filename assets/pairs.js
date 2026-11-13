/* Pairs trading lab (#/pairs/TMUS,T): the distance method of the Lecture 7 notebooks (Gatev, Goetzmann &
 * Rouwenhorst 2006) and an Engle-Granger cointegration variant, backtested walk-forward in the visitor's
 * browser on CNBC prices, against buy-and-hold. The maths is Q.pairsBacktest / Q.findPairs in quant.js;
 * tests/test_lab_js.py checks the distance method against a port of the notebook.
 */
(function () {
  "use strict";
  const DEFAULT = ["TMUS", "T"];  // the pair Lecture 7 trades
  const PER_MONTH = { d: 21, w: 52 / 12 };  // bars per month
  const FORM = { d: [6, 12], w: [12, 24, 36] }, TRADE = { d: [3, 6], w: [6, 12] };
  const ENTRIES = [1, 1.5, 2, 2.5, 3], EXITS = [-0.5, 0, 0.5, 1];
  const S = { syms: null, method: new Set(["distance"]), iv: new Set(["d"]), form: new Set(["12"]), trade: new Set(["6"]),
    entry: new Set(["2"]), exit: new Set(["0"]), stop: new Set(["none"]), cost: new Set(["5"]) };
  const one = (set) => [...set][0];
  const histories = new Map();
  const history = (sym, weekly) => {
    const k = `${sym}|${weekly ? "w" : "d"}`;
    if (!histories.has(k)) histories.set(k, priceHistory(sym, weekly ? { weekly: true } : undefined).catch((e) => { histories.delete(k); throw e; }));
    return histories.get(k);
  };

  function fromUrl(arg) {
    const p = pageParams(), syms = String(arg || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => Util.isTicker(s));
    S.syms = syms.length === 2 && syms[0] !== syms[1] ? syms : S.syms || DEFAULT.slice();
    setOne(S.method, Util.oneOf(p.model, ["distance", "coint"], one(S.method)));
    setOne(S.iv, Util.oneOf(p.iv, ["d", "w"], one(S.iv)));
    const iv = one(S.iv);
    setOne(S.form, Util.oneOf(p.look, FORM[iv].map(String), FORM[iv].includes(+one(S.form)) ? one(S.form) : String(FORM[iv][FORM[iv].length - 1])));
    setOne(S.trade, Util.oneOf(p.win, TRADE[iv].map(String), TRADE[iv].includes(+one(S.trade)) ? one(S.trade) : String(TRADE[iv][TRADE[iv].length - 1])));
    setOne(S.entry, Util.oneOf(p.en, ENTRIES.map(String), one(S.entry)));
    setOne(S.exit, Util.oneOf(p.ex, ["0", "0.5"], one(S.exit)));
    setOne(S.stop, Util.oneOf(p.st, ["none", "3", "4"], one(S.stop)));
    setOne(S.cost, Util.oneOf(p.c, ["0", "5", "10", "20"], one(S.cost)));
  }
  const toUrl = () => setPageParams("pairs", { model: one(S.method), iv: one(S.iv), look: one(S.form), win: one(S.trade), en: one(S.entry),
    ex: one(S.exit), st: one(S.stop), c: one(S.cost) }, S.syms.join(","));

  function controls() {
    const iv = one(S.iv);
    return `<div class="controls">
        <div class="control"><span class="label">Stock A</span><div id="pr-a">${searchBox(`A: ${S.syms[0]}`)}</div></div>
        <div class="control"><span class="label">Stock B</span><div id="pr-b">${searchBox(`B: ${S.syms[1]}`)}</div></div>
        <button class="btn" type="button" id="pr-swap" title="Swap A and B">⇄ Swap</button>
      </div>
      <div class="controls" style="margin-top:0">
        <div class="control"><span class="label">Method ${mq("pairs")}</span>${chips("method", [["distance", "Distance (Lecture 7)"], ["coint", "Cointegration (z-score)"]], S.method, false)}</div>
        <div class="control"><span class="label">Prices</span>${chips("iv", [["d", "Daily, 2 years"], ["w", "Weekly, 10 years"]], S.iv, false)}</div>
        <div class="control"><span class="label">Formation window</span>${chips("form", FORM[iv].map((m) => [String(m), `${m} months`]), S.form, false)}</div>
        <div class="control"><span class="label">Trading window</span>${chips("trade", TRADE[iv].map((m) => [String(m), `${m} months`]), S.trade, false)}</div>
      </div>
      <div class="controls" style="margin-top:0">
        <div class="control"><span class="label">Open at</span>${chips("entry", ENTRIES.map((k) => [String(k), `${k} σ`]), S.entry, false)}</div>
        <div class="control"><span class="label">Close at</span>${chips("exit", [["0", "Converged (0)"], ["0.5", "0.5 σ"]], S.exit, false)}</div>
        <div class="control"><span class="label">Stop loss</span>${chips("stop", [["none", "None"], ["3", "3 σ"], ["4", "4 σ"]], S.stop, false)}</div>
        <div class="control"><span class="label">Trading cost</span>${chips("cost", [["0", "0"], ["5", "5 bps"], ["10", "10 bps"], ["20", "20 bps"]], S.cost, false)}</div>
      </div>`;
  }

  async function view(root, arg) {
    fromUrl(arg);
    root.innerHTML = `<h1>Pairs trading lab</h1>
      <p class="soft">Pick two stocks that tend to move together. The backtest estimates their normal gap on a formation window,
        then trades the gap in the next window: short the one that ran ahead, buy the one that lagged, and close when they converge.
        Windows roll forward, so every trade uses only data from before it.</p>
      <div id="pr-controls">${controls()}</div>
      <div id="pr-out"><div class="loading">Loading prices…</div></div>
      <h2 data-nofresh>Find pairs in a sector ${mq("pair-finder")}</h2>
      <p class="caption">Lecture 7, part 1: the sector's 12 largest US stocks, every pair ranked by the sum of squared differences of their prices
        normalised to 1 over the last year, with the return correlation and the Engle-Granger cointegration statistic.</p>
      <div class="controls" style="margin-top:0" id="pf-controls"><div class="control"><span class="label">Sector</span><select id="pf-sector"></select></div>
        <button class="btn" type="button" id="pf-run">Find pairs</button></div>
      <div id="pf-out"></div>
      ${riskNote()}`;
    bindControls(root);
    const sectors = [...new Set((await screenerRows()).filter((r) => r.a === "s" && r.sec).map((r) => r.sec))].sort();
    const sel = $("#pf-sector", root);
    if (sel) {
      sel.innerHTML = sectors.map((s) => `<option${s === "Communication Services" ? " selected" : ""}>${esc(s)}</option>`).join("");
      $("#pf-run", root).addEventListener("click", () => finder(root, sel.value));
    }
    await run(root);
  }

  function bindControls(root) {
    const box = $("#pr-controls", root);
    const pick = (k) => (sym) => {
      sym = String(sym).trim().toUpperCase();
      if (!Util.isTicker(sym)) return;
      const other = S.syms[1 - k];
      if (sym === other) { toast("Pick two different stocks."); return; }
      S.syms[k] = sym; redraw(root);
    };
    bindSearch($("#pr-a", box), pick(0));
    bindSearch($("#pr-b", box), pick(1));
    $("#pr-swap", box).addEventListener("click", () => { S.syms.reverse(); redraw(root); });
    for (const k of ["method", "iv", "form", "trade", "entry", "exit", "stop", "cost"]) {
      bindChips(box, k, S[k], false, () => {
        if (k === "iv") fromUrl(S.syms.join(","));  // keep the windows valid for the new bar size
        redraw(root);
      });
    }
  }
  function redraw(root) {
    $("#pr-controls", root).innerHTML = controls();
    bindControls(root);
    run(root).catch((e) => { console.error(e); $("#pr-out", root).innerHTML = errorBox(e.message, () => run(root)); });
  }

  async function run(root) {
    toUrl();
    const out = $("#pr-out", root), weekly = one(S.iv) === "w", [A, B] = S.syms;
    out.innerHTML = '<div class="loading">Loading prices and running the backtest…</div>';
    const [ha, hb] = await Promise.all([history(A, weekly), history(B, weekly)]);
    await need("research");  // rfRates: FRED's 3-month T-bill history from the nightly export
    const market = await load("market.json").catch(() => null);
    const al = Q.align([{ dates: ha.dates, values: ha.close }, { dates: hb.dates, values: hb.close }]);
    const per = PER_MONTH[one(S.iv)], formation = Math.round(+one(S.form) * per), trading = Math.round(+one(S.trade) * per);
    if (!out.isConnected) return;
    if (al.dates.length < formation + 20) {
      out.innerHTML = errorBox(`${A} and ${B} share only ${al.dates.length} ${weekly ? "weeks" : "days"} of prices: not enough for a ${one(S.form)}-month formation window plus trading. Try a shorter window or weekly prices.`);
      return;
    }
    const ppy = weekly ? 52 : 252, rf = rfRates(market, al.dates, ppy);
    const o = { method: one(S.method), formation, trading, entry: +one(S.entry), exit: +one(S.exit), stop: one(S.stop) === "none" ? null : +one(S.stop),
      cost: +one(S.cost), rf: rf.rates, ppy };
    const bt = Q.pairsBacktest(al.dates, al.values[0], al.values[1], o);
    draw(out, bt, { A, B, ha, hb, al, o, rf, weekly });
  }

  function draw(out, bt, ctx) {
    const { A, B, o } = ctx, s = bt.stats, c = pal();
    const src = fresh(pxSrc(ctx.ha), pxSrc(ctx.hb));
    const statRow = (name, x) => ({ name, ...x });
    const rows = [statRow("Pairs strategy", s.strategy), statRow(`Buy and hold ${A}`, s.a), statRow(`Buy and hold ${B}`, s.b), statRow("Buy and hold, half each", s.mix)];
    const unit = ctx.weekly ? "weeks" : "days";
    out.innerHTML = `
      <div class="grid g6">
        ${kpi("Strategy return", `<span class="${tone(s.strategy.total)}">${pct(s.strategy.total)}</span>`, `${pct(s.strategy.cagr)} a year`)}
        ${kpi("Sharpe ratio", num(s.strategy.sharpe, 2), `half each: ${num(s.mix.sharpe, 2)}`, "Excess return over the 3-month T-bill per unit of volatility, annualised", "cmp-sharpe")}
        ${kpi("Max drawdown", pct(s.strategy.mdd), `half each: ${pct(s.mix.mdd)}`, "Largest fall from a peak of the strategy's value", "cmp-drawdown")}
        ${kpi("Trades", String(s.strategy.trades), ok(s.strategy.winRate) ? `${pct(s.strategy.winRate, 0, false)} profitable` : "none opened")}
        ${kpi("Average hold", ok(s.strategy.avgBars) ? `${num(s.strategy.avgBars, 0)} ${unit}` : "–", `in a position ${pct(s.strategy.exposure, 0, false)} of the time`)}
        ${kpi("Last window", bt.windows.length ? Q.egVerdict(bt.windows[bt.windows.length - 1].eg) : "–", bt.windows.length ? `Engle-Granger t ${num(bt.windows[bt.windows.length - 1].eg, 2)}` : "", "Augmented Dickey-Fuller test on the formation window's log-price residual (MacKinnon critical values: -3.90 at 1%, -3.34 at 5%, -3.05 at 10%)", "cointegration")}
      </div>
      <div class="chart-title">Strategy value against buy and hold${src}</div>
      <div class="chart" id="pr-eq" style="min-height:340px"></div>
      <div class="grid g2">
        <div><div class="chart-title">${o.method === "coint" ? "Spread z-score" : "Gap between the normalised prices"} with the open and close bands${src}</div><div class="chart" id="pr-spread" style="min-height:300px"></div></div>
        <div><div class="chart-title">Prices normalised to 1 at the first trade window, with entries and exits${src}</div><div class="chart" id="pr-px" style="min-height:300px"></div></div>
      </div>
      <div class="chart-title">Drawdown${src}</div>
      <div class="chart" id="pr-dd" style="min-height:220px"></div>
      <h2>Strategy against buy and hold${src}</h2>
      <div id="pr-stats">${table([
        { h: "", f: (r) => esc(r.name) }, { h: "Total return", r: 1, f: (r) => signedPct(r.total) }, { h: "A year", r: 1, f: (r) => signedPct(r.cagr) },
        { h: "Volatility", r: 1, f: (r) => pct(r.vol, 1, false) }, { h: "Sharpe", r: 1, f: (r) => num(r.sharpe, 2) },
        { h: "Sortino", r: 1, f: (r) => num(r.sortino, 2) }, { h: "Max drawdown", r: 1, f: (r) => pct(r.mdd) }], rows)}</div>
      <p class="caption">Risk-free rate: ${esc(ctx.rf.label)}. Each trade puts the strategy's whole value on each leg (long one, short the other), as the
        notebook does${o.method === "coint" ? `; in the cointegration method the second leg is the hedge ratio β times that` : ""}. Signals use each ${ctx.weekly ? "week's" : "day's"} close and trade at that close.
        Left out: the cost of borrowing shares to short, dividends (CNBC closes aren't adjusted for them) and slippage beyond the trading cost you pick.</p>
      <h2>Windows${src}</h2>
      <div id="pr-windows">${table([
        { h: "Formation from", f: (w) => esc(w.formStart) }, { h: "Trading from", f: (w) => esc(w.tradeStart) }, { h: "to", f: (w) => esc(w.tradeEnd) },
        { h: o.method === "coint" ? "Hedge ratio β" : "σ of the gap", r: 1, f: (w) => num(o.method === "coint" ? w.beta : w.sigma, o.method === "coint" ? 2 : 4) },
        { h: "Engle-Granger t", r: 1, f: (w) => num(w.eg, 2) }, { h: "Verdict", f: (w) => esc(Q.egVerdict(w.eg)) },
        { h: `Half-life (${unit})`, r: 1, f: (w) => num(w.halfLife, 1) }, { h: "SSE", r: 1, f: (w) => num(w.sse, 2) }], bt.windows)}</div>
      <h2>Trades${src}</h2>
      <div id="pr-trades">${table([
        { h: "Opened", f: (t) => esc(t.open) }, { h: "Closed", f: (t) => esc(t.close) },
        { h: "Position", f: (t) => esc(t.side.replace("A", A).replace("B", B)) }, { h: unit[0].toUpperCase() + unit.slice(1), r: 1, f: (t) => String(t.bars) },
        { h: "Return", r: 1, f: (t) => signedPct(t.ret, 2) }, { h: "Why closed", f: (t) => esc(t.reason) }], bt.trades.slice().reverse(), { empty: "No trade opened: the gap never passed the open band. Try a lower band or another pair.", tall: true })}</div>
      <h2>Sensitivity: Sharpe ratio for each open and close band${src}</h2>
      <div class="chart" id="pr-grid" style="min-height:280px"></div>
      <p class="caption">Same pair, windows and costs; only the bands change. A result that holds only in one cell is more likely luck than an edge,
        and picking the best cell after seeing this grid overstates what it would have earned.</p>`;

    const x = bt.dates, line = (name, y, color, extra = {}) => Object.assign({ type: "scatter", mode: "lines", name, x, y, line: { color, width: 1.6 } }, extra);
    plot($("#pr-eq", out), [line("Pairs strategy", bt.equity, c.series[0], { line: { color: c.series[0], width: 2.2 } }),
      line(`Buy and hold ${A}`, bt.bh.a, c.series[1]), line(`Buy and hold ${B}`, bt.bh.b, c.series[2]), line("Half each", bt.bh.mix, c.muted, { line: { color: c.muted, dash: "dot", width: 1.4 } })],
    layout(340, { xaxis: dateAxis(), yaxis: yaxis({ title: { text: "Value of 1" } }) }));
    plot($("#pr-spread", out), [line(o.method === "coint" ? "z-score" : "Gap", bt.spread, c.series[0]),
      line("Open band", bt.upper, c.bad, { line: { color: c.bad, dash: "dash", width: 1 } }), line("Open band ", bt.lower, c.bad, { line: { color: c.bad, dash: "dash", width: 1 }, showlegend: false }),
      line("Close band", bt.exitUp, c.good, { line: { color: c.good, dash: "dot", width: 1 } }), line("Close band ", bt.exitDown, c.good, { line: { color: c.good, dash: "dot", width: 1 }, showlegend: false })],
    layout(300, { xaxis: dateAxis(), yaxis: yaxis() }));
    const i0 = o.formation, al = ctx.al;
    const na = x.map((_, k) => al.values[0][i0 + k] / al.values[0][i0]), nb = x.map((_, k) => al.values[1][i0 + k] / al.values[1][i0]);
    const at = new Map(x.map((d, k) => [d, k]));
    const marks = (key, symbol, color, name) => ({ type: "scatter", mode: "markers", name, x: bt.trades.map((t) => t[key]),
      y: bt.trades.map((t) => na[at.get(t[key])]), marker: { symbol, size: 9, color } });
    plot($("#pr-px", out), [line(A, na, c.series[1]), line(B, nb, c.series[2]), marks("open", "triangle-up", c.good, "Opened"), marks("close", "x", c.bad, "Closed")],
      layout(300, { xaxis: dateAxis(), yaxis: yaxis() }));
    const dd = (v) => { let peak = -Infinity; return v.map((y) => { peak = Math.max(peak, y); return y / peak - 1; }); };
    plot($("#pr-dd", out), [line("Pairs strategy", dd(bt.equity), c.series[0], { fill: "tozeroy" }), line("Half each", dd(bt.bh.mix), c.muted, { line: { color: c.muted, dash: "dot" } })],
      layout(220, { xaxis: dateAxis(), yaxis: yaxis({ tickformat: ".0%" }) }));
    const grid = Q.pairsGrid(al.dates, al.values[0], al.values[1], o, ENTRIES, EXITS);
    plot($("#pr-grid", out), [{ type: "heatmap", x: EXITS.map((e) => `close ${e} σ`), y: ENTRIES.map((e) => `open ${e} σ`), z: grid.map((r) => r.map((v) => (ok(v) ? +v.toFixed(2) : null))),
      colorscale: "RdBu", zmid: 0, text: grid.map((r) => r.map((v) => (ok(v) ? v.toFixed(2) : "–"))), texttemplate: "%{text}", hovertemplate: "%{y}, %{x}: Sharpe %{z}<extra></extra>", name: "Sharpe" }],
    layout(280, { showlegend: false, yaxis: yaxis({ autorange: "reversed" }) }));
    csvFor($("#pr-eq", out).parentElement, () => ({ cols: ["date", "strategy", `bh_${A}`, `bh_${B}`, "bh_half_each", "position_A", "gap_or_z"],
      rows: x.map((d, k) => [d, bt.equity[k], bt.bh.a[k], bt.bh.b[k], bt.bh.mix[k], bt.position[k], bt.spread[k]]) }));
  }
  const signedPct = (v, d = 1) => `<span class="${tone(v)}">${pct(v, d)}</span>`;

  async function finder(root, sector) {
    const el = $("#pf-out", root);
    el.innerHTML = '<div class="loading">Loading a year of prices for the sector\'s largest stocks…</div>';
    try {
      const picks = (await screenerRows()).filter((r) => r.a === "s" && r.m === "US" && r.sec === sector && ok(r.cap))
        .sort((p, q) => q.cap - p.cap).slice(0, 12).map((r) => r.s);
      const hs = await Promise.all(picks.map((s) => history(s, false).then((h) => ({ s, h })).catch(() => null)));
      const got = hs.filter((x) => x && x.h.dates.length > 260);
      if (got.length < 2) { el.innerHTML = errorBox("Not enough price histories loaded for this sector. Try again in a moment.", () => finder(root, sector)); return; }
      const al = Q.align(got.map((x) => ({ dates: x.h.dates, values: x.h.close })));
      const i1 = al.dates.length, i0 = Math.max(0, i1 - 252);
      const pairs = Q.findPairs(got.map((x) => x.s), al.values, i0, i1).slice(0, 10);
      el.innerHTML = `${table([
        { h: "Pair", f: (p) => `<b>${esc(p.a)}</b> · <b>${esc(p.b)}</b>` }, { h: "SSE", r: 1, f: (p) => num(p.sse, 2) },
        { h: "Return correlation", r: 1, f: (p) => num(p.rho, 2) }, { h: "Engle-Granger t", r: 1, f: (p) => num(p.eg, 2) },
        { h: "Verdict", f: (p) => esc(Q.egVerdict(p.eg)) },
        { h: "", f: (p) => `<button class="btn q-small" type="button" data-pair="${esc(p.a)},${esc(p.b)}">Backtest</button>` }], pairs)}
        <p class="caption">${got.length} of ${picks.length} stocks loaded; ${esc(al.dates[i0])} to ${esc(al.dates[i1 - 1])}. A low SSE means the prices moved together
          last year, not that they will keep doing so: Lecture 7 advises checking that the businesses are related before trading a pair.</p>`;
      el.querySelectorAll("[data-pair]").forEach((b) => b.addEventListener("click", () => {
        S.syms = b.dataset.pair.split(","); redraw(root);
        $("#pr-out", root).scrollIntoView({ behavior: "smooth", block: "start" });
      }));
    } catch (e) { console.error(e); el.innerHTML = errorBox(e.message, () => finder(root, sector)); }
  }

  window.PAIRS = { view };
})();
