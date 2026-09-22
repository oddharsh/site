// The photo shells handed their JSON to jaq until 2026-09-15 and hand it to
// tools/photos/pipeline-json.ts now. Two of its outputs are COMMITTED files
// carrying jaq's pretty-printer bytes (src/worker/photo-index.json,
// public/images/metadata.json), so "the same shape" is a byte claim: a merge
// that added one photo must diff one photo. The subcommands were diffed
// against jaq on the real library before the swap (config/retired.json records
// the runs); this holds the halves that need no jaq to re-check.
import { readFile as fsReadFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { addCheckpoint, hashTiers, jqUri, mergeIndex, parseSpool, pretty, pyCompactJson, pyPrettyJson, sortKeysDeep, tierStem } from "./photos/pipeline-json.ts";

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
  const codeOf = async (rel) => (await readFile(new URL(rel, ROOT), "utf8")).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const rel of ["tools/photos/add-photos.sh", "tools/photos/extract-photo-metadata.sh", "tools/photos/download-remote-photos.sh", "tools/photos/hash-thumbnails.sh", "tools/photos/bump-version.sh"]) {
    assert.match(await codeOf(rel), /pipeline-json\.ts/, `${rel} should route its JSON through pipeline-json.ts`);
  }
  // The ban itself reads every committed shell script rather than a list: a
  // hand-kept list is how the no-python ban missed two heredocs for a week.
  const shells = execFileSync("git", ["ls-files", "-z", "*.sh"], { cwd: fileURLToPath(ROOT), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(shells.length >= 13, `git ls-files found ${shells.length} shell scripts`);
  for (const rel of shells) assert.doesNotMatch(await codeOf(rel), /\bjaq\b/, `${rel} still calls jaq`);
  const tools = JSON.parse(await readFile(new URL("config/tools.json", ROOT), "utf8")).tools;
  assert.equal(tools.some((t) => t.bin === "jaq"), false);
});

// hash-tiers replaced the Python heredoc hash-thumbnails.sh ran, and checkpoint-
// add the one bump-version.sh ran, both on 2026-09-22. Each writes a COMMITTED
// file in Python's json.dumps bytes, so the serializers are held to the files
// themselves. The heredocs were also diffed against the ports over five
// scenarios on the real library (no-op, a mixed ingest, eleven re-encodes, a
// corrupt map, a missing map) before either was replaced; this keeps the
// halves that need no Python to re-check.

test("the Python-shaped serializers reproduce the committed hashes.json and checkpoints.json", async () => {
  const hashes = await readFile(new URL("public/images/hashes.json", ROOT), "utf8");
  assert.ok(Object.keys(JSON.parse(hashes)).length >= 100, "the fixture is the real file");
  assert.equal(pyCompactJson(JSON.parse(hashes)), hashes);
  const log = await readFile(new URL("src/worker/checkpoints.json", ROOT), "utf8");
  assert.ok(JSON.parse(log).length >= 100, "the fixture is the real file");
  assert.equal(pyPrettyJson(JSON.parse(log)), log);
  // Controls: ensure_ascii, which JSON.stringify does not do. DEL is escaped
  // too, and an astral character comes out as its surrogate pair, lowercase.
  assert.equal(pyCompactJson({ "b": 1, "caf\u00e9": "\u007f\u{1F680}" }), '{"b":1,"caf\\u00e9":"\\u007f\\ud83d\\ude80"}');
  assert.notEqual(pyCompactJson({ k: "\u00e9" }), JSON.stringify({ k: "\u00e9" }));
  assert.equal(pyPrettyJson([{ b: 1, a: "\u03a9" }]), '[\n  {\n    "a": "\\u03a9",\n    "b": 1\n  }\n]\n');
});

test("hash-tiers finds stems from any tier, merges rather than replaces, and prunes to the map", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pipeline-json-tiers-"));
  const src = path.join(dir, "images"), out = path.join(dir, "i"), map = path.join(src, "hashes.json");
  await mkdir(src); await mkdir(out);
  // OLD is already addressed, with a j tier that is about to be re-encoded and
  // a superseded /i/ file lying beside it.
  await writeFile(path.join(out, "OLD.aaaaaaaa.avif"), "old-a");
  await writeFile(path.join(out, "OLD.bbbbbbbb.jpg"), "old-j");
  await writeFile(path.join(out, "STALE.cccccccc.jpg"), "nothing names me");
  await writeFile(map, JSON.stringify({ OLD: { a: "aaaaaaaa", j: "bbbbbbbb" } }));
  await writeFile(path.join(src, "OLD.jpg"), "old-j re-encoded");
  await writeFile(path.join(src, "NEW-200.avif"), "new-x"); // an additive TIERS=xs run: no JPG at all
  await writeFile(path.join(src, "notes.txt"), "not a tier");

  const lines = hashTiers(src, out, map);
  const merged = JSON.parse(await fsReadFile(map, "utf8"));
  assert.deepEqual(Object.keys(merged), ["NEW", "OLD"], "a stem with only a -200 tier is still found");
  assert.equal(merged.OLD.a, "aaaaaaaa", "the tier this run did not touch survives the merge");
  assert.notEqual(merged.OLD.j, "bbbbbbbb");
  assert.deepEqual(Object.keys(merged.NEW), ["x"]);
  assert.deepEqual((await readdir(src)).sort(), ["hashes.json", "notes.txt"], "addressed sources are pruned, everything else stays");
  assert.deepEqual((await readdir(out)).sort(), [`NEW-200.${merged.NEW.x}.avif`, "OLD.aaaaaaaa.avif", `OLD.${merged.OLD.j}.jpg`]);
  assert.equal(lines[0], `hashed 2 stems, copied 2 new files -> ${out}`);
  assert.equal(lines[1], "pruned 2 un-hashed source tiers, 2 superseded /i/ files");
  assert.ok(lines.includes("WARNING: the JPEG tier changed for 1 photo(s): OLD"), "a moved j tier warns that the histograms are stale");
  // The suffix order: a sized AVIF is its own tier of the base stem.
  assert.equal(tierStem("X-400.avif"), "X");
  assert.equal(tierStem("X-400.jpg"), "X-400");
  assert.equal(tierStem("hashes.json"), null);
});

test("checkpoint-add mints the next vnum from the projection and refuses a reused slug", () => {
  const rows = [{ slug: "b", title: "B", version: "aadhar-v7-b", vnum: 7, ymd: "2026-01-02" }, { slug: "a", title: "A", version: "aadhar-v3-a", vnum: 3, ymd: "2026-01-01" }];
  const { rows: next, entry } = addCheckpoint(rows, "c", "C", "2026-09-22");
  assert.deepEqual(entry, { slug: "c", title: "C", version: "aadhar-v8-c", vnum: 8, ymd: "2026-09-22" });
  assert.deepEqual(next.map((r) => r.vnum), [3, 7, 8], "kept in vnum order");
  assert.equal(addCheckpoint([], "x", "X", "d").entry.vnum, 1);
  assert.throws(() => addCheckpoint(rows, "a", "again", "d"), /already in the log/);
});
