// ── robots.txt patterns match in linear time ────────────────────────────────
// The other origin writes the pattern and the visitor picks the path, so Lens
// can be handed both halves of a bad match. Until 2026-11-19 each `*` compiled
// to `.*`, and "/a*a*a*a*b" against 400 "a"s took 1.1 s under bun. The budget
// below is far above what the glob match takes on 64 KB.
import { assert, test } from "../../../../tools/tests/contract-shared.ts";
import { lensPathMatch } from "../robots.ts";

const BUDGET_MS = 50;
const elapsed = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

// The regex compilePattern built before the glob match replaced it.
function regexMatch(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const pieces = body.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + pieces.join(".*") + (anchored ? "$" : "")).test(path);
}

// mulberry32, seeded so a failure names an input that reproduces.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// No "%": octet normalization runs before either matcher and this change
// leaves it alone. No newline: a URL path can't carry one, and `.` skipped it.
const PATH_TOKENS = ["/", "a", "b", ".", "$", "?", "=", "ab", "/a", ".pdf", "*"];
const PATTERN_TOKENS = [...PATH_TOKENS, "*", "*", "$"];

test("the glob match agrees with the regex it replaced", () => {
  const next = random(0x9309);
  const pick = (tokens: string[], max: number) => {
    let out = "";
    for (let k = Math.floor(next() * max); k > 0; k--) out += tokens[Math.floor(next() * tokens.length)];
    return out;
  };
  for (let n = 0; n < 20000; n++) {
    const pattern = "/" + pick(PATTERN_TOKENS, 8);
    const path = "/" + pick(PATH_TOKENS, 12);
    assert.equal(lensPathMatch(pattern, path), regexMatch(pattern, path), `${JSON.stringify(pattern)} on ${JSON.stringify(path)}`);
  }
  assert.deepEqual(
    [
      lensPathMatch("/*.pdf$", "/doc.pdf"),
      lensPathMatch("/*.pdf$", "/doc.pdf?x"),
      lensPathMatch("/a*b*$", "/a/x/b/y"),
      lensPathMatch("/a$b", "/a$bc"),
      lensPathMatch("/a$", "/ab"),
    ],
    [true, false, true, true, false],
  );
});

test("a pattern of many stars fails fast on a long path", () => {
  for (const [stars, length] of [
    [4, 400],
    [64, 64 * 1024],
  ]) {
    const pattern = "/" + "a*".repeat(stars) + "b";
    const path = "/" + "a".repeat(length);
    let matched = true;
    const ms = elapsed(() => (matched = lensPathMatch(pattern, path)));
    assert.ok(ms < BUDGET_MS, `${stars} stars on ${length} chars took ${ms.toFixed(0)} ms`);
    assert.equal(matched, false);
    assert.equal(lensPathMatch(pattern, path + "b"), true);
  }
});
