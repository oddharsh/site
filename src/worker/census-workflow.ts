// census-workflow.ts: one Workflow instance per census roster host.
//
// WHY THIS FILE EXISTS AT ALL, and why it is its own module. It imports
// `cloudflare:workers`, which gotcha 16 forbids everywhere the node contract
// suite can reach: that suite imports census.ts and lens.ts directly, and node's
// ESM loader rejects the `cloudflare:` scheme at link time. So the class lives
// alone, is imported by nothing except src/worker/index.ts (the one module only
// workerd loads), and the work it performs stays in census.ts where the tests
// can reach it. cal/src/workflow.ts is the same arrangement for the same reason.
//
// WHAT IT BUYS. A census host costs ~32 subrequests (29 of them originDiscovery
// on a cold origin, measured offline against a stubbed fetch) against a ceiling
// of 50 per invocation on Workers Free. The sweep this replaces ran four hosts
// CONCURRENTLY inside one cron invocation, demanded ~512, and hit the ceiling
// inside its first batch. Because every probe in lens.ts swallows its own error
// and returns `{ ok: false }`, the refusal was stored as a score: stripe.com and
// shopify.com went into D1 at 0 with no doors while a single-host scan of the
// same code scores them 20 with one door each.
//
// One host per INSTANCE, not one host per step. The reasoning is at
// cronCensusInner in census.ts; the short form is that Cloudflare's limits page
// is ambiguous about whether a subrequest budget belongs to the instance or the
// step, and an instance per host is correct either way.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { censusScanOne } from "./census.ts";

// WorkflowEntrypoint is generic over its Env and `this.env` is unknown without
// the parameter. The bindings this class reads are the site Worker's, which no
// type declares in one place, so the record is the honest shape. Same call as
// BookingWorkflow's.
export class CensusWorkflow extends WorkflowEntrypoint<Record<string, any>> {
  async run(event, step) {
    const { url, label, ts, ymd } = event.payload;

    // ts and ymd ride the payload rather than being read here, so every host in
    // one sweep lands on a single census day however long its instance queues.
    // A step's return value is persisted and its body must be replayable, which
    // wants the same thing from the other direction: `Date.now()` inside a step
    // would differ across a retry and split one sweep across two days.
    await step.do(
      `scan ${label}`,
      {
        // A cap error is deterministic and a retry cannot fix it, so retries are
        // for the genuinely transient case (a slow origin, a dropped
        // connection). Three attempts over a couple of minutes, then give up and
        // let the instance fail loudly, which is the outcome the old code
        // swallowed. `lensInspect` does not throw on a 403 or a timeout at the
        // target, so a hostile host does not reach this path at all.
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      () => censusScanOne(this.env, { url, label }, ts, ymd),
    );
  }
}
