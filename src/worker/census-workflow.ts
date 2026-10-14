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
// One host per INSTANCE, not one host per step. The reasoning is at
// cronCensusInner in census.ts; the short form is that Cloudflare's limits page
// is ambiguous about whether a subrequest budget belongs to the instance or the
// step, and an instance per host is correct either way.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { censusScanOne } from "./census.ts";

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
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      () => censusScanOne(this.env, { url, label }, ts, ymd),
    );
  }
}
