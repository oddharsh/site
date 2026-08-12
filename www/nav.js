// nav.js — site-wide XP "Luna" shell enhancer.
//
// The build/compiler puts the desktop icons and taskbar in every document. This
// shared deferred script adopts that one DOM contract and wires behavior; it does
// not carry a second shell constructor. Run and tray balloons arrive as separate
// first-interaction modules, while their static links remain usable without JS.
//
// • Taskbar (fixed, bottom): Start orb · pinned profile "apps" · clock tray.
// • Start orb / ⌘K (Ctrl-K) opens the lazy Run dialog — a resto-mod of
//   the XP Run box: "Type the name of a page, photo, or profile…". Filters the
//   sitemap live; ↑/↓ + Enter to go, Esc to close.
// • Destinations: pages + garage entries + profiles live in nav-run.js;
//   photos load lazily from /images/manifest.json on first open, with
//   /images/alt.json captions as searchable labels (so "car" finds the Porsche).
//
// Native fonts only (via the page's --font-* tokens, with literal fallbacks), OKLCH
// colors, 1px bevels, squared corners, instant motion. honesty: every entry resolves
// to a real destination; nothing decorative pretends to be interactive.
(function () {
  "use strict";
  var W = /** @type {Window & typeof globalThis & {__axpNav?: boolean, webkitAudioContext?: typeof AudioContext}} */ (window);
  if (W.__axpNav) return; W.__axpNav = true;
  var D = document;
  // The Run palette used to open and close inside a same-document View Transition.
  // It applies its DOM change directly now (2026-07-30), for the same reason the
  // cross-document transition came out of luna.css: the palette is already on
  // screen the instant it is asked for, so a transition could only delay it.
  // Wrapping the mutation was also never free of side effects — startViewTransition
  // defers the callback, so anything that measured or focused right after the call
  // ran a frame early. #axp-run keeps its own 90ms `axp-pop` CSS animation, which
  // is a plain keyframe on the dialog and costs the page nothing.
  // platform-aware shortcut label shown on the Start orb + Run dialog. The
  // keydown handler binds BOTH ⌘K and Ctrl-K; this is only what we DISPLAY, so
  // Mac users see ⌘K and everyone else sees Ctrl K.
  var uaData = /** @type {Navigator & {userAgentData?: {platform?: string}}} */ (navigator).userAgentData;
  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test((uaData && uaData.platform) || navigator.platform || navigator.userAgent || "");
  var KBD = IS_MAC ? "⌘K" : "Ctrl K";

  // The pageswap/pagereveal pair that tagged each navigation "axp-open" or
  // "axp-close" is gone with the transition it steered. Both listeners ran on
  // EVERY navigation to hand a type to CSS rules that no longer exist, and the
  // pageswap one also wrote the sessionStorage breadcrumb /garage/vt-check read;
  // that page now states plainly that the shell does not opt in.

  // Run destinations and profiles live in /nav-run.js, transferred only when
  // someone opens the palette. Section artwork lives only in shell-data.mjs;
  // the compiler already projected it into each taskbar pin's sprite image.
  var PHOTOS = null;          // lazy: [{ label, path, hint, kind:'photo' }]
  var WRITING = null;         // lazy: [{ label, path, hint, kind:'writing' }]
  var photosPromise = null, writingPromise = null;

  function tag(kind, o) { o.kind = kind; return o; }

  // pull the photo manifest (for /images/full/<file> paths) + alt captions (labels)
  function loadPhotos() {
    if (photosPromise) return photosPromise;
    photosPromise = Promise.all([
      fetch("/images/manifest.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch("/images/alt.json").then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    ]).then(function (res) {
      var man = res[0], alt = res[1] || {};
      var photos = ((man && man.photos) || []).map(function (p) {
        return tag("photo", {
          label: p.stem,
          path: "/images/full/" + encodeURI(p.full),
          hint: alt[p.stem] || "full-resolution photo",
          // the 400px AVIF tier the mobile grid already ships (~12KB), reused
          // by the Run preview card. Absolute + content-hashed in the manifest.
          thumb: p.thumb_small || p.thumb_avif || ""
        });
      });
      PHOTOS = photos;
      return photos;
    });
    return photosPromise;
  }

  // writing posts (for /writing/<slug> entries) — same lazy pattern as photos
  function loadWriting() {
    if (writingPromise) return writingPromise;
    writingPromise = fetch("/writing/posts.json").then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
      .then(function (posts) {
        WRITING = (posts || []).map(function (p) {
          return tag("writing", { label: p.title || p.slug, path: "/writing/" + p.slug, hint: p.date ? "note · " + p.date : "note" });
        });
        return WRITING;
      });
    return writingPromise;
  }

  // ── styles: /luna.css (the Bliss SVG + every shell rule moved there) ────────

  // the shell's CSS lives in /luna.css now (readable, cacheable, present at
  // parse time — see the shell-rewrite phase A). Pages link it at the end of
  // <head>; this fallback only covers stale cached HTML from before the
  // extraction, injecting the same <link> so the desktop still dresses itself.
  // Guard matches BOTH the plain /luna.css and the build's hashed
  // /a/luna.<hash>.css (substring "luna."), so a hashed page is never double-linked.
  function ensureLunaCss() {
    if (D.querySelector('link[href*="luna."]') || D.getElementById("axp-css")) return;
    var l = D.createElement("link"); l.rel = "stylesheet"; l.href = "/luna.css";
    (D.head || D.documentElement).appendChild(l);
  }

  // ── interaction islands + shared state ───────────────────────────────────────
  var runPromise = null, runApi = null;
  // Shared readers back both the lazy tray island and the lazy infotips.
  var sysData = null, updData = null;
  var trayPromise = null, accZ = 40;

  /** @returns {HTMLElement} */
  function el(html) {
    var t = D.createElement("template");
    t.innerHTML = html.trim();
    var node = t.content.firstElementChild;
    if (!(node instanceof HTMLElement)) throw new Error("Shell template must produce an element");
    return node;
  }

  // ── XP-flavored sound: synthesized via Web Audio (no copyrighted audio, no asset
  // bytes), gated by the tray mute toggle. Default OFF so there is never surprise
  // audio; the choice persists in localStorage. Navigation sounds are skipped on
  // purpose (page unload cuts them) — only in-page shell actions play.
  var AXP_SND = (function () {
    var ctx = null, on = false;
    try { on = localStorage.getItem("axp-sound") === "on"; } catch (e) {}
    function ac() { if (!ctx) { try { var Audio = W.AudioContext || W.webkitAudioContext; if (!Audio) return null; ctx = new Audio(); } catch (e) { return null; } } if (ctx.state === "suspended" && ctx.resume) ctx.resume(); return ctx; }
    // one decaying partial: fast attack, exponential tail (a struck note, not a beep).
    function partial(c, freq, t0, dur, peak, type) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || "sine"; o.frequency.value = freq; o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak || 0.1, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.start(t0); o.stop(t0 + dur + 0.02);
    }
    // struck-bell timbre: fundamental + inharmonic overtones, the glassy chime
    // character XP's notification sounds have (a flat sine beep does not).
    function bell(c, base, t0, dur, peak) {
      partial(c, base,        t0, dur,       peak,        "sine");
      partial(c, base * 2.01, t0, dur * 0.7, peak * 0.5,  "sine");
      partial(c, base * 2.76, t0, dur * 0.5, peak * 0.30, "sine");
      partial(c, base * 5.18, t0, dur * 0.28, peak * 0.12, "triangle");
    }
    var voices = {
      // notification ding: a quick bright chime up a fourth
      open:  function (c, t) { bell(c, 784, t, 0.45, 0.07); bell(c, 1047, t + 0.045, 0.6, 0.085); },
      // dismissal: a softer chime down
      close: function (c, t) { bell(c, 659, t, 0.40, 0.06); bell(c, 494, t + 0.05, 0.5, 0.05); },
      // critical-stop: a low dissonant pair with a little grit
      error: function (c, t) { partial(c, 196, t, 0.30, 0.075, "sine"); partial(c, 207, t, 0.32, 0.05, "triangle"); partial(c, 98, t, 0.34, 0.05, "sine"); },
      // task-complete fanfare: a rising major arpeggio landing on a held octave
      tada:  function (c, t) { [523, 659, 784].forEach(function (f, i) { bell(c, f, t + i * 0.09, 0.32, 0.07); }); bell(c, 1047, t + 0.27, 0.85, 0.09); }
    };
    return {
      on: function () { return on; },
      set: function (v) { on = !!v; try { localStorage.setItem("axp-sound", on ? "on" : "off"); } catch (e) {} },
      play: function (name) { if (!on) return; var c = ac(); if (c && voices[name]) voices[name](c, c.currentTime); }
    };
  })();

  function front(win) { win.style.zIndex = ++accZ; }
  function initRaise() {
    D.addEventListener("pointerdown", function (e) {
      var win = e.target instanceof Element && e.target.closest(".window,.np-window,.axp-acc");
      if (!(win instanceof HTMLElement) || String(win.style.zIndex) === String(accZ)) return;
      front(win);
    }, true);
  }

  var STYLE_ASSETS = {
    "nav-run": "/nav-run.css",
    "nav-tray": "/nav-tray.css",
    "infotip": "/infotip.css"
  };
  var stylePromises = Object.create(null);
  function loadStyle(name) {
    if (stylePromises[name]) return stylePromises[name];
    stylePromises[name] = new Promise(function (resolve, reject) {
      var link = D.createElement("link");
      link.rel = "stylesheet";
      link.href = STYLE_ASSETS[name];
      link.onload = resolve;
      link.onerror = function () { delete stylePromises[name]; link.remove(); reject(new Error(name + " styles failed")); };
      (D.head || D.documentElement).appendChild(link);
    });
    return stylePromises[name];
  }

  function loadRun() {
    if (!runPromise) {
      runPromise = Promise.all([loadStyle("nav-run"), import("/nav-run.js")]).then(function (loaded) {
        var m = loaded[1];
        runApi = m.createRun({
          kbd: KBD,
          sound: AXP_SND,
          loadPhotos: loadPhotos,
          loadWriting: loadWriting,
          front: front
        });
        return runApi;
      });
    }
    return runPromise;
  }
  function toggleRun(viaKeyboard) {
    if (runApi) {
      if (runApi.isOpen()) runApi.close(); else runApi.open(viaKeyboard);
      return Promise.resolve();
    }
    return loadRun().then(function (api) { api.open(viaKeyboard); });
  }

  // Behavior for the compiled taskbar. Shell presence is a build invariant:
  // nav.js enhances one DOM contract instead of carrying a second constructor.
  function wireTaskbar(bar) {
    var start = D.getElementById("axp-start");
    if (start instanceof HTMLAnchorElement) {
      var startHref = start.href;
      // platform-correct shortcut hint + title (the static partial ships ⌘K;
      // non-Mac visitors get it rewritten here before they can notice)
      start.title = "Run — navigate the site (" + KBD + ")";
      [].forEach.call(start.querySelectorAll(".axp-kbd"), function (k) { k.textContent = KBD; });
      start.addEventListener("click", function (e) {
        e.preventDefault();   // the href is the JS-off floor; JS gets the palette
        // detail === 0 means the click came from the keyboard (Enter/Space on the
        // focused orb) rather than a pointer, so the ring is still wanted here.
        toggleRun(e.detail === 0).catch(function () {
          location.assign(startHref);   // preserve the real /run fallback
        });
      });
      // Warm the island on hover intent, the same signal the homepage tooltip
      // loader binds to. The dwell before a click covers the fetch, so the
      // palette opens from memory instead of from the network. loadRun()
      // memoizes and toggleRun() awaits the same promise, so the click path is
      // unchanged and there is no captured event to replay. The catch resets it
      // so a failed warm leaves the click free to retry rather than inheriting a
      // permanently rejected promise. ⌘K deliberately gets nothing here: there
      // is no hover on the keyboard path, and warming on modifier-keydown would
      // fire for every ⌘R/⌘T/⌘C. Touch fires a synthetic pointerover while
      // scrolling past the taskbar (gotcha 10), so only a real hover counts.
      start.addEventListener("pointerover", function (e) {
        if (e.pointerType !== "touch") loadRun().catch(function () { runPromise = null; });
      }, { passive: true });
    }
    // XP taskbar truth: the app that's in front sits DEPRESSED. Match the
    // current path's first segment against each pin's section (garage subpages
    // keep the garage button pressed; the homepage is the desktop — none).
    var seg = "/" + (location.pathname.split("/")[1] || "");
    [].forEach.call(bar.querySelectorAll(".axp-pin"), function (p) {
      var pinSeg = "/" + ((p.getAttribute("href") || "").split("/")[1] || "");
      var cur = seg !== "/" && pinSeg === seg;
      p.classList.toggle("cur", cur);
      if (cur) p.setAttribute("aria-current", "page"); else p.removeAttribute("aria-current");
    });
    var sndBtn = D.getElementById("axp-sound");
    if (sndBtn) sndBtn.hidden = false;   // the partial ships it hidden: sounds need JS
    function paintSnd() {
      var on = AXP_SND.on();
      sndBtn.className = on ? "" : "muted";
      sndBtn.title = on ? "Sounds on (click to mute)" : "Sounds off (click to unmute)";
      sndBtn.setAttribute("aria-label", sndBtn.title); sndBtn.setAttribute("aria-pressed", String(!on));
      sndBtn.innerHTML = '<svg viewBox="0 0 24 24">' + (on
        ? '<defs><filter id="sdSh" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".25"></feDropShadow></filter><linearGradient id="sdC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfb"></stop><stop offset=".5" stop-color="#cfcfcf"></stop><stop offset="1" stop-color="#9c9c9c"></stop></linearGradient></defs><g filter="url(#sdSh)"><rect x="2" y="8.6" width="2.6" height="6.8" rx=".6" fill="#8c8c8c"></rect><path d="M3.4 9 H6.4 L11 4.6 V17.4 L6.4 13 H3.4 Z" fill="url(#sdC)" stroke="#5f5f5f" stroke-width=".6" stroke-linejoin="round"></path><path d="M3.9 9.4 H6.1 L9.6 6 V8.6 Z" fill="#ffffff" opacity=".4"></path><g fill="none" stroke="#2e8fd6" stroke-linecap="round"><path d="M13.4 8 Q15.4 11 13.4 14" stroke-width="1.6"></path><path d="M15.7 6 Q19.2 11 15.7 16" stroke-width="1.5" opacity=".82"></path><path d="M18 4.3 Q22.4 11 18 17.7" stroke-width="1.4" opacity=".62"></path></g></g>'
        : '<defs><filter id="muSh" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".25"></feDropShadow></filter><linearGradient id="muC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ededed"></stop><stop offset=".5" stop-color="#c2c2c2"></stop><stop offset="1" stop-color="#969696"></stop></linearGradient><radialGradient id="muR" cx=".4" cy=".34" r=".75"><stop offset="0" stop-color="#f47f72"></stop><stop offset="1" stop-color="#c2271c"></stop></radialGradient></defs><g filter="url(#muSh)"><rect x="2" y="8.6" width="2.6" height="6.8" rx=".6" fill="#8c8c8c"></rect><path d="M3.4 9 H6.4 L11 4.6 V17.4 L6.4 13 H3.4 Z" fill="url(#muC)" stroke="#5f5f5f" stroke-width=".6" stroke-linejoin="round"></path><circle cx="16.6" cy="10.8" r="5.1" fill="url(#muR)" stroke="#8c1a10" stroke-width=".7"></circle><path d="M13.3 7.5 L19.9 14.1" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"></path><ellipse cx="14.9" cy="8.4" rx="2.5" ry="1.2" fill="#ffffff" opacity=".28"></ellipse></g>') + '</svg>';
    }
    if (sndBtn) {
      sndBtn.addEventListener("click", function () { var next = !AXP_SND.on(); AXP_SND.set(next); paintSnd(); if (next) AXP_SND.play("tada"); });
      paintSnd();
    }
    // each system-utility tray icon opens a brief XP balloon above itself. they stay
    // real <a href> so a modified click (⌘/Ctrl/Shift, or middle — which fires
    // auxclick, not click) still opens the full page in a new tab.
    [].forEach.call(bar.querySelectorAll(".axp-trayico"), function (ic) {
      ic.setAttribute("aria-haspopup", "dialog");
      ic.setAttribute("aria-expanded", "false");
      ic.addEventListener("click", function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // let the browser navigate
        e.preventDefault();
        toggleTray(ic.getAttribute("data-kind"), ic).catch(function () {
          location.assign(ic.href);   // a failed island load falls back to the real page
        });
      });
      // same hover warm as the Start orb, for the same reason. Unlike /run these
      // icons keep their page prerenders: each balloon carries a "full page"
      // link, so /security and /updates are destinations a visitor really reaches.
      ic.addEventListener("pointerover", function (e) {
        if (e.pointerType !== "touch") loadTray().catch(function () { trayPromise = null; });
      }, { passive: true });
    });
    tickClock();
    setInterval(tickClock, 15000);
  }


  // Desktop icon positions are DELIBERATELY not persisted. The stored layout
  // was read back in states that couldn't honour it (luna hides #axp-icons
  // under 1024px; on the homepage luna itself lands after boot() runs), so what
  // came back was a stack rather than the arrangement anyone chose. Icons drag
  // freely within a visit and the shipped column is always what you open to.
  // One-shot sweep of the retired key so old visitors don't carry dead state.
  // Shipped 2026-07-22; safe to delete once returning visitors have cycled
  // through (any time after ~2027-07), because a leftover key with no reader
  // is inert, it just wastes a slot in someone's localStorage.
  try { localStorage.removeItem("axp-icons-pos"); } catch (_) {}

  // drag desktop icons around the wallpaper (transform-free: left/top).
  // a movement threshold distinguishes a drag from a click so links still open.
  function initIconDrag() {
    var icons = D.getElementById("axp-icons"); if (!icons) return;
    // ProMotion discipline: the gesture writes TRANSFORM only (pure compositor
    // move, promoted by .axp-dragging's will-change), and the final left/top is
    // committed once, on release. Writing left/top per pointermove forced a
    // layout every frame — visible as judder on 120Hz variable-refresh panels.
    var cur = null, sx = 0, sy = 0, ox = 0, oy = 0, nx = 0, ny = 0, moved = false;
    function mv(e) {
      if (!cur) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true; cur.classList.add("axp-dragging");
      nx = Math.max(0, Math.min(ox + dx, innerWidth - 76));
      ny = Math.max(0, Math.min(oy + dy, innerHeight - 30 - 72));
      cur.style.transform = "translate(" + (nx - ox) + "px," + (ny - oy) + "px)";
    }
    function up() {
      D.removeEventListener("pointermove", mv);
      if (cur && moved) {
        cur.style.left = nx + "px"; cur.style.top = ny + "px";
        cur.style.transform = "";
        cur.classList.remove("axp-dragging");
      }
      cur = null;
    }
    icons.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      var a = e.target instanceof Element && e.target.closest(".axp-ico");
      if (!(a instanceof HTMLElement)) return;
      cur = a; moved = false; sx = e.clientX; sy = e.clientY;
      ox = parseFloat(a.style.left) || 0; oy = parseFloat(a.style.top) || 0;
      try { a.setPointerCapture(e.pointerId); } catch (_) {}
      D.addEventListener("pointermove", mv);
      D.addEventListener("pointerup", up, { once: true });
      D.addEventListener("pointercancel", up, { once: true });
    });
    // swallow the click that follows a real drag so the link doesn't navigate
    icons.addEventListener("click", function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
  }

  // local wall-clock parts via Temporal when the browser ships it, else Date.
  function nowHM() {
    try {
      if (typeof Temporal !== "undefined" && Temporal.Now && Temporal.Now.plainTimeISO) {
        var t = Temporal.Now.plainTimeISO();
        return { h: t.hour, m: t.minute };
      }
    } catch (e) {}
    var d = new Date(); return { h: d.getHours(), m: d.getMinutes() };
  }
  function tickClock() {
    var c = D.getElementById("axp-clock"); if (!c) return;
    var t = nowHM(), h = t.h, m = t.m;
    var ap = h < 12 ? "AM" : "PM", hh = h % 12; if (hh === 0) hh = 12;
    c.textContent = hh + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  // Run palette and accessory implementation moved to /nav-run.js.

  // Data is cached per page load. Keeping these readers in the core lets a tray
  // click and a later live infotip share one fetch without shipping render code.
  function loadSys(cb) {
    if (sysData) { cb(sysData); return; }
    fetch("/whoareyou.json", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.groups) sysData = j; cb(sysData); })
      .catch(function () { cb(null); });
  }
  function loadUpd(cb) {
    if (updData) { cb(updData); return; }
    fetch("/updates.json", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.items) updData = j; cb(updData); })
      .catch(function () { cb(null); });
  }
  function loadTray() {
    if (!trayPromise) {
      trayPromise = Promise.all([loadStyle("nav-tray"), import("/nav-tray.js")]).then(function (loaded) {
        var m = loaded[1];
        return m.createTray({ sound: AXP_SND, loadSys: loadSys, loadUpd: loadUpd });
      });
    }
    return trayPromise;
  }
  function toggleTray(kind, ic) {
    return loadTray().then(function (tray) { tray.toggle(kind, ic); });
  }

  // ⌘K / Ctrl-K anywhere
  D.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      toggleRun(true).catch(function () { location.assign("/run"); });
    }
  });

  // ── compiled desktop layer + dragging ────────────────────────────────────────
  // grab a title bar → drag the window with TRANSFORM ONLY (no position change), so it
  // stays in normal flow and the page keeps scrolling. (the old version popped the
  // window to position:fixed, which collapsed a content page's flow and broke its
  // scroll.) base preserves any existing transform — e.g. the Run dialog's centering —
  // so it composes instead of jumping, which also makes the Run dialog draggable.
  // caption buttons + links are skipped so close/min/max keep working; touch scrolls.
  function initDrag() {
    var win = null, sx = 0, sy = 0, base = "", r = null, topLayer = false;
    // clamp so the title bar can't leave the desktop: the TOP is a hard wall (you
    // can't retrieve a window dragged off the top — there's no menu up there), and
    // the bar can't slide under the taskbar or fully off the sides either.
    function move(e) {
      if (!win) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var vw = innerWidth, vh = innerHeight;
      // Ordinary windows are clamped by their TITLE BAR and are free to let their
      // body slide under the taskbar, which is what XP does and what reads right:
      // the taskbar's z-index 99999 covers them.
      var maxDy = (vh - 30 - 24) - r.top;
      // A /writing folder note is popover="manual", so it lives in the TOP LAYER,
      // and the top layer paints above every z-index there is — 99999 included.
      // Dragged down, it went OVER the taskbar instead of under it. No stacking
      // rule can fix that from CSS, so the honest fallback is to stop the whole
      // window at the taskbar: the note never crosses it, in either direction.
      // Always satisfiable — .np-note[popover] caps at 100dvh - 48, which leaves
      // more room than the 38px this needs, so maxDy never falls below the top wall.
      if (topLayer) maxDy = Math.min(maxDy, (vh - 30) - r.bottom);
      dy = Math.max(8 - r.top, Math.min(dy, maxDy));
      dx = Math.max((60 - r.width) - r.left, Math.min(dx, (vw - 60) - r.left));
      win.style.transform = base + "translate(" + dx + "px," + dy + "px)";
    }
    function up() { if (win) { win.classList.remove("axp-dragging"); D.removeEventListener("pointermove", move); win = null; } }
    D.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;                       // let touch scroll the page, not drag
      if (e.pointerType === "mouse" && e.button !== 0) return;
      var b = e.target instanceof Element && e.target.closest(".title-bar,.np-titlebar,.titlebar,#axp-run .tb");
      if (!b || (e.target instanceof Element && e.target.closest("a,button,.controls,.np-controls,.x"))) return;
      var w = b.closest(".window,.np-window,#axp-run");
      if (!w) return;
      if (w.classList.contains("axp-max")) return;   // a maximized window is pinned, not draggable
      var t = getComputedStyle(w).transform;
      base = (t && t !== "none") ? t + " " : "";
      r = w.getBoundingClientRect();
      // :popover-open is the top-layer test — a popover only joins the top layer
      // while it is showing, and a hidden one can't be dragged anyway.
      topLayer = w.matches(":popover-open");
      w.classList.add("axp-dragging");
      win = w; sx = e.clientX; sy = e.clientY;
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      D.addEventListener("pointermove", move);
      D.addEventListener("pointerup", up, { once: true });
      D.addEventListener("pointercancel", up, { once: true });
    });
  }

  // The custom scrollbar widget retired in the phase-C follow-ups: luna.css
  // now styles the REAL scrollbar (::-webkit-scrollbar bevels + arrow buttons
  // in Chromium/WebKit; scrollbar-color in Firefox — the truthful thin
  // rendering). Styling any ::-webkit-scrollbar part also opts macOS out of
  // overlay bars, so the 16px XP bar is persistent exactly like the widget was.
  function initScrollbars() {
    // native bars are pure CSS now; the one JS job left is the scroll memory
    var main = D.querySelector("body > .window > .content, body > .window > .body");
    if (!main) { var npw = D.querySelector("body > .np-window"); if (npw) main = npw.querySelector(".np-text"); }
    if (main) rememberScroll(main);
  }

  // The OS model scrolls .content internally, which browsers don't reliably
  // restore on reload (the no-store homepage re-renders; the geometry is JS-aware).
  // So persist scrollTop per-path in sessionStorage (per tab, survives reload,
  // clears on close) and restore it — but ONLY on a reload. Fresh navigations
  // start at top, and back/forward is left to the browser's bfcache. Cheap:
  // scrollend (or a throttle) to write, one read on boot.
  function rememberScroll(sc) {
    var key = "axp-scroll:" + location.pathname;
    var save = function () { try { sessionStorage.setItem(key, String(sc.scrollTop)); } catch (e) {} };
    var nav = /** @type {PerformanceNavigationTiming|undefined} */ (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]);
    if (nav && nav.type === "reload") {
      var y = parseInt(sessionStorage.getItem(key), 10);
      if (y > 0) {
        var done = false;
        var restore = function () { if (done) return; sc.scrollTop = y; if (sc.scrollTop > 0) done = true; };   // fires scroll → thumb syncs
        requestAnimationFrame(restore);                      // once the scroller is laid out
        addEventListener("load", restore, { once: true });   // re-assert after images/fonts settle (scrollHeight final)
      }
    }
    if ("onscrollend" in sc) sc.addEventListener("scrollend", save, { passive: true });
    else { var t; sc.addEventListener("scroll", function () { clearTimeout(t); t = setTimeout(save, 200); }, { passive: true }); }
    addEventListener("pagehide", save);   // catch a reload/close before scrollend fires
  }

  // ── resizable windows (bottom-right grip) ─────────────────────────────────────
  function initResize() {
    // CSS `resize: both` does the actual resizing now (phase C follow-up; the
    // pointer math lived here). What remains: the decorative XP dotted grip
    // (pointer-events:none, so the native resizer under it gets the drag) and
    // one real job the platform can't do — pages clamp windows with their
    // design max-width/height, which native resize cannot exceed, so a
    // gesture starting in the corner lifts the clamps first.
    [].forEach.call(D.querySelectorAll(".window,.np-window"), function (f) {
      if (f.classList.contains("np-folder")) return;   // folder hugs its content — not resizable
      if (f.querySelector(":scope > .axp-resize")) return;
      if (getComputedStyle(f).position === "static") f.style.position = "relative";
      f.appendChild(el('<div class="axp-resize" aria-hidden="true"></div>'));
      f.addEventListener("pointerdown", function (e) {
        if (f.classList.contains("axp-max")) return;
        var r = f.getBoundingClientRect();
        if (r.right - e.clientX < 20 && r.bottom - e.clientY < 20) {
          f.style.maxWidth = "none";
          // A popover note is in the TOP LAYER, so the taskbar cannot cover it (see
          // initDrag) — the grip has to stop where the taskbar starts instead of
          // lifting the ceiling entirely. setProperty(..., "important") because
          // .np-note[popover]'s own max-height is !important, which is also why the
          // plain assignment below was already a no-op for these: the lift never
          // applied, yet a short note dragged down could still grow past the bar.
          if (f.matches(":popover-open")) f.style.setProperty("max-height", Math.max(120, (innerHeight - 30) - r.top) + "px", "important");
          else f.style.maxHeight = "none";
        }
      });
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  // Set the tab favicon to the current first-level section's compiled SVG asset,
  // so the browser no longer carries a second SVG constructor + icon table.
  // Exact-match only — /garage/<sub> + /writing/<slug> + home keep their own
  // page favicons (e.g. each garage demo's distinct icon).
  function setFavicon() {
    var np = location.pathname.replace(/\/+$/, "") || "/";
    var sec = [].filter.call(D.querySelectorAll(".axp-pin"), function (pin) {
      return ((pin.getAttribute("href") || "").replace(/\/+$/, "") || "/") === np;
    })[0];
    var icon = sec && sec.getAttribute("data-favicon");
    if (!icon) return;
    var link = D.querySelector('link[rel~="icon"]');
    if (link && !(link instanceof HTMLLinkElement)) return;
    var iconLink = /** @type {HTMLLinkElement} */ (link || D.createElement("link"));
    if (!link) { iconLink.rel = "icon"; (D.head || D.documentElement).appendChild(iconLink); }
    iconLink.type = "image/svg+xml";
    iconLink.href = icon;
  }

  // The shell's Speculation Rules used to be built here and appended at boot.
  // They ship in the HTML now, projected from SPECULATION in shell-data.mjs into
  // the generated chrome, so they reach static and worker-rendered pages alike
  // and parse with the document instead of after first paint. See #338.

  // Instant "close": the close glyph means "up to aadhar.sh". When the window
  // was opened directly FROM the homepage, going back restores it from bfcache —
  // instant, zero network, no worker hit, no loading bar — instead of a fresh
  // no-store fetch of "/". Every other case falls through to the href (a normal
  // navigation to "/"). McMaster-Carr feel without prerendering the heaviest
  // page on every hover.
  //
  // The gate has to be "the entry BEHIND this one is home", not "the referrer is
  // home". A page that writes its own history — /lens pushes an entry per view
  // and lens tab — grows the stack without ever touching document.referrer, so
  // the referrer test kept passing while Back had turned into "undo my last tab
  // click". Close is a window control, not a Back button: it either lands on the
  // homepage or it doesn't fire. The Navigation API answers the real question
  // directly; where it's missing, require a stack that hasn't grown since load
  // (any in-page push disqualifies the shortcut) and let the plain href carry it.
  function initCloseBack() {
    var homeUrl = location.origin + "/";
    var lenAtLoad = history.length;
    function prevIsHome() {
      if (window.navigation && navigation.entries && navigation.currentEntry) {
        var i = navigation.currentEntry.index;
        if (i < 1) return false;
        var prev = navigation.entries()[i - 1];
        return !!prev && prev.url === homeUrl;
      }
      return D.referrer === homeUrl && history.length === lenAtLoad;
    }
    D.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target instanceof Element && e.target.closest("a.close");
      if (!a || history.length <= 1 || !prevIsHome()) return;
      e.preventDefault();
      history.back();
    });
  }

  // ── back/forward, close-to-home, and a real maximize, injected site-wide ──
  // History buttons call history.back()/forward() so every hop rides bfcache:
  // instant, no white flash (the homepage stays no-cache, never no-store, for
  // exactly this). Maximize toggles in-page state, so no navigation and no view
  // transition; the frame's ResizeObserver re-fits the scrollbar for free.
  function initWindowControls() {
    var win = D.querySelector("body > .window, body > .np-window");
    if (!win) return;
    var bar = win.querySelector(":scope > .title-bar, :scope > .np-titlebar, :scope > .titlebar");
    if (!bar) return;
    var home = (location.pathname.replace(/\/+$/, "") || "/") === "/";

    if (!D.getElementById("axp-wc-css")) {
      var st = D.createElement("style"); st.id = "axp-wc-css";
      st.textContent =
        // maximized: cover the whole desktop (wallpaper + icons), stop at the 30px taskbar floor
        ".window.axp-max,.np-window.axp-max{position:fixed!important;inset:0 0 30px 0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;margin:0!important;border-radius:0!important;transform:none!important;z-index:9998!important}" +
        // history-nav buttons, at the head of the title bar. same Luna caption-button
        // GEL as .controls .min/.max site-wide (21x21 lozenge, traced-hex blue gradient,
        // top specular gloss band via ::after, CSS-drawn white glyph via ::before, brighter
        // hover) so back/forward read as real caption buttons. glyph is an arrow, not a bar.
        ".axp-histnav{display:inline-flex;gap:2px;margin-right:6px;flex:0 0 auto;align-items:center}" +
        ".axp-histnav button{position:relative;box-sizing:border-box;width:21px;height:21px;padding:0;margin:0;display:inline-block;overflow:hidden;font:0/0 a;color:transparent;cursor:pointer;border:1px solid #6696eb;border-radius:3px;background-color:#3e73f5;background-image:linear-gradient(180deg,#5f8cf7 0%,#3a71f5 22%,#3e73f5 55%,#2a70f2 82%,#1045be 100%);transition:filter 60ms ease-out}" +
        ".axp-histnav button::after{content:'';position:absolute;left:0;right:0;top:0;height:45%;background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.12) 70%,rgba(255,255,255,0) 100%);border-radius:2px 2px 5px 5px;pointer-events:none}" +
        // translate(-50%,-50%) centers against the triangle's real border box (5x10),
        // which margin guesses got wrong (back sat 3.5px left of center, fwd 1.5px)
        ".axp-histnav button::before{content:'';position:absolute;top:50%;left:50%;width:0;height:0;border:5px solid transparent;transform:translate(-50%,-50%);filter:drop-shadow(0 1px 0 rgba(0,0,0,.35))}" +
        ".axp-histnav .axp-back::before{border-right-color:#fff;border-left-width:0}" +
        ".axp-histnav .axp-fwd::before{border-left-color:#fff;border-right-width:0}" +
        ".axp-histnav button:hover:not([disabled]){border-color:#8fb4ff;background-color:#4fa4ff;background-image:linear-gradient(180deg,#689bff 0%,#468aff 22%,#4fa4ff 55%,#3990fc 82%,#1858c8 100%);outline:none}" +
        ".axp-histnav button:active:not([disabled]){filter:brightness(.9)}" +
        ".axp-histnav button:focus-visible{outline:1px dotted #fff;outline-offset:-4px}" +
        ".axp-histnav button[disabled]{opacity:.45;cursor:default;filter:none}";
      D.head.appendChild(st);
    }

    // close -> aadhar.sh on every non-home page. initCloseBack still upgrades the
    // click to history.back() when you actually arrived from home (bfcache, no flash).
    if (!home) {
      var closeA = bar.querySelector("a.close");
      if (closeA instanceof HTMLAnchorElement) { closeA.setAttribute("href", "/"); closeA.title = "close to aadhar.sh"; closeA.setAttribute("aria-label", "close to aadhar.sh"); }
    }

    // back / forward, injected at the head of the title bar (excluded from title-bar
    // drag because they're <button>, which initDrag already skips).
    //
    // A window may opt out with data-no-histnav, and /terminal is the one that
    // does. Back and Forward are BROWSER controls: on a document window they
    // read as the window's own chrome, but on a console they read as a terminal
    // running inside Internet Explorer, which is the opposite of the illusion.
    // Opting out here rather than by giving that window a different title-bar
    // class keeps drag, resize, maximize and close-to-home, which a console
    // window still wants — those are OS chrome, not browser chrome.
    if (!bar.querySelector(".axp-histnav") && !win.hasAttribute("data-no-histnav")) {
      var hn = el('<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button><button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>');
      bar.insertBefore(hn, bar.firstChild);
      var bBtn = hn.querySelector(".axp-back"), fBtn = hn.querySelector(".axp-fwd");
      if (!(bBtn instanceof HTMLButtonElement) || !(fBtn instanceof HTMLButtonElement)) return;
      var backButton = bBtn, forwardButton = fBtn;
      // Back's PARENT fallback: with no history behind this page (a cold
      // arrival, a shared link), Back walks UP the path instead of sitting
      // blank — /lwe/vigenere goes to /lwe/, /garage/wire to /garage/,
      // /around to /. Real history always wins (it rides bfcache, ~0ms);
      // the fallback only fires when there is nothing to go back TO. On
      // the homepage there is no parent, so Back stays disabled there.
      var parentPath = location.pathname.replace(/\/+$/, "").replace(/[^/]+$/, "") || "/";
      var atRoot = (location.pathname.replace(/\/+$/, "") || "/") === "/";
      var realBack = function () {
        return window.navigation ? navigation.canGoBack : history.length > 1;
      };
      backButton.addEventListener("click", function () {
        if (realBack()) history.back();
        else if (!atRoot) location.href = parentPath;
      });
      forwardButton.addEventListener("click", function () { history.forward(); });
      var sync = function () {
        if (!window.navigation) return;                 // no Navigation API -> leave both enabled
        var rb = navigation.canGoBack;
        backButton.disabled = !rb && atRoot;                  // parent fallback keeps it live elsewhere
        backButton.title = rb || atRoot ? "Back" : "Back to " + parentPath;
        backButton.setAttribute("aria-label", backButton.title);
        forwardButton.disabled = !navigation.canGoForward;
      };
      sync();
      if (window.navigation) navigation.addEventListener("currententrychange", sync);
      addEventListener("pageshow", sync);               // re-sync after a bfcache restore
    }

    // maximize / restore the page window
    var maxBtn = bar.querySelector(".max");
    if (maxBtn instanceof HTMLElement && !maxBtn.dataset.axpWired) {
      var maximizeButton = maxBtn;
      maximizeButton.dataset.axpWired = "1";
      maximizeButton.setAttribute("role", "button");
      maximizeButton.setAttribute("tabindex", "0");
      maximizeButton.removeAttribute("aria-hidden");
      maximizeButton.setAttribute("aria-label", "Maximize");
      maximizeButton.title = "Maximize";
      maximizeButton.style.cursor = "pointer";
      var toggle = function () {
        var on = win.classList.toggle("axp-max");
        maximizeButton.setAttribute("aria-label", on ? "Restore" : "Maximize");
        maximizeButton.title = on ? "Restore" : "Maximize";
      };
      maximizeButton.addEventListener("click", toggle);
      maximizeButton.addEventListener("keydown", function (/** @type {KeyboardEvent} */ e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    }
  }

  // ── XP infotips, on the chrome AND the content ──────────────────────────────
  // Almost everything here already carries a `title`, which buys the OS tooltip:
  // one line, in the system font, after a delay nobody chose. Windows itself was
  // richer than that — an Explorer infotip named a folder's contents, and the
  // tray's tooltips were live readouts — so /infotip.js re-draws them in Luna
  // and gives the ones with something to say the room to say it.
  //
  // The rule is now the short one: ANY [title] is a tip, wherever it lives. A
  // titled citation link on an /lwe page and a taskbar button are the same
  // promise to a visitor, and the old shell-only list meant that promise was
  // kept in the chrome and broken two inches lower. What the shell selectors
  // below still buy is the title-LESS chrome (the clock has no attribute to
  // read) and the families whose card is built from live state rather than from
  // the string.
  //
  // Same bargain the homepage strikes with tooltip.js: the loader stays here so
  // it can catch the very first hover, the implementation arrives lazily, and a
  // visitor who never points at anything (or points with a finger) transfers
  // none of it. The module's own 400ms dwell is what hides the load — the
  // import runs during the wait, so a cold first infotip lands about when a
  // warm one would.
  var INFOTIP_TARGETS = [
    "#axp-start", ".axp-pin", ".axp-trayico", "#axp-sound", "#axp-clock", ".axp-ico",
    "[data-tip]",                                   // opt-in for a control with no native tip
    "[title]"                                       // and everything the platform already tips
  ].join(",");
  // Four richer surfaces got here first, and each one already draws its own card
  // from the same engine: the photo/track/artist/car island (tooltip.js), the
  // /lens glossary (lens.js), and serendipity's event covers. A plain tip on top
  // of any of them is two popovers for one hover. `.lx-term` matters most: those
  // ship a `title` as their no-JS fallback and lens.js strips it once its own
  // surface is live, so without this the race between two lazy modules would
  // decide whether you got the good card or the flat one.
  var INFOTIP_SKIP = ".lx-term,.photos a,.np-list li,.np-artist-link,.car-link,.ev[data-cover],iframe";
  function initInfotips() {
    if (!window.matchMedia || matchMedia("(hover: none)").matches || matchMedia("(pointer: coarse)").matches) return;
    var mod = null, pending = null;
    // ONE implementation of "what was hovered", handed to the module rather than
    // restated there. Two copies of a rule this shape is how a loader and its
    // module come to disagree about which elements have a tip — and the symptom
    // would be a tooltip that works everywhere except wherever you looked first.
    var targetFor = function (n) {
      var t = n && n.closest ? n.closest(INFOTIP_TARGETS) : null;
      return t && !t.closest(INFOTIP_SKIP) ? t : null;
    };
    var load = function () {
      if (mod) return;
      // hoist.js is infotip.js's one static import, so the parser cannot
      // discover it until infotip.js has landed — the same serialized second
      // fetch that cost the homepage a round trip through tooltip.js (measured
      // 2026-07-27, see build.mjs's STRING_ASSETS note). Kicking it off here
      // runs the two in parallel; the result is unused on purpose, since the
      // module cache is what the static import hits, and on the homepage it is
      // usually already warm from tooltip.js.
      import("/hoist.js").catch(function () {});
      mod = Promise.all([loadStyle("infotip"), import("/infotip.js")]).then(function (loaded) {
        var m = loaded[1];
        // These are nav.js's own readers, so a tray infotip and its click-balloon
        // share one fetch per page rather than race for it.
        m.start({
          find: targetFor,
          initial: pending,
          kbd: KBD,
          load: { sys: loadSys, upd: loadUpd, writing: loadWriting }
        });
        pending = null;
        // These three exist only to catch the hover that arrives before the
        // module does, and the module runs its own listeners now. Since the
        // selector matches every titled element on the page, leaving them
        // attached would run a second `closest()` walk per pointerover for the
        // rest of the session, on a path that fires on every element boundary
        // the cursor crosses. Retiring them is the whole reason they are named.
        D.removeEventListener("pointerover", onOver);
        D.removeEventListener("pointerout", onOut);
        D.removeEventListener("focusin", onFocus);
      }).catch(function () { mod = null; pending = null; });
    };
    function onOver(e) {
      var t = targetFor(e.target);
      if (!t) return;
      pending = { target: t, clientX: e.clientX, clientY: e.clientY, at: Date.now() };
      load();
    }
    function onOut(e) {
      if (pending && targetFor(e.target) === pending.target && targetFor(e.relatedTarget) !== pending.target) pending = null;
    }
    function onFocus(e) {
      var t = targetFor(e.target);
      if (!t) return;
      try { if (!t.matches(":focus-visible")) return; } catch (_) {}
      pending = { target: t, focus: true };
      load();
    }
    D.addEventListener("pointerover", onOver, { passive: true });
    D.addEventListener("pointerout", onOut, { passive: true });
    D.addEventListener("focusin", onFocus);
  }

  function boot() {
    var bar = D.getElementById("axp-taskbar");
    if (!bar || !D.getElementById("axp-desktop")) return;
    ensureLunaCss(); wireTaskbar(bar); initDrag(); initRaise(); initIconDrag(); initScrollbars(); initResize(); setFavicon(); initCloseBack(); initWindowControls(); initInfotips();
  }
  function bootAfterStaticPaint() {
    // Generated/static pages and Worker-rendered shells already carry the desktop
    // and taskbar markup plus race-proof geometry in HTML. nav.js only ENHANCES
    // that shell (dragging, Run, clock, controls), so let its useful content paint
    // before doing the DOM wiring. Two frames guarantee one complete static paint.
    // A prerendered document does not run animation frames while hidden. Enhance its
    // already-SSR'd shell now, so activation inherits a fully wired desktop instead
    // of paying both frames on the click that activates the prerender.
    /** @type {Document & {prerendering?: boolean}} */
    var prerenderDocument = D;
    if (prerenderDocument.prerendering) return boot();
    requestAnimationFrame(() => requestAnimationFrame(boot));
  }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", bootAfterStaticPaint);
  else bootAfterStaticPaint();
})();
