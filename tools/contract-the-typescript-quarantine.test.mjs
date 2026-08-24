// ── the TypeScript quarantine ───────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readdir,
  remainderHolder,
  test,
} from "./contract-shared.mjs";

// ── the TypeScript quarantine ───────────────────────────────────────────────
// config/ts-migration.json names the Worker modules that were not type-clean
// when src/worker became TypeScript. Each carries @ts-nocheck. The declaration
// says the list "may only shrink", and this is what makes that true rather than
// aspirational: without it, adding @ts-nocheck to a module is a silent opt-out
// of the checker, which is the one thing the conversion was for.
test("every @ts-nocheck in the Worker is declared, and every declaration is real", async () => {
  const declared = JSON.parse(await readFile(new URL("config/ts-migration.json", ROOT), "utf8"));
  const names = Object.keys(declared.modules);

  const workerModules = (await readdir(new URL("src/worker", ROOT), { recursive: true }))
    .filter((rel) => rel.endsWith(".ts"));
  const actual = [];
  for (const rel of workerModules) {
    if (!rel.endsWith(".ts")) continue;
    const source = await readFile(new URL(`src/worker/${rel}`, ROOT), "utf8");
    if (/^\/\/ @ts-nocheck\b/m.test(source)) actual.push(`src/worker/${rel}`);
  }

  assert.deepEqual(actual.sort(), names.sort(),
    "the set of modules carrying @ts-nocheck must equal config/ts-migration.json's list — " +
    "add an entry deliberately, or delete one when you fix a module");

  // The counts are the progress record. A module that is fixed but left in the
  // list would keep claiming errors it no longer has, so require them positive
  // and require the totals to agree with the entries.
  for (const [file, count] of Object.entries(declared.modules)) {
    assert.ok(Number.isInteger(count) && count > 0, `${file} declares a non-positive error count`);
  }
  assert.equal(declared.totals.quarantined, names.length, "totals.quarantined disagrees with the list");
  assert.equal(declared.totals.worker_modules, workerModules.length, "totals.worker_modules disagrees with the Worker tree");
  assert.equal(declared.totals.fully_checked, workerModules.length - names.length, "totals.fully_checked disagrees with the Worker tree and quarantine");
  assert.equal(declared.totals.errors_at_conversion,
    Object.values(declared.modules).reduce((a, b) => a + b, 0), "totals.errors_at_conversion disagrees with the entries");
});

test("the TypeScript compiler program includes every Worker module", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const tsc = fileURLToPath(new URL("node_modules/typescript/bin/tsc", ROOT));
  const config = fileURLToPath(new URL("config/tsconfig.json", ROOT));
  const output = execFileSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], { encoding: "utf8" });
  const compiled = new Set(output.trim().split(/\r?\n/));
  const workerModules = (await readdir(new URL("src/worker", ROOT), { recursive: true }))
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => fileURLToPath(new URL(`src/worker/${rel}`, ROOT)));
  const missing = workerModules.filter((file) => !compiled.has(file));

  assert.deepEqual(missing, [], `tsc skipped Worker modules:\n  ${missing.join("\n  ")}`);
});

// EVERY DEPLOYABLE WORKER IS IN SOME TSC PROGRAM. The three auxiliary Workers
// (cf-garage, lwe-ask, lens-reader) reach production on their own deploys, and
// until 2026-08-21 no tsc program held a line of them: 6 files of live runtime
// code, checked by nothing. They were invisible for the ordinary reason an
// allowlist goes stale, which is that config/tsconfig.json's include names the
// site Worker and cal and has no way to notice a fourth project appearing.
//
// So the wrangler.toml is the registry rather than a list anybody maintains. A
// new auxiliary Worker joins this assertion by being deployable, and the test
// fails until it has a program and something runs that program.
//
// TWO PLACES COUNT AS RUNNING IT, and lens-reader is why. It is deliberately
// out of the workspace, so readability and linkedom live in
// lens-reader/node_modules; wired into the ROOT typecheck it fails in CI with
// TS2307 on both imports while every workstation that has installed there stays
// green. That is the split CLAUDE.md records about the root contract suite,
// arriving through a second door, and the control for it is to hide
// lens-reader/node_modules and re-run rather than to trust a local pass. So a
// project may instead carry its own typecheck script, and then CI has to invoke
// it in the step that installs its dependencies.
//
// Text-only on purpose: a tsc run per project would put seconds on the suite to
// re-prove what the package scripts already state.
test("every auxiliary Worker has a tsc program, and something runs it", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const root = new URL("./", ROOT).pathname;

  // A directory holding a wrangler.toml is a separately deployed Worker. The
  // ROOT config is wrangler.jsonc, so it is excluded by extension rather than
  // by name, and cal/ and serendipity/ are correctly absent: they carry no
  // wrangler config because the site Worker bundles them.
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .filter((name) => existsSync(`${root}${name}/wrangler.toml`))
    .sort();

  // A FLOOR, because a test that scanned nothing looks exactly like a clean run.
  assert.ok(projects.length >= 3,
    `expected at least the three auxiliary Workers, found ${projects.length}: ${projects.join(", ")}`);

  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const rootTypecheck = pkg.scripts.typecheck;
  const ci = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");

  const ranBy = new Map();
  const missing = [];
  for (const name of projects) {
    const config = `config/tsconfig.${name}.json`;
    if (!existsSync(`${root}${config}`)) {
      missing.push(`${name}: no ${config}`);
      continue;
    }
    if (rootTypecheck.includes(config)) {
      ranBy.set(config, "root");
      continue;
    }
    // The self-run arm. Both halves are required: a script nothing invokes is
    // decoration, and this repo has the perf-budget history to prove it.
    const own = JSON.parse(await readFile(new URL(`${name}/package.json`, ROOT), "utf8"));
    const script = own.scripts?.typecheck;
    if (!script?.includes(config.replace("config/", ""))) {
      missing.push(`${name}: ${config} exists but neither the root typecheck nor ${name}/package.json runs it`);
      continue;
    }
    // CI has to invoke it inside THAT project's step, which is the step that
    // installs the dependencies the program needs.
    const step = ci.indexOf(`working-directory: ${name}`);
    const runs = step !== -1 && ci.slice(step, step + 800).includes("bun run typecheck");
    if (!runs) missing.push(`${name}: has its own typecheck script, but ci.yml never runs it in its own step`);
    else ranBy.set(config, name);
  }
  assert.deepEqual(missing, [],
    `an auxiliary Worker is unchecked:\n  ${missing.join("\n  ")}`);

  // The other direction, so a program cannot be written and left unwired. Every
  // tsconfig in config/ has to be run by something, which is the failure that
  // made the aux Workers orphans in the first place, one level up.
  const configs = readdirSync(`${root}config`).filter((f) => /^tsconfig\..+\.json$/.test(f));

  // A THIRD WAY TO BE RUN, and it is now the common one: through a wrapper.
  // Several programs hold files from two runtimes at once, so their diagnostics
  // have to be filtered to the tree the program can legitimately judge, and a
  // package script therefore names `tools/check-*.mjs` rather than the config.
  // This arm used to be a single hardcoded exemption for tsconfig.tools.json,
  // which is the same allowlist habit the rest of this file is about: the two
  // test-suite programs added on 2026-08-23 landed on it immediately. So the
  // wrappers are READ instead. A config counts as run when some wrapper names
  // it AND a script names that wrapper — both halves, because a wrapper nothing
  // invokes is decoration and a script pointing at a wrapper that checks
  // nothing is worse.
  //
  // WHAT THIS ARM DOES NOT PROVE, stated because the obvious control is weaker
  // than it looks. It asks whether SOME script names the wrapper, not whether
  // the invocation that names it reaches this particular config:
  // check-test-types.mjs takes `--only`, so lens-reader's script runs one of its
  // two programs. Unwiring a single caller therefore leaves the arm satisfied,
  // and the control that bites is unwiring every caller (run 2026-08-23: both
  // configs reported orphaned). Modelling the flag here would mean
  // reimplementing the wrapper's selection inside the test, which is the shape
  // of check that can only ever agree with itself. The claim is the useful one
  // either way: a config cannot be written and left with nothing pointing at it.
  const scripts = [rootTypecheck, ...await Promise.all(projects.map(async (name) => {
    const own = JSON.parse(await readFile(new URL(`${name}/package.json`, ROOT), "utf8"));
    return own.scripts?.typecheck ?? "";
  }))].join(" ");

  const wrappedBy = new Map();
  for (const file of readdirSync(`${root}tools`).filter((f) => f.startsWith("check-") && f.endsWith(".mjs"))) {
    const source = await readFile(new URL(`tools/${file}`, ROOT), "utf8");
    for (const config of configs) {
      if (source.includes(`config/${config}`) && scripts.includes(`tools/${file}`)) wrappedBy.set(config, file);
    }
  }

  const orphaned = configs.filter((f) =>
    !rootTypecheck.includes(`config/${f}`) && !ranBy.has(`config/${f}`) && !wrappedBy.has(f));
  assert.deepEqual(orphaned, [],
    `a tsconfig exists that nothing runs: ${orphaned.join(", ")}`);

  // The wrapper arm has to have MATCHED something, or a rename in tools/ turns
  // it into a filter that exempts nothing while this test still reports green.
  assert.ok(wrappedBy.size >= 1,
    "no tsconfig resolved through a tools/check-*.mjs wrapper — the wrapper scan has lost its target");
});

// A TOOL MAY NOT SPAWN A PACKAGE MANAGER. Every script in tools/ runs under
// whichever runtime invoked it, in a tree that is bun today and was pnpm last
// week, so a hardcoded manager is wrong half the time. pnpm reads
// package.json's `packageManager` and REFUSES outright on a bun tree.
//
// Five tools carried `execFileSync("pnpm", ["exec", "wrangler", ...])` into the
// bun merge on 2026-08-20 and every one of them broke, including
// deploy-promote.mjs, which is the release path. Two broke SILENTLY, because
// they wrap the spawn in a catch and then regex the output for a number: the
// wire-size job reported "No change, 0 files" and perf-budget printed "hard
// checks green" without measuring a byte.
//
// They survived gotcha 29's pnpm sweep for the reason that gotcha records: the
// manager is a QUOTED ARGUMENT, so no search for `pnpm exec` as a phrase can
// see it. This test searches for the quoted token instead, which is the shape
// that sweep needed and did not have.
test("no tool spawns a package manager by name", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("tools/", ROOT).pathname;
  // TEST files are excluded, not just the old monolith's name. The rule governs
  // tools; a test that asserts about `pnpm` necessarily contains the word, and
  // the suite split on 2026-08-20 turned that one exclusion into 47 files.
  const files = readdirSync(dir).filter((f) =>
    f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "contract-shared.mjs");
  assert.ok(files.length >= 20, `expected the tools directory, got ${files.length} files`);

  // lens-seed.mjs is the one RECORDED exception: it drives a package script as
  // the subject of the browser recording rather than using a manager to reach
  // another binary.
  const RECORDED = new Set(["lens-seed.mjs"]);
  const offenders = [];
  for (const f of files) {
    if (RECORDED.has(f)) continue;
    const src = readFileSync(dir + f, "utf8");
    for (const m of src.matchAll(/(?:execFile|execFileSync|exec|spawn|spawnSync|run)\(\s*"(pnpm|npm|npx|bunx|yarn|corepack)"/g)) {
      offenders.push(`${f}: spawns "${m[1]}"`);
    }
  }
  assert.deepEqual(offenders, [], `a tool spawns a package manager:\n  ${offenders.join("\n  ")}\n  Use wranglerCommand() from tools/lib/wrangler-bin.mjs, which names the runtime instead.`);
});

// check-bun uses process.execPath as the Node half of its comparison. Running
// the controller itself under Bun therefore compares Bun with Bun and produces
// a meaningless green result. Keep both halves mechanical: the package script
// selects Node, and the tool refuses a direct Bun invocation.
test("bun:check compares bun against a real node control", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const source = readFileSync(new URL("tools/check-bun.mjs", ROOT), "utf8");

  assert.match(pkg.scripts["bun:check"], /^node /, "the controller must run under Node");
  assert.match(source, /if \(process\.versions\.bun\)/, "the tool must reject a direct Bun invocation");
  assert.match(source, /timedBuild\("node", process\.execPath,/, "the Node baseline must use the controlling Node executable");
  assert.doesNotMatch(source, /unlinkSync|symlinkSync/, "the checker must not replace the real contract suite with a temporary link");
});

// The helper those tools use has to run wrangler under NODE, name no package
// manager, and resolve the PINNED entry rather than whatever a PATH lookup
// finds. Node is not a leftover: wrangler says "Wrangler does not support the
// Bun runtime" and `check startup` does no work under it, measured 2026-08-20
// on 4.124.0, while `deploy --dry-run` under bun returns a correct number. The
// refusal is per-command, so one working subcommand proves nothing.
test("wranglerCommand runs the pinned wrangler under node", async () => {
  const { wranglerCommand, WRANGLER_ENTRY } = await import("./lib/wrangler-bin.mjs");
  const [cmd, argv] = wranglerCommand(["versions", "list"]);

  const expected = process.versions.bun ? "node" : process.execPath;
  assert.equal(cmd, expected, "wrangler runs under node, never under bun and never through a manager");
  assert.doesNotMatch(cmd, /pnpm|npx|bunx|yarn|corepack/, "a manager would fetch, or refuse on the wrong tree");
  if (!process.versions.bun) assert.doesNotMatch(cmd, /\/bun$/);

  assert.equal(argv[0], WRANGLER_ENTRY);
  assert.match(WRANGLER_ENTRY, /node_modules\/wrangler\/bin\/wrangler\.js$/);
  assert.ok(WRANGLER_ENTRY.startsWith("/"), "absolute, so a tool run from a subdirectory still finds the pin");
  assert.deepEqual(argv.slice(1), ["versions", "list"], "arguments pass through untouched");
});

// The two perf tools must stay on node for a different reason: the MEASUREMENT
// must not move with the toolchain. bun 1.4 ships zlib-ng, which gzips one
// byte-identical 2.8MB input to 898,553 bytes against node's 893,610 (0.55%
// larger, measured 2026-08-20). Every baseline constant in perf-budget.mjs was
// set under node's zlib, and perf-history's nightly series is years of the same,
// so running these under bun would re-read the whole series ~1% heavier with no
// code change. Shipped bytes are untouched, since brotli and zstd did not move.
test("the perf tools run under node so their numbers stay comparable", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT).pathname, "utf8"));
  for (const name of ["perf-budget", "perf:snapshot"]) {
    assert.match(pkg.scripts[name], /^node /, `${name} must run under node (bun's zlib-ng shifts every gzip number ~1%)`);
  }
});

// THE DEPLOY BRIDGE. The dashboard holds one command string per trigger and it
// has to work on whatever branch is being built, so the wrapper is what lets a
// pnpm branch and a bun branch share it.
//
// It runs wrangler under NODE for both, and that is the whole point rather than
// an implementation detail. WRANGLER DOES NOT SUPPORT BUN, measured 2026-08-20
// on 4.124.0: `check startup` under bun answers "Wrangler does not support the
// Bun runtime" and does no work, while `deploy --dry-run` under the same bun
// returns a correct bundle. The refusal is per-COMMAND, which is exactly why the
// first bun-built deploy looked fine.
//
// Tested by RUNNING it against fixture trees with stub binaries, because the
// failure it guards is a broken production deploy.
test("the deploy bridge runs the pinned wrangler under node, on either tree", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const script = new URL(".github/deploy-wrangler.sh", ROOT).pathname;
  const root = mkdtempSync(join(tmpdir(), "bridge-"));
  // A HERMETIC PATH: the stub directory is the whole of it, so nothing can fall
  // through to a real binary and pass this test for the wrong reason. bash has
  // to be linked in, since the parent resolves it through this same PATH.
  const { symlinkSync } = await import("node:fs");
  const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const stub = join(root, "stub");
  mkdirSync(stub);
  symlinkSync(bash, join(stub, "bash"));
  // A stub for each, so the test can tell WHICH ran. bun and the managers are
  // present and must go unused: their absence would pass this test for the
  // wrong reason.
  for (const name of ["node", "bun", "pnpm", "npx", "bunx"]) {
    writeFileSync(join(stub, name), `#!/bin/sh\necho "${name} ran: $*"\n`);
    chmodSync(join(stub, name), 0o755);
  }
  const run = (cwd, args) => execFileSync("bash", [script, ...args], {
    cwd, encoding: "utf8", env: { PATH: stub, HOME: process.env.HOME || root },
  });

  const withEntry = (dir, lockfile) => {
    mkdirSync(join(dir, "node_modules/wrangler/bin"), { recursive: true });
    writeFileSync(join(dir, lockfile), "");
    writeFileSync(join(dir, "node_modules/wrangler/bin/wrangler.js"), "");
    return dir;
  };

  // BOTH trees take the same path. The entry file rather than npx/bunx, which
  // FETCH what they cannot resolve (gotcha 29) and would let the one command
  // that publishes production deploy with a wrangler nobody pinned.
  for (const [tree, lockfile] of [["bun-tree", "bun.lock"], ["pnpm-tree", "pnpm-lock.yaml"]]) {
    const out = run(withEntry(join(root, tree), lockfile), ["versions", "upload", "--x-provision=false"]);
    assert.match(out, /node ran: node_modules\/wrangler\/bin\/wrangler\.js versions upload --x-provision=false/,
      `${tree} must run wrangler under node`);
    assert.doesNotMatch(out, /^bun ran:/m, `${tree} must not reach bun, which wrangler refuses`);
    assert.doesNotMatch(out, /(pnpm|npx|bunx) ran:/, `${tree} must not go through a package manager`);
  }

  // Every failure is LOUD, because a deploy command that half-works is worse
  // than one that stops.
  const half = join(root, "half");
  mkdirSync(half);
  assert.throws(() => run(half, ["versions", "upload"]), /Command failed/,
    "a missing wrangler entry means the install did not finish");
  assert.throws(() => run(withEntry(join(root, "noargs"), "bun.lock"), []), /Command failed/,
    "no arguments must exit rather than run a bare wrangler");

  // A missing node FAILS rather than falling back to bun. A quiet fallback would
  // ship a production deploy from the runtime wrangler disclaims.
  const noNode = join(root, "stub-no-node");
  mkdirSync(noNode);
  symlinkSync(bash, join(noNode, "bash"));
  for (const name of ["bun", "pnpm"]) {
    writeFileSync(join(noNode, name), `#!/bin/sh\necho "${name} ran: $*"\n`);
    chmodSync(join(noNode, name), 0o755);
  }
  assert.throws(
    () => execFileSync("bash", [script, "versions", "upload"], {
      cwd: withEntry(join(root, "nonode-tree"), "bun.lock"),
      encoding: "utf8", env: { PATH: noNode, HOME: process.env.HOME || root },
    }),
    /Command failed/,
    "no node must exit non-zero rather than deploy under bun",
  );
});

test("the deploy bridge never resolves wrangler from the registry", async () => {
  const script = await readFile(new URL(".github/deploy-wrangler.sh", ROOT), "utf8");
  // npx/bunx/dlx fetch what they cannot resolve locally (gotcha 29). On the one
  // path that publishes production that would mean deploying with a wrangler
  // nobody pinned, and the sweep that closed this hole missed `npx` as a quoted
  // argument, so grep for the tokens rather than for a phrase.
  for (const fetcher of ["npx", "bunx", "dlx", "bun x"]) {
    assert.ok(!script.includes(` ${fetcher} `), `deploy-wrangler.sh must not reach for ${fetcher}`);
  }
  // The wrangler ARGUMENTS stay in the dashboard string, where check-infra.mjs
  // reads them; the script must not smuggle its own.
  assert.ok(!/versions\s+upload/.test(script.replace(/^\s*#.*$/gm, "")),
    "the script takes no opinion on wrangler's arguments outside comments");
});

test("a ramp step hands the remainder to the LARGEST incumbent", () => {
  // The real 2026-08-20 split, in the order the API returned it: the 10% version
  // came first, so `find` picked it and 90% of traffic moved to a build nobody
  // canaried. This is the regression that change exists to prevent.
  const active = [
    { id: "863a5873-ecb6-4153-9e5a-afba4e824f38", pct: 10 },
    { id: "c649f1fc-0000-0000-0000-000000000000", pct: 90 },
  ];
  assert.equal(
    remainderHolder(active, "7634b9d8-fc15-48e0-9821-b384373a490e"),
    "c649f1fc-0000-0000-0000-000000000000",
    "the 90% incumbent must hold the remainder, whatever order the API listed",
  );

  // Order must not decide it, so the reversed list has to give the same answer.
  assert.equal(
    remainderHolder([...active].reverse(), "7634b9d8-fc15-48e0-9821-b384373a490e"),
    "c649f1fc-0000-0000-0000-000000000000",
  );

  // The target is never its own remainder holder, compared on the 8-char prefix
  // because that is what the ramp and its logs use.
  assert.equal(remainderHolder([{ id: "7634b9d8-fc15-48e0-9821-b384373a490e", pct: 100 }],
    "7634b9d8-fc15-48e0-9821-b384373a490e"), null);

  // One incumbent is the ordinary case and still works.
  assert.equal(remainderHolder([{ id: "c649f1fc-aaaa", pct: 100 }], "7634b9d8-fc15"), "c649f1fc-aaaa");

  // Nothing serving yet: a first deploy has no remainder to hand out.
  assert.equal(remainderHolder([], "7634b9d8-fc15"), null);
});
