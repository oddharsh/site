// The photo shells handed their JSON to jaq until 2026-09-15 and hand it to
// tools/photos/pipeline-json.ts now. Two of its outputs are COMMITTED files
// carrying jaq's pretty-printer bytes (src/worker/photo-index.json,
// public/images/metadata.json), so "the same shape" is a byte claim: a merge
// that added one photo must diff one photo. The subcommands were diffed
// against jaq on the real library before the swap (config/retired.json records
// the runs); this holds the halves that need no jaq to re-check.
import { readFile as fsReadFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { jqUri, mergeIndex, parseSpool, pretty, sortKeysDeep } from "./photos/pipeline-json.ts";

const CLI = fileURLToPath(new URL("photos/pipeline-json.ts", import.meta.url));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { cwd: fileURLToPath(ROOT), encoding: "utf8" });

test("index-merge with no entries reproduces the committed photo index byte for byte", async () => {
  const raw = await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8");
  const index = JSON.parse(raw);
  assert.ok(Object.keys(index).length >= 100, "the fixture is the real file");
  assert.equal(pretty(mergeIndex(index, {}, "2026-01-01T00:00:00.000Z")), raw);
  // Control: the sort is doing work. Reverse the key order and the bytes differ
  // until sortKeysDeep puts them back.
  const reversed = Object.fromEntries(Object.entries(index).reverse());
  assert.notEqual(pretty(reversed), raw);
  assert.equal(pretty(sortKeysDeep(reversed)), raw);
});

test("index-merge keeps an existing stem's upload date, mints one for a new stem, and writes album and heif only when set", () => {
  const index = { B: { full: "B.jpg", size: 1, uploaded: "2026-07-27T00:00:00.000Z" } };
  const spool = Buffer.from(["B", "B.jpg", "424242", "", "", "A", "A.jpg", "2", "cota-wec", "A.HIF"].join("\0") + "\0");
  const merged = mergeIndex(index, parseSpool(spool), "NOW");
  assert.deepEqual(Object.keys(merged), ["A", "B"], "sorted, so the new stem sorts first");
  assert.deepEqual(merged.B, { full: "B.jpg", size: 424242, uploaded: "2026-07-27T00:00:00.000Z" });
  assert.deepEqual(merged.A, { album: "cota-wec", full: "A.jpg", heif: "A.HIF", size: 2, uploaded: "NOW" });
  assert.deepEqual(Object.keys(merged.A), ["album", "full", "heif", "size", "uploaded"], "nested keys sort too, as jaq -S sorts them");
  // Controls: a torn spool and a non-integer size are refused rather than
  // read as a photo with a blank size.
  assert.throws(() => parseSpool(Buffer.from("A\0A.jpg\0")), /not a multiple of 5/);
  assert.throws(() => parseSpool(Buffer.from("A\0A.jpg\0big\0\0\0")), /bad spool record/);
});

test("prune reproduces the committed metadata byte for byte when every stem is published", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pipeline-json-"));
  const out = path.join(dir, "pruned.json");
  const dropped = run("prune", "public/images/metadata.json", "--published", "public/images/hashes.json", "--out", out);
  assert.equal(dropped, "", "every committed stem is published");
  assert.equal(await fsReadFile(out, "utf8"), await readFile(new URL("public/images/metadata.json", ROOT), "utf8"));
  // Control: a published set missing one stem drops exactly that stem, names
  // it on stdout, and keeps the rest in their original order.
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const [gone] = Object.keys(hashes);
  delete hashes[gone];
  const partial = path.join(dir, "hashes.json");
  await writeFile(partial, JSON.stringify(hashes));
  assert.equal(run("prune", "public/images/metadata.json", "--published", partial, "--out", out), `${gone}\n`);
  const kept = Object.keys(JSON.parse(await fsReadFile(out, "utf8")));
  const all = Object.keys(JSON.parse(await readFile(new URL("public/images/metadata.json", ROOT), "utf8")));
  assert.deepEqual(kept, all.filter((k) => k !== gone));
});

test("meta-split writes jaq -c's shape through the one key map that ships", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pipeline-json-meta-"));
  run("meta-split", "public/images/metadata.json", "--out-dir", dir);
  const meta = JSON.parse(await readFile(new URL("public/images/metadata.json", ROOT), "utf8"));
  const [stem] = Object.keys(meta);
  const text = await fsReadFile(path.join(dir, `${stem}.json`), "utf8");
  assert.ok(text.endsWith("}\n") && !text.includes("\n  "), "compact, one trailing newline");
  const short = JSON.parse(text);
  assert.equal(short.cm, meta[stem].camera);
  assert.ok(!("hi" in short), "the histogram channel is zenc's to add, not the split's");
  assert.ok(Object.values(short).every((v) => v !== null), "nulls are dropped, never written");
});

test("uri is jq's @uri, not encodeURIComponent", () => {
  assert.equal(jqUri("a b/c'd(e)*f!~.HIF"), "a%20b%2Fc%27d%28e%29%2Af%21~.HIF");
  assert.equal(jqUri("ünï.jpg"), "%C3%BCn%C3%AF.jpg");
  assert.notEqual(jqUri("!'()*"), encodeURIComponent("!'()*"), "the five characters encodeURIComponent leaves alone are the difference");
});

test("no photo shell script calls jaq on a code line, and no tool declares it", async () => {
  for (const rel of ["tools/photos/add-photos.sh", "tools/photos/extract-photo-metadata.sh", "tools/photos/download-remote-photos.sh"]) {
    const code = (await readFile(new URL(rel, ROOT), "utf8")).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(code, /\bjaq\b/, `${rel} still calls jaq`);
    assert.match(code, /pipeline-json\.ts/, `${rel} should route its JSON through pipeline-json.ts`);
  }
  const tools = JSON.parse(await readFile(new URL("config/tools.json", ROOT), "utf8")).tools;
  assert.equal(tools.some((t) => t.bin === "jaq"), false);
});
