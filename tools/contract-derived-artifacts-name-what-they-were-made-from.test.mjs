// ── every committed derived artifact names its inputs, and the digest has teeth ─
// The declaration is config/derivations.json; the kernel is tools/lib/derive.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestOf, hashInputs, record, resolveInputs, verify } from "./lib/derive.ts";

const root = fileURLToPath(ROOT);
const decl = JSON.parse(await readFile(new URL("config/derivations.json", ROOT), "utf8"));
const lock = JSON.parse(await readFile(new URL("config/derivations.lock.json", ROOT), "utf8")).files;
const graph = decl.derivations;

// ── the declaration is well formed ───────────────────────────────────────────

test("derivations: a pinned entry declares inputs and carries a recorded digest", () => {
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    assert.ok(d.inputs?.paths?.length, `${d.id}: pinned with no inputs`);
    assert.ok(d.recorded?.inputs, `${d.id}: pinned but never recorded`);
    assert.ok(d.regenerate, `${d.id}: no regenerate command, so a stale result names no way out`);
  }
});

// An unverifiable entry is the one place this graph can quietly cover less than
// it claims, so the REASON is mandatory. tools.json makes the same demand of the
// two tools that report no version: say what is skipped, never skip silently.
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

// A graph that has been emptied reports a clean pass, which is the failure every
// scanner floor in this repo exists to refuse.
test("derivations: the pinned set has not collapsed", () => {
  const pinned = graph.filter((d) => d.tier === "pinned");
  assert.ok(pinned.length >= 4, `only ${pinned.length} pinned derivations; the graph has been emptied`);
});

test("derivations: the lock covers every pinned input, so a stale result can name what moved", async () => {
  for (const d of graph.filter((x) => x.tier === "pinned")) {
    const files = await resolveInputs(root, d.inputs);
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

// ── the kernel's teeth, tested on a scratch tree rather than on the repo ──────
// Everything above asserts the DECLARATION is tidy, and a tidy declaration over a
// digest that never moves is decoration. These four run the property directly.

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

// The case that matters most here, and the reason the digest is built from
// `path hash` lines rather than from concatenated bytes. A re-encode mints a NEW
// /i/ filename for the same picture, so a digest blind to names would call the
// library unchanged at the exact moment every URL in it moved.
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
