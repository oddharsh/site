// ── lens parse budget: the CPU-bound half ────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

test("the parse is capped, and a prefix parse says so instead of under-reporting", async () => {
  const { LENS_PARSE_CAP, lensObservationSummary } = await import("../src/worker/lens.ts");
  assert.ok(LENS_PARSE_CAP > 0 && LENS_PARSE_CAP <= 512 * 1024);

  const truncated = lensObservationSummary({
    anatomy: { rawBytes: 2_000_000, parsedBytes: 262_144, parseTruncated: true, wordCount: 400 },
  });
  assert.equal(truncated.bytes, 2_000_000, "bytes must report the whole document");
  assert.equal(truncated.parsedBytes, 262_144);
  assert.equal(truncated.parseTruncated, true);

  const whole = lensObservationSummary({ anatomy: { rawBytes: 40_000, wordCount: 900 } });
  assert.equal(whole.parseTruncated, false);
  assert.equal(whole.parsedBytes, 40_000);
});

test("the parse cap is a deployment knob, not a code change", async () => {
  const { LENS_PARSE_CAP, lensParseCap } = await import("../src/worker/lens.ts");
  const KB = 1024;
  assert.equal(lensParseCap(undefined), LENS_PARSE_CAP, "no env must read the default");
  assert.equal(lensParseCap({}), LENS_PARSE_CAP, "an unset var must read the default, not the 8 KB floor");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "64" }), 64 * KB, "the free-plan flip");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "1" }), 8 * KB, "a tiny override hits the floor");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "0" }), LENS_PARSE_CAP, "zero means unset");
  assert.equal(lensParseCap({ LENS_PARSE_KB: "lots" }), LENS_PARSE_CAP, "a non-number means unset");
});
