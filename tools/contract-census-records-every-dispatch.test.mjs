// ── the census sweep leaves a record of itself, and its Workflow exists ─────
// Split-file suite; shared imports live in contract-shared.ts.
//
// THE BUG THIS PINS. /lens/census.json said `lastYmd: "2026-08-23"` for five
// Sundays. #952 removed a dot from the Workflow instance ids and the first
// Sunday after it (2026-09-27) wrote nothing either, because the Workflow the
// sweep dispatches into did not exist in the account:
//
//   $ bun run wrangler:site workflows list --json
//   lens-census-host    created_on 2026-09-28T21:10:36Z  triggered_on null  instances 0
//   cal-booking-expiry  created_on 2026-07-21T15:44:09Z
//
//   first production `wrangler deploy` (1f49a3f0@100)   2026-09-28T21:10:29Z
//
// wrangler registers a Workflow in triggersDeploy(), which `wrangler deploy`
// and `wrangler triggers deploy` call and `versions upload` / `versions deploy`
// do not. CensusWorkflow shipped on 2026-08-28, inside the ramp era, so every
// create() met `workflows.api.error.workflow.not_found`. The dispatcher counted
// that on a span, Workers Logs keep 3 days on Free, and nothing durable said
// anything. Two halves, one test each:
//   1. a sweep whose creates are all refused leaves one D1 row per host naming
//      the refusal, which failed on origin/main (it wrote no record at all);
//   2. the production deploy command stays one that registers Workflows.
// contract-census-duplicate-id-in-workerd runs the same SQL against real D1.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// A namespace import, so the control against origin/main fails on BEHAVIOUR:
// it links, runs, and writes no record.
import * as census from "../src/worker/census.ts";
import { ROOT, assert, test } from "./contract-shared.ts";

// The refusal production gives for a Workflow name the account does not hold,
// read with `wrangler:site workflows describe <missing>` on 2026-09-30. The
// binding's own wording is not observable without a production write, so the
// assertions below care that the text is carried, never what it says.
const NOT_FOUND = "workflows.api.error.workflow.not_found [code: 10200]";

/** A D1 stand-in that keeps what the sweep sent: exec() for the DDL, and
 *  batch() of bound statements for the record. */
function recordingD1() {
  const execs = [], batches = [];
  const prepare = (sql) => ({ sql, args: [], bind(...args) { return { sql, args }; } });
  return {
    execs, batches,
    exec: async (sql) => { execs.push(sql); return { count: 1 }; },
    prepare,
    batch: async (statements) => { batches.push(statements); return statements.map(() => ({ success: true })); },
  };
}

test("a sweep whose every create is refused records each host and the refusal", async () => {
  const db = recordingD1();
  let creates = 0;
  const env = {
    RESTORE_DB: db,
    CENSUS_WORKFLOW: { create: async () => { creates++; throw new Error(NOT_FOUND); } },
  };

  const sweep = await census.cronCensus(env);
  assert.equal(creates, census.CENSUS_ROSTER.length, "the sweep must try every roster host");
  assert.equal(sweep.failed, census.CENSUS_ROSTER.length);
  // THE ASSERTION origin/main FAILS: it sent nothing to D1 but the DDL, so a
  // Sunday like 2026-09-27 left no trace once its logs expired.
  assert.equal(db.batches.length, 1, "the sweep must write its record in one batch");
  assert.ok(db.execs.some((sql) => /CREATE TABLE IF NOT EXISTS lens_census_runs /.test(sql)),
    "the sweep must create its record table before writing to it");
  const [record] = db.batches;
  assert.equal(record.length, census.CENSUS_ROSTER.length, "one record row per roster host");
  const rows = record.map(({ sql, args }) => {
    assert.equal(sql, census.CENSUS_RUN_UPSERT_DISPATCH, "a dispatch row must never overwrite a scan row");
    const [ymd, host, ts, stage, outcome, detail] = args;
    assert.equal(ymd, sweep.ymd);
    assert.equal(typeof ts, "number");
    return { ymd, host, ts, stage, outcome, detail };
  });
  assert.deepEqual(rows.map((r) => r.host), census.CENSUS_ROSTER.map((s) => s.label));
  for (const r of rows) {
    assert.equal(r.stage, "dispatch");
    assert.equal(r.outcome, "dispatch_failed", `${r.host} was recorded as ${r.outcome}`);
    assert.ok(String(r.detail).includes("workflow.not_found"), `${r.host}'s record lost the refusal: ${r.detail}`);
  }

  // And what /lens/census.json would publish from those rows.
  const last = census.summarizeCensusRuns(rows);
  assert.ok(last, "rows in, a summary out");
  assert.equal(last.ymd, sweep.ymd);
  assert.equal(last.written, 0);
  assert.equal(last.recorded, census.CENSUS_ROSTER.length);
  assert.deepEqual(last.unfinished, [], "a refused create is a problem, never an unfinished instance");
  assert.equal(last.problems.length, census.CENSUS_ROSTER.length);
  assert.ok(last.problems.every((p) => p.outcome === "dispatch_failed" && p.detail.includes("workflow.not_found")));
});

test("a record the database refuses costs the record and never the sweep", async () => {
  const db = recordingD1();
  db.batch = async () => { throw new Error("D1_ERROR: no such table"); };
  const sweep = await census.cronCensus({
    RESTORE_DB: db,
    CENSUS_WORKFLOW: { create: async ({ id }) => ({ id }) },
  });
  assert.deepEqual({ created: sweep.created, failed: sweep.failed }, { created: census.CENSUS_ROSTER.length, failed: 0 });
  assert.equal(sweep.ok, true);
});

test("summarizeCensusRuns reads the latest day and names where each host stopped", () => {
  assert.equal(census.summarizeCensusRuns([]), null, "no record is null, never an empty sweep");
  const rows = [
    { ymd: "2026-10-04", host: "b.example", stage: "scan", outcome: "written", detail: null },
    { ymd: "2026-10-04", host: "a.example", stage: "dispatch", outcome: "dispatched", detail: null },
    { ymd: "2026-10-04", host: "c.example", stage: "scan", outcome: "failed", detail: "boom" },
    { ymd: "2026-10-04", host: "d.example", stage: "scan", outcome: "cap", detail: "subrequest cap reached; not published" },
    { ymd: "2026-10-04", host: "e.example", stage: "dispatch", outcome: "duplicate", detail: null },
    { ymd: "2026-09-27", host: "a.example", stage: "dispatch", outcome: "dispatch_failed", detail: NOT_FOUND },
  ];
  const last = census.summarizeCensusRuns(rows);
  assert.ok(last, "rows in, a summary out");
  assert.equal(last.ymd, "2026-10-04", "an older day must not leak into the latest");
  assert.equal(last.recorded, 5);
  assert.equal(last.written, 1);
  assert.deepEqual(last.outcomes, { written: 1, dispatched: 1, failed: 1, cap: 1, duplicate: 1 });
  assert.deepEqual(last.unfinished, ["a.example", "e.example"]);
  assert.deepEqual(last.problems.map((p) => [p.host, p.outcome]), [["c.example", "failed"], ["d.example", "cap"]]);
});

/** Does this wrangler argument list register the Workflows a config exports?
 *  Only the two commands that call triggersDeploy() do. */
function registersWorkflows(args) {
  if (args[0] === "deploy") return true;
  return args[0] === "triggers" && args[1] === "deploy";
}

/** The wrangler arguments a declared Workers Builds command passes, i.e.
 *  everything after the wrapper script. */
function wranglerArgs(command) {
  const words = command.trim().split(/\s+/);
  const at = words.findIndex((w) => w.endsWith("deploy-wrangler.sh"));
  assert.ok(at >= 0, `the command no longer runs through deploy-wrangler.sh: ${command}`);
  return words.slice(at + 1);
}

test("the production deploy command registers the Workflows the site exports", () => {
  const config = readFileSync(new URL("cloudflare.config.ts", ROOT), "utf8");
  const workflows = [...config.matchAll(/exports\.workflow\(\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
  // FLOOR, so a matcher that stops matching cannot turn this into a pass over
  // a site that exports nothing.
  assert.ok(workflows.includes("lens-census-host") && workflows.includes("cal-booking-expiry"),
    `found ${JSON.stringify(workflows)}; the export matcher is broken`);

  const release = JSON.parse(readFileSync(new URL("config/infra.json", ROOT), "utf8")).release;
  const production = wranglerArgs(release.deploy_command);
  assert.ok(registersWorkflows(production),
    `the production command is \`wrangler ${production.join(" ")}\`, which never registers a Workflow. `
    + "A new Workflow class would ship a binding to nothing, the way CensusWorkflow did from 2026-08-28 "
    + "to 2026-09-28. Run `wrangler triggers deploy` once for it, or keep `deploy` as the command.");

  // THE CONTROL: the commands the ramp era released through read false.
  assert.equal(registersWorkflows(wranglerArgs(release.non_production_deploy_command)), false,
    "versions upload registers nothing, so the matcher that calls it registering is broken");
  assert.equal(registersWorkflows(["versions", "deploy", "abc@100"]), false);
});

test("the pinned wrangler still registers Workflows in triggersDeploy", () => {
  // The rule above rests on wrangler's own code, read on the pin that shipped
  // this. If a bump moves registration somewhere else, this fails by name,
  // so the rule moves with the tool.
  const pkg = createRequire(import.meta.url).resolve("wrangler/package.json");
  const cli = readFileSync(join(dirname(pkg), "wrangler-dist", "cli.js"), "utf8");
  const start = cli.indexOf("async function triggersDeploy(");
  assert.ok(start >= 0, "wrangler no longer has a triggersDeploy(); re-read where it registers Workflows");
  const body = cli.slice(start, cli.indexOf("\nasync function ", start + 1));
  assert.match(body, /\/workflows\/\$\{workflow\.name\}`/, "triggersDeploy() no longer PUTs a Workflow");
  assert.match(body, /method: "PUT"/);
});
