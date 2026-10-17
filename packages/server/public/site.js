// Recall site (8-bit edition): reveal on scroll, the phone menu, copy buttons, tabs, sideways
// scroll hints, the API's URL in examples, the docs' table of contents, the visit's source on
// links to sign-in, and the landing page's analytics events.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const still = new URLSearchParams(location.search).has("still");

  // ---- reveal on scroll (and the benchmark bars). Only blocks below the first screen carry
  // .reveal. site.css hides them until revealed and has a failsafe that shows them anyway after a
  // moment; marking the page reveal-ready hands that job to this script. If the observer never
  // reports (some headless renderers), or the page is printed, everything is shown at once.
  const fillBars = (root) => {
    for (const f of $$(".fill", root)) f.style.width = `${f.dataset.w}%`;
  };
  const show = (el) => {
    el.classList.add("in");
    fillBars(el);
  };
  const reveals = $$(".reveal");
  const late = performance.now() > 2000; // the failsafe has (nearly) shown them already
  if (still || late || !("IntersectionObserver" in window)) reveals.forEach(show);
  else {
    let reported = false;
    const io = new IntersectionObserver(
      (entries) => {
        reported = true;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          show(e.target);
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of reveals) io.observe(el);
    setTimeout(() => {
      if (!reported) reveals.forEach(show);
    }, 1500);
  }
  addEventListener("beforeprint", () => reveals.forEach(show));
  document.documentElement.classList.add("reveal-ready");

  // ---- motion. Everything in this block runs only when motion is welcome; without it (or
  // without this script) site.css leaves the page in its final, readable state.
  const motion =
    !still &&
    "IntersectionObserver" in window &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  if (motion) {
    const root = document.documentElement;
    root.classList.add("js-motion");

    // Headings rise word by word: each word gets a clipped box and an index for its delay.
    const splitWords = (el) => {
      let i = 0;
      const walk = (node) => {
        for (const child of [...node.childNodes]) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName !== "BR") walk(child);
            continue;
          }
          if (child.nodeType !== Node.TEXT_NODE) continue;
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
              frag.append(part);
              continue;
            }
            const box = document.createElement("span");
            const word = document.createElement("span");
            box.className = "w";
            word.textContent = part;
            word.style.setProperty("--i", String(i++));
            box.append(word);
            frag.append(box);
          }
          child.replaceWith(frag);
        }
      };
      walk(el);
    };
    const titles = $$("main h2.title");
    for (const t of titles) splitWords(t);
    // Grids and lists come in one item after another.
    const staggers = $$("[data-stagger]");
    for (const box of staggers)
      for (const [i, c] of [...box.children].entries()) c.style.setProperty("--i", String(i));
    let seen = false;
    const enter = new IntersectionObserver(
      (entries) => {
        seen = true;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target;
          el.classList.add("in");
          enter.unobserve(el);
          if (el.hasAttribute("data-stagger")) setTimeout(() => el.classList.add("done"), 2000);
          if (el.classList.contains("stats-grid")) for (const n of $$(".n", el)) countUp(n);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const el of [...titles, ...staggers]) enter.observe(el);
    setTimeout(() => {
      if (!seen) for (const el of [...titles, ...staggers]) el.classList.add("in", "done");
    }, 1500);

    // Benchmark figures count up to their value: "91.0%", "0.68", "$0.005".
    function countUp(el) {
      const m = el.textContent.match(/^(\D*)([\d.,]+)(.*)$/);
      if (!m) return;
      const [, pre, digits, post] = m;
      const target = Number(digits.replaceAll(",", ""));
      const places = (digits.split(".")[1] || "").length;
      const t0 = performance.now();
      const tick = (t) => {
        const k = clamp((t - t0) / 1600);
        el.textContent = pre + (target * (1 - (1 - k) ** 4)).toFixed(places) + post;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    // Scroll progress. [data-scrub] elements get --p (0 to 1) and --pb (0 at either end, 1 in
    // the middle): "enter" runs while the element's top crosses the lower half of the screen,
    // "pin" while a tall section scrolls past its pinned child, anything else from the moment
    // the element appears until it is gone.
    const scrubs = $$("[data-scrub]");
    const hooks = new Map();
    const hero = $("[data-hero]");
    const nav = $("#nav");
    const bar = document.createElement("i");
    bar.className = "scroll-bar";
    nav?.append(bar);
    let vh = innerHeight;
    const progress = (el) => {
      const r = el.getBoundingClientRect();
      if (el.dataset.scrub === "pin") return clamp(-r.top / Math.max(1, r.height - vh));
      if (el.dataset.scrub === "enter") return clamp((vh - r.top) / (vh * 0.55));
      return clamp((vh - r.top) / (vh + r.height));
    };
    let queued = false;
    const frame = () => {
      queued = false;
      for (const el of scrubs) {
        const p = progress(el);
        if (el.scrubP !== undefined && Math.abs(p - el.scrubP) < 0.0005) continue;
        el.scrubP = p;
        el.style.setProperty("--p", p.toFixed(4));
        el.style.setProperty("--pb", (1 - Math.abs(2 * p - 1)).toFixed(4));
        hooks.get(el)?.(p);
      }
      const y = scrollY;
      if (hero) {
        hero.style.setProperty("--sy", Math.min(y, vh * 1.2).toFixed(1));
        hero.style.setProperty("--hp", clamp(y / (vh * 0.75)).toFixed(4));
      }
      if (nav) {
        const max = document.documentElement.scrollHeight - vh;
        nav.style.setProperty("--page", clamp(max > 0 ? y / max : 0).toFixed(4));
      }
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(frame);
    };
    addEventListener("scroll", queue, { passive: true });
    addEventListener("resize", () => {
      vh = innerHeight;
      queue();
    });

    // How it works: the pinned section shows step 1, 2 or 3 as it scrolls by.
    const story = $(".story");
    const track = $(".story-track", story || undefined);
    if (story && track) {
      story.dataset.step = "1";
      hooks.set(track, (p) => {
        const step = String(p < 0.34 ? 1 : p < 0.68 ? 2 : 3);
        if (story.dataset.step !== step) story.dataset.step = step;
      });
    }
    // The timeline's cursor runs from January to today as it scrolls by; what it passes lights up.
    const timeline = $(".timeline[data-scrub]");
    if (timeline) {
      timeline.classList.add("scrub");
      const marks = $$("[data-at]", timeline);
      hooks.set(timeline, (p) => {
        const q = clamp((p - 0.16) / 0.4);
        timeline.style.setProperty("--q", q.toFixed(4));
        for (const m of marks) m.classList.toggle("hit", q * 0.785 >= Number(m.dataset.at) - 0.002);
      });
    }
    queue();

    // The hero city leans with the pointer.
    if (hero && matchMedia("(pointer: fine)").matches) {
      let tx = 0;
      let ty = 0;
      let mx = 0;
      let my = 0;
      let raf = 0;
      const ease = () => {
        mx += (tx - mx) * 0.07;
        my += (ty - my) * 0.07;
        hero.style.setProperty("--mx", mx.toFixed(4));
        hero.style.setProperty("--my", my.toFixed(4));
        raf = Math.abs(tx - mx) + Math.abs(ty - my) > 0.001 ? requestAnimationFrame(ease) : 0;
      };
      const aim = (x, y) => {
        tx = x;
        ty = y;
        if (!raf) raf = requestAnimationFrame(ease);
      };
      hero.addEventListener("pointermove", (e) =>
        aim((e.clientX / innerWidth) * 2 - 1, (e.clientY / vh) * 2 - 1),
      );
      hero.addEventListener("pointerleave", () => aim(0, 0));
    }

    // Windows and cards light up under the pointer.
    for (const el of $$(".window, .stat, .why-grid li, .trust-grid li")) {
      el.classList.add("spot");
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--x", `${e.clientX - r.left}px`);
        el.style.setProperty("--y", `${e.clientY - r.top}px`);
      });
    }

    // The product demo plays its story while it is on screen: Alice's message arrives, the old
    // fact is closed, the new one appears, a question is typed and the answer streams in.
    const demo = $(".demo[data-play]");
    const answer = demo && $(".mc-answer", demo);
    if (demo && answer) {
      let n = 0;
      for (const child of [...answer.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          child.classList.add("wd");
          child.style.setProperty("--i", String(n++));
          continue;
        }
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) {
            frag.append(part);
            continue;
          }
          const w = document.createElement("span");
          w.className = "wd";
          w.textContent = part;
          w.style.setProperty("--i", String(n++));
          frag.append(w);
        }
        child.replaceWith(frag);
      }
      const STEPS = [800, 2300, 3400, 4800, 6500]; // when steps s1–s5 begin, in ms
      const LOOP = 14000;
      let timers = [];
      let onScreen = false;
      const set = (k) => {
        for (let i = 1; i <= STEPS.length; i++) demo.classList.toggle(`s${i}`, i <= k);
      };
      const stop = () => {
        for (const t of timers) clearTimeout(t);
        timers = [];
      };
      const run = () => {
        stop();
        demo.classList.add("play");
        set(0);
        for (const [i, ms] of STEPS.entries()) timers.push(setTimeout(() => set(i + 1), ms));
        timers.push(setTimeout(run, LOOP));
      };
      const pause = () => {
        stop();
        set(STEPS.length);
      };
      new IntersectionObserver(
        ([e]) => {
          onScreen = e.isIntersecting;
          if (onScreen && !document.hidden) run();
          else pause();
        },
        { threshold: 0.35 },
      ).observe(demo);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) pause();
        else if (onScreen) run();
      });
    }
  }

  // ---- phone menu: the button opens the links under the bar; a link, Escape, a click
  // elsewhere or a wider window closes it.
  const nav = $("#nav");
  const toggle = nav && $(".nav-toggle", nav);
  if (toggle) {
    const setOpen = (open, focusButton = false) => {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      if (!open && focusButton) toggle.focus();
    };
    toggle.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
    for (const a of $$(".nav-menu a", nav)) a.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("open")) setOpen(false, true);
    });
    document.addEventListener("click", (e) => {
      if (nav.classList.contains("open") && !nav.contains(e.target)) setOpen(false);
    });
    matchMedia("(min-width: 821px)").addEventListener("change", (e) => {
      if (e.matches) setOpen(false);
    });
  }

  // ---- the API's URL in the docs' examples: on the hosted site the hosted API (from the
  // recall-api meta tag, which a self-hosted server fills in with its own URLs), anywhere else
  // the deployment serving this page.
  const apiMeta = $('meta[name="recall-api"]');
  const apiUrl =
    apiMeta?.content && location.origin === apiMeta.dataset.site
      ? apiMeta.content
      : location.origin;
  for (const el of $$(".origin")) el.textContent = apiUrl;

  // ---- copy buttons (every docs code block gets one)
  const COPY_ICON =
    '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
  for (const pre of $$(".prose pre")) {
    if ($(".copy", pre)) continue;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "copy";
    add.setAttribute("aria-label", "Copy code");
    add.innerHTML = COPY_ICON;
    pre.appendChild(add);
  }
  // data-copy holds the text, data-copy-from names a <template> that does, data-copy-active
  // copies the panel showing in the button's own tab box; the result is announced.
  const status = $("#copy-status");
  const copyText = (btn) => {
    if (btn.dataset.copy) return btn.dataset.copy;
    if (btn.dataset.copyFrom)
      return document.getElementById(btn.dataset.copyFrom)?.content.textContent;
    if (btn.hasAttribute("data-copy-active"))
      return $("[data-panel]:not([hidden])", btn.closest("[data-tabbox]") || document)?.innerText;
    return btn.closest("pre")?.querySelector("code")?.innerText;
  };
  for (const btn of $$(".copy, [data-copy-from]")) {
    const original = btn.innerHTML;
    btn.addEventListener("click", async () => {
      const text = copyText(btn);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text.trim());
        btn.classList.add("done");
        btn.textContent = btn.dataset.done || "ok!";
        if (status) status.textContent = btn.dataset.done || "Copied";
        setTimeout(() => {
          btn.classList.remove("done");
          btn.innerHTML = original;
          if (status) status.textContent = "";
        }, 2200);
      } catch {
        if (status) status.textContent = "Copying is blocked in this browser";
      }
    });
  }

  // ---- tabs (install commands, use cases, comparisons): each [data-tabbox] switches only its
  // own panels; arrow keys, Home and End move between the tabs of a tab list.
  const select = (tab, focus = false) => {
    const box = tab.closest("[data-tabbox]");
    for (const t of $$(".tab", box)) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      if (t.getAttribute("role") === "tab") t.tabIndex = on ? 0 : -1;
    }
    for (const p of $$("[data-panel]", box)) p.hidden = p.dataset.panel !== tab.dataset.tab;
    if (focus) tab.focus();
    box.dispatchEvent(new Event("tabchange"));
  };
  for (const tab of $$("[data-tabbox] .tab")) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const tabs = $$(".tab", tab.parentElement);
      const i = tabs.indexOf(tab);
      const next = {
        ArrowRight: tabs[(i + 1) % tabs.length],
        ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length],
        Home: tabs[0],
        End: tabs[tabs.length - 1],
      }[e.key];
      if (!next) return;
      e.preventDefault();
      select(next, true);
    });
  }

  // ---- sideways scrollers (code, tab rows): an arrow at the right edge while there is more
  for (const box of $$(".hscroll")) {
    const scroller = () => [...box.children].find((c) => !c.hidden) || box.firstElementChild;
    const update = () => {
      const el = scroller();
      box.classList.toggle("more", !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    for (const c of box.children) c.addEventListener("scroll", update, { passive: true });
    box.closest("[data-tabbox]")?.addEventListener("tabchange", update);
    addEventListener("resize", update, { passive: true });
    update();
  }

  // ---- docs: the contents start collapsed on a phone and fold away after a jump
  const tocBox = $(".toc-box");
  if (tocBox) {
    const phone = matchMedia("(max-width: 980px)");
    const sync = () => {
      tocBox.open = !phone.matches;
    };
    sync();
    phone.addEventListener("change", sync);
    for (const a of $$("a", tocBox)) {
      a.addEventListener("click", (e) => {
        const target = phone.matches && document.getElementById(a.getAttribute("href").slice(1));
        if (!target) return;
        e.preventDefault();
        tocBox.open = false;
        target.scrollIntoView();
        history.pushState(null, "", a.getAttribute("href"));
      });
    }
  }

  // ---- docs: highlight the section in view
  const tocLinks = $$(".toc a[href^='#']");
  if (tocLinks.length) {
    const map = new Map(tocLinks.map((a) => [a.getAttribute("href").slice(1), a]));
    const toc = $(".toc");
    // A long contents list scrolls on its own: keep the current section's link in view.
    const keepVisible = (a) => {
      if (!toc || toc.scrollHeight <= toc.clientHeight) return;
      const top = a.offsetTop;
      if (top < toc.scrollTop + 8 || top + a.offsetHeight > toc.scrollTop + toc.clientHeight - 8)
        toc.scrollTop = top - toc.clientHeight / 2;
    };
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          for (const a of tocLinks) a.classList.remove("active");
          const link = map.get(e.target.id);
          if (!link) continue;
          link.classList.add("active");
          keepVisible(link);
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const id of map.keys()) {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    }
  }

  // ---- where a visit came from, carried to sign-in: the links to /app/login get the visit's
  // UTM source and campaign (or ?ref=), else the referring site's host, as src= and campaign=.
  // The sign-in page keeps them through the email link or GitHub and stores them on a new
  // account (the console's Traffic page counts sign-ups per source). No cookie, no storage:
  // it only rewrites the links of this page view.
  {
    const q = new URLSearchParams(location.search);
    const tag = (v) => (v || "").trim().slice(0, 100);
    let src = tag(q.get("utm_source") || q.get("ref"));
    const campaign = tag(q.get("utm_campaign"));
    if (!src && document.referrer) {
      try {
        const host = new URL(document.referrer).hostname.replace(/^www\./, "");
        const own = location.hostname.replace(/^(www|app|api)\./, "");
        if (host && host !== own && !host.endsWith(`.${own}`)) src = host;
      } catch {
        // not a URL: no source
      }
    }
    if (src) {
      for (const a of $$('a[href^="/app/login"]')) {
        const url = new URL(a.getAttribute("href"), location.origin);
        url.searchParams.set("src", src);
        if (campaign) url.searchParams.set("campaign", campaign);
        a.setAttribute("href", url.pathname + url.search + url.hash);
      }
    }
  }

  // ---- analytics: Umami (cookieless, self-hosted in the EU), loaded from this origin as
  // /u/script.js. Clicks are tracked by its data-umami-event attributes; here, on the landing
  // page, each section reached (once per visit) and the demo watched. Nothing is sent when the
  // tracker did not load (blocked, or no tracker on this page). No personal data.
  const track = (name) => {
    if (typeof window.umami?.track === "function") window.umami.track(name);
  };
  if ($("[data-hero]") && "IntersectionObserver" in window) {
    const sections = $$("main > section[id]");
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          seen.unobserve(e.target);
          track(`reach-${e.target.id}`);
        }
      },
      { threshold: 0.25 },
    );
    for (const el of sections) seen.observe(el);

    // The demo counts as watched once it has been on screen through all five steps (8 s).
    const demo = $(".demo[data-play]");
    if (demo) {
      let timer = 0;
      const watch = new IntersectionObserver(
        ([e]) => {
          clearTimeout(timer);
          if (!e.isIntersecting) return;
          timer = setTimeout(() => {
            watch.disconnect();
            track("demo-watched");
          }, 8000);
        },
        { threshold: 0.5 },
      );
      watch.observe(demo);
    }
  }
})();
