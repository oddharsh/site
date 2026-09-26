// ── the census dispatch, against the Workflows binding that enforces ids ─────
// cronCensus creates one CensusWorkflow instance per roster host under a
// deterministic id, so a second sweep on the same day should count every host
// as a `duplicate` rather than as `failed`. That rests on isDuplicateInstance,
// a regex written against an error nobody had seen: until wrangler/miniflare
// 15799d4 (workers-sdk#14847, in this repo's pin since #913) the LOCAL binding
// accepted a repeated id, so the error could not be produced off production.
// It can now, so this file boots a Worker on the pinned workerd through
// wrangler's createTestHarness (the contract-encodebody precedent) and asks.
//
// Recorded 2026-09-26 on the wrangler pin 3572193, from inside the Worker:
//
//   second create, same id:
//     (instance.already_exists) Workflow instance with id "<id>" already exists
//   an id the pattern refuses:
//     Workflow instance has invalid id
//
// Both arrive as a plain Error, name "Error". Through the harness's env PROXY
// the first one reads `WorkflowError: (instance.already_exists) ...` instead,
// which is why the capture happens in the Worker, where cronCensus runs.
//
// THE FIRST RUN OF THIS FOUND THE REAL BUG, and it was not the regex. The
// regex matched. What failed was the id: censusInstanceId kept `.` in its
// allowed set, every roster label is a hostname, and the binding's pattern is
// `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. With the dotted ids the very first create
// below was refused ("Workflow instance has invalid id") before uniqueness was
// ever consulted, and every roster id carries a dot, so a sweep could only
// count sixteen `failed`. The raw row and the sweep rows both hold that shut.
//
// The fixture's Workflow is a no-op bound as CENSUS_WORKFLOW, so no instance
// scans a roster host: the real CensusWorkflow's run() would fetch sixteen
// sites. The fixture imports the real census.ts, so the id, the classifier and
// the dispatch loop are production's. Gotcha 16 holds: `cloudflare:workers` is
// imported by the fixture, which only workerd ever loads.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { CENSUS_ROSTER, isDuplicateInstance } from "../src/worker/census.ts";
import { ROOT, assert, readFileSync, test } from "./contract-shared.ts";

const workerSource = (census) => `
import { WorkflowEntrypoint } from "cloudflare:workers";
import { CENSUS_ROSTER, censusInstanceId, cronCensus, isDuplicateInstance } from ${JSON.stringify(census)};

export class NoopCensus extends WorkflowEntrypoint {
  async run() { return null; }
}

async function attempt(create) {
  try {
    const instance = await create();
    return { threw: false, id: instance.id };
  } catch (error) {
    return {
      threw: true,
      name: error && error.name,
      message: error && error.message,
      duplicate: isDuplicateInstance(error),
    };
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/create-twice") {
      // A date no sweep in this run uses, so the /sweep rows stay exact.
      const id = censusInstanceId("1999-01-01", CENSUS_ROSTER[0]);
      const first = await attempt(() => env.CENSUS_WORKFLOW.create({ id }));
      const second = await attempt(() => env.CENSUS_WORKFLOW.create({ id }));
      const invalid = await attempt(() => env.CENSUS_WORKFLOW.create({ id: "census.not-a-legal-id" }));
      return Response.json({ id, first, second, invalid });
    }
    if (path === "/sweep") return Response.json(await cronCensus(env));
    return new Response("unknown", { status: 404 });
  },
};
`;

/** What the fixture's attempt() reports for one create.
 *  @typedef {{ threw: boolean, id?: string, name?: string, message?: string, duplicate?: boolean }} Attempt */
/** cronCensus's return, as the fixture serialises it.
 *  @typedef {{ ok: boolean, created: number, duplicate: number, failed: number, ymd: string }} Sweep */

test("a same-day census re-run counts every host as a duplicate, measured on the pinned workerd", async () => {
  // Production's flags, for the reason the encodeBody probe gives: a binding
  // measured under different flags is a measurement of a different runtime.
  const site = parseJsonc(readFileSync(new URL("wrangler.jsonc", ROOT), "utf8"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "census-dup-")));
  writeFileSync(join(dir, "worker.js"),
    workerSource(fileURLToPath(new URL("src/worker/census.ts", ROOT))));
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "census-duplicate-probe",
    main: "worker.js",
    compatibility_date: site.compatibility_date,
    compatibility_flags: site.compatibility_flags,
    workflows: [{ name: "census-duplicate-probe", binding: "CENSUS_WORKFLOW", class_name: "NoopCensus" }],
    d1_databases: [{ binding: "RESTORE_DB", database_name: "census-duplicate-probe",
      database_id: "00000000-0000-4000-8000-000000000000" }],
  }));

  const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const call = async (path) => {
      const response = await worker.fetch(`http://census.test${path}`);
      assert.equal(response.status, 200, `${path} answered ${response.status}`);
      return response.json();
    };

    // THE CONTROL, first. The instrument can only see a duplicate if the
    // binding enforces uniqueness at all, so a second create that returns
    // quietly fails here by name rather than letting every row below pass for
    // a binding that never refuses anything.
    const raw = /** @type {{ id: string, first: Attempt, second: Attempt, invalid: Attempt }} */ (
      await call("/create-twice"));
    assert.equal(raw.first.threw, false,
      `the first create of ${raw.id} was refused (${raw.first.message}), so this probe cannot reach a duplicate`);
    assert.equal(raw.second.threw, true,
      "a second create with the same id returned quietly: the local Workflows binding no longer "
    + "enforces id uniqueness (workers-sdk#14847), so nothing below measures anything");

    // The real classifier, on the real error object, inside workerd.
    assert.match(String(raw.second.message), /instance\.already_exists|already exists/,
      `the duplicate error changed shape: ${JSON.stringify(raw.second.message)}`);
    assert.equal(raw.second.duplicate, true,
      `isDuplicateInstance did not recognise the binding's duplicate error: ${JSON.stringify(raw.second.message)}`);

    // And the other refusal the binding makes, which must stay a failure: an
    // invalid id counted as a duplicate would be a sweep that did nothing and
    // reported sixteen harmless skips.
    assert.equal(raw.invalid.threw, true, "the binding accepted an id with a dot in it");
    assert.equal(raw.invalid.duplicate, false,
      `isDuplicateInstance classified an invalid-id refusal as a duplicate: ${JSON.stringify(raw.invalid.message)}`);

    // The dispatch itself, twice, through cronCensus. The first sweep is the row
    // that fails if an id ever turns illegal again, whichever host it is.
    const firstSweep = /** @type {Sweep} */ (await call("/sweep"));
    assert.deepEqual(
      { created: firstSweep.created, duplicate: firstSweep.duplicate, failed: firstSweep.failed },
      { created: CENSUS_ROSTER.length, duplicate: 0, failed: 0 },
      `the first sweep of the day should create one instance per host: ${JSON.stringify(firstSweep)}`);
    const secondSweep = /** @type {Sweep} */ (await call("/sweep"));
    assert.equal(secondSweep.ymd, firstSweep.ymd,
      "the two sweeps straddled midnight UTC, so the second one is not a same-day re-run; run it again");
    assert.deepEqual(
      { created: secondSweep.created, duplicate: secondSweep.duplicate, failed: secondSweep.failed },
      { created: 0, duplicate: CENSUS_ROSTER.length, failed: 0 },
      `a same-day re-run should count every host as a duplicate: ${JSON.stringify(secondSweep)}`);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDuplicateInstance refuses errors that are not a duplicate id", () => {
  // Host-side, for the shapes the Worker above cannot easily produce. The
  // proxy spelling is the harness's own, recorded the same day.
  assert.equal(isDuplicateInstance(new Error(
    "WorkflowError: (instance.already_exists) Workflow instance with id \"x\" already exists")), true);
  assert.equal(isDuplicateInstance(new Error("Workflow instance has invalid id")), false);
  assert.equal(isDuplicateInstance(new Error("Too many subrequests.")), false);
  assert.equal(isDuplicateInstance(new Error("network connection lost")), false);
  assert.equal(isDuplicateInstance(undefined), false);
});
