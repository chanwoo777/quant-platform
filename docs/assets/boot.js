/* Runs first, in <head>, on every page: the saved colour theme (before the first paint, so there is no
 * flash) and the framing guard. GitHub Pages can't send X-Frame-Options or a CSP frame-ancestors header, and
 * a <meta> CSP can't carry frame-ancestors, so when the site is shown inside another site's frame it hides
 * its controls and offers to open itself in a new tab instead (clickjacking protection). */
(function () {
  "use strict";
  var root = document.documentElement;
  try { var t = localStorage.getItem("theme"); if (t === "light" || t === "dark") root.setAttribute("data-theme", t); } catch (e) { /* storage blocked */ }
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
