// cal/test/preload.ts — what the Worker source needs before it can load on bun.
//
// The suite runs on the HOST: the route handlers, the booking store and the
// email builders execute in bun's process, and only the bindings (KV, the
// Workflow) live in a workerd that wrangler's createTestHarness boots. That is
// what lets a test stub `globalThis.fetch` and watch the worker's own outbound
// calls, the same shape the old in-isolate Vitest suite had, without a Vite
// chain to get there. Two Worker globals are missing on a host, and both are
// supplied here rather than in the source, because the source is correct for
// the runtime it ships to.
//
// 1. `cloudflare:workers`. cal/src/index.ts re-exports BookingWorkflow, whose
//    module imports WorkflowEntrypoint from that scheme, and no host runtime
//    resolves it (gotcha 16: bun fails the FILE that imports it). The class is
//    never instantiated on the host, since the real workflow runs inside the
//    harness's workerd, so an empty base class is the whole shim. This is the
//    one `mock.module` in the repository, and it is a virtual module standing
//    in for a runtime scheme rather than a dependency seam being faked, which
//    is the distinction .oxlintrc.json's no-module-mocking rule draws.
//
// 2. `caches`. cal/src/index.ts edge-caches the booking page for 30s through
//    `caches.default` and deletes the entry on every booking action. Bun has
//    no CacheStorage global at all (`typeof caches` is "undefined", measured
//    2026-09-02 on 1.4.0), so a stand-in that always misses is installed.
//    What that costs is stated rather than hidden: the cache HIT path on GET /
//    is not exercised by this suite. It never was asserted under the pool
//    either, where miniflare's cache was real but no test read the same page
//    twice; the loss is potential coverage, not a regression in what is
//    checked. The DELETE calls sit inside ctx.waitUntil and resolve false.
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {},
}));

const alwaysMiss = {
  match: async () => undefined,
  put: async () => undefined,
  delete: async () => false,
};
(globalThis as { caches?: unknown }).caches = {
  default: alwaysMiss,
  open: async () => alwaysMiss,
};
