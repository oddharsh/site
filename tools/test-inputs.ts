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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ROOT = process.cwd();

/**
 * A changed path here can move every test through how the suite runs rather
 * than what a test reads: the runner, its toolchain pins, and this selector.
 * Other workflow files are ordinary inputs, since the tests that read them are
 * traced reading them. bun.lock is global only when the caller can't say which
 * packages it moved.
 */
export const GLOBAL = [
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
  /^\.github\/install-bun\.sh$/,
  /^config\/bun-pin\.json$/,
  /^\.node-version$/,
  /^rust-toolchain\.toml$/,
  /^tools\/test-inputs\.ts$/,
];

// Outputs the suite reads but git doesn't hold. A read of one stands for the
// inputs of the step that wrote it, traced as its own entry.
export const PRODUCERS: Record<string, { dirs: string[]; command: string[] }> = {
  // The build also writes the wrangler configs it derives from cloudflare.config.ts.
  "@build": { dirs: [".build", ".wrangler.site.jsonc", ".wrangler.site.local.jsonc"], command: ["bun", "run", "perf-budget"] },
  "@types": { dirs: ["config/.generated", "cf-garage/.cloudflare"], command: ["bun", "tools/gen-runtime-types.ts", "--force"] },
};

// State a test writes for itself and reads back: wrangler's local dev state.
const SCRATCH = /(^|\/)\.wrangler(\/|$)/;

// git calls whose answer depends on which files the tree holds, not on history
// or content: a test that runs only these reruns when a file is added, removed
// or renamed. Anything else git does against this repo makes a test always run.
const TREE_ONLY = [/^ls-files\b/, /^rev-parse --(show-toplevel|show-prefix|git-dir|git-path|is-inside-work-tree)\b/, /^check-ignore\b/];

/**
 * `packages`: what it loaded from node_modules, by package name. `tree`: it
 * lists tracked files through git, so an added, removed or renamed file reruns it.
 */
export type Entry = { reads: string[]; lists: string[]; uses: string[]; packages: string[]; tree?: true; always?: string };
export type InputMap = { commit: string; files: Record<string, Entry> };

/** A path a process touched, or (with `git`) a git call and the directory it ran against. */
export type Access = { path: string; listed: boolean; missing: boolean; byGit: boolean; git?: string };

const result = (args: string) => / = (-?\d+)(?:<[^>]*>)?(?: (E[A-Z]+))?(?: \(.*\))?$/.exec(args);

/**
 * Every path an strace -f -y log touched. *at calls resolve against their
 * directory fd, and relative paths against the calling process's working
 * directory, followed through fork and chdir from `cwd`.
 */
export function accesses(log: string, cwd: string): Access[] {
  const out: Access[] = [];
  // A directory per process, shared by the threads that clone with CLONE_FS:
  // libuv's pool threads open what the main thread's chdir pointed at.
  const cwds = new Map<string, { dir: string }>(),
    gits = new Set<string>(),
    pending = new Map<string, (ret: string, errno?: string) => void>();
  const cwdOf = (pid: string) => {
    let box = cwds.get(pid);
    if (!box) cwds.set(pid, (box = { dir: cwd }));
    return box;
  };
  // The child can run, and chdir, before strace prints the parent's clone returning.
  const forked = (parent: string, child: string, sharesFs: boolean) => {
    if (!cwds.has(child)) cwds.set(child, sharesFs ? cwdOf(parent) : { dir: cwdOf(parent).dir });
    if (gits.has(parent)) gits.add(child);
  };
  for (const line of log.split("\n")) {
    const resumed = /^(\d+)\s+<\.\.\. \w+ resumed>(.*)$/.exec(line);
    if (resumed) {
      const done = result(resumed[2]);
      if (done) pending.get(resumed[1])?.(done[1], done[2]);
      pending.delete(resumed[1]);
      continue;
    }
    const call = /^(\d+)\s+(\w+)\((.*)$/.exec(line);
    if (!call) continue;
    const [, pid, name, args] = call;
    // Run now, or when the call resumes: strace -f splits a call another process interrupts.
    const finish = (fn: (ret: string, errno?: string) => void) => {
      if (args.endsWith("<unfinished ...>")) pending.set(pid, fn);
      else {
        const done = result(args);
        if (done) fn(done[1], done[2]);
      }
    };
    if (/^(clone3?|v?fork)$/.test(name)) {
      finish((ret) => Number(ret) > 0 && forked(pid, ret, args.includes("CLONE_FS")));
      continue;
    }
    if (name === "fchdir") {
      const dir = /^\d+<([^>]+)>/.exec(args);
      if (dir) finish((ret) => ret === "0" && (cwdOf(pid).dir = dir[1]));
      continue;
    }
    if (name === "getdents64") {
      const dir = /^\d+<([^>]+)>/.exec(args);
      if (dir) out.push({ path: dir[1], listed: true, missing: false, byGit: gits.has(pid) });
      continue;
    }
    const strings = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
    const [raw] = strings;
    if (raw === undefined) continue;
    const dirfd = /^\d+<([^>]+)>,/.exec(args);
    const path = isAbsolute(raw) ? raw : join(dirfd ? dirfd[1] : cwdOf(pid).dir, raw);
    if (name === "execve" && path.endsWith("/git")) {
      // argv after argv[0]; `-C dir` moves where it runs, `-c k=v` doesn't.
      const argv = strings.slice(2);
      let at = cwdOf(pid).dir;
      while (argv[0]?.startsWith("-")) {
        const flag = argv.shift();
        if (flag === "-C" && argv[0]) at = resolve(at, argv.shift() ?? "");
        else if (flag === "-c") argv.shift();
      }
      finish((ret) => {
        if (ret !== "0") return;
        gits.add(pid);
        out.push({ path: at, listed: false, missing: false, byGit: true, git: argv.join(" ") });
      });
      continue;
    }
    if (name === "chdir") {
      finish((ret) => ret === "0" && (cwdOf(pid).dir = path));
      continue;
    }
    const access: Access = { path, listed: false, missing: false, byGit: gits.has(pid) };
    out.push(access);
    finish((_, errno) => (access.missing = errno === "ENOENT"));
  }
  return out;
}

/** The package a node_modules path belongs to: the name after its last node_modules/. */
export function packageOf(rel: string): string | null {
  const names = [...rel.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/.][^/]*)/g)];
  return names.at(-1)?.[1] ?? null;
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
};

/**
 * One test's entry from its accesses. `tracked` holds every path git tracks and
 * every directory above one. git's own reads are judged by the call, not path
 * by path: what `git ls-files` opens under .git says nothing a test can see.
 */
export function entry(found: Access[], tracked: Set<string>, root: string): Entry {
  const reads = new Set<string>(),
    lists = new Set<string>(),
    uses = new Set<string>(),
    packages = new Set<string>();
  let tree = false;
  let always: string | undefined;
  for (const { path, listed, missing, byGit, git } of found) {
    const rel = within(root, path);
    if (git !== undefined) {
      // A git call against a temp repo of the test's own says nothing about this one.
      if (rel === null) continue;
      if (TREE_ONLY.some((t) => t.test(git))) tree = true;
      else always ??= `runs git ${git.split(" ").slice(0, 2).join(" ")}`;
      continue;
    }
    if (byGit || !rel || rel === ".git" || SCRATCH.test(rel)) continue;
    if (/(^|\/)node_modules(\/|$)/.test(rel)) {
      const name = packageOf(rel);
      if (name) packages.add(name);
      continue;
    }
    if (rel.startsWith(".git/")) {
      always ??= "reads .git";
      continue;
    }
    const producer = Object.entries(PRODUCERS).find(([, p]) => p.dirs.some((d) => rel === d || rel.startsWith(`${d}/`)));
    if (producer) {
      uses.add(producer[0]);
      continue;
    }
    if (listed) lists.add(rel);
    else if (tracked.has(rel) || missing) reads.add(rel);
    else always ??= `reads untracked ${rel}`;
  }
  const result: Entry = { reads: [...reads].sort(), lists: [...lists].sort(), uses: [...uses].sort(), packages: [...packages].sort() };
  if (tree) result.tree = true;
  if (always) result.always = always;
  return result;
}

export type Selection = { run: string[]; skip: string[]; why: Record<string, string> };

/**
 * `paths`: every path the change touches (a rename names both). `filesMoved`:
 * it adds, removes or renames one. `packages`: the packages its bun.lock lines
 * name; without it, a bun.lock change runs everything.
 */
export type Change = { paths: string[]; filesMoved?: boolean; packages?: string[] };

/** Package names on the added and removed lines of a bun.lock diff. */
export function lockPackages(diff: string): string[] {
  const names = new Set<string>();
  for (const [, name] of diff.matchAll(/^[+-]\s+"((?:@[^"/]+\/)?[^"/@][^"]*)":/gm)) names.add(name);
  return [...names].sort();
}

/** The test files a change can reach. A test file missing from the map runs. */
export function select(map: InputMap | null, tests: string[], { paths: changed, filesMoved = false, packages }: Change): Selection {
  const why: Record<string, string> = {};
  const all = (reason: string) => ({ run: tests, skip: [], why: Object.fromEntries(tests.map((t) => [t, reason])) });
  if (!map) return all("no input map");
  const global = changed.find((c) => GLOBAL.some((g) => g.test(c)) || (c === "bun.lock" && !packages));
  if (global) return all(`${global} changed`);
  const moved = new Set(packages ?? []);
  const touched = new Set(changed),
    dirs = new Set(changed.map(dirname));
  for (const test of tests) {
    const e = map.files[test];
    if (!e) why[test] = "not in the map";
    else if (e.always) why[test] = e.always;
    else if (e.tree && filesMoved) why[test] = "lists tracked files, and the change adds or removes one";
    else {
      const used = e.uses.map((u) => map.files[u]);
      if (used.some((u) => !u || u.always)) why[test] = `uses ${e.uses.join(", ")}, which can't be mapped`;
      else {
        const reads = [e, ...used].flatMap((x) => x.reads),
          lists = [e, ...used].flatMap((x) => x.lists);
        const hit = reads.find((r) => touched.has(r)) ?? lists.find((l) => dirs.has(l));
        const pkg = [e, ...used].flatMap((x) => x.packages ?? []).find((name) => moved.has(name));
        if (hit) why[test] = `reads ${hit}`;
        else if (pkg) why[test] = `loads ${pkg}, which the lockfile moved`;
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
    const child = spawn("strace", ["-f", "-qq", "-y", "-s", "4096", "-e", "trace=%file,%process,getdents64", "-o", out, ...command], {
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
        code === 0
          ? entry(accesses(log, ROOT), tracked, ROOT)
          : { reads: [], lists: [], uses: [], packages: [], always: `${command.join(" ")} exited ${code} under strace` };
      files[name].uses = files[name].uses.filter((u) => u !== name);
    }
    await pool(testFiles(), Number(arg("--jobs") ?? 4), async (test) => {
      const { code, log } = await traced(["bun", "test", "--preload", "./tools/lib/no-network.ts", "--timeout=60000", test], dir, test);
      files[test] =
        code === 0 ? entry(accesses(log, ROOT), tracked, ROOT) : { reads: [], lists: [], uses: [], packages: [], always: `failed under strace (exit ${code})` };
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
    const status = map ? git("diff", "--name-status", map.commit, "HEAD").split("\n").filter(Boolean) : [];
    const changed = status.flatMap((line) => line.split("\t").slice(1));
    const packages = map ? lockPackages(git("diff", map.commit, "HEAD", "--", "bun.lock")) : [];
    const { run, skip, why } = select(map, testFiles(), { paths: changed, filesMoved: status.some((line) => /^[ADRC]/.test(line)), packages });
    console.error(`test-inputs: ${changed.length} changed path(s); running ${run.length} of ${run.length + skip.length} test files`);
    if (process.argv.includes("--why")) for (const t of run) console.error(`  ${t}: ${why[t]}`);
    console.log(run.join("\n"));
  } else {
    console.error("usage: bun tools/test-inputs.ts trace --out FILE | select --map FILE [--why]");
    process.exit(2);
  }
}
