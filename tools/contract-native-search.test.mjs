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
