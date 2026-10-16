// ── q11 twins are served at q11 ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { assert, test } from "./contract-shared.ts";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { atQ11, classify, kindOfTwin, q11, q11Slack, urlForTwin } from "./check-q11.ts";

const PLAIN = Buffer.from(Array.from({ length: 400 }, (_, i) => `line ${i}: the corpus, ${i % 7} ${"ab".repeat(i % 13)}\n`).join(""));

test("the classifier judges on size, and still names a stream that is not byte-identical", () => {
  assert.equal(classify("br", q11(PLAIN)).verdict, "q11");
  const q4 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } });
  const v = classify("br", q4);
  assert.equal(v.verdict, "over");
  assert.equal(v.verdict === "over" && v.q11, q11(PLAIN).length, "must report the size the twin would have been");
  assert.ok(!atQ11(v));
  const w22 = brotliCompressSync(PLAIN, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 22 } });
  assert.ok(!w22.equals(q11(PLAIN)), "the fixture must be a different stream, or this proves nothing");
  const drift = classify("br", w22);
  assert.equal(drift.verdict, "q11-size");
  assert.ok(atQ11(drift));
  assert.equal(classify("gzip", gzipSync(PLAIN)).verdict, "over");
  assert.equal(classify(null, PLAIN).verdict, "over", "an unencoded body is not at q11 size");
  assert.equal(classify("br", PLAIN).verdict, "undecodable");
  assert.equal(classify("dcz", q11(PLAIN)).verdict, "undecodable");
});

test("the slack is 1% with an 8 B floor, between measured drift and the edge's q4", () => {
  assert.equal(q11Slack(87), 8);
  assert.equal(q11Slack(800), 8);
  assert.equal(q11Slack(5841), 59);
  assert.ok(q11Slack(5841) >= 6, "the /writing drift must fit inside the slack");
  assert.ok(q11Slack(156709) < 188404 - 156709, "the edge's /llms-full.txt must not fit inside it");
});

test("q11() is build.ts's compressQ11, so a served twin reads as q11", async () => {
  const { readFile } = await import("node:fs/promises");
  const build = await readFile(new URL("build.ts", import.meta.url), "utf8");
  assert.match(build, /createHash\("sha256"\)\.update\(compressQ11\.toString\(\)\)/, "the cache key names the encoder's settings");
  const fn = build.match(/function compressQ11\([\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(fn, /BROTLI_PARAM_QUALITY\]: 11/);
  assert.match(fn, /BROTLI_PARAM_LGWIN\]: 24/);
  assert.match(fn, /BROTLI_PARAM_SIZE_HINT\]: bytes\.length/);
  // And the other copy. Only build.ts was read until 2026-10-14, so q11() could
  // drift from these settings and this test still passed.
  const own = (await readFile(new URL("check-q11.ts", import.meta.url), "utf8")).match(/export function q11\([\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(own.length > 0, "check-q11.ts lost q11(); point this test at it");
  assert.match(own, /BROTLI_PARAM_QUALITY\]: 11/);
  assert.match(own, /BROTLI_PARAM_LGWIN\]: 24/);
  assert.match(own, /BROTLI_PARAM_SIZE_HINT\]: bytes\.length/);
  // The bytes, too: q11() on real text equals brotli at the build's settings.
  const plain = Buffer.from(build);
  const expected = brotliCompressSync(plain, { params: {
    [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 24, [zc.BROTLI_PARAM_SIZE_HINT]: plain.length,
  } });
  assert.ok(q11(plain).equals(expected), "q11() must produce the build's q11 bytes");
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
