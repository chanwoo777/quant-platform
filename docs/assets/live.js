/* Pro chart: a TradingView-style live chart drawn by this site (TradingView Lightweight Charts v5),
 * so every indicator, setting and drawing is yours to use without a widget's limits.
 *
 * Data (all keyless, straight from the visitor's browser):
 *   crypto   Binance public market data: REST klines + WebSocket kline/miniTicker streams
 *   stocks   CNBC's chart and quote endpoints (US, Korea, Europe, India, Taiwan, Australia,
 *            Canada, major indices): history, then a poll every 15 s; backs off if throttled
 *   US ticks Finnhub trade WebSocket when the visitor has saved a free key (⚙)
 * The site publishes no price history of its own, so dailyHistory() below also serves every other
 * page that charts a symbol or computes from its past prices (window.LIVE.dailyHistory).
 * Studies, investor playbooks and the indicator maths live in quant.js (tested against Python).
 */
(function () {
  "use strict";
  const LWC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
  const BINANCE_REST = "https://data-api.binance.vision/api/v3";
  const BINANCE_WS = "wss://data-stream.binance.vision/stream?streams=";
  const CNBC_CHART = "https://ts-api.cnbc.com/harmony/app/charts/";
  const CNBC_QUOTE = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1&symbols=";
  const FINNHUB_WS = "wss://ws.finnhub.io?token=";
  const SEC = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
  const LABEL = { "1d": "1D", "1w": "1W", "1M": "1M" };
  const FEED_INTERVALS = {
    binance: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
    cnbc: ["1m", "5m", "15m", "30m", "1h", "1d", "1w", "1M"],
  };
  const CNBC_RANGE = { "1m": "1D", "5m": "5D", "15m": "5D", "30m": "5D", "1h": "5D", "1d": "6M", "1w": "5Y", "1M": "ALL" };
  const CNBC_SUFFIX = { KS: "KR", KQ: "KR", L: "GB", DE: "DE", NS: "IN", BO: "IN", TW: "TW", TWO: "TW", AX: "AU", TO: "CA", V: "CA",
    PA: "FR", AS: "NL", SW: "CH", MI: "IT", MC: "ES", ST: "SE", CO: "DK", HE: "FI", OL: "NO", BR: "BE", SS: "CN", SZ: "CN", T: "JP", HK: "HK" };
  const CNBC_INDEX = { "^GSPC": ".SPX", "^N225": ".N225", "^KS11": ".KS11", "^HSI": ".HSI", "^GSPTSE": ".GSPTSE", "^STOXX": ".STOXX",
    "^TWII": ".TWII", "^NSEI": ".NSEI", "^AXJO": ".AXJO", "^VIX": ".VIX" };
  const CRYPTO_PICKS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
  const STOCK_PICKS = ["AAPL", "NVDA", "TSLA", "SPY", "005930.KS", "^GSPC"];
  const CHART_TYPES = ["Candles", "Hollow candles", "Bars", "Line", "Area", "Heikin Ashi"];
  const TOOLS = [
    ["cursor", "↖", "Cursor (Esc)"], ["trend", "╱", "Trend line (Alt+T)"], ["ray", "↗", "Ray (Alt+Shift+T)"], ["hline", "—", "Horizontal line (Alt+H)"],
    ["vline", "|", "Vertical line (Alt+V)"], ["fib", "Fib", "Fibonacci retracement (Alt+F)"], ["rect", "▭", "Rectangle (Alt+Shift+R)"],
    ["measure", "⇕", "Measure (Alt+M)"],
  ];
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const SHORTCUTS = [
    ["/", "Open indicators"], ["Type 5, 15, 60, 1D, W… then Enter", "Change interval"], ["Alt+T / Alt+Shift+T", "Trend line / ray"],
    ["Alt+H / Alt+V", "Horizontal / vertical line"], ["Alt+F", "Fibonacci retracement"], ["Alt+Shift+R", "Rectangle"], ["Alt+M", "Measure"],
    ["Esc", "Cursor / cancel"], ["Delete", "Remove the selected drawing"], ["Ctrl+Z", "Undo the last drawing"], ["Alt+L", "Log scale"],
    ["Alt+R", "Reset the chart view"], ["Alt+S", "Save a screenshot"], ["Shift+F", "Full screen"], ["Scroll / drag", "Zoom / pan; drag a pane edge to resize it"],
  ];
  const DEFAULT_STUDIES = [{ id: "volume", params: { ma: 20 } }, { id: "ma", params: { type: "EMA", length: 20 } },
    { id: "ma", params: { type: "SMA", length: 50 } }, { id: "ma", params: { type: "SMA", length: 200 } }, { id: "rsi", params: {} }];

  let uidSeq = 0;
  const newInstance = (id, params = {}) => {
    const def = Q.STUDIES.find((s) => s.id === id);
    return { uid: `s${Date.now().toString(36)}${uidSeq++}`, id, hidden: false, colors: {},
      params: Object.assign(Object.fromEntries(def.params.map((p) => [p.key, p.def])), params) };
  };
  const state = {
    type: store.get("pc:type", "Candles"),
    studies: (store.get("pc:studies", null) || DEFAULT_STUDIES.map((s) => newInstance(s.id, s.params))).filter((s) => Q.STUDIES.some((d) => d.id === s.id)),
  };
  const saveStudies = () => store.set("pc:studies", state.studies);
  const loaded = {};
  function loadScript(url, name) {
    if (window[name]) return Promise.resolve();
    if (!loaded[url]) {
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url; s.onload = resolve; s.onerror = () => { delete loaded[url]; reject(new Error(`Couldn't load ${new URL(url).host}`)); };
        document.head.appendChild(s);
      });
    }
    return loaded[url];
  }
  const localShift = () => -new Date().getTimezoneOffset() * 60;
  const isIntraday = (iv) => SEC[iv] < 86400;
  const fmtNum = (x, ref) => {
    if (!Number.isFinite(x)) return "–";
    const r = Math.abs(ref ?? x);
    const d = r >= 1000 ? 2 : r >= 1 ? 2 : r >= 0.01 ? 4 : 6;
    return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

  // ==============================================================================================
  // Symbols and data feeds. Bars: {t (UTC seconds), open, high, low, close, volume}.
  // ==============================================================================================
  async function resolve(arg) {
    const s = String(arg).trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "");
    if (/(USDT|USDC|FDUSD|BTC|ETH)$/.test(s) && /^[A-Z0-9]{5,}$/.test(s) && !(await rowFor(s))) return { sym: s, name: s.replace(/(USDT|USDC|FDUSD)$/, " / $1"), kind: "crypto", feed: "binance", pair: s };
    const row = await rowFor(s);
    if (row && row.a === "c") {
      const pair = s.replace(/\d*-USD$/, "").replace(/[^A-Z0-9]/g, "") + "USDT";
      return { sym: s, name: row.n, kind: "crypto", feed: "binance", pair, row };
    }
    let cnbc = CNBC_INDEX[s];
    if (!cnbc) {
      const m = s.match(/^(.+)\.([A-Z]+)$/);
      cnbc = m && CNBC_SUFFIX[m[2]] ? `${m[2] === "HK" ? m[1].replace(/^0+/, "") : m[1]}-${CNBC_SUFFIX[m[2]]}` : s.replace(/-/g, ".");
    }
    return { sym: s, name: row ? row.n : s, kind: row && row.a === "i" ? "index" : "stock", feed: "cnbc", cnbc, row,
      us: row ? row.m === "US" || row.m === "US ETFs" : usTicker(s), deep: await isDeep(s) };
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (r.status === 403 || r.status === 429) { const e = new Error("throttled"); e.throttled = true; throw e; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  /** Aggregate bars into `sec`-second buckets (UTC-aligned). */
  function aggregate(bars, sec) {
    const out = [];
    for (const b of bars) {
      const t = Math.floor(b.t / sec) * sec, last = out[out.length - 1];
      if (last && last.t === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; }
      else out.push({ t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
    return out;
  }
  const cnbcBars = (json, intraday) => ((json.barData || {}).priceBars || []).map((b) => {
    const tt = String(b.tradeTime);
    const t = intraday ? Math.floor(Number(b.tradeTimeinMills) / 1000) : Date.UTC(+tt.slice(0, 4), +tt.slice(4, 6) - 1, +tt.slice(6, 8)) / 1000;
    return { t, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 };
  }).filter((b) => Number.isFinite(b.close) && b.close > 0);

  const FEEDS = {
    async history(r, iv) {
      if (r.feed === "binance") {
        const res = await fetch(`${BINANCE_REST}/klines?symbol=${r.pair}&interval=${iv}&limit=1000`);
        if (res.status === 400) throw new Error(`Binance has no ${r.pair} pair`);
        if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
        return (await res.json()).map((k) => ({ t: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
      }
      const json = await getJSON(`${CNBC_CHART}${CNBC_RANGE[iv]}.json?symbol=${encodeURIComponent(r.cnbc)}`);
      let bars = cnbcBars(json, isIntraday(iv));
      if (["15m", "30m", "1h"].includes(iv)) bars = aggregate(bars, SEC[iv]);
      if (!bars.length) throw new Error(noData(r));
      return bars;
    },
    /** Live updates; onBar(bar) for a new or updated last bar. Returns stop(). */
    subscribe(r, iv, onBar, status) {
      if (r.feed === "binance") return binanceSocket(r, iv, onBar, status);
      if (r.feed === "cnbc") {
        if (r.us && FH.key() && isIntraday(iv)) return finnhubSocket(r, iv, onBar, status);
        return cnbcPoll(r, iv, onBar, status);
      }
      return () => {};
    },
  };
  const noData = (r) => `CNBC has no price data for ${r.sym}${/-(JP|HK)$/.test(r.cnbc || "") ? ": it doesn't cover Tokyo or Hong Kong listings" : ""}`;

  // --- price history for the rest of the site ------------------------------------------------------
  // The site doesn't republish anyone's price history: pages that chart a symbol or compute from its
  // past prices load it here, from the visitor's browser. Daily bars cover about two years (CNBC's
  // 1Y range returns two; Binance up to 1,000 days), weekly bars ten.
  const histCache = new Map(), waiting = [];
  let inFlight = 0;
  async function limited(fn) {  // CNBC throttles bursts, so at most four requests at a time
    if (inFlight >= 4) await new Promise((go) => waiting.push(go));
    inFlight++;
    try { return await fn(); } finally { inFlight--; if (waiting.length) waiting.shift()(); }
  }
  async function cnbcJSON(url) {
    try { return await getJSON(url); } catch (e) {
      if (!e.throttled) throw e;
      await new Promise((go) => setTimeout(go, 2000));  // one retry after a pause
      try { return await getJSON(url); } catch (e2) { throw new Error(e2.throttled ? "CNBC is throttling requests; try again in a minute" : e2.message); }
    }
  }
  /** {sym, source, weekly, dates, open, high, low, close, volume|null} for a universe symbol. */
  function dailyHistory(sym, { weekly = false } = {}) {
    const key = `${sym}|${weekly ? "w" : "d"}`;
    if (!histCache.has(key)) {
      histCache.set(key, (async () => {
        const r = await resolve(sym);
        const bars = r.feed === "binance"  // an unknown pair fails without CORS headers, so name the likely cause
          ? await limited(() => FEEDS.history(r, weekly ? "1w" : "1d")).catch(() => { throw new Error(`Binance has no ${r.pair} market, so there's no price history for ${sym}`); })
          : cnbcBars(await limited(() => cnbcJSON(`${CNBC_CHART}${weekly ? "5Y" : "1Y"}.json?symbol=${encodeURIComponent(r.cnbc)}`)), false);
        if (bars.length < 2) throw new Error(r.feed === "cnbc" ? noData(r) : `Binance has no price data for ${sym}`);
        const col = (k) => bars.map((b) => b[k]);
        return { sym, source: r.feed === "binance" ? "Binance" : "CNBC", weekly, dates: bars.map((b) => new Date(b.t * 1000).toISOString().slice(0, 10)),
          open: col("open"), high: col("high"), low: col("low"), close: col("close"), volume: bars.some((b) => b.volume) ? col("volume") : null };
      })().catch((e) => { histCache.delete(key); throw e; }));
    }
    return histCache.get(key);
  }

  function binanceSocket(r, iv, onBar, status) {
    let ws = null, stopped = false, tries = 0, timer = null;
    const lower = r.pair.toLowerCase();
    const connect = () => {
      if (stopped || document.hidden) return;
      status("wait", tries ? "Reconnecting…" : "Connecting…");
      ws = new WebSocket(`${BINANCE_WS}${lower}@kline_${iv}/${lower}@miniTicker`);
      ws.onopen = () => { tries = 0; };
      ws.onmessage = (e) => {
        const d = (JSON.parse(e.data) || {}).data || {};
        if (d.e === "kline") { const k = d.k; onBar({ t: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }); }
        else if (d.e === "24hrMiniTicker") onBar(null, { change: +d.c / +d.o - 1, label: "24h" });
        status("live", "Live · Binance");
      };
      ws.onclose = () => { ws = null; if (stopped || document.hidden) return; const s = [1, 2, 5, 10, 30][Math.min(tries++, 4)]; status("err", `Disconnected; retrying in ${s}s`); timer = setTimeout(connect, s * 1000); };
    };
    const vis = () => { if (document.hidden) { if (ws) { ws.onclose = null; ws.close(); ws = null; } status("wait", "Paused while the tab is hidden"); } else if (!ws && !stopped) connect(); };
    document.addEventListener("visibilitychange", vis);
    connect();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); if (ws) { ws.onclose = null; ws.close(); } };
  }

  /** CNBC: poll today's minute bars (intraday) or the quote (daily and longer) every 15 s. */
  function cnbcPoll(r, iv, onBar, status) {
    let stopped = false, timer = null, wait = 15000;
    const tick = async () => {
      if (stopped) return;
      if (document.hidden) { status("wait", "Paused while the tab is hidden"); timer = setTimeout(tick, 5000); return; }
      try {
        if (isIntraday(iv)) {
          let bars = cnbcBars(await getJSON(`${CNBC_CHART}1D.json?symbol=${encodeURIComponent(r.cnbc)}`), true);
          if (iv !== "1m") bars = aggregate(bars, SEC[iv]);
          bars.slice(-3).forEach((b) => onBar(b));
        } else {
          const q = (((await getJSON(CNBC_QUOTE + encodeURIComponent(r.cnbc))).FormattedQuoteResult || {}).FormattedQuote || [])[0] || {};
          const last = parseFloat(String(q.last || "").replace(/,/g, ""));
          if (Number.isFinite(last)) onBar({ quote: last, high: parseFloat(String(q.high).replace(/,/g, "")), low: parseFloat(String(q.low).replace(/,/g, "")),
            volume: parseFloat(String(q.volume || "0").replace(/,/g, "")), date: q.last_time || "" });
        }
        wait = 15000;
        status("live", "Live · CNBC · updates every 15 s");
      } catch (e) {
        wait = Math.min(wait * 2, 240000);
        status("err", e.throttled ? `CNBC is throttling requests; retrying in ${Math.round(wait / 1000)} s` : `Update failed (${e.message}); retrying`);
      }
      timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, 15000);
    status("live", "Live · CNBC · updates every 15 s");
    return () => { stopped = true; clearTimeout(timer); };
  }

  /** Finnhub trades for US symbols (visitor's key): tick-by-tick updates of the last candle. */
  function finnhubSocket(r, iv, onBar, status) {
    let ws = null, stopped = false, tries = 0, timer = null, last = null;
    const step = SEC[iv], sym = r.sym.replace(/-/g, ".");
    const connect = () => {
      if (stopped || document.hidden) return;
      ws = new WebSocket(FINNHUB_WS + encodeURIComponent(FH.key()));
      ws.onopen = () => { tries = 0; ws.send(JSON.stringify({ type: "subscribe", symbol: sym })); status("wait", "Finnhub connected, waiting for trades (US hours 9:30–16:00 New York)"); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "error") { status("err", msg.msg || "Finnhub error"); return; }
        if (msg.type !== "trade") return;
        for (const tr of msg.data || []) {
          const t = Math.floor(tr.t / 1000 / step) * step;
          if (!last || t > last.t) last = { t, open: tr.p, high: tr.p, low: tr.p, close: tr.p, volume: tr.v || 0, merge: true };
          else if (t === last.t) Object.assign(last, { high: Math.max(last.high, tr.p), low: Math.min(last.low, tr.p), close: tr.p, volume: last.volume + (tr.v || 0) });
          onBar(Object.assign({}, last));
        }
        status("live", "Live · Finnhub ticks");
      };
      ws.onclose = () => { ws = null; if (stopped || document.hidden) return; const s = [1, 2, 5, 10, 30][Math.min(tries++, 4)]; timer = setTimeout(connect, s * 1000); };
    };
    const vis = () => { if (document.hidden) { if (ws) { ws.onclose = null; ws.close(); ws = null; } } else if (!ws && !stopped) connect(); };
    document.addEventListener("visibilitychange", vis);
    connect();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); if (ws) { ws.onclose = null; ws.close(); } };
  }

  // ==============================================================================================
  // The page
  // ==============================================================================================
  let current = null;  // the chart on screen; replaced (and its feed closed) on every redraw
  async function view(el, arg) {
    if (current) { current.destroy(); current = null; }
    const r = await resolve(arg || store.get("liveSymbol", "BTCUSDT"));
    store.set("liveSymbol", r.sym);
    const ivKey = `pc:interval:${r.feed}`;
    let feed = r.feed, iv = store.get(ivKey, r.feed === "binance" ? "15m" : "5m");
    if (!FEED_INTERVALS[feed].includes(iv)) iv = FEED_INTERVALS[feed][0];
    const picks = (list) => list.map((s) => `<a class="chip${s === r.sym ? " on" : ""}" href="#/live/${encodeURIComponent(s)}">${esc(s.replace(/USDT$/, ""))}</a>`).join("");
    el.innerHTML = `
      <div class="pc" id="pc">
        <div class="pc-head">
          <div class="pc-title"><h1>${esc(r.sym)}</h1><span class="soft">${esc(r.name || "")}</span>
            <span class="ticker-price" id="pc-price">–</span><span id="pc-change"></span>
            <span class="status wait" id="pc-status"><i></i><span>Loading…</span></span></div>
          <div class="pc-links">${r.row ? `<a href="#/stock/${encodeURIComponent(r.sym)}">Stock page</a> · <a href="#/financials/${encodeURIComponent(r.sym)}">Research</a> · ` : ""}
            <span class="muted">Quick:</span> <span class="chips" style="display:inline-flex">${picks(CRYPTO_PICKS)}${picks(STOCK_PICKS)}</span></div>
        </div>
        <div class="pc-toolbar">
          <div id="pc-search" style="width:160px">${searchBox("Symbol")}</div>
          <div class="pc-group" id="pc-int"></div>
          <select id="pc-type" title="Chart type">${CHART_TYPES.map((t) => `<option${t === state.type ? " selected" : ""}>${t}</option>`).join("")}</select>
          <button class="btn" id="pc-ind" type="button" title="Indicators (/)">ƒx Indicators</button>
          <button class="btn" id="pc-books" type="button" title="Indicator sets of famous traders and investors">★ Investor playbooks</button>
          <button class="btn" id="pc-log" type="button" title="Log scale (Alt+L)">Log</button>
          <button class="btn" id="pc-pct" type="button" title="Percentage scale">%</button>
          <button class="btn" id="pc-shot" type="button" title="Screenshot (Alt+S)">📷</button>
          <button class="btn" id="pc-full" type="button" title="Full screen (Shift+F)">⛶</button>
          <button class="btn" id="pc-keys" type="button" title="Keyboard shortcuts">⌨</button>
        </div>
        <div class="pc-body">
          <div class="pc-tools" id="pc-tools">${TOOLS.map(([id, icon, tip]) => `<button type="button" class="pc-tool${id === "cursor" ? " on" : ""}" data-tool="${id}" title="${esc(tip)}">${icon}</button>`).join("")}
            <button type="button" class="pc-tool" data-tool="clear" title="Remove all drawings">🗑</button></div>
          <div class="pc-stage" id="pc-stage" tabindex="0">
            <div class="pc-chart" id="pc-chart"></div>
            <svg class="pc-draw" id="pc-draw"></svg>
            <div class="pc-legends" id="pc-legends"></div>
            <div class="pc-typed" id="pc-typed" hidden></div>
          </div>
        </div>
        <p class="caption" id="pc-foot"></p>
        <div class="card pc-alerts" id="pc-alerts" data-sym="${esc(r.sym)}"></div>
      </div>`;
    bindSearch($("#pc-search", el), (s) => { location.hash = `#/live/${encodeURIComponent(s)}`; });

    let bars = [];
    try {
      await loadScript(LWC_URL, "LightweightCharts");
      bars = await FEEDS.history(r, iv);
    } catch (e) {
      const msg = e.throttled ? "CNBC is throttling requests right now; try again in a minute." : e.message;
      $("#pc-chart").innerHTML = `<div class="empty">${esc(msg)}${r.row ? `<br><a href="#/stock/${encodeURIComponent(r.sym)}">The stock page</a> still has its scores and returns.` : ""}</div>`;
      setStatus("err", msg);
      renderAlerts($("#pc-alerts", el), r.sym);
      return;
    }
    const pc = proChart(el, r, iv, bars);
    current = pc;
    window.onRouteCleanup(() => { if (current) { current.destroy(); current = null; } });
    $("#pc-int").innerHTML = FEED_INTERVALS[feed].map((i) => `<button type="button" class="chip${i === iv ? " on" : ""}" data-v="${i}">${LABEL[i] || i}</button>`).join("");
    el.querySelectorAll("#pc-int .chip").forEach((b) => b.addEventListener("click", () => { store.set(ivKey, b.dataset.v); view(el, r.sym); }));
    pc.onInterval = (next) => { if (FEED_INTERVALS[feed].includes(next)) { store.set(ivKey, next); view(el, r.sym); } };
    $("#pc-foot").innerHTML = footNote(r, feed);
    renderAlerts($("#pc-alerts", el), r.sym);
  }
  function footNote(r, feed) {
    const src = feed === "binance" ? "Binance public market data over WebSocket (no key)."
      : `CNBC's quote and chart service (unofficial, no key), polled every 15 s${r.us && FH.key() ? "; Finnhub trade ticks with your key on intraday intervals" : r.us ? "; add a free Finnhub key (⚙) for tick-by-tick updates" : ""}. Bars include pre- and post-market sessions where available.`;
    return `${src} Indicators are computed in your browser with TradingView's formulas and stay as you set them. Drawings are saved per symbol in this browser.
      Charting by <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener">TradingView Lightweight Charts</a>. Research only, not investment advice.`;
  }
  function setStatus(kind, text) {
    const s = $("#pc-status");
    if (!s) return;
    s.className = `status ${kind}`;
    s.lastElementChild.textContent = text;
  }

  // ==============================================================================================
  // Chart engine
  // ==============================================================================================
  function proChart(el, r, iv, rawBars) {
    const LC = window.LightweightCharts, c = pal(), intraday = isIntraday(iv);
    const stage = $("#pc-stage", el), box = $("#pc-chart", el), svg = $("#pc-draw", el), legends = $("#pc-legends", el);
    const colorOf = (key) => ({ s0: c.series[0], s1: c.series[1], s2: c.series[2], s3: c.series[3], s4: c.series[4], s5: c.series[5], s6: c.series[6], s7: c.series[7] }[key] || c[key] || key);
    const chart = LC.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: c.ink2, fontFamily: FONT, attributionLogo: true,
        panes: { separatorColor: c.grid, separatorHoverColor: "rgba(120,120,120,0.25)", enableResize: true } },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.axis },
      timeScale: { borderColor: c.axis, timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
    });
    let bars = rawBars.slice(), main = null, studySeries = [], computed = [], selected = null, pending = null, tool = "cursor";
    let drawings = store.get(`pc:draw:${r.sym}`, []), stopFeed = () => {}, redrawQueued = false, studyTimer = null, lastChange = null;
    const closeOnly = bars.some((b) => b.closeOnly);
    const lastClose = () => (bars.length ? bars[bars.length - 1].close : 1);
    const chartTime = (t) => (intraday ? t + localShift() : t);
    const sessionKey = r.feed === "binance" ? (t) => Math.floor(t / 86400) : (t) => nyDate.format(new Date(t * 1000));

    // --- main series --------------------------------------------------------------------------
    function heikin(list) {
      const out = [];
      list.forEach((b, i) => {
        const close = (b.open + b.high + b.low + b.close) / 4, open = i ? (out[i - 1].open + out[i - 1].close) / 2 : (b.open + b.close) / 2;
        out.push({ t: b.t, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
      });
      return out;
    }
    const type = closeOnly && !["Line", "Area"].includes(state.type) ? "Line" : state.type;
    function makeMain() {
      const fmt = { type: "price", precision: lastClose() >= 1 ? 2 : lastClose() >= 0.01 ? 4 : 6, minMove: lastClose() >= 1 ? 0.01 : lastClose() >= 0.01 ? 0.0001 : 0.000001 };
      if (type === "Line") return chart.addSeries(LC.LineSeries, { color: c.ink, lineWidth: 2, priceFormat: fmt });
      if (type === "Area") return chart.addSeries(LC.AreaSeries, { lineColor: c.up, topColor: withAlpha(c.up, 0.3), bottomColor: withAlpha(c.up, 0.02), lineWidth: 2, priceFormat: fmt });
      if (type === "Bars") return chart.addSeries(LC.BarSeries, { upColor: c.up, downColor: c.down, priceFormat: fmt });
      const hollow = type === "Hollow candles";
      return chart.addSeries(LC.CandlestickSeries, { upColor: hollow ? "rgba(0,0,0,0)" : c.up, downColor: c.down, borderVisible: true, borderUpColor: c.up,
        borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down, priceFormat: fmt });
    }
    const toPoint = (b) => (["Line", "Area"].includes(type) ? { time: chartTime(b.t), value: b.close } : { time: chartTime(b.t), open: b.open, high: b.high, low: b.low, close: b.close });
    const displayBars = () => (type === "Heikin Ashi" ? heikin(bars) : bars);
    main = makeMain();
    main.setData(displayBars().map(toPoint));

    // --- studies --------------------------------------------------------------------------------
    let bench = null;  // aligned benchmark closes for relative strength
    async function ensureBench() {
      if (!state.studies.some((s) => s.id === "rs") || bench) return;
      // Coins against bitcoin, bitcoin and stocks against the S&P 500.
      const ref = r.feed === "binance" && r.pair !== "BTCUSDT" ? { feed: "binance", pair: "BTCUSDT", sym: "BTCUSDT" } : { feed: "cnbc", cnbc: ".SPX", sym: "^GSPC" };
      try {
        const b = await FEEDS.history(ref, iv);
        const m = new Map(b.map((x) => [x.t, x.close]));
        bench = { map: m, name: ref.sym };
      } catch (e) {
        bench = { map: new Map(), name: "benchmark" };
      }
      rebuildStudies();
    }
    function dataForStudies() {
      const d = { time: bars.map((b) => b.t), open: bars.map((b) => b.open), high: closeOnly ? null : bars.map((b) => b.high),
        low: closeOnly ? null : bars.map((b) => b.low), close: bars.map((b) => b.close), volume: closeOnly || bars.every((b) => !b.volume) ? null : bars.map((b) => b.volume),
        intraday, session: (i) => sessionKey(bars[i].t) };
      if (bench && bench.map.size) { let lastB = null; d.bench = bars.map((b) => { const v = bench.map.get(b.t); if (v) lastB = v; return v ?? lastB; }); }
      return d;
    }
    function rebuildStudies() {
      studySeries.forEach((s) => chart.removeSeries(s.api));
      studySeries = [];
      for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i);
      const d = dataForStudies();
      let pane = 0;
      computed = state.studies.map((inst) => {
        const def = Q.STUDIES.find((s) => s.id === inst.id);
        if (!def || !Q.studyFits(def, d)) return { inst, def, skipped: true };
        const p = def.kind === "pane" ? ++pane : 0;
        return { inst, def, pane: p, out: def.calc(d, inst.params) };
      });
      for (const cmp of computed) {
        if (cmp.skipped) continue;
        const { inst, def, out } = cmp;
        const visible = !inst.hidden;
        const base = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible };
        if (def.kind === "volume") {
          const h = chart.addSeries(LC.HistogramSeries, Object.assign({}, base, { priceScaleId: "vol", priceFormat: { type: "volume" } }), 0);
          h.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
          studySeries.push({ uid: inst.uid, api: h, kind: "vol" });
          out.lines.forEach((ln, k) => {
            const s = chart.addSeries(LC.LineSeries, Object.assign({}, base, { priceScaleId: "vol", color: inst.colors[k] || colorOf(ln.color), lineWidth: 1 }), 0);
            studySeries.push({ uid: inst.uid, api: s, line: k });
          });
          continue;
        }
        if (out.hist) {
          const h = chart.addSeries(LC.HistogramSeries, Object.assign({}, base, { priceFormat: { type: "price", precision: 3, minMove: 0.001 } }), cmp.pane);
          studySeries.push({ uid: inst.uid, api: h, kind: "hist" });
        }
        if (out.segments) {
          const s = chart.addSeries(LC.LineSeries, Object.assign({}, base, { lineWidth: 2 }), cmp.pane);
          studySeries.push({ uid: inst.uid, api: s, kind: "segments" });
        } else {
          out.lines.forEach((ln, k) => {
            const opts = Object.assign({}, base, { color: inst.colors[k] || colorOf(ln.color), lineWidth: ln.width || (def.kind === "pane" ? 2 : 1),
              lineStyle: ln.dash ? 2 : 0, lineType: out.step ? 1 : 0 });
            if (ln.dots) Object.assign(opts, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2 });
            if (out.range) opts.autoscaleInfoProvider = () => ({ priceRange: { minValue: out.range[0], maxValue: out.range[1] }, margins: { above: 4, below: 4 } });
            const s = chart.addSeries(LC.LineSeries, opts, cmp.pane);
            if (cmp.pane) s.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.06 } });
            if (k === 0 && out.levels) out.levels.forEach((lv) => s.createPriceLine({ price: lv, color: c.axis, lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
            studySeries.push({ uid: inst.uid, api: s, line: k });
          });
        }
      }
      const panes = chart.panes();
      panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3.2 : 1));
      fillStudies();
      requestAnimationFrame(() => { updateLegends(null); queueDraw(); });  // new panes are laid out by the next frame
      ensureBench();
    }
    /** Push computed values into the series (on rebuild and as bars update). */
    function fillStudies(recompute = false) {
      if (recompute) {
        const d = dataForStudies();
        computed.forEach((cmp) => { if (!cmp.skipped) cmp.out = cmp.def.calc(d, cmp.inst.params); });
      }
      const times = bars.map((b) => chartTime(b.t));
      for (const ss of studySeries) {
        const cmp = computed.find((x) => x.inst.uid === ss.uid);
        if (!cmp || !cmp.out) continue;
        const pt = (values, i, extra = {}) => (values[i] == null ? { time: times[i] } : Object.assign({ time: times[i], value: values[i] }, extra));
        if (ss.kind === "vol") ss.api.setData(bars.map((b, i) => ({ time: times[i], value: b.volume, color: withAlpha(b.close >= b.open ? c.up : c.down, 0.45) })));
        else if (ss.kind === "hist") ss.api.setData(times.map((_, i) => pt(cmp.out.hist, i, { color: withAlpha((cmp.out.hist[i] ?? 0) >= 0 ? c.up : c.down, 0.6) })));
        else if (ss.kind === "segments") { const sg = cmp.out.segments; ss.api.setData(times.map((_, i) => pt(sg.values, i, { color: sg.up[i] ? c.good : c.bad }))); }
        else ss.api.setData(times.map((_, i) => pt(cmp.out.lines[ss.line].values, i)));
      }
      updateLegends(null);
    }

    // --- legends ---------------------------------------------------------------------------------
    function paneTops() {
      const top0 = stage.getBoundingClientRect().top;
      return chart.panes().map((p) => { const e = p.getHTMLElement(); return e ? e.getBoundingClientRect().top - top0 : 0; });
    }
    function updateLegends(idx) {
      const i = idx ?? bars.length - 1, b = bars[i];
      if (!b) return;
      const prev = bars[i - 1], chg = prev ? b.close / prev.close - 1 : null, ref = b.close;
      const tops = paneTops(), blocks = {};
      const add = (pane, html) => { (blocks[pane] = blocks[pane] || []).push(html); };
      add(0, `<div class="pc-leg-main"><button class="pc-fold" data-act="fold" title="${legendFolded ? "Show" : "Hide"} indicator values">${legendFolded ? "▸" : "▾"}</button><b>${esc(r.sym)}</b> · ${LABEL[iv] || iv} · ${esc(r.feed === "binance" ? "Binance" : "CNBC")}
        <span>O <b>${fmtNum(b.open, ref)}</b> H <b>${fmtNum(b.high, ref)}</b> L <b>${fmtNum(b.low, ref)}</b> C <b>${fmtNum(b.close, ref)}</b>
        ${chg === null ? "" : `<b class="${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%</b>`}${b.volume ? ` Vol <b>${Math.round(b.volume).toLocaleString()}</b>` : ""}</span></div>`);
      for (const cmp of computed) {
        const { inst, def, out } = cmp;
        const btns = `<button data-act="hide" data-uid="${inst.uid}" title="${inst.hidden ? "Show" : "Hide"}">${inst.hidden ? "◌" : "◉"}</button><button data-act="edit" data-uid="${inst.uid}" title="Settings">⚙</button><button data-act="del" data-uid="${inst.uid}" title="Remove">✕</button>`;
        if (cmp.skipped) { add(0, `<div class="pc-leg off">${esc(def ? def.label(inst.params) : inst.id)} <i>needs data this symbol doesn't have</i> ${btns}</div>`); continue; }
        const vals = out.segments ? [`<span style="color:${out.segments.up[i] ? c.good : c.bad}">${fmtNum(out.segments.values[i], ref)}</span>`]
          : out.lines.map((ln, k) => `<span style="color:${inst.colors[k] || colorOf(ln.color)}">${fmtNum(ln.values[i], def.kind === "pane" ? ln.values[i] : ref)}</span>`);
        if (out.hist && out.hist[i] != null) vals.push(`<span class="${out.hist[i] >= 0 ? "pos" : "neg"}">${fmtNum(out.hist[i], out.hist[i])}</span>`);
        if (def.kind === "volume" && b.volume) vals.unshift(`<span>${Math.round(b.volume).toLocaleString()}</span>`);
        add(cmp.pane || 0, `<div class="pc-leg${inst.hidden ? " off" : ""}">${esc(def.label(inst.params))} ${vals.join(" ")} ${btns}</div>`);
      }
      legends.innerHTML = Object.entries(blocks).map(([p, list]) => `<div class="pc-leg-pane" style="top:${(tops[p] || 0) + 4}px">${list.join("")}</div>`).join("");
      legends.classList.toggle("folded", legendFolded);
    }
    let legendFolded = store.get("pc:legendFolded", window.innerWidth < 760);
    legends.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "fold") { legendFolded = !legendFolded; store.set("pc:legendFolded", legendFolded); updateLegends(null); return; }
      const inst = state.studies.find((s) => s.uid === b.dataset.uid);
      if (!inst) return;
      if (b.dataset.act === "del") state.studies = state.studies.filter((s) => s !== inst);
      else if (b.dataset.act === "hide") inst.hidden = !inst.hidden;
      else if (b.dataset.act === "edit") return openSettings(inst);
      saveStudies(); rebuildStudies();
    });
    chart.subscribeCrosshairMove((param) => {
      const idx = param && param.logical != null ? Math.max(0, Math.min(bars.length - 1, Math.round(param.logical))) : null;
      updateLegends(param && param.point ? idx : null);
      if (pending && param && param.point) { pending.preview = pointFromXY(param.point.x, param.point.y); drawAll(); }
    });

    // --- drawings ------------------------------------------------------------------------------
    const ts = () => chart.timeScale();
    const spacing = () => (bars.length > 1 ? (bars[bars.length - 1].t - bars[0].t) / (bars.length - 1) : SEC[iv]);
    function logicalOfT(t) {
      if (!bars.length) return null;
      if (t <= bars[0].t) return (t - bars[0].t) / spacing();
      const n = bars.length - 1;
      if (t >= bars[n].t) return n + (t - bars[n].t) / SEC[iv];
      let lo = 0, hi = n;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bars[m].t <= t) lo = m; else hi = m; }
      return lo + (t - bars[lo].t) / (bars[hi].t - bars[lo].t);
    }
    function tOfLogical(l) {
      const n = bars.length - 1;
      if (l <= 0) return bars[0].t + l * spacing();
      if (l >= n) return bars[n].t + (l - n) * SEC[iv];
      const i = Math.floor(l), f = l - i;
      return bars[i].t + f * (bars[i + 1].t - bars[i].t);
    }
    function pointFromXY(x, y) {
      const l = ts().coordinateToLogical(x), p = main.coordinateToPrice(y);
      return l == null || p == null ? null : { t: tOfLogical(l), p };
    }
    const xy = (pt) => { const l = logicalOfT(pt.t); return { x: l == null ? null : ts().logicalToCoordinate(l), y: main.priceToCoordinate(pt.p) }; };
    const saveDrawings = () => store.set(`pc:draw:${r.sym}`, drawings);
    function shapeSvg(dw, i, preview) {
      const a = xy(dw.a), b = dw.b ? xy(dw.b) : null, W = box.clientWidth, col = i === selected ? c.down : (dw.color || c.up);
      if (a.x == null || a.y == null) return "";
      const hit = (inner) => `<g data-i="${i}" class="${preview ? "" : "pc-shape"}">${inner}</g>`;
      const line = (x1, y1, x2, y2, extra = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1.6" ${extra}/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="10"/>`;
      const label = (x, y, text, anchor = "start") => `<text x="${x}" y="${y}" fill="${col}" font-size="11" text-anchor="${anchor}" font-family="system-ui, sans-serif">${esc(text)}</text>`;
      if (dw.type === "hline") return hit(line(0, a.y, W, a.y) + label(W - 70, a.y - 4, fmtNum(dw.a.p, lastClose()), "end"));
      if (dw.type === "vline") return hit(line(a.x, 0, a.x, box.clientHeight));
      if (!b || b.x == null || b.y == null) return hit(`<circle cx="${a.x}" cy="${a.y}" r="3" fill="${col}"/>`);
      if (dw.type === "trend") return hit(line(a.x, a.y, b.x, b.y));
      if (dw.type === "ray") {
        const dx = b.x - a.x, dy = b.y - a.y, k = dx === 0 ? 1 : (W - a.x) / dx;
        return hit(line(a.x, a.y, dx >= 0 ? a.x + dx * Math.max(k, 1) : b.x, dx >= 0 ? a.y + dy * Math.max(k, 1) : b.y));
      }
      if (dw.type === "rect") return hit(`<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="${withAlpha(col.startsWith("#") ? col : "#2a78d6", 0.1)}" stroke="${col}" stroke-width="1.4"/>`);
      if (dw.type === "fib") {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        return hit(FIB.map((lv) => {
          const price = dw.b.p + (dw.a.p - dw.b.p) * lv, y = main.priceToCoordinate(price);
          return y == null ? "" : line(x1, y, x2, y, lv === 0.5 || lv === 0.618 ? "" : 'stroke-dasharray="4 3"') + label(x2 + 4, y + 4, `${lv} (${fmtNum(price, lastClose())})`);
        }).join("") + `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-dasharray="2 4" stroke-width="1"/>`);
      }
      if (dw.type === "measure") {
        const dp = dw.b.p - dw.a.p, pctv = dp / dw.a.p, nb = Math.round(logicalOfT(dw.b.t) - logicalOfT(dw.a.t));
        const fill = withAlpha(dp >= 0 ? c.up : c.down, 0.12);
        return hit(`<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="${fill}" stroke="${dp >= 0 ? c.up : c.down}"/>`
          + label((a.x + b.x) / 2, Math.min(a.y, b.y) - 6, `${dp >= 0 ? "+" : ""}${fmtNum(dp, lastClose())} (${(pctv * 100).toFixed(2)}%) · ${nb} bars`, "middle"));
      }
      return "";
    }
    function drawAll() {
      redrawQueued = false;
      const h0 = chart.panes()[0] ? chart.panes()[0].getHeight() : box.clientHeight;
      const w0 = box.clientWidth - (chart.priceScale("right").width() || 0);
      const list = drawings.map((dw, i) => shapeSvg(dw, i, false));
      if (pending && pending.preview) list.push(shapeSvg(Object.assign({}, pending, { b: pending.preview }), -1, true));
      svg.setAttribute("width", box.clientWidth); svg.setAttribute("height", box.clientHeight);
      svg.innerHTML = `<defs><clipPath id="pc-clip"><rect x="0" y="0" width="${w0}" height="${h0}"/></clipPath></defs><g clip-path="url(#pc-clip)">${list.join("")}</g>`;
    }
    const queueDraw = () => { if (!redrawQueued) { redrawQueued = true; requestAnimationFrame(drawAll); } };
    ts().subscribeVisibleLogicalRangeChange(queueDraw);
    const ro = new ResizeObserver(() => { queueDraw(); updateLegends(null); });
    ro.observe(box);
    stage.addEventListener("pointermove", queueDraw);
    stage.addEventListener("wheel", queueDraw, { passive: true });
    svg.addEventListener("click", (e) => {
      const g = e.target.closest(".pc-shape");
      if (!g || tool !== "cursor") return;
      selected = Number(g.dataset.i); drawAll(); e.stopPropagation();
    });
    function setTool(t) {
      tool = t; pending = null;
      el.querySelectorAll(".pc-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
      stage.classList.toggle("drawing", t !== "cursor");
      drawAll();
    }
    el.querySelectorAll(".pc-tool").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.tool === "clear") { if (drawings.length && confirm(`Remove all ${drawings.length} drawings on ${r.sym}?`)) { drawings = []; selected = null; saveDrawings(); drawAll(); } return; }
      setTool(b.dataset.tool);
    }));
    // Drawing clicks come from pointer events on the stage, not the chart's click event: the chart
    // reports a quick second click elsewhere as neither a click nor a double-click.
    let downAt = null;
    stage.addEventListener("pointerdown", (e) => { downAt = tool !== "cursor" && e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
    stage.addEventListener("pointerup", (e) => {
      if (tool === "cursor" || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 6) return;  // that was a drag (pan), not a click
      const rect = box.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
      const h0 = chart.panes()[0].getHeight(), w0 = box.clientWidth - (chart.priceScale("right").width() || 0);
      if (x < 0 || y < 0 || x > w0 || y > h0) return;  // drawings live on the price pane
      placePoint(x, y);
    }, true);
    chart.subscribeClick(() => { if (tool === "cursor" && selected !== null) { selected = null; drawAll(); } });
    function placePoint(x, y) {
      const pt = pointFromXY(x, y);
      if (!pt) return;
      if (tool === "hline" || tool === "vline") { drawings.push({ type: tool, a: pt }); saveDrawings(); setTool("cursor"); return; }
      if (!pending) { pending = { type: tool, a: pt }; drawAll(); return; }
      drawings.push({ type: pending.type, a: pending.a, b: pt }); saveDrawings();
      setTool("cursor");
    }

    // --- live feed -------------------------------------------------------------------------------
    function onBar(b, meta) {
      if (meta) { lastChange = meta; showPrice(); return; }
      if (!b) return;
      if (b.quote !== undefined) {  // a daily quote: update the last bar, or start a new one on a new date
        let lastB = bars[bars.length - 1];
        const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? Date.parse(b.date + "T00:00:00Z") / 1000 : null;
        if (iv === "1d" && day && day > lastB.t) { lastB = { t: day, open: b.quote, high: b.quote, low: b.quote, close: b.quote, volume: 0 }; bars.push(lastB); }
        lastB.close = b.quote;
        if (Number.isFinite(b.high) && b.high > 0) lastB.high = Math.max(lastB.high, b.high);
        if (Number.isFinite(b.low) && b.low > 0) lastB.low = Math.min(lastB.low, b.low);
        b = lastB;
      } else {
        const lastB = bars[bars.length - 1];
        if (lastB && b.t === lastB.t) bars[bars.length - 1] = b.merge ? Object.assign(lastB, { high: Math.max(lastB.high, b.high), low: Math.min(lastB.low, b.low), close: b.close }) : b;
        else if (!lastB || b.t > lastB.t) bars.push(b);
        else return;
      }
      const shown = type === "Heikin Ashi" ? heikin(bars).pop() : bars[bars.length - 1];
      main.update(toPoint(shown));
      showPrice();
      clearTimeout(studyTimer);
      studyTimer = setTimeout(() => { fillStudies(true); queueDraw(); }, 400);
    }
    function showPrice() {
      const b = bars[bars.length - 1], p = $("#pc-price"), ch = $("#pc-change");
      if (!b || !p) return;
      p.textContent = fmtNum(b.close, b.close);
      const prev = r.feed === "binance" ? null : bars[bars.length - 2];
      const change = lastChange ? lastChange.change : intraday ? null : prev ? b.close / prev.close - 1 : null;
      if (ch) ch.innerHTML = change == null ? "" : `<span class="${change >= 0 ? "pos" : "neg"}">${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%${lastChange ? " 24h" : ""}</span>`;
    }
    rebuildStudies();
    showPrice();
    ts().fitContent();
    if (bars.length > 300) ts().setVisibleLogicalRange({ from: bars.length - 300, to: bars.length + 5 });
    setStatus("wait", "Connecting…");
    stopFeed = FEEDS.subscribe(r, iv, onBar, setStatus);

    // --- toolbar, dialogs and shortcuts ------------------------------------------------------------
    let logOn = false, pctOn = false;
    const setScale = () => chart.priceScale("right").applyOptions({ mode: logOn ? 1 : pctOn ? 2 : 0 });
    $("#pc-type", el).addEventListener("change", (e) => { state.type = e.target.value; store.set("pc:type", state.type); view(el.closest("#view") || el, r.sym); });
    $("#pc-log", el).addEventListener("click", (e) => { logOn = !logOn; pctOn = false; setScale(); e.target.classList.toggle("on", logOn); $("#pc-pct", el).classList.remove("on"); });
    $("#pc-pct", el).addEventListener("click", (e) => { pctOn = !pctOn; logOn = false; setScale(); e.target.classList.toggle("on", pctOn); $("#pc-log", el).classList.remove("on"); });
    const screenshot = () => {
      const canvas = chart.takeScreenshot(true, false), a = document.createElement("a");
      a.href = canvas.toDataURL("image/png"); a.download = `${r.sym}_${iv}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`; a.click();
    };
    const fullscreen = () => { const node = $("#pc", el); if (document.fullscreenElement) document.exitFullscreen(); else if (node.requestFullscreen) node.requestFullscreen(); };
    $("#pc-shot", el).addEventListener("click", screenshot);
    $("#pc-full", el).addEventListener("click", fullscreen);
    $("#pc-ind", el).addEventListener("click", () => openIndicators("studies"));
    $("#pc-books", el).addEventListener("click", () => openIndicators("books"));
    $("#pc-keys", el).addEventListener("click", () => modal("Keyboard shortcuts", `<table class="pc-keys">${SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>`));

    let typed = "", typedTimer = null;
    const typedBox = $("#pc-typed", el);
    const parseInterval = (s) => {
      const m = s.trim().toUpperCase().match(/^(\d*)([SMHDW]?)$/);
      if (!m) return null;
      const n = m[1] ? Number(m[1]) : 1, u = m[2];
      if (u === "D") return n === 1 ? "1d" : null;
      if (u === "W") return n === 1 ? "1w" : null;
      if (u === "M") return n === 1 ? "1M" : null;  // as on TradingView: M is months, plain numbers are minutes
      if (u === "H") return { 1: "1h", 2: "2h", 4: "4h" }[n] || null;
      if (!u) return { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 120: "2h", 240: "4h" }[n] || null;
      return null;
    };
    function onKey(e) {
      const target = e.target instanceof Element ? e.target : null;
      if ((target && target.closest("input, select, textarea")) || document.querySelector(".modal-back.open")) return;
      const k = e.key;
      if (k === "Escape") { setTool("cursor"); selected = null; drawAll(); typed = ""; typedBox.hidden = true; return; }
      if ((k === "Delete" || k === "Backspace") && selected !== null) { drawings.splice(selected, 1); selected = null; saveDrawings(); drawAll(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { drawings.pop(); saveDrawings(); drawAll(); e.preventDefault(); return; }
      if (k === "/") { e.preventDefault(); openIndicators("studies"); return; }
      if (e.altKey) {
        const map = { t: e.shiftKey ? "ray" : "trend", h: "hline", v: "vline", f: "fib", m: "measure", r: e.shiftKey ? "rect" : null };
        const kk = (e.code || "").replace("Key", "").toLowerCase();
        if (kk === "l") { $("#pc-log", el).click(); e.preventDefault(); return; }
        if (kk === "s") { screenshot(); e.preventDefault(); return; }
        if (kk === "r" && !e.shiftKey) { ts().fitContent(); chart.priceScale("right").applyOptions({ autoScale: true }); e.preventDefault(); return; }
        if (map[kk]) { setTool(map[kk]); e.preventDefault(); return; }
      }
      if (e.shiftKey && k === "F") { fullscreen(); e.preventDefault(); return; }
      if (/^[0-9]$/.test(k) || (typed && /^[smhdwSMHDW]$/.test(k)) || (!typed && /^[DWdw]$/.test(k) && !e.altKey && !e.ctrlKey)) {
        typed += k; typedBox.hidden = false; typedBox.textContent = typed.toUpperCase();
        clearTimeout(typedTimer); typedTimer = setTimeout(() => { typed = ""; typedBox.hidden = true; }, 2500);
        e.preventDefault(); return;
      }
      if (k === "Enter" && typed) {
        const next = parseInterval(typed); typed = ""; typedBox.hidden = true;
        if (next && pc.onInterval) pc.onInterval(next);
      }
    }
    document.addEventListener("keydown", onKey);

    function modal(title, body, onMount) {
      const back = document.createElement("div");
      back.className = "modal-back open";
      back.innerHTML = `<div class="modal pc-modal" role="dialog" aria-modal="true"><div class="row" style="margin:0 0 8px;justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="btn" data-close>✕</button></div>${body}</div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) close(); });
      const esc2 = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc2); } };
      document.addEventListener("keydown", esc2);
      if (onMount) onMount(back.querySelector(".modal"), close);
      return close;
    }
    function openIndicators(tab) {
      const groups = ["Trend", "Momentum", "Volatility", "Volume"];
      const studiesHtml = (q = "") => groups.map((g) => {
        const items = Q.STUDIES.filter((s) => s.group === g && (!q || s.name.toLowerCase().includes(q) || s.id.includes(q)));
        if (!items.length) return "";
        const d = dataForStudies();
        return `<h3>${g}</h3>${items.map((s) => {
          const fit = Q.studyFits(s, Object.assign({}, d, { bench: [1] }));
          return `<button type="button" class="pc-item" data-add="${s.id}"${fit ? "" : " disabled title=\"Needs data this symbol or interval doesn't have\""}>
            <b>${esc(s.name)}</b><span>${esc(s.label(Object.fromEntries(s.params.map((p) => [p.key, p.def]))))}${s.kind === "pane" ? " · own pane" : ""}</span></button>`;
        }).join("")}`;
      }).join("") || '<p class="muted">No match.</p>';
      const booksHtml = Q.PLAYBOOKS.map((b) => `<div class="card pc-book"><div><b>${esc(b.name)}</b> <span class="badge">${LABEL[b.interval] || b.interval}</span></div>
        <p class="soft">${esc(b.about)}</p>
        <p class="caption">${b.studies.length ? b.studies.map((x) => { const d = Q.STUDIES.find((s) => s.id === x.id); return esc(d.label(Object.assign(Object.fromEntries(d.params.map((p) => [p.key, p.def])), x.params))); }).join(" · ") : "No indicators"}</p>
        <div class="row" style="margin-top:6px"><button class="btn primary" data-apply="${b.id}">Apply</button><button class="btn" data-append="${b.id}">Add to chart</button></div></div>`).join("");
      modal("Indicators", `
        <div class="subtabs" style="margin-top:0"><button type="button" data-tab="studies"${tab === "studies" ? ' class="on"' : ""}>Indicators</button><button type="button" data-tab="books"${tab === "books" ? ' class="on"' : ""}>Investor playbooks</button></div>
        <div data-pane="studies"${tab === "studies" ? "" : " hidden"}><input type="search" class="pc-isearch" placeholder="Search indicators" autocomplete="off"><div class="pc-list"></div>
          <p class="caption">Click to add; add the same indicator several times with different settings. Change settings with ⚙ in the chart legend.</p></div>
        <div data-pane="books"${tab === "books" ? "" : " hidden"}><p class="caption">The indicators these traders and investors are known for, from their books and interviews, with their published settings. Applying a playbook replaces the chart's indicators and switches to its usual interval.</p>${booksHtml}</div>`,
      (m, close) => {
        const list = $(".pc-list", m), input = $(".pc-isearch", m);
        list.innerHTML = studiesHtml();
        input.addEventListener("input", () => { list.innerHTML = studiesHtml(input.value.trim().toLowerCase()); });
        if (tab === "studies") setTimeout(() => input.focus(), 30);
        m.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
          m.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
          m.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
        }));
        list.addEventListener("click", (e) => {
          const b = e.target.closest("[data-add]");
          if (!b || b.disabled) return;
          state.studies.push(newInstance(b.dataset.add)); saveStudies(); rebuildStudies();
          b.classList.add("added"); setTimeout(() => b.classList.remove("added"), 700);
        });
        m.addEventListener("click", (e) => {
          const ap = e.target.closest("[data-apply], [data-append]");
          if (!ap) return;
          const book = Q.PLAYBOOKS.find((x) => x.id === (ap.dataset.apply || ap.dataset.append));
          const insts = book.studies.map((x) => newInstance(x.id, x.params));
          state.studies = ap.dataset.apply ? insts : [...state.studies, ...insts];
          saveStudies(); close();
          if (ap.dataset.apply && book.interval !== iv && FEED_INTERVALS[r.feed].includes(book.interval) && pc.onInterval) pc.onInterval(book.interval);
          else rebuildStudies();
        });
      });
    }
    function openSettings(inst) {
      const def = Q.STUDIES.find((s) => s.id === inst.id);
      const d = dataForStudies(), out = def.calc(d, inst.params);
      const lines = out.segments ? [] : out.lines;
      const field = (p) => {
        const v = inst.params[p.key];
        if (p.type === "select") return `<label>${esc(p.label)}<select data-k="${p.key}">${p.options.map((o) => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
        if (p.type === "date") return `<label>${esc(p.label)}<input type="text" data-k="${p.key}" value="${esc(v)}" placeholder="YYYY-MM-DD"></label>`;
        return `<label>${esc(p.label)}<input type="number" data-k="${p.key}" value="${v}" min="${p.min ?? ""}" max="${p.max ?? ""}" step="${p.step || (p.type === "int" ? 1 : 0.01)}"></label>`;
      };
      modal(`${def.name} settings`, `
        <div class="params">${def.params.map(field).join("") || '<p class="muted">No inputs.</p>'}</div>
        ${lines.length ? `<h3 style="margin-top:14px">Style</h3><div class="params">${lines.map((ln, k) => {
          const col = inst.colors[k] || colorOf(ln.color);
          return `<label>${esc(ln.name)}<input type="color" data-c="${k}" value="${/^#[0-9a-f]{6}$/i.test(col) ? col : "#2a78d6"}"></label>`; }).join("")}</div>` : ""}
        <div class="row"><button class="btn primary" data-ok>Apply</button><button class="btn" data-reset>Defaults</button></div>`,
      (m, close) => {
        $("[data-ok]", m).addEventListener("click", () => {
          m.querySelectorAll("[data-k]").forEach((x) => {
            const p = def.params.find((y) => y.key === x.dataset.k);
            inst.params[p.key] = p.type === "select" || p.type === "date" ? x.value.trim() : Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, Number(x.value)));
          });
          m.querySelectorAll("[data-c]").forEach((x) => { inst.colors[x.dataset.c] = x.value; });
          saveStudies(); rebuildStudies(); close();
        });
        $("[data-reset]", m).addEventListener("click", () => {
          inst.params = Object.fromEntries(def.params.map((p) => [p.key, p.def])); inst.colors = {};
          saveStudies(); rebuildStudies(); close();
        });
      });
    }

    const pc = {
      onInterval: null,
      destroy() {
        if (pc.destroyed) return;
        pc.destroyed = true;
        stopFeed(); clearTimeout(studyTimer); ro.disconnect(); document.removeEventListener("keydown", onKey);
        document.querySelectorAll(".pc-modal").forEach((m) => m.closest(".modal-back").remove());
        chart.remove();
      },
    };
    return pc;
  }


  // ==============================================================================================
  // Price alerts: checked in this tab only, from the same sources the Live page polls
  // ==============================================================================================
  const ALERT_KEY = "alerts", ALERT_EVERY = 15000;
  const ALERT_KINDS = { above: "Price at or above", below: "Price at or below", up: "Up from previous close by at least (%)", down: "Down from previous close by at least (%)" };
  const A = { timer: null, quotes: {}, checked: null, error: "", panel: null };
  const alertList = () => { const l = store.get(ALERT_KEY, []); return Array.isArray(l) ? l : []; };
  const saveAlerts = (l) => store.set(ALERT_KEY, l);  // store wraps localStorage in try/catch

  function describe(a) {
    const v = Number(a.value);
    return a.kind === "above" ? `at or above ${v}` : a.kind === "below" ? `at or below ${v}` : `${a.kind === "up" ? "up" : "down"} ${v}% or more from the previous close`;
  }
  function toast(text) {
    let box = document.getElementById("toasts");
    if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<span>${esc(text)}</span><button type="button" aria-label="Dismiss">✕</button>`;
    t.querySelector("button").addEventListener("click", () => t.remove());
    box.appendChild(t);
    setTimeout(() => t.remove(), 20000);
  }
  function notify(a, q) {
    const text = `${a.sym} is ${describe(a)}: ${q.price} (${q.source}).`;
    try {
      if ("Notification" in window && Notification.permission === "granted") { new Notification(`Price alert: ${a.sym}`, { body: text, tag: a.id }); return; }
    } catch (e) { /* some mobile browsers only notify from a service worker: fall back to the toast */ }
    toast(text);
  }
  /** Latest quotes {sym: {price, prev, source, at}} for the symbols of armed alerts. */
  async function fetchQuotes(syms) {
    const out = {}, rs = await Promise.all(syms.map((s) => resolve(s)));
    const coins = rs.filter((r) => r.feed === "binance"), stocks = rs.filter((r) => r.feed === "cnbc");
    for (const r of coins) {  // Binance's trading-day ticker: last price and the 00:00 UTC open
      try {
        const t = await getJSON(`${BINANCE_REST}/ticker/tradingDay?symbol=${r.pair}`);
        out[r.sym] = { price: +t.lastPrice, prev: +t.openPrice, source: "Binance, change since 00:00 UTC", at: new Date().toISOString() };
      } catch (e) { out[r.sym] = { error: `Binance has no ${r.pair} market` }; }
    }
    if (stocks.length) {  // one CNBC quote request for every stock, ETF and index
      const list = (((await getJSON(CNBC_QUOTE + encodeURIComponent(stocks.map((r) => r.cnbc).join("|")))).FormattedQuoteResult || {}).FormattedQuote || []);
      const num = (x) => parseFloat(String(x ?? "").replace(/,/g, ""));
      for (const r of stocks) {
        const q = list.find((x) => x.symbol === r.cnbc) || {};
        if (q.code === 0 && Number.isFinite(num(q.last))) {
          out[r.sym] = { price: num(q.last), prev: num(q.previous_day_closing), source: "CNBC quote", at: new Date().toISOString() };
          continue;
        }
        try {  // no quote for this market (e.g. Korea): the last bar of CNBC's 1-day chart, without a previous close
          const bars = cnbcBars(await getJSON(`${CNBC_CHART}1D.json?symbol=${encodeURIComponent(r.cnbc)}`), true);
          out[r.sym] = bars.length ? { price: bars[bars.length - 1].close, prev: NaN, source: "CNBC 1-day chart", at: new Date().toISOString() } : { error: noData(r) };
        } catch (e) { out[r.sym] = { error: e.throttled ? "CNBC is throttling requests" : e.message }; }
      }
    }
    return out;
  }
  async function checkAlerts() {
    const list = alertList(), armed = list.filter((a) => a.state === "armed");
    if (!armed.length) { stopAlerts(); renderAlerts(); return; }
    try {
      Object.assign(A.quotes, await fetchQuotes([...new Set(armed.map((a) => a.sym))]));
      A.error = "";
    } catch (e) { A.error = e.throttled ? "CNBC is throttling requests; retrying" : e.message; }
    A.checked = new Date();
    let changed = false;
    for (const a of armed) {
      const q = A.quotes[a.sym];
      if (!q || q.error) { a.note = q ? q.error : ""; continue; }
      const hit = Q.alertHit(a, q);
      a.note = hit === null ? "can't be checked: no previous close from this source" : "";
      if (hit) { Object.assign(a, { state: "triggered", firedAt: new Date().toISOString(), firedPrice: q.price, note: "" }); notify(a, q); changed = true; }
    }
    const current = alertList();  // merge: the visitor may have edited the list while quotes loaded
    for (const a of armed) { const k = current.findIndex((x) => x.id === a.id); if (k >= 0 && current[k].state === "armed") current[k] = a; }
    saveAlerts(current);
    renderAlerts();
    if (changed && !current.some((a) => a.state === "armed")) stopAlerts();
  }
  function startAlerts() {
    if (A.timer || !alertList().some((a) => a.state === "armed")) return;
    A.timer = setInterval(checkAlerts, ALERT_EVERY);
    checkAlerts();
  }
  function stopAlerts() { clearInterval(A.timer); A.timer = null; }

  /** The alert list and form, drawn into `el` (the Live page's panel). */
  function renderAlerts(el = A.panel, sym = el && el.dataset.sym) {
    if (!el || !el.isConnected) return;
    A.panel = el;
    if (sym) el.dataset.sym = sym;
    const list = alertList(), when = (iso) => new Date(iso).toLocaleString();
    el.innerHTML = `
      <h3>Price alerts ${typeof mq === "function" ? mq("alerts") : ""}</h3>
      <p class="caption">Alerts work only while this tab is open. No data leaves your browser: alerts are saved in it, and checking them only asks
        CNBC or Binance for the symbols' prices, as the Live chart does. Checked every ${ALERT_EVERY / 1000} s${A.checked ? `; last check ${esc(A.checked.toLocaleTimeString())}` : ""}${A.error ? ` (${esc(A.error)})` : ""}.</p>
      <div class="pc-alert-form">
        <label>Symbol<input type="text" id="al-sym" value="${esc(el.dataset.sym || "")}" spellcheck="false" autocomplete="off"></label>
        <label>Condition<select id="al-kind">${Object.entries(ALERT_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
        <label>Value<input type="number" id="al-value" step="any" min="0"></label>
        <button type="button" class="btn primary" id="al-add">Add alert</button>
      </div>
      <p class="caption" id="al-msg"></p>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Symbol</th><th>Alert when</th><th>Status</th><th class="r">Last price</th><th></th></tr></thead><tbody>
        ${list.map((a) => { const q = A.quotes[a.sym]; return `<tr><td><a href="#/live/${encodeURIComponent(a.sym)}"><b>${esc(a.sym)}</b></a></td><td>${esc(describe(a))}</td>
          <td>${a.state === "triggered" ? `<span class="badge good">Triggered</span> ${esc(when(a.firedAt))} at ${esc(String(a.firedPrice))}` : `<span class="badge info">Armed</span>${a.note ? ` <span class="muted">${esc(a.note)}</span>` : ""}`}</td>
          <td class="r">${q && !q.error ? `${esc(String(q.price))} <span class="muted">${esc(q.source)}</span>` : "–"}</td>
          <td class="r">${a.state === "triggered" ? `<button type="button" class="btn q-small" data-rearm="${esc(a.id)}">Re-arm</button>` : ""}
            <button type="button" class="btn q-small" data-del="${esc(a.id)}">Delete</button></td></tr>`; }).join("")}</tbody></table></div>` : '<p class="caption">No alerts yet.</p>'}`;
    const msg = (t) => { $("#al-msg", el).textContent = t; };
    $("#al-add", el).addEventListener("click", async () => {
      const s = $("#al-sym", el).value.trim().toUpperCase(), kind = $("#al-kind", el).value, value = Number($("#al-value", el).value);
      if (!s) { msg("Enter a symbol."); return; }
      if (!(value > 0)) { msg("Enter a positive value."); return; }
      const r = await resolve(s);
      if (!r.row && r.feed !== "binance") { msg(`${s} isn't in the universe.`); return; }
      const first = !alertList().length;
      saveAlerts([...alertList(), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, sym: r.sym, kind, value, state: "armed", created: new Date().toISOString() }]);
      if (first && "Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (e) { /* older Safari: callback form only; the toast still works */ }
      }
      if (A.timer) checkAlerts(); else startAlerts();  // check the new alert straight away
      renderAlerts();
    });
    el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { saveAlerts(alertList().filter((a) => a.id !== b.dataset.del)); renderAlerts(); }));
    el.querySelectorAll("[data-rearm]").forEach((b) => b.addEventListener("click", () => {
      saveAlerts(alertList().map((a) => (a.id === b.dataset.rearm ? Object.assign(a, { state: "armed", firedAt: null, firedPrice: null, note: "" }) : a)));
      if (A.timer) checkAlerts(); else startAlerts();
      renderAlerts();
    }));
  }
  // Alerts keep running on every page of the site while the tab is open.
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", startAlerts); else startAlerts();

  window.LIVE = { view, dailyHistory, checkAlerts };
})();
