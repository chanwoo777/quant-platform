/* Credit analysis (#/credit/005930): Korean listings' annual figures from OpenDART (credit/index.json and
 * credit/<code>.json, written by quant/web/export.py from quant/ingestion/opendart.py), the ratios a credit analyst
 * checks, an indicative grade from a weighted scorecard, the five-year trend, a stress test, peers, and a calculator
 * for any company's own figures. The maths is Q.creditRatios / Q.creditScore in quant.js (tests/test_lab_js.py).
 */
(function () {
  "use strict";
  const C = { index: null, stress: { ebitda: 0, rate: 0, debt: 0 } };
  const GRADE_CLASS = (g) => (/^A/.test(g) ? "good" : /^BBB/.test(g) ? "info" : /^BB|^B[+-]?$/.test(g) ? "warn" : "bad");
  const won = (x) => {
    if (!ok(x)) return "–";
    const a = Math.abs(x), s = x < 0 ? "−" : "";
    return a >= 1e12 ? `${s}₩${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${s}₩${(a / 1e9).toFixed(1)}B` : `${s}₩${Math.round(a / 1e6).toLocaleString("en-US")}M`;
  };
  const ratioText = (id, v) => {
    if (v === Infinity) return id === "debt_ebitda" ? "n/m (EBITDA ≤ 0)" : "no debt / interest";
    const f = Q.CREDIT_FACTORS.find((x) => x.id === id);
    return !ok(v) ? "–" : f && f.fmt === "%" ? pct(v, 1, false) : `${num(v, 1)}x`;
  };
  const badge = (g) => `<span class="badge ${GRADE_CLASS(g)}" style="font-size:1.05em">${esc(g)}</span>`;
  // Banks, insurers and brokers file no revenue line and run on borrowed money: industrial ratios don't describe them.
  const financial = (y) => !ok(y.revenue);
  const NA = { score: NaN, grade: "n/a", parts: [], missing: [] };
  const gradeOf = (y) => (financial(y) ? NA : Q.creditScore(Q.creditRatios(y), { revenueKrw: y.revenue }));

  async function view(root, arg) {
    root.innerHTML = `<h1>Credit analysis</h1>
      <p class="soft">Korean companies' annual statements from OpenDART, the ratios a credit analyst checks first (leverage, interest cover,
        EBITDA margin, debt / EBITDA, cash flow / debt) and the indicative grade they map to, with five years of trend.</p>
      <div class="controls"><div class="control" style="width:min(420px,100%)"><label for="cr-q">Company (Korean or English name, or stock code)</label>
        <div class="search"><input id="cr-q" type="search" autocomplete="off" spellcheck="false" placeholder="삼성전자, SK hynix, 005930…"><div class="results" id="cr-results" role="listbox" hidden></div></div></div></div>
      <div id="cr-out"><div class="loading">Loading the company list…</div></div>
      <h2 data-nofresh>Calculator: your own figures ${mq("credit-scorecard")}</h2>
      <p class="caption">For any company, in any currency (one currency throughout). EBITDA = operating income + depreciation and amortisation;
        debt = borrowings + bonds + lease liabilities; interest = interest paid or interest expense.</p>
      <div id="cr-calc"></div>${riskNote()}`;
    calculator($("#cr-calc", root));
    try {
      C.index = C.index || await load("credit/index.json");
    } catch (e) {
      $("#cr-out", root).innerHTML = `<div class="unavail"><span class="state amber">● not set up yet</span> The OpenDART statements aren't in this
        export yet: the nightly job reads them once the site's owner adds a free OpenDART key. The calculator below works without them.</div>`;
      $("#cr-q", root).disabled = true;
      return;
    }
    bindSearchBox(root);
    const code = /^\d{6}$/.test(String(arg || "")) ? arg : null;
    if (code) await company(root, code);
    else overview(root);
  }

  function bindSearchBox(root) {
    const input = $("#cr-q", root), box = $("#cr-results", root);
    const list = C.index.companies;
    const show = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; return; }
      const hits = list.filter((c) => c.c.includes(q) || c.t.toLowerCase().includes(q) || c.n.toLowerCase().includes(q) || (c.e || "").toLowerCase().includes(q)).slice(0, 12);
      box.innerHTML = hits.length ? hits.map((c) => `<div class="opt" role="option" data-code="${esc(c.c)}"><b>${esc(c.n)}</b>${raw(c.e || "")}<em>${esc(c.t)}</em></div>`).join("")
        : '<div class="none">No company with that name or code.</div>';
      box.hidden = false;
    };
    input.addEventListener("input", show);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { const first = box.querySelector("[data-code]"); if (first) first.click(); } });
    box.addEventListener("click", (e) => {
      const o = e.target.closest("[data-code]");
      if (!o) return;
      box.hidden = true; input.value = "";
      location.hash = `#/credit/${o.dataset.code}`;
    });
  }

  /** Every company's latest grade: the distribution and a sortable list. */
  function overview(root) {
    const rows = C.index.companies.map((c) => {
      const y = c.y[c.y.length - 1], prev = c.y.length > 1 ? c.y[0] : null, s = gradeOf(y), r = Q.creditRatios(y);
      return { c, y, s, r, prev: prev ? gradeOf(prev) : null };
    }).filter((x) => ok(x.s.score)).sort((a, b) => a.s.score - b.s.score);
    const counts = Q.CREDIT_GRADES.map((g) => rows.filter((x) => x.s.grade.replace(/[+-]$/, "") === g).length);
    const src = { provider: "OpenDART (FSS)", label: "Annual reports", asOf: String(C.index.fetched_at || "").slice(0, 10), expect: 35 };
    $("#cr-out", root).innerHTML = `
      <h2>Indicative grades across ${rows.length} companies${fresh(src)}</h2>
      <div class="chart" id="cr-dist" style="min-height:260px"></div>
      <div id="cr-list">${table([
        { h: "Company", f: (x) => `<a href="#/credit/${esc(x.c.c)}"><b>${raw(x.c.n)}</b></a> <span class="muted">${esc(x.c.t)}</span>` },
        { h: "Year", r: 1, f: (x) => String(x.y.year) }, { h: "Grade", f: (x) => badge(x.s.grade) },
        { h: "Change", f: (x) => (x.prev && ok(x.prev.score) ? (x.s.score < x.prev.score - 0.15 ? '<span class="pos">▲ better</span>' : x.s.score > x.prev.score + 0.15 ? '<span class="neg">▼ worse</span>' : "–") : "–") },
        { h: "Debt / EBITDA", r: 1, f: (x) => ratioText("debt_ebitda", x.r.debt_ebitda) }, { h: "EBITDA / interest", r: 1, f: (x) => ratioText("coverage", x.r.coverage) },
        { h: "EBITDA margin", r: 1, f: (x) => ratioText("ebitda_margin", x.r.ebitda_margin) }, { h: "Debt / capital", r: 1, f: (x) => ratioText("debt_capital", x.r.debt_capital) },
      ], rows, { tall: true })}</div>
      <p class="caption">Latest fiscal year in each company's annual report; "Change" compares it with the year before. Search above for a company's full analysis.</p>`;
    plot($("#cr-dist", root), [{ type: "bar", x: Q.CREDIT_GRADES, y: counts, marker: { color: pal().series[0] }, text: counts.map(String), textposition: "outside", name: "Companies" }],
      layout(260, { showlegend: false, yaxis: yaxis({ title: { text: "Companies" } }) }));
    csvFor($("#cr-list", root), () => ({ cols: ["ticker", "name", "fiscal_year", "grade", "score", "debt_ebitda", "coverage", "ebitda_margin", "debt_capital", "cfo_debt"],
      rows: rows.map((x) => [x.c.t, x.c.n, x.y.year, x.s.grade, x.s.score, x.r.debt_ebitda, x.r.coverage, x.r.ebitda_margin, x.r.debt_capital, x.r.cfo_debt]) }));
  }

  async function company(root, code) {
    const out = $("#cr-out", root);
    out.innerHTML = '<div class="loading">Loading the statements…</div>';
    let d;
    try { d = await load(`credit/${code}.json`); } catch (e) { out.innerHTML = errorBox(`No OpenDART statements for ${code} in this export.`); return; }
    const row = await rowFor(d.ticker).catch(() => null);
    const years = d.years.map((y) => ({ y, r: Q.creditRatios(y), s: gradeOf(y) }));
    const last = years[years.length - 1], src = { provider: "OpenDART (FSS)", label: "Annual reports", asOf: String(C.index.fetched_at || "").slice(0, 10), expect: 35 };
    const noDa = !ok(last.y.da) && !financial(last.y), report = d.reports[String(Math.max(...Object.keys(d.reports).map(Number)))];
    out.innerHTML = `
      <div class="pc-title"><h2 style="margin:0">${raw(d.name)} <span class="soft">${raw(d.name_en || "")}</span></h2>
        <span class="muted">${esc(d.ticker)}${row && row.sec ? ` · ${esc(tr(row.sec))}` : ""} · ${esc(last.y.fs === "CFS" ? "consolidated" : "separate")} statements</span>
        ${routeLink("stock", d.ticker, "Chart and signals →")}</div>
      <div class="grid g5">
        ${kpi(`Indicative grade, FY${last.y.year}`, badge(last.s.grade), `score ${num(last.s.score, 2)} on 1 (AAA) to 7 (CCC)`, "Weighted scorecard of five ratios; not a credit rating", "credit-scorecard")}
        ${kpi("Debt / EBITDA", ratioText("debt_ebitda", last.r.debt_ebitda), `net of cash: ${ok(last.r.net_debt_ebitda) ? num(last.r.net_debt_ebitda, 1) + "x" : "–"}`)}
        ${kpi("EBITDA / interest", ratioText("coverage", last.r.coverage), last.y.interest_basis ? `interest: ${esc(last.y.interest_basis)}` : "")}
        ${kpi("EBITDA margin", ratioText("ebitda_margin", last.r.ebitda_margin), `EBITDA ${won(last.r.ebitda)}`,
          last.y.da_basis ? `Depreciation and amortisation from the ${last.y.da_basis === "notes (XBRL)" ? "notes to the financial statements (XBRL)" : "cash flow statement"}` : "")}
        ${kpi("Debt / (debt + equity)", ratioText("debt_capital", last.r.debt_capital), `debt ${won(last.r.debt)}`)}
      </div>
      ${financial(last.y) ? '<p class="risk-note" role="note">A bank, insurer or broker: deposits, policy reserves and client money make these industrial ratios meaningless, so no grade is shown. The figures below are as filed.</p>' : ""}
      ${last.y.debt_basis === "financial liabilities" ? '<p class="caption">This company does not itemise borrowings and bonds on its balance sheet, so debt is its "financial liabilities" lines, which can also hold derivatives and other payables: leverage may look a little higher than it is.</p>' : ""}
      ${noDa ? '<p class="caption">Depreciation and amortisation aren\'t in this company\'s filed cash flow statement, so EBITDA is taken as operating income: leverage looks higher and cover lower than they are.</p>' : ""}
      ${last.s.small ? '<p class="caption">Revenue under ₩100 billion: one notch lower for scale.</p>' : ""}
      <div class="grid g2">
        <div><h2>Scorecard, FY${last.y.year}${fresh(src)}</h2>${scorecard(last.s)}</div>
        <div><h2>Stress test</h2>
          <div class="controls" style="margin-top:0">
            <div class="control"><label for="st-e">EBITDA change: <b id="st-ev">0%</b></label><input id="st-e" type="range" min="-60" max="30" step="5" value="${C.stress.ebitda}"></div>
            <div class="control"><label for="st-r">Interest rate: <b id="st-rv">+0 bp</b></label><input id="st-r" type="range" min="0" max="400" step="25" value="${C.stress.rate}"></div>
            <div class="control"><label for="st-d">Debt change: <b id="st-dv">0%</b></label><input id="st-d" type="range" min="-30" max="60" step="5" value="${C.stress.debt}"></div>
          </div><div id="st-out"></div>
          <p class="caption">EBITDA and operating cash flow move together; the rate rise is charged on all debt as extra interest.</p></div>
      </div>
      <h2>Five-year trend${fresh(src)}</h2>
      <div class="grid g2"><div class="chart" id="cr-lev" style="min-height:280px"></div><div class="chart" id="cr-cov" style="min-height:280px"></div></div>
      <div id="cr-years">${table([
        { h: "", f: (x) => `<b>${esc(x.label)}</b>` }, ...years.map((y) => ({ h: `FY${y.y.year}`, r: 1, f: (x) => x.f(y) }))],
      [{ label: "Grade", f: (y) => badge(y.s.grade) }, { label: "Revenue", f: (y) => won(y.y.revenue) }, { label: "Operating income", f: (y) => won(y.y.op_income) },
        { label: "EBITDA", f: (y) => won(y.r.ebitda) + (ok(y.y.da) || financial(y.y) ? "" : "*") }, { label: "Interest", f: (y) => won(y.y.interest) }, { label: "Debt", f: (y) => won(y.r.debt) },
        { label: "Cash", f: (y) => won(y.y.cash) }, { label: "Equity", f: (y) => won(y.y.equity) }, { label: "Operating cash flow", f: (y) => won(y.y.cfo) },
        ...Q.CREDIT_FACTORS.map((f) => ({ label: f.label, f: (y) => ratioText(f.id, y.r[f.id]) })),
        { label: "Current ratio", f: (y) => (ok(y.r.current_ratio) ? `${num(y.r.current_ratio, 2)}x` : "–") }])}</div>
      <p class="caption">${report && report.url ? `Source: ${link(report.url, "the latest annual report on DART")}. ` : ""}Amounts in won. Each report also restates the two years before it; the newest report's figures are used.
        Depreciation and amortisation come from the cash flow statement or, failing that, the XBRL notes.${years.some((y) => !ok(y.y.da) && !financial(y.y)) ? " * EBITDA is operating income for that year: no depreciation figure was filed in a form that can be read (DART tags the notes from fiscal 2023 onwards)." : ""}</p>
      <h2>Peers${fresh(src)}</h2><div id="cr-peers"></div>`;
    $("#st-out", root) && bindStress(root, last.y);
    const x = years.map((y) => `FY${y.y.year}`), c = pal(), cap = (v) => (v === Infinity || !ok(v) ? null : Math.min(v, 30));
    plot($("#cr-lev", root), [{ type: "scatter", mode: "lines+markers", name: "Debt / EBITDA", x, y: years.map((y) => cap(y.r.debt_ebitda)), line: { color: c.series[0] } },
      { type: "scatter", mode: "lines+markers", name: "Debt / capital", x, y: years.map((y) => (ok(y.r.debt_capital) ? y.r.debt_capital * 10 : null)), line: { color: c.series[1], dash: "dot" }, hovertemplate: "%{customdata}<extra>Debt / capital</extra>", customdata: years.map((y) => pct(y.r.debt_capital, 1, false)) }],
    layout(280, { title: { text: tr("Leverage (debt / capital shown ×10)"), font: { size: 13 } }, yaxis: yaxis() }));
    plot($("#cr-cov", root), [{ type: "scatter", mode: "lines+markers", name: "EBITDA / interest", x, y: years.map((y) => cap(y.r.coverage)), line: { color: c.series[2] } },
      { type: "bar", name: "EBITDA margin", x, y: years.map((y) => y.r.ebitda_margin), yaxis: "y2", marker: { color: c.series[3], opacity: 0.45 } }],
    layout(280, { title: { text: tr("Interest cover and margin"), font: { size: 13 } }, yaxis: yaxis(), yaxis2: yaxis({ overlaying: "y", side: "right", tickformat: ".0%", showgrid: false }) }));
    csvFor($("#cr-years", root), () => ({ cols: ["fiscal_year", "grade", "score", "revenue", "op_income", "ebitda", "interest", "debt", "cash", "equity", "cfo", ...Q.CREDIT_FACTORS.map((f) => f.id)],
      rows: years.map((y) => [y.y.year, y.s.grade, y.s.score, y.y.revenue, y.y.op_income, y.r.ebitda, y.y.interest, y.r.debt, y.y.cash, y.y.equity, y.y.cfo, ...Q.CREDIT_FACTORS.map((f) => y.r[f.id])]) }));
    peers(root, d, row);
  }

  function scorecard(s) {
    return table([{ h: "Ratio", f: (p) => esc(p.label) }, { h: "Value", r: 1, f: (p) => ratioText(p.id, p.value) },
      { h: "Band", f: (p) => (p.grade ? badge(Q.CREDIT_GRADES[p.grade - 1]) : "–") }, { h: "Weight", r: 1, f: (p) => pct(p.weight, 0, false) }], s.parts);
  }

  function bindStress(root, base) {
    const draw = () => {
      const e = +$("#st-e", root).value, r = +$("#st-r", root).value, dd = +$("#st-d", root).value;
      C.stress = { ebitda: e, rate: r, debt: dd };
      $("#st-ev", root).textContent = `${e > 0 ? "+" : ""}${e}%`; $("#st-rv", root).textContent = `+${r} bp`; $("#st-dv", root).textContent = `${dd > 0 ? "+" : ""}${dd}%`;
      const ebitda = (ok(base.ebitda) ? base.ebitda : base.op_income) * (1 + e / 100), debt = (base.debt || 0) * (1 + dd / 100);
      const y = Object.assign({}, base, { ebitda, debt, cfo: ok(base.cfo) ? base.cfo * (1 + e / 100) : base.cfo, interest: (base.interest || 0) * (1 + dd / 100) + debt * r / 1e4 });
      const before = gradeOf(base), after = gradeOf(y), ra = Q.creditRatios(y);
      $("#st-out", root).innerHTML = `<p style="font-size:1.1em">${badge(before.grade)} → ${badge(after.grade)}
        <span class="muted">score ${num(before.score, 2)} → ${num(after.score, 2)}</span></p>
        <p class="caption">Debt / EBITDA ${ratioText("debt_ebitda", ra.debt_ebitda)}, EBITDA / interest ${ratioText("coverage", ra.coverage)}, margin ${ratioText("ebitda_margin", ra.ebitda_margin)}.</p>`;
    };
    for (const id of ["#st-e", "#st-r", "#st-d"]) $(id, root).addEventListener("input", draw);
    draw();
  }

  async function peers(root, d, row) {
    const el = $("#cr-peers", root);
    if (!row || !row.sec) { el.innerHTML = '<div class="empty">No sector for this company in the screener, so no peer list.</div>'; return; }
    const bySym = new Map((await screenerRows()).map((r) => [r.s, r]));
    const same = C.index.companies.map((c) => ({ c, r: bySym.get(c.t) })).filter((x) => x.r && x.r.sec === row.sec).map((x) => {
      const y = x.c.y[x.c.y.length - 1];
      return { c: x.c, y, s: gradeOf(y), r: Q.creditRatios(y), me: x.c.c === d.code };
    }).filter((x) => ok(x.s.score)).sort((a, b) => a.s.score - b.s.score);
    el.innerHTML = table([
      { h: "Company", f: (x) => `<a href="#/credit/${esc(x.c.c)}">${x.me ? "<b>" : ""}${raw(x.c.n)}${x.me ? "</b>" : ""}</a>` },
      { h: "Grade", f: (x) => badge(x.s.grade) }, { h: "Debt / EBITDA", r: 1, f: (x) => ratioText("debt_ebitda", x.r.debt_ebitda) },
      { h: "EBITDA / interest", r: 1, f: (x) => ratioText("coverage", x.r.coverage) }, { h: "EBITDA margin", r: 1, f: (x) => ratioText("ebitda_margin", x.r.ebitda_margin) },
      { h: "Revenue", r: 1, f: (x) => won(x.y.revenue) }], same, { empty: "No other company in this sector has statements yet.", rowClass: (x) => (x.me ? "on" : "") });
  }

  function calculator(el) {
    const fields = [["revenue", "Revenue", 1000], ["op_income", "Operating income", 150], ["da", "Depreciation and amortisation", 50], ["interest", "Interest", 20],
      ["debt", "Debt", 500], ["cash", "Cash", 100], ["equity", "Equity", 800], ["cfo", "Operating cash flow", 160]];
    el.innerHTML = `<div class="controls" style="margin-top:0">${fields.map(([k, label, v]) => `<div class="control"><label for="cc-${k}">${esc(label)}</label>
      <input id="cc-${k}" type="number" step="any" value="${v}" inputmode="decimal"></div>`).join("")}</div><div id="cc-out"></div>`;
    const draw = () => {
      const f = Object.fromEntries(fields.map(([k]) => [k, $(`#cc-${k}`, el).value === "" ? NaN : +$(`#cc-${k}`, el).value]));
      f.ebitda = ok(f.da) ? f.op_income + f.da : f.op_income;
      const s = Q.creditScore(Q.creditRatios(f));
      $("#cc-out", el).innerHTML = `<p style="font-size:1.1em">Indicative grade ${badge(s.grade)} <span class="muted">score ${num(s.score, 2)}</span></p>${scorecard(s)}`;
    };
    el.addEventListener("input", draw);
    draw();
  }

  window.CREDIT = { view };
})();
