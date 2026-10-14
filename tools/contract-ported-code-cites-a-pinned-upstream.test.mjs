// ── ported code links its upstream at a tag or a commit, never a branch ──────
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const CODE_ROOTS = ["src/worker", "src/client", "tools", "cal", "serendipity", "lens-reader", "lwe-ask", "cf-garage", "counter", "pipelines", ".github"];
const CODE_EXT = /\.(?:ts|mts|js|mjs|cjs|rs|c|h|sh|patch|ya?ml|toml)$/;

const BRANCHES = new Set(["main", "master", "HEAD", "trunk", "develop", "dev", "next", "canary", "nightly", "gh-pages"]);
const GITHUB_REF = /https?:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+)\/([^/\s"'`)]+)\//g;

const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;

function upstreamRefs(source, { patch = false } = {}) {
  const comments = source.split("\n")
    .map((line) => (patch ? line.replace(/^[+\- ]/, "") : line))
    .filter((line) => COMMENT.test(line))
    .join("\n");
  return [...comments.matchAll(GITHUB_REF)].map((m) => ({ url: m[0], ref: m[1], branch: BRANCHES.has(m[1]) }));
}

function codeFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...CODE_ROOTS], { cwd: new URL(".", ROOT), encoding: "utf8" });
  return out.split("\0").filter((rel) => rel && CODE_EXT.test(rel));
}

test("the ref matcher sees a branch link and passes a tag or sha (control)", () => {
  const [branch] = upstreamRefs("// see https://github.com/python-pillow/Pillow/blob/main/src/libImaging/Convert.c#L42");
  assert.equal(branch.ref, "main");
  assert.equal(branch.branch, true, "a blob/main link must read as a branch");
  const pinned = upstreamRefs([
    "// https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Convert.c#L42",
    "// https://github.com/microsoft/NLWeb/blob/b423f15d9aeaa023ce75993ac9deed2354597043/AskAgent/x.py",
    "// https://raw.githubusercontent.com/0xdiid/buttcrack/c398ef10/src/x.txt",
  ].join("\n"));
  assert.deepEqual(pinned.map((r) => r.branch), [false, false, false]);
  const live = 'const SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";';
  assert.deepEqual(upstreamRefs(live), []);
  assert.equal(upstreamRefs("# " + live).length, 1);
  assert.equal(upstreamRefs("+// https://github.com/a/b/blob/main/c.c", { patch: true })[0].branch, true);
});

test("a GitHub file link in this repository's code names a tag or a commit", () => {
  const files = codeFiles();
  assert.ok(files.length >= 400, `found only ${files.length} code files; the enumerator is broken`);

  const branchLinks = [];
  let pinned = 0;
  for (const rel of files) {
    if (rel.endsWith("contract-ported-code-cites-a-pinned-upstream.test.mjs")) continue;
    for (const r of upstreamRefs(readFileSync(new URL(rel, new URL(".", ROOT)), "utf8"), { patch: rel.endsWith(".patch") })) {
      if (r.branch) branchLinks.push(`${rel}: ${r.url}`);
      else pinned += 1;
    }
  }
  assert.ok(pinned >= 8, `matched only ${pinned} pinned upstream links; the matcher has stopped matching`);
  assert.deepEqual(branchLinks, [],
    "a link to an upstream branch reads whatever that branch holds today, so it stops describing what was ported. Link the tag or the commit you read.");
});
