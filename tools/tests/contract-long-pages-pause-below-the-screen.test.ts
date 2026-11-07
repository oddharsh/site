// ── long pages pause the parser below the first screen ──────────────────────
// build.ts step 1g2 runs tools/lib/parser-pause.ts on every page it dresses,
// after prose-fold.ts, which puts an in-body <link rel="stylesheet"> between
// two top-level blocks so Chrome paints the first screen before parsing the
// rest. What would quietly break it:
//   - the link landing on the first screen, which paints that screen late;
//   - the link landing inside a block (a <p>, a list), where it no longer
//     separates the first screen from the rest;
//   - a page whose first paint waits for its first fold (`rel=expect`) pausing
//     before that fold, which holds first paint for the sheet;
//   - the pause adding anything but the one link.
//
// HTMLRewriter is a bun global, so under node the suite skips, matching
// contract-long-pages-fold-below-the-screen.test.ts.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { NON_BLOCKING_PAGES } from "../lib/critical-css.ts";
import { PAUSE_HREF, PAUSE_MIN_REST, pauseBelowFirstScreen } from "../lib/parser-pause.ts";
import { FOLD_AFTER_CHARS, foldLongProse } from "../lib/prose-fold.ts";

const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };
const ROOT = new URL("../../", import.meta.url);
const LINK = `<link rel="stylesheet" href="${PAUSE_HREF}">`;
// The pages as step 1g2 hands them to the pause: folded first.
const pages = (dir) =>
  readdirSync(new URL(dir, ROOT))
    .filter((f) => f.endsWith(".html"))
    .map((f) => [`${dir}${f}`.replace("src/pages/", ""), foldLongProse(readFileSync(new URL(`${dir}${f}`, ROOT), "utf8"))]);
const ALL = [...pages("src/pages/garage/"), ...pages("src/pages/lwe/")];
const paused = (rel, html) => pauseBelowFirstScreen(html, { afterFirstFold: NON_BLOCKING_PAGES.includes(rel) });
// Visible text with whitespace collapsed, read by a second parser pass rather
// than the counter the pause uses.
const visible = (html) => {
  const bare = new HTMLRewriter()
    .on("script, style, template", {
      element(e) {
        e.remove();
      },
    })
    .transform(html);
  let text = "";
  new HTMLRewriter()
    .onDocument({
      text(t) {
        text += t.text;
      },
    })
    .transform(bare);
  return text.replace(/\s+/g, " ");
};
const CONTENT = /<(?:main|div)\b[^>]*? class="content(?: [^"]*)?"[^>]*>/;

test("the pause adds exactly one link and nothing else, and adding it twice changes nothing", needsParser, () => {
  let count = 0;
  for (const [rel, html] of ALL) {
    const out = paused(rel, html);
    if (out === html) continue;
    count++;
    assert.equal(out.split(LINK).length, 2, `${rel}: expected one pause link`);
    assert.equal(out.replace(LINK, ""), html, `${rel}: the pause changed more than the link`);
    assert.equal(paused(rel, out), out, `${rel}: pausing twice must change nothing (the twin writer re-dresses pages)`);
  }
  // 34 garage and lwe pages pause on 2026-11-07; far fewer means the selectors stopped matching.
  assert.ok(count >= 25, `only ${count} pages paused; did .window > .content or the chat .log change shape?`);
});

test("the pause sits past the first screen, with enough page left below it", needsParser, () => {
  for (const [rel, html] of ALL) {
    const out = paused(rel, html);
    const at = out.indexOf(LINK);
    if (at < 0) continue;
    const open = CONTENT.exec(out);
    assert.ok(open, `${rel}: paused, but has no .content to measure from`);
    const before = visible(out.slice(open.index, at)).length;
    const total = visible(out.slice(open.index, out.indexOf("</main>", at) >= 0 ? out.indexOf("</main>", at) : out.length)).length;
    assert.ok(before >= FOLD_AFTER_CHARS, `${rel}: the pause sits after ${before} characters, inside the first screen`);
    assert.ok(total - before >= PAUSE_MIN_REST, `${rel}: only ${total - before} characters left below the pause`);
  }
});

test("the pause is a direct child of .content, or of the chat .log", needsParser, () => {
  for (const [rel, html] of ALL) {
    const out = paused(rel, html);
    if (!out.includes(LINK)) continue;
    let parent = "";
    new HTMLRewriter()
      .on(`.window > .content > link[href="${PAUSE_HREF}"], .window > .content > .msgr > .log > link[href="${PAUSE_HREF}"]`, {
        element() {
          parent = "ok";
        },
      })
      .transform(out);
    assert.equal(parent, "ok", `${rel}: the pause sits inside a block, where it no longer ends the first screen`);
  }
});

test("a page whose first paint waits for its first fold pauses only after that fold", needsParser, () => {
  assert.ok(NON_BLOCKING_PAGES.length > 0, "no page waits for its first fold; this test checks nothing");
  for (const rel of NON_BLOCKING_PAGES) {
    const html = foldLongProse(readFileSync(new URL(`src/pages/${rel}`, ROOT), "utf8"));
    const firstFoldEnd = html.indexOf("</section>", html.indexOf('<section class="fold"'));
    assert.ok(paused(rel, html).indexOf(LINK) > firstFoldEnd, `${rel}: the pause sits before the end of the first fold`);
    // and without the rule it would have landed before it, so the rule is what moves it
    assert.ok(pauseBelowFirstScreen(html).indexOf(LINK) < firstFoldEnd, `${rel}: the pause lands after the first fold anyway; the rule is untested`);
  }
});

test("a page too short to have a first screen and a rest gets no pause", needsParser, () => {
  const html = '<div class="window"><main id="main" class="content prose"><h1>t</h1><p>short</p><h2>a</h2><p>still short</p></main></div>';
  assert.equal(pauseBelowFirstScreen(html), html);
  // the same shape with enough text does pause, at the h2 past the threshold
  const long = `<div class="window"><main id="main" class="content prose"><h1>t</h1><p>${"x".repeat(FOLD_AFTER_CHARS)}</p><h2>a</h2><p>${"y".repeat(PAUSE_MIN_REST)}</p></main></div>`;
  assert.equal(pauseBelowFirstScreen(long), long.replace("<h2>a</h2>", `${LINK}<h2>a</h2>`));
});
