// nav-tips.js — Tip of the Day, as a once-a-day island.
//
// nav.js owns WHEN: on a visitor's first page view of each local day it imports
// this module on idle, and Run's "Tip of the Day" row imports it on demand. A
// visitor who has already seen today's tip pays for one localStorage read in
// nav.js and never fetches this file. This module owns WHAT: the tips, the
// balloon, and the "Show tips at startup" checkbox.
//
// The tip is an XP notification balloon rising out of the tray, the way XP
// announced "Tour Windows XP" and "Your computer might be at risk". It wears the
// tray balloon's look (nav-tray.css styles #axp-tips beside #axp-balloon) and
// its tail points at the clock, since the tip belongs to the day. It is a
// popover="auto": a click anywhere else or Esc dismisses it, it never takes
// focus on arrival, and opening a tray balloon replaces it, since XP showed one
// balloon at a time. An automatic one also times out like XP's did, unless the
// pointer or focus is resting in it.
//
// Storage, one key shared with nav.js (TIPS_KEY there):
//   "off"            the visitor unticked "Show tips at startup"
//   Date#toDateString  the local day a tip was last shown; nav.js skips that day
//
// There is ONE tip a day and no way to page through the rest. The day's tip is
// dealt from a shuffled deck keyed on the LOCAL date (dayIndex below), so it
// holds all day (Run's row reopens the same one), turns over at the visitor's
// own midnight, and every tip comes round before any repeats.

// Tips are trusted static markup. {kbd} becomes the platform's Run shortcut.
var TIPS = [
  "Press <kbd>{kbd}</kbd> on any page to open Run. Type part of a page name, a photo caption or a profile, then press Enter.",
  "Most pages here have a Markdown copy. Add <code>.md</code> to the address, like <a href=\"/garage/encoding.md\">/garage/encoding.md</a>.",
  "Pages here ship minified, and View Source still reads. Line 1 names each page's readable twin, a <code>.src.html</code> file with the comments left in.",
  "Leave the desktop alone for a minute and the 3D Pipes screen saver starts. Any input brings you back. To see it now, open Run and type <b>sspipes</b>.",
  "In a <a href=\"/writing\">/writing</a> note, press F5 to stamp the time and date, the way Notepad always did.",
  "Windows here drag by their title bars and resize from the grip in their bottom-right corner. The desktop icons drag too, and go home on the next page.",
  "With a mouse, hover a photo on the <a href=\"/\">homepage</a> for its exposure, the Fujifilm film recipe it was shot with, and a histogram of its tones.",
  "The homepage draws a fresh 12 photos from the library on every load. Reload it and you're looking at different pictures.",
  "Click the little monitor in the tray, bottom right, to see which Cloudflare data center answered you and over which protocol.",
  "Sounds stay off until you ask. The speaker in the tray turns on clicks and chimes, synthesized in your browser, so there's no audio file to download.",
  "<a href=\"/whoareyou\">System Properties</a> shows what one request from your browser tells this site. None of it is logged or stored.",
  "<a href=\"/lens\">/lens</a> shows any address the way a machine reads it: what crawlers may take, what an agent gets back, and what the page costs to load.",
  "<a href=\"/updates\">Windows Update</a> is this site's real changelog, and <a href=\"/restore\">System Restore</a> scrubs back through its releases.",
  "This site runs an MCP server at <code>aadhar.sh/mcp</code>. Point an agent at it and it can search the site, see what's playing, and check for a free coffee slot.",
  "No page here downloads a font. Every letter you're reading came from a typeface already on your computer.",
  "A photo's address here names its exact bytes. Re-encode a picture and it gets a new address, so a cache can never hand you a stale copy.",
  "The test for every change here is one question: would Redmond have shipped it in Luna?",
  "In Chrome, resting the pointer on a link starts loading the next page before you click. That's why most pages here open instantly.",
  "Coming back in Chrome? Your browser keeps each page it has seen here, and the next visit downloads only the difference, often a few hundred bytes.",
  "The photos are straight out of camera. The look comes from a film recipe set on the Fujifilm before the shot, and the hover card lists it.",
  "Each page is one file baked at deploy. The live parts, like the playlist and the photo grid, arrive afterwards as small islands.",
  "Want to talk in person? <a href=\"/coffee\">/coffee</a> books a coffee or a bagel with me."
];

// The bulb in the Luna icon idiom: a lit glass with a highlight, and a banded
// brass screw base. Drawn on a 32 grid and shown at the balloon's 16px icon
// size. Inline because it is the only artwork this needs.
var BULB = '<svg viewBox="0 0 32 32" width="32" height="32"><defs>' +
  '<radialGradient id="axpTipG" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#fffbe0"/><stop offset=".55" stop-color="#ffe45c"/><stop offset="1" stop-color="#e9a800"/></radialGradient>' +
  '<linearGradient id="axpTipB" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a8a8a"/><stop offset=".45" stop-color="#e2e2e2"/><stop offset="1" stop-color="#7a7a7a"/></linearGradient></defs>' +
  '<path d="M16 2.5C10.4 2.5 6.5 6.7 6.5 11.7c0 3.4 1.7 5.5 3.3 7.4 1 1.2 1.7 2.3 1.9 3.9h8.6c.2-1.6.9-2.7 1.9-3.9 1.6-1.9 3.3-4 3.3-7.4 0-5-3.9-9.2-9.5-9.2Z" fill="url(#axpTipG)" stroke="#a87800" stroke-width=".8"/>' +
  '<ellipse cx="12.6" cy="8.4" rx="2.4" ry="3.4" fill="#fff" opacity=".7" transform="rotate(-25 12.6 8.4)"/>' +
  '<rect x="11.4" y="23" width="9.2" height="5" rx="1" fill="url(#axpTipB)" stroke="#5c5c5c" stroke-width=".6"/>' +
  '<path d="M11.6 24.7h8.8M11.6 26.4h8.8" stroke="#5c5c5c" stroke-width=".6"/>' +
  '<path d="M13.4 28h5.2l-1 1.8h-3.2Z" fill="#4a4a4a"/></svg>';

/** The local day, as the string nav.js compares against. */
function today() { return new Date().toDateString(); }

/** One deck: every tip once, in an order shuffled from the deck's number. */
function deck(n) {
  var s = Math.imul(n + 1, 2654435761) >>> 0, order = TIPS.map((_, i) => i);
  for (var i = order.length - 1; i > 0; i--) {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0;   // a small xorshift-multiply step
    var j = s % (i + 1), t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order;
}

/**
 * Today's tip. Days are dealt from shuffled decks of TIPS.length, so the draw
 * is random but every tip comes round before any repeats. Where one deck ends
 * on the tip the next begins with, the next one's first two swap, so no tip is
 * ever shown two days running. Keyed on the LOCAL date, as a day count.
 */
function dayIndex() {
  var d = new Date(), n = TIPS.length;
  var day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  var k = Math.floor(day / n), cards = deck(k);
  if (cards[0] === deck(k - 1)[n - 1]) { var t = cards[0]; cards[0] = cards[1]; cards[1] = t; }
  return cards[day % n];
}

// XP held a balloon for about ten seconds of user activity. Twenty is generous
// for a paragraph, and the clock pauses while the balloon is being read.
var AUTO_CLOSE_MS = 20000;

export function createTips(options) {
  var D = document;
  var key = options.key;
  var kbd = options.kbd;
  var sound = options.sound;
  var box = /** @type {HTMLElement | null} */ (null), text = /** @type {HTMLElement | null} */ (null), check = /** @type {HTMLInputElement | null} */ (null);
  var timer = 0, held = false;

  function read() { try { return localStorage.getItem(key); } catch (_) { return "off"; } }
  function write(v) { try { localStorage.setItem(key, v); } catch (_) {} }

  function disarm() { if (timer) { clearTimeout(timer); timer = 0; } }
  function arm() {
    disarm();
    timer = setTimeout(() => { timer = 0; if (box && !held && box.matches(":popover-open")) box.hidePopover(); }, AUTO_CLOSE_MS);
  }

  function build() {
    var t = D.createElement("template");
    t.innerHTML =
      '<div id="axp-tips" popover="auto" role="dialog" aria-labelledby="axp-tips-t">' +
        '<div class="tb"><span class="ic" aria-hidden="true">' + BULB + '</span><span class="t" id="axp-tips-t">Tip of the Day</span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
        '<div class="bd"><p class="ln" aria-live="polite"></p></div>' +
        '<div class="ft"><label class="chk"><input type="checkbox"> Show tips at startup</label></div>' +
      '</div>';
    const node = t.content.firstElementChild;
    if (!(node instanceof HTMLElement)) throw new Error("Tip of the Day template must produce an element");
    const p = node.querySelector(".bd p"), cb = node.querySelector(".chk input"), x = node.querySelector(".x");
    if (!(p instanceof HTMLElement) || !(cb instanceof HTMLInputElement) || !x) throw new Error("Tip of the Day template lost its parts");
    box = node; text = p; check = cb;
    D.body.appendChild(node);

    x.addEventListener("click", () => { node.hidePopover(); });
    // Ticked keeps today's stamp, so the next tip arrives tomorrow; unticked
    // stops the automatic one for good. Run can still open it either way.
    cb.addEventListener("change", () => { write(cb.checked ? today() : "off"); });
    // A balloon being read does not time out: the pointer over it or focus in
    // it holds it open, and leaving restarts the clock.
    var hold = (on) => () => { held = on; if (on) disarm(); else if (node.matches(":popover-open")) arm(); };
    node.addEventListener("pointerenter", hold(true));
    node.addEventListener("pointerleave", hold(false));
    node.addEventListener("focusin", hold(true));
    node.addEventListener("focusout", (e) => { if (!node.contains(/** @type {Node | null} */ (e.relatedTarget))) hold(false)(); });
    node.addEventListener("toggle", (e) => {
      if (/** @type {ToggleEvent} */ (e).newState !== "closed") return;
      disarm(); held = false;
      sound.play("close");
    });
  }

  /** Point the tail at the clock, which is where this balloon comes from. */
  function placeTail() {
    var clock = D.getElementById("axp-clock");
    if (!box || !clock) return;
    var cr = clock.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.style.setProperty("--tail", Math.max(14, Math.min(br.width - 14, cr.left + cr.width / 2 - br.left)) + "px");
  }

  /** @param {boolean} [auto] opened by nav.js on the day's first visit */
  function open(auto) {
    if (!box) build();
    if (!box || box.matches(":popover-open")) return;
    if (text) text.innerHTML = TIPS[dayIndex()].replace("{kbd}", kbd);
    var state = read();
    if (state !== "off") write(today());
    if (check) check.checked = state !== "off";
    box.showPopover();
    placeTail();
    // An automatic tip leaves focus where the visitor put it and times out; one
    // they asked for from Run takes focus and stays until they close it.
    if (auto) arm();
    else {
      sound.play("open");
      var x = box.querySelector(".x");
      if (x instanceof HTMLElement) x.focus();
    }
  }

  return { open: open };
}
