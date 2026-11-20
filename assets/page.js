/* The static pages (about.html, privacy.html): theme toggle, copy buttons on code blocks, and the
 * "clear my saved data" button. Kept out of the HTML so the Content-Security-Policy needs no inline scripts. */
(function () {
  "use strict";
  var root = document.documentElement;
  // Theme toggle: follows the system until the visitor picks one.
  var toggle = document.querySelector(".theme-toggle, #theme");
  if (toggle) toggle.addEventListener("click", function () {
    var t = root.getAttribute("data-theme");
    var next = (t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(window.QP_STORAGE.NS + "theme", next); } catch (e) { /* storage blocked */ }
  });
  // Copy buttons on code blocks (comments are left out).
  document.querySelectorAll(".code").forEach(function (block) {
    var button = block.querySelector(".copy");
    if (!button) return;
    button.addEventListener("click", function () {
      var text = block.querySelector("code").innerText.split("\n")
        .map(function (line) { return line.replace(/\s+#.*$/, ""); }).join("\n");
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = "Copy"; }, 1500);
      });
    });
  });
  // Remove only this site's keys (boot.js): other github.io project sites of the same account share this storage.
  document.querySelectorAll("#clear, [data-clear-data]").forEach(function (clear) {
    clear.addEventListener("click", function () {
      var msg = document.getElementById("clear-msg") || clear.nextElementSibling;
      try {
        var n = window.QP_STORAGE.clearAll();
        if (msg) msg.textContent = n ? "Removed " + n + " saved item" + (n > 1 ? "s" : "") + "." : "Nothing was saved.";
      } catch (e) {
        if (msg) msg.textContent = "Your browser blocked access to its storage, so there was nothing to clear.";
      }
    });
  });
})();
