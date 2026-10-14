// ── every install is frozen, and every lockfile has a policy over it ─────────
// Shared imports live in contract-shared.mjs.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { minimumReleaseAgeSeconds } from "./lib/bun-pin.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(ROOT);

function workflows() {
  const out = execFileSync("git", ["ls-files", "-z", ".github/workflows/*.yml"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function lockfileDirs() {
  const out = execFileSync("git", ["ls-files", "-z", "bun.lock", "*/bun.lock"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean).map((rel) => (rel.includes("/") ? dirname(rel) : ""));
}

function commandLines(source) {
  return source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !/^\s*#/.test(line));
}

const INSTALL = /\bbun (?:install|i)\b/;

const PINNED_GLOBAL = /\bbun install -g (?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:\s|$)/;

export function installObeysFloor(line) {
  return /--frozen-lockfile\b/.test(line) || PINNED_GLOBAL.test(line);
}

test("every bun install in .github/workflows is --frozen-lockfile", async () => {
  const files = workflows();

  assert.ok(files.length >= 8, `found only ${files.length} workflows; the scanner is broken`);

  const found = [];
  const unfrozen = [];
  for (const rel of files) {
    const source = await readFile(new URL(rel, ROOT), "utf8");
    for (const [n, line] of commandLines(source)) {
      if (!INSTALL.test(line)) continue;
      found.push(`${rel}:${n}`);
      if (!installObeysFloor(line)) unfrozen.push(`${rel}:${n}: ${line.trim()}`);
    }
  }

  assert.ok(found.length >= 10, `found only ${found.length} bun installs; the scanner is broken`);
  assert.deepEqual(
    unfrozen,
    [],
    `these installs let the resolver pick versions the committed lockfile does not name:\n  ${unfrozen.join("\n  ")}`,
  );
});

test("every directory with its own bun.lock carries its own bunfig.toml", async () => {
  const dirs = lockfileDirs();

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
    assert.equal(age, floor, `${where} floors installs at ${age}s where the root floors them at ${floor}s`);
  }
});


test("the global-install exemption admits an exact version and nothing looser", () => {
  assert.equal(installObeysFloor("          bun install -g @anthropic-ai/claude-code@2.1.270"), true);
  assert.equal(installObeysFloor("bun install -g left-pad@1.3.0 # pinned"), true);
  assert.equal(installObeysFloor("bun install -g @anthropic-ai/claude-code"), false);
  assert.equal(installObeysFloor("bun install -g @anthropic-ai/claude-code@latest"), false);
  assert.equal(installObeysFloor("bun install -g @anthropic-ai/claude-code@^2.1.0"), false);
  assert.equal(installObeysFloor("bun install -g @anthropic-ai/claude-code@2.1"), false);
  assert.equal(installObeysFloor("bun install @anthropic-ai/claude-code@2.1.270"), false, "a local install still needs the lockfile");
});
