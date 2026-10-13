// Recall site (8-bit edition): reveal on scroll, the phone menu, copy buttons, tabs, sideways
// scroll hints, the API's URL in examples, and the docs' table of contents.
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
})();
