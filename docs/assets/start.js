/* Start here (#/start): where a first-time visitor lands. Three guided examples, each one click: the
 * link opens the right page with its state already filled in (util.js buildHash), so the same links
 * also work when shared.
 */
(function (root) {
  "use strict";

  const PEERS = ["005930.KS", "000660.KS", "TSM", "AAPL", "NVDA"];
  const BASKET = ["005930.KS", "AAPL", "NVDA", "TSM", "MSFT"];
  const EXAMPLES = [
    { id: "peers", icon: "⇄", title: "Compare Samsung-style big tech peers",
      what: "Samsung Electronics next to SK hynix, TSMC, Apple and Nvidia: returns, risk, factor exposures, margins and how closely they move together.",
      href: Util.buildHash("compare", PEERS.join(","), { years: 2, model: "FF3", cw: "1Y", co: "cluster" }), cta: "Compare the five" },
    { id: "risk", icon: "⚠", title: "How risky is my basket?",
      what: "A $10,000 basket split equally across Samsung, Apple, Nvidia, TSMC and Microsoft: the worst day in 20 (VaR) and the average of the days beyond it (CVaR), from two years of prices. Add or drop stocks and the numbers follow.",
      href: Util.buildHash("quantum", "risk", { syms: BASKET.join(","), w: BASKET.map(() => 20).join(","), look: 500, amt: 10000 }), cta: "Measure the risk" },
    { id: "option", icon: "⚛", title: "Price an option and see the quantum version",
      what: "A 90-day call on Apple priced three ways: the Black-Scholes formula, a Monte Carlo simulation, and the nightly quantum amplitude-estimation run, with how many steps each needs for the same accuracy.",
      href: Util.buildHash("quantum", "options", { sym: "AAPL", days: 90, kind: "call", win: 126, n: 100000 }), cta: "Price the option" },
  ];

  async function view(el) {
    const rows = await Promise.all(PEERS.map((s) => rowFor(s).catch(() => null)));
    const peers = rows.filter(Boolean);
    el.innerHTML = `
      <div class="st-hero">
        <h1>Start here</h1>
        <p class="soft">A free research site for stocks, ETFs and coins in 21 markets, built from public data and updated every night. Pick one of these
          to see what it does: each opens a page with everything already filled in. Change anything, then share the address: the link opens the same view.</p>
      </div>
      <div class="grid g3 st-cards">${EXAMPLES.map((x, i) => `
        <div class="card st-card" data-example="${x.id}">
          <span class="st-icon" aria-hidden="true">${x.icon}</span><span class="st-n">${i + 1}</span>
          <h2 data-nofresh><a href="${esc(x.href)}">${esc(x.title)}</a></h2>
          <p class="soft">${esc(x.what)}</p>
          ${x.id === "peers" && peers.length ? `<div class="st-mini">${peers.map((r) => `<span><b>${esc(r.s)}</b> <span class="${tone(r.ytd)}">${pct(r.ytd, 0)}</span></span>`).join("")}
            <span class="muted">year to date${fresh("scores")}</span></div>` : ""}
          <a class="btn primary st-go" href="${esc(x.href)}">${esc(x.cta)} →</a>
        </div>`).join("")}
      </div>
      <h2 data-nofresh>Or look around</h2>
      <div class="grid g4 st-more-links">
        ${[["#/global", "Global screener", "Every stock ≥ $1B, liquid ETF and top coin, with tonight's daily brief"],
           ["#/live/BTCUSDT", "Live chart", "A TradingView-style chart with indicators, drawing tools and price alerts"],
           ["#/track-record", "Signal track record", "How the BUY / HOLD / AVOID labels did afterwards, logged live"],
           ["#/methodology", "Methodology", "How every number is calculated, with the formula and the code"]].map(([h, t, d]) =>
          `<a class="card st-link" href="${h}"><b>${esc(t)}</b><span class="soft">${esc(d)}</span></a>`).join("")}
      </div>
      <p class="soft st-feedback">Found something wrong, or want a feature for your class or project?
        <a href="https://github.com/chanwoo777/quant-platform/issues/new/choose" target="_blank" rel="noopener">Suggest a feature or report a bug on GitHub</a>: there are forms for bugs, data errors and ideas.</p>
      <p class="caption">This page opens first on your first visit; after that the site starts on Global. It's always under <b>Start</b> in the menu.
        ${SIGNAL_NOTE}</p>`;
  }

  root.START = { view, EXAMPLES };
})(typeof window !== "undefined" ? window : globalThis);
