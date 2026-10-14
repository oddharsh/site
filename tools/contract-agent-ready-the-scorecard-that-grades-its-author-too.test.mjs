// ── /agent-ready — the scorecard that grades its author too ──────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  context,
  handleTool,
  terminalGet,
  terminalReq,
  test,
  testGlobals,
} from "./contract-shared.ts";

test("the lift table is internally consistent and names its baseline", async () => {
  const { LIFT, BASELINE, liftTotals, LIFT_CHECKED } = await import("../src/worker/agent-ready.ts");
  assert.match(LIFT_CHECKED, /^\d{4}-\d{2}-\d{2}$/, "the bill must carry a checked date");

  const names = LIFT.map(([n]) => n);
  for (const b of BASELINE) assert.ok(names.includes(b), `baseline names ${b}, which is not in the table`);

  const totals = liftTotals();
  assert.equal(totals.lines, LIFT.reduce((n, [, , lines]) => n + lines, 0));
  assert.equal(totals.baseline, LIFT.filter(([n]) => BASELINE.includes(n)).reduce((n, [, , l]) => n + l, 0));
  assert.ok(totals.baseline < totals.lines / 3, "baseline should be a minority of the total, or the claim is wrong");
  for (const [name, files, lines, buys] of LIFT) {
    assert.ok(files > 0 && lines > 0, `${name} must carry real counts`);
    assert.ok(buys && buys.length > 8, `${name} must say what it buys, not just what it cost`);
  }
});

test("doors are counted, and unreadable is never counted as either", async () => {
  const { scoreDoors } = await import("../src/worker/agent-ready.ts");
  const s = scoreDoors({
    llms: { ok: true }, markdown: { ok: false, why: "HTTP 404" },
    agentCard: { ok: false, unreadable: true, why: "no signing key" },
    apiCatalog: { ok: false }, mcp: { ok: false, unreadable: true },
  });
  assert.equal(s.total, 5);
  assert.equal(s.open, 1);
  assert.equal(s.unread, 2, "unreadable doors must be counted separately");
  assert.ok(!("score" in s) && !("grade" in s), "no single number may stand in for the observation");
});

test("the scorecard grades other origins, and only bills its own", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    testGlobals.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      seen.push(url);
      if (new URL(url).pathname === "/llms.txt") {
        return new Response("# a readable map\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    };

    const self = await (await handleTool(terminalReq("/agent-ready?plain=1"), { SELF_FETCH: testGlobals.fetch }, context())).text();
    assert.match(self, /what this cost to build/);
    assert.match(self, /aadhar\.sh/);
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
