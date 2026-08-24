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

/** Directories that hold a wrangler config, discovered rather than listed, so a
 *  seventh Worker is covered by existing rather than by an edit here. */
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
      if (!/^wrangler[\w.-]*\.(toml|jsonc?)$/.test(entry.name)) continue;
      found.push({ dir, path: dir === "." ? entry.name : `${dir}/${entry.name}` });
    }
  }
  return found;
}

// TOML writes `main = "x"` and JSONC writes `"main": "x"`. One pattern reads
// both, anchored at line start so a `main` inside prose cannot match.
const MAIN = /^\s*"?main"?\s*[:=]\s*"([^"]+)"/m;

test("every wrangler config's entry point resolves to a real file", async () => {
  const configs = await wranglerConfigs();

  // FLOOR. A scanner that matches nothing reports a pass, which is the failure
  // this repository has shipped three times. Six configs exist today: the two
  // root ones plus cal, cf-garage, lens-reader and lwe-ask.
  assert.ok(configs.length >= 6, `found only ${configs.length} wrangler configs; the scanner is broken`);

  const missing = [];
  let checked = 0;
  for (const { dir, path } of configs) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    const match = MAIN.exec(source);
    if (!match) continue;              // a config may legitimately declare no main
    checked++;
    const declared = match[1];

    // wrangler.jsonc points at `.build/src/worker/index.ts`, which the build
    // STAGES rather than commits. CLAUDE.md records that build.mjs mirrors the
    // source path there deliberately, so the staged path is checkable against
    // its source twin without running a build.
    const resolved = declared.replace(/^(\.\/)?\.build\//, "");
    const onDisk = new URL(dir === "." ? resolved : `${dir}/${resolved}`, ROOT);
    if (!existsSync(onDisk)) missing.push(`${path} → ${declared}`);
  }

  assert.ok(checked >= 6, `only ${checked} configs declared a main; expected at least 6`);
  assert.deepEqual(missing, [], `wrangler entry points that do not exist:\n  ${missing.join("\n  ")}`);
});
