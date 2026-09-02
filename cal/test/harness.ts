// cal/test/harness.ts — the bindings half of cal's suite, on wrangler's own
// test harness rather than a second Cloudflare toolchain.
//
// `createTestHarness` boots cal/wrangler.test.toml in a real workerd and hands
// back the environment as MAGIC PROXIES: `env.BOOKINGS` is miniflare's KV and
// `env.BOOKING_WORKFLOW` is the real Workflow binding, both driven from this
// process. The route code itself runs HERE, in bun, imported straight from
// cal/src (preload.ts is what makes that import possible), so a test can stub
// `globalThis.fetch` and read what the worker would have sent to Resend. That
// split, bindings in workerd and code on the host, is what the Vitest pool
// could not offer without running everything inside the isolate, and it is why
// this suite no longer needs vitest, vite, rollup or postcss at all.
//
// Measured under bun 1.4.0 on 2026-09-02 before a line of this was written:
// boot 1.4s, KV put/get/list round-trip, a Workflow created THROUGH THE PROXY
// ran to completion, `introspectWorkflow().modifyAll(mockEvent)` ended it early
// and `introspectWorkflowInstance().modify(forceEventTimeout)` expired a pending
// booking through the real run() body. package.json's node-pinned-scripts note
// records that in-process dispatch works under bun while the harness's
// LISTENING SOCKET does not; nothing here goes over that socket.
//
// The proxies do not use `globalThis.fetch`, measured the same day with the
// network tripwire armed: the run exits 0 with zero recorded escapes.
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import type { ExecutionContext, KVNamespace, Workflow } from "@cloudflare/workers-types";

// MIRRORS cal/wrangler.test.toml AND NOTHING ELSE. Every var is a string,
// which is what a Workers var is. The three secrets the suite needs
// (SIGNING_SECRET, ICAL_URL, RESEND_API_KEY) are deliberately absent from the
// TOML, so a test that needs them passes values explicitly, either through
// `bootCal({ secrets })` or by spreading them over `env`.
export type CalEnv = {
  // [[kv_namespaces]]
  BOOKINGS: KVNamespace;
  // [[workflows]]
  BOOKING_WORKFLOW: Workflow;
  // [vars]
  HOST_TIMEZONE: string;
  WORKING_HOURS_START: string;
  WORKING_HOURS_END: string;
  WORKING_DAYS: string;
  SLOT_MINUTES: string;
  BUFFER_MINUTES: string;
  MIN_NOTICE_HOURS: string;
  MAX_LOOKAHEAD_DAYS: string;
  DAILY_LIMIT: string;
  WEEKLY_LIMIT: string;
  HOST_NAME: string;
  HOST_EMAIL: string;
  HOST_PUBLIC_URL: string;
  EVENT_TITLE: string;
  PENDING_TTL_DAYS: string;
};

const CONFIG = fileURLToPath(new URL("../wrangler.test.toml", import.meta.url));

export async function bootCal(opts: { secrets?: Record<string, string> } = {}) {
  const server = createTestHarness({
    workers: [{ configPath: CONFIG, secrets: opts.secrets }],
  });
  await server.listen();
  const worker = server.getWorker<CalEnv>();
  const env = await worker.getEnv();
  return {
    server,
    worker,
    env,
    close: () => server.close(),
    // Start a test with an empty pool. Storage is shared across the tests in a
    // file, and a stale pending booking from a prior test would hold a slot or
    // trip generateSlots' daily and weekly limits, so an assertion like "the
    // slot frees up again" would see it suppressed for an unrelated reason.
    // The suite never writes more than a page of keys, so one list() is whole.
    clearBookings: async () => {
      const { keys } = await env.BOOKINGS.list();
      await Promise.all(keys.map((k) => env.BOOKINGS.delete(k.name)));
    },
  };
}

// An ExecutionContext for calling `worker.fetch()` directly. The Vitest pool
// supplied createExecutionContext / waitOnExecutionContext; on the host the
// contract is two methods and a list of promises, so it is written out.
const TASKS = Symbol("waitUntil tasks");
type TestContext = ExecutionContext & { [TASKS]: Promise<unknown>[] };

export function createExecutionContext(): TestContext {
  const tasks: Promise<unknown>[] = [];
  // The two methods cal calls, and nothing else. workers-types' ExecutionContext
  // also declares `exports`, `tracing` and `abort`, none of which any route in
  // cal/src reaches for, so they are left off rather than stubbed to satisfy a
  // type: a partial stand-in installed as a whole one, said once here.
  const ctx = {
    [TASKS]: tasks,
    waitUntil(p: Promise<unknown>) { tasks.push(p); },
    passThroughOnException() {},
    props: {},
  };
  return ctx as unknown as TestContext;
}

// Flush everything the handler deferred (the emails, the cache deletes). A
// rejected task rejects here, the same way the pool's helper surfaced it.
export async function waitOnExecutionContext(ctx: TestContext) {
  await Promise.all(ctx[TASKS]);
}

// Replace `globalThis.fetch` for one test and hand back the restore. What it
// puts back is whatever was installed before, which under this suite is the
// network tripwire, so the tripwire stays armed for the next test.
export function stubFetch(impl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  const g = globalThis as { fetch: unknown };
  const previous = g.fetch;
  g.fetch = impl;
  return () => { g.fetch = previous; };
}
