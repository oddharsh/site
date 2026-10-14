// WHY IT IS HAND-WRITTEN RATHER THAN `wrangler types`. That command works here
// and its binding list is correct, so this is a choice rather than a
// workaround. It writes 15,125 lines, of which ~15,070 re-declare the runtime
// types config/tsconfig.json already loads (through @cloudflare/workers-types
// until 2026-09-02, and since then through the same command's runtime half,
// which tools/gen-runtime-types.ts runs with `--include-env=false` for exactly
// the reason this paragraph gives), and it types COUNTER and BOOKING_WORKFLOW by importing
// `./.build/src/worker/index` — BUILD OUTPUT, which does not exist in a fresh
// checkout, so a committed copy type-checks only after a build and any job
// running typecheck before build reads as broken. It also cannot see tiers 4
// and 5 below, which are the two carrying real optionality and therefore the
// two where a type buys something. `bun run env:check` (tools/check-env.ts)
// diffs this file against cloudflare.config.ts in both directions, per tier, and runs
// inside `bun run typecheck`, so the config stays the authority for tiers 1 to
// 3 and a `?` in tier 4 fails the moment the config gates the deploy on that
// name. (This paragraph described that check for three weeks before it
// existed; it was written on 2026-09-02, with the controls at its header.)

import type { BotRobotsRead } from "./botauth.ts";
import type { PublicTransport } from "./public-fetch.ts";
import type { BookingWorkflow } from "../../../cal/src/workflow.ts";
import type { CensusWorkflow } from "../census-workflow.ts";

export interface EnvBindings {
  RN_KV: KVNamespace;
  BOOKINGS: KVNamespace;
  PHOTOS_R2: R2Bucket;
  RESTORE_DB: D1Database;
  SERENDIPITY_DB: D1Database;
  SOCIAL_DB: D1Database;
  ANALYTICS: AnalyticsSQLBinding;
  BOT_LEDGER: AnalyticsEngineDataset;
  SPECULATION: AnalyticsEngineDataset;
  PERF_PROBE: AnalyticsEngineDataset;
  MISS_LEDGER: AnalyticsEngineDataset;

  LENS_RL_INSPECT: RateLimit;
  LENS_RL_SHOT: RateLimit;
  LENS_RL_COMPARE: RateLimit;
  LENS_RL_BROWSER: RateLimit;
  LENS_RL_BROWSER_ALL: RateLimit;
  LENS_RL_WIRE: RateLimit;
  LENS_RL_TOOLS: RateLimit;
  LENS_RL_NLWEB: RateLimit;
  LENS_RL_MARKDOWN: RateLimit;

  MCP_RL_IMAGE_INSPECT: RateLimit;
  MCP_RL_IMAGE_TRANSFORM: RateLimit;
  MCP_RL_IMAGE_COMPARE: RateLimit;
  MCP_RL_REPR_CAPTURE: RateLimit;
  MCP_RL_REPR_COMPARE: RateLimit;
  WEBMENTION_RL: RateLimit;
  ASK_RL: RateLimit;
  API_RL: RateLimit;

  BROWSER: BrowserRun;
  IMAGES: ImagesBinding;
  AI: Ai;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** The static-assets binding. Hands the Worker DECODED bytes: see gotcha 13. */
  ASSETS: Fetcher;

  COUNTER: DurableObjectNamespace;
  BOOKING_WORKFLOW: Workflow<Parameters<BookingWorkflow["run"]>[0]["payload"]>;
  CENSUS_WORKFLOW: Workflow<Parameters<CensusWorkflow["run"]>[0]["payload"]>;
}

export interface EnvVars {
  CF_ACCOUNT_ID: string;
  AI_GATEWAY: string;
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

export interface EnvOptionalSecrets {
  ANALYTICS_READ_TOKEN?: string;
  BILLING_READ_TOKEN?: string;
  BROWSER_RUN_TOKEN?: string;
  COVER_SECRET?: string;
  EXA_API_KEY?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR?: string;
  X402_NETWORK?: string;
  ENRICH_CRON_BATCH?: string;
}

export interface EnvInjected {
  BOT_ROBOTS_CACHE?: Map<string, Promise<BotRobotsRead>>;
  SELF_FETCH?: ((request: Request) => Promise<Response>) | null;
  OUTBOUND_TRANSPORT?: PublicTransport | null;
  IDENTITY_BODY?: boolean;
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

export interface Env
  extends EnvBindings,
    EnvVars,
    EnvSecrets,
    EnvOptionalSecrets,
    EnvInjected {}
