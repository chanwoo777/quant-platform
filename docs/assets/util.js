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

  const U = { WATCH_FORMAT, isTicker, exportWatchlist, parseWatchlist };
  if (typeof module !== "undefined" && module.exports) module.exports = U;
  root.Util = U;
})(typeof window !== "undefined" ? window : globalThis);
