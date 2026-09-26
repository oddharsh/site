// ── q11 twins are served at q11 ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
//
// `bun run q11:check` sweeps every twin the build writes and asks whether the
// bytes on the wire ARE the twin, by re-encoding what arrived at the build's
// settings and comparing. It reads production, so it is advisory and never runs
// here; what runs here is the part a network cannot break: the classifier and
// the twin-to-URL map it rests on, plus the one handler that serves a twin by
// hand rather than through servePrecompressedText.
//
// The handler is /llms-full.txt. Until 2026-09-26 it read the built file with
// .text() and returned a fresh unencoded body, so the edge compressed 516 KB
// on the fly at about q4: 188,401 B against 156,709 B at q11. The route
// oracle's `encoding: br` row could not see that, because the local harness
// re-encodes an unencoded text body to br by itself. The q11:check run against
// the old handler flagged exactly this URL and no other (177,938 B locally).
import { assert, context, test } from "./contract-shared.ts";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { classify, kindOfTwin, q11, urlForTwin } from "./check-q11.ts";
import { handleLlmsFull } from "../src/worker/x402.ts";

// Big enough that q4 and q11 produce different streams, which is the whole
// distinction under test. A tiny input can encode identically at both.
const PLAIN = Buffer.from(Array.from({ length: 400 }, (_, i) => `line ${i}: the corpus, ${i % 7} ${"ab".repeat(i % 13)}\n`).join(""));

test("the classifier tells a q11 twin from every other encoding of the same bytes", () => {
  assert.equal(classify("br", q11(PLAIN)).verdict, "q11");
  // THE CONTROL: the shape an edge produces on the fly. If this read q11 the
  // sweep could not fail, which is the check agreeing with itself.
  const q4 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } });
  const v = classify("br", q4);
  assert.equal(v.verdict, "not-q11");
  assert.equal(v.verdict === "not-q11" && v.q11, q11(PLAIN).length, "must report the size the twin would have been");
  // Same quality, different window: same content, different stream. That is a
  // re-encode somewhere between the Worker and the client, never our twin.
  const w22 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 22 } });
  assert.equal(classify("br", w22).verdict, "not-q11");
  assert.equal(classify("gzip", gzipSync(PLAIN)).verdict, "not-q11");
  assert.equal(classify(null, PLAIN).verdict, "not-q11", "an unencoded body is not a twin");
  // A header that lies about the body is its own finding, not a crash.
  assert.equal(classify("br", PLAIN).verdict, "undecodable");
  assert.equal(classify("dcz", q11(PLAIN)).verdict, "undecodable");
});

test("q11() is build.ts's brotliQ11, so a served twin reads as q11", async () => {
  // A drift in either copy of the settings reads every served twin as a
  // finding. Assert the settings in the build's source rather than trust that
  // both copies were edited together.
  const { readFile } = await import("node:fs/promises");
  const build = await readFile(new URL("build.ts", import.meta.url), "utf8");
  const fn = build.match(/function brotliQ11\([\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(fn, /BROTLI_PARAM_QUALITY\]: 11/);
  assert.match(fn, /BROTLI_PARAM_LGWIN\]: 24/);
  assert.match(fn, /BROTLI_PARAM_SIZE_HINT\]: bytes\.length/);
});

test("every twin shape maps to the URL a visitor requests", () => {
  const cases = [
    ["index.html.br", "/", "page"],
    ["garage/index.html.br", "/garage", "page"],
    ["garage/horizon.html.br", "/garage/horizon", "page"],
    ["garage/horizon.src.html.br", "/garage/horizon.src.html", "text"],
    ["index.src.html.br", "/index.src.html", "text"],
    ["a/nav.1c6af07b.js.br", "/a/nav.1c6af07b.js", "shell"],
    ["a/page-family.33367f41.dict.br", "/a/page-family.33367f41.dict", "shell"],
    ["garage/horizon.md.br", "/garage/horizon.md", "text"],
    ["llms-full.txt.br", "/llms-full.txt", "text"],
  ];
  for (const [rel, path, kind] of cases) {
    assert.equal(urlForTwin(rel), path, rel);
    assert.equal(kindOfTwin(rel), kind, rel);
  }
});

// ── /llms-full.txt serves its twin ──────────────────────────────────────────
const TWIN = q11(PLAIN);
function env({ twin = true, identity = false } = {}) {
  const asked = [];
  const out = {
    asked,
    IDENTITY_BODY: false,
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        asked.push({ path, ae: req.headers.get("accept-encoding") });
        if (path === "/llms-full.txt") return new Response(new Uint8Array(PLAIN), { headers: { "content-type": "text/plain" } });
        if (path === "/llms-full.txt.br" && twin) {
          return new Response(new Uint8Array(TWIN), { headers: { "content-type": "application/octet-stream", "content-length": String(TWIN.length) } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
  if (identity) out.IDENTITY_BODY = true;
  return out;
}
const ask = (e) => handleLlmsFull(new Request("https://aadhar.sh/llms-full.txt"), /** @type {any} */ (e), context());

test("/llms-full.txt hands over the q11 twin with the plain route's headers", async () => {
  const e = env();
  const res = await ask(e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", "the twin's octet-stream type must not leak");
  assert.equal(res.headers.get("cache-control"), "no-store", "the paid response carries a receipt and must never be shared");
  assert.equal(res.headers.get("content-length"), String(TWIN.length));
  assert.match(res.headers.get("vary") ?? "", /accept-encoding/);
  assert.ok(res.headers.get("x-payment-note"), "the ungated note must survive the twin path");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(TWIN), "the body must be the twin's bytes, untouched");
  assert.deepEqual(e.asked, [{ path: "/llms-full.txt.br", ae: "identity" }],
    "one lookup, asking for identity so the asset layer cannot wrap the twin again");
});

test("/llms-full.txt falls back to the plain file, unencoded, on every miss", async () => {
  for (const { label, e } of [
    { label: "no twin (bun run dev stages nothing derived)", e: env({ twin: false }) },
    { label: "in-process caller (IDENTITY_BODY, the /lens self-scan)", e: env({ identity: true }) },
  ]) {
    const res = await ask(e);
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get("content-encoding"), null, `${label}: must not claim an encoding it did not apply`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PLAIN), `${label}: body must be the plain file`);
  }
});
