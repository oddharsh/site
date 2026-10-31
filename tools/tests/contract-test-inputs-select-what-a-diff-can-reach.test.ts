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
  const git = entry(accesses(`103 execve("/usr/bin/git", ["git", "ls-files"], 0x7ffd /* 30 vars */) = 0`, ROOT), TRACKED, ROOT);
  assert.equal(git.always, "runs git");
  const untracked = entry(accesses(`104 openat(AT_FDCWD, "/repo/.wrangler/state.json", O_RDONLY) = 3`, ROOT), TRACKED, ROOT);
  assert.equal(untracked.always, "reads untracked .wrangler/state.json");
});

const MAP: InputMap = {
  commit: "abc",
  files: {
    "tools/tests/docs.test.ts": { reads: ["docs/GOTCHAS.md", "tools/tests/docs.test.ts"], lists: [], uses: [] },
    "tools/tests/pages.test.ts": { reads: ["tools/tests/pages.test.ts"], lists: ["src/pages"], uses: [] },
    "tools/tests/built.test.ts": { reads: ["tools/tests/built.test.ts"], lists: [], uses: ["@build"] },
    "tools/tests/git.test.ts": { reads: [], lists: [], uses: [], always: "runs git" },
    "@build": { reads: ["src/worker/index.ts"], lists: [], uses: [] },
  },
};
const TESTS = ["tools/tests/built.test.ts", "tools/tests/docs.test.ts", "tools/tests/git.test.ts", "tools/tests/new.test.ts", "tools/tests/pages.test.ts"];

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

test("test-inputs: a global input, or no map, runs everything", () => {
  assert.deepEqual(select(MAP, TESTS, [".github/workflows/ci.yml"]).skip, []);
  assert.deepEqual(select(null, TESTS, []).skip, []);
  assert.deepEqual(select(MAP, TESTS, ["README.md"]).skip, ["tools/tests/built.test.ts", "tools/tests/docs.test.ts", "tools/tests/pages.test.ts"]);
});
