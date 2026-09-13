import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSearchIndex } from "./generate-search-index.ts";
import { unpackCorpus } from "./search/reader.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = fileURLToPath(new URL("./search/Cargo.toml", import.meta.url));
execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", manifest], { cwd: root, timeout: 120_000 });
function pack(corpus) {
  return execFileSync("cargo", ["run", "--quiet", "--release", "--locked", "--manifest-path", manifest], {
    cwd: root, input: JSON.stringify(corpus), timeout: 10_000, maxBuffer: 20 * 1024 * 1024,
  });
}
test("Rust packing preserves every field in the complete authored corpus", async () => {
  const corpus = await buildSearchIndex(root);
  assert.ok(corpus.records.length >= 50);
  const packed = pack(corpus);
  assert.deepEqual(unpackCorpus(packed), corpus);
  assert.deepEqual(pack(corpus), packed);
});
test("packed corpus preserves Unicode and whitespace and rejects corrupt frames", () => {
  const corpus = { version: 1, generatedAt: "fixed", records: [{ url: "/", title: "Σ ' Α", description: "", kind: "page", text: "雪\r\n\t é 😀  Tea\u0000" }] };
  const packed = pack(corpus);
  assert.deepEqual(unpackCorpus(packed), corpus);
  for (let end = 0; end < packed.length; end++) assert.throws(() => unpackCorpus(packed.subarray(0, end)));
  assert.throws(() => unpackCorpus(Uint8Array.from([...packed, 0])));
  const version = Uint8Array.from(packed);
  version[4] = 2;
  assert.throws(() => unpackCorpus(version));
  const badRef = Uint8Array.from(packed);
  badRef[badRef.length - 1] = 127;
  assert.throws(() => unpackCorpus(badRef));
});

test("packed strings preserve leading BOM code points as content", () => {
  const corpus = { version: 1, generatedAt: "\ufefffixed", records: [{
    url: "/", title: "\ufeffTitle", description: "\ufeffDescription", kind: "page", text: "\ufeffSnow 雪",
  }] };
  assert.deepEqual(unpackCorpus(pack(corpus)), corpus);
});

test("packed expansion is bounded in UTF-8 bytes and empty tokens are refused", () => {
  const integer = (value) => {
    const bytes = [];
    while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
    return Buffer.from([...bytes, value]);
  };
  const string = (value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([integer(bytes.length), bytes]);
  };
  const frame = (token, copies) => Buffer.concat([
    Buffer.from([83, 83, 73, 88, 1]), string("fixed"), integer(1), string(token),
    integer(1), string("/"), string("title"), string(""), Buffer.from([0]),
    integer(copies), Buffer.alloc(copies),
  ]);
  assert.throws(() => unpackCorpus(frame("", 1)), /empty packed token/);
  // Six million UTF-16 units, but eighteen million UTF-8 bytes. The former
  // ceiling incorrectly accepted this expansion despite claiming a byte limit.
  assert.throws(() => unpackCorpus(frame("雪".repeat(400_000), 15)), /expanded corpus exceeds/);
});
