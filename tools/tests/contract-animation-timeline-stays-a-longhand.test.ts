// ── animation-timeline ships as a longhand, never folded into the shorthand ──
import { readFileSync } from "node:fs";
import { assert, ROOT, test } from "./contract-shared.ts";
import { parseCss } from "../lib/css-parse.ts";

// Gotcha 82. Lightning CSS 1.33, run with no `targets`, merges
// `animation: x linear both; animation-timeline: scroll()` into
// `animation:linear both x scroll()`, which no shipping engine parses. Every
// scroll-driven demo on /garage/scroll and /garage/horizon shipped that way
// and sat frozen on its first keyframe until 2026-10-23. tools/lib/css-parse.ts
// now refuses the folded form; these tests hold that refusal, and its controls
// show it fires on nothing else.

const throwsFold = (css: string) => assert.throws(() => parseCss("fixture.css", css, { minify: true }), /gotcha 82/, css);

test("the folded shorthand fails the parse, for scroll(), view() and a named timeline", () => {
  throwsFold(`.a { animation: x linear both; animation-timeline: scroll(nearest block); }`);
  throwsFold(`.a { animation: x linear both; animation-timeline: view(); }`);
  throwsFold(`.a { animation: x linear both; animation-timeline: --sd-scroll; }`);
  // authored that way by hand, with no folding needed
  throwsFold(`.a { animation: x 1s linear both view(); }`);
});

test("the unminified path folds too, so it is refused there as well", () => {
  assert.throws(() => parseCss("fixture.css", `.a { animation: x linear both; animation-timeline: view(); }`), /gotcha 82/);
});

test("longhands beside animation-timeline pass and stay separate declarations", () => {
  const out = parseCss(
    "fixture.css",
    `.a { animation-name: x; animation-timing-function: linear; animation-fill-mode: both; animation-timeline: scroll(nearest block); }`,
    { minify: true },
  );
  assert.match(out, /animation-timeline:scroll\(\)/, out);
  assert.doesNotMatch(out, /(?:^|[{;])animation:/, out);
});

test("controls: a plain shorthand, a var() and a dashed keyframes name in a longhand all pass", () => {
  for (const css of [
    `.a { animation: spin 5s linear infinite; }`,
    `.a { animation: var(--anim); }`,
    `.a { animation: si-fade .5s backwards; animation-delay: calc(sibling-index() * 90ms); }`,
    `.a { animation-name: x; animation-timeline: --named; }`,
  ]) {
    assert.doesNotThrow(() => parseCss("fixture.css", css, { minify: true }), css);
  }
});

test("the two pages that drive animations from scroll still parse", () => {
  for (const page of ["src/pages/garage/scroll.html", "src/pages/garage/horizon.html"]) {
    const html = readFileSync(new URL(page, ROOT), "utf8");
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    assert.ok(
      css.some((c) => c.includes("animation-timeline")),
      `${page} no longer sets animation-timeline in a <style>; this test is checking nothing there`,
    );
    for (const c of css) parseCss(page, c, { minify: true });
  }
});
