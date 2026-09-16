// ── the JS minifier picks the smallest candidate ────────────────────────────
// lib/minify-js.ts runs four pipelines per script (oxc alone, SWC's compressor
// then oxc, oxc-SWC-oxc, SWC alone) and ships the smallest after brotli q11.
// "Parity with SWC" is therefore a property of the function and not a number
// that rots, and this asserts the property on the real client files rather
// than on a fixture, so an engine bump that breaks the pick is caught by the
// files it would ship.
import { brotliCompressSync, constants } from "node:zlib";
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { ORDER, SWC_COMPRESS_OPTIONS, SWC_FULL_OPTIONS, minifyJavaScript } from "./lib/minify-js.ts";

const brotli = (code) => brotliCompressSync(Buffer.from(code), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

test("every client script ships no more brotli bytes than oxc alone OR SWC alone, and the winner is a named candidate", async () => {
  const files = (await readdir(new URL("src/client/", ROOT))).filter((f) => f.endsWith(".js")).sort();
  assert.ok(files.length >= 15, `only ${files.length} client files; the walk collapsed`);
  const tally = new Map();
  for (const f of files) {
    const src = await readFile(new URL(`src/client/${f}`, ROOT), "utf8");
    const { code, winner, sizes } = minifyJavaScript(f, src);
    assert.ok(ORDER.includes(winner), `${f}: winner ${winner} is not a candidate`);
    assert.equal(brotli(code), sizes[winner], `${f}: the shipped code is not the candidate the sizes name`);
    for (const k of ORDER) assert.ok(sizes[winner] <= sizes[k], `${f}: shipped ${sizes[winner]} B but candidate ${k} is ${sizes[k]} B`);
    assert.ok(code.length > 0 && code.length < src.length, `${f}: minified output is empty or larger than its source`);
    tally.set(winner, (tally.get(winner) ?? 0) + 1);
  }
  // The control on the pick itself: if every file picked one candidate, the
  // measurement is not deciding anything and the other three are decoration.
  assert.ok(tally.size >= 2, `every file picked ${[...tally.keys()][0]}; the pick is not measuring`);
});

test("ties prefer oxc, and the SWC half is a compressor with oxc's mangling rules", () => {
  assert.equal(ORDER[0], "oxc", "oxc alone is the tie-break winner");
  assert.equal(ORDER.at(-1), "swc", "SWC alone wins only when strictly smaller than the three oxc-last arrangements");
  assert.equal(SWC_COMPRESS_OPTIONS.mangle, false, "the pre-pass leaves names for oxc to mangle");
  assert.equal(SWC_FULL_OPTIONS.mangle.toplevel, false, "SWC alone keeps top-level names, like oxc-minify-options.ts");
  assert.equal(SWC_COMPRESS_OPTIONS.module, "unknown", "SWC refuses `import` under module:false; seven client files are ES modules");
  assert.ok(SWC_COMPRESS_OPTIONS.compress.ecma >= 2022, "SWC's ecma default is 5, which forbids modern syntax in the output");
  // A file with a guard clause and scattered vars is the shape SWC's passes
  // exist for; the pre-pass has to produce fewer bytes than oxc alone on it,
  // or the dependency is not buying what its header claims.
  const src = `(function(){var a=document.getElementById("x");if(!a)return;var b=a.textContent;if(!b)return;var c=b.length;function f(){return c*2}window.__probe=f()})();`;
  const { sizes } = minifyJavaScript("probe.js", src);
  assert.ok(Math.min(sizes["swc>oxc"], sizes["oxc>swc>oxc"], sizes.swc) < sizes.oxc, `SWC bought nothing on the guard-clause probe: ${JSON.stringify(sizes)}`);
});
