/* Runs first, in <head>, on every page: this site's storage keys (namespaced, migrated, clearable), the saved
 * colour theme (before the first paint, so there is no flash) and the framing guard. GitHub Pages can't send X-Frame-Options or a CSP frame-ancestors header, and
 * a <meta> CSP can't carry frame-ancestors, so when the site is shown inside another site's frame it hides
 * its controls and offers to open itself in a new tab instead (clickjacking protection). */
(function () {
  "use strict";
  var root = document.documentElement;

  // Every key this site saves is "qp:v1:<name>": a github.io origin is shared by all of an account's project
  // sites, and the version lets a future format change start clean. Keys from before the namespace are moved
  // once. Reads and writes elsewhere go through try/catch wrappers (app.js store), so blocked or corrupt
  // storage falls back to defaults.
  var NS = "qp:v1:";
  var KEYS = ["theme", "lang", "visited", "watchlist", "saved", "ticker", "stockIndicators", "finnhubKey", "liveSymbol", "pc:type", "pc:studies",
    "pc:legendFolded", "q:opt", "q:risk", "q:pf", "q:circuit", "compare", "alerts"];
  var PREFIXES = ["pc:interval:", "pc:draw:"];
  var ours = function (k) { return KEYS.indexOf(k) >= 0 || PREFIXES.some(function (p) { return k.indexOf(p) === 0; }); };
  try {
    if (localStorage.getItem(NS + "migrated") === null) {
      var all = [];  // snapshot first: adding and removing keys reorders localStorage.key(i)
      for (var i = 0; i < localStorage.length; i++) all.push(localStorage.key(i));
      all.forEach(function (k) {
        if (!k || !ours(k)) return;
        if (localStorage.getItem(NS + k) === null) localStorage.setItem(NS + k, localStorage.getItem(k));
        localStorage.removeItem(k);
      });
      localStorage.setItem(NS + "migrated", "1");
    }
  } catch (e) { /* storage blocked: nothing to migrate */ }
  /** Remove everything this site saved (watchlist, alerts, settings, language, first-visit flag, Finnhub key). */
  function clearAll() {
    var n = 0;
    [window.localStorage, window.sessionStorage].forEach(function (st) {
      var all = [];
      for (var i = 0; i < st.length; i++) all.push(st.key(i));
      all.forEach(function (k) {
        if (k && (k.indexOf(NS) === 0 || ours(k))) { if (k !== NS + "migrated") n++; st.removeItem(k); }
      });
    });
    return n;
  }
  window.QP_STORAGE = { NS: NS, KEYS: KEYS, PREFIXES: PREFIXES, clearAll: clearAll };

  try { var t = localStorage.getItem(NS + "theme"); if (t === "light" || t === "dark") root.setAttribute("data-theme", t); } catch (e) { /* storage blocked */ }
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }  // a cross-origin parent throws
  if (!framed) return;
  root.classList.add("framed");
  document.addEventListener("DOMContentLoaded", function () {
    var box = document.createElement("div");
    box.className = "framed-notice";
    box.setAttribute("role", "alert");
    var p = document.createElement("p");
    p.textContent = "This site is shown inside another page, so its controls are switched off.";
    var a = document.createElement("a");
    a.href = location.href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "btn";
    a.textContent = "Open Free Quant Platform in a new tab";
    box.appendChild(p); box.appendChild(a);
    document.body.insertBefore(box, document.body.firstChild);
    Array.prototype.forEach.call(document.body.children, function (el) { if (el !== box) el.hidden = true; });  // pages without app.css
  });
})();
