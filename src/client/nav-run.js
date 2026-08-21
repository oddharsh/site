// nav-run.js — first-interaction island for the Run palette and accessories.
// Static shell links remain the no-JS and failed-module fallback.

/**
 * @typedef {object} RunItem
 * @property {string} label
 * @property {string} [path]
 * @property {string} [url]
 * @property {string} [hint]
 * @property {string} [kind]
 * @property {string} [accId]
 * @property {string} [icon]
 * @property {(body: HTMLElement) => void} [build]
 */

export function createRun(options) {
  var D = document;
  var kbd = options.kbd;
  var sound = options.sound;
  var loadPhotos = options.loadPhotos;
  var loadWriting = options.loadWriting;
  var front = options.front;
  var run, input, list, results = [], sel = -1, lastQuery = null, semantic = { q: "", items: [] }, searchTimer = null;
  var preview = null, previewHoist = null, previewLoading = false;
  var PHOTOS = null, WRITING = null;

  /** @returns {HTMLElement} */
  function el(html) {
    var t = D.createElement("template");
    t.innerHTML = html.trim();
    var node = t.content.firstElementChild;
    if (!(node instanceof HTMLElement)) throw new Error("Run island template must produce an element");
    return node;
  }
  // The two escapes below are genuinely unnecessary (`\"` inside a character
  // class and inside a single-quoted string), and they stay. This file is a
  // CONTENT-HASHED shell asset: measured 2026-08-14, correcting them moved
  // /a/nav-run.e943e545.js to /a/nav-run.b5389c82.js, which re-minted every
  // page that references it, every per-page dictionary, and _headers: 1400+
  // built files for two backslashes. A comment costs nothing, because
  // oxc-minify strips it and the hash holds. Fix it the next time this
  // function changes for a real reason.
  // oxlint-disable-next-line no-useless-escape
  function esc(s) { return String(s).replace(/[&<>\"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]; }); }
  function tag(kind, o) { o.kind = kind; return o; }

  /** @type {RunItem[]} */
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
    { label: "terminal", path: "/terminal", hint: "terminal utilities — curl them, or drive them by keypress" },
    { label: "finger", path: "/finger", hint: "who runs this host — drivable by keypress" },
    { label: "radar", path: "/radar", hint: "signal readings in, a terminal instrument out" },
    { label: "dict", path: "/dict", hint: "compression dictionary lint — will a browser ever use it?" },
    { label: "cache", path: "/cache", hint: "behavioral revalidation lint — does your ETag ever 304?" },
    { label: "encode", path: "/encode", hint: "what did your encoder actually do?" },
    { label: "agent ready", path: "/agent-ready", hint: "the scorecard, pointed at anyone including us" },
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
    { label: "lwe · lean", path: "/lwe/lean", hint: "lean, formal verification, specs, verified compilers, kernel soundness, openai ten-proofs" },
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
    { label: "garage · dyno", path: "/garage/dyno", hint: "what this site weighs on the wire, one pull a night" },
    { label: "garage · octane", path: "/garage/octane", hint: "what a framework's floor costs against no framework" },
    { label: "garage · pretext", path: "/garage/pretext", hint: "DOM-free text measurement" },
    { label: "garage · pqc", path: "/garage/pqc", hint: "what a PQ signature costs in bytes and milliseconds" },
    { label: "garage · user-agent", path: "/garage/useragent", hint: "what a crawler name is worth when nothing verifies it" },
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
  /** @type {RunItem[]} */
  var PROFILES = [
    // generated:run-profiles:start
    { label: "GitHub", url: "https://github.com/oddharsh" },
    { label: "Twitter", url: "https://x.com/oddhash" },
    { label: "Photos", icon: "Instagram", hint: "Instagram", url: "https://www.instagram.com/aadharsh.hif" },
    { label: "Curius", url: "https://curius.app/aadharsh-pannirselvam" },
    { label: "Beli", url: "https://beliapp.com/users/aadharsh" },
    { label: "Music", icon: "Spotify", hint: "Spotify", url: "https://open.spotify.com/user/aadharsh2010" }
    // generated:run-profiles:end
  ];
  PAGES.forEach(function (p) { if (!p.kind) tag("page", p); });
  PROFILES.forEach(function (p) { p.path = p.url; tag("profile", p); });

  function buildRun() {
    // a REAL <dialog> (phase C follow-up): showModal gives the native focus
    // trap, Esc handling, inert page, and focus restore — the hand-rolled
    // backdrop div, lastFocus juggling, and aria-modal claims all retire.
    run = el(
      '<dialog id="axp-run" aria-label="Run">' +
        '<div class="tb"><span>Run</span><span class="axp-kbd" aria-hidden="true">' + kbd + '</span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
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
      sound.play("close");
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
          if (!(row instanceof HTMLElement)) return "";
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
  var ACC_OPEN = {};

  /** @type {RunItem[]} */
  var ACCESSORIES = [
    { label: "Clock", hint: "the current time, ticking", kind: "accessory", accId: "clock", path: "", icon: "🕐", build: buildClock }
  ];
  function accFront(win) { front(win); }
  function openAccessory(id) {
    var a = ACCESSORIES.filter(function (x) { return x.accId === id; })[0]; if (!a) return;
    if (ACC_OPEN[id]) { accFront(ACC_OPEN[id].win); return; }
    sound.play("open");
    var n = Object.keys(ACC_OPEN).length;
    var win = el('<div class="axp-acc"><div class="tb"><span class="ic" aria-hidden="true">' + a.icon + '</span><span class="t">' + a.label + '</span><span class="x" role="button" title="close" aria-label="close">✕</span></div><div class="bd"></div></div>');
    win.style.left = Math.max(8, Math.min(innerWidth - 200, 86 + n * 24)) + "px";
    win.style.top = Math.max(8, 64 + n * 24) + "px";
    D.body.appendChild(win);
    var bd = /** @type {HTMLElement & {_iv?: number}} */ (win.querySelector(".bd"));
    if (!bd) throw new Error("Accessory window is missing its body");
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
    if (!(tb instanceof HTMLElement)) throw new Error("Accessory window is missing its title bar");
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
    tb.addEventListener("pointerdown", function (/** @type {PointerEvent} */ e) {
      if (e.target instanceof Element && e.target.closest(".x")) return;
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
    if (!PHOTOS) loadPhotos().then(function (items) { PHOTOS = items; if (run.open) render(); });
    if (!WRITING) loadWriting().then(function (items) { WRITING = items; if (run.open) render(); });
    // the hover engine is fetched on the FIRST Run open, never on page load:
    // a visitor who never opens the palette never pays for it.
    loadPreview();
    run.showModal(); sound.play("open");
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

  return {
    open: openRun,
    close: closeRun,
    isOpen: function () { return !!(run && run.open); }
  };
}
