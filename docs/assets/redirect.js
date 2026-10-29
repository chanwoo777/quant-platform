/* 404.html: GitHub Pages serves it for unknown paths. Turn /quant-platform/stock/AAPL into the app's hash
 * route (#/stock/AAPL) so pretty links work on a static host; anything else goes to the start page. */
(function () {
  var base = "/quant-platform/";
  var path = location.pathname.indexOf(base) === 0 ? location.pathname.slice(base.length) : "";
  var route = /^(start|global|markets|stock|financials|compare|quantum|live|methodology|status|track-record|changelog)(\/[A-Za-z0-9.^=_,-]+)?\/?$/.test(path)
    ? "#/" + path.replace(/\/$/, "") : "";
  location.replace(base + route);
})();
