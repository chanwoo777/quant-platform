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
  const FILES = ["meta.json", "status.json", "global.json", "indices.json", "symbols.json", "factors.json", "market.json", "research.json", "quantum.json", "track.json"];

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
    const sb = fresh({ provider: "Nightly job (status.json)", label: "Data status", asOf: String(doc.generated_at).slice(0, 10) });
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
      <h2>Sources${sb}</h2>
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
        { h: "Notes", cls: "wrap-text", f: (s) => [s.error ? `<span class="neg">${esc(s.error)}</span>` : "", esc(s.note || ""), s.file ? `<span class="muted" translate="no">${esc(s.file)}</span>` : ""].filter(Boolean).join("<br>") },
      ], sources)}
      <h2>Quality checks${sb}</h2>
      <p class="caption">Fail-soft checks on each price table (quant/web/quality.py). A failing series is never dropped silently: its symbol carries a ⚠ in the
        screener and a note on its pages. A check that errors is listed here and the others still run.</p>
      ${table([
        { h: "Source", f: (r) => esc(r.src) }, { h: "Check", f: (r) => esc(CHECK_NAME[r.check] || r.check) },
        { h: "Result", f: (r) => (r.error ? pill("red", "check errored") : r.count ? pill("amber", `${r.count.toLocaleString()} failed`) : pill("green", "passed")) },
        { h: "Examples", cls: "wrap-text", f: (r) => (r.error ? esc(r.error) : examples(r.failed, item)) },
      ], sources.flatMap((s) => Object.entries(s.checks || {}).map(([check, c]) => Object.assign({ src: s.label, check }, c))))}
      <h2>Outliers flagged for review${sb}</h2>
      <p class="caption">Daily moves in the last ${esc((doc.thresholds || {}).outlier_sessions || 5)} sessions beyond ${esc((doc.thresholds || {}).outlier_sigma || 5)} standard
        deviations of the series' previous year of daily returns. Many are real (earnings, a dividend on a T-bill ETF); they are listed so someone looks, not removed.</p>
      ${table([
        { h: "Source", f: (o) => esc(o.src) }, { h: "Symbol", f: (o) => routeLink("stock", o.symbol) }, { h: "Date", f: (o) => esc(o.date) },
        { h: "Move", r: 1, f: (o) => signed(o.move, 1) }, { h: "Standard deviations", r: 1, f: (o) => num(Math.abs(o.sigma), 1) },
      ], outliers, { tall: true, empty: "No outliers in the last sessions." })}
      <h2>Export steps${sb}</h2>
      ${table([
        { h: "Step", f: ([k]) => `<code>${esc(k)}</code>` }, { h: "Result", f: ([, v]) => (v.ok ? pill("green", "ok") : pill("red", "failed")) },
        { h: "Seconds", r: 1, f: ([, v]) => num(v.seconds, 1) }, { h: "Error", cls: "wrap-text", f: ([, v]) => esc(v.error || "") },
      ], steps)}
      <h2>Published files${sb}</h2>
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
      { h: "Size", r: 1, f: (r) => (r.size ? `${num(r.size / 1024, 0)} KB` : "–") }, { h: "Last modified", f: (r) => raw(r.modified || "–") },
    ], rows);
  }
  const CHECK_NAME = { duplicates: "Duplicates", gaps: "Gaps (3+ missing sessions)", negative_prices: "Negative or zero prices",
    zero_volume: "Zero volume (5+ of 20 sessions)", unit_changes: "Unit changes (20x one-day jumps)" };

  // --- Signal track record (#/track-record): track.json, from quant/web/track.py ----------------------
  const SIG_ORDER = ["BUY", "HOLD", "AVOID"];
  async function trackRecord(view) {
    const t = await load("track.json");
    const min = t.min_observations || 60;
    const few = Object.values(t.horizons || {}).some((per) => SIG_ORDER.some((s) => (per[s] || {}).observations < min));
    const tonight = t.tonight || {};
    view.innerHTML = `
      <h1>Signal track record</h1>
      <p class="soft">Every night the job appends that night's BUY / HOLD / AVOID labels to a log that is never rewritten, then measures what each label's names
        did over the next 5, 20 and 60 trading days against their market's index. The log started on <b>${esc(t.start || "–")}</b>: there is no backfilled
        history, so nothing here was computed with hindsight. ${SIGNAL_NOTE}</p>
      ${few ? `<div class="note dq-note"><b>Too few observations to judge.</b> At least one row below has fewer than ${min} signal dates whose horizon has passed.
        Treat those numbers as a log being built, not as evidence that the labels work or don't.</div>` : ""}
      <div class="grid g5">
        ${kpi("Log started", esc(t.start || "–"), "first signal date logged live")}
        ${kpi("Days logged", (t.days_logged || 0).toLocaleString(), t.last ? `latest ${esc(t.last)}` : "")}
        ${kpi("Tonight", tonight.logged ? "Logged" : "Not logged", esc(tonight.reason || ""))}
        ${kpi("Hash chain", t.verify && t.verify.ok ? '<span class="pos">Verified</span>' : '<span class="neg">Problem</span>',
          t.verify && t.verify.ok ? `${t.verify.entries} files match their SHA-256` : esc((t.verify && t.verify.problems || []).join("; ")))}
        ${kpi("Benchmarks", "Market index", "S&P 500 for the US, BTC for coins, …")}
      </div>
      ${Object.entries(t.horizons || {}).map(([h, per]) => `
        <h2>After ${esc(h)} trading days${fresh("track")}</h2>
        ${table([
          { h: "Signal", f: (s) => `<span class="sig-${esc(s)}">${SIGNAL[s] || esc(s)}</span>` },
          { h: "Observations (signal dates)", r: 1, f: (s) => `${(per[s].observations || 0).toLocaleString()}${per[s].observations < min ? ` <span class="state amber">fewer than ${min}</span>` : ""}` },
          { h: "Name-days", r: 1, f: (s) => (per[s].names || 0).toLocaleString() },
          { h: "Avg return", r: 1, f: (s) => signed(per[s].avg_return, 2) },
          { h: "Benchmark", r: 1, f: (s) => signed(per[s].avg_benchmark, 2) },
          { h: "Excess", r: 1, f: (s) => signed(per[s].avg_excess, 2) },
          { h: "Hit rate", r: 1, f: (s) => (ok(per[s].hit_rate) ? `${num(100 * per[s].hit_rate, 0)}%` : "–") },
          { h: "Hit means", cls: "wrap-text", f: (s) => esc(per[s].hit_rule || (s === "AVOID" ? "underperformed its benchmark" : "beat its benchmark")) },
          { h: "Signal dates", f: (s) => (per[s].first ? `${esc(per[s].first)} to ${esc(per[s].last)}` : "none matured yet") },
        ], SIG_ORDER)}`).join("")}
      <p class="caption">${esc(t.method || "")}</p>
      <h2>The log, day by day${fresh("track")}</h2>
      <p class="caption">Each day's file is written once and never changed. Its SHA-256 is recorded with the hash of the previous line, so editing any earlier day
        breaks the chain. The latest ${(t.published_days || []).length} days' signals (without prices) can be downloaded.</p>
      ${table([
        { h: "Signal date", f: (d) => esc(d.date) }, { h: "BUY", r: 1, f: (d) => num(d.buy, 0) }, { h: "HOLD", r: 1, f: (d) => num(d.hold, 0) },
        { h: "AVOID", r: 1, f: (d) => num(d.avoid, 0) }, { h: "Logged at", f: (d) => esc(String(d.logged_at || "").replace("T", " ").slice(0, 16)) },
        { h: "SHA-256", f: (d) => `<code translate="no" title="${esc(d.sha256)}">${esc(String(d.sha256).slice(0, 12))}…</code>` },
        { h: "Signals", f: (d) => ((t.published_days || []).includes(d.date) ? `<a href="data/track/signals_${esc(d.date)}.csv" download>CSV</a>` : "–") },
      ], [...(t.days || [])].reverse(), { tall: true, empty: "Nothing logged yet." })}`;
  }

  // --- Changelog (#/changelog): changelog.json, from quant/web/changelog.py --------------------------
  async function changelogView(view) {
    const c = await load("changelog.json");
    const entries = c.entries || [], method = entries.filter((e) => e.methodology);
    const badge = fresh({ provider: "Git history", label: "Changelog", asOf: String(c.generated_at).slice(0, 10), expect: 5 });
    const months = [];
    for (const e of entries) { const m = e.date.slice(0, 7); if (!months.length || months[months.length - 1][0] !== m) months.push([m, []]); months[months.length - 1][1].push(e); }
    const entry = (e) => `<li class="cl-item${e.methodology ? " cl-method" : ""}"><span class="badge ${e.type === "fix" ? "warn" : "info"}">${esc(e.type)}</span>
      ${e.methodology ? '<span class="badge bad" title="Changes how a number on the site is calculated">methodology</span>' : ""}
      ${e.breaking ? '<span class="badge bad">breaking</span>' : ""}<b translate="no">${esc(e.title)}</b> <span class="muted">${esc(e.date)} ·
      <a href="${esc(e.url)}" target="_blank" rel="noopener"><code>${esc(e.short)}</code></a>${e.scope ? ` · ${esc(e.scope)}` : ""}</span>
      ${e.body ? `<div class="soft" translate="no">${esc(e.body)}</div>` : ""}${e.method_files && e.method_files.length ? `<div class="muted">Calculation files: ${e.method_files.map((f) => `<code>${esc(f)}</code>`).join(", ")}</div>` : ""}</li>`;
    view.innerHTML = `
      <h1>Changelog</h1>
      <p class="soft">Generated from the repository's commit messages: every commit tagged <code>feat:</code> or <code>fix:</code>
        (<a href="https://www.conventionalcommits.org/" target="_blank" rel="noopener">Conventional Commits</a>). Commits that change how a number is calculated are
        marked <span class="badge bad">methodology</span>; read those with the <a href="#/methodology">Methodology</a> page. Untagged commits, mostly before this page existed,
        are in the <a href="${esc(c.repo)}/commits" target="_blank" rel="noopener">full history</a>.${c.stale_reason ? ` <span class="neg">Git wasn't available tonight; this is the last good changelog.</span>` : ""}</p>
      <div class="grid g3">${kpi("Entries", entries.length.toLocaleString(), "feat and fix commits")}${kpi("Methodology changes", method.length.toLocaleString(), "highlighted below")}
        ${kpi("Latest", esc(entries.length ? entries[0].date : "–"), entries.length ? raw(entries[0].title.slice(0, 60)) : "")}</div>
      ${method.length ? `<h2>Methodology changes${badge}</h2><ul class="cl-list">${method.map(entry).join("")}</ul>` : ""}
      <h2>All changes${badge}</h2>
      ${months.length ? months.map(([m, list]) => `<h3>${esc(m)}</h3><ul class="cl-list">${list.map(entry).join("")}</ul>`).join("") : '<div class="empty">No tagged commits yet.</div>'}`;
  }

  root.TRUST = { status, trackRecord, changelog: changelogView };
})(typeof window !== "undefined" ? window : globalThis);
