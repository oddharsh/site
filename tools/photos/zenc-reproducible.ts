#!/usr/bin/env bun
// zenc-reproducible.ts — does the COMPILER move the histograms?
//
//   bun run zenc:reproducible                 the three toolchains below
//   bun run zenc:reproducible 1.93.0 1.98.0   any rustup toolchain names
//
// WHY THIS IS COMMITTED. The question has produced one confident wrong answer
// already. A parked branch investigated "adding one photo rewrote all 158
// histograms", ruled out Cargo.lock, the input hashes and nondeterminism, and
// concluded the remaining variable was the BUILD: it measured 31.2% of 40,448
// bins moving and proposed pinning rustc. That reasoning never ran an A/B
// between two compilers. It compared a fresh bake against the COMMITTED set,
// which came from an unrecorded build, so drift-from-committed was the only
// thing observed and rustc was the last suspect standing rather than a measured
// cause. CLAUDE.md gotcha 41 later found the real one: #394 re-encoded 316
// thumbnails, so the committed histograms described bytes nobody was served.
//
// Measured here 2026-08-28, rustc 1.93.0 / 1.96.0 / 1.98.0 over all 165 stems:
// BYTE-IDENTICAL, 0 files differing on either pair. So no pin was added, and
// config/tools.json's `cargo` entry keeps `bytes: false`.
//
// THE CONTROL IS THE POINT, and skipping it is how the first answer went wrong.
// A diff that finds nothing is worthless until it has found something, so this
// re-encodes one tile at a lower quality and asserts that EXACTLY that stem's
// meta file moves. A run that cannot see a perturbed input is reporting on
// itself, which is the lesson `onestep:probe` and gotcha 15 already carry.
//
// It needs rustup with the named toolchains installed, so it is a workstation
// control like `kitesurf:check` rather than a CI step. Nothing here writes into
// the repository: every bake goes to a scratch root holding a symlink to public/i.
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CRATE = join(ROOT, "tools/photos/zenc");
const PUBLIC = join(ROOT, "public");
const TOOLCHAINS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const CHAINS = TOOLCHAINS.length ? TOOLCHAINS : ["1.93.0", "1.96.0", "1.98.0"];

const die = (msg: string): never => { console.error(`zenc:reproducible: ${msg}`); process.exit(1); };
const run = (cmd: string[], cwd = ROOT) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });

if (run(["rustup", "--version"]).exitCode !== 0) die("needs rustup on PATH");

const scratch = mkdtempSync(join(tmpdir(), "zenc-repro-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

// One root per bake: images/hashes.json copied, i/ symlinked, meta/ empty.
const rootFor = (name: string, tiles?: string) => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "images", "meta"), { recursive: true });
  copyFileSync(join(PUBLIC, "images/hashes.json"), join(dir, "images/hashes.json"));
  symlinkSync(tiles ?? join(PUBLIC, "i"), join(dir, "i"));
  return dir;
};

const bake = (binary: string, root: string) => {
  const r = run([binary, "histogram", "--root", root]);
  if (r.exitCode !== 0) die(`bake failed under ${binary}: ${r.stderr.toString().trim()}`);
};

// Compare two meta directories by content, so a bake that writes nothing cannot
// pass as agreement: both sides must hold the same non-empty set of stems.
const compare = (a: string, b: string) => {
  const read = (d: string) => new Map(readdirSync(d).map((f) => [f, readFileSync(join(d, f), "utf8")]));
  const [A, B] = [read(a), read(b)];
  if (!A.size) die(`no meta files written into ${a}`);
  if (A.size !== B.size) die(`stem counts differ: ${A.size} vs ${B.size}`);
  return [...A].filter(([f, body]) => B.get(f) !== body).map(([f]) => f);
};

const binaries = new Map<string, string>();
for (const chain of CHAINS) {
  const build = run(["cargo", `+${chain}`, "build", "--release", "--locked"], CRATE);
  if (build.exitCode !== 0) die(`cargo +${chain} build failed — is that toolchain installed? (rustup toolchain install ${chain})\n${build.stderr.toString().trim()}`);
  const binary = join(scratch, `zenc-${chain}`);
  copyFileSync(join(CRATE, "target/release/zenc"), binary);
  binaries.set(chain, binary);
  console.log(`built under rustc ${chain}`);
}

// Two identical binaries would make every comparison below pass for free.
const digests = new Map<string, string>();
for (const [chain, binary] of binaries) {
  digests.set(chain, new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex"));
}
if (new Set(digests.values()).size !== binaries.size) {
  console.warn("warn: two toolchains produced the SAME binary, so their comparison proves nothing");
}

const baked = new Map<string, string>();
for (const [chain, binary] of binaries) {
  const root = rootFor(chain);
  bake(binary, root);
  baked.set(chain, join(root, "images/meta"));
}

// ── the control: one perturbed input must move exactly one stem ──────────────
const hashes = JSON.parse(readFileSync(join(PUBLIC, "images/hashes.json"), "utf8")) as Record<string, { j: string }>;
const victim = Object.keys(hashes).sort()[0];
const tiles = join(scratch, "tiles");
mkdirSync(tiles);
for (const f of readdirSync(join(PUBLIC, "i"))) copyFileSync(join(PUBLIC, "i", f), join(tiles, f));
const tile = join(tiles, `${victim}.${hashes[victim].j}.jpg`);
const before = new Bun.CryptoHasher("sha256").update(await Bun.file(tile).arrayBuffer()).digest("hex");
// sips refuses to write a file in place, so re-encode aside and copy back.
const aside = join(scratch, "perturbed.jpg");
if (run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "40", tile, "--out", aside]).exitCode !== 0) die("sips could not re-encode the control tile");
copyFileSync(aside, tile);
const after = new Bun.CryptoHasher("sha256").update(await Bun.file(tile).arrayBuffer()).digest("hex");
if (before === after) die("the control tile did not change, so the comparison below is untested");

const first = CHAINS[0];
const controlRoot = rootFor("control", tiles);
bake(binaries.get(first)!, controlRoot);
const moved = compare(baked.get(first)!, join(controlRoot, "images/meta"));
if (moved.length !== 1 || moved[0] !== `${victim}.json`) {
  die(`control failed: perturbing ${victim} moved ${moved.length} stem(s) [${moved.slice(0, 5).join(", ")}], expected exactly ${victim}.json`);
}
console.log(`control ok: re-encoding ${victim} moves exactly its own histogram, and nothing else`);

// ── the verdict ─────────────────────────────────────────────────────────────
let differ = 0;
for (let i = 1; i < CHAINS.length; i++) {
  const [a, b] = [CHAINS[0], CHAINS[i]];
  const d = compare(baked.get(a)!, baked.get(b)!);
  differ += d.length;
  console.log(`rustc ${a} vs ${b}: ${d.length} of ${readdirSync(baked.get(a)!).length} histograms differ${d.length ? ` (${d.slice(0, 5).join(", ")})` : ""}`);
}
console.log(differ
  ? `\nVERDICT: the compiler MOVES histograms. Pin rustc in tools/photos/zenc/rust-toolchain.toml,\nflip config/tools.json's cargo entry to bytes: true, and record the version there.`
  : `\nVERDICT: the compiler does not move histograms. No rustc pin is warranted; config/tools.json's\ncargo entry stays bytes: false. Suspect the INPUT bytes instead (CLAUDE.md gotcha 41).`);
process.exit(differ ? 1 : 0);
