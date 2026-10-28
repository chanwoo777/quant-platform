/* Small pure helpers shared by the pages (window.Util), kept free of the DOM so tests/test_util_js.py can
 * run them under Node.js: watchlist import/export and page state in the URL.
 */
(function (root) {
  "use strict";

  // --- watchlist files ------------------------------------------------------------------------------
  const WATCH_FORMAT = "free-quant-platform/watchlist";
  const WATCH_MAX = 500;
  const isTicker = (s) => typeof s === "string" && /^[A-Za-z0-9.^=\-]{1,32}$/.test(s.trim());
  /** The JSON a visitor downloads: {format, version, exported_at, watchlist}. */
  function exportWatchlist(list, now = new Date()) {
    return JSON.stringify({ format: WATCH_FORMAT, version: 1, exported_at: now.toISOString(), watchlist: list }, null, 1);
  }
  /** Parse an exported watchlist, or a bare array of tickers. Throws a readable error on anything else.
   * Returns {list, skipped}: valid tickers (trimmed, de-duplicated, at most 500) and how many were dropped. */
  function parseWatchlist(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new Error("the file isn't JSON"); }
    const raw = Array.isArray(doc) ? doc : doc && Array.isArray(doc.watchlist) ? doc.watchlist : null;
    if (!raw) throw new Error("expected a list of tickers, or a file exported from this page");
    const good = [...new Set(raw.filter(isTicker).map((s) => s.trim()))];
    if (!good.length) throw new Error("no valid tickers in the file");
    return { list: good.slice(0, WATCH_MAX), skipped: raw.length - Math.min(good.length, WATCH_MAX) };
  }

  // --- page state in the URL: #/route/arg?key=value&list=a,b ----------------------------------------
  // Every page writes what it shows (tickers, windows, filters, basket) after the "?", so a copied link
  // reproduces the view in a fresh browser. Lists are comma-separated; empty values are left out.
  const enc = (s) => encodeURIComponent(String(s)).replace(/%2C/gi, ",").replace(/%5E/gi, "^");
  function parseHash(hash) {
    const h = String(hash || "").replace(/^#\/?/, "");
    const i = h.indexOf("?");
    const path = i < 0 ? h : h.slice(0, i), qs = i < 0 ? "" : h.slice(i + 1);
    const [route = "", ...rest] = path.split("/");
    const params = {};
    for (const part of qs.split("&")) {
      if (!part) continue;
      const j = part.indexOf("=");
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; } };
      params[dec(j < 0 ? part : part.slice(0, j))] = j < 0 ? "" : dec(part.slice(j + 1));
    }
    let arg;
    try { arg = rest.length ? decodeURIComponent(rest.join("/")) : undefined; } catch (e) { arg = rest.join("/"); }
    return { route, arg: arg === "" ? undefined : arg, params };
  }
  function buildHash(route, arg, params = {}) {
    const keep = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)
      && !(typeof v === "number" && !Number.isFinite(v)));
    const qs = keep.map(([k, v]) => `${enc(k)}=${enc(Array.isArray(v) ? v.join(",") : v)}`).join("&");
    return `#/${route}${arg !== undefined && arg !== null && arg !== "" ? "/" + enc(arg) : ""}${qs ? "?" + qs : ""}`;
  }
  /** A comma list from a URL value ("" -> []). */
  const listParam = (s) => (s === undefined || s === null || s === "" ? [] : String(s).split(",").map((x) => x.trim()).filter(Boolean));
  /** A number from a URL value within [lo, hi], or the fallback. */
  function numParam(s, fallback, lo = -Infinity, hi = Infinity) {
    const x = Number(s);
    return s === undefined || s === "" || !Number.isFinite(x) ? fallback : Math.min(hi, Math.max(lo, x));
  }
  /** A value from a URL only when it is one of `allowed`. */
  const oneOf = (s, allowed, fallback) => (allowed.includes(s) ? s : fallback);

  const U = { WATCH_FORMAT, isTicker, exportWatchlist, parseWatchlist, parseHash, buildHash, listParam, numParam, oneOf };
  if (typeof module !== "undefined" && module.exports) module.exports = U;
  root.Util = U;
})(typeof window !== "undefined" ? window : globalThis);
