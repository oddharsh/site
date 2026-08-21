// lens-boot.js — keep the complete server-rendered /lens idle shell idle.
// The full client arrives for URL state, a persisted non-default view, or the
// first interaction with the Lens UI. Capture listeners replay that first
// action after import(), so a cold click cannot race the client that owns it.
// They are bound to the Lens content root rather than the document, so the
// desktop shell's own controls never wait on a module they do not use.
(function () {
  "use strict";

  var app = null;
  var ready = false;
  var replaying = false;

  function load() {
    if (!app) {
      // @ts-expect-error — a CACHE-BUSTED specifier. "/lens.js?v=1" is a real URL
      // the browser resolves and no path mapping can match. Pointing tsc at the
      // file instead answers "is not a module", because lens.js is a classic
      // script IIFE, and the fix for THAT would be adding an `export {}` that
      // changes it from script scope to module scope for a type checker. This is
      // a side-effect import. @ts-expect-error rather than @ts-ignore so it fails
      // the day the situation changes.
      app = import("/lens.js?v=1").then(function () {
        ready = true;
      }, function (error) {
        app = null;
        throw error;
      });
    }
    return app;
  }

  function hasClientState() {
    var params = new URLSearchParams(location.search);
    if (["url", "vs", "view", "lens", "cf"].some(function (key) { return params.has(key); })) return true;
    try {
      var saved = localStorage.getItem("lx-mode");
      return !!saved && saved !== "both";
    } catch (error) {
      return false;
    }
  }

  function control(event) {
    return event.target && event.target.closest && event.target.closest("button,input,select,textarea");
  }

  function warm(event) {
    if (control(event)) load().catch(function () {});
  }

  function click(event) {
    var button = event.target && event.target.closest && event.target.closest("button");
    if (!button || ready || replaying) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var replay = function () {
      replaying = true;
      button.click();
      replaying = false;
    };
    load().then(replay, replay);
  }

  function submit(event) {
    if (ready || replaying) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var form = event.target;
    var submitter = event.submitter;
    var replay = function () {
      replaying = true;
      form.requestSubmit(submitter || undefined);
      replaying = false;
    };
    // A failed import still replays into the form's native GET fallback.
    load().then(replay, replay);
  }

  // SCOPED TO THE LENS UI, never to the document, and that is the whole reason
  // this block reads the DOM before it listens. `click` runs in the capture
  // phase and calls stopImmediatePropagation, so whatever it matches, no other
  // handler sees until the client has loaded. The desktop shell owns real
  // <button> elements of its own: nav.js injects Back and Forward into every
  // window title bar, which lives OUTSIDE .content. On the document those were
  // swallowed too, so the first press of Back on the idle shell downloaded the
  // whole Lens client before the browser would navigate, a module the visitor
  // was leaving the page to avoid needing. Scoping is default-deny: a control
  // the shell grows later sits outside this root and passes straight through.
  var form = document.getElementById("lx-form");
  var root = form && (form.closest(".content") || form.parentNode);
  if (!root) return; // no Lens UI here, and lens.js bails on the same element

  root.addEventListener("pointerover", warm, { passive: true });
  root.addEventListener("focusin", warm, { passive: true });
  root.addEventListener("click", click, true);
  root.addEventListener("submit", submit, true);

  if (hasClientState()) load().catch(function () {});
})();
