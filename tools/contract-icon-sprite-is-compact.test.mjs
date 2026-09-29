// ── The icon sprite carries each paint definition once ──────────────────────
// hoistDefs merges two gradients only when their text is identical, so two
// spellings of one colour keep two copies. That is how the security icon's
// gloss survived #940's dedupe: its stops said #ffffff where garageG's said
// #fff. compactSvg folds such colours now, and these tests hold both halves:
// the rule itself, and the committed sprite it produced.
//
// The sprite is content-hashed under /a/, so a regression here is not free to
// fix later. Every re-mint re-keys every page and page dictionary (gotcha 35).
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { compactSvg } from "./photos/gen-desktop-partial.ts";

const FOLDABLE = /="#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3"/i;
const PAINT_DEF = /<(filter|linearGradient|radialGradient|clipPath|mask|pattern)\b([^>]*?)\bid="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g;

test("compactSvg folds a whole-value hex colour and nothing else", () => {
  assert.equal(compactSvg('<stop stop-color="#FFFFFF"/>'), '<stop stop-color="#fff"/>');
  assert.equal(compactSvg('<rect fill="#aabbcc"/>'), '<rect fill="#abc"/>');
  // Pairs that do not repeat have no short form.
  assert.equal(compactSvg('<rect fill="#abcdef"/>'), '<rect fill="#abcdef"/>');
  // A fragment reference is not a colour, even when it looks like one.
  assert.equal(compactSvg('<rect fill="url(#aabbcc)"/>'), '<rect fill="url(#aabbcc)"/>');
});

test("the committed sprite has no foldable colour and no duplicate paint definition", () => {
  const sprite = readFileSync("public/icons.svg", "utf8");
  assert.ok(!FOLDABLE.test(sprite), `public/icons.svg carries ${sprite.match(FOLDABLE)?.[0]}: run bun run gen:shell`);
  const seen = new Map();
  let defs = 0;
  for (const m of sprite.matchAll(PAINT_DEF)) {
    defs++;
    const body = `${m[1]}${m[2]}${m[4]}>${m[5]}`;
    assert.ok(!seen.has(body), `${m[3]} repeats ${seen.get(body)} in every attribute but the id`);
    seen.set(body, m[3]);
  }
  // A floor, so a PAINT_DEF that stops matching cannot pass over zero definitions.
  assert.ok(defs >= 20, `only ${defs} paint definitions matched`);
});
