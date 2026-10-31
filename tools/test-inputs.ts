// Which contract test files a change can reach, from the files each one
// actually opened.
//
// `bun test --changed` follows imports, and this suite reads most of what it
// checks with readFileSync: docs, configs, pages, workflows. So `trace` runs
// each test file alone under strace (Linux) and records every repo path it
// opened, stat'ed or listed, and `select` runs a file again only when a changed
// path is one of those, or sits in a directory it listed. The same idea as
// Dagger's function cache, keyed on traced reads instead of declared inputs.
//
// A trace shows the paths this commit's code took. A read behind a branch the
// trace never took is invisible, so main and the nightly run everything.
// Files a trace can't map (it read .git, an untracked file, or failed under
// strace) always run, and so does every file when the map is missing or a
// global input changed.
//
//   bun tools/test-inputs.ts trace --out map.json          Linux, strace on PATH
//   bun tools/test-inputs.ts select --map map.json         files to run, one a line

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

const ROOT = process.cwd();

/** A changed path here can move every test, through how the suite runs rather than what it reads. */
export const GLOBAL = [/^\.github\//, /^bun\.lock$/, /^rust-toolchain\.toml$/, /^tools\/test-inputs\.ts$/];

// Outputs the suite reads but git doesn't hold. A read of one stands for the
// inputs of the step that wrote it, traced as its own entry.
export const PRODUCERS: Record<string, { prefixes: string[]; command: string[] }> = {
  "@build": { prefixes: [".build/"], command: ["bun", "run", "perf-budget"] },
  "@types": { prefixes: ["config/.generated/", "cf-garage/.cloudflare/"], command: ["bun", "tools/gen-runtime-types.ts", "--force"] },
};

export type Entry = { reads: string[]; lists: string[]; uses: string[]; always?: string };
export type InputMap = { commit: string; files: Record<string, Entry> };

export type Access = { path: string; listed: boolean; missing: boolean; exec: boolean };

/** Every path an strace -f -y log touched, with its *at directory resolved. Relative paths resolve against `cwd`. */
export function accesses(log: string, cwd: string): Access[] {
  const out: Access[] = [];
  const pending = new Map<string, Access>();
  for (const line of log.split("\n")) {
    const resumed = /^(\d+)\s+<\.\.\. \w+ resumed>.*= (-1 E\w+|\S+)/.exec(line);
    if (resumed) {
      const access = pending.get(resumed[1]);
      if (access) access.missing = resumed[2].startsWith("-1 ENOENT");
      pending.delete(resumed[1]);
      continue;
    }
    const call = /^(\d+)\s+(\w+)\((.*)$/.exec(line);
    if (!call) continue;
    const [, pid, name, args] = call;
    if (name === "getdents64") {
      const dir = /^\d+<([^>]+)>/.exec(args);
      if (dir) out.push({ path: dir[1], listed: true, missing: false, exec: false });
      continue;
    }
    const quoted = /"((?:[^"\\]|\\.)*)"/.exec(args);
    if (!quoted) continue;
    const raw = quoted[1].replace(/\\(.)/g, "$1");
    const dirfd = /^\d+<([^>]+)>,/.exec(args);
    const path = isAbsolute(raw) ? raw : join(dirfd ? dirfd[1] : cwd, raw);
    const access: Access = { path, listed: false, missing: / = -1 ENOENT/.test(args), exec: name === "execve" };
    out.push(access);
    if (args.endsWith("<unfinished ...>")) pending.set(pid, access);
  }
  return out;
}

/**
 * One test's entry from its accesses. `tracked` holds every path git tracks and
 * every directory above one.
 */
export function entry(found: Access[], tracked: Set<string>, root: string): Entry {
  const reads = new Set<string>(),
    lists = new Set<string>(),
    uses = new Set<string>();
  let always: string | undefined;
  for (const { path, listed, missing, exec } of found) {
    if (exec && path.endsWith("/git")) always ??= "runs git";
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (/(^|\/)node_modules(\/|$)/.test(rel)) continue;
    if (rel === ".git" || rel.startsWith(".git/")) {
      always ??= "reads .git";
      continue;
    }
    const producer = Object.entries(PRODUCERS).find(([, p]) => p.prefixes.some((pre) => rel.startsWith(pre)));
    if (producer) {
      uses.add(producer[0]);
      continue;
    }
    if (listed) lists.add(rel);
    else if (tracked.has(rel) || missing) reads.add(rel);
    else always ??= `reads untracked ${rel}`;
  }
  const result: Entry = { reads: [...reads].sort(), lists: [...lists].sort(), uses: [...uses].sort() };
  if (always) result.always = always;
  return result;
}

export type Selection = { run: string[]; skip: string[]; why: Record<string, string> };

/** The test files `changed` can reach. A test file missing from the map runs. */
export function select(map: InputMap | null, tests: string[], changed: string[]): Selection {
  const why: Record<string, string> = {};
  const all = (reason: string) => ({ run: tests, skip: [], why: Object.fromEntries(tests.map((t) => [t, reason])) });
  if (!map) return all("no input map");
  const global = changed.find((c) => GLOBAL.some((g) => g.test(c)));
  if (global) return all(`${global} changed`);
  const touched = new Set(changed),
    dirs = new Set(changed.map(dirname));
  for (const test of tests) {
    const e = map.files[test];
    if (!e) why[test] = "not in the map";
    else if (e.always) why[test] = e.always;
    else {
      const used = e.uses.map((u) => map.files[u]);
      if (used.some((u) => !u || u.always)) why[test] = `uses ${e.uses.join(", ")}, which can't be mapped`;
      else {
        const reads = [e, ...used].flatMap((x) => x.reads),
          lists = [e, ...used].flatMap((x) => x.lists);
        const hit = reads.find((r) => touched.has(r)) ?? lists.find((l) => dirs.has(l));
        if (hit) why[test] = `reads ${hit}`;
      }
    }
  }
  return { run: tests.filter((t) => why[t]), skip: tests.filter((t) => !why[t]), why };
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const testFiles = () => [...new Bun.Glob("tools/tests/**/*.test.ts").scanSync(ROOT)].sort();

function trackedSet(): Set<string> {
  const set = new Set<string>();
  for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
    set.add(file);
    for (let d = dirname(file); d !== "."; d = dirname(d)) set.add(d);
  }
  return set;
}

function traced(command: string[], dir: string, name: string): Promise<{ code: number; log: string }> {
  const out = join(dir, name.replace(/\W/g, "_"));
  return new Promise((done) => {
    const child = spawn("strace", ["-f", "-qq", "-y", "-s", "4096", "-e", "trace=%file,getdents64", "-o", out, ...command], {
      cwd: ROOT,
      stdio: "ignore",
    });
    child.on("close", (code) => done({ code: code ?? 1, log: existsSync(out) ? readFileSync(out, "utf8") : "" }));
  });
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  if (mode === "trace") {
    const out = arg("--out") ?? "test-inputs.json";
    const dir = mkdtempSync(join(tmpdir(), "test-inputs-"));
    const tracked = trackedSet();
    const files: Record<string, Entry> = {};
    const started = Date.now();
    // The producers first and alone: the build and the generator rewrite what
    // the tests then read.
    for (const [name, { command }] of Object.entries(PRODUCERS)) {
      const { code, log } = await traced(command, dir, name);
      files[name] =
        code === 0 ? entry(accesses(log, ROOT), tracked, ROOT) : { reads: [], lists: [], uses: [], always: `${command.join(" ")} exited ${code} under strace` };
      files[name].uses = files[name].uses.filter((u) => u !== name);
    }
    await pool(testFiles(), Number(arg("--jobs") ?? 4), async (test) => {
      const { code, log } = await traced(["bun", "test", "--preload", "./tools/lib/no-network.ts", "--timeout=60000", test], dir, test);
      files[test] = code === 0 ? entry(accesses(log, ROOT), tracked, ROOT) : { reads: [], lists: [], uses: [], always: `failed under strace (exit ${code})` };
    });
    rmSync(dir, { recursive: true, force: true });
    const map: InputMap = { commit: git("rev-parse", "HEAD").trim(), files };
    writeFileSync(out, JSON.stringify(map));
    const always = Object.entries(files).filter(([, e]) => e.always);
    console.log(`traced ${Object.keys(files).length} entries in ${Math.round((Date.now() - started) / 1000)} s; ${always.length} always run:`);
    for (const [name, e] of always) console.log(`  ${name}: ${e.always}`);
  } else if (mode === "select") {
    const path = arg("--map");
    const map: InputMap | null = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    // Against the commit the map was traced at, so main's later commits count as changes too.
    const changed = map ? git("diff", "--name-only", map.commit, "HEAD").split("\n").filter(Boolean) : [];
    const { run, skip, why } = select(map, testFiles(), changed);
    console.error(`test-inputs: ${changed.length} changed path(s); running ${run.length} of ${run.length + skip.length} test files`);
    if (process.argv.includes("--why")) for (const t of run) console.error(`  ${t}: ${why[t]}`);
    console.log(run.join("\n"));
  } else {
    console.error("usage: bun tools/test-inputs.ts trace --out FILE | select --map FILE [--why]");
    process.exit(2);
  }
}
