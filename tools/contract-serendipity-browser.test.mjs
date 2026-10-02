// Run the shipped client against a small document/history fixture. No browser,
// network, or shared process timezone is needed to exercise the date boundary.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../src/client/serendipity.js", import.meta.url), "utf8");

class ElementFixture {
  /** @type {ElementFixture | null} */
  nextElementSibling = null;
  /** @type {ElementFixture[]} */
  children = [];
  /** @type {Record<string, (event: any) => void>} */
  listeners = {};
  hidden = false;
  value = "";
  style = { display: "" };
  /** @type {Record<string, string>} */
  dataset = {};
  /** @param {Record<string, string>} attrs */
  constructor(attrs = {}, text = "") {
    this.attrs = attrs;
    this.textContent = text;
    this.classes = new Set((attrs.class || "").split(" "));
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    };
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  hasAttribute(name) { return name === "hidden" ? this.hidden : name in this.attrs; }
  closest(selector) { return selector === ".chip" && this.classes.has("chip") ? this : null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

const fixtureEvent = (name, start) => {
  const card = new ElementFixture({ class: "ev" }, name);
  card.dataset.start = start;
  return { card, time: new ElementFixture({ datetime: start }, "UTC fallback") };
};

function browser({ url = "https://aadhar.sh/serendipity", zone = "America/New_York", now = "2026-10-02T12:00:00Z", events = [fixtureEvent("NYC Friday", "2026-10-03T01:00:00Z"), fixtureEvent("NYC Saturday", "2026-10-03T16:00:00Z")], intlFails = false, detail = false } = {}) {
  const search = new ElementFixture(), chips = new ElementFixture();
  chips.children = ["all", "week", "weekend"].map((value) => new ElementFixture({ class: "chip", "data-when": value }));
  const none = new ElementFixture(), group = new ElementFixture({ class: "grp" });
  let pool = events;
  /** @type {Record<string, () => void>} */
  const docListeners = {}, winListeners = {};
  const location = { href: url }, entries = [url];
  let index = 0;
  const history = {
    state: { preserved: true },
    pushState(state, _title, href) { assert.equal(state, this.state); entries.splice(++index); entries.push(href); location.href = href; },
    replaceState(state, _title, href) { assert.equal(state, this.state); entries[index] = href; location.href = href; },
  };
  const document = {
    querySelector: () => detail ? null : search,
    getElementById: (id) => detail ? null : ({ "ev-chips": chips, "ev-none": none }[id] || null),
    querySelectorAll: (selector) => {
      if (selector === "time[data-event-time]") return pool.map((e) => e.time);
      if (selector === ".ev[href]") return detail ? [] : pool.map((e) => e.card);
      if (selector === ".grp[data-grp]") return detail ? [] : [group];
      throw new Error(`Unexpected selector ${selector}`);
    },
    addEventListener: (name, fn) => { docListeners[name] = fn; },
  };
  const linkCards = () => {
    group.nextElementSibling = pool[0]?.card || null;
    pool.forEach((e, i) => { e.card.nextElementSibling = pool[i + 1]?.card || null; });
  };
  linkCards();
  class Clock extends Date { static now() { return Date.parse(now); } }
  const DateTimeFormat = function(locale, options) {
    if (intlFails) throw new Error("Local formatting unavailable");
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: options?.timeZone || zone });
  };
  runInNewContext(CLIENT, { document, location, history, URL, Date: Clock, Intl: { DateTimeFormat }, window: { addEventListener: (name, fn) => { winListeners[name] = fn; } } });
  const travel = (delta) => { index += delta; location.href = entries[index]; winListeners.popstate(); };
  return {
    search, chips, none, group, events, location, entries,
    type(q) { search.value = q; search.listeners.input({}); },
    blur() { search.listeners.blur({}); },
    click(when) { chips.listeners.click({ target: chips.children.find((c) => c.getAttribute("data-when") === when) }); },
    back() { travel(-1); }, forward() { travel(1); },
    hydrate(next) { pool = next; linkCards(); docListeners.island(); },
  };
}

test("weekend membership follows the labeled local day on both sides of midnight", () => {
  const ny = browser({ url: "https://aadhar.sh/serendipity?when=weekend" });
  assert.match(ny.events[0].time.textContent, /Fri, Oct 2.*9:00 PM EDT/);
  assert.equal(ny.events[0].card.hidden, true, "Saturday UTC is still Friday in New York");
  assert.match(ny.events[1].time.textContent, /Sat, Oct 3.*12:00 PM EDT/);
  assert.equal(ny.events[1].card.hidden, false);
  const tokyo = browser({ zone: "Asia/Tokyo", url: "https://aadhar.sh/serendipity?when=weekend" });
  assert.match(tokyo.events[0].time.textContent, /Sat, Oct 3.*10:00 AM/);
  assert.equal(tokyo.events[0].card.hidden, false);
});

test("DST repetition retains the instant and uses each date's correct zone label", () => {
  const b = browser({ now: "2026-10-31T00:00:00Z", events: [fixtureEvent("first", "2026-11-01T05:30:00Z"), fixtureEvent("second", "2026-11-01T06:30:00Z")] });
  assert.match(b.events[0].time.textContent, /Sun, Nov 1.*1:30 AM EDT/);
  assert.match(b.events[1].time.textContent, /Sun, Nov 1.*1:30 AM EST/);
  b.click("weekend");
  assert.ok(b.events.every((e) => !e.card.hidden));
});

test("unavailable local formatting retains UTC labels and uses UTC weekend days", () => {
  const b = browser({ intlFails: true, url: "https://aadhar.sh/serendipity?when=weekend" });
  assert.equal(b.events[0].time.textContent, "UTC fallback");
  assert.equal(b.events[0].card.hidden, false);
});

test("bookmarked filters restore before the island arrives and apply when it lands", () => {
  const b = browser({ url: "https://aadhar.sh/serendipity?q=Saturday&when=weekend", events: [] });
  assert.equal(b.search.value, "Saturday");
  assert.equal(b.chips.children[2].getAttribute("aria-pressed"), "true");
  const events = [fixtureEvent("NYC Friday", "2026-10-03T01:00:00Z"), fixtureEvent("NYC Saturday", "2026-10-03T16:00:00Z")];
  b.hydrate(events);
  assert.equal(events[0].card.hidden, true);
  assert.equal(events[1].card.hidden, false);
  assert.match(events[1].time.textContent, /EDT/);
  b.type("absent");
  assert.equal(b.none.style.display, "block");
  assert.equal(b.group.hidden, true);
});

test("typing and date chips preserve unrelated URL state and restore on Back/Forward and reload", () => {
  const b = browser({ url: "https://aadhar.sh/serendipity?msg=Thanks#events" });
  b.type("Sat"); b.type("Saturday");
  assert.equal(b.entries.length, 2, "typing uses one history entry");
  b.blur(); b.click("weekend");
  const bookmarked = b.location.href;
  assert.equal(new URL(bookmarked).searchParams.get("q"), "Saturday");
  assert.equal(new URL(bookmarked).searchParams.get("msg"), "Thanks");
  assert.equal(new URL(bookmarked).hash, "#events");
  b.back();
  assert.equal(b.search.value, "Saturday");
  assert.equal(b.chips.children[0].getAttribute("aria-pressed"), "true");
  b.back();
  assert.equal(b.search.value, "");
  assert.ok(b.events.every((e) => !e.card.hidden));
  b.forward(); b.forward();
  assert.equal(b.location.href, bookmarked);
  const reload = browser({ url: bookmarked });
  assert.equal(reload.search.value, "Saturday");
  assert.equal(reload.events[0].card.hidden, true);
  b.click("all"); b.type("");
  assert.equal(new URL(b.location.href).searchParams.has("when"), false);
  assert.equal(new URL(b.location.href).searchParams.has("q"), false);
});

test("unknown date filters use All; a detail page localizes without dashboard controls", () => {
  const b = browser({ url: "https://aadhar.sh/serendipity?when=unknown&q=%3Cscript%3E" });
  assert.equal(b.search.value, "<script>");
  assert.equal(b.chips.children[0].getAttribute("aria-pressed"), "true");
  const detail = browser({ detail: true });
  assert.match(detail.events[0].time.textContent, /Fri, Oct 2.*EDT/);
});
