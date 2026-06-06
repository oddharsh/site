// nav.js — site-wide XP "Luna" taskbar + Run command palette.
//
// One deferred, self-contained widget shared across every page (SW-cached) instead
// of 10 inline copies — it injects its own <style> once (the same pattern the design
// system's components use) and builds the taskbar + Run dialog into <body>.
//
// • Taskbar (fixed, bottom): Start orb · pinned profile "apps" · clock tray.
// • Start orb / ⌘K (Ctrl-K) / the taskbar both open the Run dialog — a resto-mod of
//   the XP Run box: "Type the name of a page, photo, or profile…". Filters the
//   sitemap live; ↑/↓ + Enter to go, Esc to close.
// • Destinations: pages + garage entries + profiles are inline (small, stable);
//   the 131 photos load lazily from /images/manifest.json on first open, with
//   /images/alt.json captions as searchable labels (so "car" finds the Porsche).
//
// Native fonts only (via the page's --font-* tokens, with literal fallbacks), OKLCH
// colors, 1px bevels, squared corners, instant motion. honesty: every entry resolves
// to a real destination; nothing decorative pretends to be interactive.
(function () {
  "use strict";
  if (window.__axpNav) return; window.__axpNav = true;
  var D = document;

  // ── destinations ──────────────────────────────────────────────────────────
  var PAGES = [
    { label: "Home", path: "/", hint: "aadhar.sh" },
    { label: "whoareyou", path: "/whoareyou", hint: "for agents + the curious" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "garage", path: "/garage/", hint: "prototypes + experiments" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "music", path: "/rn", hint: "what I'm listening to right now" },
    { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" },
    { label: "source", path: "/source", hint: "view this site's source" },
    { label: "writing", path: "/writing", hint: "notes, in flux — an editable notepad" },
    { label: "garage · chunks", path: "/garage/chunks", hint: "content-addressed chunking" },
    { label: "garage · cloudflare", path: "/garage/cloudflare", hint: "free Cloudflare features" },
    { label: "garage · encoding", path: "/garage/encoding", hint: "thumbnail encoding study" },
    { label: "garage · horizon", path: "/garage/horizon", hint: "web-platform horizon" },
    { label: "garage · pretext", path: "/garage/pretext", hint: "DOM-free text measurement" },
    { label: "garage · scroll", path: "/garage/scroll", hint: "XP scroll chrome" },
    { label: "garage · tooltips", path: "/garage/tooltips", hint: "tooltip experiments" }
  ];
  var PROFILES = [
    { label: "Twitter", url: "https://twitter.com/oddhash" },
    { label: "Instagram", url: "https://instagram.com/aadharsh.hif" },
    { label: "Curius", url: "https://curius.app/aadharsh-pannirselvam" },
    { label: "Beli", url: "https://beliapp.com/users/aadharsh" },
    { label: "Spotify", url: "https://open.spotify.com/user/aadharsh2010" }
  ];
  var PHOTOS = null;          // lazy: [{ label, path, hint, kind:'photo' }]
  var WRITING = null;         // lazy: [{ label, path, hint, kind:'writing' }]
  var photosPromise = null, writingPromise = null;

  function tag(kind, o) { o.kind = kind; return o; }
  PAGES.forEach(function (p) { tag("page", p); });
  PROFILES.forEach(function (p) { p.path = p.url; tag("profile", p); });

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
          hint: alt[p.stem] || "full-resolution photo"
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

  // ── styles (injected once) ──────────────────────────────────────────────────
  var CSS =
"#axp-taskbar{position:fixed;left:0;right:0;bottom:0;height:30px;z-index:99999;display:flex;align-items:stretch;" +
"font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:11px;user-select:none;" +
"background:linear-gradient(180deg,oklch(67% 0.15 256) 0%,oklch(58% 0.19 257) 4%,oklch(51% 0.20 258) 9%,oklch(49% 0.20 258) 50%,oklch(46% 0.20 259) 92%,oklch(40% 0.18 260) 100%);" +
"box-shadow:inset 0 1px 0 oklch(82% 0.09 250),inset 0 2px 0 oklch(62% 0.16 255)}" +
// start orb
"#axp-start{display:flex;align-items:center;gap:6px;padding:0 16px 2px 9px;border:0;cursor:pointer;color:oklch(100% 0 0);" +
"font-family:var(--font-caption,'Trebuchet MS',Verdana,sans-serif);font-style:italic;font-weight:bold;font-size:14px;text-shadow:1px 1px 1px oklch(22% 0.07 145);" +
"border-radius:0 9px 9px 0/0 14px 14px 0;margin-right:6px;" +
"background:linear-gradient(180deg,oklch(72% 0.17 142) 0%,oklch(63% 0.18 143) 8%,oklch(54% 0.18 144) 46%,oklch(50% 0.18 145) 52%,oklch(58% 0.17 143) 92%,oklch(45% 0.16 146) 100%);" +
"box-shadow:inset 1px 1px 0 oklch(86% 0.13 140),inset -1px -1px 0 oklch(38% 0.13 147)}" +
"#axp-start:hover{filter:brightness(1.08)}#axp-start:active,#axp-start[aria-expanded=true]{filter:brightness(.92);box-shadow:inset 1px 1px 0 oklch(38% 0.13 147),inset -1px -1px 0 oklch(86% 0.13 140)}" +
// the Windows flag, drawn as 4 CSS squares (no logo asset)
"#axp-flag{flex:0 0 auto;width:14px;height:14px;display:grid;grid-template:1fr 1fr/1fr 1fr;gap:1px;transform:perspective(20px) rotateY(-12deg);filter:drop-shadow(1px 1px 0 oklch(30% 0.07 145))}" +
"#axp-flag i{display:block;border-radius:1px}#axp-flag i:nth-child(1){background:oklch(64% 0.21 25)}#axp-flag i:nth-child(2){background:oklch(80% 0.18 130)}" +
"#axp-flag i:nth-child(3){background:oklch(68% 0.17 250)}#axp-flag i:nth-child(4){background:oklch(83% 0.18 90)}" +
// pinned profile apps
"#axp-pins{display:flex;align-items:center;gap:3px;padding:3px 0}" +
".axp-pin{display:flex;align-items:center;gap:5px;height:100%;padding:0 9px;border:1px solid transparent;cursor:pointer;color:oklch(100% 0 0);" +
"font-family:inherit;font-size:11px;background:oklch(60% 0.16 257);border-radius:2px;text-decoration:none;" +
"box-shadow:inset 1px 1px 0 oklch(74% 0.13 252),inset -1px -1px 0 oklch(40% 0.16 260)}" +
".axp-pin:hover{background:oklch(66% 0.16 256)}.axp-pin:active{box-shadow:inset 1px 1px 0 oklch(40% 0.16 260),inset -1px -1px 0 oklch(74% 0.13 252)}" +
".axp-pin b{width:9px;height:9px;border-radius:2px;flex:0 0 auto;box-shadow:inset 0 0 0 1px oklch(100% 0 0 / .4)}" +
"#axp-spacer{flex:1}" +
// tray + clock
"#axp-tray{display:flex;align-items:center;padding:0 12px 0 10px;margin:3px 4px 3px 0;color:oklch(100% 0 0);" +
"font-size:11px;letter-spacing:.02em;border-radius:3px;background:oklch(46% 0.15 256);" +
"box-shadow:inset 1px 1px 0 oklch(38% 0.15 260),inset -1px -1px 0 oklch(66% 0.13 252)}" +
// ── Run dialog ──
"#axp-run-back{position:fixed;inset:0;z-index:99998;display:none}" +
"#axp-run-back.open{display:block}" +
"#axp-run{position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:100000;width:min(440px,calc(100vw - 24px));display:none;" +
"font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:12px;color:oklch(21% 0 0);background:oklch(100% 0 0);" +
"border:2px solid oklch(45% 0.22 263);border-right-color:oklch(33% 0.16 263);border-bottom-color:oklch(33% 0.16 263);" +
"box-shadow:inset 1px 1px 0 oklch(58% 0.16 258),inset -1px -1px 0 oklch(33% 0.16 263),4px 4px 0 oklch(46% 0.16 263 / .35),6px 8px 24px -6px oklch(0% 0 0 / .5)}" +
"#axp-run.open{display:block}" +
"#axp-run .tb{display:flex;align-items:center;gap:6px;padding:3px 4px 4px 7px;color:oklch(100% 0 0);" +
"font-family:var(--font-caption,'Trebuchet MS',Verdana,sans-serif);font-weight:bold;font-size:12px;text-shadow:1px 1px oklch(28% 0.12 263);" +
"border-radius:5px 5px 0 0;border-bottom:1px solid oklch(41% 0.10 251);" +
"background:linear-gradient(180deg,oklch(70% 0.15 258) 0%,oklch(60% 0.20 261) 8%,oklch(51% 0.225 263) 18%,oklch(50% 0.225 263) 86%,oklch(58% 0.18 260) 100%)}" +
"#axp-run .tb .x{margin-left:auto;width:20px;height:18px;border:1px solid oklch(100% 0 0 / .6);border-radius:3px;cursor:pointer;color:oklch(100% 0 0);" +
"background:oklch(64% 0.21 25);font:bold 11px var(--font-ui,Tahoma);line-height:1;display:flex;align-items:center;justify-content:center}" +
"#axp-run .tb .x:hover{background:oklch(72% 0.22 25)}" +
"#axp-run .body{display:flex;gap:11px;padding:14px 13px 6px}" +
"#axp-run .ico{flex:0 0 auto;width:34px;height:34px;position:relative;margin-top:2px}" +
// run "document with green swoosh" icon, pure CSS
"#axp-run .ico .doc{position:absolute;inset:0 6px 0 2px;background:oklch(99% 0 0);border:1px solid oklch(55% 0 0);border-radius:1px}" +
"#axp-run .ico .doc::before{content:'';position:absolute;left:3px;right:5px;top:5px;height:1px;box-shadow:0 0 0 0 oklch(60% 0 0),0 3px 0 oklch(60% 0 0),0 6px 0 oklch(60% 0 0),0 9px 0 oklch(60% 0 0);background:oklch(60% 0 0)}" +
"#axp-run .ico .sw{position:absolute;left:-2px;bottom:-1px;width:26px;height:18px;border-radius:50%;border:5px solid oklch(58% 0.18 150);border-right-color:transparent;border-bottom-color:transparent;transform:rotate(34deg)}" +
"#axp-run .prompt{flex:1;line-height:1.45;color:oklch(28% 0 0)}" +
"#axp-run .open-row{display:flex;align-items:center;gap:8px;padding:4px 13px 2px}" +
"#axp-run .open-row label{flex:0 0 auto}" +
"#axp-run input{flex:1;font-family:var(--font-ui,Tahoma,Verdana,sans-serif);font-size:12px;padding:3px 5px;color:oklch(18% 0 0);background:oklch(100% 0 0);" +
"border:2px solid;border-color:oklch(55% 0 0) oklch(86% 0 0) oklch(86% 0 0) oklch(55% 0 0)}" +
"#axp-run input:focus{outline:1px dotted oklch(45% 0.10 263);outline-offset:1px}" +
"#axp-run .list{margin:6px 13px 0;border:1px solid oklch(72% 0.02 250);max-height:40vh;overflow:auto;background:oklch(100% 0 0)}" +
"#axp-run .grp{padding:3px 8px;font-size:10px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:oklch(45% 0.04 255);background:oklch(95% 0.01 250);position:sticky;top:0}" +
"#axp-run .opt{display:flex;align-items:baseline;gap:8px;padding:3px 9px;cursor:pointer;white-space:nowrap}" +
"#axp-run .opt .nm{font-weight:bold;color:oklch(30% 0.03 255)}" +
"#axp-run .opt .ht{color:oklch(52% 0 0);font-size:11px;overflow:hidden;text-overflow:ellipsis}" +
"#axp-run .opt .pa{margin-left:auto;color:oklch(60% 0 0);font-family:var(--font-mono,'Courier New',monospace);font-size:10px}" +
"#axp-run .opt[aria-selected=true]{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}" +
"#axp-run .opt[aria-selected=true] .nm,#axp-run .opt[aria-selected=true] .ht,#axp-run .opt[aria-selected=true] .pa{color:oklch(100% 0 0)}" +
"#axp-run .empty{padding:8px 10px;color:oklch(52% 0 0);font-style:italic}" +
"#axp-run .btns{display:flex;justify-content:flex-end;gap:7px;padding:11px 13px 13px}" +
"#axp-run .btn{min-width:74px;padding:3px 12px;font-family:inherit;font-size:12px;cursor:pointer;color:oklch(18% 0 0);" +
"background:linear-gradient(180deg,oklch(99% 0 0),oklch(92% 0.005 263));border:1px solid oklch(50% 0.04 263);border-radius:3px;" +
"box-shadow:inset 1px 1px 0 oklch(100% 0 0),inset -1px -1px 0 oklch(84% 0.02 90)}" +
"#axp-run .btn:hover{background:linear-gradient(180deg,oklch(99% 0.02 263),oklch(90% 0.03 263))}" +
"#axp-run .btn:active{box-shadow:inset 1px 1px 0 oklch(84% 0.02 90),inset -1px -1px 0 oklch(100% 0 0)}" +
"#axp-run .btn.def{outline:1px dotted oklch(45% 0.10 263);outline-offset:-4px}" +
"@media (max-width:560px){.axp-pin .lbl{display:none}.axp-pin{padding:0 7px}#axp-run .body{padding-top:11px}}" +
"@media (prefers-reduced-motion:no-preference){#axp-run.open{animation:axp-pop .09s ease-out}}" +
"@keyframes axp-pop{from{transform:translate(-50%,-50%) scale(.97);opacity:.4}to{transform:translate(-50%,-50%) scale(1);opacity:1}}";

  function injectCSS() {
    if (D.getElementById("axp-css")) return;
    var s = D.createElement("style"); s.id = "axp-css"; s.textContent = CSS;
    (D.head || D.documentElement).appendChild(s);
  }

  // ── build DOM ────────────────────────────────────────────────────────────────
  var run, input, list, backdrop, results = [], sel = -1;

  function el(html) { var t = D.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

  function buildTaskbar() {
    var bar = el('<div id="axp-taskbar" role="navigation" aria-label="taskbar"></div>');
    var start = el('<button id="axp-start" type="button" aria-haspopup="dialog" aria-expanded="false" title="Run — navigate the site (⌘K)"><span id="axp-flag" aria-hidden="true"><i></i><i></i><i></i><i></i></span>start</button>');
    start.addEventListener("click", function () { openRun(); });
    bar.appendChild(start);
    var pins = el('<div id="axp-pins"></div>');
    PROFILES.forEach(function (p) {
      var b = el('<a class="axp-pin" target="_blank" rel="noopener me external" title="' + p.label + ' — opens in a new tab"><b style="background:' + pinColor(p.label) + '"></b><span class="lbl">' + p.label + '</span></a>');
      b.href = p.url; pins.appendChild(b);
    });
    bar.appendChild(pins);
    bar.appendChild(el('<div id="axp-spacer"></div>'));
    var tray = el('<div id="axp-tray" aria-hidden="true"><span id="axp-clock"></span></div>');
    bar.appendChild(tray);
    D.body.appendChild(bar);
    tickClock();
    setInterval(tickClock, 15000);
  }

  function pinColor(name) {
    return { Twitter: "oklch(70% 0.14 233)", Instagram: "oklch(63% 0.2 9)", Curius: "oklch(64% 0.17 145)", Beli: "oklch(72% 0.18 60)", Spotify: "oklch(68% 0.18 145)" }[name] || "oklch(70% 0.05 255)";
  }

  function tickClock() {
    var c = D.getElementById("axp-clock"); if (!c) return;
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    var ap = h < 12 ? "AM" : "PM", hh = h % 12; if (hh === 0) hh = 12;
    c.textContent = hh + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  function buildRun() {
    backdrop = el('<div id="axp-run-back"></div>');
    backdrop.addEventListener("click", closeRun);
    run = el(
      '<div id="axp-run" role="dialog" aria-modal="true" aria-label="Run">' +
        '<div class="tb"><span>Run</span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
        '<div class="body"><div class="ico" aria-hidden="true"><div class="doc"></div><div class="sw"></div></div>' +
          '<div class="prompt">Type the name of a page, photo, or profile, and <b>aadhar.sh</b> will open it for you.</div></div>' +
        '<div class="open-row"><label for="axp-run-in">Open:</label><input id="axp-run-in" type="text" autocomplete="off" spellcheck="false" placeholder="start typing… (e.g. garage, encoding, spotify, a photo)"></div>' +
        '<div class="list" id="axp-run-list" role="listbox" aria-label="destinations"></div>' +
        '<div class="btns"><button class="btn def" type="button" data-act="ok">OK</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>' +
      '</div>'
    );
    D.body.appendChild(backdrop); D.body.appendChild(run);
    input = run.querySelector("#axp-run-in");
    list = run.querySelector("#axp-run-list");
    run.querySelector(".x").addEventListener("click", closeRun);
    run.querySelector('[data-act=cancel]').addEventListener("click", closeRun);
    run.querySelector('[data-act=ok]').addEventListener("click", function () { go(results[sel] || results[0]); });
    input.addEventListener("input", render);
    input.addEventListener("keydown", onKey);
    list.addEventListener("click", function (e) {
      var o = e.target.closest(".opt"); if (!o) return;
      go(results[+o.dataset.i]);
    });
  }

  // ── filtering + render ────────────────────────────────────────────────────────
  function pool() { return PAGES.concat(WRITING || [], PROFILES, PHOTOS || []); }

  function score(item, q) {
    var l = item.label.toLowerCase(), h = (item.hint || "").toLowerCase(), p = (item.path || "").toLowerCase();
    if (l === q) return 100;
    if (l.indexOf(q) === 0) return 80;
    if (p.indexOf(q) > -1) return 60;
    if (l.indexOf(q) > -1) return 50;
    if (h.indexOf(q) > -1) return 30;
    return -1;
  }

  function render() {
    var q = input.value.trim().toLowerCase();
    var items = pool();
    if (q) {
      items = items.map(function (it) { return { it: it, s: score(it, q) }; })
        .filter(function (x) { return x.s >= 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .map(function (x) { return x.it; })
        .slice(0, 40);
    } else {
      // empty: show pages + writing + profiles + a handful of photos as a "directory"
      items = PAGES.concat(WRITING || [], PROFILES, (PHOTOS || []).slice(0, 8));
    }
    results = items; sel = items.length ? 0 : -1;
    var groups = { page: [], writing: [], profile: [], photo: [] }, order = ["page", "writing", "profile", "photo"], names = { page: "Pages", writing: "Writing", profile: "Profiles", photo: "Photos" };
    items.forEach(function (it, i) { groups[it.kind].push({ it: it, i: i }); });
    var html = "";
    order.forEach(function (k) {
      if (!groups[k].length) return;
      html += '<div class="grp">' + names[k] + "</div>";
      groups[k].forEach(function (g) {
        html += '<div class="opt" role="option" data-i="' + g.i + '" aria-selected="' + (g.i === sel) + '">' +
          '<span class="nm">' + esc(g.it.label) + "</span>" +
          (g.it.hint ? '<span class="ht">' + esc(g.it.hint) + "</span>" : "") +
          '<span class="pa">' + esc(g.it.kind === "profile" ? "↗" : g.it.path) + "</span></div>";
      });
    });
    list.innerHTML = html || '<div class="empty">No match. Try a page name, a photo stem, or a profile.</div>';
    ensureVisible();
  }

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[sel] || results[0]); }
    else if (e.key === "Escape") { e.preventDefault(); closeRun(); }
  }
  function move(d) {
    if (!results.length) return;
    sel = (sel + d + results.length) % results.length;
    [].forEach.call(list.querySelectorAll(".opt"), function (o) { o.setAttribute("aria-selected", +o.dataset.i === sel); });
    ensureVisible();
  }
  function ensureVisible() {
    var o = list.querySelector('.opt[aria-selected=true]'); if (o) o.scrollIntoView({ block: "nearest" });
  }

  function go(item) {
    if (!item) return;
    closeRun();
    if (item.kind === "profile") window.open(item.url, "_blank", "noopener");
    else location.assign(item.path);
  }

  // ── open / close ──────────────────────────────────────────────────────────────
  var lastFocus = null;
  function openRun() {
    if (!run) buildRun();
    if (run.classList.contains("open")) return;
    if (!PHOTOS) loadPhotos().then(function () { if (run.classList.contains("open")) render(); });
    if (!WRITING) loadWriting().then(function () { if (run.classList.contains("open")) render(); });
    lastFocus = D.activeElement;
    backdrop.classList.add("open"); run.classList.add("open");
    var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "true");
    input.value = ""; render();
    input.focus();
  }
  function closeRun() {
    if (!run || !run.classList.contains("open")) return;
    run.classList.remove("open"); backdrop.classList.remove("open");
    var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ⌘K / Ctrl-K anywhere
  D.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      run && run.classList.contains("open") ? closeRun() : openRun();
    }
  });

  // ── boot ────────────────────────────────────────────────────────────────────
  function boot() { injectCSS(); buildTaskbar(); }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
