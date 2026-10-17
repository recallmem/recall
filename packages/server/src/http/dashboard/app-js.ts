/**
 * Optional progressive enhancement (served at <base>/static/app.js; CSP allows
 * only same-origin scripts): copy buttons on snippets, pickers that submit on
 * change, a busy state on the Ask button, the consent screen's guard on
 * "Allow", the console Traffic page's live visitor counter and globe, and the
 * Links page's link preview and copy buttons, and the Playground's wait for the sample conversation. Every page works without it (the consent screen then relies on the
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
  // The console Traffic page's live counter: visitors in the last 5 minutes, every 20 s while shown.
  var live = document.querySelector("[data-live-url]");
  if (live && window.fetch) {
    var count = live.querySelector("[data-live]");
    setInterval(function () {
      if (document.visibilityState !== "visible") return;
      fetch(live.getAttribute("data-live-url"), { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) {
          if (!b || typeof b.visitors !== "number") return;
          count.textContent = b.visitors.toLocaleString("en-US");
          live.classList.toggle("on", b.visitors > 0);
        })
        .catch(function () {});
    }, 20000);
  }
  // The console Traffic page's globe: the flat map's land cells and visitor markers on a pixel
  // sphere, drawn on a small canvas that CSS scales up crisp (orthographic projection). Drag,
  // the arrow keys or a sideways scroll turn it; it also turns on its own unless motion is reduced.
  function makeGlobe(canvas, tip) {
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    var S = canvas.width, C = S / 2, R = Math.round(S * 0.4), D = Math.PI / 180;
    var cols = Number(canvas.getAttribute("data-cols")) || 120;
    var land = canvas.getAttribute("data-land") || "";
    var pts = [];
    try { pts = JSON.parse(canvas.getAttribute("data-points") || "[]"); } catch (e) { pts = []; }
    var cells = [], grid = [], stars = [], i, a, b;
    for (i = 0; i < land.length; i++)
      if (land.charAt(i) === "#") cells.push([(-180 + ((i % cols) + 0.5) * 3) * D, (84 - (Math.floor(i / cols) + 0.5) * 3) * D]);
    for (a = -180; a < 180; a += 30) for (b = -81; b <= 81; b += 3) grid.push([a * D, b * D]);
    for (b = -60; b <= 60; b += 30) for (a = -180; a < 180; a += 3) grid.push([a * D, b * D]);
    var seed = 7;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    while (stars.length < 70) {
      var sx = Math.floor(rnd() * S), sy = Math.floor(rnd() * S);
      if ((sx - C) * (sx - C) + (sy - C) * (sy - C) > (R + 8) * (R + 8)) stars.push([sx, sy, rnd()]);
    }
    // The sphere, its shading and its glow do not move: draw them once.
    var base = document.createElement("canvas");
    base.width = S; base.height = S;
    var bx = base.getContext("2d");
    var y, x, w;
    for (y = -R - 4; y <= R + 4; y++)
      for (x = -R - 4; x <= R + 4; x++) {
        var d = Math.sqrt(x * x + y * y);
        if (d <= R) {
          var rim = d / R;
          bx.fillStyle = rim > 0.93 && (x + y) % 2 === 0 ? "#050403" : rim > 0.8 && (x + y) % 3 === 0 ? "#080706" : "#0d0b08";
          bx.fillRect(C + x, C + y, 1, 1);
        } else if (d <= R + 1.5) {
          bx.fillStyle = "rgba(255,176,0,.45)"; bx.fillRect(C + x, C + y, 1, 1);
        } else if (d <= R + 3.5 && (x + y) % 2 === 0) {
          bx.fillStyle = "rgba(255,176,0,.16)"; bx.fillRect(C + x, C + y, 1, 1);
        }
      }
    var lon0 = pts.length ? Number(pts[0][2]) * D : 0, lat0 = 18 * D;
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var running = false, raf = 0, last = 0, idle = 0, drag = null, hover = -1, shown = [];
    var TIER = ["#8a6000", "#b07a00", "#e59d00", "#ffcb4d", "#fff1c2"];
    var project = function (lam, phi) {
      var dl = lam - lon0, cp = Math.cos(phi), cl = Math.cos(dl);
      return [C + R * cp * Math.sin(dl), C - R * (Math.cos(lat0) * Math.sin(phi) - Math.sin(lat0) * cp * cl), Math.sin(lat0) * Math.sin(phi) + Math.cos(lat0) * cp * cl];
    };
    var dot = function (px, py, size, color) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(px - size / 2), Math.round(py - size / 2), size, size);
    };
    var circle = function (cx, cy, r, color) {
      var n = Math.max(10, Math.round(r * 6));
      ctx.fillStyle = color;
      for (var k = 0; k < n; k++) ctx.fillRect(Math.round(cx + r * Math.cos((k / n) * 2 * Math.PI)), Math.round(cy + r * Math.sin((k / n) * 2 * Math.PI)), 1, 1);
    };
    var draw = function (t) {
      var k, p;
      ctx.clearRect(0, 0, S, S);
      for (k = 0; k < stars.length; k++) {
        var tw = reduce ? 1 : 0.35 + 0.65 * Math.abs(Math.sin(t / 900 + stars[k][2] * 40));
        ctx.fillStyle = "rgba(233,220,192," + (0.25 + 0.6 * stars[k][2] * tw).toFixed(2) + ")";
        ctx.fillRect(stars[k][0], stars[k][1], 1, 1);
      }
      // A satellite on a tilted orbit; behind the globe on the far side.
      var orbit = reduce ? 0.6 : t / 5200;
      var ox = C + (R + 16) * Math.cos(orbit), oy = C - (R + 16) * 0.32 * Math.sin(orbit), front = Math.sin(orbit) < 0;
      var sat = function () {
        dot(ox - 3, oy, 3, "#5fd7ff"); dot(ox + 3, oy, 3, "#5fd7ff"); dot(ox, oy, 2, "#f4efe4");
        if (reduce || Math.floor(t / 500) % 2) dot(ox, oy - 2, 1, "#ff5f56");
      };
      if (!front) sat();
      ctx.drawImage(base, 0, 0);
      for (k = 0; k < grid.length; k++) {
        p = project(grid[k][0], grid[k][1]);
        if (p[2] > 0.05) dot(p[0], p[1], 1, "rgba(255,176,0," + (0.06 + 0.12 * p[2]).toFixed(2) + ")");
      }
      for (k = 0; k < cells.length; k++) {
        p = project(cells[k][0], cells[k][1]);
        if (p[2] <= 0) continue;
        if (p[2] > 0.55) dot(p[0], p[1], 3, p[2] > 0.85 ? "#6e5e45" : "#5a4c37");
        else if (p[2] > 0.22) dot(p[0], p[1], 2, "#463b2c");
        else dot(p[0], p[1], 1, "#342c21");
      }
      shown = [];
      for (k = pts.length - 1; k >= 0; k--) {
        var q = pts[k];
        p = project(Number(q[2]) * D, Number(q[3]) * D);
        if (p[2] <= 0.02) continue;
        var tier = Number(q[4]) || 1;
        if (tier >= 3) {
          var f = reduce ? 0.35 : (t / 1700 + k * 0.37) % 1;
          circle(p[0], p[1], 3 + f * 9, "rgba(255,203,77," + Math.min(1, (1 - f) * 1.1 * p[2]).toFixed(2) + ")");
        }
        if (tier >= 3) dot(p[0], p[1], tier >= 4 ? 7 : 6, "rgba(255,176,0,.22)");
        dot(p[0], p[1], k === hover ? 5 : tier >= 4 ? 5 : tier >= 3 ? 4 : 3, k === hover ? "#ffffff" : TIER[tier] || TIER[1]);
        shown.push([k, p[0], p[1]]);
      }
      if (front) sat();
    };
    var loop = function (now) {
      raf = 0;
      if (!running) return;
      var dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (!drag && !reduce && now > idle) lon0 -= dt * 0.00011;
      draw(now);
      if (!reduce) raf = requestAnimationFrame(loop);
    };
    var redraw = function () {
      if (reduce || !running) draw(performance.now());
    };
    var placeTip = function () {
      if (!tip) return;
      if (hover < 0) { tip.hidden = true; return; }
      var hit = null;
      for (var k = 0; k < shown.length; k++) if (shown[k][0] === hover) hit = shown[k];
      if (!hit) { tip.hidden = true; return; }
      var q = pts[hover], rect = canvas.getBoundingClientRect(), box = canvas.parentNode.getBoundingClientRect();
      tip.textContent = q[0] + ": " + Number(q[1]).toLocaleString("en-US") + (Number(q[1]) === 1 ? " visitor" : " visitors");
      tip.style.left = (rect.left - box.left + (hit[1] * rect.width) / S).toFixed(0) + "px";
      tip.style.top = (rect.top - box.top + (hit[2] * rect.height) / S).toFixed(0) + "px";
      tip.hidden = false;
    };
    var at = function (e) {
      var rect = canvas.getBoundingClientRect();
      return [((e.clientX - rect.left) * S) / rect.width, ((e.clientY - rect.top) * S) / rect.height, rect];
    };
    canvas.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, lon: lon0, lat: lat0 };
      hover = -1; placeTip();
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      var pos = at(e);
      if (drag) {
        lon0 = drag.lon - ((e.clientX - drag.x) / pos[2].width) * Math.PI * 1.3;
        if (e.pointerType === "mouse")
          lat0 = Math.max(-70 * D, Math.min(70 * D, drag.lat + ((e.clientY - drag.y) / pos[2].height) * Math.PI));
        redraw();
        return;
      }
      var best = -1, bestD = 36;
      for (var k = 0; k < shown.length; k++) {
        var dx = shown[k][1] - pos[0], dy = shown[k][2] - pos[1];
        if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; best = shown[k][0]; }
      }
      if (best !== hover) { hover = best; redraw(); placeTip(); }
    });
    var release = function () {
      drag = null;
      idle = performance.now() + 2500;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerleave", function () {
      if (!drag && hover >= 0) { hover = -1; redraw(); placeTip(); }
    });
    canvas.addEventListener("wheel", function (e) {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      lon0 += e.deltaX * 0.006;
      idle = performance.now() + 2500;
      redraw();
    }, { passive: false });
    canvas.addEventListener("keydown", function (e) {
      var step = { ArrowLeft: [10, 0], ArrowRight: [-10, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
      if (!step) return;
      e.preventDefault();
      lon0 += step[0] * D;
      lat0 = Math.max(-70 * D, Math.min(70 * D, lat0 + step[1] * D));
      idle = performance.now() + 2500;
      redraw();
    });
    var visible = true;
    var sync = function () {
      var want = !canvas.closest("[hidden]") && visible && document.visibilityState === "visible";
      if (want && !running) {
        running = true; last = 0;
        if (reduce) draw(performance.now());
        else if (!raf) raf = requestAnimationFrame(loop);
      } else if (!want) running = false;
    };
    document.addEventListener("visibilitychange", sync);
    if (window.IntersectionObserver)
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; sync(); }).observe(canvas);
    return { sync: sync };
  }
  var mapStage = document.querySelector("[data-map]");
  var viewToggle = mapStage && mapStage.closest(".panel") && mapStage.closest(".panel").querySelector(".view-toggle");
  var globeCanvas = mapStage && mapStage.querySelector("canvas.globe");
  var globe = globeCanvas ? makeGlobe(globeCanvas, mapStage.querySelector(".globe-tip")) : null;
  if (viewToggle && globe) {
    var showView = function (view) {
      mapStage.querySelectorAll("[data-view-pane]").forEach(function (pane) {
        pane.hidden = pane.getAttribute("data-view-pane") !== view;
      });
      viewToggle.querySelectorAll("button[data-view]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
      });
      globe.sync();
    };
    viewToggle.hidden = false;
    viewToggle.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-view]");
      if (!b) return;
      showView(b.getAttribute("data-view"));
      try { localStorage.setItem("recall.mapView", b.getAttribute("data-view")); } catch (err) { /* private mode */ }
    });
    var savedView = null;
    try { savedView = localStorage.getItem("recall.mapView"); } catch (err) { savedView = null; }
    if (savedView === "globe") showView("globe");
  }

  // Copy buttons for a piece of text (the console's Links page); hidden until this script runs.
  document.querySelectorAll("button[data-copy-text]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () {
      var done = function (label) {
        b.textContent = label;
        setTimeout(function () { b.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(b.getAttribute("data-copy-text") || "").then(function () { done("Copied"); }, function () { done("Select & copy"); });
      else done("Select & copy");
    });
  });
  // The Links page's form: the link as it will be made, while it is filled in (the server cleans
  // the tags the same way: lower case, dashes for spaces, only a-z 0-9 . _ -).
  var utmForm = document.querySelector("form[data-utm-form]");
  if (utmForm) {
    var utmPreview = utmForm.querySelector("[data-utm-preview]");
    var utmCode = utmPreview && utmPreview.querySelector("code");
    var media = {};
    try { media = JSON.parse(utmForm.getAttribute("data-media") || "{}"); } catch (e) { media = {}; }
    var slug = function (v) {
      return (v || "").trim().toLowerCase().replace(/\\s+/g, "-").replace(/[^a-z0-9._-]/g, "").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
    };
    var showLink = function () {
      var f = utmForm.elements;
      var source = slug(f.source.value), campaign = slug(f.campaign.value), content = slug(f.content.value);
      var path = (f.custom_path.value || "").trim() || f.path.value || "/";
      var hash = path.indexOf("#");
      var q = new URLSearchParams();
      q.set("utm_source", source || "source");
      q.set("utm_medium", slug(f.medium.value) || media[source] || "referral");
      q.set("utm_campaign", campaign || "campaign");
      if (content) q.set("utm_content", content);
      utmCode.textContent = (utmForm.getAttribute("data-site") || "").replace(/\\/+$/, "") + (hash < 0 ? path : path.slice(0, hash)) + "?" + q.toString() + (hash < 0 ? "" : path.slice(hash));
      utmPreview.hidden = false;
    };
    if (utmCode) {
      utmForm.addEventListener("input", showLink);
      utmForm.addEventListener("change", showLink);
      showLink();
    }
  }

  // The Playground while Recall reads the sample conversation: look again after a few seconds.
  var refresher = document.querySelector("[data-refresh-after]");
  if (refresher) {
    setTimeout(function () {
      if (document.visibilityState === "visible") location.href = refresher.getAttribute("data-refresh-href") || location.href;
    }, (Number(refresher.getAttribute("data-refresh-after")) || 5) * 1000);
  }
})();
`;
