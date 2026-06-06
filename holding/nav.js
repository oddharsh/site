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

  // XP "Bliss" desktop, drawn as an inline VECTOR SVG (no raster bytes — the site
  // ships none for chrome): blue sky, soft blurred clouds, a rolling green hill with a
  // sunlit rim. encodeURIComponent keeps the markup readable here + safe in the URI.
  var BLISS_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice">' +
    '<defs>' +
    '<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f7fcc"/><stop offset=".42" stop-color="#6ba3e0"/><stop offset=".62" stop-color="#bcdcf4"/><stop offset=".67" stop-color="#dfeefb"/></linearGradient>' +
    '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#95c43d"/><stop offset=".35" stop-color="#74af2d"/><stop offset="1" stop-color="#3c7d1a"/></linearGradient>' +
    '<radialGradient id="sn" cx=".5" cy=".64" r=".55"><stop offset="0" stop-color="#fffbe6" stop-opacity=".5"/><stop offset="1" stop-color="#fffbe6" stop-opacity="0"/></radialGradient>' +
    '<filter id="bl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.1"/></filter>' +
    '</defs>' +
    '<rect width="200" height="120" fill="url(#s)"/><rect width="200" height="120" fill="url(#sn)"/>' +
    '<g fill="#fff" filter="url(#bl)">' +
    '<g opacity=".92"><ellipse cx="34" cy="25" rx="18" ry="4.6"/><ellipse cx="41" cy="20" rx="11" ry="4.2"/><ellipse cx="25" cy="22" rx="8" ry="3.6"/></g>' +
    '<g opacity=".8"><ellipse cx="151" cy="18" rx="14" ry="3.8"/><ellipse cx="158" cy="14" rx="7" ry="3.2"/></g>' +
    '<g opacity=".6"><ellipse cx="98" cy="31" rx="22" ry="3"/></g>' +
    '<g opacity=".75"><ellipse cx="123" cy="42" rx="11" ry="2.6"/></g>' +
    '</g>' +
    '<path d="M0,79 C36,69 70,85 104,76 C140,67 172,78 200,72 L200,120 L0,120 Z" fill="url(#g)"/>' +
    '<path d="M0,79 C36,69 70,85 104,76 C140,67 172,78 200,72" fill="none" stroke="#bcde66" stroke-width="1.1" opacity=".5"/>' +
    '</svg>';
  var blissUrl = "data:image/svg+xml," + encodeURIComponent(BLISS_SVG);

  // ── styles (injected once) ──────────────────────────────────────────────────
  var CSS =
// View Transitions: animate window open/close across real navigations while the
// desktop + taskbar stay put (named = persistent). progressive — a no-op where the
// browser doesn't support it (Firefox just navigates instantly).
"@view-transition{navigation:auto}" +
// the shared Bliss desktop on a fixed layer behind everything; page bodies forced
// transparent so it shows through (overriding each page's own body background).
"html,body{background:transparent !important}" +
"#axp-desktop{position:fixed;inset:0;z-index:-1;view-transition-name:axp-desktop;background:url(\"" + blissUrl + "\") center center/cover no-repeat}" +
// windows drag by their title bar
".title-bar,.np-titlebar,.titlebar,#axp-run .tb{cursor:move}" +
".axp-dragging{user-select:none;will-change:transform}.axp-dragging .title-bar,.axp-dragging .np-titlebar,.axp-dragging .titlebar,#axp-run.axp-dragging .tb{cursor:grabbing}" +
"::view-transition-old(root){animation:axp-vo .18s ease both}::view-transition-new(root){animation:axp-vi .24s ease both}" +
"@keyframes axp-vo{to{opacity:0;transform:scale(.975)}}@keyframes axp-vi{from{opacity:0;transform:scale(1.025)}}" +
"@media (prefers-reduced-motion:reduce){::view-transition-old(root),::view-transition-new(root){animation:none}}" +
"#axp-taskbar{position:fixed;left:0;right:0;bottom:0;height:30px;z-index:99999;view-transition-name:axp-taskbar;display:flex;align-items:stretch;" +
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
// the site's traffic cone, drawn as CSS (the only mark the site uses) — orange
// triangle with two white bands + a base, matching the /favicon.ico cone.
"#axp-cone{flex:0 0 auto;width:15px;height:15px;position:relative;margin-right:1px;filter:drop-shadow(1px 1px 1px oklch(25% 0.05 30 / .5))}" +
"#axp-cone::before{content:'';position:absolute;left:0;right:0;top:0;bottom:2px;clip-path:polygon(50% 0,100% 100%,0 100%);background:linear-gradient(180deg,oklch(64% 0.22 38) 0 34%,oklch(97% 0.02 80) 34% 48%,oklch(64% 0.22 38) 48% 70%,oklch(97% 0.02 80) 70% 82%,oklch(64% 0.22 38) 82% 100%)}" +
"#axp-cone::after{content:'';position:absolute;left:1px;right:1px;bottom:0;height:3px;border-radius:1px;background:oklch(70% 0.19 55)}" +
// pinned profile apps. NB: these are <a> tags, so the host page's a:hover /
// a:visited rules would otherwise bleed in (red/purple text, underlines) — pin
// every link state explicitly to white + no underline.
"#axp-pins{display:flex;align-items:center;gap:3px;padding:0 3px}" +
".axp-pin,.axp-pin:link,.axp-pin:visited,.axp-pin:hover,.axp-pin:active{color:oklch(100% 0 0);text-decoration:none}" +
".axp-pin{display:flex;align-items:center;gap:6px;height:23px;padding:0 10px;cursor:pointer;font-family:inherit;font-size:11px;border-radius:2px;" +
"border:1px solid oklch(72% 0.12 254);border-bottom-color:oklch(42% 0.17 261);" +
"background:linear-gradient(180deg,oklch(70% 0.15 255) 0%,oklch(60% 0.17 257) 48%,oklch(54% 0.18 259) 52%,oklch(58% 0.17 257) 100%);" +
"box-shadow:inset 0 1px 0 oklch(82% 0.11 250)}" +
".axp-pin:hover{background:linear-gradient(180deg,oklch(76% 0.14 254) 0%,oklch(66% 0.17 256) 48%,oklch(60% 0.18 258) 52%,oklch(64% 0.16 256) 100%);border-color:oklch(84% 0.10 250)}" +
".axp-pin:active{background:linear-gradient(180deg,oklch(52% 0.18 260),oklch(60% 0.16 257));box-shadow:inset 1px 1px 2px oklch(36% 0.16 263);border-top-color:oklch(42% 0.17 261)}" +
".axp-pin b{width:9px;height:9px;border-radius:2px;flex:0 0 auto;box-shadow:inset 0 0 0 1px oklch(100% 0 0 / .5),0 1px 0 oklch(0% 0 0 / .25)}" +
"#axp-spacer{flex:1}" +
// tray + clock — flat, NOT a sunken box (the real XP clock is just text on the bar);
// the only chrome is an engraved vertical separator on the tray's left edge.
"#axp-tray{display:flex;align-items:center;padding:0 14px 0 13px;color:oklch(100% 0 0);" +
"font-size:11px;letter-spacing:.02em;border-left:1px solid oklch(40% 0.16 262);box-shadow:inset 1px 0 0 oklch(64% 0.15 254)}" +
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
// the canonical Luna caption CLOSE button (design system): 21x21 red "gel" lozenge,
// glossy gradient, CSS-drawn white X. matches .title-bar .controls .close site-wide.
"#axp-run .tb .x{position:relative;box-sizing:border-box;margin-left:auto;width:21px;height:21px;padding:0;overflow:hidden;font-size:0;color:transparent;cursor:pointer;border:1px solid #d8401c;border-radius:3px;background-color:#e45f3e;background-image:linear-gradient(180deg,#e8795f 0%,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110 100%);transition:filter .1s ease}" +
"#axp-run .tb .x:hover{border-color:#ff7a66;background-color:#ff957c;background-image:linear-gradient(180deg,#ff8b7d 0%,#ff7463 26%,#ff957c 55%,#fd7e64 82%,#d34936 100%);box-shadow:0 0 4px rgba(255,120,96,.7)}" +
"#axp-run .tb .x:active{filter:brightness(.9)}" +
"#axp-run .tb .x::before,#axp-run .tb .x::after{content:'';position:absolute;left:50%;top:50%;width:13px;height:2px;margin:-1px 0 0 -6.5px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}" +
"#axp-run .tb .x::before{transform:rotate(45deg)}#axp-run .tb .x::after{transform:rotate(-45deg)}" +
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
    var start = el('<button id="axp-start" type="button" aria-haspopup="dialog" aria-expanded="false" title="Run — navigate the site (⌘K)"><span id="axp-cone" aria-hidden="true"></span>start</button>');
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
    // clamp, don't wrap — XP's Run combobox (and Windows list controls) stop at
    // the ends rather than looping; wrapping reads as janky.
    sel = Math.max(0, Math.min(results.length - 1, sel + d));
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

  // ── desktop layer + dragging ─────────────────────────────────────────────────
  function buildDesktop() {
    if (D.getElementById("axp-desktop")) return;
    var d = D.createElement("div"); d.id = "axp-desktop"; d.setAttribute("aria-hidden", "true");
    D.body.insertBefore(d, D.body.firstChild);
  }
  // grab a title bar → pin the window to its current spot (fixed) and let it roam the
  // desktop. cosmetic + per-page (resets on navigation), like shoving a window around.
  // caption buttons + links are skipped so close/min/max keep working.
  function initDrag() {
    var win = null, sx = 0, sy = 0;
    // compositor-only: drag with transform (not left/top) so each pointermove is a
    // GPU transform, no layout/paint. re-based on every grab so it never accumulates.
    function move(e) { if (win) win.style.transform = "translate(" + (e.clientX - sx) + "px," + (e.clientY - sy) + "px)"; }
    function up() { if (win) { win.classList.remove("axp-dragging"); D.removeEventListener("pointermove", move); win = null; } }
    D.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;                       // let touch scroll the page, not drag
      if (e.pointerType === "mouse" && e.button !== 0) return;
      var b = e.target.closest && e.target.closest(".title-bar,.np-titlebar,.titlebar,#axp-run .tb");
      if (!b || e.target.closest("a,button,.controls,.np-controls,.x")) return;
      var w = b.closest(".window,.np-window,#axp-run");
      if (!w) return;
      // pin to its current spot (fixed) — rect already includes any prior drag offset,
      // so set left/top there and zero the transform → no jump, fresh relative drag.
      var r = w.getBoundingClientRect();
      w.style.position = "fixed"; w.style.margin = "0";
      w.style.left = r.left + "px"; w.style.top = r.top + "px"; w.style.width = r.width + "px"; w.style.maxWidth = "none";
      w.style.transform = "translate(0,0)";
      w.classList.add("axp-dragging");
      win = w; sx = e.clientX; sy = e.clientY;
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      D.addEventListener("pointermove", move);
      D.addEventListener("pointerup", up, { once: true });
      D.addEventListener("pointercancel", up, { once: true });
    });
  }

  // ensure page content clears the fixed 30px taskbar on EVERY page — raise the body's
  // bottom padding to a floor only where it's too low; never reduce a page that already
  // spaces itself generously (homepage 64, garage 60, writing 54, serendipity wrap 48).
  function clearForTaskbar() {
    try {
      var pb = parseFloat(getComputedStyle(D.body).paddingBottom) || 0;
      if (pb < 38) D.body.style.paddingBottom = "38px";
    } catch (e) {}
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  function boot() { injectCSS(); buildDesktop(); buildTaskbar(); initDrag(); clearForTaskbar(); }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
