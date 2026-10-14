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
  const files = readdirSync(dir).filter((f) =>
    (f.endsWith(".ts") || f.endsWith(".mjs")) && !f.endsWith(".test.mjs")
    && !f.endsWith(".d.ts") && f !== "contract-shared.ts");
  assert.ok(files.length >= 20, `expected the tools directory, got ${files.length} files`);

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(dir + f, "utf8");
    for (const m of src.matchAll(/(?:execFile|execFileSync|exec|spawn|spawnSync|run)\(\s*"(pnpm|npm|npx|bunx|yarn|corepack)"/g)) {
      offenders.push(`${f}: spawns "${m[1]}"`);
    }
  }
  assert.deepEqual(offenders, [], `a tool spawns a package manager:\n  ${offenders.join("\n  ")}\n  Use wranglerCommand() from tools/lib/wrangler-bin.ts, which names the runtime instead.`);
});

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

test("the nightly row's gzip figure is wrangler's, never the runtime's zlib", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("tools/perf-snapshot.ts", ROOT).pathname, "utf8");
  const row = src.slice(src.indexOf("const line = {"), src.indexOf("source: \"nightly\""));
  assert.ok(row.length > 100, "the row builder moved; re-anchor this test");
  assert.match(row, /worker_gzip: snap\.worker\.gzipBytes/, "worker_gzip must be the figure the wrangler dry-run printed");
  assert.doesNotMatch(row, /\.gzip\b/, "no row field may read a per-asset gzip, which is the runtime's zlib");
  assert.match(src, /dryOut\.match\(\/gzip:/, "gzipBytes must be read from the dry-run's own line");
});

// With that settled, node is spent only where wrangler needs it. Wrangler
// refuses bun per command (`check startup`, measured 2026-08-20) and its
// createTestHarness under bun boots and then times out every route (167 of 168
// hard failures in 9m23s against 168 passes in 6s under node, measured
// 2026-09-16), so the bridge and the route oracle stay on node; test:node is
// the twin suite and exists to be the other runtime. Everything else runs
// under bun, and this is the list, so a fourth node spawn is a decision.
test("node is spawned only by the wrangler bridge, the route oracle, the twin suite, the harness dispatch tests and the CPU sweep", async () => {
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = new URL(".", ROOT).pathname;
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT).pathname, "utf8"));
  const nodeScripts = Object.entries(pkg.scripts).filter(([, cmd]) => /(^|&& |\| )node /.test(cmd)).map(([k]) => k).sort();
  assert.deepEqual(nodeScripts, ["cpu:sweep", "routes:check", "routes:check:remote", "test:node"]);
  const files = execFileSync("git", ["ls-files", "-z", "*.sh", "**/*.sh", ".github/workflows/*.yml"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const spawns = [];
  for (const rel of files) {
    const code = readFileSync(`${root}${rel}`, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const m of code.matchAll(/(?:^|[ "(;&|])node (?:tools|\.perf|"\$|\S*\.(?:m?js|ts))/gm)) spawns.push(`${rel}: ${m[0].trim()}`);
  }
  assert.deepEqual(spawns, [
    ".github/deploy-wrangler.sh: node \"$",
    ".github/workflows/ci.yml: node tools",
  ], `node spawns outside the allowlist: ${JSON.stringify(spawns)}`);
});

test("the deploy bridge runs the pinned wrangler under node, on either tree", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const script = new URL(".github/deploy-wrangler.sh", ROOT).pathname;
  // The REAL path: macOS tmpdir() is /var/folders, a symlink to /private/var, and
  // the script prints the resolved path, so a symlinked root fails the match.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-")));
  const { symlinkSync } = await import("node:fs");
  const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const stub = join(root, "stub");
  mkdirSync(stub);
  symlinkSync(bash, join(stub, "bash"));
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

  const half = join(root, "half");
  mkdirSync(half);
  assert.throws(() => run(half, ["versions", "upload"]), /Command failed/,
    "a missing wrangler entry means the install did not finish");
  assert.throws(() => run(withEntry(join(root, "noargs"), "bun.lock"), []), /Command failed/,
    "no arguments must exit rather than run a bare wrangler");

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
  const code = script.replace(/^\s*#.*$/gm, "");
  assert.ok(!/versions\s+upload/.test(code),
    "the script takes no opinion on wrangler's arguments outside comments");
  const argvLines = code.split("\n").filter((line) => /^\s*set -- |exec node "\$entry"/.test(line));
  const flags = [...new Set(argvLines.join("\n").match(/--[a-z][a-z-]*/g) ?? [])];
  assert.deepEqual(flags, ["--x-new-config"], "the only wrangler flag the script may add is --x-new-config");
  assert.ok(argvLines.some((line) => /exec node "\$entry" "\$@"\s*$/.test(line)), "the exec line must pass the arguments through unchanged");
  assert.match(code, /if \[ -f cloudflare\.config\.ts \]; then\s+set -- "\$@" --x-new-config\s+fi/,
    "--x-new-config must be added when, and only when, cloudflare.config.ts exists");
});

test("a ramp step hands the remainder to the LARGEST incumbent", () => {
  const active = [
    { id: "863a5873-ecb6-4153-9e5a-afba4e824f38", pct: 10 },
    { id: "c649f1fc-0000-0000-0000-000000000000", pct: 90 },
  ];
  assert.equal(
    remainderHolder(active, "7634b9d8-fc15-48e0-9821-b384373a490e"),
    "c649f1fc-0000-0000-0000-000000000000",
    "the 90% incumbent must hold the remainder, whatever order the API listed",
  );

  assert.equal(
    remainderHolder([...active].reverse(), "7634b9d8-fc15-48e0-9821-b384373a490e"),
    "c649f1fc-0000-0000-0000-000000000000",
  );

  assert.equal(remainderHolder([{ id: "7634b9d8-fc15-48e0-9821-b384373a490e", pct: 100 }],
    "7634b9d8-fc15-48e0-9821-b384373a490e"), null);

  assert.equal(remainderHolder([{ id: "c649f1fc-aaaa", pct: 100 }], "7634b9d8-fc15"), "c649f1fc-aaaa");

  assert.equal(remainderHolder([], "7634b9d8-fc15"), null);
});

test("the ramp's error reporter strips wrangler's ANSI colour codes", () => {
  const ESC = "\u001b";
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

  const halfStripped = stderr.replace(/\[[0-9;]*m/g, "");
  assert.equal([...halfStripped].filter((c) => c === ESC).length, 7);
  assert.ok(halfStripped.includes(`${ESC}[`), "the old pattern re-forms a CSI introducer");

  assert.deepEqual(wranglerErrorLines({ stdout: `${ESC}[1monly stdout${ESC}[0m` }), ["only stdout"]);
  assert.deepEqual(wranglerErrorLines({ message: "spawn ENOENT" }), ["spawn ENOENT"]);
  assert.deepEqual(wranglerErrorLines({}), []);

  const many = { stderr: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") };
  assert.equal(wranglerErrorLines(many).length, 6);
});

test("every program declared null-safe still declares it", async () => {
  const { readdirSync } = await import("node:fs");

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
    "tsconfig.sw.json",
  ].sort();

  const configs = readdirSync(new URL("config/", ROOT).pathname)
    .filter((f) => /^tsconfig\..+\.json$/.test(f) || f === "tsconfig.json");

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
// without deleting its own explanation. Gotcha 42.
test("no .ts file carries a JSDoc type annotation, which TypeScript ignores", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const root = fileURLToPath(new URL("./", ROOT));
  const files = execFileSync("git", ["ls-files", "*.ts"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.endsWith(".d.ts"));

  assert.ok(files.length >= 100, `only ${files.length} .ts files found — the enumeration is broken`);

  const tag = /@(type|param|returns|typedef)\s*\{/;
  const offenders = [];
  for (const rel of files) {
    const lines = (await readFile(new URL(rel, ROOT), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!tag.test(line)) return;
      if (line.trimStart().startsWith("//")) return;
      offenders.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(offenders, [],
    `JSDoc types in .ts files, where they are ignored:\n  ${offenders.join("\n  ")}\n` +
    "Write a real annotation instead. If it is only documentation, drop the {braces} " +
    "so it reads as prose rather than as a type nothing enforces.");
});
