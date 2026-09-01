// ── every wrangler config points at a file that exists ──────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  existsSync,
  readFile,
  readdir,
  test,
} from "./contract-shared.ts";

// `main` is the one field in a wrangler config that names a path wrangler has
// to resolve itself, and it is the one field nothing here was checking.
//
// cal/wrangler.test.toml carried `main = "src/index.js"` from the TypeScript
// conversion until 2026-08-23 while its suite stayed green, because the Vitest
// pool resolves that specifier through Vite, which maps `.js` onto `.ts`. The
// pool never asks wrangler. So the config was broken for every real wrangler
// command and correct for the only consumer anybody ran, which is exactly the
// shape that survives review.
//
// Five of the six configs were updated by that conversion. The one that was not
// is the one no deploy path touches, so nothing failed. This is the check that
// turns "no deploy path touches it" from the reason it rotted into the reason
// it cannot rot again.

/** Directories that hold a Worker config, discovered rather than listed, so a
 *  seventh Worker is covered by existing rather than by an edit here.
 *
 *  TWO FORMATS. `wrangler.{toml,jsonc}` is the settled one; `cloudflare.config.ts`
 *  is wrangler's experimental TypeScript config, which cf-garage moved to on
 *  2026-08-23 as the cheapest place to be wrong. Both are matched, because a
 *  check that only knows the old format stops covering a Worker on the day it
 *  migrates and says nothing. */
async function wranglerConfigs() {
  const found = [];
  const roots = ["."];
  for (const name of await readdir(new URL(".", ROOT), { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (["node_modules", ".git", ".build", ".wrangler", ".claude"].includes(name.name)) continue;
    roots.push(name.name);
  }
  for (const dir of roots) {
    const url = new URL(dir === "." ? "." : `${dir}/`, ROOT);
    let entries;
    try { entries = await readdir(url, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^(wrangler[\w.-]*\.(toml|jsonc?)|cloudflare\.config\.(ts|mts|js|mjs))$/.test(entry.name)) continue;
      found.push({ dir, path: dir === "." ? entry.name : `${dir}/${entry.name}` });
    }
  }
  return found;
}

// TOML writes `main = "x"`, JSONC writes `"main": "x"`, and the TypeScript
// config renames the field to `entrypoint: "./x"`. One pattern reads all three,
// anchored at line start so the word inside a comment cannot match.
//
// THE RENAME IS THE TRAP, and the floor below is what caught it. A scanner
// keyed on `main` alone finds nothing in cloudflare.config.ts, skips the file
// without complaint, and reports a pass over one fewer Worker than it did the
// day before. That is this check's own failure mode, arriving within a day of
// it being written.
const ENTRY = /^\s*"?(?:main|entrypoint)"?\s*[:=]\s*"([^"]+)"/m;

test("every wrangler config's entry point resolves to a real file", async () => {
  const configs = await wranglerConfigs();

  // FLOOR. A scanner that matches nothing reports a pass, which is the failure
  // this repository has shipped three times. Six configs exist today: the two
  // root ones, plus cal, lens-reader and lwe-ask on wrangler.*, plus cf-garage
  // on cloudflare.config.ts.
  assert.ok(configs.length >= 6, `found only ${configs.length} Worker configs; the scanner is broken`);

  const missing = [];
  let checked = 0;
  for (const { dir, path } of configs) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    const match = ENTRY.exec(source);
    if (!match) continue;              // a config may legitimately declare no main
    checked++;
    const declared = match[1];

    // wrangler.jsonc points at `.build/src/worker/index.ts`, which the build
    // STAGES rather than commits. CLAUDE.md records that build.ts mirrors the
    // source path there deliberately, so the staged path is checkable against
    // its source twin without running a build.
    const resolved = declared.replace(/^\.\//, "").replace(/^\.build\//, "");
    const onDisk = new URL(dir === "." ? resolved : `${dir}/${resolved}`, ROOT);
    if (!existsSync(onDisk)) missing.push(`${path} → ${declared}`);
  }

  // A SECOND floor, on the extraction rather than the discovery. Finding six
  // files and reading an entry point out of five is the shape the rename would
  // have produced, and it is invisible to the count above.
  assert.ok(checked >= 6, `only ${checked} of ${configs.length} configs declared an entry point; expected at least 6`);
  assert.deepEqual(missing, [], `Worker entry points that do not exist:\n  ${missing.join("\n  ")}`);
});
