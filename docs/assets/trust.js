/* Pages that make the numbers checkable: Data status (#/status).
 * They read files the nightly export writes (status.json, from quant/web/status.py) and use the
 * helpers in app.js (load, table, kpi, ageDays, sourceState).
 */
(function (root) {
  "use strict";

  const pill = (state, text) => `<span class="state ${esc(state)}">● ${esc(text || STATE_TEXT[state] || state)}</span>`;
  const when = (iso) => (iso ? esc(String(iso).replace("T", " ").replace(/\+00:00$/, " UTC").slice(0, 20)) : "–");
  const count = (x) => (x && ok(x.count) ? x.count.toLocaleString() : "–");
  // The files a visitor's pages load; the status page checks each is published.
  const FILES = ["meta.json", "status.json", "global.json", "indices.json", "symbols.json", "factors.json", "market.json", "research.json", "quantum.json"];

  function examples(list, fmt) {
    if (!list || !list.length) return "";
    return `<details class="st-more"><summary>${list.length} shown</summary><ul class="reasons">${list.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul></details>`;
  }
  const item = (x) => (typeof x === "string" ? esc(x) : `<b>${esc(x.symbol || "table")}</b>${x.date ? ` · ${esc(x.date)}` : ""} · ${esc(x.detail || "")}`);
  const failedChecks = (s) => Object.values(s.checks || {}).reduce((t, c) => t + (ok(c.count) ? c.count : 0), 0);
  const brokenChecks = (s) => Object.entries(s.checks || {}).filter(([, c]) => c.error).map(([k]) => k);

  async function status(view) {
    const doc = await dataStatus();
    if (!doc) {
      view.innerHTML = `<h1>Data status</h1><div class="unavail">${pill("red", "missing")} <code>data/status.json</code> isn't in the published site,
        so the state of tonight's sources is unknown. Every freshness badge shows red until it is.</div>`;
      return;
    }
    const sources = doc.sources.map((s) => Object.assign({}, s, sourceState(s.id)));
    const n = { green: 0, amber: 0, red: 0 };
    sources.forEach((s) => n[s.state]++);
    const steps = Object.entries(doc.export_steps || {});
    const failedSteps = steps.filter(([, v]) => !v.ok);
    const overall = worstState(sources.map((s) => s.state));
    const outliers = sources.flatMap((s) => ((s.outliers || {}).failed || []).map((o) => Object.assign({ src: s.label }, o)));
    view.innerHTML = `
      <h1>Data status</h1>
      <p class="soft">What the nightly job loaded, from where, and what its checks found. Written by the job at ${when(doc.generated_at)}; ages below are
        recomputed for today, so a site that stops updating turns amber, then red. Every freshness badge on the site links here.</p>
      <div class="grid g4">
        ${kpi("Overall", pill(overall), `${n.green} green · ${n.amber} amber · ${n.red} red`)}
        ${kpi("Sources", sources.length.toLocaleString(), "read by the nightly job")}
        ${kpi("Export steps", `${steps.length - failedSteps.length} of ${steps.length} ok`, failedSteps.length ? `failed: ${esc(failedSteps.map(([k]) => k).join(", "))}` : "none failed")}
        ${kpi("Generated", when(doc.generated_at).slice(0, 10), when(doc.generated_at).slice(11))}
      </div>
      <h2>Sources</h2>
      ${table([
        { h: "Source", cls: "wrap-text", f: (s) => `<b>${esc(s.label)}</b><div class="muted">${esc(s.provider)}</div>` },
        { h: "State", f: (s) => pill(s.state) },
        { h: "Data as of", f: (s) => `${esc(s.as_of || "–")}<div class="muted">${ok(s.age) ? `${s.age} ${s.calendar ? "days" : "weekdays"} old; expected ≤ ${s.expect}` : ""}</div>` },
        { h: "Last successful run", f: (s) => when(s.last_success) },
        { h: "Rows", r: 1, f: (s) => (ok(s.rows) ? s.rows.toLocaleString() : "–") },
        { h: "Missing tickers", cls: "wrap-text", f: (s) => `${count(s.missing)}${examples((s.missing || {}).sample, esc)}` },
        { h: "Stale series", cls: "wrap-text", f: (s) => `${count(s.stale)}${examples((s.stale || {}).sample, item)}` },
        { h: "Outliers (review)", r: 1, f: (s) => count(s.outliers) },
        { h: "Check failures", r: 1, f: (s) => (s.checks ? failedChecks(s).toLocaleString() + (brokenChecks(s).length ? ` · ${brokenChecks(s).length} check errored` : "") : "–") },
        { h: "Notes", cls: "wrap-text", f: (s) => [s.error ? `<span class="neg">${esc(s.error)}</span>` : "", esc(s.note || ""), s.file ? `<span class="muted">${esc(s.file)}</span>` : ""].filter(Boolean).join("<br>") },
      ], sources)}
      <h2>Quality checks</h2>
      <p class="caption">Fail-soft checks on each price table (quant/web/quality.py). A failing series is never dropped silently: its symbol carries a ⚠ in the
        screener and a note on its pages. A check that errors is listed here and the others still run.</p>
      ${table([
        { h: "Source", f: (r) => esc(r.src) }, { h: "Check", f: (r) => esc(CHECK_NAME[r.check] || r.check) },
        { h: "Result", f: (r) => (r.error ? pill("red", "check errored") : r.count ? pill("amber", `${r.count.toLocaleString()} failed`) : pill("green", "passed")) },
        { h: "Examples", cls: "wrap-text", f: (r) => (r.error ? esc(r.error) : examples(r.failed, item)) },
      ], sources.flatMap((s) => Object.entries(s.checks || {}).map(([check, c]) => Object.assign({ src: s.label, check }, c))))}
      <h2>Outliers flagged for review</h2>
      <p class="caption">Daily moves in the last ${esc((doc.thresholds || {}).outlier_sessions || 5)} sessions beyond ${esc((doc.thresholds || {}).outlier_sigma || 5)} standard
        deviations of the series' previous year of daily returns. Many are real (earnings, a dividend on a T-bill ETF); they are listed so someone looks, not removed.</p>
      ${table([
        { h: "Source", f: (o) => esc(o.src) }, { h: "Symbol", f: (o) => routeLink("stock", o.symbol) }, { h: "Date", f: (o) => esc(o.date) },
        { h: "Move", r: 1, f: (o) => signed(o.move, 1) }, { h: "Standard deviations", r: 1, f: (o) => num(Math.abs(o.sigma), 1) },
      ], outliers, { tall: true, empty: "No outliers in the last sessions." })}
      <h2>Export steps</h2>
      ${table([
        { h: "Step", f: ([k]) => `<code>${esc(k)}</code>` }, { h: "Result", f: ([, v]) => (v.ok ? pill("green", "ok") : pill("red", "failed")) },
        { h: "Seconds", r: 1, f: ([, v]) => num(v.seconds, 1) }, { h: "Error", cls: "wrap-text", f: ([, v]) => esc(v.error || "") },
      ], steps)}
      <h2>Published files</h2>
      <div id="st-files"><div class="loading">Checking the published files…</div></div>
      <p class="caption">State: green = fresh; amber = older than the source's expected age; red = missing, failed, or more than three times older than expected.
        Ages count weekdays (calendar days for coins). Expected ages differ by source: the Fama-French library is published monthly, one to two months behind.</p>`;
    const rows = await Promise.all(FILES.map(async (f) => {
      try {
        const r = await fetch("data/" + f, { method: "HEAD", cache: "no-store" });
        return { f, ok: r.ok, code: r.status, size: Number(r.headers.get("content-length")) || null, modified: r.headers.get("last-modified") };
      } catch (e) { return { f, ok: false, code: e.message }; }
    }));
    const box = $("#st-files", view);
    if (box) box.innerHTML = table([
      { h: "File", f: (r) => `<code>data/${esc(r.f)}</code>` }, { h: "State", f: (r) => (r.ok ? pill("green", "published") : pill("red", `missing (${r.code})`)) },
      { h: "Size", r: 1, f: (r) => (r.size ? `${num(r.size / 1024, 0)} KB` : "–") }, { h: "Last modified", f: (r) => esc(r.modified || "–") },
    ], rows);
  }
  const CHECK_NAME = { duplicates: "Duplicates", gaps: "Gaps (3+ missing sessions)", negative_prices: "Negative or zero prices",
    zero_volume: "Zero volume (5+ of 20 sessions)", unit_changes: "Unit changes (20x one-day jumps)" };

  root.TRUST = { status };
})(typeof window !== "undefined" ? window : globalThis);
