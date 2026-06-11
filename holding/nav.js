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
    { label: "garage · masonry", path: "/garage/masonry", hint: "Grid Lanes masonry photo grid (with fixed-square fallback)" },
    { label: "garage · pretext", path: "/garage/pretext", hint: "DOM-free text measurement" },
    { label: "garage · safari 27", path: "/garage/safari27", hint: "WWDC26 Safari 27 features, through this site's lens" },
    { label: "garage · scroll", path: "/garage/scroll", hint: "XP scroll chrome" },
    { label: "garage · tooltips", path: "/garage/tooltips", hint: "tooltip experiments" }
  ];
  // `icon` (when present) keys the tile colour + glyph; `hint` doubles as a Run
  // search alias + tooltip, so "Photos"/"Music" still resolve to insta/spotify.
  var PROFILES = [
    { label: "Twitter", url: "https://twitter.com/oddhash" },
    { label: "Photos", icon: "Instagram", hint: "Instagram", url: "https://instagram.com/aadharsh.hif" },
    { label: "Curius", url: "https://curius.app/aadharsh-pannirselvam" },
    { label: "Beli", url: "https://beliapp.com/users/aadharsh" },
    { label: "Music", icon: "Spotify", hint: "Spotify", url: "https://open.spotify.com/user/aadharsh2010" }
  ];

  // desktop shortcuts — launchers that live on the wallpaper (not the taskbar).
  // Notepad is a "system folder"; profiles are internet shortcuts. (PROFILES
  // objects are shared by reference — they get .path/.kind tagged below.)
  // (My Pictures was removed: there's no Apache-style R2 bucket view to open.)
  var DESKTOP = [
    { label: "Notepad", path: "/writing", kind: "note", hint: "writing, in flux" }
  ].concat(PROFILES);

  // first-level subpages — the full-fledged "apps" pinned to the taskbar.
  var SUBPAGES = [
    { label: "garage", path: "/garage/", hint: "prototypes + experiments" },
    { label: "writing", path: "/writing", hint: "notes, in flux — an editable notepad" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "whoareyou", path: "/whoareyou", hint: "for agents + the curious" },
    { label: "music", path: "/rn", hint: "what I'm listening to right now" },
    { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" }
  ];

  // per-section icons — original CSS/SVG glyphs (colored tile + white pictogram,
  // so they read on the blue taskbar button AND a white browser tab). Used BOTH as
  // each first-level route's tab favicon (set by setFavicon below) and its taskbar
  // app-button icon — the favicons and the desktop shell finally share one language.
  var SECTION_ICONS = {
    garage: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#e8851f'/><g fill='#fff'><rect x='14' y='5' width='4' height='22' rx='1.5'/><rect x='5' y='14' width='22' height='4' rx='1.5'/><rect x='14' y='5' width='4' height='22' rx='1.5' transform='rotate(45 16 16)'/><rect x='14' y='5' width='4' height='22' rx='1.5' transform='rotate(-45 16 16)'/><circle cx='16' cy='16' r='6.5'/></g><circle cx='16' cy='16' r='2.8' fill='#e8851f'/></svg>",
    writing: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#2f6bd6'/><g fill='#fff'><rect x='8' y='8' width='16' height='2.6' rx='1.3'/><rect x='8' y='14.7' width='16' height='2.6' rx='1.3'/><rect x='8' y='21.4' width='10' height='2.6' rx='1.3'/></g></svg>",
    serendipity: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#7c4dd6'/><rect x='6' y='8' width='20' height='18' rx='2' fill='#fff'/><rect x='6' y='8' width='20' height='5' rx='2' fill='#dccff5'/><g fill='#7c4dd6'><rect x='9' y='16' width='3.4' height='3.4'/><rect x='14.3' y='16' width='3.4' height='3.4'/><rect x='19.6' y='16' width='3.4' height='3.4'/><rect x='9' y='21' width='3.4' height='3.4'/><rect x='14.3' y='21' width='3.4' height='3.4'/></g></svg>",
    around: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#1f9b8e'/><path d='M16 6 C11.6 6 8 9.3 8 13.6 C8 19 16 26 16 26 C16 26 24 19 24 13.6 C24 9.3 20.4 6 16 6 Z' fill='#fff'/><circle cx='16' cy='13.6' r='3.2' fill='#1f9b8e'/></svg>",
    whoareyou: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#4a5bd0'/><rect x='15' y='4' width='2' height='4' fill='#fff'/><circle cx='16' cy='4' r='2' fill='#fff'/><rect x='8' y='9' width='16' height='14' rx='3.5' fill='#fff'/><circle cx='12.5' cy='15' r='2.1' fill='#4a5bd0'/><circle cx='19.5' cy='15' r='2.1' fill='#4a5bd0'/><rect x='12' y='19' width='8' height='1.8' rx='0.9' fill='#4a5bd0'/></svg>",
    music: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#2faa55'/><g fill='#fff'><rect x='17' y='7' width='2.6' height='14'/><path d='M19.6 7 C23 8 25 10 24.4 13.6 C23 11 21 11 19.6 11.8 Z'/><ellipse cx='14' cy='21' rx='4.4' ry='3.5'/></g></svg>",
    coffee: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#7a5230'/><path d='M8 12 h13 v6 a6.5 6.5 0 0 1-13 0 Z' fill='#fff'/><path d='M21 13 h3 a2.6 2.6 0 0 1 0 5.2 h-3' fill='none' stroke='#fff' stroke-width='2.2'/><g stroke='#fff' stroke-width='1.8' stroke-linecap='round'><path d='M11 5.5 v3'/><path d='M14.5 5 v3.5'/></g></svg>"
  };
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
// app-shell: the taskbar is a HARD FLOOR. the body is the scroll container and ends at
// the taskbar's top (height = viewport − 30px taskbar), so page content scrolls within
// it and never flows under the bar. html doesn't scroll. dvh tracks the mobile URL bar;
// vh is the fallback. !important to beat each page's own min-height:100vh / overflow.
"html{height:100dvh;overflow:hidden}" +
// base: the desktop area is the viewport minus the taskbar (the hard floor).
// windowless pages (e.g. the raw directory index) keep normal scrolling here.
"body{min-height:0 !important;height:calc(100vh - 30px) !important;height:calc(100dvh - 30px) !important;overflow-x:hidden !important;overflow-y:auto !important;box-sizing:border-box}" +
// frontier typography, site-wide (headings with their own text-wrap:balance win):
// prettier paragraph ragging where supported, normal wrapping where not.
"body{text-wrap:pretty}" +
// OS-window model — only on pages that actually have a window. body becomes a
// flex column that centres the single window and CLIPS overflow, so the window
// is pinned: it never scrolls the page and can't slide under the taskbar. its
// inner region scrolls instead. (:has gates this; old browsers fall back to the
// scrolling body above. the fixed taskbar/desktop/icons/run sit outside this flow.)
"body:has(.window),body:has(.np-window),body:has(.wrap){overflow:hidden !important;display:flex !important;flex-direction:column !important;align-items:center !important;padding:8px !important}" +
// window frame: bounded to the desktop, sized to content but never taller than it.
".window,.np-window,.wrap{position:relative;z-index:2;flex:0 1 auto !important;min-height:0;max-height:100% !important;width:100%;margin:0 auto !important;box-sizing:border-box}" +
".window,.np-window{display:flex;flex-direction:column}" +
".window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:0 0 auto}" +
// the scrolling region inside the frame (Notepad's .np-text already scrolls)
".window>.content,.window>.body{flex:1 1 auto;min-height:0;overflow:auto}" +
".np-window .np-text{flex:1 1 auto;min-height:0}" +   // textarea fills the window (so resizing a note grows the editor, not empty space)
// serendipity nests its window in .wrap — make it a transparent flex pass-through
".wrap{display:flex;flex-direction:column;padding-bottom:0 !important}.wrap>.window{flex:0 1 auto;max-height:100%}" +
// strict windowing: HIDE the native scrollbar on the scroll regions — a custom
// XP scrollbar (mounted by JS) rides the window's right edge instead. (the Run
// list keeps a normal styled bar; it isn't a window.)
".window>.content,.window>.body,.np-text{scrollbar-width:none;-ms-overflow-style:none}" +
".window>.content::-webkit-scrollbar,.window>.body::-webkit-scrollbar,.np-text::-webkit-scrollbar{width:0;height:0;display:none}" +
"#axp-run .list{scrollbar-color:oklch(62% 0.14 255) oklch(90% 0.02 250)}" +
// reserve room on the right so content clears the custom bar (toggled when it shows)
".axp-sb-pad{padding-right:20px !important}" +
// the custom scrollbar widget: sunken track, raised thumb, raised arrow buttons
".axp-sb{position:absolute;width:16px;display:flex;flex-direction:column;z-index:3;user-select:none;touch-action:none}" +
".axp-sb-track{flex:1 1 auto;position:relative;background:oklch(92% 0.015 250);box-shadow:inset 1px 0 0 oklch(72% 0.03 250),inset -1px 0 0 oklch(100% 0 0)}" +
".axp-sb-thumb{position:absolute;left:1px;right:1px;top:0;min-height:18px;border:1px solid;border-color:oklch(88% 0.05 256) oklch(46% 0.15 260) oklch(46% 0.15 260) oklch(88% 0.05 256);background:linear-gradient(90deg,oklch(80% 0.08 256),oklch(63% 0.16 257));box-shadow:inset 1px 1px 0 oklch(92% 0.06 250)}" +
".axp-sb-thumb:hover{background:linear-gradient(90deg,oklch(84% 0.09 256),oklch(67% 0.17 257))}" +
".axp-sb-up,.axp-sb-down{flex:0 0 auto;height:16px;border:1px solid;border-color:oklch(100% 0 0) oklch(50% 0.04 260) oklch(50% 0.04 260) oklch(100% 0 0);background:linear-gradient(180deg,oklch(98% 0.01 255),oklch(86% 0.03 256));padding:0;cursor:pointer;position:relative}" +
".axp-sb-up:active,.axp-sb-down:active{border-color:oklch(50% 0.04 260) oklch(100% 0 0) oklch(100% 0 0) oklch(50% 0.04 260);background:linear-gradient(180deg,oklch(86% 0.03 256),oklch(94% 0.02 255))}" +
".axp-sb-up::before,.axp-sb-down::before{content:'';position:absolute;left:50%;top:50%;width:0;height:0;border:3px solid transparent}" +
".axp-sb-up::before{margin:-4px 0 0 -3px;border-bottom-color:oklch(28% 0.04 260)}" +
".axp-sb-down::before{margin:-1px 0 0 -3px;border-top-color:oklch(28% 0.04 260)}" +
// resize grip (bottom-right corner of every window)
".axp-resize{position:absolute;right:1px;bottom:1px;width:14px;height:14px;cursor:nwse-resize;z-index:4;background:linear-gradient(135deg,transparent 0 38%,oklch(72% 0.04 256) 38% 50%,transparent 50% 60%,oklch(72% 0.04 256) 60% 72%,transparent 72% 84%,oklch(72% 0.04 256) 84% 96%,transparent 96%)}" +
"#axp-desktop{position:fixed;inset:0;z-index:-1;transform:translateZ(0);view-transition-name:axp-desktop;background:url(\"" + blissUrl + "\") center center/cover no-repeat}" +
// windows drag by their title bar
".title-bar,.np-titlebar,.titlebar,#axp-run .tb{cursor:move}" +
".axp-dragging{user-select:none;will-change:transform}.axp-dragging .title-bar,.axp-dragging .np-titlebar,.axp-dragging .titlebar,#axp-run.axp-dragging .tb{cursor:grabbing}" +
// transition ONLY the window — freeze the desktop, taskbar AND root groups so the
// wallpaper + taskbar never cross-fade (that root cross-fade was the white flash).
".window,.np-window{view-transition-name:axp-window}" +
"::view-transition-group(root),::view-transition-group(axp-desktop),::view-transition-group(axp-taskbar),::view-transition-group(axp-icons){animation:none !important}" +
// map to XP's "animate windows when minimizing/maximizing": the outgoing window
// zooms DOWN toward the taskbar and the incoming one zooms UP out of it — scale
// origin biased below-centre (toward the bar at the bottom), fast + near-linear,
// minimize easing in, restore easing out. no modern in-place cross-zoom.
"::view-transition-group(axp-window){animation-duration:.2s;animation-timing-function:ease-out}" +
"::view-transition-old(axp-window){transform-origin:50% 130%;animation:axp-min .18s cubic-bezier(.4,0,1,1) both}" +
"::view-transition-new(axp-window){transform-origin:50% 130%;animation:axp-res .2s cubic-bezier(0,0,.2,1) both}" +
"@keyframes axp-min{to{opacity:0;transform:scale(.66)}}@keyframes axp-res{from{opacity:0;transform:scale(.66)}}" +
"@media (prefers-reduced-motion:reduce){::view-transition-old(axp-window),::view-transition-new(axp-window),::view-transition-group(axp-window){animation:none !important}}" +
"#axp-taskbar{position:fixed;left:0;right:0;bottom:0;height:30px;z-index:99999;view-transition-name:axp-taskbar;display:flex;align-items:stretch;" +
"font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:11px;user-select:none;" +
"background:linear-gradient(180deg,oklch(67% 0.15 256) 0%,oklch(58% 0.19 257) 4%,oklch(51% 0.20 258) 9%,oklch(49% 0.20 258) 50%,oklch(46% 0.20 259) 92%,oklch(40% 0.18 260) 100%);" +
"box-shadow:inset 0 1px 0 oklch(82% 0.09 250),inset 0 2px 0 oklch(62% 0.16 255)}" +
// start orb
"#axp-start{display:flex;align-items:center;gap:6px;padding:0 16px 2px 9px;border:0;cursor:pointer;color:oklch(100% 0 0);" +
"font-family:var(--font-caption,'Trebuchet MS',Verdana,Geneva,sans-serif);font-style:italic;font-weight:bold;font-size:14px;text-shadow:1px 1px 1px oklch(22% 0.07 145);" +
"border-radius:0 9px 9px 0/0 14px 14px 0;margin-right:6px;" +
"background:linear-gradient(180deg,oklch(72% 0.17 142) 0%,oklch(63% 0.18 143) 8%,oklch(54% 0.18 144) 46%,oklch(50% 0.18 145) 52%,oklch(58% 0.17 143) 92%,oklch(45% 0.16 146) 100%);" +
"box-shadow:inset 1px 1px 0 oklch(86% 0.13 140),inset -1px -1px 0 oklch(38% 0.13 147)}" +
"#axp-start:hover{filter:brightness(1.08)}#axp-start:active,#axp-start[aria-expanded=true]{filter:brightness(.92);box-shadow:inset 1px 1px 0 oklch(38% 0.13 147),inset -1px -1px 0 oklch(86% 0.13 140)}" +
// the site's traffic cone, drawn as CSS (the only mark the site uses) — orange
// triangle with two white bands + a base, matching the /favicon.ico cone.
"#axp-cone{flex:0 0 auto;width:15px;height:15px;position:relative;margin-right:1px;filter:drop-shadow(1px 1px 1px oklch(25% 0.05 30 / .5))}" +
"#axp-cone::before{content:'';position:absolute;left:0;right:0;top:0;bottom:2px;clip-path:polygon(50% 0,100% 100%,0 100%);background:linear-gradient(180deg,oklch(64% 0.22 38) 0 34%,oklch(97% 0.02 80) 34% 48%,oklch(64% 0.22 38) 48% 70%,oklch(97% 0.02 80) 70% 82%,oklch(64% 0.22 38) 82% 100%)}" +
"#axp-cone::after{content:'';position:absolute;left:1px;right:1px;bottom:0;height:3px;border-radius:1px;background:oklch(70% 0.19 55)}" +
// ── Desktop shortcuts ── icons on the wallpaper (top-left, XP-style). The
// philosophy: desktop = launchers (profiles + Pictures + Notepad), taskbar =
// runnable apps. They sit ABOVE content (z-index) but only show on wide screens
// where the centred window leaves a wallpaper gutter — so they don't overlap.
// Stylized CSS glyphs + brand colours, no image bytes, no trademark repros.
// full-desktop layer (pointer-events pass through to the window EXCEPT on icons),
// so icons can be dragged anywhere on the wallpaper. positions persist in
// localStorage; default layout is a left column.
"#axp-icons{position:fixed;inset:0;z-index:1;pointer-events:none;view-transition-name:axp-icons}" +
".axp-ico,.axp-ico:link,.axp-ico:visited,.axp-ico:hover,.axp-ico:active{color:oklch(100% 0 0);text-decoration:none}" +
".axp-ico{position:absolute;pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:4px;width:76px;padding:5px 3px 4px;box-sizing:border-box;border:1px solid transparent;border-radius:2px;cursor:pointer}" +
".axp-ico.axp-dragging{opacity:.8;z-index:7}" +
".axp-ico:hover{background:oklch(60% 0.20 263 / .26);border-color:oklch(74% 0.10 263 / .5)}" +
".axp-ico:focus-visible{outline:1px dotted oklch(100% 0 0);outline-offset:1px;background:oklch(60% 0.20 263 / .34)}" +
".axp-ico:active .ic{transform:translateY(1px)}" +
".axp-ico .ic{width:31px;height:31px;border-radius:3px;display:flex;align-items:center;justify-content:center;color:oklch(100% 0 0);font-weight:bold;font-size:18px;line-height:1;font-family:var(--font-caption,'Trebuchet MS',Verdana,Geneva,sans-serif);text-shadow:0 1px 1px oklch(0% 0 0 / .4);box-shadow:inset 0 1px 0 oklch(100% 0 0 / .5),inset 0 -2px 2px oklch(0% 0 0 / .22),0 1px 2px oklch(0% 0 0 / .5)}" +
// label: white text with the classic XP desktop drop shadow, up to two lines
".axp-ico .t{font-size:11px;line-height:1.18;text-align:center;color:oklch(100% 0 0);text-shadow:0 1px 2px oklch(18% 0.04 263),0 0 3px oklch(18% 0.04 263);max-width:82px;overflow-wrap:anywhere}" +
// My Pictures glyph: a tiny framed Bliss — sky, sun, rolling hill
// Notepad glyph: white ruled page with a folded corner
".axp-ico .note{background:linear-gradient(135deg,oklch(99% 0 0) 0 80%,oklch(82% 0.02 250) 80% 100%);position:relative}" +
".axp-ico .note::before{content:'';position:absolute;left:7px;right:7px;top:9px;height:1px;background:oklch(58% 0.13 250);box-shadow:0 4px 0 oklch(58% 0.13 250),0 8px 0 oklch(58% 0.13 250),0 12px 0 oklch(58% 0.13 250)}" +
".axp-ico .note::after{content:'';position:absolute;right:0;top:0;border-width:6px;border-style:solid;border-color:oklch(82% 0.02 250) oklch(99% 0 0) oklch(99% 0 0) oklch(82% 0.02 250)}" +
// generic camera glyph for the photo app (rounded body + lens + flash nub)
".axp-ico .cam{width:15px;height:11px;border:1.8px solid oklch(100% 0 0);border-radius:2px;position:relative;box-sizing:border-box}" +
".axp-ico .cam::before{content:'';position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border:1.8px solid oklch(100% 0 0);border-radius:50%;box-sizing:border-box}" +
".axp-ico .cam::after{content:'';position:absolute;right:0;top:-4px;width:4px;height:2px;background:oklch(100% 0 0);border-radius:1px}" +
// only show desktop icons when the centred window leaves a wallpaper gutter
"@media (max-width:1023px){#axp-icons{display:none}}" +
// app buttons (first-level subpages). NB: these are <a> tags, so the host page's
// a:hover / a:visited rules would otherwise bleed in (red/purple text,
// underlines) — pin every link state explicitly to white + no underline.
"#axp-pins{display:flex;align-items:center;gap:3px;padding:0 3px;min-width:0}" +
".axp-pin .lbl{overflow:hidden;text-overflow:ellipsis;max-width:92px}" +
".axp-pin,.axp-pin:link,.axp-pin:visited,.axp-pin:hover,.axp-pin:active{color:oklch(100% 0 0);text-decoration:none}" +
".axp-pin{display:flex;align-items:center;gap:6px;height:23px;padding:0 10px;cursor:pointer;font-family:inherit;font-size:11px;border-radius:2px;" +
"border:1px solid oklch(72% 0.12 254);border-bottom-color:oklch(42% 0.17 261);" +
"background:linear-gradient(180deg,oklch(70% 0.15 255) 0%,oklch(60% 0.17 257) 48%,oklch(54% 0.18 259) 52%,oklch(58% 0.17 257) 100%);" +
"box-shadow:inset 0 1px 0 oklch(82% 0.11 250)}" +
".axp-pin:hover{background:linear-gradient(180deg,oklch(76% 0.14 254) 0%,oklch(66% 0.17 256) 48%,oklch(60% 0.18 258) 52%,oklch(64% 0.16 256) 100%);border-color:oklch(84% 0.10 250)}" +
".axp-pin:active{background:linear-gradient(180deg,oklch(52% 0.18 260),oklch(60% 0.16 257));box-shadow:inset 1px 1px 2px oklch(36% 0.16 263);border-top-color:oklch(42% 0.17 261)}" +
".axp-pin .fav{width:15px;height:15px;flex:0 0 auto;display:flex;line-height:0;filter:drop-shadow(0 1px 1px oklch(0% 0 0 / .3))}.axp-pin .fav svg{width:100%;height:100%;display:block}" +
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
"border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;" +
"box-shadow:inset 1px 1px 0 #166aee,inset 2px 2px 0 #0855dd,inset -1px -1px 0 #00138c,inset -2px -2px 0 #003bda,4px 4px 0 rgba(0,30,160,.35),2px 3px 12px -2px oklch(30% 0.12 263 / .55)}" +
"#axp-run.open{display:block}" +
"#axp-run .tb{display:flex;align-items:center;gap:6px;padding:3px 4px 4px 7px;color:oklch(100% 0 0);" +
"font-family:var(--font-caption,'Trebuchet MS',Verdana,Geneva,sans-serif);font-weight:bold;font-size:12px;text-shadow:1px 1px oklch(28% 0.12 263);" +
"border-radius:3px 3px 0 0;border-bottom:1px solid oklch(41% 0.10 251);" +
"background:linear-gradient(180deg,oklch(70% 0.15 258) 0%,oklch(60% 0.20 261) 8%,oklch(51% 0.225 263) 18%,oklch(50% 0.225 263) 86%,oklch(58% 0.18 260) 100%)}" +
// the canonical Luna caption CLOSE button (design system): 21x21 red "gel" lozenge,
// glossy gradient, CSS-drawn white X. matches .title-bar .controls .close site-wide.
"#axp-run .tb .x{position:relative;box-sizing:border-box;margin-left:auto;width:21px;height:21px;padding:0;overflow:hidden;font-size:0;color:transparent;cursor:pointer;border:1px solid #d8401c;border-radius:3px;background-color:#e45f3e;background-image:linear-gradient(180deg,#e8795f 0%,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110 100%);transition:filter 60ms ease-out}" +
"#axp-run .tb .x:hover,#axp-run .tb .x:focus-visible{border-color:#ff7a66;background-color:#ff957c;background-image:linear-gradient(180deg,#ff8b7d 0%,#ff7463 26%,#ff957c 55%,#fd7e64 82%,#d34936 100%);box-shadow:0 0 4px rgba(255,120,96,.7);outline:none}" +
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
"#axp-run input{flex:1;font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:12px;padding:3px 5px;color:oklch(18% 0 0);background:oklch(100% 0 0);" +
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
  var run, input, list, backdrop, results = [], sel = -1, lastQuery = null;

  function el(html) { var t = D.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

  function buildTaskbar() {
    var bar = el('<div id="axp-taskbar" role="navigation" aria-label="taskbar"></div>');
    var start = el('<button id="axp-start" type="button" aria-haspopup="dialog" aria-expanded="false" title="Run — navigate the site (⌘K)"><span id="axp-cone" aria-hidden="true"></span>start</button>');
    start.addEventListener("click", function () { openRun(); });
    bar.appendChild(start);
    // app buttons — first-level subpages (internal nav → View-Transition windows).
    // profiles used to live here as Quick Launch; they're desktop shortcuts now —
    // the taskbar holds only runnable "apps".
    // (qlColor/qlGlyph are kept: the desktop profile icons reuse them.)
    var pins = el('<div id="axp-pins"></div>');
    SUBPAGES.forEach(function (s) {
      var b = el('<a class="axp-pin" title="' + s.hint + '"><span class="fav" aria-hidden="true">' + (SECTION_ICONS[s.label] || "") + '</span><span class="lbl">' + s.label + '</span></a>');
      b.href = s.path; pins.appendChild(b);
    });
    bar.appendChild(pins);
    bar.appendChild(el('<div id="axp-spacer"></div>'));
    var tray = el('<div id="axp-tray" aria-hidden="true"><span id="axp-clock"></span></div>');
    bar.appendChild(tray);
    D.body.appendChild(bar);
    tickClock();
    setInterval(tickClock, 15000);
  }


  // Quick Launch tile gradients — brand-evoking colours (Instagram gets the
  // retro tan→brown of its original skeuomorphic camera, not the modern ramp).
  function qlColor(name) {
    return {
      Twitter: "linear-gradient(180deg,oklch(78% 0.12 233),oklch(64% 0.16 240))",
      Instagram: "linear-gradient(180deg,oklch(74% 0.08 78),oklch(52% 0.10 52))",
      Curius: "linear-gradient(180deg,oklch(73% 0.15 145),oklch(60% 0.17 146))",
      Beli: "linear-gradient(180deg,oklch(81% 0.16 70),oklch(68% 0.18 55))",
      Spotify: "linear-gradient(180deg,oklch(75% 0.17 146),oklch(62% 0.19 147))"
    }[name] || "linear-gradient(180deg,oklch(72% 0.05 255),oklch(60% 0.07 257))";
  }

  // generic, non-trademark glyphs: a CSS camera for the photo app, @ for the
  // microblog, a music note for the player, lettermarks for the rest.
  function qlGlyph(name) {
    if (name === "Instagram") return '<i class="cam" aria-hidden="true"></i>';
    return { Twitter: "@", Spotify: "♪", Curius: "C", Beli: "B" }[name] || name.charAt(0);
  }

  // remembered desktop-icon positions (per label)
  function iconPos() { try { return JSON.parse(localStorage.getItem("axp-icons-pos") || "{}"); } catch (_) { return {}; } }
  function saveIconPos(p) { try { localStorage.setItem("axp-icons-pos", JSON.stringify(p)); } catch (_) {} }

  // build the desktop-shortcut layer on the wallpaper
  function buildIcons() {
    if (D.getElementById("axp-icons")) return;
    var wrap = el('<nav id="axp-icons" aria-label="desktop shortcuts"></nav>');
    var saved = iconPos();
    DESKTOP.forEach(function (it, i) {
      var ext = it.kind === "profile";
      var a = el('<a class="axp-ico"' + (ext ? ' target="_blank" rel="noopener me external"' : "") +
        ' title="' + esc(it.hint || it.label) + (ext ? " — opens in a new tab" : "") + '"></a>');
      a.href = it.path;
      a.dataset.key = it.label;
      var p = saved[it.label];
      a.style.left = (p ? p.x : 9) + "px";
      a.style.top = (p ? p.y : 9 + i * 86) + "px";
      var cls = it.kind === "note" ? "note" : "";
      var style = ext ? ' style="background:' + qlColor(it.icon || it.label) + '"' : "";
      var inner = ext ? qlGlyph(it.icon || it.label) : "";
      a.innerHTML = '<span class="ic ' + cls + '"' + style + " aria-hidden=\"true\">" + inner + "</span><span class=\"t\">" + esc(it.label) + "</span>";
      wrap.appendChild(a);
    });
    D.body.appendChild(wrap);
  }

  // drag desktop icons around the wallpaper (transform-free: left/top, persisted).
  // a movement threshold distinguishes a drag from a click so links still open.
  function initIconDrag() {
    var icons = D.getElementById("axp-icons"); if (!icons) return;
    var cur = null, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    function mv(e) {
      if (!cur) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true; cur.classList.add("axp-dragging");
      var nx = Math.max(0, Math.min(ox + dx, innerWidth - 76));
      var ny = Math.max(0, Math.min(oy + dy, innerHeight - 30 - 72));
      cur.style.left = nx + "px"; cur.style.top = ny + "px";
    }
    function up() {
      D.removeEventListener("pointermove", mv);
      if (cur && moved) {
        cur.classList.remove("axp-dragging");
        var p = iconPos(); p[cur.dataset.key] = { x: parseFloat(cur.style.left), y: parseFloat(cur.style.top) }; saveIconPos(p);
      }
      cur = null;
    }
    icons.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      var a = e.target.closest(".axp-ico"); if (!a) return;
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
    // XP list controls hot-track: the row under the cursor becomes the selection,
    // so OK / Enter act on whatever you're hovering (not a stale keyboard pick).
    list.addEventListener("mouseover", function (e) {
      var o = e.target.closest(".opt"); if (!o) return;
      var i = +o.dataset.i; if (i === sel) return;
      sel = i;
      [].forEach.call(list.querySelectorAll(".opt"), function (x) { x.setAttribute("aria-selected", +x.dataset.i === sel); });
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
    // preserve the selection across an async re-render (loadPhotos/loadWriting
    // resolve and re-render with the SAME query, growing the list) — otherwise a
    // keyboard-first user who arrow-selected a row would have it yanked back to
    // the top mid-aim. only reset to the top when the query actually changed (a
    // keystroke), where selecting the new best match IS correct.
    var keep = (q === lastQuery && sel >= 0 && results[sel]) ? results[sel] : null;
    results = items;
    if (keep) {
      sel = -1;
      for (var si = 0; si < items.length; si++) {
        if (items[si].kind === keep.kind && items[si].path === keep.path && items[si].label === keep.label) { sel = si; break; }
      }
      if (sel < 0) sel = items.length ? 0 : -1;
    } else {
      sel = items.length ? 0 : -1;
    }
    lastQuery = q;
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
  // grab a title bar → drag the window with TRANSFORM ONLY (no position change), so it
  // stays in normal flow and the page keeps scrolling. (the old version popped the
  // window to position:fixed, which collapsed a content page's flow and broke its
  // scroll.) base preserves any existing transform — e.g. the Run dialog's centering —
  // so it composes instead of jumping, which also makes the Run dialog draggable.
  // caption buttons + links are skipped so close/min/max keep working; touch scrolls.
  function initDrag() {
    var win = null, sx = 0, sy = 0, base = "", r = null;
    // clamp so the title bar can't leave the desktop: the TOP is a hard wall (you
    // can't retrieve a window dragged off the top — there's no menu up there), and
    // the bar can't slide under the taskbar or fully off the sides either.
    function move(e) {
      if (!win) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var vw = innerWidth, vh = innerHeight;
      dy = Math.max(8 - r.top, Math.min(dy, (vh - 30 - 24) - r.top));
      dx = Math.max((60 - r.width) - r.left, Math.min(dx, (vw - 60) - r.left));
      win.style.transform = base + "translate(" + dx + "px," + dy + "px)";
    }
    function up() { if (win) { win.classList.remove("axp-dragging"); D.removeEventListener("pointermove", move); win = null; } }
    D.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;                       // let touch scroll the page, not drag
      if (e.pointerType === "mouse" && e.button !== 0) return;
      var b = e.target.closest && e.target.closest(".title-bar,.np-titlebar,.titlebar,#axp-run .tb");
      if (!b || e.target.closest("a,button,.controls,.np-controls,.x")) return;
      var w = b.closest(".window,.np-window,#axp-run");
      if (!w) return;
      var t = getComputedStyle(w).transform;
      base = (t && t !== "none") ? t + " " : "";
      r = w.getBoundingClientRect();
      w.classList.add("axp-dragging");
      win = w; sx = e.clientX; sy = e.clientY;
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      D.addEventListener("pointermove", move);
      D.addEventListener("pointerup", up, { once: true });
      D.addEventListener("pointercancel", up, { once: true });
    });
  }

  // ── custom XP scrollbar on the window frame ───────────────────────────────────
  function mountScrollbar(frame, scroller) {
    if (frame.querySelector(":scope > .axp-sb")) return;
    if (getComputedStyle(frame).position === "static") frame.style.position = "relative";
    var sb = el('<div class="axp-sb" aria-hidden="true"><span class="axp-sb-up"></span><div class="axp-sb-track"><div class="axp-sb-thumb"></div></div><span class="axp-sb-down"></span></div>');
    frame.appendChild(sb);
    var track = sb.querySelector(".axp-sb-track"), thumb = sb.querySelector(".axp-sb-thumb");
    // inset the bar off the window's inner bevel (right + 1px top) and stop it
    // 15px above the bottom so it doesn't pile onto the bevel or the resize grip
    // in the bottom-right corner — like XP, where the corner is the sizing grip.
    function place() { sb.style.top = (scroller.offsetTop + 1) + "px"; sb.style.height = Math.max(0, scroller.offsetHeight - 16) + "px"; sb.style.right = "3px"; }
    function update() {
      var sh = scroller.scrollHeight, ch = scroller.clientHeight;
      if (sh - ch <= 1) { sb.style.display = "none"; scroller.classList.remove("axp-sb-pad"); return; }
      sb.style.display = "flex"; scroller.classList.add("axp-sb-pad");
      var th = track.clientHeight;
      var thumbH = Math.max(18, Math.round(th * ch / sh));
      var maxTop = th - thumbH;
      thumb.style.height = thumbH + "px";
      thumb.style.top = Math.round(maxTop * (scroller.scrollTop / (sh - ch))) + "px";
    }
    function refresh() { place(); update(); }
    scroller.addEventListener("scroll", update, { passive: true });
    thumb.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      var startY = e.clientY, startScroll = scroller.scrollTop;
      var sh = scroller.scrollHeight, ch = scroller.clientHeight;
      var maxTop = track.clientHeight - thumb.offsetHeight;
      function mv(ev) { var frac = maxTop > 0 ? (ev.clientY - startY) / maxTop : 0; scroller.scrollTop = startScroll + frac * (sh - ch); }
      function done() { D.removeEventListener("pointermove", mv); }
      try { thumb.setPointerCapture(e.pointerId); } catch (_) {}
      D.addEventListener("pointermove", mv); D.addEventListener("pointerup", done, { once: true });
    });
    sb.querySelector(".axp-sb-up").addEventListener("click", function (e) { e.stopPropagation(); scroller.scrollBy({ top: -48 }); });
    sb.querySelector(".axp-sb-down").addEventListener("click", function (e) { e.stopPropagation(); scroller.scrollBy({ top: 48 }); });
    track.addEventListener("pointerdown", function (e) {
      if (e.target !== track) return;
      var rel = e.clientY - track.getBoundingClientRect().top;
      var dir = rel < (thumb.offsetTop + thumb.offsetHeight / 2) ? -1 : 1;
      scroller.scrollBy({ top: dir * scroller.clientHeight * 0.9 });
    });
    if (window.ResizeObserver) { var ro = new ResizeObserver(refresh); ro.observe(scroller); ro.observe(frame); }
    window.addEventListener("resize", refresh);
    window.addEventListener("load", refresh);
    refresh();
  }
  function initScrollbars() {
    [].forEach.call(D.querySelectorAll(".window"), function (w) {
      var sc = w.querySelector(":scope > .content, :scope > .body");
      if (sc) mountScrollbar(w, sc);
    });
    [].forEach.call(D.querySelectorAll(".np-window"), function (w) {
      var sc = w.querySelector(".np-text");
      if (sc) mountScrollbar(w, sc);
    });
  }

  // ── resizable windows (bottom-right grip) ─────────────────────────────────────
  function initResize() {
    [].forEach.call(D.querySelectorAll(".window,.np-window"), function (f) {
      if (f.classList.contains("np-folder")) return;   // folder hugs its content — not resizable
      if (f.querySelector(":scope > .axp-resize")) return;
      if (getComputedStyle(f).position === "static") f.style.position = "relative";
      var g = el('<div class="axp-resize" aria-hidden="true"></div>');
      f.appendChild(g);
      g.addEventListener("pointerdown", function (e) {
        e.preventDefault(); e.stopPropagation();
        var sx = e.clientX, sy = e.clientY, rc = f.getBoundingClientRect(), w0 = rc.width, h0 = rc.height;
        f.classList.add("axp-dragging");
        function mv(ev) {
          var nw = Math.max(260, Math.min(w0 + (ev.clientX - sx), innerWidth - 16));
          var nh = Math.max(140, Math.min(h0 + (ev.clientY - sy), innerHeight - 30 - 16));
          f.style.width = nw + "px"; f.style.maxWidth = "none"; f.style.height = nh + "px";
        }
        function done() { D.removeEventListener("pointermove", mv); f.classList.remove("axp-dragging"); }
        try { g.setPointerCapture(e.pointerId); } catch (_) {}
        D.addEventListener("pointermove", mv); D.addEventListener("pointerup", done, { once: true });
      });
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  // set the tab favicon to the current first-level section's icon, so the favicon
  // matches its taskbar button. exact-match only — /garage/<sub> + /writing/<slug>
  // + home keep their own page favicons (e.g. each garage demo's distinct icon).
  function setFavicon() {
    var np = location.pathname.replace(/\/+$/, "") || "/";
    var sec = SUBPAGES.filter(function (s) { return (s.path.replace(/\/+$/, "") || "/") === np; })[0];
    if (!sec || !SECTION_ICONS[sec.label]) return;
    var link = D.querySelector('link[rel~="icon"]');
    if (!link) { link = D.createElement("link"); link.rel = "icon"; (D.head || D.documentElement).appendChild(link); }
    link.type = "image/svg+xml";
    link.href = "data:image/svg+xml," + encodeURIComponent(SECTION_ICONS[sec.label]);
  }

  // shell-wide Speculation Rules: prerender the shell's safe destinations on
  // hover-intent (eagerness "moderate"), so opening a "window" (garage, writing,
  // serendipity…) is near-instant and the View Transition plays on already-loaded
  // content. excludes the homepage (counter), /around (live crawl), /whoareyou
  // (transient), /rn (redirect), /coffee (transactional), images + raw text.
  // unsupported browsers ignore the script → plain navigation. skips the homepage,
  // which ships its own inline ruleset earlier in the HTML.
  function injectSpeculation() {
    if (D.querySelector('script[type="speculationrules"]')) return;
    if (typeof HTMLScriptElement === "undefined" || !HTMLScriptElement.supports || !HTMLScriptElement.supports("speculationrules")) return;
    var s = D.createElement("script");
    s.type = "speculationrules";
    s.textContent = JSON.stringify({
      prerender: [{
        where: { and: [
          { href_matches: "/*" },
          { not: { href_matches: "/" } },
          { not: { href_matches: "/around*" } },
          { not: { href_matches: "/whoareyou*" } },
          { not: { href_matches: "/rn*" } },
          { not: { href_matches: "/coffee*" } },
          { not: { href_matches: "/images*" } },
          { not: { href_matches: "/index.md" } },
          { not: { href_matches: "/llms.txt" } }
        ] },
        eagerness: "moderate"
      }]
    });
    D.body.appendChild(s);
  }

  function boot() { injectCSS(); buildDesktop(); buildIcons(); buildTaskbar(); initDrag(); initIconDrag(); initScrollbars(); initResize(); setFavicon(); injectSpeculation(); }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
