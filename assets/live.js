/* Live charts with TradingView-style indicators.
 *
 * Two engines:
 *   TradingView  TradingView's free embeddable chart (tv.js): real-time US stocks and ETFs
 *                (Cboe One), XETRA, TSX, ASX and Binance crypto, no key, full history and the
 *                full indicator menu. The indicators picked here are preloaded as studies.
 *   Native       TradingView Lightweight Charts drawn by this site, with the same indicators
 *                computed in quant.js:
 *                  crypto     Binance public market data: REST klines + WebSocket kline stream
 *                  US stocks  Finnhub trade WebSocket with the visitor's free key, aggregated
 *                             into candles; without a key, the nightly daily bars
 *                  others     the nightly daily bars (markets the free widget doesn't carry)
 * Sockets reconnect with backoff, pause while the tab is hidden, and close when the visitor
 * leaves the page (window.onRouteCleanup from app.js).
 */
(function () {
  "use strict";
  const LWC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
  const TV_URL = "https://s3.tradingview.com/tv.js";
  const BINANCE_REST = "https://data-api.binance.vision/api/v3";
  const BINANCE_WS = "wss://data-stream.binance.vision/stream?streams=";
  const FINNHUB_WS = "wss://ws.finnhub.io?token=";
  const SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
  const TV_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" };
  const CRYPTO_PICKS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT"];
  const STOCK_PICKS = ["AAPL", "NVDA", "MSFT", "TSLA", "SPY", "QQQ"];
  // Yahoo exchange codes -> TradingView prefixes for listings the free widget carries.
  const US_EXCHANGES = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ", NYQ: "NYSE", NYS: "NYSE",
    ASE: "AMEX", AMX: "AMEX", PCX: "AMEX", ARCA: "AMEX", BTS: "BATS", BATS: "BATS" };
  // Suffix -> TradingView exchange, for "view on TradingView" links (the widget refuses most).
  const SUFFIX_EXCHANGE = { KS: "KRX", KQ: "KRX", T: "TSE", HK: "HKEX", L: "LSE", NS: "NSE", BO: "BSE", TW: "TWSE", TWO: "TPEX",
    PA: "EURONEXT", AS: "EURONEXT", BR: "EURONEXT", LS: "EURONEXT", SW: "SIX", MI: "MIL", MC: "BME", ST: "OMXSTO", CO: "OMXCOP",
    HE: "OMXHEX", OL: "OSL", SS: "SSE", SZ: "SZSE", DE: "XETR", TO: "TSX", V: "TSXV", AX: "ASX" };
  const WIDGET_OK = new Set(["NASDAQ", "NYSE", "AMEX", "BATS", "XETR", "TSX", "ASX", "BINANCE"]);
  const state = {
    engine: {},  // per symbol kind: "tv" | "native"
    tvInterval: store.get("tvInterval", "15m"),
    nativeInterval: store.get("nativeInterval", "1m"),
    indicators: new Set(store.get("liveIndicators", ["ema", "vwap", "rsi", "macd"])),
  };
  const loaded = {};
  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve();
    if (!loaded[url]) {
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url; s.onload = resolve;
        s.onerror = () => { delete loaded[url]; reject(new Error(`Couldn't load ${new URL(url).host}`)); };
        document.head.appendChild(s);
      });
    }
    return loaded[url];
  }
  const localShift = () => -new Date().getTimezoneOffset() * 60;  // the native axis shows local time
  const fmt = (x) => (!Number.isFinite(x) ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(2) : x.toPrecision(4));
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const nyClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  function usMarketOpen(now = new Date()) {
    const [wd, hm] = nyClock.format(now).split(" ");
    const [h, m] = hm.split(":").map(Number), mins = (h % 24) * 60 + m;
    return !["Sat", "Sun"].includes(wd.replace(",", "")) && mins >= 570 && mins < 960;  // 9:30-16:00 New York (holidays not checked)
  }

  /** What is this symbol and which engines can show it? */
  async function resolve(arg) {
    const s = String(arg).toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (/(USDT|USDC|FDUSD)$/.test(s) && s.length > 5) return { kind: "crypto", sym: s, pair: s, name: s.replace(/(USDT|USDC|FDUSD)$/, " / $1"), tv: "BINANCE:" + s };
    const row = await rowFor(s);
    if (row && row.a === "c") {
      const pair = s.replace(/\d*-USD$/, "").replace(/[^A-Z0-9]/g, "") + "USDT";
      return { kind: "crypto", sym: s, pair, name: row.n, tv: "BINANCE:" + pair, row };
    }
    const info = row ? ((await symbolData(s)) || {}).info || {} : {};
    const us = row ? row.m === "US" || row.m === "US ETFs" : usTicker(s);
    let tv = null, link = null;
    if (us) {
      const t = s.replace(/-/g, ".");
      tv = US_EXCHANGES[info.ex] ? `${US_EXCHANGES[info.ex]}:${t}` : t;
      link = tv.includes(":") ? tv : null;
    } else {
      const m = s.match(/^(.+)\.([A-Z]+)$/);
      if (m && SUFFIX_EXCHANGE[m[2]]) {
        const ex = SUFFIX_EXCHANGE[m[2]], code = ex === "HKEX" ? m[1].replace(/^0+/, "") : m[1].replace(/-/g, ".");
        link = `${ex}:${code}`;
        if (WIDGET_OK.has(ex)) tv = link;
      }
    }
    return { kind: us ? "us" : row ? "intl" : "unknown", sym: s, name: row ? row.n : s, tv, link: link || tv, row, deep: await isDeep(s) };
  }
  const engines = (r) => (r.kind === "crypto" ? ["native", "tv"] : r.kind === "unknown" ? (FH.key() ? ["tv", "native"] : ["tv"])
    : r.tv ? ["tv", "native"] : ["native"]);

  async function view(el, arg) {
    const r = await resolve(arg || store.get("liveSymbol", "BTCUSDT"));
    store.set("liveSymbol", r.sym);
    const avail = engines(r);
    let engine = state.engine[r.kind] && avail.includes(state.engine[r.kind]) ? state.engine[r.kind] : avail[0];
    if (r.kind === "unknown" && !r.tv) {
      el.innerHTML = `<h1>Live charts</h1><div class="note">${esc(r.sym)} isn't in the universe and isn't a US ticker or a Binance pair (like BTCUSDT).</div>`;
      return;
    }
    const picks = (list) => list.map((s) => `<a class="chip${s === r.sym ? " on" : ""}" href="#/live/${s}">${s.replace(/USDT$/, "")}</a>`).join("");
    const nativeLabel = r.kind === "crypto" ? "Native · Binance WebSocket"
      : (r.kind === "us" || r.kind === "unknown") && FH.key() ? "Native · Finnhub WebSocket" : "Native · daily bars";
    el.innerHTML = `
      <h1>Live charts</h1>
      <div class="controls">
        <div class="control" style="width:min(300px,100%)"><span class="label">Symbol</span><div id="lv-search">${searchBox("BTC, AAPL, SAP.DE, 005930.KS…")}</div></div>
        <div class="control"><span class="label">Crypto</span><div class="chips">${picks(CRYPTO_PICKS)}</div></div>
        <div class="control"><span class="label">US stocks</span><div class="chips">${picks(STOCK_PICKS)}</div></div>
      </div>
      <div class="asset-head" style="margin-top:4px"><h2 style="margin:0">${esc(r.sym)}</h2><span class="soft">${esc(r.name || "")}</span>
        ${r.row ? `<a href="#/stock/${encodeURIComponent(r.sym)}">Stock page</a> · <a href="#/financials/${encodeURIComponent(r.sym)}">Research</a>` : ""}
        ${r.link ? ` · <a href="https://www.tradingview.com/symbols/${esc(r.link.replace(":", "-"))}/" target="_blank" rel="noopener">View on TradingView ↗</a>` : ""}</div>
      <div class="controls">
        ${avail.length > 1 ? `<div class="control"><span class="label">Chart</span><div class="chips" id="lv-engine">${avail.map((e) =>
          `<button type="button" class="chip${e === engine ? " on" : ""}" data-v="${e}">${e === "tv" ? "TradingView · real-time" : nativeLabel}</button>`).join("")}</div></div>` : ""}
        <div class="control"><span class="label">Interval</span><div class="chips" id="lv-int"></div></div>
      </div>
      <div class="controls" style="margin-top:0">
        <div class="control"><span class="label">Overlays</span><div class="chips" id="lv-over"></div></div>
        <div class="control"><span class="label">Oscillators</span><div class="chips" id="lv-osc"></div></div>
      </div>
      <div class="row" id="lv-quote" style="justify-content:space-between;align-items:flex-end;margin:0 0 10px">
        <div><span class="ticker-price" id="lv-price">–</span> <span id="lv-change"></span><div class="caption" id="lv-sub"></div></div>
        <span class="status wait" id="lv-status"><i></i><span>Loading…</span></span>
      </div>
      <div class="live-chart" id="lv-chart"></div>
      <div class="caption" id="lv-legend" style="margin-top:6px"></div>
      <div id="lv-extra"></div>`;
    bindSearch($("#lv-search", el), (s) => { location.hash = `#/live/${encodeURIComponent(s)}`; });
    el.querySelectorAll("#lv-engine .chip").forEach((b) => b.addEventListener("click", () => { state.engine[r.kind] = b.dataset.v; view(el, r.sym); }));

    const session = engine === "tv" ? tradingView(r) : r.kind === "crypto" ? binance(r)
      : (r.kind === "us" || r.kind === "unknown") && FH.key() ? finnhub(r) : dailyBars(r);
    // Interval and indicator chips; the engine says which apply.
    const ints = session.intervals;
    const cur = engine === "tv" ? state.tvInterval : state.nativeInterval;
    session.interval = ints.includes(cur) ? cur : ints[0];
    $("#lv-int").innerHTML = ints.map((i) => `<button type="button" class="chip${i === session.interval ? " on" : ""}" data-v="${i}">${i === "1d" ? "1D" : i === "1w" ? "1W" : i}</button>`).join("");
    el.querySelectorAll("#lv-int .chip").forEach((b) => b.addEventListener("click", () => {
      if (engine === "tv") { state.tvInterval = b.dataset.v; store.set("tvInterval", b.dataset.v); }
      else { state.nativeInterval = b.dataset.v; store.set("nativeInterval", b.dataset.v); }
      view(el, r.sym);
    }));
    const drawChips = () => {
      const fits = (ind) => (engine === "tv" ? !(ind.intraday && ["1d", "1w"].includes(session.interval)) : session.fits(ind));
      for (const [box, kind] of [["#lv-over", "overlay"], ["#lv-osc", "pane"]]) {
        $(box).innerHTML = Q.INDICATORS.filter((i) => i.kind === kind).map((i) => {
          const ok = fits(i);
          return `<button type="button" class="chip${state.indicators.has(i.id) && ok ? " on" : ""}" data-v="${i.id}"${ok ? "" : ` disabled title="${esc(session.whyNot(i))}" style="opacity:.45"`}>${esc(i.name)}</button>`;
        }).join("");
      }
      el.querySelectorAll("#lv-over .chip, #lv-osc .chip").forEach((b) => b.addEventListener("click", () => {
        const id = b.dataset.v;
        state.indicators.has(id) ? state.indicators.delete(id) : state.indicators.add(id);
        store.set("liveIndicators", [...state.indicators]);
        drawChips();
        session.setIndicators(Q.INDICATORS.filter((i) => state.indicators.has(i.id) && fits(i)));
      }));
      return Q.INDICATORS.filter((i) => state.indicators.has(i.id) && fits(i));
    };
    const active = drawChips();
    window.onRouteCleanup(session.stop);
    try {
      await session.start(active);
    } catch (e) {
      console.error(e);
      setStatus("err", e.message);
      $("#lv-extra").innerHTML = `<div class="note">${esc(e.message)}</div>`;
    }
  }

  function setStatus(kind, text) {
    const s = $("#lv-status");
    if (!s) return;
    s.className = `status ${kind}`;
    s.lastElementChild.textContent = text;
  }
  function setPrice(price, change, sub) {
    const p = $("#lv-price"), ch = $("#lv-change"), sb = $("#lv-sub");
    if (p && Number.isFinite(price)) p.textContent = fmt(price);
    if (ch && Number.isFinite(change)) ch.innerHTML = `<span class="${change >= 0 ? "pos" : "neg"}">${(change >= 0 ? "+" : "−") + Math.abs(change * 100).toFixed(2)}%</span>`;
    if (sb && sub !== undefined) sb.textContent = sub;
  }

  // ==============================================================================================
  // TradingView embeddable chart
  // ==============================================================================================
  function tradingView(r) {
    const s = {
      intervals: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
      fits: () => true, whyNot: () => "",
      async start(indicators) {
        $("#lv-quote").style.display = "none";
        await loadScript(TV_URL, "TradingView");
        $("#lv-extra").innerHTML = `<p class="caption" id="lv-tvnote"></p><p class="caption">Chart and data by <a href="https://www.tradingview.com/" target="_blank" rel="noopener nofollow">TradingView</a>.
          US stocks show TradingView's free real-time feed (Cboe One), which can differ slightly from the consolidated tape.
          Use the chart's own <b>Indicators</b> menu for anything not listed above (100+ built-ins).</p>`;
        draw(indicators);
      },
      setIndicators: draw,
      stop() {},
    };
    function draw(indicators) {
      const box = $("#lv-chart");
      if (!box) return;
      // The free widget keeps at most 5 studies, and drops entries when plain ids and
      // {id, inputs} objects are mixed: send objects only, in the order picked, up to 5.
      const studies = [], skipped = [];
      for (const ind of indicators) {
        const list = ind.tv.map((x) => (typeof x === "string" ? { id: x } : x));
        if (studies.length + list.length <= 5) studies.push(...list); else skipped.push(ind.name);
      }
      const note = $("#lv-tvnote");
      if (note) note.textContent = skipped.length ? `TradingView's free chart shows up to 5 indicators (EMA 9/21 and SMA 50/200 count as two), so ${skipped.join(", ")} ${skipped.length > 1 ? "were" : "was"} left out. Add them from the chart's Indicators menu.` : "";
      box.style.height = "min(78vh, 720px)";
      box.innerHTML = '<div id="tv-widget" style="height:100%"></div>';
      new TradingView.widget({
        container_id: "tv-widget", symbol: r.tv, interval: TV_INTERVAL[s.interval], autosize: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC", theme: isDark() ? "dark" : "light",
        style: "1", locale: "en", allow_symbol_change: true, withdateranges: true, details: false, hide_side_toolbar: false,
        enable_publishing: false, save_image: true, studies,
      });
    }
    return s;
  }

  // ==============================================================================================
  // Native chart (Lightweight Charts) with indicator overlays and oscillator bands
  // ==============================================================================================
  function nativeChart(intraday) {
    const c = pal(), box = $("#lv-chart");
    box.innerHTML = "";
    const chart = LightweightCharts.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: c.ink2, fontFamily: FONT },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.axis },
      timeScale: { borderColor: c.axis, timeVisible: intraday, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const color = (key) => ({ s0: c.series[0], s1: c.series[1], s2: c.series[2], s3: c.series[3], s4: c.series[4], s5: c.series[5], s6: c.series[6], s7: c.series[7] }[key] || c[key] || key);
    let main = null, volume = null, extra = [], bars = [], lineMode = false, active = [], pending = null;
    const mainSeries = (line) => {
      lineMode = line;
      main = line ? chart.addLineSeries({ color: c.ink, lineWidth: 2 })
        : chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
    };
    function layoutBands() {
      const panes = active.filter((i) => i.kind === "pane").length;
      const share = Math.min(0.56, 0.2 * panes), mainBottom = share;
      main.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: mainBottom + (volume ? 0.12 : 0.03) } });
      if (volume) volume.priceScale().applyOptions({ scaleMargins: { top: 1 - mainBottom - 0.12, bottom: mainBottom } });
      return { share, band: panes ? share / panes : 0 };
    }
    function drawIndicators() {
      pending = null;
      extra.forEach((s) => chart.removeSeries(s));
      extra = [];
      if (!bars.length) return;
      const d = {
        time: bars.map((b) => b.time), open: bars.map((b) => b.open), close: bars.map((b) => b.close),
        high: lineMode ? null : bars.map((b) => b.high), low: lineMode ? null : bars.map((b) => b.low),
        volume: volume ? bars.map((b) => b.volume) : null, intraday, session: (i) => bars[i].session,
      };
      const { band } = layoutBands();
      let pane = 0;
      const legend = [];
      for (const ind of active) {
        const out = ind.calc(d), isPane = ind.kind === "pane";
        if (out.segments) {  // one line coloured per point (v4 lines don't break on blank points)
          const sg = out.segments, s = chart.addLineSeries({ lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
          s.setData(d.time.map((t, i) => (sg.values[i] == null ? { time: t } : { time: t, value: sg.values[i], color: sg.up[i] ? c.good : c.bad })));
          extra.push(s);
          const lastI = sg.values.length - 1;
          legend.push(`<span style="color:${sg.up[lastI] ? c.good : c.bad}">■</span> ${esc(sg.name)} ${fmt(sg.values[lastI])}`);
          continue;
        }
        const scaleId = isPane ? `pane-${ind.id}` : "right";
        const top = isPane ? 1 - band * (active.filter((i) => i.kind === "pane").length - pane) : 0;
        const margins = isPane ? { top: top + 0.02, bottom: 1 - (top + band) + 0.005 } : null;
        if (out.hist) {
          const h = chart.addHistogramSeries({ priceScaleId: scaleId, lastValueVisible: false, priceLineVisible: false });
          h.setData(d.time.map((t, i) => (out.hist[i] == null ? { time: t } : { time: t, value: out.hist[i], color: (out.hist[i] >= 0 ? c.up : c.down) + "99" })));
          extra.push(h);
        }
        out.lines.forEach((ln, k) => {
          const s = chart.addLineSeries({ color: color(ln.color), lineWidth: ln.dots ? 1 : 2, priceScaleId: scaleId, lastValueVisible: false,
            priceLineVisible: false, crosshairMarkerVisible: false, lineStyle: ln.dash ? 2 : 0,
            ...(ln.dots ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}) });
          s.setData(d.time.map((t, i) => (ln.values[i] == null ? { time: t } : { time: t, value: ln.values[i] })));
          if (k === 0 && out.levels) out.levels.forEach((lv) => s.createPriceLine({ price: lv, color: c.axis, lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
          extra.push(s);
          const last = [...ln.values].reverse().find((v) => v != null);
          legend.push(`<span style="color:${color(ln.color)}">■</span> ${esc(ln.name)} ${fmt(last)}`);
        });
        if (isPane) {
          chart.priceScale(scaleId).applyOptions({ scaleMargins: margins, visible: false });
          pane++;
        }
      }
      const lg = $("#lv-legend");
      if (lg) lg.innerHTML = legend.join(" &nbsp; ") + (active.some((i) => i.id === "ichimoku") ? " &nbsp; (cloud drawn up to the last bar)" : "");
    }
    return {
      chart,
      setBars(list, { line = false, withVolume = true } = {}) {
        if (!main) {
          mainSeries(line);
          if (withVolume) {
            volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
          }
        }
        bars = list;
        main.setData(bars.map((b) => (lineMode ? { time: b.time, value: b.close } : b)));
        if (volume) volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: (b.close >= b.open ? c.up : c.down) + "55" })));
        drawIndicators();
        chart.timeScale().fitContent();
      },
      update(b) {
        const lastBar = bars[bars.length - 1];
        if (lastBar && b.time === lastBar.time) bars[bars.length - 1] = b;
        else if (!lastBar || b.time > lastBar.time) bars.push(b);
        else return;
        main.update(lineMode ? { time: b.time, value: b.close } : b);
        if (volume) volume.update({ time: b.time, value: b.volume, color: (b.close >= b.open ? c.up : c.down) + "55" });
        if (!pending) pending = setTimeout(drawIndicators, 1000);  // indicators refresh at most once a second
      },
      setIndicators(list) { active = list; drawIndicators(); },
      remove() { clearTimeout(pending); chart.remove(); },
      get bars() { return bars; },
    };
  }
  function nativeSession(intervals, fitsFn, whyNotFn) {
    return { intervals, fits: fitsFn, whyNot: whyNotFn };
  }
  const needsText = { hlc: "needs high/low prices", hlcv: "needs high/low prices and volume", cv: "needs volume" };

  /** WebSocket with reconnect-with-backoff and pause-while-hidden. */
  function socket(url, { onOpen, onMessage, onResume }) {
    let ws = null, stopped = false, tries = 0, timer = null;
    const connect = () => {
      if (stopped || document.hidden) return;
      setStatus("wait", tries ? "Reconnecting…" : "Connecting…");
      ws = new WebSocket(url);
      ws.onopen = () => { tries = 0; if (onOpen) onOpen(ws); };
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

  // --- Binance (crypto, keyless) ---------------------------------------------------------------
  function binance(r) {
    let ui = null, conn = null;
    const s = nativeSession(["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
      (ind) => !(ind.intraday && ["1d", "1w"].includes(s.interval)), (ind) => (ind.intraday ? "intraday intervals only" : ""));
    const utcDay = (t) => Math.floor(t / 86400);
    const toBar = (k) => { const t = Math.floor(k[0] / 1000); return { time: t + localShift(), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], session: utcDay(t) }; };
    async function seed() {
      const res = await fetch(`${BINANCE_REST}/klines?symbol=${r.pair}&interval=${s.interval}&limit=600`);
      if (res.status === 400) throw new Error(`Binance has no ${r.pair} pair. Try a USDT pair such as BTCUSDT, or the TradingView chart.`);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
      ui.setBars((await res.json()).map(toBar));
      const t = await fetch(`${BINANCE_REST}/ticker/24hr?symbol=${r.pair}`).then((x) => x.json()).catch(() => null);
      const last = ui.bars[ui.bars.length - 1];
      setPrice(last ? last.close : NaN, t ? +t.priceChangePercent / 100 : NaN, `${r.pair} · Binance spot · 24h change`);
    }
    Object.assign(s, {
      async start(indicators) {
        await loadScript(LWC_URL, "LightweightCharts");
        ui = nativeChart(true);
        ui.setIndicators(indicators);
        await seed();
        const lower = r.pair.toLowerCase();
        conn = socket(`${BINANCE_WS}${lower}@kline_${s.interval}/${lower}@miniTicker`, {
          onMessage(msg) {
            const d = msg.data || {};
            if (d.e === "kline") {
              const k = d.k, t = Math.floor(k.t / 1000);
              ui.update({ time: t + localShift(), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, session: utcDay(t) });
              setPrice(+k.c, NaN);
            } else if (d.e === "24hrMiniTicker") setPrice(+d.c, +d.c / +d.o - 1);
            setStatus("live", "Live");
          },
          onResume: () => seed().catch(() => {}),  // fill the gap left while the tab was hidden
        });
        conn.start();
        $("#lv-extra").innerHTML = `<p class="caption">Streaming from Binance's public market data (no key). VWAP resets at 00:00 UTC.
          Indicators are computed in your browser with TradingView's formulas.</p>`;
      },
      setIndicators(list) { if (ui) ui.setIndicators(list); },
      stop() { if (conn) conn.stop(); if (ui) ui.remove(); },
    });
    return s;
  }

  // --- Finnhub (US stocks, visitor's key) ------------------------------------------------------
  function finnhub(r) {
    let ui = null, conn = null, prevClose = NaN, idle = null;
    const s = nativeSession(["1m", "5m", "15m"], () => true, () => "");
    const tape = [];
    Object.assign(s, {
      async start(indicators) {
        await loadScript(LWC_URL, "LightweightCharts");
        ui = nativeChart(true);
        ui.setIndicators(indicators);
        const step = SECONDS[s.interval];
        try {
          const q = await FH.get("quote", { symbol: r.sym });
          if (q && q.c) { prevClose = q.pc; setPrice(q.c, q.pc ? q.c / q.pc - 1 : NaN, `${r.sym} · Finnhub · vs previous close`); }
        } catch (e) { $("#lv-extra").innerHTML = `<div class="note">${esc(e.message)}</div>`; }
        $("#lv-extra").insertAdjacentHTML("beforeend", `<h3 style="margin-top:16px">Trades</h3><div class="tape table-wrap" id="lv-tape"><div class="empty">Waiting for trades…</div></div>
          <p class="caption">Candles are built in your browser from Finnhub's trade stream, starting when this page opened, so indicators
          need a few bars to warm up. For full intraday history use the TradingView chart above.</p>`);
        const open = usMarketOpen();
        setStatus("wait", open ? "Connecting…" : "US market closed (9:30–16:00 New York, Mon–Fri)");
        idle = setTimeout(() => setStatus("wait", usMarketOpen() ? "Connected, no trades yet" : "US market closed (9:30–16:00 New York, Mon–Fri)"), 15000);
        let last = null;
        conn = socket(FINNHUB_WS + encodeURIComponent(FH.key()), {
          onOpen(ws) { ws.send(JSON.stringify({ type: "subscribe", symbol: r.sym })); if (usMarketOpen()) setStatus("wait", "Connected, waiting for trades…"); },
          onMessage(msg) {
            if (msg.type === "error") { setStatus("err", msg.msg || "Finnhub error"); return; }
            if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
            clearTimeout(idle);
            for (const tr of msg.data) {
              if (tr.s !== r.sym) continue;
              const t = Math.floor(tr.t / 1000 / step) * step;
              const time = t + localShift(), session = nyDate.format(new Date(tr.t));
              if (!last || time > last.time) last = { time, open: tr.p, high: tr.p, low: tr.p, close: tr.p, volume: tr.v || 0, session };
              else if (time === last.time) Object.assign(last, { high: Math.max(last.high, tr.p), low: Math.min(last.low, tr.p), close: tr.p, volume: last.volume + (tr.v || 0) });
              else continue;  // a late trade for an earlier candle
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
      setIndicators(list) { if (ui) ui.setIndicators(list); },
      stop() { clearTimeout(idle); if (conn) conn.stop(); if (ui) ui.remove(); },
    });
    return s;
  }

  // --- Daily bars from the nightly export (markets without a free real-time feed) -------------
  function dailyBars(r) {
    let ui = null, hasOHLC = false;
    const s = nativeSession(["1d"], (ind) => !ind.intraday && (hasOHLC || ind.needs === "c"),
      (ind) => (ind.intraday ? "intraday charts only" : needsText[ind.needs] + " (kept for the deep-tier stocks)"));
    Object.assign(s, {
      async prepare() {
        if (r.deep) {
          const d = await load(`deep/${r.sym.replace("^", "_")}.json`);
          hasOHLC = true;
          return d.d.map((t, i) => ({ time: t, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i] }));
        }
        const sd = await symbolData(r.sym);
        if (!sd || !sd.px) throw new Error(`No daily prices for ${r.sym}.`);
        return sd.px.dates.map((t, i) => ({ time: t, open: sd.px.values[i], close: sd.px.values[i] }));
      },
      async start(indicators) {
        const [list] = await Promise.all([s.prepare(), loadScript(LWC_URL, "LightweightCharts")]);
        ui = nativeChart(false);
        ui.setIndicators(indicators.filter((i) => s.fits(i)));
        ui.setBars(list, { line: !hasOHLC, withVolume: hasOHLC });
        const n = list.length, last = list[n - 1], prev = list[n - 2];
        setPrice(last.close, prev ? last.close / prev.close - 1 : NaN, `Daily close ${last.time}${r.row && r.row.cur ? " · " + r.row.cur : ""}`);
        setStatus("wait", "Daily bars, updated nightly");
        const why = r.kind === "us"
          ? "Add a free Finnhub key in ⚙ settings for a live tick stream here, or switch to the TradingView chart for real-time candles without a key."
          : "TradingView's free embeddable chart doesn't carry this market, so this chart shows the platform's nightly daily data. Use “View on TradingView” for its live chart.";
        $("#lv-extra").innerHTML = `<div class="note">${why}</div>` + (hasOHLC ? "" :
          `<p class="caption">Only closing prices are stored for this symbol, so the chart is a line and indicators that need highs, lows or volume are unavailable.</p>`);
        // The chips were drawn before the data told us whether highs and lows exist: redraw them.
        document.querySelectorAll("#lv-over .chip, #lv-osc .chip").forEach((b) => {
          const ind = Q.INDICATORS.find((i) => i.id === b.dataset.v), fit = s.fits(ind);
          b.disabled = !fit; b.style.opacity = fit ? "" : ".45"; b.title = fit ? "" : s.whyNot(ind);
          b.classList.toggle("on", fit && state.indicators.has(ind.id));
        });
        ui.setIndicators(indicators.filter((i) => s.fits(i)));
      },
      setIndicators(list) { if (ui) ui.setIndicators(list.filter((i) => s.fits(i))); },
      stop() { if (ui) ui.remove(); },
    });
    return s;
  }

  window.LIVE = { view };
})();
