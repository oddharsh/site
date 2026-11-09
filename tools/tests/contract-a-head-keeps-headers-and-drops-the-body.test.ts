// ── A HEAD keeps the GET's headers and drops its body ───────────────────────
// lib/http.ts's forMethod is the one way a response built for a GET answers a
// HEAD (the 404 page, the 500 page, a negotiated Markdown twin).
import { assert, test } from "./contract-shared.ts";

test("forMethod: GET passes through; HEAD keeps status and headers, cancels the body", async () => {
  const { forMethod } = await import("../../src/worker/lib/http.ts");
  const make = () => new Response("page", { status: 404, headers: { "content-type": "text/html", "x-k": "v" } });

  const get = make();
  assert.equal(forMethod(new Request("https://aadhar.sh/x"), get), get, "a GET gets the very same response");

  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  const head = forMethod(new Request("https://aadhar.sh/x", { method: "HEAD" }), new Response(body, make()));
  assert.equal(head.status, 404);
  assert.equal(head.headers.get("x-k"), "v");
  assert.equal(head.headers.get("content-type"), "text/html");
  assert.equal(head.body, null);
  assert.equal(cancelled, true, "the GET body's stream is released, not left unread");
});
