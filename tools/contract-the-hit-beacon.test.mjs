// ── the /hit beacon ─────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  handleHit,
  test,
} from "./contract-shared.mjs";

// ── the /hit beacon ─────────────────────────────────────────────────
// The counter's Durable Object is a single global instance, so reaching it costs
// a real round trip (185-308ms from SJC; 630ms observed on a cold contended
// load). The ?tick=1 beacon discards the number, so it must not wait for one —
// but the tick still has to happen, which is what waitUntil buys. The SVG shape
// DOES need the number, so it must keep waiting. These two tests pin that split;
// collapsing either direction is a real regression.
function slowCounter() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  return {
    release,
    seen,
    env: {
      COUNTER: {
        idFromName: () => "homepage-visits",
        get: () => ({
          async fetch(u) { seen.push(new URL(u).search); await gate; return Response.json({ n: 41 }); },
        }),
      },
    },
  };
}

test("the /hit beacon answers 204 without waiting on the Durable Object", async () => {
  const { env, seen, release } = slowCounter();
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };

  const res = await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(seen.length, 1, "the tick must still be initiated, not skipped");
  assert.equal(seen[0], "", "a real beacon advances the count (no ?peek)");
  assert.equal(kept.length, 1, "the unfinished DO trip must be handed to waitUntil");

  release();
  await kept[0];   // and it still completes behind the response
});

test("the /hit beacon still ticks when there is no ctx to defer onto", async () => {
  const { env, seen, release } = slowCounter();
  release();   // resolve immediately; without a ctx the handler must await it
  const res = await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, undefined);
  assert.equal(res.status, 204);
  assert.equal(seen.length, 1, "no ctx must mean await, never a dropped tick");
});

test("the /hit odometer waits for the number it renders", async () => {
  const { env, release } = slowCounter();
  const ctx = { waitUntil: () => {} };
  let settled = false;
  const pending = handleHit(new Request("https://aadhar.sh/hit"), env, ctx).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "the SVG shape must not answer before the DO does");
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^image\/svg\+xml/);
  assert.match(await res.text(), /000041/, "the odometer renders the DO's number");
});

test("a peeking /hit reads without advancing, in either shape", async () => {
  for (const [label, req] of [
    ["prefetch", new Request("https://aadhar.sh/hit?tick=1", { headers: { "sec-purpose": "prefetch;prerender" } })],
    ["bot", new Request("https://aadhar.sh/hit", { headers: { "user-agent": "ClaudeBot/1.0" } })],
  ]) {
    const { env, seen, release } = slowCounter();
    release();
    const kept = [];
    await handleHit(req, env, { waitUntil: (p) => kept.push(p) });
    await Promise.all(kept);
    assert.equal(seen[0], "?peek=1", `${label} must peek, never advance`);
  }
});
