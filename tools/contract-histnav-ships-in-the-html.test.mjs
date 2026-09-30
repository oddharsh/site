// ── Back/Forward ship in the HTML, never injected after paint ───────────────
// nav.js used to CREATE the title bar's Back/Forward pair inside boot(), which
// runs two animation frames after the static paint on purpose. So every
// windowed page painted its caption and then slid it right by the pair's width:
// bun run cls (tools/layout-shift-lab.ts) found `.title-bar dx+50` on 65 of 65
// pages at desktop width, and at 390px four garage captions wrapped onto a
// second line and pushed the document down 19px.
//
// The pair is baked into every renderer's markup now, and luna.css carries its
// rules. Each assertion below renders the real surface rather than grepping
// source, because the failure is silent: a renderer that forgets the bake still
// gets working buttons from nav.js's fallback, and pays with the layout shift.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { DESKTOP_HISTNAV } from "../src/worker/lib/desktop.ts";
import { lunaPage } from "../src/worker/lib/chrome.ts";
import { unsafeHtml } from "../src/worker/lib/html.ts";
import { notepadWindow } from "../src/worker/writing.ts";
import { successPage } from "../cal/src/templates.ts";
import { HISTNAV_HTML, bakeHistnav, staticShellPages } from "./photos/gen-desktop-partial.ts";

const count = (haystack) => haystack.split(DESKTOP_HISTNAV).length - 1;

// ── the title bar is reachable, not aria-hidden ─────────────────────────────
// Every page window's title bar used to carry aria-hidden="true" while holding
// the Back/Forward buttons, the close link, and a .max that nav.js turns into a
// focusable control: focusable content inside aria-hidden, which a screen
// reader skips while the keyboard still lands on it. The bar is exposed now,
// its decorations (.icon, .min) are hidden one by one, and .max is a native
// button. `maxButton: false` is for a window nothing wires (a popover note, the
// standalone cal host), where .max stays an inert hidden span.
const TITLE_BAR = /<div class="(?:title-bar|np-titlebar)"([^>]*)>/;
function assertAccessibleTitleBar(source, label, { maxButton = true } = {}) {
  const open = TITLE_BAR.exec(source);
  assert.ok(open, `${label}: no window title bar`);
  assert.doesNotMatch(open[1], /aria-hidden/, `${label}: the title bar is aria-hidden, which hides its buttons from a screen reader`);
  const end = source.indexOf('class="close"', open.index);
  assert.ok(end > open.index, `${label}: no close control in the title bar`);
  const bar = source.slice(open.index, end);
  assert.match(bar, /<span class="(?:icon|np-ico)(?: [\w-]+)*" aria-hidden="true">/, `${label}: the decorative icon must be aria-hidden`);
  assert.match(bar, /<span class="min"[^>]* aria-hidden="true">/, `${label}: .min does nothing, so it must be aria-hidden`);
  if (maxButton) {
    assert.match(bar, /<button type="button" class="max"[^>]* aria-label="[^"]+">/, `${label}: .max must be a native, labelled button`);
    assert.doesNotMatch(bar, /<span class="max"/, `${label}: .max is still a span`);
  } else {
    assert.match(bar, /<span class="max"[^>]* aria-hidden="true">/, `${label}: an unwired .max must stay an inert hidden span`);
  }
}

test("the title-bar check fails on the old aria-hidden pattern (control)", () => {
  const old = '<div class="title-bar" aria-hidden="true"><span class="title-text"><span class="icon"></span>t</span><span class="controls"><span class="min"></span><span class="max"></span><a class="close" href="/"></a></span></div>';
  assert.throws(() => assertAccessibleTitleBar(old, "old"), /aria-hidden/);
  const spanMax = '<div class="title-bar"><span class="title-text"><span class="icon" aria-hidden="true"></span>t</span><span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/"></a></span></div>';
  assert.throws(() => assertAccessibleTitleBar(spanMax, "span max"), /native, labelled button/);
});

test("the generated module carries the canonical pair", () => {
  assert.equal(DESKTOP_HISTNAV, HISTNAV_HTML, "desktop.ts is stale: run bun run gen:shell");
});

test("every static page carries the pair once, at the head of its window's title bar", () => {
  const pages = staticShellPages();
  assert.ok(pages.length >= 40, `only ${pages.length} static shell pages found`);
  for (const file of pages) {
    const source = readFileSync(file, "utf8");
    assert.equal(count(source), 1, `${file}: expected the pair exactly once`);
    assert.equal(bakeHistnav(source), source, `${file}: not in its baked position, run bun run gen:shell`);
    assertAccessibleTitleBar(source, file);
  }
});

test("bakeHistnav is idempotent, skips a comment, and honours data-no-histnav", () => {
  const page = '<body><div class="window">\n  <!-- chrome -->\n  <div class="title-bar">\n    <span class="title-text">t</span></div></div></body>';
  const once = bakeHistnav(page);
  assert.equal(count(once), 1);
  assert.ok(once.includes(`<div class="title-bar">${DESKTOP_HISTNAV}\n`));
  assert.equal(bakeHistnav(once), once, "a second bake must not stack a second pair");
  // an OLDER generator's pair converges on the canonical one rather than doubling
  const stale = once.replace(DESKTOP_HISTNAV, '<span class="axp-histnav"><button type="button" class="axp-back"></button></span>');
  assert.equal(bakeHistnav(stale), once);
  // the control: the opt-out window gets nothing, and a baked one is removed
  const optedOut = once.replace('<div class="window">', '<div class="window" data-no-histnav>');
  assert.equal(count(bakeHistnav(optedOut)), 0);
});

test("lunaPage bakes the pair into its title bar, byte-equal to the generated one", async () => {
  const page = await lunaPage({ title: "t", body: unsafeHtml("<p>x</p>") }).text();
  assert.equal(count(page), 1, "chrome.ts's html literal drifted from DESKTOP_HISTNAV");
  assert.ok(page.includes(`<div class="title-bar">${DESKTOP_HISTNAV}`));
  assertAccessibleTitleBar(page, "lunaPage");
  const optedOut = await lunaPage({ title: "t", windowAttrs: unsafeHtml("data-no-histnav") }).text();
  assert.equal(count(optedOut), 0, "data-no-histnav must drop the pair, as nav.js would");
});

test("a standalone Notepad window bakes the pair and a popover note does not", () => {
  // nav.js wires the FIRST body-level window only; a popover note never is one
  assert.equal(count(notepadWindow("a.txt", "text", "/writing")), 1);
  assert.equal(count(notepadWindow("a.txt", "text", "/writing", undefined, "note-a")), 0);
  assertAccessibleTitleBar(notepadWindow("a.txt", "text", "/writing"), "notepad window");
  assertAccessibleTitleBar(notepadWindow("a.txt", "text", "/writing", undefined, "note-a"), "popover note", { maxButton: false });
});

test("cal bakes the pair under /coffee and not on the standalone cal host", () => {
  const env = { HOST_NAME: "aadhar.sh", HOST_PUBLIC_URL: "https://aadhar.sh" };
  assert.equal(count(successPage({ ...env, BASE_PATH: "/coffee" })), 1);
  // cal.aadhar.sh loads no nav.js, so nothing would ever wire the buttons there
  assert.equal(count(successPage({ ...env, BASE_PATH: "" })), 0);
  assertAccessibleTitleBar(successPage({ ...env, BASE_PATH: "/coffee" }), "cal under /coffee");
  assertAccessibleTitleBar(successPage({ ...env, BASE_PATH: "" }), "standalone cal", { maxButton: false });
});

test("the pair's rules are in luna.css at first paint, and nav.js injects none", () => {
  const luna = readFileSync("src/styles/luna.css", "utf8");
  assert.match(luna, /^\.axp-histnav \{ display: inline-flex;/m);
  assert.match(luna, /@media \(scripting: none\), \(width < 720px\) \{ \.axp-histnav \{ display: none; \} \}/,
    "the pair must hide with script off (dead buttons) and on a phone (wrapped captions)");
  const nav = readFileSync("src/client/nav.js", "utf8");
  assert.doesNotMatch(nav, /\.axp-histnav[^\n]*\{/, "nav.js must not carry the pair's CSS again");
  // The homepage alone loads luna.css non-blocking (media=print swap), so its
  // inline critical block has to carry the SIZE of the pair, or the caption paints
  // with two 16x6 native buttons and grows 15px when luna lands.
  const home = readFileSync("src/pages/index.html", "utf8");
  assert.match(home, /\.axp-histnav button \{ box-sizing: border-box; width: 21px; height: 21px;/);
  assert.match(home, /@media \(width < 720px\) \{ \.axp-histnav \{ display: none; \} \}/);
});
