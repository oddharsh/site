// ── one Window template for every document (#1026) ──────────────────────────
// The XP title bar was written in 45 places, lunaPage plus 44 hand copies in
// src/pages, and they drifted: four markup variants for .min, and two pages that
// hid their focusable Back/Forward from assistive tech. titleBar() in
// src/worker/lib/window.ts is the one source now. lunaPage and serendipity call
// it, gen:shell writes its output into every static page between axp:window
// markers, and the two page generators call it when scaffolding.
//
// build.ts's shell freshness check already fails a page whose bar drifts (it
// runs patchStaticShell, which ends in bakeTitleBar). These tests cover what
// that check cannot: that the markers are present once per page, that the
// rewrite REFUSES markup it has no field for rather than dropping it, and that
// no second renderer grows back.
import { readFileSync, readdirSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { WINDOW_CLOSE, WINDOW_OPEN, bakeTitleBar, staticShellPages } from "./photos/gen-desktop-partial.ts";

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("every static page with a title bar carries exactly one generated bar", () => {
  const pages = staticShellPages();
  let baked = 0;
  for (const file of pages) {
    const source = readFileSync(file, "utf8");
    if (!source.includes('class="title-bar"')) continue;
    assert.equal(occurrences(source, WINDOW_OPEN), 1, `${file}: expected one ${WINDOW_OPEN}`);
    assert.equal(occurrences(source, WINDOW_CLOSE), 1, `${file}: expected one ${WINDOW_CLOSE}`);
    assert.equal(bakeTitleBar(source, file), source, `${file}: title bar drifted from lib/window.ts, run bun run gen:shell`);
    assert.doesNotMatch(source, /<span class="min" title=/, `${file}: .min carries a tooltip on a control that does nothing`);
    baked++;
  }
  // 44 on 2026-09-30 (vt-b and vt-check draw no window). A floor, so a matcher
  // that stopped finding bars cannot report a clean pass over nothing.
  assert.ok(baked >= 40, `only ${baked} static pages carry a generated title bar`);
});

test("the bake converges the old variants and keeps every field", () => {
  const page = (bar) => `<body>\n<div class="window">\n    ${bar}\n    <div class="content"></div>\n</div>\n</body>`;
  // the lwe shape: split tags, a tooltip on .min, an entity in the caption
  const lwe = page('<div class="title-bar">\n      <span class="title-text"><span class="icon" aria-hidden="true"></span>aadhar.sh/lwe &middot; FHE</span>\n      <span class="controls"\n        ><span class="min" title="minimize" aria-hidden="true"></span\n        ><button type="button" class="max" title="maximize" aria-label="maximize"></button\n        ><a class="close" href="/lwe" title="back to Learning With Errors" aria-label="back to Learning With Errors"></a\n      ></span>\n    </div>');
  const once = bakeTitleBar(lwe);
  // the caption was authored HTML, so it must pass through unescaped
  assert.ok(once.includes("aadhar.sh/lwe &middot; FHE</span>"), "the caption's entity was re-escaped");
  assert.ok(once.includes(`${WINDOW_OPEN}<div class="title-bar">`) && once.endsWith(`</div>${WINDOW_CLOSE}\n    <div class="content"></div>\n</div>\n</body>`));
  assert.equal(occurrences(once, 'title="minimize"'), 0);
  assert.equal(bakeTitleBar(once), once, "a second bake must change nothing");
  // the icon class, the close label differing from its title, and the opt-out
  const custom = page('<div class="title-bar"><span class="title-text"><span class="icon df-icon" aria-hidden="true"></span>aadhar.sh/dotfiles</span><span class="controls"><span class="min" aria-hidden="true"></span><button type="button" class="max" title="maximize" aria-label="maximize"></button><a class="close" href="/" title="back to the desktop" aria-label="close dotfiles"></a></span></div>')
    .replace('<div class="window">', '<div class="window" data-no-histnav>');
  const baked = bakeTitleBar(custom);
  assert.ok(baked.includes('<span class="icon df-icon" aria-hidden="true">'), "the icon class was dropped");
  assert.ok(baked.includes('title="back to the desktop" aria-label="close dotfiles"'), "the close label was dropped");
  assert.ok(!baked.includes("axp-histnav"), "data-no-histnav must keep Back/Forward out");
});

test("the bake refuses markup the template has no field for (control)", () => {
  const withExtra = '<body>\n<div class="window">\n  <div class="title-bar"><span class="title-text"><span class="icon" aria-hidden="true"></span>x</span><span class="badge">beta</span><span class="controls"><span class="min" aria-hidden="true"></span><button type="button" class="max" title="maximize" aria-label="maximize"></button><a class="close" href="/" title="t" aria-label="t"></a></span></div>\n</div>\n</body>';
  assert.throws(() => bakeTitleBar(withExtra, "fixture"), /fixture: the title bar carries markup the template would drop/);
  const attributed = withExtra.replace('<span class="badge">beta</span>', "").replace('<div class="title-bar">', '<div class="title-bar" data-x="1">');
  assert.throws(() => bakeTitleBar(attributed, "fixture"), /attributes the template has no field for/);
});

test("no renderer outside lib/window.ts authors a title bar", () => {
  // The one sanctioned exception is cal: on its standalone host nothing loads
  // nav.js, so its .max stays an inert hidden span, which is a different
  // contract from titleBar()'s labelled button (contract-histnav-ships-in-the-
  // html, "standalone cal"). Folding it in means a field for that, deliberately
  // not added until a second caller needs it.
  const allowed = new Set(["src/worker/lib/window.ts", "cal/src/templates.ts"]);
  const offenders = [];
  let scanned = 0;
  for (const dir of ["src/worker", "serendipity", "cal/src", "pipelines"]) {
    for (const rel of readdirSync(dir, { recursive: true })) {
      const file = `${dir}/${rel}`;
      if (!/\.(ts|mjs|js)$/.test(file)) continue;
      scanned++;
      if (/<div class=\\?"title-bar\\?">/.test(readFileSync(file, "utf8")) && !allowed.has(file)) offenders.push(file);
    }
  }
  assert.ok(scanned > 50, `scanned only ${scanned} files`);
  assert.deepEqual(offenders, [], `these files write title-bar markup by hand; call titleBar() from lib/window.ts: ${offenders.join(", ")}`);
});
