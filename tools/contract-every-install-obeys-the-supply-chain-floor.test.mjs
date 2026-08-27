// ── every install is frozen, and every lockfile has a policy over it ─────────
// Shared imports live in contract-shared.mjs.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { minimumReleaseAgeSeconds } from "./lib/bun-pin.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Two halves of one guarantee, and lens-reader was missing BOTH until
// 2026-08-27: `.github/workflows/ci.yml` ran a bare `bun install` in that
// directory, the one of nine in these workflows that let the resolver pick
// versions the committed lockfile does not name, and no bunfig.toml sat beside
// its bun.lock to floor what the resolver could pick.
//
// The second half is not an inference. bun resolves bunfig.toml from the CWD
// and then $HOME/.bunfig.toml, and it does NOT walk up, measured on 1.4.0 with
// one manifest in one directory, moving only the file:
//
//   bunfig in that directory -> exit 1, `blocked by minimum-release-age`
//   bunfig one level up      -> exit 0, the package installed
//
// So the root file governs the root and nothing else, and any project outside
// the workspace carrying its own lockfile needs its own copy.

const root = fileURLToPath(ROOT);

/** Workflow files, from `git ls-files` rather than a directory walk, so an
 *  untracked scratch copy cannot fail the run and a new workflow is covered by
 *  existing. */
function workflows() {
  const out = execFileSync("git", ["ls-files", "-z", ".github/workflows/*.yml"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/** Directories holding a committed bun.lock, repo-relative, "" for the root. */
function lockfileDirs() {
  const out = execFileSync("git", ["ls-files", "-z", "bun.lock", "*/bun.lock"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean).map((rel) => (rel.includes("/") ? dirname(rel) : ""));
}

/** A LINE-LEADING `#` is the only comment this drops, so a trailing `# note`
 *  after a real command still counts. Both YAML and the shell inside a `run: |`
 *  block spell a comment that way, so one rule covers the file. */
function commandLines(source) {
  return source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !/^\s*#/.test(line));
}

// `install\b` refuses "bun installed", which is prose in bun-pin.yml's PR body
// and the one false positive a substring search produces here. `bun i\b` is the
// alias, and it cannot reach `bun index.ts` for the same reason.
const INSTALL = /\bbun (?:install|i)\b/;

test("every bun install in .github/workflows is --frozen-lockfile", async () => {
  const files = workflows();

  // FLOOR. A scanner that matches nothing reports a pass, which is the failure
  // this repository has shipped three times. Nine installs across eight
  // workflows today, and the count only grows.
  assert.ok(files.length >= 8, `found only ${files.length} workflows; the scanner is broken`);

  const found = [];
  const unfrozen = [];
  for (const rel of files) {
    const source = await readFile(new URL(rel, ROOT), "utf8");
    for (const [n, line] of commandLines(source)) {
      if (!INSTALL.test(line)) continue;
      found.push(`${rel}:${n}`);
      if (!/--frozen-lockfile\b/.test(line)) unfrozen.push(`${rel}:${n}: ${line.trim()}`);
    }
  }

  assert.ok(found.length >= 9, `found only ${found.length} bun installs; the scanner is broken`);
  assert.deepEqual(
    unfrozen,
    [],
    `these installs let the resolver pick versions the committed lockfile does not name:\n  ${unfrozen.join("\n  ")}`,
  );
});

test("every directory with its own bun.lock carries its own bunfig.toml", async () => {
  const dirs = lockfileDirs();

  // FLOOR. Two today: the root, and lens-reader, which sits outside the
  // workspace because readability and its parser are megabytes only that Worker
  // bundles.
  assert.ok(dirs.length >= 2, `found only ${dirs.length} lockfiles; the scanner is broken`);
  assert.ok(dirs.includes("lens-reader"), "lens-reader's bun.lock went missing from the scan");

  const floor = minimumReleaseAgeSeconds(root);
  assert.ok(floor > 0, "the root declares no usable minimumReleaseAge");

  for (const dir of dirs) {
    const where = dir || "the repository root";
    let age;
    try {
      age = minimumReleaseAgeSeconds(join(root, dir));
    } catch (err) {
      assert.fail(
        `${where} carries a bun.lock and no bunfig.toml declaring minimumReleaseAge (${err.message}). ` +
          `bun reads bunfig.toml from the working directory and never walks up, so the root file does not reach it.`,
      );
    }
    // One decision, so one number. A sub-project quietly declaring a shorter
    // window is exactly what this pair of tests exists to catch, and a longer
    // one is a policy change that belongs in both files.
    assert.equal(age, floor, `${where} floors installs at ${age}s where the root floors them at ${floor}s`);
  }
});
