// ── the TypeScript quarantine ───────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readdir,
  remainderHolder,
  test,
  wranglerErrorLines,
} from "./contract-shared.ts";

// ── the TypeScript quarantine ───────────────────────────────────────────────
// The migration quarantine is empty. Keep the restriction directly in source:
// no Worker module may opt out, and no fixed module count can drift on additions.
test("every Worker module remains free of ts-nocheck", async () => {
  const workerModules = (await readdir(new URL("src/worker", ROOT), { recursive: true }))
    .filter((rel) => rel.endsWith(".ts"));
  assert.ok(workerModules.length > 0, "discover Worker source before checking opt-outs");
  for (const rel of workerModules) {
    const source = await readFile(new URL(`src/worker/${rel}`, ROOT), "utf8");
    assert.doesNotMatch(source, /^\/\/ @ts-nocheck\b/m, `${rel} must not opt out of typechecking`);
  }
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
    (f.endsWith(".ts") || f.endsWith(".mjs")) && !f.endsWith(".test.mjs")
    && !f.endsWith(".d.ts") && f !== "contract-shared.ts");
  assert.ok(files.length >= 20, `expected the tools directory, got ${files.length} files`);

  // There is NO exception list, and there was one until 2026-08-23. It held
  // lens-seed.mjs, recorded as "drives a package script as the subject of the
  // browser recording rather than using a manager to reach another binary".
  // That reason described no code in the file: its only spawn was
  // `execFileSync("pnpm", ["exec", "wrangler", ...])`, which is a manager
  // reaching another binary and is exactly what this test bans. So the one
  // genuine offender was the one file exempted, and the suite reported green
  // while every seed run on a bun tree died on "This project is configured to
  // use bun". An allowlist entry whose stated reason does not match the code it
  // exempts is worse than no test, because it looks like a considered decision.
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(dir + f, "utf8");
    for (const m of src.matchAll(/(?:execFile|execFileSync|exec|spawn|spawnSync|run)\(\s*"(pnpm|npm|npx|bunx|yarn|corepack)"/g)) {
      offenders.push(`${f}: spawns "${m[1]}"`);
    }
  }
  assert.deepEqual(offenders, [], `a tool spawns a package manager:\n  ${offenders.join("\n  ")}\n  Use wranglerCommand() from tools/lib/wrangler-bin.ts, which names the runtime instead.`);
});

// The `bun:check` assertions stood here until 2026-08-24 and went with the tool
// they guarded. Their invariant did NOT retire, so read this as a forwarding
// address rather than a deletion: a comparison whose two halves are the same
// runtime is a green result with no control, which is why check-bun.ts refused
// to be invoked through bun. `bump-bun-pin.ts` inherits the same exposure from
// the other side, since ITS baseline is whatever bun happens to be on PATH, and
// contract-the-bun-pin-is-declared-once.test.mjs asserts the guard that closes
// it (the runtime must equal the pin, or the script refuses to run).

// The helper those tools use has to run wrangler under NODE, name no package
// manager, and resolve the PINNED entry rather than whatever a PATH lookup
// finds. Node is not a leftover: wrangler says "Wrangler does not support the
// Bun runtime" and `check startup` does no work under it, measured 2026-08-20
// on 4.124.0, while `deploy --dry-run` under bun returns a correct number. The
// refusal is per-command, so one working subcommand proves nothing.
test("wranglerCommand runs the pinned wrangler under node", async () => {
  const { wranglerCommand, WRANGLER_ENTRY } = await import("./lib/wrangler-bin.ts");
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
// were pinned to node from 2026-08-20 to 2026-09-16. bun 1.4 ships zlib-ng,
// which gzips one byte-identical 2.8MB input to 898,553 bytes against node's
// 893,610 (0.55% larger), and the fear was that perf-history's nightly series
// would re-read ~1% heavier with no code change. Measured before lifting the
// pin: the series never saw the runtime. A snapshot recorded under node and one
// under bun differ in exactly one field name, `gzip`, across 70 leaves, and the
// nightly ROW built from each is byte-identical, because the row's only gzip
// figure is the Worker bundle's, which wrangler reports and wrangler runs under
// node whoever spawns it. perf-budget's own gzip readings moved by 0.1 KiB on
// two assets against 12 KiB envelopes. So the claim to hold is structural: the
// row must never take a gzip figure from the runtime's zlib.
test("the nightly row's gzip figure is wrangler's, never the runtime's zlib", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("tools/perf-snapshot.ts", ROOT).pathname, "utf8");
  const row = src.slice(src.indexOf("const line = {"), src.indexOf("source: \"nightly\""));
  assert.ok(row.length > 100, "the row builder moved; re-anchor this test");
  assert.match(row, /worker_gzip: snap\.worker\.gzipBytes/, "worker_gzip must be the figure the wrangler dry-run printed");
  assert.doesNotMatch(row, /\.gzip\b/, "no row field may read a per-asset gzip, which is the runtime's zlib");
  // and the figure it does take is parsed off wrangler's output, not computed
  assert.match(src, /dryOut\.match\(\/gzip:/, "gzipBytes must be read from the dry-run's own line");
});

// With that settled, node is spent only where wrangler needs it. Wrangler
// refuses bun per command (`check startup`, measured 2026-08-20) and its
// createTestHarness under bun boots and then times out every route (167 of 168
// hard failures in 9m23s against 168 passes in 6s under node, measured
// 2026-09-16), so the bridge and the route oracle stay on node; test:node is
// the twin suite and exists to be the other runtime. Everything else runs
// under bun, and this is the list, so a fourth node spawn is a decision.
//
// THE FOURTH, taken 2026-09-30: tools/lib/harness-dispatch.ts. Since the wrangler
// pin ddaa558, getWorker().fetch() reaches workerd only through an undici
// Dispatcher that bun's fetch ignores, so the three contract tests that dispatch
// through the harness re-run themselves in a node child when bun collects them.
// It spawns from a module rather than a script, so the scan below cannot see it;
// this paragraph and the module's header are its record.
test("node is spawned only by the wrangler bridge, the route oracle, the twin suite and the harness dispatch tests", async () => {
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = new URL(".", ROOT).pathname;
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT).pathname, "utf8"));
  const nodeScripts = Object.entries(pkg.scripts).filter(([, cmd]) => /(^|&& |\| )node /.test(cmd)).map(([k]) => k).sort();
  assert.deepEqual(nodeScripts, ["routes:check", "routes:check:remote", "test:node"]);
  const files = execFileSync("git", ["ls-files", "-z", "*.sh", "**/*.sh", ".github/workflows/*.yml"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const spawns = [];
  for (const rel of files) {
    const code = readFileSync(`${root}${rel}`, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const m of code.matchAll(/(?:^|[ "(;&|])node (?:tools|\.perf|"\$|\S*\.(?:m?js|ts))/gm)) spawns.push(`${rel}: ${m[0].trim()}`);
  }
  assert.deepEqual(spawns, [
    // the bridge Workers Builds runs, which is the whole reason node is pinned
    ".github/deploy-wrangler.sh: node \"$",
  ], `node spawns outside the allowlist: ${JSON.stringify(spawns)}`);
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
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const script = new URL(".github/deploy-wrangler.sh", ROOT).pathname;
  // The REAL path: macOS tmpdir() is /var/folders, a symlink to /private/var, and
  // the script prints the resolved path, so a symlinked root fails the match.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-")));
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

  // An AUXILIARY Worker: WRANGLER_CWD names its directory. The root's pinned
  // entry runs from there, and --x-new-config follows THAT directory's config.
  const repo = withEntry(join(root, "aux-tree"), "bun.lock");
  mkdirSync(join(repo, "lwe-ask"));
  writeFileSync(join(repo, "lwe-ask/cloudflare.config.ts"), "");
  mkdirSync(join(repo, "counter"));
  const runIn = (dir, args) => execFileSync("bash", [script, ...args], {
    cwd: repo, encoding: "utf8", env: { PATH: stub, HOME: process.env.HOME || root, WRANGLER_CWD: dir },
  });
  assert.match(runIn("lwe-ask", ["deploy"]), new RegExp(`node ran: ${repo}/node_modules/wrangler/bin/wrangler\\.js deploy --x-new-config`),
    "an aux Worker with a TS config runs the root's wrangler with --x-new-config");
  assert.match(runIn("counter", ["deploy"]), new RegExp(`node ran: ${repo}/node_modules/wrangler/bin/wrangler\\.js deploy$`, "m"),
    "an aux Worker without one gets no flag");
  assert.throws(() => runIn("missing", ["deploy"]), /Command failed/, "a WRANGLER_CWD that does not exist must fail");

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
  const code = script.replace(/^\s*#.*$/gm, "");
  assert.ok(!/versions\s+upload/.test(code),
    "the script takes no opinion on wrangler's arguments outside comments");
  // ONE named exception since 2026-09-28: `--x-new-config`, the flag the site's
  // cloudflare.config.ts needs, added here because only an in-repo switch lands
  // atomically with the merge that adds the config. It is pinned rather than
  // allowed: it must be the only flag the script writes, and it must be
  // conditioned on the config FILE, never on which command runs.
  // What can reach wrangler's argv is a `set --` rewrite of the positional
  // arguments or the exec line itself; bun's own flags elsewhere never do.
  const argvLines = code.split("\n").filter((line) => /^\s*set -- |exec node "\$entry"/.test(line));
  const flags = [...new Set(argvLines.join("\n").match(/--[a-z][a-z-]*/g) ?? [])];
  assert.deepEqual(flags, ["--x-new-config"], "the only wrangler flag the script may add is --x-new-config");
  assert.ok(argvLines.some((line) => /exec node "\$entry" "\$@"\s*$/.test(line)), "the exec line must pass the arguments through unchanged");
  assert.match(code, /if \[ -f cloudflare\.config\.ts \]; then\s+set -- "\$@" --x-new-config\s+fi/,
    "--x-new-config must be added when, and only when, cloudflare.config.ts exists");
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

// A ramp reports a wrangler failure by trimming its stderr to the first few real
// lines, which is only readable once the ANSI colour codes come off. Nothing
// exercised that until 2026-08-27, and the gap cost more than coverage usually
// does: the pattern carries its ESC as a RAW 0x1b byte, invisible in any
// rendering of the source, so it reads as though it strips the bracket and
// leaves the escape. That reading was reported as a bug, and the repair it
// implies (an escape in front of the byte already there) matches nothing and
// leaves every colour code in place. This is the two lines that answer it.
test("the ramp's error reporter strips wrangler's ANSI colour codes", () => {
  const ESC = "\u001b";
  // Verbatim from wrangler 4.126.0 stderr: `deploy --dry-run` against a config
  // whose entry point does not exist, captured under FORCE_COLOR=3.
  const stderr = [
    `${ESC}[31m✘ ${ESC}[41;31m[${ESC}[41;97mERROR${ESC}[41;31m]${ESC}[0m ${ESC}[1mThe entry-point file at "does-not-exist.ts" was not found.${ESC}[0m`,
    "",
    "  This might mean that your entry-point file needs to be generated.",
    "",
    '🪵  Logs were written to "/Users/x/.wrangler/logs/wrangler-2026-08-27.log"',
  ].join("\n");

  const lines = wranglerErrorLines({ stderr });

  assert.deepEqual(lines, [
    '✘ [ERROR] The entry-point file at "does-not-exist.ts" was not found.',
    "This might mean that your entry-point file needs to be generated.",
  ]);
  assert.ok(!lines.join("\n").includes(ESC), "no ESC byte may survive into the reported text");

  // The control, because the assertion above would pass on a fixture carrying no
  // escapes at all. Dropping the escape from the pattern leaves one ESC per code
  // and the survivors re-form an `ESC [` introducer, which is the failure the
  // audit described and the shape this fixture is able to detect.
  const halfStripped = stderr.replace(/\[[0-9;]*m/g, "");
  assert.equal([...halfStripped].filter((c) => c === ESC).length, 7);
  assert.ok(halfStripped.includes(`${ESC}[`), "the old pattern re-forms a CSI introducer");

  // stdout is the fallback when a failure says nothing on stderr, then message.
  assert.deepEqual(wranglerErrorLines({ stdout: `${ESC}[1monly stdout${ESC}[0m` }), ["only stdout"]);
  assert.deepEqual(wranglerErrorLines({ message: "spawn ENOENT" }), ["spawn ENOENT"]);
  assert.deepEqual(wranglerErrorLines({}), []);

  // Capped, so one chatty failure cannot bury the ramp's own message under it.
  const many = { stderr: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") };
  assert.equal(wranglerErrorLines(many).length, 6);
});

// ── strictNullChecks is a RATCHET, and it only ever tightens ────────────────
// `strict` is off everywhere and stays off: it bundles noImplicitAny, measured
// at 7,197 diagnostics across this repo against strictNullChecks' 1,544, and the
// two answer different questions. noImplicitAny finds missing annotations on
// code that was written without types. strictNullChecks finds places a null can
// actually arrive, which is the half worth having.
//
// The programs below declare it: most are clean under it outright, and two
// carry a per-file baseline that can only fall. The list may only
// GROW: turning the flag off in one of them, or dropping a program from this
// list while its config still has it, fails here. That is the same mechanism
// the completed Worker migration used for its quarantine, pointed the other
// way — that one could only shrink, this one can only grow.
//
// TEXT-BASED on purpose. Proving a program is clean means RUNNING tsc against
// it, which is what `bun run typecheck` already does on every one of these; a
// second run per program here would put ~8 compilations on a suite that answers
// in about a second. What this asserts is the declaration, and typecheck is what
// makes the declaration true.
test("every program declared null-safe still declares it", async () => {
  const { readdirSync } = await import("node:fs");

  // Some of these are clean under the flag; tsconfig.json, tsconfig.tools.json
  // and tsconfig.browser.json are ratcheted against config/ts-baseline.json by
  // tools/typecheck.ts. Both kinds belong here, because what this asserts is
  // that the flag stays ON, not that a program is clean.
  const DECLARED = [
    "tsconfig.json",
    "tsconfig.cf-garage.json",
    "tsconfig.cf-garage-test.json",
    "tsconfig.cal-test.json",
    "tsconfig.lens-reader.json",
    "tsconfig.lens-reader-test.json",
    "tsconfig.lwe-ask.json",
    "tsconfig.browser.json",
    "tsconfig.tools.json",
    // The last program to join, on 2026-08-27. It had been the only config in
    // config/ without the flag, and its header argues why the service worker
    // needs a separate PROGRAM rather than a laxer one, so the gap read as a
    // decision purely because it sat where a decision goes. 0 diagnostics.
    "tsconfig.sw.json",
  ].sort();

  const configs = readdirSync(new URL("config/", ROOT).pathname)
    .filter((f) => /^tsconfig\..+\.json$/.test(f) || f === "tsconfig.json");

  // A FLOOR on the scan itself, because a test that read no configs would agree
  // with an empty declaration list and report a clean run.
  assert.ok(configs.length >= 8,
    `only ${configs.length} tsconfigs found — this is reading the wrong directory`);

  const strict = [];
  for (const name of configs) {
    const source = await readFile(new URL(`config/${name}`, ROOT), "utf8");
    if (/"strictNullChecks"\s*:\s*true/.test(source)) strict.push(name);
  }

  const missing = DECLARED.filter((name) => !strict.includes(name));
  assert.deepEqual(missing, [],
    `these programs are declared null-safe but no longer set strictNullChecks:\n  ${missing.join("\n  ")}\n` +
    "The flag comes off only by fixing whatever made it fail, never by editing this list down.");

  // The other direction, so a program that gains the flag joins the record
  // rather than sitting outside it: a config can be ahead of this list only by
  // somebody forgetting to add it.
  const undeclared = strict.filter((name) => !DECLARED.includes(name));
  assert.deepEqual(undeclared, [],
    `these programs set strictNullChecks but are not in the declared list: ${undeclared.join(", ")} — add them`);
});

// ── a JSDoc TYPE in a .ts file is inert, and this repo keeps writing them ────
// TypeScript ignores `@type`, `@param {T}`, `@returns {T}` and `@typedef` in a
// .ts file. The annotation still LOOKS like it types something, so it survives
// review, and what it typed silently stops being checked.
//
// It has fired six times during this migration, every time the same way: a
// correct JSDoc fix, and a correct .js -> .ts rename, landing in either order.
// The damage measured on 2026-08-24, when the survivors were finally converted:
//   nlweb.ts        10 → 2 diagnostics   (an inert @returns)
//   ua-survey.ts    21 → 19              (two inert @type)
//   cal/test         0 → 8 → 0           (booking.ts's signatures typed nothing,
//                                         so three tests read through a
//                                         `Booking | null` unchecked)
// and two more had DRIFTED from the real annotation they shadowed, documenting
// a `note` field where the tuple says `what` and a `RouteHandler` where the
// table says `Function`.
//
// PROSE IS NOT AN ANNOTATION, which is why this matches only tags that open a
// comment line. The notes written ABOUT this trap all mention `@type` inside a
// `//` line and must survive; a test that failed on them would be unfixable
// without deleting its own explanation.
test("no .ts file carries a JSDoc type annotation, which TypeScript ignores", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const root = fileURLToPath(new URL("./", ROOT));
  const files = execFileSync("git", ["ls-files", "*.ts"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.endsWith(".d.ts"));

  // A FLOOR, because a test that scanned nothing would agree with any tree.
  assert.ok(files.length >= 100, `only ${files.length} .ts files found — the enumeration is broken`);

  const tag = /@(type|param|returns|typedef)\s*\{/;
  const offenders = [];
  for (const rel of files) {
    const lines = (await readFile(new URL(rel, ROOT), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!tag.test(line)) return;
      if (line.trimStart().startsWith("//")) return;   // prose about this very trap
      offenders.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(offenders, [],
    `JSDoc types in .ts files, where they are ignored:\n  ${offenders.join("\n  ")}\n` +
    "Write a real annotation instead. If it is only documentation, drop the {braces} " +
    "so it reads as prose rather than as a type nothing enforces.");
});
