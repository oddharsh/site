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

  /** @typedef {{ id: string, label: string, acc?: string, check?: () => boolean, fn: () => void }} MenuAction */
  /** @typedef {{ name: string, items: (MenuAction | "sep")[] }} MenuDefinition */
  /** @typedef {{ btn: HTMLElement, drop: HTMLElement, rows: HTMLElement[] }} OpenMenu */

  /** @param {string} h */
  function el(h) { var t = D.createElement("template"); t.innerHTML = h.trim(); return /** @type {HTMLElement} */ (t.content.firstChild); }
  // Intentional twins of nav.js's el()/esc(). nav.js and notepad.js are separate
  // top-level scripts, each minified on its own by Oxc in build.ts, so sharing
  // these ~250 bytes would cost either an import (a
  // second request on every /writing page) or a window global — and notepad.js is
  // deferred BEFORE nav.js, so nav's global isn't there yet when this runs. Keep the
  // two byte-identical instead: esc() escapes the double quote too, so it stays safe
  // in an attribute even though today's callers only use it in text.
  /** @param {string} s */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // Note popovers used to show and hide inside a same-document View Transition,
  // each one given its own `axp-note-<id>` transition name. That came out with the
  // rest of the View Transition machinery (2026-07-30): a popover is a top-layer
  // element that is already composited, so the transition bought a cross-fade at
  // the cost of a deferred callback and a frame of latency on every open and close.

  // Menu owns interaction; the caller owns actions and checkbox state. Keeping
  // it in this classic script costs no extra request or cross-script global.
  /** @type {(() => void) | null} */
  var closeActiveMenu = null;
  /** @param {HTMLElement} menubar @param {MenuDefinition[]} definitions */
  function Menu(menubar, definitions) {
    /** @type {OpenMenu | null} */
    var opened = null;
    /** @type {HTMLElement[]} */
    var buttons = [];
    menubar.replaceChildren();

    /** @param {boolean} [restore] */
    function close(restore) {
      var previous = opened;
      if (!previous) return;
      opened = null;
      closeActiveMenu = null;
      D.removeEventListener("click", outside);
      previous.btn.setAttribute("aria-expanded", "false");
      previous.drop.remove();
      if (restore) previous.btn.focus();
    }
    function outside() { close(); }
    /** @param {number} index */
    function focusButton(index) {
      buttons.forEach(function (button, i) { button.tabIndex = i === index ? 0 : -1; });
      buttons[index].focus();
    }
    /** @param {number} index @param {boolean} [last] */
    function open(index, last) {
      if (closeActiveMenu) closeActiveMenu();
      var definition = definitions[index], btn = buttons[index];
      var drop = el('<div class="np-drop" role="menu"></div>');
      drop.setAttribute("aria-label", definition.name);
      /** @type {HTMLElement[]} */
      var rows = [];
      definition.items.forEach(function (item) {
        if (item === "sep") { drop.appendChild(el('<div class="np-sep" role="separator"></div>')); return; }
        var checked = item.check ? item.check() : null;
        var row = el('<button type="button" class="np-item" tabindex="-1" role="' + (checked === null ? "menuitem" : "menuitemcheckbox") + '">' +
          '<span class="np-chk" aria-hidden="true">' + (checked ? "✓" : "") + "</span>" +
          '<span class="np-lbl">' + esc(item.label) + "</span>" +
          '<span class="np-acc">' + (item.acc ? esc(item.acc) : "") + "</span></button>");
        row.dataset.npAction = item.id;
        if (checked !== null) row.setAttribute("aria-checked", String(checked));
        row.addEventListener("click", function (e) { e.stopPropagation(); close(true); item.fn(); });
        rows.push(row);
        drop.appendChild(row);
      });
      focusButton(index);
      btn.setAttribute("aria-expanded", "true");
      btn.after(drop);
      drop.style.left = btn.offsetLeft + "px";
      opened = { btn: btn, drop: drop, rows: rows };
      closeActiveMenu = outside;
      D.addEventListener("click", outside);
      if (rows.length) rows[last ? rows.length - 1 : 0].focus();
    }
    definitions.forEach(function (definition, index) {
      var btn = el('<button type="button" role="menuitem" class="np-menu" aria-haspopup="menu" aria-expanded="false">' + esc(definition.name) + "</button>");
      btn.tabIndex = index === 0 ? 0 : -1;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (opened && opened.btn === btn) close(true);
        else open(index);
      });
      btn.addEventListener("mouseenter", function () { if (opened && opened.btn !== btn) open(index); });
      buttons.push(btn);
      menubar.appendChild(btn);
    });
    menubar.addEventListener("focusout", function (e) {
      if (!menubar.contains(/** @type {Node | null} */ (e.relatedTarget))) close();
    });
    menubar.addEventListener("keydown", function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var active = D.activeElement;
      var top = buttons.indexOf(/** @type {HTMLElement} */ (active));
      var rows = opened ? opened.rows : [];
      var row = rows.indexOf(/** @type {HTMLElement} */ (active));
      if (top < 0 && row < 0) return;
      var key = e.key, index = top >= 0 ? top : buttons.indexOf(/** @type {OpenMenu} */ (opened).btn);
      if (key === "Tab") { close(true); return; } // native Tab continues outside the composite
      if (key === "Escape") {
        if (!opened) return;
        close(true);
      } else if (key === "ArrowRight" || key === "ArrowLeft") {
        var next = (index + (key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        if (opened) open(next);
        else focusButton(next);
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (top >= 0) open(top, key === "ArrowUp");
        else rows[(row + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
      } else if (key === "Home" || key === "End") {
        if (top >= 0) focusButton(key === "Home" ? 0 : buttons.length - 1);
        else rows[key === "Home" ? 0 : rows.length - 1].focus();
      } else if ((key === "Enter" || key === " ") && top >= 0) {
        open(top);
      } else if (key.length === 1 && key !== " ") {
        var candidates = top >= 0 ? buttons : rows, from = top >= 0 ? top : row;
        for (var offset = 1; offset <= candidates.length; offset++) {
          var match = (from + offset) % candidates.length;
          var label = candidates[match].querySelector(".np-lbl") || candidates[match];
          if ((label.textContent || "").toLowerCase().startsWith(key.toLowerCase())) {
            if (top >= 0) focusButton(match);
            else candidates[match].focus();
            break;
          }
        }
      } else return; // native Enter/Space activates an action button exactly once
      e.preventDefault();
      e.stopPropagation();
    });
    return outside;
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
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (win.hidePopover) win.hidePopover();
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
  // Bare global: an undeclared `Temporal` cannot be handed to a parser without
  // throwing ReferenceError, so typeof is the only operator that can ask.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
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
      if (win.matches("[popover]") && win.hidePopover) win.hidePopover();
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
      // Both controls are authored in the literal above, before this detached box is exposed.
      /** @type {HTMLAnchorElement} */ (box.querySelector(".close")).addEventListener("click", close);
      /** @type {HTMLButtonElement} */ (box.querySelector(".np-btn")).addEventListener("click", close);
      D.body.appendChild(back); D.body.appendChild(box);
      /** @type {HTMLElement} */ (box.querySelector(".np-btn")).focus();
    }

    /** @type {MenuDefinition[]} */
    var MENUS = [
      { name: "File", items: [
        { id: "new", label: "New", acc: "Ctrl+N", fn: newDoc },
        { id: "open", label: "Open…", acc: "Ctrl+O", fn: function () { location.assign("/writing"); } },
        "sep",
        { id: "print", label: "Print…", acc: "Ctrl+P", fn: function () { window.print(); } },
        { id: "exit", label: "Exit", fn: exit }
      ] },
      { name: "Edit", items: [
        { id: "undo", label: "Undo", acc: "Ctrl+Z", fn: function () { ta.focus(); try { D.execCommand("undo"); } catch (e) {} } },
        "sep",
        { id: "select-all", label: "Select All", acc: "Ctrl+A", fn: selectAll },
        { id: "insert-date", label: "Time/Date", acc: "F5", fn: insertDate }
      ] },
      { name: "Format", items: [ { id: "word-wrap", label: "Word Wrap", check: function () { return wrap; }, fn: toggleWrap } ] },
      { name: "View", items: [ { id: "status-bar", label: "Status Bar", check: function () { return statusOn; }, fn: toggleStatus } ] },
      { name: "Help", items: [ { id: "about", label: "About Notepad", fn: about } ] }
    ];

    // ── keyboard shortcuts (only while editing) ────────────────────────────────
    ta.addEventListener("keydown", function (e) {
      if (e.key === "F5") { e.preventDefault(); insertDate(); }            // Notepad's date stamp (Ctrl+R still reloads)
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); window.print(); }
    });

    if (menubar) {
      var closeMenu = Menu(menubar, MENUS);
      // A manually closed note must not retain a detached menu or document listener.
      win.addEventListener("beforetoggle", function (e) { if (e.newState === "closed") closeMenu(); });
    }
    status();
  }

  // ── folder: open notes as popovers over the "selecting menu" ───────────────────
  // notes are popover="manual" (NOT auto) so several can stay open at once like
  // real windows — opening one doesn't light-dismiss the others. they cascade
  // down-and-right so each new one is offset; close with ✕ or Esc (topmost first).
  function initFolder() {
    var files = D.querySelector(".np-files");
    if (!files || !("showPopover" in HTMLElement.prototype)) return;   // no-JS / old → follow links

    files.addEventListener("click", function (/** @type {MouseEvent} */ e) {
      // let a modified / non-primary click through so the real /writing/<slug>
      // permalink still opens (Cmd/Ctrl-click new tab, middle-click, etc.).
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      var a = /** @type {Element} */ (e.target).closest("a[data-note]"); if (!a) return;
      var pop = D.getElementById("note-" + /** @type {HTMLElement} */ (a).dataset.note); if (!pop) return;
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
      var open = /** @type {NodeListOf<HTMLElement>} */ (D.querySelectorAll(".np-note:popover-open"));
      if (open.length) {
        e.preventDefault();
        open[open.length - 1].hidePopover();
      }
    }, true);
  }
  function openNote(pop) {
    enhance(pop); // Hidden notes acquire actions/listeners only when first opened.
    var ta = pop.querySelector(".np-text");
    // Order matters here: everything below focus() or measures the note, and a
    // popover is still `display:none` (writing.js's .np-note rule) until
    // showPopover() runs. That used to be a genuine trap — the whole body sat in
    // a startViewTransition callback precisely because the transition DEFERRED
    // it, so anything written outside the callback ran a frame early against a
    // hidden element and silently did nothing. With the transition gone the calls
    // simply run in order, which is the same guarantee without the indirection.
    if (pop.matches(":popover-open")) {                 // already open → raise + focus
      try { pop.hidePopover(); pop.showPopover(); } catch (_) {}
      if (ta) ta.focus();
      return;
    }
    var n = D.querySelectorAll(".np-note:popover-open").length;   // # already open → cascade step
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
  }

  [].forEach.call(D.querySelectorAll(".np-window:not([popover])"), enhance);
  initFolder();
})();
