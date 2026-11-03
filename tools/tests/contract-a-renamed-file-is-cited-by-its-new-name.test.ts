// ── a renamed file is cited by its new name ─────────────────────────────────
// The tools moved from .mjs to .ts and their prose stayed behind: on
// 2026-10-17, 177 lines in 115 files still named a .mjs file that no longer
// existed: file headers naming themselves, usage strings, assertion messages,
// a public/_headers comment, /garage/blueprint's copy. The build's repo-paths step (tools/build.ts, 7b)
// could not see them, because it reads only served bytes and only cites a
// path anchored on a top-level directory, and most of these were bare names
// like perf-budget.mjs.
//
// The rule is narrow on purpose, since a nuisance check gets commented out. A
// `.mjs` or `.cjs` name is stale when no tracked file has that name and a
// tracked file has the same name in `.ts`. Fixtures that a test writes on
// purpose (mod.mjs, upload.mjs) have no .ts twin, and workerd's own worker.mjs
// exists, so neither is flagged.
import { ROOT, assert, test } from "./contract-shared.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repoFiles } from "../lib/repo-files.ts";

const NAME = /(?<![\w.-])([A-Za-z0-9_][A-Za-z0-9_.-]*)\.(?:mjs|cjs)\b/g;
const SKIP = /(^|\/)(bun\.lock|package-lock\.json)$|^src\/dict\/|\.(br|dcz|dict|png|jpe?g|avif|jxl|webp|gif|pdf|woff2?|ico|mp4|zip|wasm|bin)$/i;

// Dated history: each sentence names the file as it was called when the event
// happened, so the old name is the true one. Keyed by file and name, and an
// entry that stops matching fails below, so the list cannot outlive its lines.
const HISTORY = [
  ["tools/tests/contract-the-typescript-quarantine.test.ts", "deploy-promote.mjs", "five tools broke on the 2026-08-20 bun merge"],
  ["tools/build.ts", "radar-sample.mjs", "what /terminal/radar printed after the rename"],
  ["docs/TOOLCHAIN-DECISIONS.md", "deploy-promote.mjs", "comment:exec quotes what the comment USED TO SAY"],
  ["docs/TOOLCHAIN-DECISIONS.md", "perf-budget.mjs", "comment:exec quotes what the comment USED TO SAY"],
] as const;

type Citation = { file: string; line: number; name: string; now: string };

/** Every `.mjs`/`.cjs` name in `texts` whose file is gone and whose `.ts` twin exists. */
function staleCitations(files: string[], texts: Map<string, string>): Citation[] {
  const names = new Set(files.map((f) => f.slice(f.lastIndexOf("/") + 1)));
  const found: Citation[] = [];
  for (const [file, text] of texts) {
    for (const [i, line] of text.split("\n").entries()) {
      for (const m of line.matchAll(NAME)) {
        const now = `${m[1]}.ts`;
        if (!names.has(m[0]) && names.has(now)) found.push({ file, line: i + 1, name: m[0], now });
      }
    }
  }
  return found;
}

test("the matcher flags a renamed file's old name and leaves fixtures and live .mjs files alone", () => {
  const files = ["tools/new-tool.ts", "tools/lib/helper.ts", "tools/x.test.ts", "vendor/worker.mjs", "worker.ts"];
  const texts = new Map([
    ["docs/a.md", "run `bun tools/new-tool.mjs`, then see helper.cjs and x.test.mjs"],
    ["tools/b.ts", 'writeFile("mod.mjs") // a fixture with no twin\nimport "./vendor/worker.mjs"; // exists'],
    ["tools/c.ts", "not-a-new-tool.mjs and new-tool.mjsx are other names"],
  ]);
  assert.deepEqual(
    staleCitations(files, texts).map((c) => `${c.file}:${c.line} ${c.name} -> ${c.now}`),
    ["docs/a.md:1 new-tool.mjs -> new-tool.ts", "docs/a.md:1 helper.cjs -> helper.ts", "docs/a.md:1 x.test.mjs -> x.test.ts"],
  );
});

test("every file cites a renamed file by its new name", () => {
  const root = fileURLToPath(ROOT);
  const files = repoFiles([], root);
  // This file is skipped: HISTORY and the header have to spell the old names
  // to explain them. It passed locally on 2026-10-17 only because it was not
  // yet tracked, and the first CI run failed on its own six citations.
  const self = fileURLToPath(import.meta.url).slice(root.length);
  const texts = new Map<string, string>();
  for (const file of files) {
    if (SKIP.test(file) || file === self) continue;
    try {
      texts.set(file, readFileSync(`${root}${file}`, "utf8"));
    } catch {
      /* a submodule or a deleted path */
    }
  }
  // A scan that reads nothing finds nothing and still passes. 900 of 2260
  // tracked files are text on 2026-10-17; most of the rest are photo tiers.
  assert.ok(texts.size > 800, `scanned only ${texts.size} tracked files, expected 800+`);

  const all = staleCitations(files, texts);
  const exempt = (c: Citation) => HISTORY.some(([file, name]) => c.file === file && c.name === name);
  const stale = all.filter((c) => !exempt(c));
  assert.deepEqual(
    stale.map((c) => `${c.file}:${c.line} ${c.name} (now ${c.now})`),
    [],
    "these name a file by the .mjs name it had before it became .ts; cite the .ts file",
  );

  for (const [file, name, why] of HISTORY) {
    assert.ok(
      all.some((c) => c.file === file && c.name === name),
      `HISTORY exempts ${name} in ${file} (${why}), but the line is gone; drop the entry`,
    );
  }
});
