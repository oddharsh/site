// lens-boot.js — keep the complete server-rendered /lens idle shell idle.
// The full client arrives for URL state, a persisted non-default view, or the
// first interaction. Capture listeners replay that first action after import(),
// so a cold click cannot race the client that owns it.
(function () {
  "use strict";

  var app = null;
  var ready = false;
  var replaying = false;

  function load() {
    if (!app) {
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

  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("focusin", warm, { passive: true });
  document.addEventListener("click", click, true);
  document.addEventListener("submit", submit, true);

  if (hasClientState()) load().catch(function () {});
})();
