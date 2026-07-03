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
  // platform-aware shortcut label shown on the Start orb + Run dialog. The
  // keydown handler binds BOTH ⌘K and Ctrl-K; this is only what we DISPLAY, so
  // Mac users see ⌘K and everyone else sees Ctrl K.
  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "");
  var KBD = IS_MAC ? "⌘K" : "Ctrl K";

  // DIRECTIONAL view transitions — tag each cross-document navigation as an "open"
  // (forward / push) or a "close" (back), so the window VT animates the right way
  // (see the :active-view-transition-type rules in injectCSS). Strictly additive:
  // needs the Navigation API + cross-doc view-transition-types; otherwise the
  // symmetric default animation plays. Registered NOW (not in boot's DOMContentLoaded
  // callback) so the pagereveal listener is in place before the incoming page reveals.
  function axpVTDir(act) {
    try {
      if (act && act.navigationType === "traverse" && act.from && act.entry && act.from.index > act.entry.index) return "axp-close";
    } catch (e) {}
    return "axp-open";
  }
  if (window.navigation && "onpagereveal" in window) {
    addEventListener("pageswap", function (e) {
      if (e.viewTransition && e.activation) { try { e.viewTransition.types.add(axpVTDir(e.activation)); } catch (x) {} }
    });
    addEventListener("pagereveal", function (e) {
      if (e.viewTransition && navigation.activation) { try { e.viewTransition.types.add(axpVTDir(navigation.activation)); } catch (x) {} }
    });
  }

  // ── destinations ──────────────────────────────────────────────────────────
  var PAGES = [
    { label: "Home", path: "/", hint: "aadhar.sh" },
    { label: "photos", path: "/photos", hint: "every photo, Explorer Thumbnails view — the archive the old /images/ listing became" },
    { label: "whoareyou", path: "/whoareyou", hint: "system properties · what one request reveals · for agents + the curious" },
    { label: "security center", path: "/security", hint: "the site's security posture, XP-style: firewall, updates, threat protection" },
    { label: "windows update", path: "/updates", hint: "what shipped lately: the service-worker changelog as installed updates" },
    { label: "system restore", path: "/restore", hint: "scrub the site back through its real deploy history, backed by Cloudflare D1" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "garage", path: "/garage/", hint: "prototypes + experiments" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "music", path: "/rn", hint: "what I'm listening to right now" },
    { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" },
    { label: "writing", path: "/writing", hint: "notes, in flux — an editable notepad" },
    { label: "reading", path: "/reading", hint: "what I've been reading — saved to Curius, mirrored here" },
    { label: "lens", path: "/lens", hint: "the other web: see any URL the way a machine does — raw HTML, JSON-LD, llms.txt" },
    { label: "learning with errors", path: "/lwe/", hint: "chat-style explainers + live demos" },
    // generated:lwe-pages:start
    { label: "lwe · fhe", path: "/lwe/fhe", hint: "fully homomorphic encryption, explained" },
    { label: "lwe · mpc", path: "/lwe/mpc", hint: "multi-party computation, honest majority and traitors" },
    { label: "lwe · tee", path: "/lwe/tee", hint: "trusted execution environments and side-channels" },
    { label: "lwe · utf-8", path: "/lwe/utf8", hint: "text encoding, ascii, utf-32, utf-8, live byte demos" },
    { label: "lwe · vigenère", path: "/lwe/vigenere", hint: "the Vigenère cipher and Kryptos: keystream workbench, cipher stats" },
    { label: "lwe · encoding", path: "/lwe/encoding", hint: "image encoding: avif, jpeg, jpegli, bytes-per-pixel" },
    { label: "lwe · programmable crypto", path: "/lwe/pcrypto", hint: "programmable cryptography: zk, mpc, fhe as one toolkit" },
    { label: "lwe · dac", path: "/lwe/dac", hint: "digital-to-analog: multibit R-2R vs delta-sigma noise shaping" },
    { label: "lwe · drivers", path: "/lwe/drivers", hint: "headphone drivers: planar magnetic vs dynamic, force and breakup" },
    { label: "lwe · knots", path: "/lwe/knots", hint: "knots: granny vs square, the Ian knot, why laces come undone" },
// generated:lwe-pages:end
    { label: "garage · chunks", path: "/garage/chunks", hint: "content-addressed chunking" },
    { label: "garage · cloudflare", path: "/garage/cloudflare", hint: "free Cloudflare features" },
    { label: "garage · encoding", path: "/garage/encoding", hint: "thumbnail encoding study" },
    { label: "garage · horizon", path: "/garage/horizon", hint: "web-platform horizon" },
    { label: "garage · masonry", path: "/garage/masonry", hint: "Grid Lanes masonry photo grid (with fixed-square fallback)" },
    { label: "garage · pretext", path: "/garage/pretext", hint: "DOM-free text measurement" },
    { label: "garage · safari 27", path: "/garage/safari27", hint: "WWDC26 Safari 27 features, through this site's lens" },
    { label: "garage · scroll", path: "/garage/scroll", hint: "XP scroll chrome" },
    { label: "garage · tooltips", path: "/garage/tooltips", hint: "tooltip experiments" },
    // Raycast deep-link easter eggs — fire built-in Raycast commands (every Raycast
    // user has these). kind "raycast" → location.href to the protocol URL: the OS
    // hands it to Raycast and the page stays put. Without Raycast it's a harmless
    // no-op / "open Raycast?" prompt, so they're explicitly labeled. Naturally
    // excluded from the prerender ruleset (the href isn't a "/*" path).
    { label: "confetti 🎉", path: "raycast://extensions/raycast/raycast/confetti", hint: "fire Raycast confetti — needs Raycast installed", kind: "raycast" },
    { label: "toggle bounce", path: "raycast://extensions/raycast/raycast/toggle-bounce-animation", hint: "toggle Raycast's window bounce — needs Raycast", kind: "raycast" }
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
    { label: "lwe", path: "/lwe/", hint: "chat-style explainers + live demos" },
    { label: "writing", path: "/writing", hint: "notes, in flux: an editable notepad" },
    { label: "reading", path: "/reading", hint: "what I've been reading, from Curius" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "lens", path: "/lens", hint: "the other web: how machines read a URL" },
    { label: "music", path: "/rn", hint: "what I'm listening to right now" },
    { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" }
  ];

  // per-section icons — original CSS/SVG glyphs (colored tile + white pictogram,
  // so they read on the blue taskbar button AND a white browser tab). Used BOTH as
  // each first-level route's tab favicon (set by setFavicon below) and its taskbar
  // app-button icon — the favicons and the desktop shell finally share one language.
  // Glossy Luna app-tile chrome shared by every SECTION icon. `p` is a per-route id
  // prefix (so gradient/filter ids never collide when several render on one page);
  // `c` is [light, mid, dark, outline]; `art` is the white pictogram. The face is a
  // top->bottom 3-stop gradient with a white inner rim, a curved top gloss sweep, and
  // a soft drop shadow; the pictogram gets a faint dark drop-shadow so it sits on the
  // gloss like real XP art. ONE tile drives both the taskbar app-button AND the
  // route's browser-tab favicon (setFavicon encodeURIComponent's it), so the shell
  // and the favicons speak one language. Original recreations in the Luna spirit,
  // drawn from scratch — never Microsoft's actual icon assets.
  function sectionTile(p, c, art) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>'
      + '<linearGradient id="' + p + 'F" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c[0] + '"/><stop offset=".5" stop-color="' + c[1] + '"/><stop offset="1" stop-color="' + c[2] + '"/></linearGradient>'
      + '<linearGradient id="' + p + 'G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      + '<filter id="' + p + 'S" x="-20%" y="-15%" width="140%" height="145%"><feDropShadow dx="0" dy=".6" stdDeviation=".7" flood-color="#000" flood-opacity=".32"/></filter>'
      + '</defs><g filter="url(#' + p + 'S)">'
      + '<rect x="1" y="1" width="30" height="30" rx="7" fill="url(#' + p + 'F)" stroke="' + c[3] + '" stroke-width="1"/>'
      + '<rect x="2.3" y="2.3" width="27.4" height="27.4" rx="5.8" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1"/>'
      + '<path d="M3 9 Q3 3 9 3 H23 Q29 3 29 9 V12.5 Q16 18 3 12.5 Z" fill="url(#' + p + 'G)"/>'
      + '<g style="filter:drop-shadow(0 .5px .4px rgba(0,0,0,.35))">' + art + '</g>'
      + '</g></svg>';
  }
  var SECTION_ICONS = {
    garage:      sectionTile("garage", ["#ffb45a","#ef8f24","#c2660a","#8f4d06"], '<g fill="#fff"><rect x="14" y="5" width="4" height="22" rx="1.5"/><rect x="5" y="14" width="22" height="4" rx="1.5"/><rect x="14" y="5" width="4" height="22" rx="1.5" transform="rotate(45 16 16)"/><rect x="14" y="5" width="4" height="22" rx="1.5" transform="rotate(-45 16 16)"/><circle cx="16" cy="16" r="6.5"/></g><circle cx="16" cy="16" r="2.8" fill="#ef8f24"/>'),
    writing:     sectionTile("writing", ["#6fa0ee","#2f6bd6","#1a4ba8","#143c86"], '<g fill="#fff"><rect x="8" y="8" width="16" height="2.6" rx="1.3"/><rect x="8" y="14.7" width="16" height="2.6" rx="1.3"/><rect x="8" y="21.4" width="10" height="2.6" rx="1.3"/></g>'),
    reading:     sectionTile("reading", ["#de8186","#c1545a","#93333a","#732830"], '<g fill="#fff"><path d="M16 9 C13 7.2 9 7 6 7.6 V24 C9 23.4 13 23.6 16 25 Z"/><path d="M16 9 C19 7.2 23 7 26 7.6 V24 C23 23.4 19 23.6 16 25 Z" opacity=".82"/></g><path d="M16 9 V25" stroke="#c1545a" stroke-width="1.4"/>'),
    serendipity: sectionTile("serendipity", ["#a886e8","#7c4dd6","#5a32a8","#482788"], '<rect x="6" y="8" width="20" height="18" rx="2" fill="#fff"/><rect x="6" y="8" width="20" height="5" rx="2" fill="#e7e7ef"/><g fill="#7c4dd6"><rect x="9" y="16" width="3.4" height="3.4"/><rect x="14.3" y="16" width="3.4" height="3.4"/><rect x="19.6" y="16" width="3.4" height="3.4"/><rect x="9" y="21" width="3.4" height="3.4"/><rect x="14.3" y="21" width="3.4" height="3.4"/></g>'),
    around:      sectionTile("around", ["#5cc6ba","#1f9b8e","#137468","#0d5a50"], '<path d="M16 6 C11.6 6 8 9.3 8 13.6 C8 19 16 26 16 26 C16 26 24 19 24 13.6 C24 9.3 20.4 6 16 6 Z" fill="#fff"/><circle cx="16" cy="13.6" r="3.2" fill="#1f9b8e"/>'),
    whoareyou:   sectionTile("whoareyou", ["#8190e6","#4a5bd0","#3140a4","#263286"], '<rect x="15" y="4" width="2" height="4" fill="#fff"/><circle cx="16" cy="4" r="2" fill="#fff"/><rect x="8" y="9" width="16" height="14" rx="3.5" fill="#fff"/><circle cx="12.5" cy="15" r="2.1" fill="#4a5bd0"/><circle cx="19.5" cy="15" r="2.1" fill="#4a5bd0"/><rect x="12" y="19" width="8" height="1.8" rx="0.9" fill="#4a5bd0"/>'),
    music:       sectionTile("music", ["#6fcd8a","#2faa55","#1d8040","#156030"], '<g fill="#fff"><rect x="17" y="7" width="2.6" height="14"/><path d="M19.6 7 C23 8 25 10 24.4 13.6 C23 11 21 11 19.6 11.8 Z"/><ellipse cx="14" cy="21" rx="4.4" ry="3.5"/></g>'),
    coffee:      sectionTile("coffee", ["#b08858","#875c34","#5e3c1e","#472d16"], '<path d="M8 12 h13 v6 a6.5 6.5 0 0 1-13 0 Z" fill="#fff"/><path d="M21 13 h3 a2.6 2.6 0 0 1 0 5.2 h-3" fill="none" stroke="#fff" stroke-width="2.2"/><g stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M11 5.5 v3"/><path d="M14.5 5 v3.5"/></g>'),
    lwe:         sectionTile("lwe", ["#838ae6","#4b53c9","#333aa0","#272d82"], '<path d="M6 9 h20 a2 2 0 0 1 2 2 v9 a2 2 0 0 1-2 2 H14 l-5 4 v-4 H6 a2 2 0 0 1-2-2 v-9 a2 2 0 0 1 2-2 Z" fill="#fff"/><g stroke="#4b53c9" stroke-width="1.7" stroke-linecap="round" fill="none"><path d="M8.5 13.5 q2 -2.4 4 0 t4 0 t4 0"/><path d="M8.5 18 q2 -2.4 4 0 t4 0"/></g>'),
    lens:        sectionTile("lens", ["#79c7e6","#2f9fc4","#1d7895","#145d73"], '<rect x="5.5" y="5" width="15" height="19" rx="2" fill="#fff"/><g fill="#2f9fc4"><rect x="8.5" y="9.5" width="9" height="1.7" rx="0.6"/><rect x="8.5" y="13" width="9" height="1.7" rx="0.6"/><rect x="8.5" y="16.5" width="6" height="1.7" rx="0.6"/></g><circle cx="20.5" cy="20.5" r="6" fill="#2f9fc4" stroke="#fff" stroke-width="2.2"/><circle cx="18.6" cy="18.6" r="1.5" fill="#fff" opacity=".85"/><path d="M24.8 24.8 L28.5 28.5" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>')
  };
  var PHOTOS = null;          // lazy: [{ label, path, hint, kind:'photo' }]
  var WRITING = null;         // lazy: [{ label, path, hint, kind:'writing' }]
  var photosPromise = null, writingPromise = null;

  function tag(kind, o) { o.kind = kind; return o; }
  PAGES.forEach(function (p) { if (!p.kind) tag("page", p); });   // preserve a pre-set kind (e.g. "raycast")
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
// site-wide typography: modern line-breaking. text-wrap is inherited, so this one
// rule on <html> turns on "pretty" (fewer orphans + less ragged last lines) for
// every page nav.js loads on. progressive — browsers without it just wrap normally,
// at no layout cost. the homepage + shared worker chrome also set it inline so the
// flagship surfaces don't wait for this deferred script.
"html{text-wrap:pretty}" +
// View Transitions: animate window open/close across real navigations while the
// desktop + taskbar stay put (named = persistent). progressive — a no-op where the
// browser doesn't support it (Firefox just navigates instantly).
"@view-transition{navigation:auto}" +
// the shared Bliss desktop on a fixed layer behind everything; page BODIES forced
// transparent so it shows through. html keeps a sky→hills gradient (the same one
// pages paint at first load) as the backstop — NOT transparent: during a cross-doc
// view transition the #axp-desktop snapshot momentarily repaints, and a transparent
// html exposes the browser's white canvas behind it (a white flash). The gradient
// makes that gap read as sky, not white; the opaque Bliss layer covers it otherwise.
"html{background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%) !important}body{background:transparent !important}" +
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
/* 24px (not 20) so content children clear the scrollbar with a ~5px gutter:
   the bar is 16px + right:3px, so padding must exceed 19 or a full-width panel
   border (the now-playing list, the photo grid) kisses the scrollbar's edge. */
".axp-sb-pad{padding-right:28px !important}" +
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
// accessory windows — small built-in apps (a Clock for now) that float over the
// desktop, composite, drag, and click-to-front. plain DOM windows, no iframes.
".axp-acc{position:fixed;z-index:40;min-width:170px;background:oklch(99% 0.005 95);border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-top-left-radius:7px;border-top-right-radius:7px;box-shadow:inset 1px 1px 0 #166aee,inset -1px -1px 0 #00138c,3px 4px 9px rgba(0,20,90,.4);display:flex;flex-direction:column;overflow:hidden;touch-action:none}" +
".axp-acc>.tb{display:flex;align-items:center;gap:5px;padding:3px 4px 3px 7px;cursor:move;color:#fff;font-family:var(--font-caption);font-weight:bold;font-size:10pt;text-shadow:1px 1px #0f1089;background:linear-gradient(180deg,oklch(70% 0.15 258),oklch(51% 0.225 263) 60%,oklch(58% 0.18 260))}" +
".axp-acc>.tb .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
".axp-acc>.tb .x{width:18px;height:16px;flex:0 0 18px;display:grid;place-items:center;border:1px solid #d8401c;border-radius:3px;background:linear-gradient(180deg,#e8795f,#ae3110);font-size:9px;cursor:pointer}.axp-acc>.tb .x:hover{filter:brightness(1.12)}" +
".axp-acc>.bd{padding:8px;background:#ece9d8}" +
".clk{text-align:center;padding:5px 12px}.clk-t{font-family:var(--font-mono);font-size:22pt;font-weight:bold;color:#15243f;letter-spacing:1px}.clk-d{font-size:8.5pt;color:#4a5568;margin-top:3px;white-space:nowrap}" +
// windows drag by their title bar
".title-bar,.np-titlebar,.titlebar,#axp-run .tb{cursor:move}" +
".axp-dragging{user-select:none;will-change:transform}.axp-dragging .title-bar,.axp-dragging .np-titlebar,.axp-dragging .titlebar,#axp-run.axp-dragging .tb{cursor:grabbing}" +
// transition ONLY the window — freeze the desktop, taskbar AND root groups so the
// wallpaper + taskbar never cross-fade (that root cross-fade was the white flash).
".window,.np-window{view-transition-name:axp-window}" +
"::view-transition-group(root),::view-transition-group(axp-desktop),::view-transition-group(axp-taskbar),::view-transition-group(axp-icons){animation:none !important}" +
// HOLD the persistent shell layers through the transition. Freezing only the GROUP
// (above) stops them moving but the UA still cross-fades their old↔new images — and
// the INCOMING page hasn't run nav.js yet, so it has no desktop/taskbar/icons snapshot
// to fade INTO → the Bliss layer fades to nothing for a beat (the white flash). Pinning
// the old/new images to animation:none keeps the old Bliss fully opaque the whole time;
// since the shell is identical across pages, the live new shell takes over seamlessly.
"::view-transition-old(axp-desktop),::view-transition-new(axp-desktop),::view-transition-old(axp-taskbar),::view-transition-new(axp-taskbar),::view-transition-old(axp-icons),::view-transition-new(axp-icons){animation:none !important;mix-blend-mode:normal}" +
// map to XP's "animate windows when minimizing/maximizing": the outgoing window
// zooms DOWN toward the taskbar and the incoming one zooms UP out of it — scale
// origin biased below-centre (toward the bar at the bottom), fast + near-linear,
// minimize easing in, restore easing out. no modern in-place cross-zoom.
"::view-transition-group(axp-window){animation-duration:.2s;animation-timing-function:ease-out}" +
"::view-transition-old(axp-window){transform-origin:50% 130%;animation:axp-min .18s cubic-bezier(.4,0,1,1) both}" +
"::view-transition-new(axp-window){transform-origin:50% 130%;animation:axp-res .2s cubic-bezier(0,0,.2,1) both}" +
"@keyframes axp-min{to{opacity:0;transform:scale(.66)}}@keyframes axp-res{from{opacity:0;transform:scale(.66)}}" +
// DIRECTIONAL refinement (Chromium view-transition-types). initVTTypes() tags each
// cross-doc nav "axp-open" (forward/push) or "axp-close" (back). OPEN emphasises the
// NEW window zooming up out of the taskbar while the old just fades; CLOSE emphasises
// the OLD window minimising toward the taskbar while the new fades in. These are more
// specific than the bare rules above, so a typed nav wins; with no type (unsupported,
// or a reload) the symmetric default plays. reduce-motion below still neutralises all.
":root:active-view-transition-type(axp-open)::view-transition-old(axp-window){transform-origin:50% 50%;animation:axp-vt-out .12s ease-out both}" +
":root:active-view-transition-type(axp-open)::view-transition-new(axp-window){transform-origin:50% 120%;animation:axp-open-in .2s cubic-bezier(0,0,.2,1) both}" +
":root:active-view-transition-type(axp-close)::view-transition-old(axp-window){transform-origin:50% 120%;animation:axp-min .18s cubic-bezier(.4,0,1,1) both}" +
":root:active-view-transition-type(axp-close)::view-transition-new(axp-window){transform-origin:50% 50%;animation:axp-vt-in .16s ease-out both}" +
"@keyframes axp-open-in{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}@keyframes axp-vt-out{to{opacity:0}}@keyframes axp-vt-in{from{opacity:0}to{opacity:1}}" +
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
// the ⌘K / Ctrl-K keycap badge — a small inset "key" reading on both the green
// Start orb and the blue Run title bar (translucent white on either ground).
".axp-kbd{display:inline-flex;align-items:center;font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-style:normal;font-weight:bold;font-size:9px;line-height:1;letter-spacing:.02em;padding:2px 4px;border-radius:3px;color:oklch(100% 0 0);background:oklch(100% 0 0 / .18);border:1px solid oklch(100% 0 0 / .5);box-shadow:inset 0 1px 0 oklch(100% 0 0 / .35);text-shadow:none;white-space:nowrap}" +
"#axp-run .tb .axp-kbd{margin-left:6px}" +
// on the Start orb the boxed chip clashes with the italic 'start' logotype — strip the
// tile (no border/fill/shadow) down to a quiet translucent hint set off by a thin rule.
"#axp-start .axp-kbd{background:none;border:0;box-shadow:none;border-radius:0;padding:0 0 0 6px;margin-left:5px;border-left:1px solid oklch(100% 0 0 / .4);opacity:.8;font-weight:normal;font-size:9.5px;letter-spacing:.04em}" +
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
// notification-area icons: System Properties, Security Center, Windows Update.
// where the little XP "system" tray bits actually lived, right of the engraved
// separator. shared class so the three line up identically.
".axp-trayico{display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:8px;border-radius:3px;text-decoration:none;opacity:.85;cursor:pointer}" +
".axp-trayico:hover{background:oklch(64% 0.15 254);opacity:1}" +
".axp-trayico svg{width:15px;height:15px;display:block;filter:drop-shadow(0 1px 1px oklch(0% 0 0 / .3))}" +
// mute/unmute speaker, sits just left of System Properties; matches its tray styling
"#axp-sound{display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:7px;padding:0;border:0;background:transparent;border-radius:3px;cursor:pointer;opacity:.88}" +
"#axp-sound:hover{background:oklch(64% 0.15 254);opacity:1}" +
"#axp-sound.muted{opacity:.5}" +
"#axp-sound svg{width:15px;height:15px;display:block;filter:drop-shadow(0 1px 1px oklch(0% 0 0 / .3))}" +
// ── XP balloon-tip popout for tray icons: brief status + a tail to the icon ──
// pale-yellow notification bubble (the classic XP balloon), one at a time, opens
// above whichever tray icon was clicked. --tail is the px offset of the down-tail
// from the balloon's left edge, set in JS so it points at that icon.
"#axp-balloon{position:fixed;right:6px;bottom:38px;z-index:100000;width:min(300px,calc(100vw - 16px));display:none;" +
"font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:11px;color:oklch(28% 0.02 90);" +
"background:oklch(98.5% 0.035 95);border:1px solid oklch(72% 0.06 86);border-radius:4px;" +
"box-shadow:2px 3px 11px -3px oklch(40% 0.05 90 / .55)}" +
"#axp-balloon.open{display:block}" +
"@media (prefers-reduced-motion:no-preference){#axp-balloon.open{animation:axp-bln .12s ease-out}}" +
"@keyframes axp-bln{from{transform:translateY(7px);opacity:.3}to{transform:translateY(0);opacity:1}}" +
"#axp-balloon::before,#axp-balloon::after{content:'';position:absolute;top:100%;left:var(--tail,84%);width:0;height:0;border:9px solid transparent;border-bottom:0;margin-left:-9px}" +
"#axp-balloon::before{border-top-color:oklch(72% 0.06 86)}" +
"#axp-balloon::after{border-top-color:oklch(98.5% 0.035 95);margin-top:-1.5px}" +
"#axp-balloon .tb{display:flex;align-items:flex-start;gap:7px;padding:8px 8px 3px 9px}" +
"#axp-balloon .ic{flex:0 0 16px;width:16px;height:16px;margin-top:1px}#axp-balloon .ic svg{width:16px;height:16px;display:block}" +
"#axp-balloon .t{flex:1;font-weight:bold;font-size:11px;line-height:1.3;padding-top:1px;color:oklch(24% 0.02 90)}" +
"#axp-balloon .x{flex:0 0 auto;position:relative;width:14px;height:14px;padding:0;margin:0;border:1px solid oklch(72% 0.04 88);border-radius:2px;background:oklch(95% 0.02 90);cursor:pointer;font-size:0;color:transparent}" +
"#axp-balloon .x:hover{background:oklch(86% 0.07 55)}" +
"#axp-balloon .x::before,#axp-balloon .x::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:1.5px;margin:-.75px 0 0 -4px;background:oklch(35% 0.02 90)}" +
"#axp-balloon .x::before{transform:rotate(45deg)}#axp-balloon .x::after{transform:rotate(-45deg)}" +
"#axp-balloon .bd{padding:0 12px 4px 32px}" +
"#axp-balloon .ln{margin:3px 0;line-height:1.45;color:oklch(32% 0.015 90)}" +
"#axp-balloon .ln .k{color:oklch(50% 0.02 90)}#axp-balloon .ln b{color:oklch(20% 0.02 90)}" +
"#axp-balloon .ok{color:oklch(50% 0.16 145);font-weight:bold}" +
"#axp-balloon .mono{font-family:var(--font-mono,'Courier New',monospace);font-size:10px}" +
"#axp-balloon .load{padding:0 12px 6px 32px;color:oklch(55% 0.02 90);font-style:italic}" +
"#axp-balloon .ft{padding:2px 12px 9px 32px}#axp-balloon .ft a{color:oklch(42.61% 0.2353 263.74);font-size:10.5px;text-decoration:underline}" +
// ── Run dialog ──
"#axp-run-back{position:fixed;inset:0;z-index:99998;display:none}" +
"#axp-run-back.open{display:block}" +
"#axp-run{position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:100000;width:min(440px,calc(100vw - 24px));display:none;" +
"font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif);font-size:12px;color:oklch(21% 0 0);background:oklch(100% 0 0);" +
"border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;" +
"box-shadow:inset 1px 1px 0 #166aee,inset 2px 2px 0 #0855dd,inset -1px -1px 0 #00138c,inset -2px -2px 0 #003bda,4px 4px 0 rgba(0,30,160,.35),2px 3px 12px -2px oklch(30% 0.12 263 / .55)}" +
"#axp-run.open{display:block}" +
"#axp-run .tb{display:flex;align-items:center;gap:6px;padding:3px 4px 4px 7px;color:oklch(100% 0 0);" +
"font-family:var(--font-caption,'Trebuchet MS',Verdana,Geneva,sans-serif);font-weight:bold;font-size:10pt;text-shadow:1px 1px oklch(28% 0.12 263);" +
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
  var run, input, list, backdrop, results = [], sel = -1, lastQuery = null, semantic = { q: "", items: [] }, searchTimer = null;
  // System Properties tray popout state
  var balloon = null, balloonKind = null, sysData = null, updData = null;

  function el(html) { var t = D.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

  // ── XP-flavored sound: synthesized via Web Audio (no copyrighted audio, no asset
  // bytes), gated by the tray mute toggle. Default OFF so there is never surprise
  // audio; the choice persists in localStorage. Navigation sounds are skipped on
  // purpose (page unload cuts them) — only in-page shell actions play.
  var AXP_SND = (function () {
    var ctx = null, on = false;
    try { on = localStorage.getItem("axp-sound") === "on"; } catch (e) {}
    function ac() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (ctx.state === "suspended" && ctx.resume) ctx.resume(); return ctx; }
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

  function buildTaskbar() {
    var bar = el('<div id="axp-taskbar" role="navigation" aria-label="taskbar"></div>');
    var start = el('<button id="axp-start" type="button" aria-haspopup="dialog" aria-expanded="false" title="Run — navigate the site (' + KBD + ')"><span id="axp-cone" aria-hidden="true"></span>start<span class="axp-kbd" aria-hidden="true">' + KBD + '</span></button>');
    // the Start orb is a toggle: open Run, or close it if it's already open
    // (matches the ⌘K / Ctrl-K shortcut, which toggles too).
    start.addEventListener("click", function () { (run && run.classList.contains("open")) ? closeRun() : openRun(); });
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
    var tray = el('<div id="axp-tray">' +
      '<a id="axp-sysprop" class="axp-trayico" href="/whoareyou" data-kind="sysprop" title="System Properties · what one request reveals" aria-label="System Properties"><svg viewBox="0 0 24 24"><defs><filter id="spSh" x="-30%" y="-20%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="spBez" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3efe4"></stop><stop offset=".5" stop-color="#d6d0be"></stop><stop offset="1" stop-color="#b1aa94"></stop></linearGradient><linearGradient id="spScr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fb0e8"></stop><stop offset=".5" stop-color="#2f72b6"></stop><stop offset="1" stop-color="#16548f"></stop></linearGradient><linearGradient id="spGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".5"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#spSh)"><ellipse cx="12" cy="21.3" rx="5.2" ry="1" fill="#8f876f" opacity=".5"></ellipse><rect x="10.4" y="17.2" width="3.2" height="2.8" fill="#c3bca6"></rect><path d="M7 21 Q7 19.7 8.6 19.7 H15.4 Q17 19.7 17 21 Z" fill="url(#spBez)" stroke="#897f66" stroke-width=".4"></path><rect x="2.3" y="2.7" width="19.4" height="14.9" rx="2" fill="url(#spBez)" stroke="#857c63" stroke-width=".5"></rect><rect x="2.95" y="3.3" width="18.1" height="13.7" rx="1.5" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".5"></rect><rect x="4.2" y="4.7" width="15.6" height="11" rx=".8" fill="#0f3d63"></rect><rect x="4.6" y="5.1" width="14.8" height="10.2" rx=".6" fill="url(#spScr)"></rect><path d="M4.6 5.1 H19.4 V7.9 Q12 11.8 4.6 9.1 Z" fill="url(#spGl)"></path><circle cx="20" cy="15.9" r=".8" fill="#84e85a" stroke="#3f7a2a" stroke-width=".3"></circle></g></svg></a>' +
      '<a id="axp-security" class="axp-trayico" href="/security" data-kind="security" title="Security Center · what guards this site" aria-label="Security Center"><svg viewBox="0 0 24 24"><defs><filter id="seSh" x="-30%" y="-15%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="seF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ed24f"></stop><stop offset=".5" stop-color="#3f9c24"></stop><stop offset="1" stop-color="#297818"></stop></linearGradient><linearGradient id="seGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#seSh)"><path d="M12 2.2 L4.4 4.9 V11.4 C4.4 16.2 8 19.7 12 21.6 C16 19.7 19.6 16.2 19.6 11.4 V4.9 Z" fill="url(#seF)" stroke="#1f5f12" stroke-width=".7"></path><path d="M12 3.4 L5.6 5.7 V11.3 C5.6 15.3 8.6 18.4 12 20.1 C15.4 18.4 18.4 15.3 18.4 11.3 V5.7 Z" fill="none" stroke="#c6f2a6" stroke-opacity=".5" stroke-width=".6"></path><path d="M12 3.4 L5.6 5.7 V8.8 Q12 10.8 18.4 8.8 V5.7 Z" fill="url(#seGl)"></path><path d="M8 11.5 L11 14.5 L16.2 8.4" fill="none" stroke="#103f08" stroke-opacity=".35" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"></path><path d="M8 11.2 L11 14.2 L16.2 8.1" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></g></svg></a>' +
      '<a id="axp-updates" class="axp-trayico" href="/updates" data-kind="updates" title="Windows Update · what shipped lately" aria-label="Windows Update"><svg viewBox="0 0 24 24"><defs><filter id="upSh" x="-25%" y="-20%" width="150%" height="155%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><radialGradient id="upG" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="#8eccf2"></stop><stop offset=".55" stop-color="#3f8fd0"></stop><stop offset="1" stop-color="#175a98"></stop></radialGradient><linearGradient id="upB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#74cf52"></stop><stop offset="1" stop-color="#2c861d"></stop></linearGradient><radialGradient id="upGl" cx=".35" cy=".3" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".7"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></radialGradient></defs><g filter="url(#upSh)"><circle cx="10.6" cy="10.6" r="8.2" fill="url(#upG)" stroke="#114e7d" stroke-width=".6"></circle><g fill="none" stroke="#dcefff" stroke-width=".55" opacity=".7"><path d="M2.5 10.6 H18.7"></path><path d="M3.6 7.1 H17.6"></path><path d="M3.6 14.1 H17.6"></path><path d="M10.6 2.4 V18.8"></path><ellipse cx="10.6" cy="10.6" rx="3.1" ry="8.2"></ellipse></g><ellipse cx="7.4" cy="7" rx="3.4" ry="2.2" fill="url(#upGl)"></ellipse><circle cx="17.8" cy="17.8" r="4.5" fill="url(#upB)" stroke="#ffffff" stroke-width=".9"></circle><path d="M17.8 15.6 A2.2 2.2 0 1 1 15.7 18.4" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"></path><path d="M16.9 14.9 L18.8 15.3 L17.5 16.8 Z" fill="#ffffff"></path></g></svg></a>' +
      '<span id="axp-clock" aria-hidden="true"></span></div>');
    // mute/unmute speaker, inserted left of System Properties
    var sndBtn = el('<button id="axp-sound" type="button"></button>');
    function paintSnd() {
      var on = AXP_SND.on();
      sndBtn.className = on ? "" : "muted";
      sndBtn.title = on ? "Sounds on (click to mute)" : "Sounds off (click to unmute)";
      sndBtn.setAttribute("aria-label", sndBtn.title); sndBtn.setAttribute("aria-pressed", String(!on));
      sndBtn.innerHTML = '<svg viewBox="0 0 24 24">' + (on
        ? '<defs><filter id="sdSh" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".25"></feDropShadow></filter><linearGradient id="sdC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfb"></stop><stop offset=".5" stop-color="#cfcfcf"></stop><stop offset="1" stop-color="#9c9c9c"></stop></linearGradient></defs><g filter="url(#sdSh)"><rect x="2" y="8.6" width="2.6" height="6.8" rx=".6" fill="#8c8c8c"></rect><path d="M3.4 9 H6.4 L11 4.6 V17.4 L6.4 13 H3.4 Z" fill="url(#sdC)" stroke="#5f5f5f" stroke-width=".6" stroke-linejoin="round"></path><path d="M3.9 9.4 H6.1 L9.6 6 V8.6 Z" fill="#ffffff" opacity=".4"></path><g fill="none" stroke="#2e8fd6" stroke-linecap="round"><path d="M13.4 8 Q15.4 11 13.4 14" stroke-width="1.6"></path><path d="M15.7 6 Q19.2 11 15.7 16" stroke-width="1.5" opacity=".82"></path><path d="M18 4.3 Q22.4 11 18 17.7" stroke-width="1.4" opacity=".62"></path></g></g>'
        : '<defs><filter id="muSh" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".25"></feDropShadow></filter><linearGradient id="muC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ededed"></stop><stop offset=".5" stop-color="#c2c2c2"></stop><stop offset="1" stop-color="#969696"></stop></linearGradient><radialGradient id="muR" cx=".4" cy=".34" r=".75"><stop offset="0" stop-color="#f47f72"></stop><stop offset="1" stop-color="#c2271c"></stop></radialGradient></defs><g filter="url(#muSh)"><rect x="2" y="8.6" width="2.6" height="6.8" rx=".6" fill="#8c8c8c"></rect><path d="M3.4 9 H6.4 L11 4.6 V17.4 L6.4 13 H3.4 Z" fill="url(#muC)" stroke="#5f5f5f" stroke-width=".6" stroke-linejoin="round"></path><circle cx="16.6" cy="10.8" r="5.1" fill="url(#muR)" stroke="#8c1a10" stroke-width=".7"></circle><path d="M13.3 7.5 L19.9 14.1" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"></path><ellipse cx="14.9" cy="8.4" rx="2.5" ry="1.2" fill="#ffffff" opacity=".28"></ellipse></g>') + '</svg>';
    }
    sndBtn.addEventListener("click", function () { var next = !AXP_SND.on(); AXP_SND.set(next); paintSnd(); if (next) AXP_SND.play("tada"); });
    paintSnd();
    tray.insertBefore(sndBtn, tray.firstChild);
    // each system-utility tray icon opens a brief XP balloon above itself. they stay
    // real <a href> so a modified click (⌘/Ctrl/Shift, or middle — which fires
    // auxclick, not click) still opens the full page in a new tab.
    [].forEach.call(tray.querySelectorAll(".axp-trayico"), function (ic) {
      ic.setAttribute("aria-haspopup", "dialog");
      ic.setAttribute("aria-expanded", "false");
      ic.addEventListener("click", function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // let the browser navigate
        e.preventDefault();
        toggleBalloon(ic.getAttribute("data-kind"), ic);
      });
    });
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
        ' title="' + esc(it.hint || it.label) + (ext ? " (opens in a new tab)" : "") + '"></a>');
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
        '<div class="tb"><span>Run</span><span class="axp-kbd" aria-hidden="true">' + KBD + '</span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
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
  function pool() { return PAGES.concat(ACCESSORIES, WRITING || [], PROFILES, PHOTOS || []); }

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
      items = PAGES.concat(ACCESSORIES, WRITING || [], PROFILES, (PHOTOS || []).slice(0, 8));
    }
    // Search Companion: semantic matches from the LWE index, prepended as their own
    // group. Debounced fetch; the results fold in on a later render with the same query.
    if (q && q.length >= 3) {
      if (semantic.q === q) {
        var have = {}; items.forEach(function (it) { have[it.path] = 1; });
        items = semantic.items.filter(function (s) { return !have[s.path]; }).concat(items);
      } else { scheduleSemantic(input.value.trim()); }
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
    var groups = { search: [], page: [], accessory: [], writing: [], profile: [], photo: [], raycast: [] };
    var order  = ["search", "page", "accessory", "writing", "profile", "photo", "raycast"];
    var names  = { search: "Search Companion", page: "Pages", accessory: "Accessories", writing: "Writing", profile: "Profiles", photo: "Photos", raycast: "Raycast" };
    // defensive: a kind with no bucket must NOT throw and blank the whole palette.
    // that's the bug this fixes — the empty-query "directory" lists every PAGES
    // item incl. the kind:"raycast" easter eggs, and groups["raycast"] was
    // undefined, so render threw and the list came up empty until you typed
    // something that filtered the raycast rows out. any future kind self-buckets.
    items.forEach(function (it, i) {
      var k = it.kind || "page";
      if (!groups[k]) { groups[k] = []; order.push(k); names[k] = k; }
      groups[k].push({ it: it, i: i });
    });
    var html = "";
    order.forEach(function (k) {
      if (!groups[k].length) return;
      html += '<div class="grp">' + names[k] + "</div>";
      groups[k].forEach(function (g) {
        html += '<div class="opt" role="option" data-i="' + g.i + '" aria-selected="' + (g.i === sel) + '">' +
          '<span class="nm">' + esc(g.it.label) + "</span>" +
          (g.it.hint ? '<span class="ht">' + esc(g.it.hint) + "</span>" : "") +
          '<span class="pa">' + esc(g.it.kind === "profile" ? "↗" : g.it.kind === "raycast" ? "↗ raycast" : g.it.kind === "accessory" ? "↗ window" : g.it.path) + "</span></div>";
      });
    });
    list.innerHTML = html || '<div class="empty">No match. Try a page name, a photo stem, or a profile — or <a href="/photos">browse all photos</a>.</div>';
    ensureVisible();
  }

  // ── Search Companion: debounced semantic search over the LWE index ─────────────
  function scheduleSemantic(qRaw) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { doSemantic(qRaw); }, 240);
  }
  function doSemantic(qRaw) {
    var qKey = qRaw.trim().toLowerCase();
    if (qKey.length < 3) return;
    fetch("/lwe/ask/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: qRaw }) })
      .then(function (r) { return r.ok ? r.json() : { results: [] }; })
      .then(function (d) {
        semantic = { q: qKey, items: (d.results || []).map(function (x) { return { kind: "search", label: x.title, hint: x.snippet, path: x.url }; }) };
        if (input && input.value.trim().toLowerCase() === qKey && run && run.classList.contains("open")) render();
      })
      .catch(function () {});
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
    if (item.kind === "accessory") openAccessory(item.accId);  // floating built-in app — opens here, no navigation
    else if (item.kind === "raycast") location.href = item.path;   // protocol deep link → OS hands it to Raycast; page stays
    else if (item.kind === "profile") window.open(item.url, "_blank", "noopener");
    else location.assign(item.path);
  }

  // ── accessory window manager ────────────────────────────────────────────────
  // Small built-in apps that float over the desktop as plain DOM windows: open
  // several, drag them, click one (or its taskbar button) to bring it to front.
  // No iframes, no SPA — the content pages stay one-document-per-window; only these
  // accessories get the multi-window treatment (the same split XP itself made).
  var ACC_Z = 40, ACC_OPEN = {};

  // ── click-to-raise: any pointerdown inside a window brings it to the front ──
  // "front" is just paint order among overlapping siblings, and windows only
  // overlap once dragging (or an accessory popout) is involved — the flex
  // desktop never overlaps them at rest. One monotonic counter shared by page
  // windows and accessories keeps the two families interleaving correctly
  // (click a page window and it rises above the Clock, and vice versa).
  // Capture phase so clicks on scrollbars, inputs, and the textarea all raise.
  // Ceiling stays far below the taskbar (99999) / Run (99998) / balloon layers.
  function initRaise() {
    D.addEventListener("pointerdown", function (e) {
      var w = e.target && e.target.closest && e.target.closest(".window,.np-window,.axp-acc");
      if (!w) return;
      if (String(w.style.zIndex) === String(ACC_Z)) return;   // already on top
      w.style.zIndex = ++ACC_Z;
    }, true);
  }
  var ACCESSORIES = [
    { label: "Clock", hint: "the current time, ticking", kind: "accessory", accId: "clock", path: "", icon: "🕐", build: buildClock }
  ];
  function accFront(win) { win.style.zIndex = ++ACC_Z; }
  function openAccessory(id) {
    var a = ACCESSORIES.filter(function (x) { return x.accId === id; })[0]; if (!a) return;
    if (ACC_OPEN[id]) { accFront(ACC_OPEN[id].win); return; }
    AXP_SND.play("open");
    var n = Object.keys(ACC_OPEN).length;
    var win = el('<div class="axp-acc"><div class="tb"><span class="ic" aria-hidden="true">' + a.icon + '</span><span class="t">' + a.label + '</span><span class="x" role="button" title="close" aria-label="close">✕</span></div><div class="bd"></div></div>');
    win.style.left = Math.max(8, Math.min(innerWidth - 200, 86 + n * 24)) + "px";
    win.style.top = Math.max(8, 64 + n * 24) + "px";
    D.body.appendChild(win);
    var bd = win.querySelector(".bd");
    try { a.build(bd); } catch (e) {}
    accFront(win);
    var btn = el('<button class="axp-pin axp-acc-btn" title="' + a.hint + '"><span class="fav" aria-hidden="true">' + a.icon + '</span><span class="lbl">' + a.label + '</span></button>');
    var bar = D.getElementById("axp-taskbar"), spacer = D.getElementById("axp-spacer");
    if (bar && spacer) bar.insertBefore(btn, spacer);
    btn.addEventListener("click", function () { accFront(win); });
    ACC_OPEN[id] = { win: win, btn: btn };
    win.addEventListener("pointerdown", function () { accFront(win); });
    win.querySelector(".x").addEventListener("click", function (ev) {
      ev.stopPropagation(); if (bd._iv) clearInterval(bd._iv); win.remove(); btn.remove(); delete ACC_OPEN[id];
    });
    var tb = win.querySelector(".tb");
    tb.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".x")) return;
      accFront(win);
      var r = win.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
      try { tb.setPointerCapture(e.pointerId); } catch (er) {}
      function mv(ev) {
        win.style.left = Math.max(0, Math.min(innerWidth - 40, ox + ev.clientX - sx)) + "px";
        win.style.top = Math.max(0, Math.min(innerHeight - 36, oy + ev.clientY - sy)) + "px";
      }
      function up() { tb.removeEventListener("pointermove", mv); tb.removeEventListener("pointerup", up); }
      tb.addEventListener("pointermove", mv); tb.addEventListener("pointerup", up);
    });
  }
  function buildClock(bd) {
    bd.innerHTML = '<div class="clk"><div class="clk-t">--:--:--</div><div class="clk-d"></div></div>';
    var t = bd.querySelector(".clk-t"), dd = bd.querySelector(".clk-d");
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    function tick() {
      var now = new Date();
      t.textContent = p2(now.getHours()) + ":" + p2(now.getMinutes()) + ":" + p2(now.getSeconds());
      dd.textContent = now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }
    tick(); bd._iv = setInterval(tick, 1000);
  }

  // ── open / close ──────────────────────────────────────────────────────────────
  var lastFocus = null;
  function openRun() {
    if (!run) buildRun();
    if (run.classList.contains("open")) return;
    if (!PHOTOS) loadPhotos().then(function () { if (run.classList.contains("open")) render(); });
    if (!WRITING) loadWriting().then(function () { if (run.classList.contains("open")) render(); });
    lastFocus = D.activeElement;
    backdrop.classList.add("open"); run.classList.add("open"); AXP_SND.play("open");
    var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "true");
    input.value = ""; render();
    input.focus();
  }
  function closeRun() {
    if (!run || !run.classList.contains("open")) return;
    run.classList.remove("open"); backdrop.classList.remove("open"); AXP_SND.play("close");
    var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  // ── tray balloons: brief XP notification-bubble popouts for the system-utility
  // icons (System Properties, Security Center, Windows Update). One balloon at a
  // time; it opens above whichever icon was clicked, with a tail pointing at it.
  // The full pages keep all the detail; these are the quick at-a-glance status.
  var BALLOON = {
    sysprop: { title: "System Properties", href: "/whoareyou",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#1c4bb0' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'><rect x='1.8' y='2.4' width='12.4' height='8' rx='1'></rect><path d='M6 10.4v2M10 10.4v2M4.6 12.9h6.8'></path></svg>",
      load: loadSys, render: renderSys },
    security: { title: "Security Center", href: "/security",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#2c8f1e' stroke-width='1.3' stroke-linejoin='round' stroke-linecap='round'><path d='M8 1.7 2.7 3.7 V8 c0 3.4 2.6 5.4 5.3 6.4 2.7-1 5.3-3 5.3-6.4 V3.7 Z'></path><path d='M5.7 8 7.3 9.7 10.5 6.2'></path></svg>",
      load: loadSys, render: renderSec },
    updates: { title: "Windows Update", href: "/updates",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#1c4bb0' stroke-width='1.2'><circle cx='8' cy='8' r='6'></circle><path d='M2 8 h12 M8 2 c2.3 2.4 2.3 9.2 0 12 M8 2 c-2.3 2.4 -2.3 9.2 0 12'></path></svg>",
      load: loadUpd, render: renderUpd }
  };
  function buildBalloon() {
    if (balloon) return;
    balloon = el(
      '<div id="axp-balloon" role="dialog" aria-label="notification">' +
        '<div class="tb"><span class="ic" aria-hidden="true"></span><span class="t"></span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
        '<div class="bd"></div><div class="ft"></div>' +
      '</div>'
    );
    D.body.appendChild(balloon);
    balloon.querySelector(".x").addEventListener("click", closeBalloon);
  }
  function balloonBody() { return balloon && balloon.querySelector(".bd"); }
  // data, cached per page load
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
  function flatFields(j) { var m = {}; (j.groups || []).forEach(function (g) { (g.fields || []).forEach(function (f) { m[f.k] = f.v; }); }); return m; }
  function renderSys(j) {
    var b = balloonBody(); if (!b) return;
    if (!j) { b.innerHTML = '<div class="load">couldn\'t read this connection.</div>'; return; }
    var m = flatFields(j);
    b.innerHTML =
      '<div class="ln"><span class="k">Network</span> <b>' + esc(m["Cloudflare colo"] || "—") + '</b> <span class="k">' + esc(m["ISP / ASN"] || "") + '</span></div>' +
      '<div class="ln"><span class="k">Transport</span> <b>' + esc(m["HTTP version"] || "—") + '</b> · ' + esc(m["TLS version"] || "") + '</div>' +
      '<div class="ln"><span class="k">Region</span> ' + esc((m["City"] || "—") + ", " + (m["Country"] || "")) + '</div>' +
      '<div class="ln"><span class="k">Client</span> ' + esc(m["Best guess"] || "—") + '</div>';
  }
  function renderSec(j) {
    var b = balloonBody(); if (!b) return;
    var m = j ? flatFields(j) : {};
    var tr = j ? ('<div class="ln"><span class="k">Transport</span> ' + esc((m["HTTP version"] || "") + " · " + (m["TLS version"] || "")) + '</div>') : "";
    b.innerHTML =
      '<div class="ln"><b>Firewall</b> <span class="ok">ON</span> <span class="k">Cloudflare edge</span></div>' +
      '<div class="ln"><b>Automatic Updates</b> <span class="ok">ON</span> <span class="k">service worker</span></div>' +
      '<div class="ln"><b>Threat protection</b> <span class="ok">ON</span> <span class="k">bot auth</span></div>' + tr;
  }
  function renderUpd(j) {
    var b = balloonBody(); if (!b) return;
    if (!j) { b.innerHTML = '<div class="load">couldn\'t read the update log.</div>'; return; }
    var latest = (j.items || []).slice(0, 2).map(function (it) {
      return '<div class="ln"><span class="k">' + esc(it.slug) + '</span> ' + esc(it.title) + '</div>';
    }).join("");
    b.innerHTML =
      '<div class="ln"><b class="ok">aadhar.sh is up to date.</b></div>' +
      '<div class="ln"><span class="k">build</span> <span class="mono">' + esc(j.build || "—") + '</span></div>' + latest;
  }
  function placeTail(ic) {
    // aim the down-tail at the center of the icon that opened the balloon
    try {
      var ir = ic.getBoundingClientRect(), br = balloon.getBoundingClientRect();
      var x = Math.max(14, Math.min(br.width - 14, (ir.left + ir.width / 2) - br.left));
      balloon.style.setProperty("--tail", x + "px");
    } catch (e) {}
  }
  function openBalloon(kind, ic) {
    var cfg = BALLOON[kind]; if (!cfg) return;
    if (!balloon) buildBalloon();
    balloonKind = kind;
    balloon.querySelector(".ic").innerHTML = cfg.icon;
    balloon.querySelector(".t").textContent = cfg.title;
    balloon.querySelector(".ft").innerHTML = '<a href="' + cfg.href + '">full page</a>';
    balloonBody().innerHTML = '<div class="load">reading…</div>';
    balloon.classList.add("open"); AXP_SND.play("open");
    if (ic) { ic.setAttribute("aria-expanded", "true"); placeTail(ic); }
    var x = balloon.querySelector(".x"); if (x) try { x.focus(); } catch (e) {}
    cfg.load(function (data) { if (balloon.classList.contains("open") && balloonKind === kind) cfg.render(data); });
  }
  function closeBalloon() {
    if (!balloon || !balloon.classList.contains("open")) return;
    balloon.classList.remove("open"); AXP_SND.play("close");
    var ic = balloonKind && D.querySelector('.axp-trayico[data-kind="' + balloonKind + '"]');
    if (ic) { ic.setAttribute("aria-expanded", "false"); try { ic.focus(); } catch (e) {} }
    balloonKind = null;
  }
  function toggleBalloon(kind, ic) {
    if (!balloon) buildBalloon();
    if (balloon.classList.contains("open") && balloonKind === kind) { closeBalloon(); return; }
    openBalloon(kind, ic);
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ⌘K / Ctrl-K anywhere
  D.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      run && run.classList.contains("open") ? closeRun() : openRun();
    }
  });

  // Escape closes the tray balloon; a pointerdown anywhere outside it (and outside
  // ANY tray icon — clicking a sibling icon swaps the balloon via its own handler)
  // dismisses it, like a real XP notification balloon.
  D.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && balloon && balloon.classList.contains("open")) closeBalloon();
  });
  D.addEventListener("pointerdown", function (e) {
    if (!balloon || !balloon.classList.contains("open")) return;
    if (e.target.closest && (e.target.closest("#axp-balloon") || e.target.closest(".axp-trayico"))) return;
    closeBalloon();
  }, true);

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
      if (w.classList.contains("axp-max")) return;   // a maximized window is pinned, not draggable
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
    // remember the primary window's scroll across quick reloads
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
    var nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || {};
    if (nav.type === "reload") {
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
    [].forEach.call(D.querySelectorAll(".window,.np-window"), function (f) {
      if (f.classList.contains("np-folder")) return;   // folder hugs its content — not resizable
      if (f.querySelector(":scope > .axp-resize")) return;
      if (getComputedStyle(f).position === "static") f.style.position = "relative";
      var g = el('<div class="axp-resize" aria-hidden="true"></div>');
      f.appendChild(g);
      g.addEventListener("pointerdown", function (e) {
        if (f.classList.contains("axp-max")) return;   // no resizing a maximized window
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
  // serendipity, coffee…) is near-instant and the View Transition plays on
  // already-loaded content. the homepage is prerenderable now (the counter left
  // the document for /hit.svg) and so is /around (its crawl moved to a cron; a
  // visit is a pure KV read). excluded: /whoareyou (per-request fingerprint),
  // /rn (redirect), images + raw text. /coffee IS prerendered: GET is read-only
  // (booking is POST) so a speculative open is safe.
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
          { not: { href_matches: "/whoareyou*" } },
          { not: { href_matches: "/rn*" } },
          { not: { href_matches: "/images*" } },
          { not: { href_matches: "/index.md" } },
          { not: { href_matches: "/llms.txt" } }
        ] },
        eagerness: "moderate"
      }],
      // eager prefetch (document-only, no render) for the cheap STATIC content pages
      // (garage + lwe explainers, minus the lwe-ask worker endpoint), so even an
      // un-hovered/touch click loads from cache. dynamic worker pages stay prerender-
      // on-hover above, so we don't fire a worker invocation per link on every visit.
      prefetch: [{
        where: { and: [
          { or: [ { href_matches: "/garage/*" }, { href_matches: "/lwe/*" } ] },
          { not: { href_matches: "/lwe/ask*" } }
        ] },
        eagerness: "eager"
      }]
    });
    D.body.appendChild(s);
  }

  // Instant "close": the close glyph means "up to aadhar.sh". When the window
  // was opened directly FROM the homepage, going back restores it from bfcache —
  // instant, zero network, no worker hit, no loading bar — instead of a fresh
  // no-store fetch of "/". Gated on the referrer actually BEING home so the
  // "close = home" semantics hold; every other case falls through to the href
  // (a normal navigation to "/"). McMaster-Carr feel without prerendering the
  // heaviest page on every hover.
  function initCloseBack() {
    D.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest("a.close");
      if (!a || history.length <= 1 || D.referrer !== location.origin + "/") return;
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
      if (closeA) { closeA.setAttribute("href", "/"); closeA.title = "close to aadhar.sh"; closeA.setAttribute("aria-label", "close to aadhar.sh"); }
    }

    // back / forward, injected at the head of the title bar (excluded from title-bar
    // drag because they're <button>, which initDrag already skips).
    if (!bar.querySelector(".axp-histnav")) {
      var hn = el('<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button><button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>');
      bar.insertBefore(hn, bar.firstChild);
      var bBtn = hn.querySelector(".axp-back"), fBtn = hn.querySelector(".axp-fwd");
      bBtn.addEventListener("click", function () { history.back(); });
      fBtn.addEventListener("click", function () { history.forward(); });
      var sync = function () {
        if (!window.navigation) return;                 // no Navigation API -> leave both enabled
        bBtn.disabled = !navigation.canGoBack;
        fBtn.disabled = !navigation.canGoForward;
      };
      sync();
      if (window.navigation) navigation.addEventListener("currententrychange", sync);
      addEventListener("pageshow", sync);               // re-sync after a bfcache restore
    }

    // maximize / restore the page window
    var maxBtn = bar.querySelector(".max");
    if (maxBtn && !maxBtn.dataset.axpWired) {
      maxBtn.dataset.axpWired = "1";
      maxBtn.setAttribute("role", "button");
      maxBtn.setAttribute("tabindex", "0");
      maxBtn.removeAttribute("aria-hidden");
      maxBtn.setAttribute("aria-label", "Maximize");
      maxBtn.title = "Maximize";
      maxBtn.style.cursor = "pointer";
      var toggle = function () {
        var on = win.classList.toggle("axp-max");
        maxBtn.setAttribute("aria-label", on ? "Restore" : "Maximize");
        maxBtn.title = on ? "Restore" : "Maximize";
      };
      maxBtn.addEventListener("click", toggle);
      maxBtn.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    }
  }

  function boot() { injectCSS(); buildDesktop(); buildIcons(); buildTaskbar(); initDrag(); initRaise(); initIconDrag(); initScrollbars(); initResize(); setFavicon(); injectSpeculation(); initCloseBack(); initWindowControls(); }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
