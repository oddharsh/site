// ── /pixel-peeper grades its resample calls by the known answer ─────────────
//
// The resample axis ships with no metric scores (gen-pixel-peeper.ts
// buildResample: two downscales share no common-size reference), so no option
// carries s2best or butterbest. The page once graded every call by those flags
// anyway, which told every visitor "both metrics picked another one" and
// printed "s2 null bu null" under the tiles. It now grades by the analytically
// known answer, the tile the linear-light kernel made, through
// AXES.resample.answer. This holds the page to that predicate and the manifest
// to giving it exactly one tile to find in every call.
//
// Each tile's caption shows LIGHT KEPT instead: its decoded mean linear
// luminance over the source window's. Averaging in light conserves that mean,
// so the zenc tile has to keep more of it than sips in every call. A call
// where it doesn't would put a number under the tiles that argues against the
// answer the page grades by.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

const MANIFEST = JSON.parse(readFileSync(new URL("../public/pixel-peeper/manifest.json", import.meta.url), "utf8"));
const PAGE = readFileSync(new URL("../src/pages/pixel-peeper/index.html", import.meta.url), "utf8");
const resample = MANIFEST.trials.filter((t) => t.axis === "resample");

test("the page grades resample calls by the zenc label this test checks", () => {
  assert.match(PAGE, /resample:\{answer:o=>o\.label==="zenc",/, "AXES.resample.answer must stay the label test this contract holds the manifest to");
});

test("every resample call is unscored and has exactly one linear-light tile and one sips tile", () => {
  assert.ok(resample.length > 0, "the manifest should carry resample calls");
  for (const t of resample) {
    const labels = t.options.map((o) => o.label).sort();
    assert.deepEqual(labels, ["sips", "zenc"], `${t.crop}: a resample call is sips against zenc`);
    for (const o of t.options) {
      assert.equal(o.s2, null, `${t.crop}/${o.label}: a resample tile has no reference to score against`);
      assert.ok(!o.s2best && !o.butterbest, `${t.crop}/${o.label}: no metric picks a resample tile`);
    }
  }
});

test("every resample tile carries light kept, and the linear-light tile keeps more than sips", () => {
  for (const t of resample) {
    const light = Object.fromEntries(t.options.map((o) => [o.label, o.light]));
    for (const [label, v] of Object.entries(light)) assert.ok(typeof v === "number" && v > 80 && v <= 100.5, `${t.crop}/${label}: light kept should be a percentage near 100, got ${v}`);
    assert.ok(light.zenc > light.sips, `${t.crop}: zenc keeps ${light.zenc}% of the window's light and sips ${light.sips}%; averaging in light must keep more`);
  }
});

test("the page captions light kept wherever a tile has no metric scores", () => {
  assert.match(PAGE, /o\.s2===null\?\(o\.light==null\?``:`<span class="m">light kept \$\{o\.light\.toFixed\(1\)\}%<\/span>`\)/, "the caption must show light kept for an unscored tile");
});
