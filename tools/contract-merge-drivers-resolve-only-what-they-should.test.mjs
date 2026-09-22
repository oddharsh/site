// ── the merge drivers resolve the machine-owned classes and nothing else ─────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// A merge driver that resolves a conflict WRONGLY is worse than the conflict it
// replaced, because a conflict stops you and a wrong resolution does not. So the
// assertions here are mostly about what the drivers must REFUSE, and every one
// of them is run against a real git performing a real merge rather than against
// the merge function in isolation.
//
// THE FIXTURE ROOT IS CANONICALISED, and that is not decoration. mkdtemp under
// $TMPDIR hands back /var/... on macOS while anything resolving the path reads
// /private/var/..., and the driver asks git for an absolute git dir. Three
// fixtures in this repository have already been caught by that split, and it is
// invisible on Linux CI, so a version of this file without realpathSync is green
// where it runs and red on the machine writing it (gotcha 45).

const repoRoot = fileURLToPath(ROOT);
const driver = join(repoRoot, "tools", "merge-driver.ts");

function git(cwd, args, env = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}
function gitStatus(cwd, args, env = {}) {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/** A throwaway repository wired to the real drivers. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "merge-driver-")));
  git(dir, ["init", "-q", "-b", "base"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "contract"]);
  for (const mode of ["json", "pin", "regen"]) {
    git(dir, ["config", `merge.${mode}.driver`, `bun ${driver} ${mode} %O %A %B %L %P`]);
  }
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, ".gitattributes"), readFileSync(join(repoRoot, ".gitattributes")));
  return dir;
}

const pkg = (scripts, dev = {}) =>
  JSON.stringify({ name: "fixture", scripts, devDependencies: dev }, null, 2) + "\n";

/** base -> a mainline commit and a feature commit, then replay the feature. */
function replay(dir, files) {
  for (const [path, body] of Object.entries(files.base)) writeFileSync(join(dir, path), body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["branch", "-q", "feature"]);
  for (const [path, body] of Object.entries(files.mainline)) writeFileSync(join(dir, path), body);
  git(dir, ["commit", "-qam", "mainline"]);
  const mainline = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "feature"]);
  for (const [path, body] of Object.entries(files.feature)) writeFileSync(join(dir, path), body);
  git(dir, ["commit", "-qam", "feature"]);
  // A rebase is what a branch here actually does, and it is the orientation the
  // drivers have to get right: git labels the MAINLINE "ours" during one.
  const status = gitStatus(dir, ["rebase", mainline]);
  const unmerged = git(dir, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  return { status, unmerged, read: (p) => readFileSync(join(dir, p), "utf8") };
}

test("an add/add in package.json keeps both sides and moves nothing else", () => {
  const dir = fixture();
  try {
    const out = replay(dir, {
      base: { "package.json": pkg({ build: "bun build", test: "bun test" }) },
      mainline: { "package.json": pkg({ build: "bun build", test: "bun test", lint: "oxlint" }) },
      feature: { "package.json": pkg({ build: "bun build", test: "bun test", dev: "bun dev" }) },
    });
    assert.deepEqual(out.unmerged, [], "the add/add should not have survived as a conflict");
    const merged = JSON.parse(out.read("package.json"));
    assert.equal(merged.scripts.lint, "oxlint", "the mainline's new script was dropped");
    assert.equal(merged.scripts.dev, "bun dev", "the feature's new script was dropped");
    assert.equal(merged.scripts.build, "bun build", "an untouched script changed");
    assert.equal(Object.keys(merged.scripts).length, 4, "the merge invented or lost a script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE CONTROL. Without this the file above could pass with a driver that simply
// takes one whole side, which is the failure this whole design exists to avoid.
test("both sides moving the same key is still a conflict", () => {
  const dir = fixture();
  try {
    const out = replay(dir, {
      base: { "package.json": pkg({ build: "bun build" }) },
      mainline: { "package.json": pkg({ build: "MAINLINE" }) },
      feature: { "package.json": pkg({ build: "FEATURE" }) },
    });
    assert.notEqual(out.status, 0, "a genuine disagreement was resolved silently");
    assert.deepEqual(out.unmerged, ["package.json"], "the conflict should stand on package.json");
    assert.match(out.read("package.json"), /<<<<<<</, "no conflict markers were written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key one side deleted stays deleted rather than being resurrected", () => {
  const dir = fixture();
  try {
    const out = replay(dir, {
      base: { "package.json": pkg({ build: "bun build", old: "retired" }) },
      mainline: { "package.json": pkg({ build: "bun build" }) },
      feature: { "package.json": pkg({ build: "bun build", old: "retired", dev: "bun dev" }) },
    });
    assert.deepEqual(out.unmerged, []);
    const merged = JSON.parse(out.read("package.json"));
    assert.ok(!("old" in merged.scripts), "a deleted key came back");
    assert.equal(merged.scripts.dev, "bun dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrangler pin conflict resolves to the proposal and records the gate it owes", () => {
  const dir = fixture();
  try {
    const url = (sha) => `https://pkg.pr.new/cloudflare/workers-sdk/wrangler@${sha}`;
    const out = replay(dir, {
      base: { "package.json": pkg({ build: "b" }, { wrangler: url("aaaaaaa") }) },
      mainline: { "package.json": pkg({ build: "b" }, { wrangler: url("bbbbbbb") }) },
      feature: { "package.json": pkg({ build: "b" }, { wrangler: url("ccccccc") }) },
    });
    assert.deepEqual(out.unmerged, [], "the pin conflict was left standing");
    const merged = JSON.parse(out.read("package.json"));
    assert.equal(merged.devDependencies.wrangler, url("ccccccc"), "the mainline pin won over the proposal");
    const ledger = readFileSync(join(dir, ".git", "site-merge-pending"), "utf8");
    assert.match(ledger, /canary:wrangler/, "the gate the pin owes was not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lockfile is parked for regeneration rather than text-merged", () => {
  const dir = fixture();
  try {
    const out = replay(dir, {
      base: { "bun.lock": "lock base\n", "package.json": pkg({ build: "b" }) },
      mainline: { "bun.lock": "lock MAINLINE\n" },
      feature: { "bun.lock": "lock FEATURE\n" },
    });
    assert.deepEqual(out.unmerged, [], "bun.lock was left as a conflict");
    assert.ok(!out.read("bun.lock").includes("<<<<<<<"), "conflict markers reached bun.lock");
    const ledger = readFileSync(join(dir, ".git", "site-merge-pending"), "utf8");
    assert.match(ledger, /^bun\.lock\t/m, "bun.lock was not recorded for regeneration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The round-trip guard is what stops the driver reformatting a file it resolves.
test("a JSON file this serializer cannot reproduce is refused, not reformatted", () => {
  const dir = fixture();
  try {
    const odd = (build) => `{"name":"fixture","scripts":{"build":"${build}"},"devDependencies":{}}`;
    const out = replay(dir, {
      base: { "package.json": odd("base") + "\n" },
      mainline: { "package.json": odd("base") + "\n// not json\n" },
      feature: { "package.json": odd("feature") + "\n" },
    });
    assert.notEqual(out.status, 0, "an unparseable file was resolved anyway");
    assert.deepEqual(out.unmerged, ["package.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The drift guard. .gitattributes names drivers and config/gitconfig defines
// them, and the two live in different files precisely because git will not read
// an executable definition out of a tracked one. Nothing else joins them.
test("every driver .gitattributes names is defined in config/gitconfig", async () => {
  const attrs = await readFile(new URL(".gitattributes", ROOT), "utf8");
  const conf = await readFile(new URL("config/gitconfig", ROOT), "utf8");
  const named = new Set([...attrs.matchAll(/^\s*\S+\s+merge=(\S+)/gm)].map((m) => m[1]));
  const defined = new Set([...conf.matchAll(/^\[merge "([^"]+)"\]/gm)].map((m) => m[1]));

  assert.ok(named.size >= 3, `only ${named.size} merge attributes found; the scan has stopped matching`);
  for (const name of named) {
    assert.ok(defined.has(name), `.gitattributes uses merge=${name} and config/gitconfig does not define it`);
  }
  for (const name of defined) {
    assert.ok(named.has(name), `config/gitconfig defines merge.${name} and no path uses it`);
  }
});

// The round-trip guard makes a refusal safe, and it also makes the driver a
// SILENT NO-OP on any file it cannot reproduce. That failure has no symptom: the
// conflicts simply come back and nobody connects it to the reformat that caused
// it. So the real targets are asserted to be reproducible, which is a claim
// about the committed bytes rather than about the code.
test("the JSON files the drivers own reproduce through the serializer", async () => {
  const attrs = await readFile(new URL(".gitattributes", ROOT), "utf8");
  const owned = [...attrs.matchAll(/^\s*(\S+)\s+merge=(?:json|pin)/gm)].map((m) => m[1]);
  assert.ok(owned.length >= 3, `only ${owned.length} json/pin paths found; the scan has stopped matching`);

  for (const path of owned) {
    const text = await readFile(new URL(path, ROOT), "utf8");
    const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
    const round = JSON.stringify(JSON.parse(text), null, indent) + (text.endsWith("\n") ? "\n" : "");
    assert.equal(
      round,
      text,
      `${path} no longer reproduces through the driver's serializer, so the driver will refuse it silently and its conflicts come back`,
    );
  }
});
