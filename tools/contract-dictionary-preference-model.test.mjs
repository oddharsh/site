import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { brotliCompressSync } from "node:zlib";
import { measureDictionaryPreference, preferenceModel } from "./measure-dictionary-preference.ts";

test("dictionary selection charges an unsupported exact snapshot at full Brotli", () => {
  const pages = [{ page: "a.html", brotli: 1000, family: 800, exact: [100, 200] }];
  const miss = preferenceModel(pages, 1500, 0);
  assert.equal(miss.exactFirstWorst, 1000);
  const hit = preferenceModel(pages, 1500, 1);
  assert.equal(hit.exactFirstBest, 100);
  assert.equal(hit.exactFirstWorst, 200);
  assert.equal(hit.exactHitThresholdWorst, 0.25);
  assert.equal(preferenceModel(pages, 1500, 0.25).exactFirstWorst, hit.family);
  assert.equal(hit.familyPaybackSubsequentPages, 8);
});

test("missing and losing tiers cannot manufacture savings", () => {
  const pages = [
    { page: "a.html", brotli: 1000, family: 800, exact: [] },
    { page: "b.html", brotli: 1000, family: 700, exact: [900] },
  ];
  const model = preferenceModel(pages, 100, 1);
  assert.equal(model.pagesWithExact, 1);
  assert.equal(model.exactFirstBest, 1900);
  assert.equal(model.exactHitThresholdBest, null);
  assert.equal(preferenceModel([{ page: "a", brotli: 100, family: 100, exact: [] }], 10, 1).familyPaybackSubsequentPages, null);
  assert.throws(() => preferenceModel([], 10, 0.5), /No pages/);
  assert.throws(() => preferenceModel(pages, 10, 1.1), /hitRate/);
});

test("the reader counts a missing family delta as Brotli and rejects a corrupt frame", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dictionary-preference-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "pd"));
  const tag = createHash("sha256").update("dictionary").digest("hex").slice(0, 16);
  await writeFile(join(dir, `a/page-family.${tag.slice(0, 8)}.dict`), "dictionary");
  await writeFile(join(dir, `a/page-family.${tag.slice(0, 8)}.dict.br`), brotliCompressSync(Buffer.from("dictionary")));
  const raw = Buffer.from("<p>A page with no winning delta.</p>");
  const br = brotliCompressSync(raw);
  await writeFile(join(dir, "index.html"), raw);
  await writeFile(join(dir, "index.html.br"), br);
  const read = await measureDictionaryPreference(dir, dir);
  assert.equal(read.model.family, br.length);
  assert.equal(read.model.exactBest, br.length);
  assert.equal(read.verifiedDeltas, 0);
  await writeFile(join(dir, `pd/index.${tag}.dcz`), Buffer.alloc(50));
  await assert.rejects(() => measureDictionaryPreference(dir, dir), /Invalid dictionary frame/);
});
