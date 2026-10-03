// ── Owner secrets compare in constant time, through one gate ─────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { execFileSync } from "node:child_process";

// Ten checks gate owner-only actions on a secret from the request (a cache
// bust, the playlist admin, the census refresh, serendipity's sync triggers).
// Four compared with timingSafeEqual and six with `===`, which stops at the
// first differing character and so leaks the secret's prefix through response
// timing. lib/http.ts's secretMatches is now the one gate: constant time, and
// closed when the binding is unset.

test("secretMatches: equal only when a configured secret matches exactly", async () => {
  const { secretMatches } = await import("../src/worker/lib/http.ts");
  assert.equal(secretMatches("s3cret", "s3cret"), true);
  assert.equal(secretMatches("s3cres", "s3cret"), false, "same length, last character differs");
  assert.equal(secretMatches("s3cre", "s3cret"), false, "a prefix is not the secret");
  assert.equal(secretMatches("s3crett", "s3cret"), false, "nor is an extension");
  // Fails closed: a missing binding must never match a missing parameter. The
  // `===` form this replaced was only safe here because each caller remembered
  // to write `env.X &&` in front of it.
  assert.equal(secretMatches(null, undefined), false);
  assert.equal(secretMatches(undefined, undefined), false);
  assert.equal(secretMatches("", ""), false, "an empty secret is an unset one");
  assert.equal(secretMatches("", undefined), false);
  assert.equal(secretMatches(null, "s3cret"), false);
});

test("serendipity's admin gate reads the header or the query, through secretMatches", async () => {
  const { adminGated } = await import("../serendipity/serendipity.ts");
  const env = { SYNC_SECRET: "k" };
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync?key=k"), env), true);
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync", { headers: { "x-sync-key": "k" } }), env), true);
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync?key=x"), env), false);
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync"), env), false);
  // Control for the fail-closed arm: no binding, no parameter, still refused.
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync"), {}), false);
  assert.equal(adminGated(new Request("https://aadhar.sh/serendipity/sync?key="), { SYNC_SECRET: "" }), false);
});

// A bare equality against a secret-shaped binding. Comparisons with undefined,
// null or "" are presence tests and stay legal.
const BARE = /(?:===|!==)\s*env\.[A-Z_]*(?:SECRET|KEY|TOKEN)\b|\benv\.[A-Z_]*(?:SECRET|KEY|TOKEN)\s*(?:===|!==)\s*(?!\s|undefined\b|null\b|""|'')/;

test("no Worker module compares an owner secret with === or !==", () => {
  // Control first: the scanner flags each of the shapes this change removed,
  // and passes the presence test and the gate itself.
  for (const line of [
    'if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {',
    'if (!env.RN_BUST_SECRET || url.searchParams.get("bust") !== env.RN_BUST_SECRET) return null;',
    "return !!(env && env.SYNC_SECRET && supplied === env.SYNC_SECRET);",
    "if (env.CENSUS_KEY === refresh) {",
  ]) assert.ok(BARE.test(line), `the scanner must flag: ${line}`);
  for (const line of [
    "if (env.CENSUS_KEY === undefined) return;",
    'if (secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET)) {',
  ]) assert.ok(!BARE.test(line), `the scanner must pass: ${line}`);

  const files = execFileSync("git", ["ls-files", "src/worker", "cal/src", "serendipity", "counter/src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(?:ts|js|mjs)$/.test(f));
  assert.ok(files.length > 50, `expected the Worker sources, got ${files.length} files`);
  const hits = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!/^\s*\/\//.test(line) && BARE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], "compare owner secrets with secretMatches (lib/http.ts)");
});
