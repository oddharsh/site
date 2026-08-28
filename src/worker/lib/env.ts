// env.ts — the site Worker's binding surface as ONE type, checked against
// wrangler.jsonc rather than remembered. Bundled by wrangler at deploy; not
// served. Types only, so the whole module erases and nothing here reaches the
// wire.
//
// WHY THIS EXISTS. Every handler in index.ts took `env: any`, so a typo'd
// binding name was a runtime `undefined` and a deleted binding was nothing at
// all. That is the failure wrangler.jsonc's own `secrets` block was added to
// catch, one layer up: the comment it replaced had drifted in BOTH directions,
// naming two secrets nothing reads and omitting two the Worker genuinely does.
// A comment cannot fail a deploy and neither can `any`.
//
// WHY IT IS HAND-WRITTEN RATHER THAN `wrangler types`. That command works here
// and its binding list is correct, so this is a choice rather than a
// workaround. It writes 15,125 lines, of which ~15,070 re-declare the runtime
// types config/tsconfig.json already loads through `@cloudflare/workers-types`,
// and it types COUNTER and BOOKING_WORKFLOW by importing
// `./.build/src/worker/index` — BUILD OUTPUT, which does not exist in a fresh
// checkout, so a committed copy type-checks only after a build and any job
// running typecheck before build reads as broken. It also cannot see tiers 4
// and 5 below, which are the two carrying real optionality and therefore the
// two where a type buys something. `bun run env:check` diffs this file against
// wrangler.jsonc in both directions, so the generated list stays the authority
// for tiers 1 to 3; it is consulted rather than committed.
//
// THE FIVE TIERS ARE NOT DECORATION: they are the required/optional split, and
// getting it backwards is how strictNullChecks stops meaning anything. Tiers 1
// to 3 are guaranteed present at runtime, because wrangler refuses to publish a
// Worker missing a declared binding or a required secret, so they are
// non-optional and code may read them straight. Tiers 4 and 5 are genuinely
// absent in normal operation, so they are `?` and every read has to face that.
// COVER_SECRET, ANALYTICS_READ_TOKEN and BILLING_READ_TOKEN are the ones to
// look at: wrangler.jsonc argues each is deliberately NOT a required secret
// because the path degrades without it, and the `?` here is that argument in a
// form the compiler enforces.


import type { BookingWorkflow } from "../../../cal/src/workflow.ts";
import type { CensusWorkflow } from "../census-workflow.ts";

// ---------------------------------------------------------------------------
// Tier 1 — platform bindings. Declared in wrangler.jsonc; wrangler will not
// publish a Worker whose code names one it does not carry.
// ---------------------------------------------------------------------------
export interface EnvBindings {
  /** Playlist tracks, cover metadata, /lens response caches, the visit mirror. */
  RN_KV: KVNamespace;
  /** Pending and confirmed coffee bookings, plus the per-slot `held:` keys. */
  BOOKINGS: KVNamespace;
  /** `aadhar-photos`: the SOOC originals, ~3 GB across 158 photos. */
  PHOTOS_R2: R2Bucket;
  /** `aadhar-restore`: the deploy log both /restore and /updates render. */
  RESTORE_DB: D1Database;
  SERENDIPITY_DB: D1Database;
  SOCIAL_DB: D1Database;
  /** Identified crawler hits, priced by /ledger. */
  BOT_LEDGER: AnalyticsEngineDataset;
  SPECULATION: AnalyticsEngineDataset;
  /** The :07/:37 homepage-fragment latency series. */
  PERF_PROBE: AnalyticsEngineDataset;

  // The eight per-IP /lens budgets plus the one account-wide browser bucket.
  // LENS_BUDGETS in lens.ts mirrors these ceilings because that is what the 429
  // message quotes; a contract test pins the two together.
  LENS_RL_INSPECT: RateLimit;
  LENS_RL_SHOT: RateLimit;
  LENS_RL_COMPARE: RateLimit;
  LENS_RL_BROWSER: RateLimit;
  /** Keyed on a CONSTANT, not the caller: every browser route bills one bucket. */
  LENS_RL_BROWSER_ALL: RateLimit;
  LENS_RL_WIRE: RateLimit;
  LENS_RL_TOOLS: RateLimit;
  LENS_RL_NLWEB: RateLimit;
  LENS_RL_MARKDOWN: RateLimit;

  // The five /mcp tools that spend something on a caller's say-so, mirrored in
  // MCP_BUDGETS (mcp.ts), plus the public webmention endpoint's own ceiling.
  MCP_RL_IMAGE_INSPECT: RateLimit;
  MCP_RL_IMAGE_TRANSFORM: RateLimit;
  MCP_RL_IMAGE_COMPARE: RateLimit;
  MCP_RL_REPR_CAPTURE: RateLimit;
  MCP_RL_REPR_COMPARE: RateLimit;
  WEBMENTION_RL: RateLimit;

  BROWSER: BrowserRun;
  IMAGES: ImagesBinding;
  /** Read straight off the binding by /whoareyou.json; the ramp's read-out. */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** The static-assets binding. Hands the Worker DECODED bytes: see gotcha 13. */
  ASSETS: Fetcher;

  /**
   * UNPARAMETERIZED on purpose, where `wrangler types` writes
   * `DurableObjectNamespace<Counter>`. Counter hand-rolls its Durable Object
   * instead of extending the base class, because importing that class means
   * importing `cloudflare:workers`, which the contract suite cannot resolve
   * under plain node. So it carries no `[__DURABLE_OBJECT_BRAND]` and cannot
   * satisfy the parameter: measured, `DurableObjectNamespace<Counter>` is
   * TS2741 here. The cost is that `.get()` hands back an unparameterized stub
   * rather than a typed RPC surface, which is the price of that constraint
   * rather than an oversight. Parameterize this the day Counter can extend
   * DurableObject.
   */
  COUNTER: DurableObjectNamespace;
  BOOKING_WORKFLOW: Workflow<Parameters<BookingWorkflow["run"]>[0]["payload"]>;
  // One instance per census roster host. The payload carries ts and ymd so a
  // whole sweep lands on one census day however long an instance queues.
  CENSUS_WORKFLOW: Workflow<Parameters<CensusWorkflow["run"]>[0]["payload"]>;
}

// ---------------------------------------------------------------------------
// Tier 2 — vars. Plain strings in wrangler.jsonc, so every one arrives as a
// string even where it names a number: SLOT_MINUTES is "30" and the cal module
// parses it. Typing them `string` rather than the literal wrangler generates is
// deliberate, because a literal makes editing a var in wrangler.jsonc a TYPE
// change and fails unrelated code that compares against it.
// ---------------------------------------------------------------------------
export interface EnvVars {
  /** An identifier rather than a secret, and committed as such. */
  CF_ACCOUNT_ID: string;
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
}

// ---------------------------------------------------------------------------
// Tier 3 — required secrets. The names (never the values) are in
// wrangler.jsonc's `secrets.required`, which makes them a DEPLOY GATE: wrangler
// refuses to publish unless each is configured on the Worker. That gate is what
// earns them a non-optional type here. Set one with the versions form, since
// `wrangler secret put` deploys immediately and this repo's newest version is
// normally an unramped upload:
//   bun run wrangler versions secret put -c wrangler.jsonc <NAME>
// ---------------------------------------------------------------------------
export interface EnvSecrets {
  CENSUS_KEY: string;
  ICAL_URL: string;
  RESEND_API_KEY: string;
  RN_BUST_SECRET: string;
  RN_SIGNING_KEY_JWK: string;
  RN_SIGNING_KEY_MLDSA_JWK: string;
  SIGNING_SECRET: string;
  SYNC_SECRET: string;
  WORK_CALENDAR_SLUG: string;
  WORK_CALENDAR_URL: string;
}

// ---------------------------------------------------------------------------
// Tier 4 — DEGRADING secrets. Read by code, deliberately absent from
// `secrets.required`, because each one's path is built to degrade and declaring
// it would fail the deploy over a working site. That is wrangler.jsonc's
// argument; `?` is what makes the compiler hold the code to it. Removing a `?`
// here to quiet an error is the one edit this file exists to prevent, since it
// asserts a credential is present on a path whose whole design is that it may
// not be.
// ---------------------------------------------------------------------------
export interface EnvOptionalSecrets {
  /** /ledger's Analytics Engine SQL. Without it the cost line reads unconfigured. */
  ANALYTICS_READ_TOKEN?: string;
  /** Billing:Read and nothing else. Kept off the CI token on purpose. */
  BILLING_READ_TOKEN?: string;
  /** Browser Rendering EDIT scope, for the Kitesurf REST path in lens-render.ts. */
  BROWSER_RUN_TOKEN?: string;
  /** Serendipity cover images; falls back to SYNC_SECRET. */
  COVER_SECRET?: string;
  /** Serendipity enrichment. Absent means the enrich pass reports itself skipped. */
  EXA_API_KEY?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR?: string;
  X402_NETWORK?: string;
  /** Bounded per-tick enrichment batch. Parsed, so a string; absent takes the default. */
  ENRICH_CRON_BATCH?: string;
}

// ---------------------------------------------------------------------------
// Tier 5 — INJECTED, never configured. These exist only because a caller built
// a derived env and spread one in, so they are absent on a normal request by
// construction and no amount of Cloudflare configuration adds them. They are
// also why this file could not be generated: nothing in wrangler.jsonc knows
// they exist.
// ---------------------------------------------------------------------------
export interface EnvInjected {
  /**
   * In-process dispatch back into this Worker, so a /lens self-scan costs no
   * wire request. index.ts sets it to NULL on the inner env, which is what stops
   * a self-scan recursing forever, so the type has to admit null rather than
   * only absence. Callers read it as
   * `env.SELF_FETCH ? env.SELF_FETCH(req) : env.ASSETS.fetch(req)`.
   */
  SELF_FETCH?: ((request: Request) => Promise<Response>) | null;
  /**
   * Set beside SELF_FETCH. Tells lib/assets.ts to skip the brotli and dictionary
   * lookups and hand back plain bytes, because an in-process caller is going to
   * parse the body rather than ship it.
   */
  IDENTITY_BODY?: boolean;
  /** Set per-request by cal's router so templates can mount under /coffee. */
  BASE_PATH?: string;
}

/**
 * An inbound request, as workerd hands one to a handler.
 *
 * The bare `Request` is NOT this, and the difference is easy to miss because
 * both have a `cf`. On the bare type `cf` is `CfProperties`, which is the set a
 * caller may SET on an OUTBOUND fetch (`cacheTtl`, `resolveOverride`,
 * `polish`), so the inbound telemetry is simply absent from it: typing
 * serveWorkerRequest's parameter as `Request` made
 * `request.cf.botManagement.verifiedBot` an error reading a property off `{}`,
 * which is the compiler being right. Both reads are load-bearing here, since
 * `co` and `bot` are two of the six fields on every worker-owned log line.
 */
export type SiteRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * The site Worker's env. `route()` and every handler take this instead of `any`.
 *
 * Note what is NOT here: COUNTER_SEED, which counter.ts mentions in a comment
 * about how the old cf-garage DO handed its count over, and which no line of
 * code reads. Leaving it out is the point of writing the surface down.
 */
export interface Env
  extends EnvBindings,
    EnvVars,
    EnvSecrets,
    EnvOptionalSecrets,
    EnvInjected {}
