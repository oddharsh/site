// One timezone for event labels and weekend filtering. Server-rendered times
// are labeled UTC; local formatting enhances them without personalizing the
// shared event fragment. Event detail pages load this same script.
(function () {
  /** @type {Intl.DateTimeFormat | null} */
  var dayFormat = null;
  /** @type {Intl.DateTimeFormat | null} */
  var clockFormat = null;
  try {
    var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone });
    clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" });
  } catch (error) {
    // If local formatting is unavailable, retain UTC labels AND UTC filtering.
    dayFormat = clockFormat = null;
  }

  function localizeTimes() {
    if (!dayFormat || !clockFormat) return;
    var day = dayFormat, clock = clockFormat;
    document.querySelectorAll("time[data-event-time]").forEach((time) => {
      var date = new Date(time.getAttribute("datetime") || "");
      if (!isNaN(date.getTime())) time.textContent = day.format(date) + " · " + clock.format(date);
    });
  }
  function isWeekend(s, now) {
    if (s < now || s > now + 8 * 864e5) return false;
    if (!dayFormat) { var w = new Date(s).getUTCDay(); return w === 0 || w === 6; }
    var weekday = dayFormat.formatToParts(new Date(s)).find((part) => part.type === "weekday");
    return weekday?.value === "Sat" || weekday?.value === "Sun";
  }

  /** @type {HTMLInputElement | null} */
  var search = document.querySelector("#ev-search");
  var chips = document.getElementById("ev-chips");
  var none = document.getElementById("ev-none"), tip = document.getElementById("ev-tip");
  var when = "all", editing = false;

  function paintChips() {
    if (!chips) return;
    Array.from(chips.children).forEach((chip) => {
      var selected = chip.getAttribute("data-when") === when;
      chip.classList.toggle("on", selected);
      chip.setAttribute("aria-pressed", String(selected));
    });
  }
  function restore() {
    var params = new URL(location.href).searchParams;
    if (search) search.value = params.get("q") || "";
    var value = params.get("when");
    when = value === "week" || value === "weekend" ? value : "all";
    editing = false;
    paintChips();
    apply();
  }
  function syncUrl(push) {
    var url = new URL(location.href);
    var q = search ? search.value : "";
    if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
    if (when === "all") url.searchParams.delete("when"); else url.searchParams.set("when", when);
    if (url.href === location.href) return;
    if (push) history.pushState(history.state, "", url.href);
    else history.replaceState(history.state, "", url.href);
  }
  function apply() {
    // Re-read after island hydration so filters typed before it arrives survive.
    var cards = document.querySelectorAll(".ev[href]"), grps = document.querySelectorAll(".grp[data-grp]");
    var q = ((search && search.value) || "").trim().toLowerCase(), now = Date.now(), wk = now + 7 * 864e5, shown = 0;
    cards.forEach((card) => {
      var c = /** @type {HTMLElement} */ (card);
      var okq = !q || (c.textContent || "").toLowerCase().indexOf(q) !== -1;
      var s = c.dataset.start ? new Date(c.dataset.start).getTime() : NaN, okw = true;
      if (when === "week") okw = !isNaN(s) && s >= now && s <= wk;
      else if (when === "weekend") okw = !isNaN(s) && isWeekend(s, now);
      var visible = okq && okw; c.hidden = !visible; if (visible) shown++;
    });
    grps.forEach((group) => {
      var g = /** @type {HTMLElement} */ (group);
      var any = false, n = g.nextElementSibling;
      while (n && !n.classList.contains("grp")) {
        if (n.classList.contains("ev") && !n.hasAttribute("hidden")) { any = true; break; }
        n = n.nextElementSibling;
      }
      g.hidden = !any;
    });
    if (none) none.style.display = shown || !cards.length ? "none" : "block";
  }
  document.addEventListener("island", () => { localizeTimes(); apply(); });
  if (search) {
    search.addEventListener("input", () => {
      // One history entry per typing session, rather than one per keystroke.
      syncUrl(!editing);
      editing = true;
      apply();
    });
    search.addEventListener("blur", () => { editing = false; });
  }
  if (chips) chips.addEventListener("click", (event) => {
    var target = /** @type {HTMLElement} */ (event.target);
    var button = target.closest(".chip");
    if (!button) return;
    when = button.getAttribute("data-when") || "all";
    editing = false;
    paintChips();
    syncUrl(true);
    apply();
  });
  if (search || chips) window.addEventListener("popstate", restore);
  localizeTimes();
  restore();

  // Keep the existing shared cover-tooltip engine and its deferred import.
  if (tip && !matchMedia("(hover: none)").matches) {
    var tipNode = tip;
    import("/hoist.js").then((m) => {
      m.createHoist({
        node: tipNode,
        anchorName: "--ev-tip",
        findTarget: (el) => { return el instanceof Element ? el.closest(".ev[data-cover]") : null; },
        contentFor: (anchor) => {
          var url = anchor.getAttribute("data-cover");
          return url ? '<img decoding="async" alt="" src="' + url.replace(/"/g, "&quot;") + '">' : "";
        },
      });
    }).catch(() => {}); // The event list still works without cover tooltips.
  }
})();
