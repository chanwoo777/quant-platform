/* Live charts: TradingView Lightweight Charts fed by WebSocket streams.
 *   Crypto     Binance public market data: REST klines seed the chart, then a combined
 *              kline + miniTicker stream updates it. No key needed.
 *   US stocks  Finnhub trade stream with the visitor's own free key (⚙ settings); trades are
 *              aggregated into candles in the browser. Free Finnhub data covers US exchanges.
 * The socket reconnects with backoff, pauses while the tab is hidden, and closes when the
 * visitor leaves the page (window.onRouteCleanup from app.js).
 */
(function () {
  "use strict";
  const LWC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
  const BINANCE_REST = "https://data-api.binance.vision/api/v3";
  const BINANCE_WS = "wss://data-stream.binance.vision/stream?streams=";
  const FINNHUB_WS = "wss://ws.finnhub.io?token=";
  const INTERVALS = { binance: ["1m", "5m", "15m", "1h", "4h", "1d"], finnhub: ["1m", "5m", "15m"] };
  const SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const CRYPTO_PICKS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT"];
  const STOCK_PICKS = ["AAPL", "NVDA", "MSFT", "TSLA", "SPY", "QQQ"];
  const state = { interval: "1m" };
  let lwc = null;

  function loadLibrary() {
    if (window.LightweightCharts) return Promise.resolve();
    if (!lwc) {
      lwc = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = LWC_URL; s.onload = resolve;
        s.onerror = () => { lwc = null; reject(new Error("Couldn't load the chart library from cdn.jsdelivr.net")); };
        document.head.appendChild(s);
      });
    }
    return lwc;
  }
  const sourceOf = (sym) => (/(USDT|USDC|FDUSD)$/.test(sym) && sym.length > 5 ? "binance" : "finnhub");
  const localShift = () => -new Date().getTimezoneOffset() * 60;  // the chart axis shows the visitor's local time
  const fmt = (x) => (x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4).replace(/0{1,2}$/, "") : x.toPrecision(4));

  async function view(el, arg) {
    const sym = String(arg || store.get("liveSymbol", "BTCUSDT")).toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    store.set("liveSymbol", sym);
    const src = sourceOf(sym);
    if (!INTERVALS[src].includes(state.interval)) state.interval = "1m";
    const picks = (list) => list.map((s) => `<a class="chip${s === sym ? " on" : ""}" href="#/live/${s}">${s.replace(/USDT$/, "")}</a>`).join("");
    el.innerHTML = `
      <h1>Live charts</h1>
      <p class="soft">Real-time candles over WebSocket, in your local time zone. Crypto streams from Binance's public market data (no key needed).
        US stocks stream live trades from Finnhub using your free key (⚙ settings); outside US market hours there are no trades.</p>
      <div class="controls">
        <div class="control" style="width:min(300px,100%)"><span class="label">Symbol</span><div id="lv-search">${searchBox("BTC, ETH, AAPL, NVDA…")}</div></div>
        <div class="control"><span class="label">Crypto</span><div class="chips">${picks(CRYPTO_PICKS)}</div></div>
        <div class="control"><span class="label">US stocks</span><div class="chips">${picks(STOCK_PICKS)}</div></div>
        <div class="control"><span class="label">Interval</span><div class="chips" id="lv-int">${INTERVALS[src].map((i) =>
          `<button type="button" class="chip${i === state.interval ? " on" : ""}" data-v="${i}">${i}</button>`).join("")}</div></div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:10px">
        <div><div class="caption">${esc(sym)} · ${src === "binance" ? "Binance spot" : "Finnhub · US trades"}</div>
          <span class="ticker-price" id="lv-price">–</span> <span id="lv-change"></span></div>
        <span class="status wait" id="lv-status"><i></i><span>Connecting…</span></span>
      </div>
      <div class="live-chart" id="lv-chart"></div>
      <div id="lv-extra"></div>`;
    bindSearch($("#lv-search", el), (s) => { location.hash = `#/live/${encodeURIComponent(liveSymbolFor(s) || s)}`; });
    el.querySelectorAll("#lv-int .chip").forEach((b) => b.addEventListener("click", () => { state.interval = b.dataset.v; view(el, sym); }));

    try { await loadLibrary(); } catch (e) { $("#lv-chart").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const session = src === "binance" ? binance(sym) : finnhub(sym);
    window.onRouteCleanup(session.stop);
    session.start();
  }

  // --- shared chart + connection plumbing ---------------------------------------------------------
  function makeChart() {
    const c = pal(), box = $("#lv-chart");
    box.innerHTML = "";
    const chart = LightweightCharts.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: c.ink2, fontFamily: FONT },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.axis },
      timeScale: { borderColor: c.axis, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const candles = chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
    const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const volColor = (bar) => (bar.close >= bar.open ? c.up : c.down) + "66";
    return {
      chart, candles, volume,
      set(bars) { candles.setData(bars); volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: volColor(b) }))); chart.timeScale().fitContent(); },
      update(b) { candles.update(b); volume.update({ time: b.time, value: b.volume, color: volColor(b) }); },
    };
  }
  function setStatus(kind, text) {
    const s = $("#lv-status");
    if (!s) return;
    s.className = `status ${kind}`;
    s.lastElementChild.textContent = text;
  }
  function setPrice(price, change) {
    const p = $("#lv-price"), ch = $("#lv-change");
    if (p && Number.isFinite(price)) p.textContent = fmt(price);
    if (ch && Number.isFinite(change)) ch.innerHTML = `<span class="${change >= 0 ? "pos" : "neg"}">${(change >= 0 ? "+" : "−") + Math.abs(change * 100).toFixed(2)}%</span>`;
  }
  /** WebSocket with reconnect-with-backoff and pause-while-hidden. */
  function socket(url, { onOpen, onMessage, onResume }) {
    let ws = null, stopped = false, tries = 0, timer = null;
    const connect = () => {
      if (stopped || document.hidden) return;
      setStatus("wait", tries ? "Reconnecting…" : "Connecting…");
      ws = new WebSocket(url);
      ws.onopen = () => { tries = 0; onOpen && onOpen(ws); };
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
      ws.onclose = () => {
        ws = null;
        if (stopped || document.hidden) return;
        const delay = [1, 2, 5, 10, 30][Math.min(tries++, 4)] * 1000;
        setStatus("err", `Disconnected; retrying in ${delay / 1000}s`);
        timer = setTimeout(connect, delay);
      };
    };
    const onVisibility = () => {
      if (document.hidden) { if (ws) { ws.onclose = null; ws.close(); ws = null; } setStatus("wait", "Paused while the tab is hidden"); }
      else if (!stopped && !ws) { (onResume ? onResume() : Promise.resolve()).finally(connect); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return {
      start: connect,
      stop() { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); if (ws) { ws.onclose = null; ws.close(); } },
    };
  }

  // --- Binance (crypto, keyless) ------------------------------------------------------------------
  function binance(sym) {
    const iv = state.interval, lower = sym.toLowerCase();
    let ui = null, conn = null, seen = false;
    const toBar = (k) => ({ time: Math.floor(k[0] / 1000) + localShift(), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    async function seed() {
      const r = await fetch(`${BINANCE_REST}/klines?symbol=${sym}&interval=${iv}&limit=500`);
      if (r.status === 400) throw new Error(`Binance has no ${sym} pair. Try a USDT pair such as BTCUSDT.`);
      if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
      const bars = (await r.json()).map(toBar);
      ui.set(bars);
      const t = await fetch(`${BINANCE_REST}/ticker/24hr?symbol=${sym}`).then((x) => x.json()).catch(() => null);
      setPrice(bars.length ? bars[bars.length - 1].close : NaN, t ? +t.priceChangePercent / 100 : NaN);
    }
    return {
      async start() {
        ui = makeChart();
        try { await seed(); } catch (e) { setStatus("err", e.message); $("#lv-extra").innerHTML = `<div class="note">${esc(e.message)}</div>`; return; }
        conn = socket(`${BINANCE_WS}${lower}@kline_${iv}/${lower}@miniTicker`, {
          onMessage(msg) {
            const d = msg.data || {};
            if (d.e === "kline") {
              const k = d.k;
              ui.update({ time: Math.floor(k.t / 1000) + localShift(), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
              setPrice(+k.c, NaN);
            } else if (d.e === "24hrMiniTicker") {
              setPrice(+d.c, +d.c / +d.o - 1);
            }
            if (!seen) { seen = true; } setStatus("live", "Live");
          },
          onResume: () => seed().catch(() => {}),  // fill the gap left while the tab was hidden
        });
        conn.start();
        $("#lv-extra").innerHTML = `<p class="caption">Data: Binance spot market (data-api.binance.vision / data-stream.binance.vision). Prices in the quote currency (${esc(sym.match(/(USDT|USDC|FDUSD)$/)[1])}).</p>`;
      },
      stop() { if (conn) conn.stop(); if (ui) ui.chart.remove(); },
    };
  }

  // --- Finnhub (US stocks, visitor's key) ---------------------------------------------------------
  function finnhub(sym) {
    const iv = state.interval, step = SECONDS[iv];
    let ui = null, conn = null, prevClose = NaN, last = null, idleTimer = null;
    const tape = [];
    return {
      async start() {
        ui = makeChart();
        const key = FH.key();
        if (!key) {
          setStatus("err", "No Finnhub key");
          $("#lv-extra").innerHTML = `<div class="note">Live US stock prices need a free Finnhub API key. Get one at
            <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a> and paste it in ⚙ settings (top right).
            It stays in this browser. Crypto works without a key.</div>`;
          return;
        }
        try {
          const q = await FH.get("quote", { symbol: sym });
          if (q && q.c) { prevClose = q.pc; setPrice(q.c, q.pc ? q.c / q.pc - 1 : NaN); }
          else { $("#lv-extra").innerHTML = `<div class="note">Finnhub has no quote for ${esc(sym)}. Free Finnhub data covers US-listed symbols.</div>`; }
        } catch (e) { $("#lv-extra").innerHTML = `<div class="note">${esc(e.message)}</div>`; }
        const extra = $("#lv-extra");
        extra.insertAdjacentHTML("beforeend", `<h2>Trades</h2><div class="tape table-wrap" id="lv-tape"><div class="empty">Waiting for trades…</div></div>
          <p class="caption">Candles are built in your browser from Finnhub's trade stream, starting when this page opened. Data: Finnhub (finnhub.io).</p>`);
        idleTimer = setTimeout(() => setStatus("wait", "Connected, no trades yet (US market hours are 9:30–16:00 New York time, Mon–Fri)"), 20000);
        conn = socket(FINNHUB_WS + encodeURIComponent(key), {
          onOpen(ws) { ws.send(JSON.stringify({ type: "subscribe", symbol: sym })); setStatus("wait", "Connected, waiting for trades…"); },
          onMessage(msg) {
            if (msg.type === "error") { setStatus("err", msg.msg || "Finnhub error"); return; }
            if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
            clearTimeout(idleTimer);
            for (const tr of msg.data) {
              if (tr.s !== sym) continue;
              const t = Math.floor(tr.t / 1000 / step) * step + localShift();
              if (!last || t > last.time) last = { time: t, open: tr.p, high: tr.p, low: tr.p, close: tr.p, volume: tr.v || 0 };
              else if (t === last.time) Object.assign(last, { high: Math.max(last.high, tr.p), low: Math.min(last.low, tr.p), close: tr.p, volume: last.volume + (tr.v || 0) });
              else continue;  // late trade for an earlier candle
              ui.update(Object.assign({}, last));
              tape.unshift(tr); tape.length = Math.min(tape.length, 60);
            }
            if (last) setPrice(last.close, Number.isFinite(prevClose) && prevClose ? last.close / prevClose - 1 : NaN);
            setStatus("live", "Live");
            const box = $("#lv-tape");
            if (box) box.innerHTML = `<table><thead><tr><th>Time</th><th class="r">Price</th><th class="r">Size</th></tr></thead><tbody>${tape.map((tr) =>
              `<tr><td>${new Date(tr.t).toLocaleTimeString()}</td><td class="r">${fmt(tr.p)}</td><td class="r">${(tr.v || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>`;
          },
        });
        conn.start();
      },
      stop() { clearTimeout(idleTimer); if (conn) conn.stop(); if (ui) ui.chart.remove(); },
    };
  }

  window.LIVE = { view };
})();
