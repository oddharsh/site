// ── lens phases: pay for what you asked for ──────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

test("a page-only scan omits the discovery-derived fields rather than zeroing them", async () => {
  const { lensInspect, lensObservationSummary } = await import("../src/worker/lens.ts");
  let out;
  try {
    out = await lensInspect("https://example.com/", {}, { phases: ["page"] });
  } catch { return; }

  assert.equal(out.phases.page, true);
  assert.equal(out.phases.discovery, false);
  assert.ok(!("readiness" in out), "readiness must be absent when discovery did not run");
  assert.ok(!("agent" in out), "agent doors must be absent when discovery did not run");
  assert.ok(!("discovery" in out));

  const summary = lensObservationSummary(out);
  assert.equal(summary.phases.discovery, false);
});

test("the default scan is unchanged — every phase still runs", async () => {
  const src = readFileSync("src/worker/lens.ts", "utf8");
  assert.match(src, /if \(opts\.phases && !opts\.phases\.includes\("discovery"\)\) return out;/,
    "the early return must require an explicit phases opt-in");
  const { lensObservationSummary } = await import("../src/worker/lens.ts");
  assert.deepEqual(lensObservationSummary({}).phases, { page: true, discovery: true, botViews: true });
});
