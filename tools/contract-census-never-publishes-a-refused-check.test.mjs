// ── the census never publishes a check the platform refused ──────────────────
// Split-file suite; shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import {
  configText, ROOT, assert, readFile, test } from "./contract-shared.ts";
import { CENSUS_ROSTER, censusCapHit, censusInstanceId } from "../src/worker/census.ts";

test("censusCapHit finds the platform's refusal wherever a probe buried it", () => {
  const contaminated = {
    readiness: { overall: 0 },
    discovery: {
      robotsTxt: { ok: true, status: 200 },
      llmsTxt: { ok: false, error: "Too many subrequests by single Worker" },
    },
  };
  assert.equal(censusCapHit(contaminated), true, "a cap error under discovery must be found");

  assert.equal(censusCapHit({ discovery: { oauthDiscovery: { openidConfiguration: { ok: false, error: "Too many subrequests" } } } }), true);

  const honest = {
    readiness: { overall: 20 },
    discovery: {
      robotsTxt: { ok: true, status: 200 },
      llmsTxt: { ok: false, status: 404 },
      aiTxt: { ok: false, error: "fetch failed" },
      securityTxt: { ok: false, error: "The operation was aborted due to timeout" },
    },
  };
  assert.equal(censusCapHit(honest), false, "404s, timeouts and network errors are the site's answer, not the platform's");

  assert.equal(censusCapHit(null), false);
  assert.equal(censusCapHit("Too many subrequests"), false, "a bare string is not a probe result");
  assert.equal(censusCapHit({ discovery: { robotsTxt: { ok: true, body: "Too many subrequests" } } }), false,
    "the words appearing in a fetched BODY are the site's content, not our failure");
});

test("censusInstanceId is deterministic, per host per day, and legal", () => {
  const [first] = CENSUS_ROSTER;
  const a = censusInstanceId("2026-08-30", first);
  assert.equal(a, censusInstanceId("2026-08-30", first), "same host, same day, same id");
  assert.notEqual(a, censusInstanceId("2026-09-06", first), "a new census day is a new instance");
  assert.notEqual(a, censusInstanceId("2026-08-30", CENSUS_ROSTER[1]), "two hosts never collide");

  // Workflows cap an instance id at 100 characters and hold it to one pattern.
  // This asserted /^[A-Za-z0-9._-]+$/ until 2026-09-26, a guess that let a dot
  // through, while the binding's own ALLOWED_STRING_ID_PATTERN (miniflare's
  // workflows binding, wrangler pin 3572193) refuses one. Every roster label is
  // a hostname, so every id failed the real check and passed this one.
  // contract-census-duplicate-id-in-workerd asks the binding itself.
  const ids = CENSUS_ROSTER.map((s) => censusInstanceId("2026-08-30", s));
  assert.equal(new Set(ids).size, CENSUS_ROSTER.length, "every roster host gets a distinct id");
  for (const id of ids) {
    assert.ok(id.length <= 100, `${id} is longer than the 100-character ceiling`);
    assert.match(id, /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/, `${id} carries a character an instance id may not`);
  }
});

test("the cron dispatches and never scans in-line", async () => {
  const src = await readFile(new URL("src/worker/census.ts", ROOT), "utf8");
  const body = src.slice(src.indexOf("async function cronCensusInner"));
  const inner = body.slice(0, body.indexOf("\n}\n") + 3);

  assert.match(inner, /CENSUS_WORKFLOW\.create\(/, "the sweep must dispatch Workflow instances");
  assert.doesNotMatch(inner, /lensInspect\(/, "the dispatcher must not scan a host itself");
  assert.doesNotMatch(inner, /Promise\.all/, "a concurrent fan-out here is the bug this replaced");
  assert.match(inner, /no_workflow/, "a missing binding must be reported, never silently worked around");

  assert.doesNotMatch(inner, /batchSize|CENSUS_ROSTER\.slice/, "batching hosts into one invocation is what overspent the budget");
});

test("the Workflow class is exported from the entrypoint and bound in the site config", async () => {
  const index = await readFile(new URL("src/worker/index.ts", ROOT), "utf8");
  assert.match(index, /export \{ CensusWorkflow \} from "\.\/census-workflow\.ts";/,
    "index.ts must re-export CensusWorkflow for the binding's class_name to resolve");

  const { parseJsonc } = await import("./lib/jsonc.ts");
  const config = "cloudflare.config.ts";
  const parsed = parseJsonc(await configText(config));
  const entry = (parsed.workflows ?? []).find((w) => w.binding === "CENSUS_WORKFLOW");
  assert.ok(entry, `${config} must bind CENSUS_WORKFLOW`);
  assert.equal(entry.class_name, "CensusWorkflow", `${config} must name the exported class`);
});

test("only the entrypoint and the workflow module import cloudflare:workers", () => {
  // Gotcha 16, asserted rather than remembered. The node contract suite imports
  // census.ts directly, so the moment the class or its import moves into
  // census.ts this file stops loading at all, which is exactly how a rule
  // stated only in prose gets broken.
  // `-l` on the bare string matches PROSE: lib/trace.ts's header quotes the
  // import in the course of explaining, at length, why it must never perform
  // one. Anchor to a line that actually begins an import statement, which is the
  // same quote-versus-code distinction the CSP and link-integrity scanners had
  // to learn. `-E` for a real regex, and the floor below proves it still matches.
  const out = execFileSync("git", ["grep", "-lE", "^\\s*import .*from \"cloudflare:workers\"", "--", "src/worker"], {
    cwd: new URL(".", ROOT), encoding: "utf8",
  });
  const files = out.split("\n").filter(Boolean).sort();
  assert.ok(files.length >= 2, `the scanner found ${files.length} importers; it is broken`);
  assert.deepEqual(files, ["src/worker/census-workflow.ts", "src/worker/index.ts"],
    "cloudflare:workers may only be imported where workerd is the only loader");
});
