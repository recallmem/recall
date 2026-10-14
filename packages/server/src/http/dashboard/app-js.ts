/**
 * Optional progressive enhancement (served at <base>/static/app.js; CSP allows
 * only same-origin scripts): copy buttons on snippets, pickers that submit on
 * change, a busy state on the Ask button, and the consent screen's guard on
 * "Allow". Every page works without it (the consent screen then relies on the
 * server's minimum time between showing the page and accepting "Allow").
 */
export const SCRIPT = `"use strict";
(function () {
  document.querySelectorAll("pre[data-copy]").forEach(function (pre) {
    var head = pre.parentNode.querySelector(".code-head");
    var wrap = head;
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "copyable";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
    }
    var b = document.createElement("button");
    b.type = "button";
    b.className = "copy-btn";
    b.textContent = "Copy";
    b.addEventListener("click", function () {
      var done = function (label) {
        b.textContent = label;
        setTimeout(function () { b.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(pre.textContent || "").then(function () { done("Copied"); }, function () { done("Select & copy"); });
      else done("Select & copy");
    });
    wrap.appendChild(b);
  });
  document.querySelectorAll("select[data-autosubmit]").forEach(function (sel) {
    sel.addEventListener("change", function () {
      if (sel.name === "ws") {
        var peer = sel.form.querySelector("select[name=peer]");
        if (peer) peer.disabled = true;
      }
      sel.form.submit();
    });
  });
  document.querySelectorAll("[data-nojs]").forEach(function (el) { el.hidden = true; });
  // Buttons that copy another element's text (the setup prompt) need this script: shown by it.
  document.querySelectorAll("button[data-copy-text]").forEach(function (b) {
    var src = document.getElementById(b.getAttribute("data-copy-text"));
    if (!src || !navigator.clipboard) return;
    var label = b.textContent;
    b.hidden = false;
    b.addEventListener("click", function () {
      navigator.clipboard.writeText(src.textContent || "").then(function () {
        b.textContent = b.getAttribute("data-done") || "Copied";
        setTimeout(function () { b.textContent = label; }, 2400);
      }, function () { b.textContent = "Select and copy it below"; });
    });
  });
  // Tabs that are links (?connect=...) switch in place, keeping the URL in step.
  document.querySelectorAll("[data-tabs]").forEach(function (box) {
    box.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[data-tab]") : null;
      if (!a || !box.contains(a)) return;
      e.preventDefault();
      var id = a.getAttribute("data-tab");
      box.querySelectorAll("a[data-tab]").forEach(function (t) {
        if (t === a) t.setAttribute("aria-current", "true");
        else t.removeAttribute("aria-current");
      });
      box.querySelectorAll("[data-panel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-panel") !== id;
      });
      if (window.history && history.replaceState) history.replaceState(null, "", a.getAttribute("href"));
    });
  });
  // On phones the nav scrolls sideways: bring the current page into view and fade only the
  // edges that hide links.
  var nav = document.getElementById("side-nav");
  if (nav) {
    var fade = function () {
      var max = nav.scrollWidth - nav.clientWidth;
      nav.classList.toggle("fits", max <= 1);
      nav.classList.toggle("scrolled", nav.scrollLeft > 4);
      nav.classList.toggle("at-end", max > 1 && nav.scrollLeft >= max - 4);
    };
    var cur = nav.querySelector("[aria-current]");
    if (cur && nav.scrollWidth > nav.clientWidth) {
      var r = cur.getBoundingClientRect();
      var n = nav.getBoundingClientRect();
      nav.scrollLeft += r.left - n.left - (nav.clientWidth - r.width) / 2;
    }
    nav.addEventListener("scroll", fade, { passive: true });
    window.addEventListener("resize", fade);
    fade();
  }
  document.querySelectorAll("form").forEach(function (form) {
    form.addEventListener("submit", function () {
      var b = form.querySelector("button[data-busy]");
      if (!b) return;
      b.dataset.label = b.innerHTML;
      b.textContent = b.dataset.busy;
      b.disabled = true;
    });
  });
  window.addEventListener("pageshow", function () {
    document.querySelectorAll("button[data-busy][disabled]").forEach(function (b) {
      b.disabled = false;
      if (b.dataset.label) b.innerHTML = b.dataset.label;
    });
  });
  // Consent buttons (OAuth "Allow") against double-click-jacking: disabled until this page has
  // been visible and focused for 500 ms (and a second has passed since it was requested) and
  // the user has moved the pointer or pressed a key here since. Losing focus starts over.
  var guarded = document.querySelectorAll("button[data-consent]");
  if (guarded.length) {
    var timer = null;
    var settled = false;
    var used = false;
    var update = function () {
      guarded.forEach(function (b) { b.disabled = !(settled && used); });
    };
    var arm = function () {
      clearTimeout(timer);
      settled = false;
      used = false;
      update();
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = setTimeout(function () {
        settled = true;
        update();
      }, Math.max(500, 1200 - performance.now()));
    };
    var interact = function () {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      used = true;
      update();
    };
    ["pointermove", "mousemove", "keydown"].forEach(function (type) {
      document.addEventListener(type, interact, true);
    });
    window.addEventListener("focus", arm);
    window.addEventListener("blur", arm);
    window.addEventListener("pageshow", arm);
    document.addEventListener("visibilitychange", arm);
    arm();
  }
})();
`;
