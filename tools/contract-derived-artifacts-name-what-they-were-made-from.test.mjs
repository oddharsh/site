// ── every committed derived artifact names its inputs, and the digest has teeth ─
// The declaration is config/derivations.json; the kernel is tools/lib/derive.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestOf, hashInputs, project, record, relock, resolveInputs, verify } from "./lib/derive.ts";
import { SHELL_FLOOR, WRITER_FLOOR, declaredBy, findShellTouchers, findWriters } from "./lib/derive-writers.ts";

/** @typedef {import("./lib/derive.ts").Derivation} Derivation */

const root = fileURLToPath(ROOT);
const decl = JSON.parse(await readFile(new URL("config/derivations.json", ROOT), "utf8"));
const lock = JSON.parse(await readFile(new URL("config/derivations.lock.json", ROOT), "utf8")).files;
const graph = decl.derivations;

test("derivations: a pinned entry declares inputs and carries a recorded digest", () => {
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    assert.ok(d.inputs?.paths?.length, `${d.id}: pinned with no inputs`);
    assert.ok(d.recorded?.inputs, `${d.id}: pinned but never recorded`);
    assert.ok(d.regenerate, `${d.id}: no regenerate command, so a stale result names no way out`);
  }
});

test("derivations: an unverifiable entry says which inputs are missing and why", () => {
  for (const d of graph.filter((x) => x.tier === "unverifiable")) {
    assert.ok(d.unverifiable && d.unverifiable.length > 80, `${d.id}: no reason for being unverifiable`);
    assert.ok(!d.inputs, `${d.id}: declares inputs, so it is pinned rather than unverifiable`);
  }
});

test("derivations: every declared output exists", async () => {
  for (const d of graph) {
    for (const out of d.outputs) {
      const info = await import("node:fs/promises").then((fs) => fs.stat(path.join(root, out)).catch(() => null));
      assert.ok(info, `${d.id}: declared output ${out} does not exist`);
    }
  }
});

test("derivations: the pinned set has not collapsed", () => {
  const pinned = graph.filter((d) => d.tier === "pinned");
  assert.ok(pinned.length >= 4, `only ${pinned.length} pinned derivations; the graph has been emptied`);
});

test("derivations: the lock covers every pinned input, so a stale result can name what moved", async () => {
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    const files = [...(await resolveInputs(root, d.inputs)), ...(d.inputs.bytes ?? [])];
    const missing = files.filter((f) => !(f in lock));
    assert.equal(missing.length, 0, `${d.id}: ${missing.length} inputs absent from the lock, e.g. ${missing[0]}`);
  }
});

test("derivations: the recorded digest matches the bytes on disk", async () => {
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    const made = await record(root, d);
    assert.ok(made, `${d.id}: record() returned nothing for a pinned derivation`);
    assert.equal(made.recorded.inputs, d.recorded.inputs, `${d.id} is stale: run bun run derive:check`);
  }
});

test("derivations: package.json exposes the check", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.ok(pkg.scripts["derive:check"], "no derive:check script");
});

const scratch = async (files) => {
  const dir = await mkdtemp(path.join(tmpdir(), "derive-"));
  await mkdir(path.join(dir, "in"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, "in", name), body);
  return dir;
};
const digestFor = async (dir, spec) => digestOf(await hashInputs(dir, await resolveInputs(dir, spec)));
const SPEC = { paths: ["in"] };

test("derive: a changed byte moves the digest", async () => {
  const dir = await scratch({ "a.txt": "one", "b.txt": "two" });
  const before = await digestFor(dir, SPEC);
  await writeFile(path.join(dir, "in/a.txt"), "onE");
  assert.notEqual(await digestFor(dir, SPEC), before, "a content change did not move the digest");
  await rm(dir, { recursive: true, force: true });
});

test("derive: a rename moves the digest even when every byte is identical", async () => {
  const dir = await scratch({ "a.1234.jpg": "pixels", "b.txt": "two" });
  const before = await digestFor(dir, SPEC);
  const fs = await import("node:fs/promises");
  await fs.rename(path.join(dir, "in/a.1234.jpg"), path.join(dir, "in/a.5678.jpg"));
  assert.notEqual(await digestFor(dir, SPEC), before, "a rename with identical bytes did not move the digest");
  await rm(dir, { recursive: true, force: true });
});

test("derive: verify names the file that moved", async () => {
  const dir = await scratch({ "a.txt": "one", "b.txt": "two" });
  const made = await record(dir, { id: "t", tier: "pinned", why: "", outputs: [], inputs: SPEC });
  assert.ok(made, "record() returned nothing for a pinned derivation");
  await writeFile(path.join(dir, "in/b.txt"), "changed");
  const v = await verify(dir, { id: "t", tier: "pinned", why: "", outputs: [], inputs: SPEC, recorded: made.recorded }, made.hashes);
  assert.equal(v.state, "stale");
  assert.deepEqual(v.changed, ["in/b.txt"]);
  await rm(dir, { recursive: true, force: true });
});

// Gotcha 40's shape: a path rewrite left eight scripts writing into directories
// that do not exist, and every one of them carried on. An input tree that has
// been renamed away must be an error rather than an empty set that hashes to a
// stable digest and reports fresh forever.
test("derive: a declared input that has vanished is an error, never an empty set", async () => {
  const dir = await scratch({ "a.txt": "one" });
  await assert.rejects(
    () => resolveInputs(dir, { paths: ["in", "gone"] }),
    /declared input does not exist: gone/,
    "a missing input tree did not throw",
  );
  await rm(dir, { recursive: true, force: true });
});

test("derive: set mode ignores a re-encode and notices a new photo", async () => {
  const spec = { paths: ["in"], include: [".jpg"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$" };
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: [], inputs: spec };
  const dir = await scratch({ "a.11111111.jpg": "px", "b.22222222.jpg": "px" });
  const before = digestOf((await project(dir, d)).entries);

  const fs = await import("node:fs/promises");
  await fs.rename(path.join(dir, "in/a.11111111.jpg"), path.join(dir, "in/a.33333333.jpg"));
  await fs.writeFile(path.join(dir, "in/a.33333333.jpg"), "different pixels");
  assert.equal(digestOf((await project(dir, d)).entries), before, "a re-encode moved a set-mode digest");

  await fs.writeFile(path.join(dir, "in/c.44444444.jpg"), "px");
  assert.notEqual(digestOf((await project(dir, d)).entries), before, "a new stem did not move the digest");
  await rm(dir, { recursive: true, force: true });
});

test("derive: set mode refuses an input it cannot project", async () => {
  const spec = { paths: ["in"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$" };
  const dir = await scratch({ "a.11111111.jpg": "px", "README": "not a thumbnail" });
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: [], inputs: spec };
  await assert.rejects(
    () => project(dir, d),
    /does not match the set pattern/,
    "an unparseable input was silently skipped",
  );
  await rm(dir, { recursive: true, force: true });
});

test("derive: coverage is computed live, so --lock cannot clear a gap", async () => {
  const spec = { paths: ["in"], include: [".jpg"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$" };
  const dir = await scratch({ "a.11111111.jpg": "px", "b.22222222.jpg": "px" });
  const fs = await import("node:fs/promises");
  await fs.writeFile(path.join(dir, "out.json"), JSON.stringify({ a: "covered" }));
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: ["out.json"], inputs: spec, covers: "out.json" };

  const made = await record(dir, d);
  assert.ok(made, "record() returned nothing");
  const v = await verify(dir, { ...d, recorded: made.recorded }, made.hashes);
  assert.equal(v.state, "stale", "a covering artifact missing an entry was reported fresh");
  assert.deepEqual(v.uncovered, ["b"]);
  await rm(dir, { recursive: true, force: true });
});

test("derive: coverage reports an entry left behind by a deleted input", async () => {
  const spec = { paths: ["in"], include: [".jpg"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$" };
  const dir = await scratch({ "a.11111111.jpg": "px" });
  const fs = await import("node:fs/promises");
  await fs.writeFile(path.join(dir, "out.json"), JSON.stringify({ a: "covered", gone: "orphan" }));
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: ["out.json"], inputs: spec, covers: "out.json" };
  const made = await record(dir, d);
  assert.ok(made, "record() returned nothing");
  const v = await verify(dir, { ...d, recorded: made.recorded }, made.hashes);
  assert.equal(v.state, "fresh", "an orphaned entry was treated as a failure");
  const forced = await verify(dir, { ...d, recorded: { ...made.recorded, inputs: "forced-mismatch" } }, made.hashes);
  if (forced.state !== "stale") throw new Error("forced digest mismatch did not read as stale");
  assert.deepEqual(forced.orphaned, ["gone"]);
  await rm(dir, { recursive: true, force: true });
});

const SET_WITH_BYTES = { paths: ["in"], include: [".jpg"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$", bytes: ["cap.json"] };
const withCaptions = async () => {
  const dir = await scratch({ "a.11111111.jpg": "px", "b.22222222.jpg": "px" });
  await writeFile(path.join(dir, "cap.json"), JSON.stringify({ a: "a dog", b: "a car" }));
  await writeFile(path.join(dir, "out.json"), JSON.stringify({ a: "t", b: "t" }));
  return dir;
};

test("derive: a changed `bytes` file makes a set-mode artifact stale, and names the file", async () => {
  const dir = await withCaptions();
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: ["out.json"], inputs: SET_WITH_BYTES, covers: "out.json" };
  const made = await record(dir, d);
  assert.ok(made, "record() returned nothing");
  assert.equal((await verify(dir, { ...d, recorded: made.recorded }, made.hashes)).state, "fresh", "control: nothing moved yet");

  await writeFile(path.join(dir, "cap.json"), JSON.stringify({ a: "a zebra", b: "a car" }));
  const v = await verify(dir, { ...d, recorded: made.recorded }, made.hashes);
  if (v.state !== "stale") throw new Error(`a re-captioned input read ${v.state}`);
  assert.deepEqual(v.changed, ["cap.json"]);
  assert.deepEqual(v.uncovered, [], "a `bytes` file was counted as a key the artifact must cover");
  await rm(dir, { recursive: true, force: true });
});

test("derive: `bytes` leaves a set-mode digest blind to a re-encode", async () => {
  const dir = await withCaptions();
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: [], inputs: SET_WITH_BYTES };
  const before = digestOf((await project(dir, d)).entries);
  const fs = await import("node:fs/promises");
  await fs.rename(path.join(dir, "in/a.11111111.jpg"), path.join(dir, "in/a.33333333.jpg"));
  assert.equal(digestOf((await project(dir, d)).entries), before, "a re-encode moved a set digest that carries `bytes`");
  await rm(dir, { recursive: true, force: true });
});

test("derive: `bytes` rows are bare paths in the lock, owned by the derivation that declares them", async () => {
  const dir = await withCaptions();
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: [], inputs: SET_WITH_BYTES };
  const made = await record(dir, d);
  assert.ok(made, "record() returned nothing");
  assert.ok("cap.json" in made.hashes, "the `bytes` file has no lock row");
  assert.ok("t#a" in made.hashes && !("a" in made.hashes), "set keys lost their namespace");
  assert.ok(made.owns("cap.json") && made.owns("t#b") && !made.owns("other#b"), "ownership is misattributed");
  await rm(dir, { recursive: true, force: true });
});

test("derive: `bytes` outside set mode is refused, and a vanished `bytes` file is an error", async () => {
  const dir = await withCaptions();
  await assert.rejects(
    () => project(dir, { id: "t", tier: "pinned", why: "", outputs: [], inputs: { paths: ["in"], bytes: ["cap.json"] } }),
    /set mode only/,
  );
  await assert.rejects(
    () => project(dir, { id: "t", tier: "pinned", why: "", outputs: [], inputs: { ...SET_WITH_BYTES, bytes: ["gone.json"] } }),
    /declared input does not exist: gone.json/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("derivations: images/semantics declares the caption and recipe files its generator folds in", async () => {
  const d = graph.find((x) => x.id === "images/semantics");
  assert.ok(d, "images/semantics left the graph");
  const src = await readFile(new URL("tools/photos/gen-photo-semantics.ts", ROOT), "utf8");
  for (const file of ["alt.json", "metadata.json"]) {
    assert.match(src, new RegExp(`"${file.replace(".", "\\.")}"`), `control: the generator no longer names ${file}; re-trace it`);
    assert.ok(d.inputs.bytes?.includes(`public/images/${file}`), `images/semantics does not declare public/images/${file}`);
  }
});

test("derive: a rewrite drops the row for an input that is gone", async () => {
  const dir = await scratch({ "a.txt": "one", "b.txt": "two" });
  /** @type {Derivation} */
  const d = { id: "t", tier: "pinned", why: "", outputs: [], inputs: SPEC };

  const first = await record(dir, d);
  assert.ok(first, "record() returned nothing");
  const lock1 = relock({}, first.hashes, first.owns).next;
  assert.deepEqual(Object.keys(lock1).sort(), ["in/a.txt", "in/b.txt"]);

  const fs = await import("node:fs/promises");
  await fs.rm(path.join(dir, "in/b.txt"));
  const second = await record(dir, d);
  assert.ok(second, "record() returned nothing on the re-record");
  const lock2 = relock(lock1, second.hashes, second.owns);
  assert.deepEqual(Object.keys(lock2.next).sort(), ["in/a.txt"], "the row for a deleted input survived the rewrite");
  assert.deepEqual(lock2.pruned, ["in/b.txt"], "the reported prune disagrees with what was dropped");
  await rm(dir, { recursive: true, force: true });
});

test("derive: --only prunes its own dead rows and leaves every other derivation's alone", async () => {
  const dir = await scratch({ "a.11111111.jpg": "px", "b.22222222.jpg": "px" });
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.join(dir, "other"), { recursive: true });
  await fs.writeFile(path.join(dir, "other/keep.txt"), "not mine");

  /** @type {Derivation} */
  const stems = { id: "stems", tier: "pinned", why: "", outputs: [], inputs: { paths: ["in"], include: [".jpg"], set: "^in/(.+)\\.[0-9a-f]{8}\\.jpg$" } };
  /** @type {Derivation} */
  const sibling = { id: "sibling", tier: "pinned", why: "", outputs: [], inputs: { paths: ["other"] } };

  const madeStems = await record(dir, stems);
  const madeSibling = await record(dir, sibling);
  assert.ok(madeStems && madeSibling, "record() returned nothing");
  let lockAll = relock({}, madeStems.hashes, madeStems.owns).next;
  lockAll = relock(lockAll, madeSibling.hashes, madeSibling.owns).next;
  assert.deepEqual(Object.keys(lockAll).sort(), ["other/keep.txt", "stems#a", "stems#b"]);

  await fs.rm(path.join(dir, "in/b.22222222.jpg"));
  const again = await record(dir, stems);
  assert.ok(again, "record() returned nothing on the re-record");
  const after = relock(lockAll, again.hashes, again.owns);
  assert.deepEqual(Object.keys(after.next).sort(), ["other/keep.txt", "stems#a"], "--only pruned or kept the wrong rows");
  assert.deepEqual(after.pruned, ["stems#b"], "--only dropped something other than its own dead row");
  assert.equal(after.next["other/keep.txt"], lockAll["other/keep.txt"], "another derivation's row was rewritten");
  await rm(dir, { recursive: true, force: true });
});

test("derivations: every lock row is an input some derivation still collects", async () => {
  const live = new Set();
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    const { entries, lockName } = await project(root, d);
    for (const name of Object.keys(entries)) live.add(lockName(name));
  }
  const dead = Object.keys(lock).filter((key) => !live.has(key));
  assert.deepEqual(
    dead.slice(0, 8),
    [],
    `${dead.length} of ${Object.keys(lock).length} lock rows name inputs nothing collects; run bun run derive:check -- --lock`,
  );
});

test("derivations: a set-mode entry declares what it covers", () => {
  for (const d of graph.filter((x) => x.inputs?.set)) {
    assert.ok(d.covers, `${d.id}: set mode with no covers, so a half-written artifact reads fresh`);
    assert.ok(d.outputs.includes(d.covers), `${d.id}: covers ${d.covers}, which is not one of its outputs`);
  }
});

// ── the census: no generator exists that nothing declares ────────────────────
// The graph answers "is this artifact stale" and cannot answer the question
// underneath it, which is whether an artifact has a declaration at all. That is
// the gap gotcha 46 fell through.

const writers = await findWriters(root, decl.writers.roots);
const shell = await findShellTouchers(root, decl.writers.shellRoots ?? decl.writers.roots);
const everything = [...writers, ...shell];
const regenerates = graph.map((d) => d.regenerate ?? "");

test("census: the writer scan has not stopped matching", () => {
  assert.ok(writers.length >= WRITER_FLOOR, `only ${writers.length} writers found, under the floor of ${WRITER_FLOOR}`);
});

test("census: every file that writes is declared or exempt with a reason", () => {
  const undeclared = everything.filter((f) => !declaredBy(f, regenerates) && !(f in decl.writers.exempt));
  assert.deepEqual(undeclared, [], `undeclared generator(s): ${undeclared.join(", ")}`);
});

test("census: an exemption states why, at length", () => {
  for (const [file, reason] of Object.entries(decl.writers.exempt)) {
    assert.ok(reason.length > 40, `${file}: exemption reason is too thin to be one`);
  }
});

test("census: no exemption outlives the file it exempts", () => {
  const stale = Object.keys(decl.writers.exempt).filter((f) => !everything.includes(f));
  assert.deepEqual(stale, [], `exempt but no longer writing: ${stale.join(", ")}`);
});

test("census: a file is never both declared and exempt", () => {
  const both = everything.filter((f) => declaredBy(f, regenerates) && f in decl.writers.exempt);
  assert.deepEqual(both, [], `both declared and exempt: ${both.join(", ")}`);
});

test("census: every regenerate command names a file that exists", async () => {
  const fs = await import("node:fs/promises");
  for (const d of graph) {
    if (!d.regenerate) continue;
    const named = d.regenerate.match(/\b[\w./-]+\.(ts|mjs|js|sh|py)\b/g) ?? [];
    assert.ok(named.length, `${d.id}: regenerate names no script`);
    for (const f of named) {
      const info = await fs.stat(path.join(root, f)).catch(() => null);
      assert.ok(info, `${d.id}: regenerate names ${f}, which does not exist`);
    }
  }
});

test("census: the shell scan has not stopped matching", () => {
  assert.ok(shell.length >= SHELL_FLOOR, `only ${shell.length} shell scripts matched, under the floor of ${SHELL_FLOOR}`);
});

test("census: the shell tier still sees the scripts it was built for", () => {
  for (const f of [
    "tools/photos/add-car-photo.sh",
    "tools/photos/reencode-thumbnails.sh",
    "tools/photos/gen-encoding-grids.sh",
    "tools/photos/gen-encoding-samples.sh",
  ]) {
    assert.ok(shell.includes(f), `${f} is no longer seen by the shell scan`);
  }
});

// gotcha 46's residual gap was this script telling you to re-run hash-thumbnails
// and stopping there, which is exactly the run that leaves the histograms behind.
test("census: the standalone re-encode path points at derive:check", async () => {
  const src = await readFile(new URL("tools/photos/reencode-thumbnails.sh", ROOT), "utf8");
  assert.ok(src.includes("derive:check"), "reencode-thumbnails.sh no longer names derive:check");
});

test("census: no test hands the repo root to a write-shaped call", async () => {
  const fs = await import("node:fs/promises");
  const dir = path.join(root, "tools");
  const offenders = [];
  for (const name of (await fs.readdir(dir)).filter((f) => f.includes(".test."))) {
    const src = (await fs.readFile(path.join(dir, name), "utf8"))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    if (!/const root = fileURLToPath\(ROOT\)/.test(src)) continue;
    for (const m of src.matchAll(/\b(write\w*)\s*\(\s*root\s*[,)]/g)) offenders.push(`${name}: ${m[1]}(root, ...)`);
  }
  assert.deepEqual(offenders, [], `a test writes through the repo root: ${offenders.join(", ")}`);
});
