// ── test-inputs: a diff selects the test files that opened what it changed ──
import { assert, test } from "./contract-shared.ts";
import { accesses, entry, select, type InputMap } from "../test-inputs.ts";

// tools/test-inputs.ts reads `strace -f -y` logs. These lines are that format,
// trimmed: pid, syscall, args, and the result.

const ROOT = "/repo";
const LOG = [
  `101 openat(AT_FDCWD, "/repo/docs/GOTCHAS.md", O_RDONLY|O_CLOEXEC) = 3</repo/docs/GOTCHAS.md>`,
  `101 newfstatat(AT_FDCWD, "src/pages/new.html", 0x7ffd, 0) = -1 ENOENT (No such file or directory)`,
  `102 openat(7</repo/src/content>, "posts.json", O_RDONLY <unfinished ...>`,
  `101 getdents64(9</repo/src/pages>, 0x55d0 /* 12 entries */, 32768) = 384`,
  `102 <... openat resumed>) = 4</repo/src/content/posts.json>`,
  `101 openat(AT_FDCWD, "/repo/node_modules/wrangler/package.json", O_RDONLY) = 5`,
  `101 openat(AT_FDCWD, "/repo/.build/index.html", O_RDONLY) = 6`,
  `101 openat(AT_FDCWD, "/usr/lib/libc.so.6", O_RDONLY) = 3`,
].join("\n");
const TRACKED = new Set(["docs", "docs/GOTCHAS.md", "src", "src/content", "src/content/posts.json", "src/pages", "src/pages/a.html"]);

test("test-inputs: a trace keeps repo reads, resolves *at directories, and names what it can't map", () => {
  const found = accesses(LOG, ROOT);
  assert.ok(
    found.some((a) => a.path === "/repo/src/content/posts.json" && !a.missing),
    "openat on a directory fd joins the fd's path",
  );
  assert.ok(
    found.some((a) => a.path === "/repo/src/pages/new.html" && a.missing),
    "a relative stat resolves against the cwd",
  );
  assert.deepEqual(entry(found, TRACKED, ROOT), {
    reads: ["docs/GOTCHAS.md", "src/content/posts.json", "src/pages/new.html"],
    lists: ["src/pages"],
    uses: ["@build"],
  });
  const untracked = entry(accesses(`104 openat(AT_FDCWD, "/repo/.cache/state.json", O_RDONLY) = 3`, ROOT), TRACKED, ROOT);
  assert.equal(untracked.always, "reads untracked .cache/state.json");
  assert.deepEqual(
    entry(accesses(`104 openat(AT_FDCWD, "/repo/counter/.wrangler/state/d1.sqlite", O_RDWR) = 3`, ROOT), TRACKED, ROOT).always,
    undefined,
    "wrangler state a test made for itself",
  );
});

const MAP: InputMap = {
  commit: "abc",
  files: {
    "tools/tests/docs.test.ts": { reads: ["docs/GOTCHAS.md", "tools/tests/docs.test.ts"], lists: [], uses: [] },
    "tools/tests/pages.test.ts": { reads: ["tools/tests/pages.test.ts"], lists: ["src/pages"], uses: [] },
    "tools/tests/built.test.ts": { reads: ["tools/tests/built.test.ts"], lists: [], uses: ["@build"] },
    "tools/tests/git.test.ts": { reads: [], lists: [], uses: [], always: "runs git log" },
    "tools/tests/ls.test.ts": { reads: [], lists: [], uses: [], tree: true },
    "@build": { reads: ["src/worker/index.ts"], lists: [], uses: [] },
  },
};
const TESTS = [
  "tools/tests/built.test.ts",
  "tools/tests/docs.test.ts",
  "tools/tests/git.test.ts",
  "tools/tests/ls.test.ts",
  "tools/tests/new.test.ts",
  "tools/tests/pages.test.ts",
];

test("test-inputs: a child keeps its parent's directory until it changes its own", () => {
  const log = [
    `200 clone3({flags=CLONE_VM|CLONE_VFORK, exit_signal=SIGCHLD}, 88 <unfinished ...>`,
    `201 chdir("/tmp/fixture") = 0`,
    `200 <... clone3 resumed>) = 201`,
    `201 openat(AT_FDCWD, "metadata.json", O_RDONLY) = 3</tmp/fixture/metadata.json>`,
    `200 openat(AT_FDCWD, "docs/GOTCHAS.md", O_RDONLY) = 4</repo/docs/GOTCHAS.md>`,
  ].join("\n");
  assert.deepEqual(
    accesses(log, ROOT).map((a) => a.path),
    ["/tmp/fixture/metadata.json", "/repo/docs/GOTCHAS.md"],
  );
  assert.deepEqual(entry(accesses(log, ROOT), TRACKED, ROOT).reads, ["docs/GOTCHAS.md"], "the fixture outside the repo isn't an input");
});

test("test-inputs: git is judged by the call and the repo it ran in", () => {
  const git = (cwd: string, ...argv: string[]) =>
    [
      `300 chdir("${cwd}") = 0`,
      `300 execve("/usr/bin/git", [${["git", ...argv].map((a) => JSON.stringify(a)).join(", ")}], 0x7ffd /* 30 vars */) = 0`,
      `300 openat(AT_FDCWD, "/repo/.git/index", O_RDONLY) = 3`,
    ].join("\n");
  assert.deepEqual(entry(accesses(git("/repo", "ls-files", "-z"), ROOT), TRACKED, ROOT), { reads: [], lists: [], uses: [], tree: true });
  assert.equal(entry(accesses(git("/repo", "log", "--format=%H"), ROOT), TRACKED, ROOT).always, "runs git log --format=%H");
  assert.equal(
    entry(accesses(git("/tmp/scratch", "-c", "user.name=t", "commit", "-qm", "x"), ROOT), TRACKED, ROOT).always,
    undefined,
    "a temp repo of the test's own",
  );
  assert.equal(entry(accesses(git("/tmp/scratch", "-C", "/repo", "log"), ROOT), TRACKED, ROOT).always, "runs git log", "-C moves it back into this repo");
  assert.equal(
    entry(accesses(`301 openat(AT_FDCWD, "/repo/.git/HEAD", O_RDONLY) = 3`, ROOT), TRACKED, ROOT).always,
    "reads .git",
    "a test reading .git itself",
  );
});

test("test-inputs: a file a test reads but never imports selects it, and nothing else that doesn't read it", () => {
  const { run, why } = select(MAP, TESTS, ["docs/GOTCHAS.md"]);
  assert.deepEqual(run, ["tools/tests/docs.test.ts", "tools/tests/git.test.ts", "tools/tests/new.test.ts"]);
  assert.equal(why["tools/tests/docs.test.ts"], "reads docs/GOTCHAS.md");
  assert.equal(why["tools/tests/new.test.ts"], "not in the map");
});

test("test-inputs: a new file in a listed directory, and a source the build read, each select their readers", () => {
  assert.ok(select(MAP, TESTS, ["src/pages/b.html"]).run.includes("tools/tests/pages.test.ts"));
  assert.ok(!select(MAP, TESTS, ["src/pages/deep/b.html"]).run.includes("tools/tests/pages.test.ts"), "only the directory it listed");
  assert.equal(select(MAP, TESTS, ["src/worker/index.ts"]).why["tools/tests/built.test.ts"], "reads src/worker/index.ts");
});

test("test-inputs: a test that lists tracked files reruns when the change adds or removes one", () => {
  assert.ok(select(MAP, TESTS, ["src/new.ts"], true).run.includes("tools/tests/ls.test.ts"));
  assert.ok(!select(MAP, TESTS, ["src/old.ts"], false).run.includes("tools/tests/ls.test.ts"), "an edit in place doesn't");
});

test("test-inputs: a global input, or no map, runs everything", () => {
  assert.deepEqual(select(MAP, TESTS, [".github/workflows/ci.yml"]).skip, []);
  assert.notDeepEqual(select(MAP, TESTS, [".github/workflows/photos.yml"]).skip, [], "another workflow is an ordinary input");
  assert.deepEqual(select(null, TESTS, []).skip, []);
  assert.deepEqual(select(MAP, TESTS, ["README.md"]).skip, [
    "tools/tests/built.test.ts",
    "tools/tests/docs.test.ts",
    "tools/tests/ls.test.ts",
    "tools/tests/pages.test.ts",
  ]);
});
