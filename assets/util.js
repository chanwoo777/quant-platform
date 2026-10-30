/* Small pure helpers shared by the pages (window.Util), kept free of the DOM so tests/test_util_js.py can
 * run them under Node.js: watchlist import/export and page state in the URL.
 */
(function (root) {
  "use strict";

  // --- watchlist files ------------------------------------------------------------------------------
  const WATCH_FORMAT = "free-quant-platform/watchlist";
  const WATCH_MAX = 500, WATCH_BYTES = 100 * 1024;
  const WATCH_KEYS = ["format", "version", "exported_at", "disclaimer", "watchlist"];
  const DISCLAIMER = "Research and education only, not investment advice. Data may be delayed or wrong. Past performance does not predict future results.";
  const isTicker = (s) => typeof s === "string" && /^[A-Za-z0-9.^=\-]{1,32}$/.test(s.trim());
  /** The JSON a visitor downloads: {format, version, exported_at, watchlist}. */
  function exportWatchlist(list, now = new Date()) {
    return JSON.stringify({ format: WATCH_FORMAT, version: 1, exported_at: now.toISOString(), disclaimer: DISCLAIMER, watchlist: list }, null, 1);
  }
  /** Parse an exported watchlist, or a bare array of tickers. Throws a readable error on anything else:
   * over 100 KB, not JSON, fields other than the export's, another format or version, or non-text entries.
   * Returns {list, skipped}: valid tickers (trimmed, de-duplicated, at most 500) and how many were dropped. */
  function parseWatchlist(text) {
    if (typeof text !== "string" || text.length > WATCH_BYTES) throw new Error("the file is larger than 100 KB");
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new Error("the file isn't JSON"); }
    if (doc && !Array.isArray(doc) && typeof doc === "object") {
      const extra = Object.keys(doc).filter((k) => !WATCH_KEYS.includes(k));
      if (extra.length) throw new Error(`unexpected field "${String(extra[0]).slice(0, 40)}"`);
      if (doc.format !== WATCH_FORMAT || doc.version !== 1) throw new Error("expected a list of tickers, or a file exported from this page");
    }
    const raw = Array.isArray(doc) ? doc : doc && Array.isArray(doc.watchlist) ? doc.watchlist : null;
    if (!raw) throw new Error("expected a list of tickers, or a file exported from this page");
    if (raw.some((s) => typeof s !== "string")) throw new Error("every entry must be a ticker in quotes");
    const good = [...new Set(raw.filter(isTicker).map((s) => s.trim()))];
    if (!good.length) throw new Error("no valid tickers in the file");
    return { list: good.slice(0, WATCH_MAX), skipped: raw.length - Math.min(good.length, WATCH_MAX) };
  }

  // --- page state in the URL: #/route/arg?key=value&list=a,b ----------------------------------------
  // Every page writes what it shows (tickers, windows, filters, basket) after the "?", so a copied link
  // reproduces the view in a fresh browser. Lists are comma-separated; empty values are left out.
  const enc = (s) => encodeURIComponent(String(s)).replace(/%2C/gi, ",").replace(/%5E/gi, "^");
  // What a link may carry: the keys the pages write, values without markup characters, and a route
  // argument made of ticker characters. Anything else is dropped and reported as `rejected`.
  const HASH_KEYS = new Set(["tab", "cls", "sig", "mkt", "sec", "q", "min", "cap", "unu", "sort", "dir", "page", "hm", "brief", "span", "news",
    "ind", "layers", "model", "iv", "type", "years", "cw", "co", "sym", "days", "kind", "win", "n", "syms", "w", "look", "amt", "pick", "lam", "K", "ql"]);
  const HASH_VALUE = /^[\p{L}\p{N} .,^=_:&'()/+-]{0,300}$/u;
  const HASH_ARG = /^[A-Za-z0-9.^=_,-]{1,300}$/;
  const HASH_ROUTE = /^[a-z-]{0,20}$/;
  /** {route, arg, params, rejected}: unknown keys, malformed values and arguments are left out. */
  function parseHash(hash) {
    const h = String(hash || "").replace(/^#\/?/, "");
    const i = h.indexOf("?");
    const path = i < 0 ? h : h.slice(0, i), qs = i < 0 ? "" : h.slice(i + 1);
    let [route = "", ...rest] = path.split("/");
    let rejected = false;
    if (!HASH_ROUTE.test(route)) { route = ""; rest.length = 0; rejected = true; }
    const params = {};
    for (const part of qs.split("&")) {
      if (!part) continue;
      const j = part.indexOf("=");
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; } };
      const key = dec(j < 0 ? part : part.slice(0, j)), value = j < 0 ? "" : dec(part.slice(j + 1));
      if (HASH_KEYS.has(key) && HASH_VALUE.test(value)) params[key] = value; else rejected = true;
    }
    let arg;
    try { arg = rest.length ? decodeURIComponent(rest.join("/")) : undefined; } catch (e) { arg = rest.join("/"); }
    if (arg !== undefined && arg !== "" && !HASH_ARG.test(arg)) { arg = undefined; rejected = true; }
    return { route, arg: arg === "" ? undefined : arg, params, rejected };
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

  // --- downloads --------------------------------------------------------------------------------------
  // A spreadsheet runs a cell that starts with = + - @ (or a tab or carriage return) as a formula, so
  // such text gets a leading apostrophe. Plain numbers ("-0.42", "1.5e-3", "-12%") are left alone.
  const NUMBER = /^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?%?$/;
  function csvCell(v) {
    let s = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  }
  /** A CSV file's text: a BOM (so Excel reads Korean as UTF-8), the header lines (title, source, as-of,
   * disclaimer), then every field quoted and neutralised. */
  function toCsv(header, cols, rows) {
    const lines = [...header.map((h) => csvCell(`# ${h}`)), cols.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }
  /** A download name from free text: lower-case letters, digits, dashes and underscores, plus an optional date. */
  function fileName(title, date, ext, fallback = "data") {
    const slug = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback;
    const d = String(date || "").replace(/[^0-9A-Za-z-]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
    return `${slug}${d ? "_" + d : ""}.${String(ext).replace(/[^a-z0-9]/g, "")}`;
  }

  const U = { WATCH_FORMAT, WATCH_BYTES, HASH_KEYS, DISCLAIMER, csvCell, toCsv, fileName, isTicker, exportWatchlist, parseWatchlist, parseHash, buildHash, listParam, numParam, oneOf };
  if (typeof module !== "undefined" && module.exports) module.exports = U;
  root.Util = U;
})(typeof window !== "undefined" ? window : globalThis);
