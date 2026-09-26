// ── q11 twins are served at q11 ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
//
// `bun run q11:check` sweeps every twin the build writes and asks whether the
// bytes on the wire ARE the twin, by re-encoding what arrived at the build's
// settings and comparing. It reads production, so it is advisory and never runs
// here; what runs here is the part a network cannot break: the classifier and
// the twin-to-URL map it rests on.
//
// The first sweep found /llms-full.txt, whose handler read the built file with
// .text() and returned a fresh unencoded body, so the edge compressed 516 KB on
// the fly at about q4: 188,401 B against 156,709 B at q11. #956 fixed the
// handler and carries its own test (contract-llms-full-ships-its-q11-twin). The
// route oracle's `encoding: br` row could not see it, because the local harness
// re-encodes an unencoded text body to br by itself; run against the old
// handler in that harness, q11:check flagged exactly this URL and no other.
import { assert, test } from "./contract-shared.ts";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { classify, kindOfTwin, q11, urlForTwin } from "./check-q11.ts";

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
