import { WorkerEntrypoint, tracing } from "cloudflare:workers";
import type { Env, SiteRequest } from "./lib/env.ts";
import type { SpanName } from "./lib/span-vocabulary.ts";
import calWorker from "../../cal/src/index.ts";
import { handleAgentAuthClaim, handleAgentAuthRegister, handleAgentAuthRevoke, handleAgentAuthToken } from "./agent.ts";
import { cronAround, handleAroundChangesJson, handleAroundJson, handleAroundSnapshot, refreshAroundSnapshot, renderAroundPage } from "./around.ts";
import { handleBotPage } from "./bot.ts";
import { cronCensus, handleCensus, handleCensusJson, handleCensusTable, renderCensusPage } from "./census.ts";
import { handleCoffeeAvailability } from "./coffee.ts";
import { handleHit } from "./counter.ts";
import { handlePhotoGrid, serveMarkdown, warmGridData } from "./home.ts";
import { handleInbox, handleInboxMail } from "./inbox.ts";
import { handleWebmention, handleWebmentionDecision } from "./webmention.ts";
import { cronSendWebmentions } from "./webmention-send.ts";
import { handleLedgerJson, handleLedgerLines, renderLedgerPage } from "./ledger.ts";
import { handlePrefetchActivation, handleSpeculationJson } from "./speculation.ts";
import { handleLens, handleLensBrowser, handleLensCompare, handleLensFetch, handleLensShot } from "./lens.ts";
import { handleLensWire } from "./lens-wire.ts";
import { handleLensNlweb } from "./lens-nlweb.ts";
import { handleLensTools } from "./lens-tools.ts";
import { handleLensMarkdown } from "./lens-markdown.ts";
import { serveAssetWith404Clamp, serveFreshAsset, servePrecompressedShell, servePrecompressedText, serveStaticPage } from "./lib/assets.ts";
import { serveBuiltPage } from "./lib/built-page.ts";
import { BOT_UA, handleSignatureDirectory, withBotPolicyCache } from "./lib/botauth.ts";
import { PAGE_CACHE_CONTROL } from "./lib/const.ts";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.ts";
import { wantsMarkdown } from "./lib/http.ts";
import { handleSiteMcp } from "./mcp.ts";
import { SHELL_PRELOAD_LINK } from "./lib/shell-assets.ts";
import { cronJob } from "./lib/cron.ts";
import { installTracing, span } from "./lib/trace.ts";
import { installTracing as installCalTracing } from "../../cal/src/trace.ts";
import { IMAGES_MANIFEST_HEADERS, getThumbHashes, handleAlbum, handleImagesManifest, handlePhotoQuery, handlePhotos, servePhotoFromR2 } from "./photos.ts";
import type { Album } from "./albums.ts";
import { createDispatch, isEdgeCacheable, type RouteHandler } from "./dispatch.ts";
import {
  AROUND_SNAPSHOT_URL, CENSUS_TABLE_URL, DYNO_PULLS_URL, INBOX_MAIL_URL, LEDGER_LINES_URL,
  READING_LIST_URL, WHOAREYOU_VALUES_URL, type ExactPath, type PrefixLabel,
} from "./routes.ts";
import { handleReading, handleReadingList } from "./reading.ts";
import { handleGithubJson } from "./github.ts";
import { cronEnrichReadingHn } from "./reading-hn.ts";
import { handleRun } from "./run.ts";
import { cronEnrichTracks, handleRn, handleRnAdmin, handleRnArt, handleRnMarkdown, handleRnSet, handleRnTracks, handleRnTracksHtml } from "./rn.ts";
import { cronHomeProbe } from "./perf-probe.ts";
import { handleDynoJson, handleDynoPulls, renderDynoPage } from "./dyno.ts";
import { handleAsk } from "./nlweb.ts";
import { handleSearch, handleSearchJson } from "./search.ts";
import { handleSecurityJson, renderSecurityCenter } from "./security.ts";
import { handleTool } from "./terminal.ts";
import { handleSystemRestore, handleUpdatesJson, handleWindowsUpdate } from "./updates.ts";
import { handleWhoareyouJson, handleWhoareyouValues, renderWhoareyouPage } from "./whoareyou.ts";
import { handleWritingIndex, handleWritingPost } from "./writing.ts";
import { handleLlmsFull } from "./x402.ts";
import { cronSerendipity, handleSerendipity, MCP_INFO_PATH as SERENDIPITY_MCP_INFO, SERENDIPITY_SECURITY_HEADERS, serendipityCsp, withSerendipitySecurityHeaders } from "../../serendipity/serendipity.ts";
import { scriptHashesFor } from "./lib/csp-hashes.ts";

// Hand the runtime's tracer to both span helpers. THIS is the only module that
// may import it: the rest of the worker is also imported by contract-tests.mjs
// under plain node, which cannot resolve the `cloudflare:` scheme (see
// lib/trace.js's header). Module-scope, so it completes at isolate init before
// any handler runs; without it every span is a harmless direct call, which is
// exactly the behavior the tests and `wrangler dev` get.
installTracing(tracing);
installCalTracing(tracing);


// the coffee-booking expiry timer (Workflows). One durable instance per pending
// booking replaces the old weekly cron sweep; its class_name must resolve on
// this entry so the BOOKING_WORKFLOW binding can find it (see cal/src/workflow.ts).
export { BookingWorkflow } from "../../cal/src/workflow.ts";
// One instance per census roster host; see census-workflow.ts for why the class
// sits in its own module and why the unit is an instance rather than a step.
export { CensusWorkflow } from "./census-workflow.ts";

// The named entrypoint is the only one configured to consult Workers Cache in
// production. A cache hit returns before this method runs; a miss gets the
// exact same dispatcher, security headers, and observability as the gateway.
export class CachedPages extends WorkerEntrypoint<Env> {
  async fetch(request) {
    return serveWorkerRequest(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (isEdgeCacheable(request) && ctx.exports?.CachedPages) {
      return ctx.exports.CachedPages.fetch(request);
    }
    return serveWorkerRequest(request, env, ctx);
  },

  // cron (cloudflare.config.ts "triggers"): the /around crawl runs on the frequent
  // schedule so the request path stays a pure KV read and the page is safe to
  // prerender. The weekly schedule sweeps the /lens/census roster into D1.
  async scheduled(event, env, ctx) {
    env = withBotPolicyCache(env);
    // Each arm runs inside a named span. This is the single highest-value place
    // to trace in the whole worker, because a cron has NO response: there is no
    // Server-Timing header to read, no status code, no visitor to complain. Every
    // one of these jobs is also written to swallow its own failures on purpose
    // (a crawl that cannot reach a neighbor skips it and retries next tick), so
    // until now a job that had been silently degrading for weeks looked exactly
    // like a job that was fine. The span is the difference.
    //
    // The job is AWAITED, not just waitUntil'd: a scheduled event's generous
    // budget applies to work the handler is still awaiting, while a handler
    // that returns immediately leaves its waitUntil tail at the runtime's
    // post-return grace — which is what cut the census sweep off at its first
    // batch on the owner-refresh path. waitUntil still receives the promise
    // too, so failure semantics are unchanged.
    // The name is the CRON SLICE of SpanName rather than a type parameter, and
    // both halves of that are load-bearing. Left with implicit-any parameters
    // this helper erased the inference it wraps: the callback's return widened
    // to `unknown` and the `.catch()` three of these calls rely on became an
    // error on `unknown`. Made generic instead, `SpanSurface<N>` stays deferred
    // and the compiler cannot prove `cron.schedule` belongs, so even the
    // correct attribute fails. A closed union resolves the surface to `cron`
    // and says the true thing about this helper: it opens cron spans only.
    const cron = (name: Extract<SpanName, `cron.${string}`>, work: () => Promise<unknown>) => {
      const p = span(name, work, { "cron.schedule": event.cron });
      ctx.waitUntil(p);
      return p;
    };
    // Dispatch via cronJob() (lib/cron.js): minute+hour signatures, immune to
    // Cloudflare's cron-expression normalization ("* * 1" can come back
    // "* * MON", and the old exact match sent three straight weekly censuses
    // into the else-branch). Unknown expressions get their own traced event
    // instead of silently running somebody else's job.
    const job = cronJob(event.cron);
    if (job === "home_probe") {
      await cron("cron.home_probe", () => cronHomeProbe(env, ctx));   // :07/:37 — the two homepage fragments' KV latency -> Analytics Engine
      // Same tick, because Workers Free caps an account at five triggers and
      // this needs no schedule of its own: it fills a bounded batch of album
      // covers per run and converges in a few ticks (rn.js cronEnrichTracks).
      // Caught, so a Spotify wobble cannot cost the probe its measurement, and
      // ordered second for the same reason.
      await cron("cron.rn_enrich", () => cronEnrichTracks(env, ctx)).catch(() => {});
      // Third on the same tick, for the same reason: /reading's Hacker News
      // threads, a bounded batch per run (reading-hn.ts has the subrequest sum
      // all three jobs share). Last, so an Algolia wobble costs neither of the
      // other two.
      await cron("cron.reading_hn", () => cronEnrichReadingHn(env)).catch(() => {});
    } else if (job === "census") {
      // SUNDAYS 08:17 UTC. Cloudflare numbers weekdays Quartz-style, 1 = Sunday
      // through 7 = Saturday, where most cron systems use 0 = Sunday, so the `1`
      // in "17 8 * * 1" schedules Sunday. Nine comments across three files read
      // Monday for six weeks while production fired on Sunday, and nothing could
      // catch it because cronJob() matches minute+hour and is right either way.
      // The pairing is pinned in contract-the-perf-probe now. Prefer the
      // three-letter form in anything new.
      await cron("cron.census", () => cronCensus(env));   // the longitudinal census, full roster in one awaited pass
    } else if (job === "daily_outbound") {
      // 05:41 UTC daily — the two jobs that probe somebody else's server.
      // Sequential, not Promise.all: both fetch third-party hosts and running
      // them together doubles the burst this site presents at one instant, which
      // is the opposite of why they share an off-peak daily tick.
      //
      // Each is awaited inside its own span, so one failing still lets the other
      // run and the trace says which. That matters more here than elsewhere,
      // because a cron has no response and both jobs are designed to be quiet.
      // Both are caught so a failure in one cannot skip the other. span() does
      // not swallow, so enterSpan has already recorded the exception by the time
      // the catch runs; what is dropped here is only the rethrow.
      // withSelfFetch, not the bare env: this job reads this site's OWN pages, and
      // a plain fetch() to our own hostname from inside the worker is blocked as
      // recursion (error 1042 — perf-probe.js documents the same limit). It failed
      // by returning "", so every page was skipped and the run wrote nothing at
      // all. Measured 2026-08-28: both webmention tables empty since the feature
      // shipped, while /around on this same tick had run that morning.
      await cron("cron.webmention_send", () => cronSendWebmentions(withSelfFetch(env, ctx))).catch(() => {});
      await cron("cron.around", () => cronAround(env)).catch(() => {});
    } else if (job === "serendipity") {
      // 00/06/12/18:23 UTC — re-sync every enabled Luma feed into the
      // serendipity pool (serendipity.js cronSerendipity): events, then the
      // next few guest lists plus a bounded historical-roster backfill, then
      // descriptions. Four times daily
      // keeps the pool honest AND the stored Luma session warm; without this
      // tick the pool only refreshed on a cookie re-paste. Odd minute, same
      // collision-avoidance as the others.
      await cron("cron.serendipity", () => cronSerendipity(env));
    } else {
      await cron("cron.unmatched", async () => ({ ok: false, cron: event.cron }));
    }
    // NOTE: the weekly coffee-booking sweep (0 4 * * 7) is gone — each pending
    // booking now carries its own BookingWorkflow expiry timer (cal/src/workflow.ts).
  },
};

// The handler for each exact route, keyed by its id in routes.ts. The ROUTE
// LIST is data and lives there, where cloudflare.config.ts, build.ts and the
// contract suite can read it; this module cannot be loaded outside workerd
// (gotcha 16), so it binds handlers and nothing else. `Record<ExactPath, …>`
// is what makes that safe: a route with no handler is a missing key and a
// handler with no route is an excess one, and both are compile errors.
//
// The annotation is also what checks each handler's signature. Inferred, an
// object of handlers would take whatever each function happens to be, and a
// handler returning something that is not a Response would pass silently.
const EXACT_HANDLERS: Record<ExactPath, RouteHandler> = {
  "/favicon.ico": routeFavicon,

  "/auth.md": routeAuthMd,
  "/.well-known/api-catalog": routeApiCatalog,
  "/.well-known/agent-card.json": routeAgentCard,
  "/.well-known/oauth-protected-resource": routeOAuthProtectedResource,
  "/.well-known/oauth-authorization-server": routeOAuthAuthorizationServer,
  "/.well-known/http-message-signatures-directory": handleSignatureDirectory,
  "/agent/auth": handleAgentAuthRegister,
  "/agent/auth/claim": handleAgentAuthClaim,
  "/oauth2/token": handleAgentAuthToken,
  "/oauth2/revoke": handleAgentAuthRevoke,

  "/hit": handleHit,

  "/whoareyou": routeWhoareyou,
  "/whoareyou.json": handleWhoareyouJson,
  [WHOAREYOU_VALUES_URL]: handleWhoareyouValues,
  "/security": routeSecurity,
  "/security.json": handleSecurityJson,
  "/reading": handleReading,
  [READING_LIST_URL]: handleReadingList,
  "/github.json": handleGithubJson,
  "/updates": routeUpdates,
  "/updates.json": handleUpdatesJson,
  "/restore": routeRestore,
  "/garage/dyno": routeDyno,
  [DYNO_PULLS_URL]: handleDynoPulls,
  "/garage/dyno.json": handleDynoJson,
  // /perf shipped as the original name and lived for about an hour. The 301s are
  // not for humans: `agents: true` puts a surface in the MCP resources projection,
  // and _headers caches the well-known cards for 30 days, so an agent can hold the
  // old path long after a deploy could purge it. Same argument as the /images ->
  // /i/ redirects, on a shorter clock.
  "/perf": (request) => Response.redirect(new URL("/garage/dyno", request.url).href, 301),
  "/perf.json": (request) => Response.redirect(new URL("/garage/dyno.json", request.url).href, 301),

  "/lens": routeLens,
  "/lens/": routeDropSlash,
  "/lens/fetch": handleLensFetch,
  "/lens/shot": handleLensShot,
  "/lens/browser": handleLensBrowser,
  "/lens/wire": handleLensWire,
  "/lens/tools": handleLensTools,
  "/lens/nlweb": handleLensNlweb,
  "/lens/markdown": handleLensMarkdown,
  "/lens/compare.json": handleLensCompare,
  "/lens/census": routeCensus,
  [CENSUS_TABLE_URL]: handleCensusTable,
  "/lens/census.json": handleCensusJson,

  "/mcp": handleSiteMcp,

  // ── the tools ──────────────────────────────────────────────────────────
  // Top-level, because that is where this site puts utilities: /lens, /photos,
  // /coffee and /reading all live here, while every content page nests. Each
  // tool answers HTML to a browser and a frame to everything else, with an
  // explicit .txt representation alongside — the same contract as the .md twins.
  //
  // /terminal, the console page that showed one /mcp exchange, retired on
  // 2026-09-16. It rendered per request (no twin, no delta, edge-compressed at
  // about q4) to show bytes that came out identical every time, and the exchange
  // it demonstrated reads better from /mcp itself. A 410 rather than a redirect,
  // because no surviving page is the same thing; the body says where to go. One
  // `/terminal*` run_worker_first row covers the bare path and everything under it.
  "/terminal": routeTerminalGone,
  "/terminal/": routeTerminalGone,

  "/finger": handleTool, "/finger.txt": handleTool,
  "/radar": handleTool,  "/radar.txt": handleTool,
  "/dict": handleTool,   "/dict.txt": handleTool,
  "/cache": handleTool,  "/cache.txt": handleTool,
  "/agent-ready": handleTool, "/agent-ready.txt": handleTool,
  "/encode": handleTool, "/encode.txt": handleTool,
  // /photos and /lens already own their HTML pages, so they gain only the frame
  // representation rather than a second competing route.
  "/photos.txt": handleTool,
  "/lens.txt": handleTool,

  "/search": routeSearch,
  "/search.json": handleSearchJson,

  // /ask — NLWeb's REST convention, over the same corpus /search reads. It sits
  // beside search rather than under /terminal because NLWeb specifies the path:
  // a client knocks on <origin>/ask and nothing else, so this is one of the few
  // routes here whose SPELLING is load-bearing.
  "/ask": handleAsk,

  // the x402 bot paywall: llms.txt's map is free, the full corpus costs $0.01
  // by machine payment (ungated until X402_PAY_TO is set).
  "/llms-full.txt": handleLlmsFull,

  // the crawl ledger: the month's AI-bot traffic as an invoice, issued
  // monthly, collected never.
  "/ledger": routeLedger,
  [LEDGER_LINES_URL]: handleLedgerLines,
  "/ledger.json": handleLedgerJson,

  // the prefetch activation beacon's receiver (speculation.js). A credentialless
  // HEAD from the browser when a speculated document is actually navigated to.
  "/ledger/prefetch": handlePrefetchActivation,
  // the ledger read back per path: speculations against activations, so the
  // eager candidates are chosen from what got navigated to (speculation.js).
  "/ledger/speculation.json": handleSpeculationJson,

  "/writing": routeWritingIndex,
  "/writing/": routeDropSlash,

  // webmention: the open web's way to say "I linked to you." The endpoint takes
  // the POST; the approve/decline pair are HMAC-signed host actions (same
  // construction as cal's booking approvals); /inbox displays what I approved.
  "/webmention": handleWebmention,
  "/webmention/approve": handleWebmentionDecision,
  "/webmention/decline": handleWebmentionDecision,
  "/inbox": handleInbox,
  [INBOX_MAIL_URL]: handleInboxMail,

  "/rn": handleRn,
  // /rn has no page of its own to twin, so its Markdown is rendered live from
  // the same payload /rn/tracks serves. This is the URL form; /rn negotiates.
  "/rn.md": handleRnMarkdown,
  "/rn/tracks": handleRnTracks,
  "/rn/tracks.html": handleRnTracksHtml,
  "/rn/admin": handleRnAdmin,
  "/rn/set": handleRnSet,

  "/bot": routeBot,
  "/around": routeAround,
  [AROUND_SNAPSHOT_URL]: handleAroundSnapshot,
  "/around/json": handleAroundJson,
  "/around/changes.json": handleAroundChangesJson,

  "/photos": routePhotos,
  "/photos/": routePhotosRedirect,
  "/photos/query.json": handlePhotoQuery,
  // the homepage grid's random twelve, fetched by the inline hydrator
  "/photos/grid.html": handlePhotoGrid,
  "/coffee/availability.json": handleCoffeeAvailability,
  "/run": routeRun,

  // the Apache-styled listings are retired (owner decree 2026-07-02): /photos
  // is the browse surface, so every listing URL 301s there instead of 404ing.
  "/images": routePhotosRedirect,
  "/images/": routePhotosRedirect,
  "/images/full": routePhotosRedirect,
  "/images/full/": routePhotosRedirect,
  "/images/manifest.json": routeImagesManifest,
  "/images/metadata.json": routeImagesMetadata,
  // Three root-level text assets that were edge-compressed at ~q4 until
  // 2026-08-31, now served from their build-time q11 twin. search-index.json is
  // the one /search fetches on every query, and the largest of the three.
  "/search-index.json": routeTextTwin,
  "/llms.txt": routeTextTwin,
  "/sitemap.xml": routeTextTwin,
  "/resume.json": routeTextTwin,

  "/index.html": routeIndexHtml,
  "/": routeHomepage,
};

// The handler for each prefix route. Their ORDER, patterns and the reasons for
// both are in routes.ts's PREFIX_ROUTES; dispatch walks that order.
const PREFIX_HANDLERS: Record<PrefixLabel, RouteHandler> = {
  "/coffee/<path>": routeCoffee,
  "/serendipity/<path>": routeSerendipity,
  "/writing/<slug>": routeWritingPost,
  "/writing/<file>.<ext>": routeTextTwin,
  "/section-icons/<name>.svg": routeTextTwin,
  "/terminal/<anything>": routeTerminalGone,
  // Matches the whole prefix and lets the handler 404 a bad shape, rather than
  // duplicating its hash/width/format grammar here. One regex, in rn.ts, is
  // what keeps this from becoming an open image proxy.
  "/rn/art/<hash>-<width>-<v>.<ext>": handleRnArt,
  "/images/meta/<stem>.json": routeImagesMeta,
  "/images/<index>.json": routeTextTwin,
  "/<page>.md": routeTextTwin,
  "/<path>.src.<ext>": routeTextTwin,
  "/.well-known/<card>": routeTextTwin,
  "/images/full/<key>": servePhotoFromR2,
  "/images/<thumb>": routeImageThumb,
  // A sub-resource under a static section (images, ask.js, /dotfiles/macos.sh)
  // is matched out by serveStaticPage's extension test and passes straight
  // through to the asset layer.
  "/garage/<page>": routeStaticPage,
  "/lwe/<page>": routeStaticPage,
  "/pixel-peeper/<page>": routeStaticPage,
  "/access": routeStaticPage,
  "/dotfiles": routeStaticPage,
  "/a/<asset>": routeShellAsset,
};

// The pipeline every request meets (dispatch.ts), handed the handlers above.
// Self-dispatch and the album pages are armed there, from routes.ts and
// albums.ts, so neither needs a wrapper in the tables.
const { serveWorkerRequest, withSelfFetch } = createDispatch({
  exact: EXACT_HANDLERS,
  prefix: PREFIX_HANDLERS,
  album: routeAlbum,
  calHost: routeCalHost,
});

// These two applications remain separate source modules, but the public route
// boundary is now owned by this Worker. Keeping the delegation here means the
// app-specific cache, auth, and persistence policies stay local to each module.
//
// The one exception is the booking page itself. GET /coffee is a BUILT document
// since 2026-09-30 (build.ts step 5b bakes cal's bookingPage), served here with
// the page policy every generated document takes, and its slot list arrives
// from /coffee/slots.html, which cal still renders per request. Where no bake is
// staged (bun run dev serves the unbuilt tree) cal renders the same shell.
async function routeCoffee(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/coffee") {
    return serveBuiltPage(request, env, {
      headers: { "cache-control": PAGE_CACHE_CONTROL, link: SHELL_PRELOAD_LINK, "referrer-policy": "strict-origin-when-cross-origin" },
      live: () => calWorker.fetch(request, env, ctx),
    });
  }
  return calWorker.fetch(request, env, ctx);
}

async function routeCalHost(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return noStoreRedirect("https://aadhar.sh/coffee");

  if (env.WORK_CALENDAR_SLUG && path === `/${env.WORK_CALENDAR_SLUG}`) {
    try {
      // The stored secret is always the calendar.app.google SHORT link — the
      // stable, trusted seed. But that short link costs the visitor an extra
      // browser round trip: it 30x-bounces to the full calendar.google.com
      // appointment URL. We resolve that bounce server-side once, cache the
      // final URL in KV, and redirect straight to it — collapsing two
      // client-visible navigations into one. If resolution fails for any
      // reason, we fall back to the short link, so behavior never regresses.
      const seed = new URL(env.WORK_CALENDAR_URL || "");
      if (seed.protocol !== "https:" || seed.hostname !== "calendar.app.google") {
        throw new Error("unexpected work-calendar target");
      }
      const resolved = await resolveWorkCalendar(seed.href, env, ctx);
      return noStoreRedirect(resolved || seed.href);
    } catch {
      // Fail closed: an absent or malformed target must not become an open
      // redirect, and should not reveal whether the slug was correct.
      return new Response("not found", { status: 404 });
    }
  }

  // Keep the existing legacy Cal endpoint behavior for /coffee, /slots, and
  // signed host actions while the alias remains a separate exact path.
  return routeCoffee(request, env, ctx);
}

function noStoreRedirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

// The final calendar.google.com URL a calendar.app.google short link resolves
// to, cached so only the first visitor after a TTL window pays the resolution
// latency. 24h is well inside how long Google keeps an appointment-schedule URL
// stable, and a miss just re-resolves — never a hard failure.
const WORK_CAL_CACHE_KEY = "workcal:resolved";
const WORK_CAL_TTL = 86400; // 24h

// Resolve the short link to its full destination, reading/writing the KV cache.
// Returns a validated calendar.google.com URL string, or null (caller falls
// back to the short link). Never throws.
async function resolveWorkCalendar(shortUrl: string, env: Env, ctx: ExecutionContext) {
  if (env.RN_KV) {
    try {
      // No cacheTtl, and the reason is specific to this key rather than a habit.
      // It is the only KV value here written WITH an expirationTtl, and KV caches
      // negative lookups on the same timer, so a colo that reads it in the moment
      // after the 24h window lapses would pin the miss: every visitor for the rest
      // of that window re-walks the redirect chain and re-writes, which costs more
      // than the cold read it was meant to save. Whether the colo's own write
      // clears that miss is not documented either way, and this route is a shared
      // booking link, so two visits landing at one colo inside any window worth
      // setting is the rare case rather than the common one. Measure the
      // negative-lookup behaviour before revisiting.
      const cached = await env.RN_KV.get(WORK_CAL_CACHE_KEY);
      if (cached && isResolvedCalendarUrl(cached)) return cached;
    } catch {}
  }
  const resolved = await followToCalendar(shortUrl);
  if (resolved && env.RN_KV) {
    // Warm the cache off the response path when we can; the visitor should not
    // wait on the KV write.
    const write = env.RN_KV.put(WORK_CAL_CACHE_KEY, resolved, { expirationTtl: WORK_CAL_TTL });
    if (ctx && ctx.waitUntil) ctx.waitUntil(write.catch(() => {}));
    else { try { await write; } catch {} }
  }
  return resolved;
}

// Follow the short link's 30x chain by header only (redirect: "manual"), never
// fetching the heavy calendar page body. Stops as soon as it lands on
// calendar.google.com. Bounded hops + timeout so a slow/hostile upstream can't
// stall the redirect. Identifies honestly as AadharshBot.
async function followToCalendar(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    let resp;
    try {
      resp = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": BOT_UA },
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      return null;
    }
    if (resp.status < 300 || resp.status >= 400) return null; // not a redirect; give up
    const loc = resp.headers.get("location");
    if (!loc) return null;
    try {
      current = new URL(loc, current).href;
    } catch {
      return null;
    }
    if (isResolvedCalendarUrl(current)) return current;
  }
  return null;
}

function isResolvedCalendarUrl(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname === "calendar.google.com";
  } catch {
    return false;
  }
}

// The dashboard's plain GET is a built document since 2026-09-25, with its
// events as an island (serendipity.ts says why). It keeps serendipity's own CSP,
// whose img-src admits the cover proxy's https fallback, with the build's hashes
// in place of 'unsafe-inline', so withSecurityHeaders sees a bespoke policy and
// leaves it. The headers go in through serveStaticPage rather than through
// withSerendipitySecurityHeaders, because that REBUILDS the Response from an
// object init, which drops encodeBody on a precompressed body and double-encodes
// it (gotcha 13). A flash ?msg= view, a HEAD and every other path stay live, and so
// does local dev, where no bake is staged and the build map has no entry.
async function routeSerendipity(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  // The readable twin of a built page here (/serendipity/mcp-info.src.html),
  // which that page's own first line names as its View Source. This prefix wins
  // before the generic "/<path>.src.<ext>" row, and handleSerendipity has no
  // such file, so it answered 404 until 2026-09-26.
  if (/^\/serendipity\/[^/]+\.src\.html$/i.test(url.pathname)) return servePrecompressedText(request, env);
  // The dashboard's plain GET and the agents page, both built at deploy; a
  // flash ?msg= belongs to the dashboard only.
  const built = (url.pathname === "/serendipity" && !url.searchParams.has("msg")) || url.pathname === SERENDIPITY_MCP_INFO;
  if (request.method === "GET" && built) {
    const hashes = scriptHashesFor(url.pathname);
    if (hashes) {
      const scriptSrc = ["'self'", ...hashes.map((h) => `'sha256-${h}'`)].join(" ");
      const response = await serveStaticPage(request, env, {
        headers: { ...SERENDIPITY_SECURITY_HEADERS, ...GENERATED_PAGE_HEADERS, "content-security-policy": serendipityCsp(scriptSrc) },
      });
      if (response.status !== 404) return response;
      try { await response.body?.cancel(); } catch {}
    }
  }
  const response = await handleSerendipity(request, env, ctx);
  return withSerendipitySecurityHeaders(response);
}

// /favicon.ico — serve the inline traffic-cone SVG directly. without this,
// legacy/bot probes for /favicon.ico would fetch the full homepage.
function routeFavicon() {
  return new Response(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='4' y='25' width='24' height='3' rx='0.5' fill='#1a1a1a'/><path d='M 16 4 L 9 25 L 23 25 Z' fill='#ff6600'/><path d='M 11.3 18 L 20.7 18 L 21.7 21 L 10.3 21 Z' fill='#ffffff'/><path d='M 13.7 11 L 18.3 11 L 19 13 L 13 13 Z' fill='#ffffff'/></svg>`,
    { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }
  );
}

// Agent-discovery docs: extensionless / iterated files stay worker-first because
// prior scanner work treats /auth.md, OAuth metadata, and live auth endpoints as
// one coordinated surface.
function routeAuthMd(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "text/markdown; charset=utf-8");
}

function routeApiCatalog(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/linkset+json");
}

function routeAgentCard(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routeOAuthProtectedResource(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routeOAuthAuthorizationServer(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routePhotosRedirect(_request, _env, _ctx, url) {
  return Response.redirect(url.origin + "/photos", 301);
}

// canonical URLs carry no trailing slash (sitemap + rel=canonical + llms.txt all
// say so, and the asset layer's drop-trailing-slash agrees). A worker route's own
// slashed twin 301s to the slashless form rather than serving a duplicate 200.
function routeDropSlash(_request, _env, _ctx, url) {
  return Response.redirect(url.origin + url.pathname.replace(/\/+$/, "") + url.search, 301);
}

// /terminal retired 2026-09-16 (the ROUTES comment says why). 410 rather than 404
// so a bookmark or an old link reads as "removed on purpose" and is told where
// the thing it wanted now lives. Cached a day: the answer will not change.
function routeTerminalGone() {
  return new Response(
    "410 Gone: the /terminal console page retired on 2026-09-16.\n\n"
    + "What it showed is the live exchange: POST https://aadhar.sh/mcp (JSON-RPC, tools/list then tools/call).\n"
    + "The catalogue as a document: https://aadhar.sh/.well-known/mcp/server-card.json\n"
    + "Every tool also answers a plain GET at its own path: /finger, /photos, /lens, /radar, /dict, /cache, /agent-ready, /encode\n",
    {
      status: 410,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-robots-tag": "noindex",
      },
    },
  );
}

function routeWritingPost(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  const slug = url.pathname.slice("/writing/".length);
  return serveBuiltPage(request, env, {
    headers: WRITING_PAGE_HEADERS,
    live: () => handleWritingPost(request, slug, env, ctx),
  });
}

// stale-while-revalidate rather than must-revalidate, matching the `/garage/*` and
// `/lwe/*` rules in _headers and for the same reason: it is the difference between a
// page that can be its own compression dictionary and one whose offer every browser
// throws away. The window is also the dictionary's lifetime. See the long note there,
// and the measured policy table in lib/assets.js.
const GENERATED_PAGE_HEADERS = {
  "cache-control": PAGE_CACHE_CONTROL,
  "link": SHELL_PRELOAD_LINK,
};

const UTILITY_SHELL_HEADERS = {
  "cache-control": "public, max-age=300, s-maxage=300",
  "link": SHELL_PRELOAD_LINK,
};

function routeRun(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  // A command answers with its own redirect; the bare page is noindex.
  return serveBuiltPage(request, env, {
    headers: { ...UTILITY_SHELL_HEADERS, "x-robots-tag": "noindex" },
    divert: () => (url.searchParams.get("cmd") ? handleRun(request, env, ctx) : null),
  });
}

// A query answers HTML and keeps its own headers: the twin describes the form
// and names /search.json for results, and it has no rendering of one query. The
// bare form's Markdown twin is noindex while its HTML carries no robots header,
// which is how this route has always answered, so the noindex is declared for
// the negotiated request alone.
function routeSearch(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  return serveBuiltPage(request, env, {
    headers: wantsMarkdown(request) ? { ...UTILITY_SHELL_HEADERS, "x-robots-tag": "noindex" } : UTILITY_SHELL_HEADERS,
    divert: () => (url.searchParams.get("q") ? handleSearch(request, env, ctx) : null),
  });
}

// /security is a built document since 2026-09-16 (security.ts's header says
// why); the three per-connection values it shows arrive from /security.json.
// Its Markdown twin carries the page's own noindex, as every representation of a
// built page carries its policy (lib/built-page.ts): a Markdown rendering of a
// noindex page should not be the indexable copy of it. The live arm is for `bun
// run dev`, which stages no bake; the build refuses to ship without the file.
const PRIVATE_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "x-robots-tag":    "noindex",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function routeSecurity(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: PRIVATE_PAGE_HEADERS, live: () => renderSecurityCenter() });
}

// /whoareyou is a built document since 2026-09-25, with its per-request values
// as an island from /whoareyou/values.html (whoareyou.ts says why and what moved).
// Same shape as routeSecurity above, down to the twin carrying the page's noindex.
function routeWhoareyou(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: PRIVATE_PAGE_HEADERS, live: () => renderWhoareyouPage() });
}

// /garage/dyno is a built document since 2026-09-25, with its chart and table as
// an island from /garage/dyno/pulls.html (dyno.ts says why). It takes the same
// headers as the other garage pages, since the shell only moves on a deploy.
function routeDyno(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: GENERATED_PAGE_HEADERS, live: () => renderDynoPage() });
}

// /ledger and /around are built documents since 2026-09-25, each with its live
// half as an island (ledger.ts and around.ts say why). The dev fallback is the
// same as routeDyno's.
// /lens/census is a built document since 2026-09-25 (census.ts says why). The
// owner's ?refresh=KEY view renders live and whole, because its banner belongs
// to the request that asked for the sweep. /inbox is the same shape, and its
// route lives in inbox.ts so the contract suite can call it (gotcha 16).
function routeCensus(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: { ...GENERATED_PAGE_HEADERS, "x-robots-tag": "index" },
    divert: (url) => (url.searchParams.has("refresh") ? handleCensus(request, env, ctx) : null),
    live: () => renderCensusPage(),
  });
}

function routeLedger(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: GENERATED_PAGE_HEADERS, live: () => renderLedgerPage() });
}

// The owner's ?bust=SECRET still works at the page URL: it re-crawls and
// overwrites this colo's cached snapshot before the shell goes out, so the
// island the shell then fetches is the new crawl. A wrong or absent secret does
// nothing and the static page is served as usual.
async function routeAround(request: SiteRequest, env: Env) {
  if (new URL(request.url).searchParams.has("bust")) {
    const busted = await refreshAroundSnapshot(request, env);
    try { await busted?.body?.cancel(); } catch {}
  }
  return serveBuiltPage(request, env, {
    headers: { ...GENERATED_PAGE_HEADERS, "x-robots-tag": "noindex" },
    live: () => renderAroundPage(),
  });
}

function routeLens(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  // A target-bearing Lens response spends crawler/browser budget and contains
  // third-party data, so it remains the live no-store Worker path. The bare,
  // deterministic shell is now a built q11/DCZ/304 static page.
  return serveBuiltPage(request, env, {
    headers: GENERATED_PAGE_HEADERS,
    divert: () => (url.searchParams.get("url") ? handleLens(request, env, ctx) : null),
  });
}

function routeWritingIndex(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: WRITING_PAGE_HEADERS,
    live: () => handleWritingIndex(request, env, ctx),
  });
}

// /photos and /bot join the generated-page tier, same shape as /writing above: the
// build emits their HTML (build.ts step 1e), so they earn the q11 twin and the dcz
// delta tiers that 40 authored pages already had, and the dynamic handler stays as
// the fallback for a build that somehow shipped without them.
//
// Both were build-renderable all along and nothing had noticed: /photos renders from
// the bundled pool (module memory since the pool moved into the Worker) plus the
// committed alt.json, and /bot's renderBotPage() takes no arguments at all. At 60KB
// /photos was the largest page on the site and the largest one still taking
// Cloudflare's on-the-fly zstd-3 with no twin and no delta.
//
// /photos gets a SHORTER stale window than the rest. The generated policy's 7 days is
// free for a garage page, which changes when something is written; /photos changes
// every time a photo is added, and a returning browser inside the window lists the
// older set. A day bounds that while still leaving a dictionary lifetime long enough
// to matter for the repeat visit dictionaries exist for. Owner call, 2026-07-29.
const PHOTOS_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
};

// /updates and /restore: generated at deploy, dynamic handler as the 404 fallback.
// Same shape as /photos and /writing. They take the standard generated policy — no
// shortened window like /photos needs, because their data cannot change between
// deploys, so a stale copy inside the 7 days is a copy of the same log.
function routeUpdates(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: GENERATED_PAGE_HEADERS,
    live: () => handleWindowsUpdate(request, env, ctx),
  });
}

function routeRestore(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: GENERATED_PAGE_HEADERS,
    live: () => handleSystemRestore(request, env, ctx),
  });
}

function routePhotos(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: PHOTOS_PAGE_HEADERS,
    live: () => handlePhotos(request, env, ctx),
  });
}

function routeAlbum(album: Album, request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: PHOTOS_PAGE_HEADERS,
    live: () => handleAlbum(album, request, env, ctx),
  });
}

function routeBot(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return serveBuiltPage(request, env, {
    headers: GENERATED_PAGE_HEADERS,
    live: () => handleBotPage(request, env, ctx),
  });
}

const WRITING_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "link": `${SHELL_PRELOAD_LINK}, </webmention>; rel="webmention"`,
};

// The staged manifest and its q11 twin (build.ts step 1e), with the live handler
// as the 404 fallback for a tree that staged nothing, which is `bun run dev`.
// IMAGES_MANIFEST_HEADERS overrides the one-year immutable cache _headers puts on
// /images/*; photos.ts carries the measurement and the reason.
async function routeImagesManifest(request: SiteRequest, env: Env) {
  const response = await servePrecompressedText(request, env, { headers: IMAGES_MANIFEST_HEADERS });
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleImagesManifest();
}

function routeImagesMetadata(request: SiteRequest, env: Env) {
  return servePrecompressedText(request, env, {
    headers: { "cache-control": "public, max-age=60, s-maxage=60, must-revalidate" },
    notFoundBody: '{"error":"not found"}',
    notFoundType: "application/json; charset=utf-8",
  });
}

function routeImagesMeta(request: SiteRequest, env: Env) {
  return servePrecompressedText(request, env, {
    notFoundBody: '{"error":"not found"}',
    notFoundType: "application/json; charset=utf-8",
  });
}

// legacy thumbnail URLs (/images/<stem>.<ext>[?v=N]) 301 into their content-
// addressed /i/ twins, so every old link, bookmark, and cached page keeps
// resolving for at least a year after the hash cutover. Unknown names fall
// through to the asset layer with the 404 cache-clamp, same as before.
function routeStaticPage(request: SiteRequest, env: Env) {
  return serveStaticPage(request, env);
}

function routeShellAsset(request: SiteRequest, env: Env) {
  return servePrecompressedShell(request, env);
}

// The q11 twin for a static text asset outside /a/ and outside any page
// prefix. The reasoning, and the measurement that put these behind the
// Worker, is on servePrecompressedText.
function routeTextTwin(request: SiteRequest, env: Env) {
  return servePrecompressedText(request, env);
}

async function routeImageThumb(request: SiteRequest, env: Env, _ctx: ExecutionContext, url: URL) {
  const m = url.pathname.match(/^\/images\/([^/]+?)(-400)?\.(avif|jpe?g)$/i);
  if (m) {
    const [, stem, small, ext] = m;
    const h = (await getThumbHashes(env))[stem];
    const isJpg = /^jpe?g$/i.test(ext);
    const key = small ? "s" : (isJpg ? "j" : "a");
    if (h && h[key]) {
      const name = small ? `${stem}-400.${h[key]}.avif` : `${stem}.${h[key]}.${isJpg ? "jpg" : "avif"}`;
      return new Response(null, {
        status: 301,
        headers: {
          "location":      `${url.origin}/i/${name}`,
          "cache-control": "public, max-age=86400",
        },
      });
    }
  }
  return serveAssetWith404Clamp(request, env);
}

function routeIndexHtml(_request, _env, _ctx, url) {
  url.pathname = "/";
  return Response.redirect(url.toString(), 301);
}

// `/` is a static document again. Everything that varied per request left it
// (see home.js's handlePhotoGrid header for where each piece went), so it takes
// the same path as /garage and /lwe: a q11 twin, a dcz delta against the page
// dictionary, and a real validator that answers 304.
//
// The policy is now the ordinary generated-page one, and the whole point is that
// `/` stops being special. It held `private, no-cache, must-revalidate` from the
// era when the document was SSR'd per request; step 1d bakes that variance out, so
// the reason the exception existed is gone while the exception's two costs stayed.
//
// COST ONE: no-cache bars reuse without revalidation, which is exactly the
// permission RFC 9842 requires, so Chromium refuses to keep a dictionary offered
// under it (measured across eight policies — the table lives in lib/assets.js and
// tools/check-dictionary-support.ts). That left `/` as the ONE page outside the
// per-page dictionary tier, taking the family corpus's 6.3% where every other page
// gets 93-97%. Measured against production 2026-07-31: 8,780 B plain q11 versus
// 8,225 B against the family dictionary.
//
// COST TWO: no shared cache may hold it, so every single front-door hit runs the
// worker. Measured the same day from SJC, the 103-to-200 window (which IS the
// worker's think time) was 8.5-18.8 ms warm, with cold-isolate samples near 130 ms.
// Small, but paid on every visit including the cold external arrival that is the
// one navigation nothing can prerender.
//
// What the exception was buying, per the note it replaces, was a front door that
// revalidates every time. `max-age=0` keeps that for the BROWSER: it still
// revalidates on every navigation and still answers 304 off the ETag. What changes
// is that a shared cache may now serve the document, and may serve it stale inside
// the swr window. Priced deliberately: the document is identical for everyone, the
// per-visit parts (tracks, the random twelve, the visit count) are separate no-store
// fragments, and a deploy purges the edge, so the stale window in practice is
// bounded by the next deploy rather than by the header. swr is 604800 because
// Chromium sizes a registered dictionary's LIFETIME from that window, so shortening
// it would quietly re-break cost one.
//
// The /hit beacon is unaffected — it was already a separate request, and counter.js
// already declines to count a speculative load.
// SHELL_PRELOAD_LINK first, then discovery. Cloudflare Early Hints harvests only
// the rel=preload entries out of this header and replays them as a 103, and
// without them here `/` was the ONE page on the site not getting that 103.
// Measured against production 2026-07-30: /whoareyou answered
//   HTTP/2 103
//   link: </a/luna.*.css>; as=style; rel=preload, </a/nav.*.js>; as=script; rel=preload
// and `/` answered with the ten discovery links and no preload at all.
//
// That is backwards from shell-assets.js's own reasoning, though that reasoning
// has since expired and the header stays for a different one. The file argues the
// homepage is where a 103 buys the most, because it "does KV reads before the 200."
// It no longer does; step 1d moved every one of them off the document. Measured
// against production 2026-07-31, the 103-to-200 window on `/` is 8.5-18.8 ms, and
// an earlier measurement (see the CDP note in CLAUDE.md) found windows under ~100 ms
// do not complete the preload. So the 103 is close to inert HERE and the honest
// reason to keep emitting the pair is the cold-isolate tail plus the fact that
// Cloudflare harvests these preloads for the 103 it replays on the routes that DO
// think. Do not re-derive a homepage win from it.
//
// Lost to a refactor rather than to a decision: lib/security.js still exported
// withHomepageDiscoveryHeaders, which sets precisely this pair, and nothing had
// imported it since `/` moved to serveStaticPage + these headers. The behaviour
// was still written down, just disconnected from the route, which is why nothing
// read as broken. That function is deleted in this commit rather than left as a
// second place to describe the same header.
const HOMEPAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "link": `${SHELL_PRELOAD_LINK}, ${HOMEPAGE_DISCOVERY_LINK}`,
};

// HEAD no longer forks here. It used to answer from homepageHeadResponse, a
// hand-written header set in home.js, and that duplicate had drifted in the way a
// duplicate only reached by an unwatched path always does: its markdown branch
// omitted x-markdown-tokens, which the GET has always sent.
//
// The drift also hid, and it is worth knowing why. `/` is in
// WORKERS_CACHEABLE_PATHS and the predicate admits HEAD, so a plain HEAD is
// satisfied from the stored GET entry, carrying the GET's own headers and ETag
// (verified against production: both returned W/"c4717f10…-br"). Only the
// MARKDOWN head reached the duplicate, because wantsMarkdown bails the cache —
// so the one path that ran it was the one nothing else could check.
//
// Both branches now take the GET's own code, which decides the header set once.
function routeHomepage(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  if (wantsMarkdown(request)) return serveMarkdown(request, env);
  // warm the grid fragment's two memoised maps behind the document (home.ts says why)
  ctx.waitUntil(warmGridData(env));
  return serveStaticPage(request, env, { headers: HOMEPAGE_HEADERS });
}
