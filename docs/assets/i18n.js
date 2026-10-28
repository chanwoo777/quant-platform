/* Korean / English (window.I18N). The pages are written in English; when the visitor picks 한국어, every
 * piece of interface text is looked up in the dictionary (i18n.ko.js, keyed by the English) as the page
 * draws, and replaced. Tickers, company names, headlines and formulas are data and stay as they are.
 *
 * How a key is made from what's on the page:
 *  - whitespace is collapsed; numbers, percentages, dates and dollar amounts become {0}, {1}, ... so one
 *    entry covers every value ("{0} stocks in {1} markets"), and in Korean dates and dollar amounts are
 *    written the Korean way (2026. 10. 27., 5.1조 달러);
 *  - a block whose text runs around inline markup (a link, bold) is one key, with each inline element as
 *    <0/>, <1/>, ... so the Korean can put it where Korean word order needs it; each inline element's own
 *    text is translated separately.
 * Anything with no entry stays English and is listed by I18N.report() (or on screen with #...?i18n=missing):
 * that list is how to find interface text the dictionary doesn't cover yet.
 */
(function (root) {
  "use strict";
  const LANGS = { en: "English", ko: "한국어" };
  const read = () => { try { return localStorage.getItem("lang"); } catch (e) { return null; } };
  const browserLang = typeof navigator !== "undefined" ? navigator.language || "" : "";
  const lang = LANGS[read()] ? read() : browserLang.toLowerCase().startsWith("ko") ? "ko" : "en";
  const dict = (root.I18N_DICT = root.I18N_DICT || {});
  const missing = new Map();

  // --- tokens: values that stay values ---------------------------------------------------------------
  // Dates, numbers (with sign, $, %, x, bp, pp, K/M/B/T) and tickers or codes (AAPL, 005930.KS, ^GSPC, BTC-USD, FF3,
  // RSI) all stay as they are. BUY / HOLD / AVOID are words the dictionary translates, so they aren't codes.
  const TOKEN = /(?<![\w.^])(?:\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|(?=[\w.^=\-]*[A-Z])\^?[A-Z0-9]+(?:[.\-=][A-Z0-9]+)+\b|\^[A-Z0-9]{2,}\b|(?!(?:BUY|HOLD|AVOID)\b)\b[A-Z][A-Z0-9]+\b|x(?:inf|[−+-]?\d(?:[\d,]*\d)?(?:\.\d+)?(?:e[+-]?\d+)?)\b|[−+-]?\$?\d(?:[\d,]*\d)?(?:\.\d+)?(?:%|×|x\b|bp\b|pp\b|[KMBT]\b|k\b)?)/g;
  function koMoney(v) {
    const a = Math.abs(v), sign = v < 0 ? "−" : "";
    const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, "") : x.toFixed(2).replace(/\.?0+$/, ""));
    if (a >= 1e12) return `${sign}${fmt(a / 1e12)}조 달러`;
    if (a >= 1e8) return `${sign}${fmt(a / 1e8)}억 달러`;
    if (a >= 1e4) return `${sign}${fmt(a / 1e4)}만 달러`;
    return `${sign}${a.toLocaleString("ko-KR")}달러`;
  }
  function localToken(tok) {
    if (lang !== "ko") return tok;
    let m = tok.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (m) return `${m[1]}. ${+m[2]}. ${+m[3]}.${m[4] ? " " + m[4] : ""}`;
    m = tok.match(/^([−+-]?)\$(\d[\d,]*(?:\.\d+)?)([KMBT])$/);
    if (m) return (m[1] === "+" ? "+" : "") + koMoney((m[1] && m[1] !== "+" ? -1 : 1) * parseFloat(m[2].replace(/,/g, "")) * { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[3]]);
    return tok;
  }
  const squash = (s) => s.replace(/\s+/g, " ");
  /** {key, tokens} for a plain string. */
  function keyOf(text) {
    const tokens = [];
    const key = squash(text).trim().replace(TOKEN, (t) => `{${tokens.push(t) - 1}}`);
    return { key, tokens };
  }
  const HANGUL = /[가-힣]/;
  const WORDY = /[A-Za-z]{2,}/;
  const ACRONYM = /^[A-Z0-9 .^=&/+\-·:()]+$/;  // tickers and codes on their own aren't interface text
  function note(key, where) {
    if (where === "fragment") return;  // part of a sentence that is reported whole
    if (!key || !WORDY.test(key) || HANGUL.test(key) || ACRONYM.test(key.replace(/\{\d+\}/g, ""))) return;
    if (!missing.has(key)) missing.set(key, where || "");
  }
  function lookup(key) { return lang === "en" ? null : (dict[lang] || {})[key] ?? null; }
  /** Translate a plain string (alerts, toasts, chart labels). */
  function tText(text, where) {
    if (lang === "en" || text === null || text === undefined) return text;
    const s = String(text);
    if (!WORDY.test(s) && !/\d{4}-\d{2}-\d{2}|\$\d[\d,.]*[KMBT]\b/.test(s)) return s;
    const special = translateSpecial(s);
    if (special !== null) return special;
    const { key, tokens } = keyOf(s);
    const hit = lookup(key);
    if (hit === null) { note(key, where); return tokens.length ? s.replace(TOKEN, localToken) : s; }
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
    return lead + hit.replace(/\{(\d+)\}/g, (_, i) => localToken(tokens[+i] ?? "")) + trail;
  }
  // The scorer's reasons ("Buy candidate: clause; clause; clause.") are translated clause by clause.
  const WHY = /^(Buy candidate|Avoid|Hold \/ watch|Not enough data): (.*?)\.( New buys paused: (.+) is in a Bear regime\.)?$/;
  function translateSpecial(s) {
    const m = squash(s).trim().match(WHY);
    if (!m) return null;
    const head = tText(m[1], "why"), clauses = m[2].split("; ").map((c) => tText(c, "why"));
    return `${head}: ${clauses.join("; ")}.${m[3] ? " " + tText(`New buys paused: {market} is in a Bear regime.`, "why").replace("{market}", tText(m[4], "why")) : ""}`;
  }

  // --- the page: translate as it draws ----------------------------------------------------------------
  const SKIP = "script, style, math, svg, pre, code, textarea, input, canvas, .js-plotly-plot, [translate='no'], [data-i18n-skip]";
  const INLINE = new Set(["A", "B", "STRONG", "I", "EM", "SPAN", "CODE", "SUB", "SUP", "SMALL", "ABBR", "KBD", "BR", "MARK", "LABEL"]);
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const made = new WeakSet();  // text nodes the translator wrote: never translated twice
  const skipped = (el) => el.nodeType === 1 && el.matches(SKIP);
  /** Does `el` only hold text and inline elements (so its sentence is one key)? */
  function isLeaf(el) {
    let text = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) text = true; continue; }
      if (n.nodeType !== 1) continue;
      if (!INLINE.has(n.tagName) || skipped(n) && n.tagName !== "CODE" && !n.matches("[translate='no']")) return false;
      if ([...n.children].some((c) => !INLINE.has(c.tagName))) return false;
    }
    return text;
  }
  function translateLeaf(el) {
    if ([...el.childNodes].some((n) => n.nodeType === 3 && made.has(n))) return;  // already done (or done in pieces)
    const parts = [], kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) parts.push({ text: n.nodeValue });
      else if (n.nodeType === 1) { parts.push({ kid: kids.length }); kids.push(n); }
    }
    if (!kids.length) { [...el.childNodes].forEach((n) => translateTextNode(n)); return; }  // plain text
    const tokens = [];
    const raw = parts.map((p) => (p.text !== undefined ? p.text.replace(TOKEN, (t) => `{${tokens.push(t) - 1}}`) : `<${p.kid}/>`)).join("");
    const key = squash(raw).trim();
    kids.forEach((k) => { if (!skipped(k) || k.tagName === "LABEL") walk(k); });
    const special = translateSpecial(el.textContent);
    if (special !== null) { el.textContent = special; return; }
    const hit = lookup(key);
    if (hit === null) {
      note(key, where(el));
      parts.forEach((p, i) => { if (p.text !== undefined) translateTextNode(el.childNodes[i], true); });
      return;
    }
    const frag = document.createDocumentFragment();
    const lead = (parts[0].text || "").match(/^\s*/)[0];
    if (lead) frag.appendChild(mk(lead));
    for (const piece of hit.split(/(<\d+\/>|\{\d+\})/)) {
      if (!piece) continue;
      let m = piece.match(/^<(\d+)\/>$/);
      if (m && kids[+m[1]]) { frag.appendChild(kids[+m[1]]); continue; }
      m = piece.match(/^\{(\d+)\}$/);
      frag.appendChild(mk(m ? localToken(tokens[+m[1]] ?? "") : piece));
    }
    const last = parts[parts.length - 1];
    if (last.text && /\s$/.test(last.text)) frag.appendChild(mk(" "));
    el.replaceChildren(frag);
  }
  const mk = (s) => { const t = document.createTextNode(s); made.add(t); return t; };
  function translateTextNode(n, fragment) {
    if (!n || n.nodeType !== 3 || made.has(n)) return;
    const s = n.nodeValue;
    if (!s.trim()) return;
    const out = tText(s, fragment ? "fragment" : where(n.parentElement));
    if (out !== s) { n.nodeValue = out; }
    made.add(n);
  }
  function translateAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || el.dataset["i18nAttr" + a.replace(/-/g, "")] === v) continue;
      const out = tText(v, `@${a}`);
      el.setAttribute(a, out);
      el.dataset["i18nAttr" + a.replace(/-/g, "")] = out;
    }
  }
  const where = (el) => (el ? (el.closest("[id]") ? "#" + el.closest("[id]").id : el.tagName.toLowerCase()) : "");
  function walk(node) {
    if (lang === "en" || !node) return;
    if (node.nodeType === 3) {
      const p = node.parentElement;
      if (p && !p.closest(SKIP)) { if (isLeaf(p) && [...p.childNodes].some((c) => c.nodeType === 1)) translateLeaf(p); else translateTextNode(node); }
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches("input, textarea")) { translateAttrs(node); return; }  // placeholders and labels, never the value
    if (node.closest(SKIP)) return;
    translateAttrs(node);
    if (node.tagName === "SELECT") { node.querySelectorAll("option").forEach((o) => translateTextNode(o.firstChild)); return; }
    if (isLeaf(node)) { translateLeaf(node); node.querySelectorAll("*").forEach((c) => { if (!c.closest(SKIP)) translateAttrs(c); }); return; }
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) translateTextNode(c);
      else if (c.nodeType === 1 && !skipped(c)) walk(c);
      else if (c.nodeType === 1 && !c.matches("[translate='no'], [data-i18n-skip]")) translateAttrs(c);
    }
  }
  function start() {
    document.documentElement.lang = lang;
    const btn = document.getElementById("lang");
    if (btn) {
      btn.textContent = lang === "ko" ? "English" : "한국어";
      btn.setAttribute("aria-label", lang === "ko" ? "Switch to English" : "한국어로 보기");
      btn.addEventListener("click", () => { try { localStorage.setItem("lang", lang === "ko" ? "en" : "ko"); } catch (e) { /* private mode */ } location.reload(); });
    }
    if (lang === "en") return;
    walk(document.body);
    document.title = tText(document.title);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") { if (!made.has(r.target)) translateTextNode(r.target); continue; }
        r.addedNodes.forEach((n) => { if (!made.has(n)) walk(n); });
      }
      if (location.hash.includes("i18n=missing")) showMissing();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    if (location.hash.includes("i18n=missing")) setTimeout(showMissing, 1500);
  }
  let panel = null;
  function showMissing() {
    if (!panel) { panel = document.createElement("pre"); panel.className = "i18n-missing"; panel.setAttribute("data-i18n-skip", ""); document.body.appendChild(panel); }
    panel.textContent = `Untranslated (${missing.size}):\n` + [...missing.keys()].join("\n");
  }
  /** Chart labels: trace names, axis and legend titles, annotations and hover text. */
  function plotly(traces, layout) {
    if (lang === "en") return [traces, layout];
    const tr = (s) => (typeof s === "string" ? s.split(/(%\{[^}]*\}|<br>|<extra>.*?<\/extra>)/).map((p) => (/^%\{|^<br>$|^<extra>/.test(p) ? p : tText(p, "chart"))).join("") : s);
    for (const t of traces) {
      if (t.name) t.name = tr(t.name);
      if (t.hovertemplate) t.hovertemplate = tr(t.hovertemplate);
      if (Array.isArray(t.x) && t.type === "waterfall") t.x = t.x.map(tr);
      if (Array.isArray(t.y) && t.type === "scatter" && t.mode === "markers" && typeof t.y[0] === "string") t.y = t.y.map(tr);
    }
    for (const k of Object.keys(layout)) {
      const ax = layout[k];
      if (ax && typeof ax === "object" && ax.title) { if (typeof ax.title === "string") ax.title = tr(ax.title); else if (ax.title.text) ax.title.text = tr(ax.title.text); }
    }
    (layout.annotations || []).forEach((a) => { if (a.text) a.text = tr(a.text); });
    return [traces, layout];
  }
  const LOCALE = lang === "ko" ? "ko-KR" : "en-US";
  root.I18N = { lang, LANGS, LOCALE, tText, keyOf, localToken, plotly, walk, report: () => [...missing.keys()], missing };
  root.tr = tText;
  if (typeof module !== "undefined" && module.exports) module.exports = root.I18N;  // tests/test_i18n.py
  if (typeof document === "undefined") return;
  // Deferred scripts run before DOMContentLoaded, so waiting for it means the dictionary files have loaded too.
  if (document.readyState === "complete") start(); else document.addEventListener("DOMContentLoaded", start);
})(typeof window !== "undefined" ? window : globalThis);
