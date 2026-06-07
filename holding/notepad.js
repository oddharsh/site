// notepad.js — behavior for the /writing Notepad view. The window chrome, menu
// bar, textarea (seeded with the canonical text) and status bar are server-rendered
// by _worker.js; this just wires the authentic Notepad interactions. Deferred,
// SW-cached, and a no-op on any page without a .np-window.
//
// The text is a real <textarea>: editable by nature, and ephemeral by nature — there
// is no save, so a reload re-seeds it from the server's canonical copy. That IS the
// feature (writing in flux); nothing here persists edits.
(function () {
  "use strict";
  var D = document;
  var win = D.querySelector(".np-window");
  if (!win || win.__np) return; win.__np = true;
  var ta = win.querySelector(".np-text");
  var menubar = win.querySelector(".np-menubar");
  var statusEl = win.querySelector(".np-status");
  var posEl = win.querySelector(".np-pos");
  var wcEl = win.querySelector(".np-wc");
  if (!ta) return;

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

  // ── actions ────────────────────────────────────────────────────────────────
  function toggleWrap() {
    wrap = !wrap;
    ta.setAttribute("wrap", wrap ? "soft" : "off");
    ta.classList.toggle("nowrap", !wrap);
  }
  function toggleStatus() {
    statusOn = !statusOn;
    if (statusEl) statusEl.style.display = statusOn ? "" : "none";
  }
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
  function about() {
    if (D.querySelector(".np-about")) return;
    var box = el(
      '<div class="np-about" role="dialog" aria-label="About Notepad">' +
        '<div class="np-titlebar"><span class="np-ico"></span><span class="np-title">About Notepad</span>' +
          '<span class="np-controls"><a class="close" href="#" aria-label="Close">✕</a></span></div>' +
        '<div class="np-about-body"><p><b>Notepad</b> — a resto-mod of the Windows&nbsp;XP app.</p>' +
        '<p>This is a real text field: edit it however you like. Nothing saves — reload and the page restores my canonical version. The writing here is always in flux.</p>' +
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
      { label: "Exit", fn: function () { location.assign("/writing"); } }
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

  // ── menu bar ────────────────────────────────────────────────────────────────
  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.btn.setAttribute("aria-expanded", "false"); openMenu.drop.remove(); openMenu = null; } }
  function buildMenus() {
    if (!menubar) return;
    menubar.innerHTML = "";
    MENUS.forEach(function (m) {
      var btn = el('<button type="button" class="np-menu" aria-haspopup="true" aria-expanded="false">' + esc(m.name) + "</button>");
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

  // ── keyboard shortcuts (only while editing) ──────────────────────────────────
  ta.addEventListener("keydown", function (e) {
    if (e.key === "F5") { e.preventDefault(); insertDate(); }            // Notepad's date stamp (Ctrl+R still reloads)
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); window.print(); }
  });

  function el(h) { var t = D.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  buildMenus();
  status();
})();
