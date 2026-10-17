// ── Worker request deadlines are AbortSignal.timeout, and a timeout is named ──
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

// Every outbound deadline in the Worker code is `AbortSignal.timeout(ms)`. It
// replaced 18 hand-rolled ones (an AbortController, a setTimeout that aborted
// it, and a finally that cleared the timer) on 2026-10-01. The platform owns the
// timer, so there is nothing to clear, and the deadline covers the body read as
// well as the headers. Four /lens probes used to clear theirs as soon as headers
// arrived, which left a slow-drip body unbounded.
//
// The one behaviour that changes is the error NAME. A fetch cut off by
// AbortSignal.timeout rejects with `TimeoutError`, where `controller.abort()`
// rejected with `AbortError` (both measured in workerd 2026-09-26). Two callers
// turned that name into a visitor-facing message, and a check left on the old
// name would quietly turn "the site took too long" into a generic failure.

test("a /lens scan that times out still says it timed out", async () => {
  const { handleLensFetch } = await import("../src/worker/lens.ts");
  const scan = async (error) => {
    // aadhar.sh scans dispatch through SELF_FETCH, so the deadline's rejection can
    // be injected without the network, with the exact shape workerd throws.
    const env = { SELF_FETCH: async () => { throw error; } };
    const res = await handleLensFetch(
      new Request("https://aadhar.sh/lens/fetch?url=https%3A%2F%2Faadhar.sh%2F&phases=page"),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, body: await res.json() };
  };

  const timedOut = await scan(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(timedOut.status, 502);
  assert.equal(timedOut.body.error, "The site took too long to answer (8s timeout).");

  // Control: a cancellation that is NOT the deadline must not claim to be one.
  const cancelled = await scan(new DOMException("The operation was aborted", "AbortError"));
  assert.equal(cancelled.status, 502);
  assert.notEqual(cancelled.body.error, timedOut.body.error);
});

// A hand-rolled abort timer, in the shape the 18 replaced sites had.
const HAND_ROLLED = /setTimeout\(\s*\(\)\s*=>\s*\w+\.abort\(/;

test("the matcher sees a hand-rolled abort timer (control)", () => {
  assert.ok(HAND_ROLLED.test("const to = setTimeout(() => ctrl.abort(), 8000);"));
  assert.ok(!HAND_ROLLED.test("const deadline = AbortSignal.timeout(8000);"));
});

test("no Worker code arms its own abort timer", () => {
  const roots = ["src/worker", "cal/src", "serendipity", "counter/src", "lens-reader/src", "lwe-ask/src", "cf-garage/src"];
  const files = execFileSync("git", ["ls-files", "-z", "--", ...roots], { cwd: new URL(".", ROOT), encoding: "utf8" })
    .split("\0")
    .filter((rel) => /\.(?:ts|js|mjs)$/.test(rel));
  // FLOOR. An enumerator that returns nothing passes everything.
  assert.ok(files.length >= 100, `found only ${files.length} Worker source files; the enumerator is broken`);
  const offenders = files.filter((rel) => HAND_ROLLED.test(readFileSync(new URL(rel, new URL(".", ROOT)), "utf8")));
  assert.deepEqual(offenders, [],
    "use `AbortSignal.timeout(ms)` for a request deadline: the platform owns the timer, so there is no finally to forget, and the body read is covered too");
});
