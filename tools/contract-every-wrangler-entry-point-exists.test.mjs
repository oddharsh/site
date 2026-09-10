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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
//
// Since 2026-09-02 that config has a real wrangler consumer: cal's suite boots
// it through createTestHarness, which resolves `main` the way a deploy would,
// so a wrong path now fails the suite before it reaches this check.

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

test("Wrangler check follows every tracked project's installed resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-wrangler-check-"));
  const version = "4.129.1";
  const env = { ...process.env };
  delete env.WRANGLER_VERSION;
  const write = async (name, value) => {
    const dest = join(dir, name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(value));
  };
  const run = (status, pattern, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [join(dir, "tools/check-wrangler.ts")], {
      cwd: tmpdir(), env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, pattern);
  };
  try {
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools/check-wrangler.ts"), await readFile(new URL("tools/check-wrangler.ts", ROOT)));
    const pkg = { type: "module", devDependencies: { wrangler: version }, workspaces: ["cal", "cf-garage", "lwe-ask"] };
    await write("package.json", pkg);
    const projects = ["cal", "cf-garage", "lwe-ask", "lens-reader", "nested/new project"];
    for (const project of projects) await write(`${project}/package.json`, {});
    execFileSync("git", ["init", "--quiet", dir]);
    execFileSync("git", ["-C", dir, "add", "package.json", ...projects.map((p) => `${p}/package.json`)]);
    await write("node_modules/.bun/wrangler@current/node_modules/wrangler/package.json", { version });
    await symlink(".bun/wrangler@current/node_modules/wrangler", join(dir, "node_modules/wrangler"));
    run(0, /Wrangler/);

    // Both a newly tracked nested project and a standalone install join the check.
    for (const project of ["cal", "lens-reader", "nested/new project"]) {
      for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        await write(`${project}/package.json`, { [kind]: { wrangler: version } });
        run(1, /must not declare Wrangler/);
        await write(`${project}/package.json`, {});
      }
    }
    // A matching version in a second installation still isn't the root install.
    for (const localVersion of [version, "9.9.9"]) {
      await write("cal/node_modules/wrangler/package.json", { version: localVersion });
      run(1, /cal:.*must use the root Wrangler/);
      await rm(join(dir, "cal/node_modules/wrangler"), { recursive: true });
    }
    await symlink(join(dir, "node_modules/wrangler"), join(dir, "cal/node_modules/wrangler"));
    await write("node_modules/.bun/wrangler@unused/node_modules/wrangler/package.json", { version: "9.9.9" });
    await write("scratch/package.json", { devDependencies: { wrangler: "9.9.9" } });
    run(0, /6 projects/); // Same physical install; unused cache and untracked scratch are not consumers.

    await write("node_modules/.bun/wrangler@current/node_modules/wrangler/package.json", { version: "9.9.9" });
    run(1, /installed.*9\.9\.9|resolves Wrangler.*9\.9\.9/);
    await write("node_modules/.bun/wrangler@current/node_modules/wrangler/package.json", { version });
    run(0, /6 projects/, { WRANGLER_VERSION: `v${version}` });
    run(1, /expected 9\.9\.9/, { WRANGLER_VERSION: "9.9.9" });
    await write("package.json", { ...pkg, devDependencies: { wrangler: `^${version}` } });
    run(1, /exact Wrangler version/);
    await write("package.json", pkg);
    await rm(join(dir, "lens-reader/package.json"));
    run(1, /ENOENT/); // A tracked manifest that cannot be read is not an empty project.
    await write("lens-reader/package.json", {});
    execFileSync("git", ["-C", dir, "rm", "--cached", "--quiet", "package.json"]);
    run(1, /no tracked root package.json/);
    execFileSync("git", ["-C", dir, "add", "package.json"]);
    await rm(join(dir, ".git"), { recursive: true });
    run(1, /not a git repository/);
    await rm(join(dir, "node_modules/wrangler"));
    run(1, /bun install/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
