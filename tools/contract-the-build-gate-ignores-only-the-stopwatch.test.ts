// The byte-identical build gate (lib/bun-gates.ts) compares two `.build/`
// trees. From 2026-10-13 the build also wrote its own phase timings there, and
// the gate read a stopwatch as a byte change: every candidate bun went red on
// `phases.json` alone (gotcha 68). The gate now skips that one file. These
// tests hold both halves: the timings never fail it, and anything else still
// does, so the exemption cannot quietly widen into a gate that passes
// everything.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_TIMINGS, builtBytes, diffTrees } from "./lib/bun-gates.ts";

async function tree(files) {
  const dir = await mkdtemp(join(tmpdir(), "build-gate-"));
  for (const [rel, body] of Object.entries<string>(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

test("two builds that differ only in their phase timings are byte-identical", async () => {
  const a = await tree({ "public/a/app.1234abcd.js": "x", "phases.json": '[{"wallMs":3012}]\n' });
  const b = await tree({ "public/a/app.1234abcd.js": "x", "phases.json": '[{"wallMs":2987}]\n' });
  try {
    assert.equal(diffTrees(builtBytes(a), builtBytes(b)).identical, true);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("CONTROL: a changed byte anywhere else still fails, timings or not", async () => {
  const a = await tree({ "public/a/app.1234abcd.js": "x", "phases.json": "[]\n", "worker.js": "1" });
  const b = await tree({ "public/a/app.1234abcd.js": "y", "phases.json": "[]\n", "worker.js": "2" });
  // A phases.json served under public/ is a shipped byte, not the stopwatch.
  const c = await tree({ "public/phases.json": "1" });
  const d = await tree({ "public/phases.json": "2" });
  try {
    assert.deepEqual(diffTrees(builtBytes(a), builtBytes(b)).differing.sort(), ["public/a/app.1234abcd.js", "worker.js"]);
    assert.deepEqual(diffTrees(builtBytes(c), builtBytes(d)).differing, ["public/phases.json"]);
  } finally {
    for (const dir of [a, b, c, d]) await rm(dir, { recursive: true, force: true });
  }
});

test("the exempt file is the one build.ts writes outside the served tree", async () => {
  assert.deepEqual(BUILD_TIMINGS, ["phases.json"]);
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  const wrangler = await readFile(new URL("wrangler.config.ts", ROOT), "utf8");
  assert.match(build, /const OUT = "\.build";/);
  assert.match(build, /writeFile\(`\$\{OUT\}\/phases\.json`/, "build.ts must still write its timings to .build/phases.json, or the exemption names nothing");
  assert.match(wrangler, /assetsDirectory: "\.build\/public"/, "the served tree must stay below .build/, or phases.json would ship");
});
