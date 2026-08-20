// ── reading somebody else's site ─────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.mjs";

// ── reading somebody else's site ─────────────────────────────────────────



test("a door that could not be read is never reported as a door that is shut", async () => {
  // The honesty invariant, asserted on the classifier directly. Locally every
  // external probe fails for want of the AadharshBot signing key, and reporting
  // that as "not served" would have this thing confidently announcing that
  // well-known origins have no llms.txt.
  const { classifyDoor } = await import("../src/worker/lib/doors.ts");

  const failed = classifyDoor({ ok: false, error: "signing key is unavailable" }, "text/plain");
  assert.equal(failed.ok, false);
  assert.equal(failed.unreadable, true, "a failed check was reported as a negative result");

  // A real 404 IS a finding, and must not be confused with the above.
  const missing = classifyDoor({ ok: false, status: 404 }, "text/plain");
  assert.equal(missing.ok, false);
  assert.ok(!missing.unreadable, "a 404 is a shut door, not an unreadable one");
  assert.equal(missing.why, "HTTP 404");

  // A 200 that answers the wrong content-type is not an open door: SPA
  // catch-alls serve their shell for every unknown path, and counting that as
  // present would make this reader agree with every site that has no agent
  // surface at all.
  const spa = classifyDoor({ ok: true, status: 200, body: "<!doctype html>", contentType: "text/html; charset=utf-8" }, "text/plain");
  assert.equal(spa.ok, false);
  assert.equal(spa.wrongType, "text/html");

  // And the happy path still opens.
  const open = classifyDoor({ ok: true, status: 200, body: "# llms\nhello", contentType: "text/plain" }, "text/plain");
  assert.equal(open.ok, true);
  assert.equal(open.bytes, 12);
});

test("the MCP client reads both Streamable HTTP framings", async () => {
  // A server answers one JSON object or an SSE stream, at its own discretion.
  // A client that handles only the first reports the second as a broken door,
  // which is the exact dishonesty classifyDoor above exists to prevent.
  const { parseMcpBody } = await import("../src/worker/lib/doors.ts");

  const plain = parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', "application/json");
  assert.equal(plain.ok, true);
  assert.equal(plain.framing, "json");

  // Byte-for-byte the shape mcp.deepwiki.com returns, measured 2026-08-14.
  const stream = parseMcpBody(
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ask_question"}]}}\n\n',
    "text/event-stream",
  );
  assert.equal(stream.ok, true);
  assert.equal(stream.framing, "sse");
  assert.equal(stream.payload.result.tools[0].name, "ask_question");

  // The content-type is a hint, not the rule: a stream under the wrong type is
  // still a stream, and a data: line is unambiguous.
  assert.equal(parseMcpBody('data: {"jsonrpc":"2.0","result":{}}\n\n', "text/plain").framing, "sse");

  // A stream carries keep-alives and notifications as well as the answer, so
  // the first line that PARSES is not necessarily the message.
  const noisy = parseMcpBody(
    ': keep-alive\ndata: {"note":"not jsonrpc"}\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"real"}]}}\n\n',
    "text/event-stream",
  );
  assert.equal(noisy.payload.result.tools[0].name, "real");

  // And the two failures stay legible rather than throwing.
  assert.equal(parseMcpBody(": keep-alive\ndata: not json\n\n", "text/event-stream").ok, false);
  const html = parseMcpBody("<!doctype html>", "text/html; charset=utf-8");
  assert.equal(html.ok, false);
  assert.match(html.detail, /text\/html/, "a shut door should name what it answered instead");
});
