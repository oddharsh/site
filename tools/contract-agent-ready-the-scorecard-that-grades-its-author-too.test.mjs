// ── /agent-ready — the scorecard that grades its author too ──────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  terminalGet,
  test,
  testGlobals,
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
  //
  // The doors are stubbed because this test never read them. Measured
  // 2026-08-21 with a fetch counter, the three scans below made 34 real
  // requests: 26 door probes and 4 DNS-AID lookups against production
  // aadhar.sh for the self-audit, plus 4 more DNS lookups for example.com.
  // Every assertion was about the frame's SHAPE, so all 34 bought no coverage.
  //
  // The risk they carried was the TIMEOUT, not a wrong answer, and the obvious
  // guess is wrong here. Each probe is individually caught, so a dead network
  // degrades every door to `unreadable` and the frame still renders: running
  // all 47 files with `fetch` throwing gives 338 pass on this commit AND on the
  // one before it. What a slow production costs is wall clock against bun's
  // 5000ms per-test default, which is a hard fail rather than a slow pass.
  // Timed cold on a healthy workstation, this body spent 3328ms of that 5000 on
  // connection setup, then 85ms per repeat once the connection was warm. So the
  // whole margin was TLS and DNS to a host CI has no reason to have talked to.
  //
  // Worth knowing why the foreign scan cost only DNS: an external probe is
  // signed, the AadharshBot key is a secret, and secrets are unavailable under
  // node, so every foreign HTTP door already failed before it reached a fetch.
  // That half was never testing the network to begin with.
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    // llms.txt answers and nothing else does, so the frame has to render an
    // open door beside four shut ones. A stub that answered everything the same
    // way would let a scorecard that ignores its input pass.
    testGlobals.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      seen.push(url);
      if (new URL(url).pathname === "/llms.txt") {
        return new Response("# a readable map\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    };

    const self = await (await terminalGet("/agent-ready?plain=1")).text();
    assert.match(self, /what this cost to build/);
    assert.match(self, /aadhar\.sh/);
    // The scan read what it was served rather than defaulting: one door open,
    // and a 404 reported as SHUT rather than as unreadable, which is the
    // distinction the whole surface exists to keep.
    assert.match(self, /open\s+llms\.txt/, "the open door the stub served is not rendered as open");
    assert.match(self, /shut\s+agent card/, "a 404 is a shut door, never an unreadable one");

    const foreign = await (await terminalGet("/agent-ready?plain=1&url=https%3A%2F%2Fexample.com")).text();
    assert.ok(!/what this cost to build/.test(foreign), "the bill must not appear for a foreign origin");
    assert.match(foreign, /doors a machine can walk through/);

    // A refused target must be refused BEFORE anything leaves, which no
    // assertion covered while the suite was making real requests anyway.
    // 169.254.169.254 is the cloud metadata address, so a probe that escaped
    // here would be the SSRF this guard exists to stop.
    const before = seen.length;
    const refused = await (await terminalGet("/agent-ready?plain=1&url=http%3A%2F%2F169.254.169.254%2F")).text();
    assert.match(refused, /refused/);
    assert.equal(seen.length, before, "a refused target must not reach a fetch at all");
  } finally {
    testGlobals.fetch = realFetch;
  }
});
