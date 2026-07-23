// notepad.js — behavior for the /writing Notepad view. The window chrome, menu
// bar, textarea (seeded with the canonical text) and status bar are server-rendered
// by _worker.js; this just wires the authentic Notepad interactions. Deferred,
// short-cached with SWR, and a no-op on any page without a .np-window.
//
// The text is a real <textarea>: editable by nature, and ephemeral by nature — there
// is no save, so a reload re-seeds it from the server's canonical copy. That IS the
// feature (writing in flux); nothing here persists edits.
//
// The /writing folder inlines every note as a popover .np-window; clicking a file
// composites the note OVER the folder ("selecting menu") with no navigation and
// without touching the address bar. That is deliberate: notes are popover="manual"
// so several stay open at once (cascaded, Esc closes the topmost), and one URL
// cannot honestly name three open windows — pushState would also trap Back, since
// five open notes would mean six Backs to leave the site. An XP folder opening a
// Notepad window never drove the address bar either.
//
// The permalink is real without it: every row IS an <a href="/writing/<slug>">
// that the worker serves as a standalone page, and a modified click (Cmd/Ctrl,
// middle, shift) passes straight through to it. Each window is enhanced
// independently — hence the per-window enhance() below.
(function () {
  "use strict";
  var D = document;

  function el(h) { var t = D.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; }
  // Intentional twins of nav.js's el()/esc(). nav.js and notepad.js are separate
  // top-level scripts, each minified on its own (build.mjs runs esbuild `transform`,
  // never `bundle`), so sharing these ~250 bytes would cost either an import (a
  // second request on every /writing page) or a window global — and notepad.js is
  // deferred BEFORE nav.js, so nav's global isn't there yet when this runs. Keep the
  // two byte-identical instead: esc() escapes the double quote too, so it stays safe
  // in an attribute even though today's callers only use it in text.
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // Same-document popover transitions are tagged "axp-dialog" so luna.css cancels
  // the axp-window minimize/restore for them: .np-folder is itself a .np-window, so
  // an untyped transition pulsed the whole folder every time a note opened.
  function withViewTransition(fn, types) {
    if (D.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return types ? D.startViewTransition({ update: fn, types: types }) : D.startViewTransition(fn);
    }
    return fn();
  }
  function nameNoteTransition(pop) {
    if (!pop.id) return;
    pop.style.viewTransitionName = "axp-note-" + pop.id.replace(/[^a-z0-9_-]/gi, "-");
  }

  // ── per-window enhancement ────────────────────────────────────────────────────
  function enhance(win) {
    if (!win || win.__np) return; win.__np = true;
    var ta = win.querySelector(".np-text");
    var menubar = win.querySelector(".np-menubar");
    var statusEl = win.querySelector(".np-status");
    var posEl = win.querySelector(".np-pos");
    var wcEl = win.querySelector(".np-wc");
    // a popover note's close button hides the popover instead of navigating
    var closeBtn = win.querySelector(".np-controls .close[data-pop]");
    if (closeBtn && win.matches("[popover]")) {
      nameNoteTransition(win);
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (win.hidePopover) withViewTransition(function () { win.hidePopover(); }, ["axp-dialog"]);
      });
    }
    if (!ta) return;   // folder index has no textarea — nothing more to wire

    var wrap = ta.getAttribute("wrap") !== "off";   // default on (readable prose)
    var statusOn = true;

    // ── status bar: Ln/Col + word count (live) ────────────────────────────────
    function status() {
      if (posEl) {
        var c = ta.selectionStart, before = ta.value.slice(0, c);
        var nl = before.lastIndexOf("\n");
        posEl.textContent = "Ln " + (before.split("\n").length) + ", Col " + (c - nl);
      }
      if (wcEl) {
        var words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
        wcEl.textContent = words + (words === 1 ? " word" : " words");
      }
    }
    ["keyup", "click", "input", "select", "focus"].forEach(function (e) { ta.addEventListener(e, status); });

    // ── actions ──────────────────────────────────────────────────────────────
    function toggleWrap() { wrap = !wrap; ta.setAttribute("wrap", wrap ? "soft" : "off"); ta.classList.toggle("nowrap", !wrap); }
    function toggleStatus() { statusOn = !statusOn; if (statusEl) statusEl.style.display = statusOn ? "" : "none"; }
    function selectAll() { ta.focus(); ta.select(); }
    function insertDate() {
      // classic Notepad F5: "h:mm AM/PM M/D/YYYY". Prefer Temporal where the
      // browser ships it; fall back to Date everywhere else.
      var Y, Mo, Da, H, Mi;
      try {
        if (typeof Temporal !== "undefined" && Temporal.Now && Temporal.Now.plainDateTimeISO) {
          var z = Temporal.Now.plainDateTimeISO();
          Y = z.year; Mo = z.month; Da = z.day; H = z.hour; Mi = z.minute;
        }
      } catch (e) {}
      if (Y === undefined) {
        var d = new Date(); Y = d.getFullYear(); Mo = d.getMonth() + 1; Da = d.getDate(); H = d.getHours(); Mi = d.getMinutes();
      }
      var ap = H < 12 ? "AM" : "PM", hh = H % 12 || 12;
      var stamp = hh + ":" + String(Mi).padStart(2, "0") + " " + ap + " " + Mo + "/" + Da + "/" + Y;
      var s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + stamp + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + stamp.length;
      ta.focus(); status();
    }
    function newDoc() { ta.value = ""; ta.focus(); status(); }   // a fresh scratch (unsaved, like everything here)
    function exit() {
      if (win.matches("[popover]") && win.hidePopover) withViewTransition(function () { win.hidePopover(); }, ["axp-dialog"]);
      else location.assign("/writing");
    }
    function about() {
      if (D.querySelector(".np-about")) return;
      var box = el(
        '<div class="np-about" role="dialog" aria-label="About Notepad">' +
          '<div class="np-titlebar"><span class="np-ico"></span><span class="np-title">About Notepad</span>' +
            '<span class="np-controls"><a class="close" href="#" aria-label="Close">✕</a></span></div>' +
          '<div class="np-about-body"><p><b>Notepad</b>, a resto-mod of the Windows&nbsp;XP app.</p>' +
          '<p>This is a real text field: edit it however you like. Nothing saves, so a reload restores my canonical version. The writing here is always in flux.</p>' +
          '<div class="np-about-btns"><button type="button" class="np-btn">OK</button></div></div></div>'
      );
      var back = el('<div class="np-modal-back"></div>');
      function close(e) { if (e) e.preventDefault(); box.remove(); back.remove(); }
      back.addEventListener("click", close);
      box.querySelector(".close").addEventListener("click", close);
      box.querySelector(".np-btn").addEventListener("click", close);
      D.body.appendChild(back); D.body.appendChild(box);
      box.querySelector(".np-btn").focus();
    }

    var MENUS = [
      { name: "File", items: [
        { label: "New", acc: "Ctrl+N", fn: newDoc },
        { label: "Open…", acc: "Ctrl+O", fn: function () { location.assign("/writing"); } },
        "sep",
        { label: "Print…", acc: "Ctrl+P", fn: function () { window.print(); } },
        { label: "Exit", fn: exit }
      ] },
      { name: "Edit", items: [
        { label: "Undo", acc: "Ctrl+Z", fn: function () { ta.focus(); try { D.execCommand("undo"); } catch (e) {} } },
        "sep",
        { label: "Select All", acc: "Ctrl+A", fn: selectAll },
        { label: "Time/Date", acc: "F5", fn: insertDate }
      ] },
      { name: "Format", items: [ { label: "Word Wrap", check: function () { return wrap; }, fn: toggleWrap } ] },
      { name: "View", items: [ { label: "Status Bar", check: function () { return statusOn; }, fn: toggleStatus } ] },
      { name: "Help", items: [ { label: "About Notepad", fn: about } ] }
    ];

    // ── menu bar ───────────────────────────────────────────────────────────────
    var openMenu = null;
    function closeMenu() { if (openMenu) { openMenu.btn.setAttribute("aria-expanded", "false"); openMenu.drop.remove(); openMenu = null; } }
    function buildMenus() {
      if (!menubar) return;
      menubar.innerHTML = "";
      MENUS.forEach(function (m) {
        var btn = el('<button type="button" role="menuitem" class="np-menu" aria-haspopup="true" aria-expanded="false">' + esc(m.name) + "</button>");
        btn.addEventListener("click", function (e) { e.stopPropagation(); var was = openMenu && openMenu.btn === btn; closeMenu(); if (!was) open(m, btn); });
        btn.addEventListener("mouseenter", function () { if (openMenu && openMenu.btn !== btn) { closeMenu(); open(m, btn); } });
        menubar.appendChild(btn);
      });
      D.addEventListener("click", closeMenu);
      D.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
    }
    function open(m, btn) {
      var drop = el('<div class="np-drop" role="menu"></div>');
      m.items.forEach(function (it) {
        if (it === "sep") { drop.appendChild(el('<div class="np-sep"></div>')); return; }
        var checked = it.check ? it.check() : null;
        var row = el('<button type="button" class="np-item" role="menuitem">' +
          '<span class="np-chk">' + (checked ? "✓" : "") + "</span>" +
          '<span class="np-lbl">' + esc(it.label) + "</span>" +
          '<span class="np-acc">' + (it.acc ? esc(it.acc) : "") + "</span></button>");
        row.addEventListener("click", function (e) { e.stopPropagation(); closeMenu(); it.fn(); });
        drop.appendChild(row);
      });
      btn.setAttribute("aria-expanded", "true");
      btn.parentNode.appendChild(drop);
      drop.style.left = btn.offsetLeft + "px";
      openMenu = { btn: btn, drop: drop };
    }

    // ── keyboard shortcuts (only while editing) ────────────────────────────────
    ta.addEventListener("keydown", function (e) {
      if (e.key === "F5") { e.preventDefault(); insertDate(); }            // Notepad's date stamp (Ctrl+R still reloads)
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); window.print(); }
    });

    buildMenus();
    status();
  }

  // ── folder: open notes as popovers over the "selecting menu" ───────────────────
  // notes are popover="manual" (NOT auto) so several can stay open at once like
  // real windows — opening one doesn't light-dismiss the others. they cascade
  // down-and-right so each new one is offset; close with ✕ or Esc (topmost first).
  function initFolder() {
    var files = D.querySelector(".np-files");
    if (!files || !("showPopover" in HTMLElement.prototype)) return;   // no-JS / old → follow links

    files.addEventListener("click", function (e) {
      // let a modified / non-primary click through so the real /writing/<slug>
      // permalink still opens (Cmd/Ctrl-click new tab, middle-click, etc.).
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      var a = e.target.closest("a[data-note]"); if (!a) return;
      var pop = D.getElementById("note-" + a.dataset.note); if (!pop) return;
      e.preventDefault();
      openNote(pop);
    });

    // manual popovers don't close on Esc, so wire it to close the topmost note.
    // capture phase, so we see an open menu BEFORE its own bubble-phase Esc
    // handler removes it: if a .np-drop menu is open, that Escape belongs to the
    // menu, so leave the note alone (a second Escape then closes the note).
    D.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (D.querySelector(".np-drop")) return;
      var open = D.querySelectorAll(".np-note:popover-open");
      if (open.length) {
        e.preventDefault();
        withViewTransition(function () { open[open.length - 1].hidePopover(); }, ["axp-dialog"]);
      }
    }, true);
  }
  function openNote(pop) {
    nameNoteTransition(pop);
    var ta = pop.querySelector(".np-text");
    // Anything that needs the note to be VISIBLE must live inside the transition
    // callback: startViewTransition defers it, so a focus() or a measure out here
    // runs while the popover is still `display:none` (writing.js's .np-note rule)
    // and silently does nothing. Only the reduced-motion path, where
    // withViewTransition calls fn synchronously, ever worked.
    if (pop.matches(":popover-open")) {                 // already open → raise + focus
      withViewTransition(function () {
        try { pop.hidePopover(); pop.showPopover(); } catch (_) {}
        if (ta) ta.focus();
      }, ["axp-dialog"]);
      return;
    }
    var n = D.querySelectorAll(".np-note:popover-open").length;   // # already open → cascade step
    withViewTransition(function () {
      try { pop.showPopover(); } catch (_) { return; }
      var folder = D.querySelector(".np-folder");
      var bx = (folder ? folder.getBoundingClientRect().left : 16) + 32;
      var by = (folder ? folder.getBoundingClientRect().top : 8) + 30;
      var step = 26;
      var x = Math.max(8, Math.min(bx + n * step, innerWidth - pop.offsetWidth - 8));
      var y = Math.max(8, Math.min(by + n * step, innerHeight - 30 - 90));
      pop.style.margin = "0"; pop.style.right = "auto"; pop.style.left = x + "px"; pop.style.top = y + "px";
      if (ta) ta.focus();
      window.dispatchEvent(new Event("resize"));   // nudge the custom scrollbar to (re)measure now it's visible
    }, ["axp-dialog"]);
  }

  [].forEach.call(D.querySelectorAll(".np-window"), enhance);
  initFolder();
})();
