// ── /pixel-peeper keeps the tiles in view when you pick one ─────────────────
//
// A pick appends the verdict banner and a 320px diff map under the tiles, then
// focuses Next so Enter advances. Next sits below the diff map, and a plain
// focus() scrolls its element into view: at 1280x800 that moved the stage 323px
// and threw the tiles you had just judged off the top of the window. Every
// focus() on this page passes preventScroll, so the viewport stays on the
// content you were reading while the new stuff grows in below it.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

const PAGE = readFileSync(new URL("../src/pages/pixel-peeper/index.html", import.meta.url), "utf8");

test("every focus() on the eye exam passes preventScroll", () => {
  const calls = [...PAGE.matchAll(/\.focus\(([^)]*)\)/g)];
  assert.ok(calls.length > 0, "the page should still focus Next after a pick");
  for (const [call, args] of calls) {
    assert.match(args, /preventScroll:\s*true/, `${call} scrolls its target into view and drags the tiles off screen`);
  }
});
