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
import { atQ11, classify, kindOfTwin, q11, q11Slack, urlForTwin } from "./check-q11.ts";

// Big enough that q4 and q11 produce different streams, which is the whole
// distinction under test. A tiny input can encode identically at both.
const PLAIN = Buffer.from(Array.from({ length: 400 }, (_, i) => `line ${i}: the corpus, ${i % 7} ${"ab".repeat(i % 13)}\n`).join(""));

test("the classifier judges on size, and still names a stream that is not byte-identical", () => {
  assert.equal(classify("br", q11(PLAIN)).verdict, "q11");
  // THE CONTROL: the shape an edge produces on the fly. If this passed, the
  // sweep could not fail, which is the check agreeing with itself.
  const q4 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } });
  const v = classify("br", q4);
  assert.equal(v.verdict, "over");
  assert.equal(v.verdict === "over" && v.q11, q11(PLAIN).length, "must report the size the twin would have been");
  assert.ok(!atQ11(v));
  // Same quality, different window: a different stream at q11 size. This is
  // the shape of the /writing false alarm (macOS arm64 re-encoded production's
  // 5,841 B twin to 5,847 B), so it must pass while being told apart from exact.
  const w22 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 22 } });
  assert.ok(!w22.equals(q11(PLAIN)), "the fixture must be a different stream, or this proves nothing");
  const drift = classify("br", w22);
  assert.equal(drift.verdict, "q11-size");
  assert.ok(atQ11(drift));
  assert.equal(classify("gzip", gzipSync(PLAIN)).verdict, "over");
  assert.equal(classify(null, PLAIN).verdict, "over", "an unencoded body is not at q11 size");
  // A header that lies about the body is its own finding, not a crash.
  assert.equal(classify("br", PLAIN).verdict, "undecodable");
  assert.equal(classify("dcz", q11(PLAIN)).verdict, "undecodable");
});

test("the slack is 1% with an 8 B floor, between measured drift and the edge's q4", () => {
  // Drift measured 2026-09-26: 6 B on 5,841 (0.1%). The edge's q4 on anything
  // real is 12-26% over. The floor keeps a 1 B drift on an 87 B file a pass.
  assert.equal(q11Slack(87), 8);
  assert.equal(q11Slack(800), 8);
  assert.equal(q11Slack(5841), 59);
  assert.ok(q11Slack(5841) >= 6, "the /writing drift must fit inside the slack");
  assert.ok(q11Slack(156709) < 188404 - 156709, "the edge's /llms-full.txt must not fit inside it");
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
