// ── lens phases: pay for what you asked for ──────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── lens phases: pay for what you asked for ──────────────────────────────

test("a page-only scan omits the discovery-derived fields rather than zeroing them", async () => {
  // The honesty rule of the split. A readiness score computed without discovery
  // is not a partial score, it is a WRONG one, and `doors: 0` would read as
  // "this site has no agent doors" when it means "nobody looked". So the fields
  // are ABSENT and `phases` says which ran.
  const { lensInspect, lensObservationSummary } = await import("../src/worker/lens.ts");
  let out;
  try {
    out = await lensInspect("https://example.com/", {}, { phases: ["page"] });
  } catch { return; }   // no signing key here; the shape assertions below need a body

  assert.equal(out.phases.page, true);
  assert.equal(out.phases.discovery, false);
  // Absent, not empty. `in` rather than a truthiness check, because {} and 0
  // are exactly the values that would lie.
  assert.ok(!("readiness" in out), "readiness must be absent when discovery did not run");
  assert.ok(!("agent" in out), "agent doors must be absent when discovery did not run");
  assert.ok(!("discovery" in out));

  // And the summary carries the phase forward, so a caller downstream can still
  // tell a zero from an absence.
  const summary = lensObservationSummary(out);
  assert.equal(summary.phases.discovery, false);
});

test("the default scan is unchanged — every phase still runs", async () => {
  // The split must be opt-in. Existing callers (/lens/fetch, lens_inspect,
  // /lens, the census) pass no phases and must keep the full behaviour.
  const src = readFileSync("src/worker/lens.ts", "utf8");
  assert.match(src, /if \(opts\.phases && !opts\.phases\.includes\("discovery"\)\) return out;/,
    "the early return must require an explicit phases opt-in");
  // A summary built from a full result reports every phase true by default, so
  // nothing downstream has to special-case the old shape.
  const { lensObservationSummary } = await import("../src/worker/lens.ts");
  assert.deepEqual(lensObservationSummary({}).phases, { page: true, discovery: true, botViews: true });
});
