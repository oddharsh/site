// nav.js — site-wide XP "Luna" taskbar + Run command palette.
//
// One deferred, self-contained widget shared across every page (immutable /a/ URL) instead
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
  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "");
  var KBD = IS_MAC ? "⌘K" : "Ctrl K";

  // The pageswap/pagereveal pair that tagged each navigation "axp-open" or
  // "axp-close" is gone with the transition it steered. Both listeners ran on
  // EVERY navigation to hand a type to CSS rules that no longer exist, and the
  // pageswap one also wrote the sessionStorage breadcrumb /garage/vt-check read;
  // that page now states plainly that the shell does not opt in.

  // ── destinations ──────────────────────────────────────────────────────────
  var PAGES = [
    { label: "Home", path: "/", hint: "aadhar.sh" },
    { label: "photos", path: "/photos", hint: "every photo, Explorer Thumbnails view — the archive the old /images/ listing became" },
    { label: "whoareyou", path: "/whoareyou", hint: "system properties · what one request reveals · for agents + the curious" },
    { label: "security center", path: "/security", hint: "the site's security posture, XP-style: firewall, updates, threat protection" },
    { label: "windows update", path: "/updates", hint: "what shipped lately: the deploy changelog as installed updates" },
    { label: "system restore", path: "/restore", hint: "scrub the site back through its real deploy history, backed by Cloudflare D1" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "garage", path: "/garage", hint: "prototypes + experiments" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "music", path: "/rn", hint: "what I'm listening to right now" },
    { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" },
    { label: "writing", path: "/writing", hint: "notes, in flux — an editable notepad" },
    { label: "inbox", path: "/inbox", hint: "who linked here — webmentions from the open web, rendered as Outlook Express mail" },
    { label: "reading", path: "/reading", hint: "what I've been reading — saved to Curius, mirrored here" },
    { label: "lens", path: "/lens", hint: "the other web: see any URL the way a machine does — raw HTML, JSON-LD, llms.txt" },
    { label: "pixel peeper", path: "/pixel-peeper", hint: "whose eye do you have? a compression vision test — pick the best encode, blind" },
    { label: "learning with errors", path: "/lwe", hint: "chat-style explainers + live demos" },
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
    // generated:garage-pages:start
    { label: "garage · blueprint", path: "/garage/blueprint", hint: "the repo, blueprinted by Fable 5" },
    { label: "garage · chunks", path: "/garage/chunks", hint: "content-addressed chunking" },
    { label: "garage · cloudflare", path: "/garage/cloudflare", hint: "free Cloudflare features" },
    { label: "garage · encoding", path: "/garage/encoding", hint: "thumbnail encoding study" },
    { label: "garage · compression", path: "/garage/compression", hint: "brotli q11 + dcz deltas" },
    { label: "garage · 5.6 sol", path: "/garage/gpt56", hint: "the performance pass outlined with 5.6 Sol" },
    { label: "garage · horizon", path: "/garage/horizon", hint: "web-platform horizon" },
    { label: "garage · iroh", path: "/garage/iroh", hint: "dial a machine by its public key" },
    { label: "garage · masonry", path: "/garage/masonry", hint: "Grid Lanes masonry photo grid (with fixed-square fallback)" },
    { label: "garage · octane", path: "/garage/octane", hint: "what a framework's floor costs against no framework" },
    { label: "garage · pretext", path: "/garage/pretext", hint: "DOM-free text measurement" },
    { label: "garage · pqc", path: "/garage/pqc", hint: "what a PQ signature costs in bytes and milliseconds" },
    { label: "garage · safari 27", path: "/garage/safari27", hint: "WWDC26 Safari 27 features, through this site's lens" },
    { label: "garage · scroll", path: "/garage/scroll", hint: "XP scroll chrome" },
    { label: "garage · teardown", path: "/garage/teardown", hint: "what a multi-agent audit found + fixed" },
    { label: "garage · tooltips", path: "/garage/tooltips", hint: "tooltip experiments" },
    { label: "garage · wire", path: "/garage/wire", hint: "the first build step + the brotli rabbit hole" },
    { label: "garage · workers", path: "/garage/workers", hint: "off Pages, onto Workers" },
    // generated:garage-pages:end
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
    { label: "GitHub", url: "https://github.com/oddharsh" },
    { label: "Twitter", url: "https://x.com/oddhash" },
    { label: "Photos", icon: "Instagram", hint: "Instagram", url: "https://www.instagram.com/aadharsh.hif" },
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
    { label: "garage", path: "/garage", hint: "prototypes + experiments" },
    { label: "lwe", path: "/lwe", hint: "chat-style explainers + live demos" },
    { label: "writing", path: "/writing", hint: "notes, in flux: an editable notepad" },
    { label: "reading", path: "/reading", hint: "what I've been reading, from Curius" },
    { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
    { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
    { label: "lens", path: "/lens", hint: "the other web: how machines read a URL" },
    { label: "pixel peeper", path: "/pixel-peeper", hint: "a compression vision test — whose eye do you have?" },
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
    lens:        sectionTile("lens", ["#79c7e6","#2f9fc4","#1d7895","#145d73"], '<rect x="5.5" y="5" width="15" height="19" rx="2" fill="#fff"/><g fill="#2f9fc4"><rect x="8.5" y="9.5" width="9" height="1.7" rx="0.6"/><rect x="8.5" y="13" width="9" height="1.7" rx="0.6"/><rect x="8.5" y="16.5" width="6" height="1.7" rx="0.6"/></g><circle cx="20.5" cy="20.5" r="6" fill="#2f9fc4" stroke="#fff" stroke-width="2.2"/><circle cx="18.6" cy="18.6" r="1.5" fill="#fff" opacity=".85"/><path d="M24.8 24.8 L28.5 28.5" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>'),
    // an eye whose pupil is a literal pixel — the whole premise in one glyph. The
    // magenta is the one hue the tile set had left (serendipity owns violet,
    // reading owns dusty rose), so it stays legible at 15px on the taskbar. Key is
    // the SUBPAGES label, so it carries the space; the sprite id gets slugged.
    "pixel peeper": sectionTile("peeper", ["#f19ad0","#d24d9c","#a32d73","#82205a"], '<path d="M2.6 16 C7 9.6 11.4 7.1 16 7.1 C20.6 7.1 25 9.6 29.4 16 C25 22.4 20.6 24.9 16 24.9 C11.4 24.9 7 22.4 2.6 16 Z" fill="#fff"/><rect x="11.1" y="11.1" width="9.8" height="9.8" rx="1" fill="#a32d73"/><rect x="12.9" y="12.9" width="3.1" height="3.1" rx=".5" fill="#fff" opacity=".92"/>')
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

  // ── build DOM ────────────────────────────────────────────────────────────────
  var run, input, list, results = [], sel = -1, lastQuery = null, semantic = { q: "", items: [] }, searchTimer = null;
  var preview = null, previewHoist = null, previewLoading = false;
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
    // ADOPT-OR-BUILD (shell rewrite phase B): most pages ship the taskbar as
    // static markup now, so the desktop exists for curl, readers, and JS-off
    // visitors and CLS is 0. Those pages take the adopt path one line down.
    //
    // The construct path below is NOT a legacy fallback. Two live routes load
    // /nav.js without the partial and still build here every visit: /coffee
    // (cal/src/templates.js, which ships a bare bottom strip as a placeholder)
    // and /serendipity (serendipity.js). Both are separate Worker modules that
    // predate lib/desktop.js and don't import it; until they do, this is their
    // taskbar. gen-desktop-partial.mjs also evals the tray template out of this
    // function, so the markup here stays the single source of truth either way.
    // Whichever path runs, wireTaskbar() below binds behavior.
    var bar = D.getElementById("axp-taskbar");
    if (bar) { wireTaskbar(bar); return; }
    bar = el('<div id="axp-taskbar" role="navigation" aria-label="taskbar"></div>');
    // the Start orb is a real link to /run (the palette's no-script floor);
    // wireTaskbar intercepts the click to open the live palette instead.
    var start = el('<a id="axp-start" href="/run" aria-haspopup="dialog" aria-expanded="false"><span id="axp-cone" aria-hidden="true"></span>start<span class="axp-kbd" aria-hidden="true"></span></a>');
    bar.appendChild(start);
    // app buttons — first-level subpages, each opening as its own "window".
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
    // GENERATOR INPUT: scripts/gen-desktop-partial.mjs slices this expression by
    // its first line and its closing `</div>');`, then evals it to bake the tray
    // into lib/desktop.js. Keep it one string-concatenation expression with that
    // exact opening and closing shape; the generator throws if the marker moves.
    var tray = el('<div id="axp-tray">' +
      '<a id="axp-sysprop" class="axp-trayico" href="/whoareyou" data-kind="sysprop" title="System Properties · what one request reveals" aria-label="System Properties"><svg viewBox="0 0 24 24"><defs><filter id="spSh" x="-30%" y="-20%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="spBez" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3efe4"></stop><stop offset=".5" stop-color="#d6d0be"></stop><stop offset="1" stop-color="#b1aa94"></stop></linearGradient><linearGradient id="spScr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fb0e8"></stop><stop offset=".5" stop-color="#2f72b6"></stop><stop offset="1" stop-color="#16548f"></stop></linearGradient><linearGradient id="spGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".5"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#spSh)"><ellipse cx="12" cy="21.3" rx="5.2" ry="1" fill="#8f876f" opacity=".5"></ellipse><rect x="10.4" y="17.2" width="3.2" height="2.8" fill="#c3bca6"></rect><path d="M7 21 Q7 19.7 8.6 19.7 H15.4 Q17 19.7 17 21 Z" fill="url(#spBez)" stroke="#897f66" stroke-width=".4"></path><rect x="2.3" y="2.7" width="19.4" height="14.9" rx="2" fill="url(#spBez)" stroke="#857c63" stroke-width=".5"></rect><rect x="2.95" y="3.3" width="18.1" height="13.7" rx="1.5" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".5"></rect><rect x="4.2" y="4.7" width="15.6" height="11" rx=".8" fill="#0f3d63"></rect><rect x="4.6" y="5.1" width="14.8" height="10.2" rx=".6" fill="url(#spScr)"></rect><path d="M4.6 5.1 H19.4 V7.9 Q12 11.8 4.6 9.1 Z" fill="url(#spGl)"></path><circle cx="20" cy="15.9" r=".8" fill="#84e85a" stroke="#3f7a2a" stroke-width=".3"></circle></g></svg></a>' +
      '<a id="axp-security" class="axp-trayico" href="/security" data-kind="security" title="Security Center · what guards this site" aria-label="Security Center"><svg viewBox="0 0 24 24"><defs><filter id="seSh" x="-30%" y="-15%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="seF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ed24f"></stop><stop offset=".5" stop-color="#3f9c24"></stop><stop offset="1" stop-color="#297818"></stop></linearGradient><linearGradient id="seGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#seSh)"><path d="M12 2.2 L4.4 4.9 V11.4 C4.4 16.2 8 19.7 12 21.6 C16 19.7 19.6 16.2 19.6 11.4 V4.9 Z" fill="url(#seF)" stroke="#1f5f12" stroke-width=".7"></path><path d="M12 3.4 L5.6 5.7 V11.3 C5.6 15.3 8.6 18.4 12 20.1 C15.4 18.4 18.4 15.3 18.4 11.3 V5.7 Z" fill="none" stroke="#c6f2a6" stroke-opacity=".5" stroke-width=".6"></path><path d="M12 3.4 L5.6 5.7 V8.8 Q12 10.8 18.4 8.8 V5.7 Z" fill="url(#seGl)"></path><path d="M8 11.5 L11 14.5 L16.2 8.4" fill="none" stroke="#103f08" stroke-opacity=".35" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"></path><path d="M8 11.2 L11 14.2 L16.2 8.1" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></g></svg></a>' +
      '<a id="axp-updates" class="axp-trayico" href="/updates" data-kind="updates" title="Windows Update · what shipped lately" aria-label="Windows Update"><svg viewBox="0 0 24 24"><defs><filter id="upSh" x="-25%" y="-20%" width="150%" height="155%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><radialGradient id="upG" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="#8eccf2"></stop><stop offset=".55" stop-color="#3f8fd0"></stop><stop offset="1" stop-color="#175a98"></stop></radialGradient><linearGradient id="upB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#74cf52"></stop><stop offset="1" stop-color="#2c861d"></stop></linearGradient><radialGradient id="upGl" cx=".35" cy=".3" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".7"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></radialGradient></defs><g filter="url(#upSh)"><circle cx="10.6" cy="10.6" r="8.2" fill="url(#upG)" stroke="#114e7d" stroke-width=".6"></circle><g fill="none" stroke="#dcefff" stroke-width=".55" opacity=".7"><path d="M2.5 10.6 H18.7"></path><path d="M3.6 7.1 H17.6"></path><path d="M3.6 14.1 H17.6"></path><path d="M10.6 2.4 V18.8"></path><ellipse cx="10.6" cy="10.6" rx="3.1" ry="8.2"></ellipse></g><ellipse cx="7.4" cy="7" rx="3.4" ry="2.2" fill="url(#upGl)"></ellipse><circle cx="17.8" cy="17.8" r="4.5" fill="url(#upB)" stroke="#ffffff" stroke-width=".9"></circle><path d="M17.8 15.6 A2.2 2.2 0 1 1 15.7 18.4" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"></path><path d="M16.9 14.9 L18.8 15.3 L17.5 16.8 Z" fill="#ffffff"></path></g></svg></a>' +
      '<span id="axp-clock" aria-hidden="true"></span></div>');
    // mute/unmute speaker, inserted left of System Properties (painted by
    // wireTaskbar; ships empty here, the static partial ships the "on" art)
    var sndBtn = el('<button id="axp-sound" type="button"></button>');
    tray.insertBefore(sndBtn, tray.firstChild);
    bar.appendChild(tray);
    D.body.appendChild(bar);
    wireTaskbar(bar);
  }

  // behavior for the taskbar, whether adopted (static partial) or constructed.
  function wireTaskbar(bar) {
    var start = D.getElementById("axp-start");
    if (start) {
      // platform-correct shortcut hint + title (the static partial ships ⌘K;
      // non-Mac visitors get it rewritten here before they can notice)
      start.title = "Run — navigate the site (" + KBD + ")";
      [].forEach.call(start.querySelectorAll(".axp-kbd"), function (k) { k.textContent = KBD; });
      start.addEventListener("click", function (e) {
        e.preventDefault();   // the href is the JS-off floor; JS gets the palette
        // detail === 0 means the click came from the keyboard (Enter/Space on the
        // focused orb) rather than a pointer, so the ring is still wanted here.
        (run && run.open) ? closeRun() : openRun(e.detail === 0);
      });
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
        toggleBalloon(ic.getAttribute("data-kind"), ic);
      });
    });
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

  var ICON_STEP = 86;
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

  // build the desktop-shortcut layer on the wallpaper.
  // ADOPT-OR-BUILD: on pages carrying the static partial the icons already ship
  // at their default positions (inline left/top), so adopting is a no-op. The
  // construct path below runs on the two partial-less routes named at
  // buildTaskbar (/coffee and /serendipity).
  function buildIcons() {
    if (D.getElementById("axp-icons")) return;
    var wrap = el('<nav id="axp-icons" aria-label="desktop shortcuts"></nav>');
    DESKTOP.forEach(function (it, i) {
      var ext = it.kind === "profile";
      var a = el('<a class="axp-ico"' + (ext ? ' target="_blank" rel="noopener me external"' : "") +
        ' title="' + esc(it.hint || it.label) + (ext ? " (opens in a new tab)" : "") + '"></a>');
      a.href = it.path;
      a.dataset.key = it.label;
      a.style.left = "9px";
      a.style.top = (9 + i * ICON_STEP) + "px";
      var cls = it.kind === "note" ? "note" : "";
      var style = ext ? ' style="background:' + qlColor(it.icon || it.label) + '"' : "";
      var inner = ext ? qlGlyph(it.icon || it.label) : "";
      a.innerHTML = '<span class="ic ' + cls + '"' + style + " aria-hidden=\"true\">" + inner + "</span><span class=\"t\">" + esc(it.label) + "</span>";
      wrap.appendChild(a);
    });
    D.body.appendChild(wrap);
  }

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
    // a REAL <dialog> (phase C follow-up): showModal gives the native focus
    // trap, Esc handling, inert page, and focus restore — the hand-rolled
    // backdrop div, lastFocus juggling, and aria-modal claims all retire.
    run = el(
      '<dialog id="axp-run" aria-label="Run">' +
        '<div class="tb"><span>Run</span><span class="axp-kbd" aria-hidden="true">' + KBD + '</span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
        '<div class="body"><div class="ico" aria-hidden="true"><div class="doc"></div><div class="sw"></div></div>' +
          '<div class="prompt">Type the name of a page, photo, or profile, and <b>aadhar.sh</b> will open it for you.</div></div>' +
        '<div class="open-row"><label for="axp-run-in">Open:</label><input id="axp-run-in" type="text" autocomplete="off" spellcheck="false" placeholder="start typing… (e.g. garage, encoding, spotify, a photo)"></div>' +
        '<div class="list" id="axp-run-list" role="listbox" aria-label="destinations"></div>' +
        '<div class="btns"><button class="btn def" type="button" data-act="ok">OK</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>' +
      '</dialog>'
    );
    D.body.appendChild(run);
    // the preview card lives OUTSIDE the dialog and hoists into the top layer,
    // because the list is its own scroller and would otherwise clip it. Shown
    // after the modal opens, so it stacks above it.
    preview = el('<div id="axp-run-preview" popover="manual" aria-hidden="true"></div>');
    D.body.appendChild(preview);
    // ::backdrop click = light dismiss: a click landing on the dialog element
    // itself (not its children) can only be the backdrop-covered margin area
    run.addEventListener("click", function (e) { if (e.target === run) closeRun(); });
    // native close (Esc/cancel, or run.close()): one place for the side effects
    // native Esc fires cancel (then close) WITHOUT routing through closeRun, so
    // the card needs its own hook on that path too.
    run.addEventListener("cancel", function () { if (previewHoist) previewHoist.hide(); });
    run.addEventListener("close", function () {
      AXP_SND.play("close");
      if (previewHoist) previewHoist.hide();   // belt and braces with closeRun
      var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "false");
    });
    input = run.querySelector("#axp-run-in");
    list = run.querySelector("#axp-run-list");
    run.querySelector(".x").addEventListener("click", closeRun);
    run.querySelector('[data-act=cancel]').addEventListener("click", closeRun);
    run.querySelector('[data-act=ok]').addEventListener("click", function () { go(results[sel] || results[0]); });
    input.addEventListener("input", render);
    input.addEventListener("keydown", onKey);
    list.addEventListener("click", function (e) {
      var o = e.target.closest(".opt"); if (!o) return;
      // Navigable rows are anchors now. A MODIFIED click (⌘/ctrl/shift/alt, or any
      // non-primary button) is the user asking the browser for a new tab or window,
      // so let it reach the anchor untouched instead of collapsing it into a
      // same-tab go(). A plain click still routes through go(), which stays the one
      // funnel for accessories, raycast links and profiles alike.
      if (o.hasAttribute("href") && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
      e.preventDefault();
      go(results[+o.dataset.i]);
    });
    // XP list controls hot-track: the row under the cursor becomes the selection,
    // so OK / Enter act on whatever you're hovering (not a stale keyboard pick).
    list.addEventListener("mouseover", function (e) {
      var o = e.target.closest(".opt"); if (!o) return;
      setSel(+o.dataset.i);
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
        // A row that navigates to a same-origin path renders as a REAL anchor, and
        // the href is the whole point: `eagerness: "moderate"` starts a prerender
        // when the pointer rests on a LINK, so a <div> row could never be
        // prerendered no matter how long you hovered it. Every ⌘K navigation was
        // therefore a cold load. go() still owns the plain click (below), so the
        // href changes nothing about the funnel — it only makes the row visible to
        // the speculation rules, and gives ⌘/middle-click a real target for free.
        // Excluded on purpose: accessory rows open in-page and never navigate,
        // raycast rows are protocol deep links (unprerenderable, and a stray href
        // would let a modified click hand the OS a raw raycast:// URL), and profile
        // rows are cross-origin, which "/*" cannot match anyway.
        var navigable = g.it.path && g.it.path.charAt(0) === "/" &&
          g.it.kind !== "accessory" && g.it.kind !== "raycast" && g.it.kind !== "profile";
        html += "<" + (navigable ? "a" : "div") + ' class="opt" role="option" data-i="' + g.i + '"' +
          (navigable ? ' href="' + esc(g.it.path) + '"' : "") +
          (g.it.thumb ? ' data-thumb="' + esc(g.it.thumb) + '"' : "") +
          ' aria-selected="' + (g.i === sel) + '">' +
          '<span class="nm">' + esc(g.it.label) + "</span>" +
          (g.it.hint ? '<span class="ht">' + esc(g.it.hint) + "</span>" : "") +
          '<span class="pa">' + esc(g.it.kind === "profile" ? "↗" : g.it.kind === "raycast" ? "↗ raycast" : g.it.kind === "accessory" ? "↗ window" : g.it.path) + "</span>" +
          "</" + (navigable ? "a" : "div") + ">";
      });
    });
    list.innerHTML = html || '<div class="empty">No match. Try a page name, a photo stem, or a profile — or <a href="/photos">browse all photos</a>.</div>';
    // route the freshly-rendered selection through the one funnel, so a new
    // query re-points the preview card instead of stranding it on a dead row.
    setSel(sel);
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
        if (input && input.value.trim().toLowerCase() === qKey && run && run.open) render();
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
    setSel(Math.max(0, Math.min(results.length - 1, sel + d)));
  }

  // THE single selection funnel. Arrow keys, mouse hot-track, and render()'s
  // initial pick all route through here, which is what makes the preview card
  // honest: it is tethered to the SELECTED row, never the merely-hovered one, so
  // it can never show something that pressing Enter would not open.
  function setSel(i) {
    sel = i;
    var cur = null;
    [].forEach.call(list.querySelectorAll(".opt"), function (o) {
      var on = +o.dataset.i === sel;
      o.setAttribute("aria-selected", on);
      if (on) cur = o;
    });
    ensureVisible();
    showPreview(cur);
  }

  // ── Run preview card ────────────────────────────────────────────────────────
  // Only rows carrying data-thumb ever mount one (photos, and semantic hits that
  // resolve to an image); pages, profiles and notes never do. Nothing is fetched
  // until such a row is actually selected, and then it's the 400px AVIF tier the
  // photo grid already ships. The engine is the shared one in /hoist.js, driven
  // manually here: this surface follows SELECTION, not the cursor, so it passes
  // no findTarget and wires no listeners of its own.
  function showPreview(row) {
    if (!previewHoist) return;                     // module still loading, or coarse pointer
    var src = row && row.dataset ? row.dataset.thumb : "";
    if (!src) { previewHoist.hide(); return; }
    previewHoist.showAnchored(row);
  }
  function loadPreview() {
    if (previewHoist || previewLoading || !preview) return;
    previewLoading = true;
    import("/hoist.js").then(function (m) {
      previewHoist = m.createHoist({
        node: preview,
        followPointer: false,                      // anchored only; there is no cursor to glide with
        anchorName: "--axp-run-preview",
        contentFor: function (row) {
          var src = row.dataset.thumb;
          if (!src) return "";
          // width/height are reserved so the card never reflows as it decodes.
          return '<img src="' + esc(src) + '" alt="" width="400" height="400" decoding="async">';
        }
      });
      showPreview(list.querySelector('.opt[aria-selected=true]'));
    }).catch(function () { /* no preview is a fine outcome; Run still navigates */ });
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
    // Same ProMotion discipline as initIconDrag / initDrag: the gesture writes
    // TRANSFORM only (a pure compositor move, promoted by .axp-dragging's
    // will-change) and commits the final left/top once, on release. Writing
    // left/top per pointermove re-laid out this fixed window every frame — the
    // judder those two drags were already rewritten to avoid. rAF batching would
    // NOT help: pointermove is already frame-coalesced and getBoundingClientRect
    // is read once at pointerdown, so there is no read/write thrash to defer; it
    // would still force a layout per frame and diverge from the other two drags.
    // .axp-acc is position:fixed, so viewport left/top and transform are the same
    // coordinates, and it has no fixed-position descendants, so the transform's
    // new containing block changes nothing.
    tb.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".x")) return;
      accFront(win);
      var r = win.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
      var nx = ox, ny = oy;
      try { tb.setPointerCapture(e.pointerId); } catch (er) {}
      win.classList.add("axp-dragging");   // earn-it: will-change on for the gesture, off on drop
      function mv(ev) {
        nx = Math.max(0, Math.min(innerWidth - 40, ox + ev.clientX - sx));
        ny = Math.max(0, Math.min(innerHeight - 36, oy + ev.clientY - sy));
        win.style.transform = "translate(" + (nx - ox) + "px," + (ny - oy) + "px)";
      }
      function up() {
        win.style.left = nx + "px"; win.style.top = ny + "px";
        win.style.transform = "";
        win.classList.remove("axp-dragging");
        tb.removeEventListener("pointermove", mv);
        tb.removeEventListener("pointerup", up);
        tb.removeEventListener("pointercancel", up);   // a cancelled gesture otherwise leaks mv + strands the drag
      }
      tb.addEventListener("pointermove", mv);
      tb.addEventListener("pointerup", up);
      tb.addEventListener("pointercancel", up);
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
  // `viaKeyboard` decides whether the focused input shows its ring. The browser
  // otherwise guesses from how focus seemed to arrive, and a scripted focus() is
  // exactly the case its heuristic can't read: the SAME line serves ⌘K (mid
  // keyboard flow, the ring is the only thing saying where you landed) and a
  // click on Start (the pointer already said it, so the ring is noise).
  // focus({focusVisible}) is the option that lets the caller answer instead.
  // An engine without it ignores the member and keeps today's guess, so this
  // costs nothing where it isn't supported (Chrome 145, Safari 18.4, FF 104).
  function openRun(viaKeyboard) {
    if (!run) buildRun();
    if (run.open) return;
    if (!PHOTOS) loadPhotos().then(function () { if (run.open) render(); });
    if (!WRITING) loadWriting().then(function () { if (run.open) render(); });
    // the hover engine is fetched on the FIRST Run open, never on page load:
    // a visitor who never opens the palette never pays for it.
    loadPreview();
    run.showModal(); AXP_SND.play("open");
    var s = D.getElementById("axp-start"); if (s) s.setAttribute("aria-expanded", "true");
    input.value = ""; render();
    input.focus({ focusVisible: !!viaKeyboard });
  }
  function closeRun() {
    // The card is in the TOP LAYER, so if it outlives the dialog it floats over
    // a page with nothing to explain it. Hide it here rather than only on the
    // dialog's "close" event: that event is the tidy place for side effects, but
    // it is not guaranteed to reach us (it does not fire at all in some
    // embedded browser builds — measured), and a stranded card is too visible a
    // failure to hang on an event. Cheap and idempotent, so both paths can run.
    if (previewHoist) previewHoist.hide();
    if (run && run.open) run.close();   // other side effects ride the "close" event
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
      '<div class="ln"><b>Automatic Updates</b> <span class="ok">ON</span> <span class="k">immutable assets</span></div>' +
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
      run && run.open ? closeRun() : openRun(true);
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
      var b = e.target.closest && e.target.closest(".title-bar,.np-titlebar,.titlebar,#axp-run .tb");
      if (!b || e.target.closest("a,button,.controls,.np-controls,.x")) return;
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
  // serendipity, coffee…) is near-instant. This is the whole reason the View
  // Transition could come out: with the document already rendered at click time
  // there is nothing for an animation to cover, only latency to add. The
  // homepage is prerenderable now (its counter only
  // PEEKS on render; the tick left the document for the /hit beacon) and so is
  // /around (its crawl moved to a cron; a visit is a pure KV read).
  // excluded: /whoareyou (per-request fingerprint),
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
      var a = e.target.closest && e.target.closest("a.close");
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
      if (closeA) { closeA.setAttribute("href", "/"); closeA.title = "close to aadhar.sh"; closeA.setAttribute("aria-label", "close to aadhar.sh"); }
    }

    // back / forward, injected at the head of the title bar (excluded from title-bar
    // drag because they're <button>, which initDrag already skips).
    if (!bar.querySelector(".axp-histnav")) {
      var hn = el('<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button><button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>');
      bar.insertBefore(hn, bar.firstChild);
      var bBtn = hn.querySelector(".axp-back"), fBtn = hn.querySelector(".axp-fwd");
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
      bBtn.addEventListener("click", function () {
        if (realBack()) history.back();
        else if (!atRoot) location.href = parentPath;
      });
      fBtn.addEventListener("click", function () { history.forward(); });
      var sync = function () {
        if (!window.navigation) return;                 // no Navigation API -> leave both enabled
        var rb = navigation.canGoBack;
        bBtn.disabled = !rb && atRoot;                  // parent fallback keeps it live elsewhere
        bBtn.title = rb || atRoot ? "Back" : "Back to " + parentPath;
        bBtn.setAttribute("aria-label", bBtn.title);
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

  function boot() { ensureLunaCss(); buildDesktop(); buildIcons(); buildTaskbar(); initDrag(); initRaise(); initIconDrag(); initScrollbars(); initResize(); setFavicon(); injectSpeculation(); initCloseBack(); initWindowControls(); }
  function bootAfterStaticPaint() {
    // Generated/static pages and Worker-rendered shells already carry the desktop
    // and taskbar markup plus race-proof geometry in HTML. nav.js only ENHANCES
    // that shell (dragging, Run, clock, controls), so let its useful content paint
    // before doing the DOM wiring. Two frames guarantee one complete static paint;
    // pages without the server shell still build it synchronously as their fallback.
    // A prerendered document does not run animation frames while hidden. Enhance its
    // already-SSR'd shell now, so activation inherits a fully wired desktop instead
    // of paying both frames on the click that activates the prerender.
    const hasStaticShell = D.getElementById("axp-desktop") && D.getElementById("axp-taskbar");
    if (hasStaticShell) {
      if (D.prerendering) return boot();
      requestAnimationFrame(() => requestAnimationFrame(boot));
    }
    else boot();
  }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", bootAfterStaticPaint);
  else bootAfterStaticPaint();
})();
