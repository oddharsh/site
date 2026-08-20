// ── /cache — the behavioral revalidation lint ───────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.mjs";

// ── /cache — the behavioral revalidation lint ───────────────────
// judgeRevalidation is pure: the whole product is the rules, and the network
// half dies at signing under plain node anyway.

test("an ETag that changes between identical fetches is called what it is", async () => {
  // THE failure this tool exists for. Headers look perfect, and every
  // If-None-Match will 200 with a full body, forever.
  const { judgeRevalidation } = await import("../src/worker/cache-lint.ts");
  const v = judgeRevalidation({
    first: { status: 200, headers: { etag: '"abc-gzip"', "cache-control": "max-age=600" } },
    second: { status: 200, headers: { etag: '"abc-br"' } },
    conditional: { status: 200, headers: {} },
  });
  assert.equal(v.healthy, false);
  assert.ok(v.vetoes.some((f) => f.id === "stability"), "an unstable validator must be a veto");
  // The 200 is consistent with the unstable ETag, so it is explained rather
  // than double-counted as a second independent failure.
  assert.ok(v.findings.some((f) => f.id === "revalidation" && f.verdict === "bad-but-explained"));
});

test("a stable ETag the origin then ignores is its own distinct failure", async () => {
  const { judgeRevalidation } = await import("../src/worker/cache-lint.ts");
  const v = judgeRevalidation({
    first: { status: 200, headers: { etag: '"stable"' } },
    second: { status: 200, headers: { etag: '"stable"' } },
    conditional: { status: 200, headers: {} },
  });
  assert.ok(v.vetoes.some((f) => f.id === "revalidation"), "a stable validator answered 200 — the origin ignores conditionals");
  assert.ok(!v.vetoes.some((f) => f.id === "stability"), "stability itself passed and must say so");
});

test("the healthy path and the no-validator path both read correctly", async () => {
  const { judgeRevalidation } = await import("../src/worker/cache-lint.ts");
  const healthy = judgeRevalidation({
    first: { status: 200, headers: { etag: '"v1"', "cache-control": "max-age=300" } },
    second: { status: 200, headers: { etag: '"v1"' } },
    conditional: { status: 304, headers: {} },
  });
  assert.equal(healthy.healthy, true);

  const none = judgeRevalidation({ first: { status: 200, headers: {} }, second: { status: 200, headers: {} }, conditional: null });
  assert.ok(none.vetoes.some((f) => f.id === "validator"), "no validator at all is a veto, not a silent pass");
});

test("negotiating on Accept without saying so in Vary is flagged — the #195 trap", async () => {
  // Hit in production on THIS site: markdown negotiation answered from a warm
  // URL-keyed cache as HTML, because the stored Vary named only accept-encoding.
  const { judgeRevalidation } = await import("../src/worker/cache-lint.ts");
  const base = { status: 200, headers: { etag: '"x"', "content-type": "text/html", vary: "accept-encoding" } };
  const trapped = judgeRevalidation({
    first: base, second: base, conditional: { status: 304, headers: {} },
    negotiated: { status: 200, headers: { "content-type": "text/markdown" } },
  });
  assert.ok(trapped.vetoes.some((f) => f.id === "vary"));

  const honest = judgeRevalidation({
    first: { ...base, headers: { ...base.headers, vary: "accept-encoding, accept" } },
    second: base, conditional: { status: 304, headers: {} },
    negotiated: { status: 200, headers: { "content-type": "text/markdown" } },
  });
  assert.ok(!honest.vetoes.some((f) => f.id === "vary"), "declared negotiation is fine");
});
