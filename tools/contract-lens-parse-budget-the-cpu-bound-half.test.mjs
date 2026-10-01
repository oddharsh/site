// ── lens parse budget: the CPU-bound half ────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

// ── lens parse budget: the CPU-bound half ────────────────────────────────

test("the parse is capped, and a prefix parse says so instead of under-reporting", async () => {
  // lensText/lensMarkdown are regex chains costing ~32ms per MB (measured, node,
  // same V8). At the old 2MB fetch cap that is ~64ms of pure CPU — impossible on
  // the Workers free plan's 10ms ceiling and wasteful on paid. Capping the PARSE
  // bounds the worst case; the median page is nowhere near it and is untouched.
  const { LENS_PARSE_CAP, lensObservationSummary } = await import("../src/worker/lens.ts");
  assert.ok(LENS_PARSE_CAP > 0 && LENS_PARSE_CAP <= 512 * 1024);

  // rawBytes must stay the TRUE size. We know it from the fetch even when we
  // decline to parse all of it, and reporting the prefix as the page's size
  // would be a plain lie about the thing being measured.
  const truncated = lensObservationSummary({
    anatomy: { rawBytes: 2_000_000, parsedBytes: 262_144, parseTruncated: true, wordCount: 400 },
  });
  assert.equal(truncated.bytes, 2_000_000, "bytes must report the whole document");
  assert.equal(truncated.parsedBytes, 262_144);
  assert.equal(truncated.parseTruncated, true);

  // An un-truncated scan reports no prefix and parsedBytes falls back to the size.
  const whole = lensObservationSummary({ anatomy: { rawBytes: 40_000, wordCount: 900 } });
  assert.equal(whole.parseTruncated, false);
  assert.equal(whole.parsedBytes, 40_000);
});

test("the parse cap is a deployment knob, not a code change", async () => {
  // "Move lens onto the free plan" should be a var flip. The floor keeps a
  // typo (LENS_PARSE_KB=1) from disabling parsing entirely.
  //
  // Asserted through lensParseCap rather than over lens.ts's source text, which
  // is what this test did until 2026-10-01: its floor regex matched only the
  // COMMENT quoting the old `||` bug, so it would have stayed green with the
  // floor deleted from the code. And the case that bug got wrong (unset reads
  // the 256 KB default, never the 8 KB floor) is the first assertion here.
  const { LENS_PARSE_CAP, lensParseCap } = await import("../src/worker/lens.ts");
  const KB = 1024;
  assert.equal(lensParseCap(undefined), LENS_PARSE_CAP, "no env must read the default");
  assert.equal(lensParseCap({}), LENS_PARSE_CAP, "an unset var must read the default, not the 8 KB floor");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "64" }), 64 * KB, "the free-plan flip");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "1" }), 8 * KB, "a tiny override hits the floor");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "0" }), LENS_PARSE_CAP, "zero means unset");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "lots" }), LENS_PARSE_CAP, "a non-number means unset");
});
