// ── ci:census: a failure is named by what failed, and only real lines count ──
import { assert, test } from "./contract-shared.ts";
import { gated, signature, suspects } from "../ci-census.ts";

// tools/ci-census.ts groups failed CI runs by the first test that failed. The
// fixture lines are shaped like `gh run view --log-failed` output: job, step,
// timestamp, text. The echoed-script line is the one that once made 24
// unrelated runs share a title.

const line = (text: string) => `validate\tUNKNOWN STEP\t2026-10-16T01:12:48.6316278Z ${text}`;

test("ci:census: names a job by its first failing test, through the workspace prefix", () => {
  const log = [
    line("cal-aadhar-sh test: (pass) routing > unknown path → 404 [15.72ms]"),
    line("cal-aadhar-sh test: (fail) POST /book validation > two bookings take one slot [130.48ms]"),
  ].join("\n");
  assert.equal(signature(log, "Test coffee Worker"), "POST /book validation > two bookings take one slot");
});

test("ci:census: an ::error echoed inside a step's script isn't an annotation", () => {
  const echoed = line("\x1b[36;1m    console.error(`::error title=zstd dictionary ignored::none=${none}`);\x1b[0m");
  assert.equal(signature(echoed, "Format"), "Format");
  const real = line("::error title=error: Test %22x%22 timed out after 5000ms::");
  assert.equal(signature([echoed, real].join("\n"), "Format"), 'error: Test "x" timed out after 5000ms');
});

test("ci:census: a gated step on branches is their own bug; on main it's a suspect", () => {
  assert.equal(gated("Typecheck"), true);
  assert.equal(gated("Test coffee Worker"), false);
  const f = (branch: string, step: string, sig = step) => ({ id: 1, branch, date: "2026-10-16", step, signature: sig });
  const found = suspects([
    f("claude/a", "Typecheck"),
    f("claude/b", "Typecheck"),
    f("claude/a", "Test coffee Worker", "race"),
    f("claude/b", "Test coffee Worker", "race"),
    f("main", "Check page contracts and copy"),
  ]).map((s) => s.sig);
  assert.deepEqual(found.sort(), ["Check page contracts and copy", "race"]);
});
