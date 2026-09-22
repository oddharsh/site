// ── the canary soak ─────────────────────────────────────────────────────────
// Shared imports live in contract-shared.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EXIT, verdictFor } from "./soak-canary.ts";

const exec = promisify(execFile);

// A pinned pass, with only the fields verdictFor reads. Defaults describe the
// healthy case, so each test below states the ONE thing it is about.
const pass = (over = {}) => ({
  pinned: { onTarget: 12, offTarget: 0, errors: 0, errorDetail: [], stalls: 0, stallReasons: [], strayVersions: [], answered: 12, total: 12, ...over.pinned },
  allOnTarget: over.allOnTarget ?? false,
  sampleAnswered: over.sampleAnswered ?? 12,
});

// ── what counts as a fault ──────────────────────────────────────────────────
// The whole point of the soak is that it may roll production back without a
// human in the room, so the bar for "faulty" has to be exactly one thing: the
// origin answered badly to a request that was pinned to the code being ramped.

test("an origin error is faulty even when later passes are clean", () => {
  const { verdict, reason } = verdictFor([
    pass(),
    pass({ pinned: { errors: 2, errorDetail: ["a299988d HTTP 500"], onTarget: 10, answered: 12 } }),
    pass(),
  ]);
  assert.equal(verdict, "faulty");
  assert.match(reason, /HTTP 500/, "the verdict must name what it saw, not just that it saw something");
});

test("a total measurement blackout is unproven and never faulty", () => {
  // Gotcha 15's lesson as an assertion. If this ever returns "faulty", a bad
  // afternoon on the runner's egress rolls back healthy releases.
  const dead = pass({ pinned: { onTarget: 0, errors: 0, stalls: 12, answered: 0, stallReasons: ["timed out after 8000ms"] } });
  const { verdict, reason } = verdictFor([dead, dead, dead]);
  assert.equal(verdict, "unproven");
  assert.match(reason, /could not measure/);
});

test("an override that never applies is unproven, and names who answered instead", () => {
  // Cloudflare honours the version override only for a version in the CURRENT
  // deployment, so this is what a canary that has since left it looks like.
  // Measured against production on 2026-09-22: a soak aimed at 3077218d came
  // back 0/12 on target with all twelve answered by 8d900fe1, because a newer
  // ramp had replaced it in the deployment while the soak was being written.
  const stray = pass({ pinned: { onTarget: 0, offTarget: 12, strayVersions: ["8d900fe1"], answered: 12 } });
  const { verdict, reason } = verdictFor([stray, stray]);
  assert.equal(verdict, "unproven");
  assert.match(reason, /8d900fe1/);
  assert.match(reason, /never exercised/);
});

test("one pass that reached the target is enough to call the rest clean", () => {
  const stray = pass({ pinned: { onTarget: 0, offTarget: 12, strayVersions: ["8d900fe1"], answered: 12 } });
  const { verdict } = verdictFor([stray, pass(), stray]);
  assert.equal(verdict, "clean");
});

// ── the fast path ───────────────────────────────────────────────────────────

test("a target holding every sampled request reads as already shipped", () => {
  const { verdict } = verdictFor([pass({ allOnTarget: true, sampleAnswered: 12 })]);
  assert.equal(verdict, "shipped");
});

test("a thin sample cannot claim the release already shipped", () => {
  // One lucky request against a dying network must not read as 100%.
  const { verdict } = verdictFor([pass({ allOnTarget: true, sampleAnswered: 1 })]);
  assert.equal(verdict, "clean");
});

test("no passes at all is unproven", () => {
  assert.equal(verdictFor([]).verdict, "unproven");
});

// ── the exit codes ──────────────────────────────────────────────────────────

test("only a clean soak exits 0", () => {
  assert.equal(EXIT.clean, 0);
  for (const [verdict, code] of Object.entries(EXIT)) {
    if (verdict === "clean") continue;
    assert.notEqual(code, 0, `${verdict} must not look like success to the shell`);
  }
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, "each verdict needs its own code so a workflow can branch on it");
});

// ── gotcha 36, made structural ──────────────────────────────────────────────
// Cloudflare-Workers-Version-Overrides declines to pin on an 8-char prefix and
// says nothing about it. A soak handed a prefix would probe the live split,
// find the incumbent answering 200 twelve times, and report a canary it never
// touched as clean. Two halves hold that shut, and both are asserted: the CLI
// refuses a prefix, and deploy:promote prints the full id for it to be handed.

test("the soak refuses a version id that is not the full uuid", async () => {
  await assert.rejects(
    () => exec(process.execPath, ["tools/soak-canary.ts", "--version", "a299988d", "--worker", "aadhar-sh", "--once"], { cwd: new URL(".", ROOT) }),
    // A JSDoc type, which is live in a .mjs file and inert in a .ts one
    // (gotcha 42). assert.rejects hands the callback `unknown`.
    /** @param {{ stderr?: string }} e */
    (e) => {
      assert.match(String(e.stderr), /FULL version uuid/);
      assert.match(String(e.stderr), /target version id:/, "the refusal must say where to get the right value");
      return true;
    },
  );
});

test("deploy:promote prints the full version id on its own line", async () => {
  const source = await readFile(new URL("tools/deploy-promote.ts", ROOT), "utf8");
  assert.match(source, /console\.log\(`target version id: \$\{target\}`\)/, "soak-canary reads this line");
  // And the prefix line must stay first and stay distinct, because ramp.yml
  // matches `^target version: ` with a literal colon. If the two lines ever
  // collapse into one spelling, the workflow's sed starts capturing whichever
  // it meets first and the failure is silent in both directions.
  assert.match(source, /console\.log\(`target version:   \$\{target\.slice\(0, 8\)\}`\)/);
});

test("the ramp workflow reads the prefix line and the full line separately", async () => {
  const ramp = await readFile(new URL(".github/workflows/ramp.yml", ROOT), "utf8");
  assert.match(ramp, /\^target version: \*/, "the prefix capture must keep its literal colon");
  assert.match(ramp, /\^target version id: \*/, "the soak needs the full id captured too");
});
