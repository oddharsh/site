// ── repo path tokens match the regex ────────────────────────────────────────
// Build step 7b-paths finds every repository path cited in the staged bytes.
// The rule is REPO_PATH_REGEX; the build runs repoPathTokens(), a hand-written
// scanner about 11x faster, because the regex's leading lookbehind leaves the
// engine no literal to search for. A scanner that drifted from the rule would
// let a stale citation ship, so every case here asks for the regex's exact
// matches, in order.
import { readdirSync, readFileSync } from "node:fs";
import {
  assert,
  ROOT,
  test,
} from "./contract-shared.ts";

const { REPO_DIRS, REPO_PATH_REGEX, repoPathTokens } = await import("./lib/repo-path-tokens.ts");
const oracle = (text) => text.match(REPO_PATH_REGEX) || [];

test("the edge cases of the rule", () => {
  const cases = [
    "see src/worker/index.ts.",
    "tools/build.ts, tools/lib/dcz.ts; and (config/infra.json)",
    "x/src/a.ts",                // a slash before the name: part of a longer path
    ".src/a.ts",                 // a dot before it: a hidden directory elsewhere
    "-src/a.ts _src/a.ts 9src/a.ts", // a word character before it
    "cf-garage/x.ts garage/x.ts", // a listed name containing a hyphen, and its suffix alone
    "lwe-ask/ lwe-ask/a",        // nothing after the slash, then a single character
    "src//a src/./a src/../a",
    "SRC/a.ts Src/a.ts",         // names are lowercase in the rule
    "https://github.com/x/src/main.rs",
    "<code>src/pages/garage/wire.html</code>",
    "src/a.ts/src/b.ts",         // one token: the second name sits after a slash
    "public/i/x.avif\nsrc/b.ts\tdocs/c.md",
    "",
    "/",
    "srcsrc/a.ts",
    "talks/é.md tools/naïve.ts", // the path class is ASCII; it stops at é
  ];
  for (const text of cases) assert.deepEqual(repoPathTokens(text), oracle(text), JSON.stringify(text));
});

test("the repository's own source cites paths exactly as the regex reads them", () => {
  let files = 0, tokens = 0;
  for (const root of ["tools", "src/worker", "src/pages", "docs"]) {
    for (const rel of readdirSync(new URL(`${root}/`, ROOT), { recursive: true, encoding: "utf8" })) {
      if (!/\.(ts|mjs|js|html|md|css|json)$/.test(rel)) continue;
      const text = readFileSync(new URL(`${root}/${rel}`, ROOT), "utf8");
      const want = oracle(text);
      assert.deepEqual(repoPathTokens(text), want, `${root}/${rel}`);
      files++; tokens += want.length;
    }
  }
  // floors, so a corpus that quietly stopped reaching files reads as a failure
  assert.ok(files > 400, `read ${files} files`);
  assert.ok(tokens > 1000, `compared ${tokens} tokens`);
});

test("random text over the characters that matter agrees with the regex", () => {
  // Seeded, so a failure reproduces. Fragments are the names, their near
  // misses, and every character the rule treats specially.
  let seed = 0x5eed;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const parts = [...REPO_DIRS, "garage", "lwe", "srcs", "Src", "/", "/", "/", ".", "-", "_", "a", "Z", "9", " ", "\n", ",", ")", "é", ".ts", "x"];
  for (let i = 0; i < 5000; i++) {
    let text = "";
    for (let j = rand(24); j >= 0; j--) text += parts[rand(parts.length)];
    assert.deepEqual(repoPathTokens(text), oracle(text), JSON.stringify(text));
  }
});
