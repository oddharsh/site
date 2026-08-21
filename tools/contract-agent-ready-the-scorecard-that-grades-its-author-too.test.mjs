// ── /agent-ready — the scorecard that grades its author too ──────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  terminalGet,
  test,
} from "./contract-shared.mjs";

// ── /agent-ready — the scorecard that grades its author too ──────────────

test("the lift table is internally consistent and names its baseline", async () => {
  // The bill is hand-maintained with a checked date, the same contract lens's
  // census runs on. What a test CAN hold is that it adds up and that the
  // baseline is a real subset — a claim like "compatibility is a weekend" is
  // only worth making if the number behind it is derived from the table.
  const { LIFT, BASELINE, liftTotals, LIFT_CHECKED } = await import("../src/worker/agent-ready.ts");
  assert.match(LIFT_CHECKED, /^\d{4}-\d{2}-\d{2}$/, "the bill must carry a checked date");

  const names = LIFT.map(([n]) => n);
  for (const b of BASELINE) assert.ok(names.includes(b), `baseline names ${b}, which is not in the table`);

  const totals = liftTotals();
  assert.equal(totals.lines, LIFT.reduce((n, [, , lines]) => n + lines, 0));
  assert.equal(totals.baseline, LIFT.filter(([n]) => BASELINE.includes(n)).reduce((n, [, , l]) => n + l, 0));
  // The headline claim: baseline is a small fraction of the whole.
  assert.ok(totals.baseline < totals.lines / 3, "baseline should be a minority of the total, or the claim is wrong");
  for (const [name, files, lines, buys] of LIFT) {
    assert.ok(files > 0 && lines > 0, `${name} must carry real counts`);
    assert.ok(buys && buys.length > 8, `${name} must say what it buys, not just what it cost`);
  }
});

test("doors are counted, and unreadable is never counted as either", async () => {
  // The rule this whole codebase keeps rediscovering. A check that could not run
  // is not a pass and not a failure, and a scorecard that collapses it into
  // either one is lying about a site it never reached.
  const { scoreDoors } = await import("../src/worker/agent-ready.ts");
  const s = scoreDoors({
    llms: { ok: true }, markdown: { ok: false, why: "HTTP 404" },
    agentCard: { ok: false, unreadable: true, why: "no signing key" },
    apiCatalog: { ok: false }, mcp: { ok: false, unreadable: true },
  });
  assert.equal(s.total, 5);
  assert.equal(s.open, 1);
  assert.equal(s.unread, 2, "unreadable doors must be counted separately");
  // open + unread must never be conflated into a score.
  assert.ok(!("score" in s) && !("grade" in s), "no single number may stand in for the observation");
});

test("the scorecard grades other origins, and only bills its own", async () => {
  // A scorecard that can only flatter its author is marketing. And the bill is
  // meaningless for an origin whose source tree we do not have, so it is shown
  // for the self-audit alone.
  const self = await (await terminalGet("/agent-ready?plain=1")).text();
  assert.match(self, /what this cost to build/);
  assert.match(self, /aadhar\.sh/);

  const foreign = await (await terminalGet("/agent-ready?plain=1&url=https%3A%2F%2Fexample.com")).text();
  assert.ok(!/what this cost to build/.test(foreign), "the bill must not appear for a foreign origin");
  assert.match(foreign, /doors a machine can walk through/);

  const refused = await (await terminalGet("/agent-ready?plain=1&url=http%3A%2F%2F169.254.169.254%2F")).text();
  assert.match(refused, /refused/);
});
