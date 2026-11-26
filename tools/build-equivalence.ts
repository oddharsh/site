#!/usr/bin/env bun
// Does a warm, incremental build stage exactly what a clean build stages?
//
//   bun run build:equivalence                      a random seed, 4 edits
//   bun run build:equivalence -- --seed 7 --edits 6
//   bun run build:equivalence -- --plan island,revert-island
//
// A warm build reuses every compressor, minifier and transform output whose
// key is unchanged (tools/lib/build-cache.ts). A key that forgets one input
// serves last build's bytes for this build's input, and nothing in the build
// can tell. This is the oracle for that: two copy-on-write clones of the tree
// take the same edits; one builds with the cache on and keeps it between
// edits, the other builds with BUILD_CACHE=0 every time. After every edit the
// two .build trees must hold the same paths with the same bytes. phases.json
// is the one file left out, since it records timings.
//
// The edits are drawn from EDITS by a seeded generator, so a failing sequence
// replays from the seed it prints. Each kind changes one input a cached step
// reads: page text, a client island, a stylesheet every page names (which
// re-mints its /a/ URL in all of them), a writing post, and putting an edited
// file back, which is where a stale entry would come back to life.
//
// Off macOS there is no clonefile; under CI=true the clones are rsync copies
// with node_modules linked back, the way tools/controls.ts makes its trees.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloneTree } from "./lib/clone-tree.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

type Edit = { file: string; apply: (text: string, n: number) => string };
// Each edit keeps the page or module valid: the build's invariants must still
// pass, or the run compares two failures.
const EDITS: Record<string, Edit> = {
  page: { file: "src/pages/dotfiles/index.html", apply: (s, n) => s.replace("it is short.</p>", `it is short. Probe ${n}.</p>`) },
  island: { file: "src/client/tooltip.ts", apply: (s, n) => `${s}\nglobalThis.__equivalenceProbe = ${n};\n` },
  luna: { file: "src/styles/luna.css", apply: (s, n) => `${s}\n.equivalence-probe{order:${n}}\n` },
  quiz: { file: "src/styles/quiz.css", apply: (s, n) => `${s}\n.equivalence-probe{order:${n}}\n` },
  post: { file: "src/content/writing/colophon.txt", apply: (s, n) => `${s.trimEnd()}\n\nProbe ${n}.\n` },
};
const KINDS = Object.keys(EDITS);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

// mulberry32: small, seedable, and the same sequence on every runtime
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Number(arg("seed") ?? Math.floor(Math.random() * 2 ** 31));
const random = rng(seed);
const plan = (() => {
  const given = arg("plan");
  if (given) return given.split(",");
  const count = Number(arg("edits") ?? 4);
  const steps: string[] = [];
  for (let i = 0; i < count; i++) {
    const edited = [...new Set(steps.filter((s) => !s.startsWith("revert-")))];
    // one step in four puts an edited file back, once there is one to put back
    if (edited.length && random() < 0.25) steps.push(`revert-${edited[Math.floor(random() * edited.length)]}`);
    else steps.push(KINDS[Math.floor(random() * KINDS.length)]);
  }
  return steps;
})();
for (const step of plan) {
  const kind = step.replace(/^revert-/, "");
  if (!EDITS[kind]) throw new Error(`build-equivalence: no edit named ${kind} (have ${KINDS.join(", ")})`);
}
console.log(`build-equivalence: seed ${seed}, plan ${plan.join(",")}`);

const scratch = mkdtempSync(join(tmpdir(), "aadhar-equivalence-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));

async function cloneOf(name: string): Promise<string> {
  const dir = join(scratch, name);
  if (await cloneTree(ROOT, dir)) return dir;
  if (process.env.CI !== "true") throw new Error("build-equivalence: no clonefile here; run on macOS, or under CI=true");
  execFileSync("rsync", ["-a", "--exclude=/node_modules", "--exclude=/.build", `${ROOT}/`, `${dir}/`]);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}
const warm = await cloneOf("warm");
const clean = await cloneOf("clean");

function build(root: string, env: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("bun", ["tools/build.ts"], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`build in ${root} exited ${code}\n${err.slice(-3000)}`))));
  });
}

function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(root, ".build");
  for (const rel of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!rel.isFile()) continue;
    const path = join(rel.parentPath, rel.name);
    const key = path.slice(base.length + 1);
    if (key === "phases.json") continue;
    out.set(key, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return out;
}

const originals = new Map<string, string>();
let failures = 0;
for (let step = 0; step <= plan.length; step++) {
  const label = step === 0 ? "no edit" : plan[step - 1];
  if (step > 0) {
    const kind = label.replace(/^revert-/, "");
    const { file, apply } = EDITS[kind];
    const n = Math.floor(random() * 1e6);
    for (const root of [warm, clean]) {
      const path = join(root, file);
      if (!originals.has(file)) originals.set(file, readFileSync(path, "utf8"));
      writeFileSync(path, label.startsWith("revert-") ? originals.get(file)! : apply(readFileSync(path, "utf8"), n));
    }
  }
  // CI and WORKERS_CI turn the cache off (buildCacheEnabled), so the warm side
  // clears them; the clean side forces it off the documented way.
  await Promise.all([build(warm, { BUILD_CACHE: "1", CI: "", WORKERS_CI: "" }), build(clean, { BUILD_CACHE: "0" })]);
  const a = treeDigest(warm);
  const b = treeDigest(clean);
  const differ = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
  if (differ.length) {
    failures++;
    const shown = differ.slice(0, 12).map((k) => `  ${k}${!a.has(k) ? " (clean only)" : !b.has(k) ? " (warm only)" : ""}`);
    console.log(`build-equivalence: step ${step} (${label}): the warm .build differs from a clean build in ${differ.length} files\n${shown.join("\n")}`);
  } else console.log(`build-equivalence: step ${step} (${label}): ${a.size} files identical`);
}
if (failures) {
  console.log(`build-equivalence: FAILED at seed ${seed}; replay with --seed ${seed} --plan ${plan.join(",")}`);
  process.exit(1);
}
console.log(`build-equivalence: ok, ${plan.length} edits, every warm build matched its clean build`);
