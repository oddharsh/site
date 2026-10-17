// ── the network tripwire ─────────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { escaped } from "./lib/no-network.ts";

// ── the network tripwire ─────────────────────────────────────────────────
// `tools/lib/no-network.ts` is preloaded by both test scripts and fails the
// run if anything reaches the network. These are the assertions that keep it
// armed, because the gate is a flag in package.json and a flag is one careless
// edit from gone.

test("a refused fetch is RECORDED, not merely thrown", async () => {
  // The load-bearing property, and the reason a throw on its own would be a
  // tripwire that cannot fire. Every probe in lens.ts wraps its fetch in a
  // try/catch and degrades, so a refusal is SWALLOWED and the test still
  // passes: measured on the real suite, all 47 files pass with `fetch` set to
  // throw, on this commit and every commit before it. The record is what
  // survives the catch, so this asserts the record rather than the throw.
  //
  // It reads the SAME array the preload writes to, which is the thing worth
  // checking rather than assuming: a second module instance would give this
  // test its own empty array and it would pass while proving nothing.
  const before = escaped.length;
  try {
    let threw = false;
    // Swallowed exactly the way a real probe swallows it.
    try { await fetch("https://example.invalid/tripwire-self-test"); } catch { threw = true; }
    assert.ok(threw, "the tripwire let a request through");
    assert.equal(escaped.length, before + 1, "the refusal was thrown but never recorded");
    assert.match(escaped[escaped.length - 1], /example\.invalid/, "the record must name the URL somebody has to go fix");
  } finally {
    // Truncate to the length this test found, never to zero: a real escape
    // recorded by an earlier test must still fail the run.
    escaped.length = before;
  }
});

test("both test scripts arm it, and neither can drop it quietly", async () => {
  // `validate` runs `bun run test` and `bun run test:node`. A tripwire wired
  // into one of them is a tripwire for half the suite, and the node twin is
  // exactly where this repo has been bitten by a check that existed and never
  // ran (CLAUDE.md's note on test:node not being in CI until it was).
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const MODULE = "tools/lib/no-network.ts";

  // bun takes --preload, node takes --import. Asserting the FLAG and not just
  // the path is the point: the wrong flag for the runner is silently ignored.
  assert.match(pkg.scripts.test, /--preload \.\/tools\/lib\/no-network\.ts/,
    "`test` must preload the tripwire");
  assert.match(pkg.scripts["test:node"], /--import \.\/tools\/lib\/no-network\.ts/,
    "`test:node` must import the tripwire");
  for (const script of ["test", "test:node"]) {
    assert.ok(pkg.scripts[script].includes(MODULE), `${script} no longer arms ${MODULE}`);
  }
});

test("the tripwire offers no way to turn itself off", async () => {
  // Same reasoning infra.json uses for asserting `bypass_actors` EMPTY rather
  // than against a declared list: an allowlist is an invitation to add an entry
  // instead of a stub, and the entry is permanent and silent. Nothing under
  // tools/ has a reason to leave the machine. The checks that genuinely read
  // the wire (infra:check, dcz:check, routes:check:remote) are their own
  // scripts and never run under `bun test`.
  const src = readFileSync("tools/lib/no-network.ts", "utf8");
  assert.ok(!/process\.env/.test(src), "an env-var opt-out is a way to turn a red check green");
  // It must fail the PROCESS, since the harness will happily report a green
  // suite over a swallowed refusal.
  assert.match(src, /process\.exitCode = 1/, "the tripwire must fail the run, not just print");
});
