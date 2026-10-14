// ── the network tripwire ─────────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { escaped } from "./lib/no-network.ts";

test("a refused fetch is RECORDED, not merely thrown", async () => {
  const before = escaped.length;
  try {
    let threw = false;
    try { await fetch("https://example.invalid/tripwire-self-test"); } catch { threw = true; }
    assert.ok(threw, "the tripwire let a request through");
    assert.equal(escaped.length, before + 1, "the refusal was thrown but never recorded");
    assert.match(escaped[escaped.length - 1], /example\.invalid/, "the record must name the URL somebody has to go fix");
  } finally {
    escaped.length = before;
  }
});

test("both test scripts arm it, and neither can drop it quietly", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const MODULE = "tools/lib/no-network.ts";

  assert.match(pkg.scripts.test, /--preload \.\/tools\/lib\/no-network\.ts/,
    "`test` must preload the tripwire");
  assert.match(pkg.scripts["test:node"], /--import \.\/tools\/lib\/no-network\.ts/,
    "`test:node` must import the tripwire");
  for (const script of ["test", "test:node"]) {
    assert.ok(pkg.scripts[script].includes(MODULE), `${script} no longer arms ${MODULE}`);
  }
});

test("the tripwire offers no way to turn itself off", async () => {
  const src = readFileSync("tools/lib/no-network.ts", "utf8");
  assert.ok(!/process\.env/.test(src), "an env-var opt-out is a way to turn a red check green");
  assert.match(src, /process\.exitCode = 1/, "the tripwire must fail the run, not just print");
});
