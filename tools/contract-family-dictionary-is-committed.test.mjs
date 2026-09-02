// ── the family dictionary is committed, and stable until it drifts ────────────
// Split-file convention: shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import {
  FAMILY_DICT_DIR,
  FAMILY_DICT_SIZE,
  FAMILY_DRIFT,
  chooseFamilyDictionary,
  familyFileName,
  hash8,
  readCommittedFamily,
  writeCommittedFamily,
} from "./lib/page-family.ts";

// The site-page dictionary is advertised by every HTML response and fetched once
// per URL. Until 2026-09-02 its URL was the hash of a corpus derived on every
// build from pages that carry every hashed shell reference, so most deploys
// re-minted it and every returning visitor re-downloaded 17 KB for a dictionary
// measured 0.1 point better than the one they held. The build now ships the
// committed copy in src/dict/f-dict while it is within FAMILY_DRIFT of the fresh
// derivation. These pin the three things that keep that true: the committed file
// is well-formed and singular, the rule chooses the way its header says, and the
// build, the roll and the nightly workflow all still know the directory exists.

test("src/dict/f-dict holds exactly one well-formed dictionary", async () => {
  const names = (await readdir(FAMILY_DICT_DIR)).filter((n) => !n.startsWith("."));
  assert.equal(names.length, 1, `expected one committed family dictionary, found ${names.length}: ${names.join(", ")}`);
  const committed = await readCommittedFamily();
  assert.ok(committed, "readCommittedFamily returned nothing for a populated directory");
  assert.equal(committed.bytes.length, FAMILY_DICT_SIZE);
  assert.equal(committed.name, familyFileName(committed.bytes), "the filename must name the hash of the decoded bytes");
  assert.notEqual(committed.bytes.readUInt32LE(0), 0xec30a437, "RFC 9842 needs RAW bytes, never a zstd --train artifact");
});

test("readCommittedFamily refuses two files and a lying filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f-dict-"));
  try {
    const raw = Buffer.alloc(FAMILY_DICT_SIZE, "<p>the family corpus</p>\n");
    const br = (b) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } });
    assert.equal(await readCommittedFamily(dir), null, "an empty directory means 'ship fresh', not an error");
    await writeFile(join(dir, "page-family.deadbeef.dict.br"), br(raw));
    await assert.rejects(() => readCommittedFamily(dir), /names deadbeef but the bytes hash to/);
    await writeFile(join(dir, familyFileName(raw)), br(raw));
    await assert.rejects(() => readCommittedFamily(dir), /expected at most one/);
    await rm(join(dir, "page-family.deadbeef.dict.br"));
    const ok = await readCommittedFamily(dir);
    assert.ok(ok, "a single well-formed file must read back");
    assert.equal(ok.hash8, hash8(raw));
    // writeCommittedFamily replaces rather than accumulates: one file, always.
    const other = Buffer.alloc(FAMILY_DICT_SIZE, "<p>a different corpus</p>\n");
    await writeCommittedFamily(other, dir);
    const after = await readdir(dir);
    assert.deepEqual(after, [familyFileName(other)]);
    assert.ok(brotliDecompressSync(await readFile(join(dir, after[0]))).equals(other), "the committed bytes round-trip exactly");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed dictionary ships until it drifts past the line, then the fresh one does", async () => {
  // Pages that repeat one vocabulary; a dictionary made of that vocabulary is
  // near-perfect, and one made of unrelated bytes is nearly useless.
  const vocab = Array.from({ length: 200 }, (_, i) => `<li class="row-${i}" data-k="${i * 7919}">entry ${i} of the fixture corpus</li>`).join("\n");
  const pages = Array.from({ length: 6 }, (_, p) => Buffer.from(`<html><body>${vocab}<p>page ${p}</p>${vocab}</body></html>`));
  const fresh = Buffer.from(vocab.slice(0, FAMILY_DICT_SIZE).padEnd(FAMILY_DICT_SIZE, "\n"));
  const unrelated = Buffer.alloc(FAMILY_DICT_SIZE);
  for (let i = 0; i < unrelated.length; i++) unrelated[i] = (i * 2654435761) >>> 24;

  const none = await chooseFamilyDictionary({ fresh, committed: null, pages });
  assert.equal(none.source, "fresh");
  assert.equal(none.committedTotal, null);
  assert.equal(none.frames.length, pages.length, "one frame per page, in order");

  const same = await chooseFamilyDictionary({ fresh, committed: Buffer.from(fresh), pages });
  assert.equal(same.source, "committed", "identical bytes are zero drift and must ship as committed");
  assert.equal(same.drift, 0);

  const far = await chooseFamilyDictionary({ fresh, committed: unrelated, pages });
  assert.equal(far.source, "fresh", "an unrelated committed dictionary is past any sane line");
  const farDrift = far.drift ?? -1;
  assert.ok(farDrift > FAMILY_DRIFT, `drift ${farDrift} should exceed ${FAMILY_DRIFT}`);
  assert.equal(far.freshTotal, none.freshTotal, "the fresh total does not depend on what was committed");

  // The threshold is the whole rule: raise it past the measured drift and the
  // same committed bytes ship again.
  const lenient = await chooseFamilyDictionary({ fresh, committed: unrelated, pages, threshold: farDrift + 1 });
  assert.equal(lenient.source, "committed");
});

test("the build, the roll and the nightly workflow all know the directory", () => {
  const build = readFileSync("tools/build.ts", "utf8");
  assert.match(build, /readCommittedFamily\(\)/, "build.ts no longer reads the committed family dictionary");
  assert.match(build, /chooseFamilyDictionary\(/, "build.ts no longer applies the drift rule");
  assert.match(build, /page-family\.\$\{hash8\(dictionary\)\}\.dict/, "the shipped URL must still be the hash of the CHOSEN bytes");
  assert.match(build, /FAMILY_REPORT/, "build.ts must record its decision for the roll");
  // The build must never write into the source tree; only the roll commits.
  assert.doesNotMatch(build, /writeCommittedFamily/);

  const roll = readFileSync("tools/roll-shell-dictionary.ts", "utf8");
  assert.match(roll, /writeCommittedFamily\(/, "the roll is the one writer of src/dict/f-dict");
  assert.match(roll, /--family/);

  const workflow = readFileSync(".github/workflows/dictionary-roll.yml", "utf8");
  const mentions = workflow.match(/src\/dict\/f-dict/g) || [];
  assert.ok(mentions.length >= 4, `dictionary-roll.yml names src/dict/f-dict ${mentions.length} time(s); the status check, both counts and the git add all have to`);

  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(scripts["family:roll"], "bun tools/roll-shell-dictionary.ts --family");
});
