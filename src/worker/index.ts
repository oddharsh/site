import { WorkerEntrypoint, tracing } from "cloudflare:workers";
import type { Env, SiteRequest } from "./lib/env.ts";
import type { SpanName } from "./lib/span-vocabulary.ts";
import calWorker from "../../cal/src/index.ts";
import { cronAround, handleAroundChangesJson, handleAroundJson, handleAroundSnapshot, refreshAroundSnapshot, renderAroundPage } from "./around.ts";
import { handleBotPage } from "./bot.ts";
import { renderAboutPage, renderContactPage, renderDevelopersPage, renderPrivacyPage } from "./trust.ts";
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

installTracing(tracing);


// the coffee-booking expiry timer (Workflows). One durable instance per pending
// booking replaces the old weekly cron sweep; its class_name must resolve on
// this entry so the BOOKING_WORKFLOW binding can find it (see cal/src/workflow.ts).
export { BookingWorkflow } from "../../cal/src/workflow.ts";
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

  async scheduled(event, env, ctx) {
    env = withBotPolicyCache(env);
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
      await cron("cron.home_probe", () => cronHomeProbe(env, ctx));
      // Same tick, because Workers Free caps an account at five triggers and
      // this needs no schedule of its own: it fills a bounded batch of album
      // covers per run and converges in a few ticks (rn.js cronEnrichTracks).
      // Caught, so a Spotify wobble cannot cost the probe its measurement, and
      // ordered second for the same reason.
      await cron("cron.rn_enrich", () => cronEnrichTracks(env, ctx)).catch(() => {});
      await cron("cron.reading_hn", () => cronEnrichReadingHn(env)).catch(() => {});
    } else if (job === "census") {
      // SUNDAYS 08:17 UTC. Cloudflare numbers weekdays Quartz-style, 1 = Sunday
      // through 7 = Saturday, where most cron systems use 0 = Sunday, so the `1`
      // in "17 8 * * 1" schedules Sunday. Nine comments across three files read
      // Monday for six weeks while production fired on Sunday, and nothing could
      // catch it because cronJob() matches minute+hour and is right either way.
      // The pairing is pinned in contract-the-perf-probe now. Prefer the
      // three-letter form in anything new.
      await cron("cron.census", () => cronCensus(env));
    } else if (job === "daily_outbound") {
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
      await cron("cron.serendipity", () => cronSerendipity(env));
    } else {
      await cron("cron.unmatched", async () => ({ ok: false, cron: event.cron }));
    }
  },
};

// The handler for each exact route, keyed by its id in routes.ts. The ROUTE
// LIST is data and lives there, where cloudflare.config.ts, build.ts and the
// contract suite can read it; this module cannot be loaded outside workerd
// (gotcha 16), so it binds handlers and nothing else. `Record<ExactPath, …>`
// is what makes that safe: a route with no handler is a missing key and a
// handler with no route is an excess one, and both are compile errors.
const EXACT_HANDLERS: Record<ExactPath, RouteHandler> = {
  "/favicon.ico": routeFavicon,

  "/.well-known/api-catalog": routeApiCatalog,
  "/.well-known/agent-card.json": routeAgentCard,
  "/.well-known/http-message-signatures-directory": handleSignatureDirectory,

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

  "/terminal": routeTerminalGone,
  "/terminal/": routeTerminalGone,

  "/finger": handleTool, "/finger.txt": handleTool,
  "/radar": handleTool,  "/radar.txt": handleTool,
  "/dict": handleTool,   "/dict.txt": handleTool,
  "/cache": handleTool,  "/cache.txt": handleTool,
  "/agent-ready": handleTool, "/agent-ready.txt": handleTool,
  "/encode": handleTool, "/encode.txt": handleTool,
  "/photos.txt": handleTool,
  "/lens.txt": handleTool,

  "/search": routeSearch,
  "/search.json": handleSearchJson,

  // /ask — NLWeb's REST convention, over the same corpus /search reads. It sits
  // beside search rather than under /terminal because NLWeb specifies the path:
  // a client knocks on <origin>/ask and nothing else, so this is one of the few
  // routes here whose SPELLING is load-bearing.
  "/ask": handleAsk,

  "/llms-full.txt": handleLlmsFull,

  "/ledger": routeLedger,
  [LEDGER_LINES_URL]: handleLedgerLines,
  "/ledger.json": handleLedgerJson,

  "/ledger/prefetch": handlePrefetchActivation,
  "/ledger/speculation.json": handleSpeculationJson,

  "/writing": routeWritingIndex,
  "/writing/": routeDropSlash,

  "/webmention": handleWebmention,
  "/webmention/approve": handleWebmentionDecision,
  "/webmention/decline": handleWebmentionDecision,
  "/inbox": handleInbox,
  [INBOX_MAIL_URL]: handleInboxMail,

  "/rn": handleRn,
  "/rn.md": handleRnMarkdown,
  "/rn/tracks": handleRnTracks,
  "/rn/tracks.html": handleRnTracksHtml,
  "/rn/admin": handleRnAdmin,
  "/rn/set": handleRnSet,

  "/bot": routeBot,
  "/about": routeTrustPage(renderAboutPage),
  "/contact": routeTrustPage(renderContactPage),
  "/privacy": routeTrustPage(renderPrivacyPage),
  "/developers": routeTrustPage(renderDevelopersPage),
  "/around": routeAround,
  [AROUND_SNAPSHOT_URL]: handleAroundSnapshot,
  "/around/json": handleAroundJson,
  "/around/changes.json": handleAroundChangesJson,

  "/photos": routePhotos,
  "/photos/": routePhotosRedirect,
  "/photos/query.json": handlePhotoQuery,
  "/photos/grid.html": handlePhotoGrid,
  "/coffee/availability.json": handleCoffeeAvailability,
  "/run": routeRun,

  "/images": routePhotosRedirect,
  "/images/": routePhotosRedirect,
  "/images/full": routePhotosRedirect,
  "/images/full/": routePhotosRedirect,
  "/images/manifest.json": routeImagesManifest,
  "/images/metadata.json": routeImagesMetadata,
  "/search-index.json": routeTextTwin,
  "/llms.txt": routeTextTwin,
  "/sitemap.xml": routeTextTwin,
  "/resume.json": routeTextTwin,

  "/index.html": routeIndexHtml,
  "/": routeHomepage,
};

const PREFIX_HANDLERS: Record<PrefixLabel, RouteHandler> = {
  "/coffee/<path>": routeCoffee,
  "/serendipity/<path>": routeSerendipity,
  "/writing/<slug>": routeWritingPost,
  "/writing/<file>.<ext>": routeTextTwin,
  "/section-icons/<name>.svg": routeTextTwin,
  "/terminal/<anything>": routeTerminalGone,
  "/rn/art/<hash>-<width>-<v>.<ext>": handleRnArt,
  "/images/meta/<stem>.json": routeImagesMeta,
  "/images/<index>.json": routeTextTwin,
  "/<page>.md": routeTextTwin,
  "/<path>.src.<ext>": routeTextTwin,
  "/.well-known/<card>": routeTextTwin,
  "/images/full/<key>": servePhotoFromR2,
  "/images/<thumb>": routeImageThumb,
  "/garage/<page>": routeStaticPage,
  "/lwe/<page>": routeStaticPage,
  "/pixel-peeper/<page>": routeStaticPage,
  "/access": routeStaticPage,
  "/dotfiles": routeStaticPage,
  "/a/<asset>": routeShellAsset,
};

const { serveWorkerRequest, withSelfFetch } = createDispatch({
  exact: EXACT_HANDLERS,
  prefix: PREFIX_HANDLERS,
  album: routeAlbum,
  calHost: routeCalHost,
});

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
      const seed = new URL(env.WORK_CALENDAR_URL || "");
      if (seed.protocol !== "https:" || seed.hostname !== "calendar.app.google") {
        throw new Error("unexpected work-calendar target");
      }
      const resolved = await resolveWorkCalendar(seed.href, env, ctx);
      return noStoreRedirect(resolved || seed.href);
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

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

const WORK_CAL_CACHE_KEY = "workcal:resolved";
const WORK_CAL_TTL = 86400;

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
    const write = env.RN_KV.put(WORK_CAL_CACHE_KEY, resolved, { expirationTtl: WORK_CAL_TTL });
    if (ctx && ctx.waitUntil) ctx.waitUntil(write.catch(() => {}));
    else { try { await write; } catch {} }
  }
  return resolved;
}

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
    if (resp.status < 300 || resp.status >= 400) return null;
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
  if (/^\/serendipity\/[^/]+\.src\.html$/i.test(url.pathname)) return servePrecompressedText(request, env);
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

function routeFavicon() {
  return new Response(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='4' y='25' width='24' height='3' rx='0.5' fill='#1a1a1a'/><path d='M 16 4 L 9 25 L 23 25 Z' fill='#ff6600'/><path d='M 11.3 18 L 20.7 18 L 21.7 21 L 10.3 21 Z' fill='#ffffff'/><path d='M 13.7 11 L 18.3 11 L 19 13 L 13 13 Z' fill='#ffffff'/></svg>`,
    { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }
  );
}

function routeApiCatalog(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/linkset+json");
}

function routeAgentCard(request: SiteRequest, env: Env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routePhotosRedirect(_request, _env, _ctx, url) {
  return Response.redirect(url.origin + "/photos", 301);
}

function routeDropSlash(_request, _env, _ctx, url) {
  return Response.redirect(url.origin + url.pathname.replace(/\/+$/, "") + url.search, 301);
}

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
  return serveBuiltPage(request, env, {
    headers: { ...UTILITY_SHELL_HEADERS, "x-robots-tag": "noindex" },
    divert: () => (url.searchParams.get("cmd") ? handleRun(request, env, ctx) : null),
  });
}

function routeSearch(request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  return serveBuiltPage(request, env, {
    headers: wantsMarkdown(request) ? { ...UTILITY_SHELL_HEADERS, "x-robots-tag": "noindex" } : UTILITY_SHELL_HEADERS,
    divert: () => (url.searchParams.get("q") ? handleSearch(request, env, ctx) : null),
  });
}

const PRIVATE_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "x-robots-tag":    "noindex",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function routeSecurity(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: PRIVATE_PAGE_HEADERS, live: () => renderSecurityCenter() });
}

function routeWhoareyou(request: SiteRequest, env: Env) {
  return serveBuiltPage(request, env, { headers: PRIVATE_PAGE_HEADERS, live: () => renderWhoareyouPage() });
}

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

const PHOTOS_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
};

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

function routeTrustPage(render: () => Response): RouteHandler {
  return (request: SiteRequest, env: Env) => serveBuiltPage(request, env, {
    headers: GENERATED_PAGE_HEADERS,
    live: () => render(),
  });
}

const WRITING_PAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "link": `${SHELL_PRELOAD_LINK}, </webmention>; rel="webmention"`,
};

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

function routeStaticPage(request: SiteRequest, env: Env) {
  return serveStaticPage(request, env);
}

function routeShellAsset(request: SiteRequest, env: Env) {
  return servePrecompressedShell(request, env);
}

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

// The /hit beacon is unaffected — it was already a separate request, and counter.js
// already declines to count a speculative load.
// SHELL_PRELOAD_LINK first, then discovery. Cloudflare Early Hints harvests only
// the rel=preload entries out of this header and replays them as a 103, and
// without them here `/` was the ONE page on the site not getting that 103.
// Measured against production 2026-07-30: /whoareyou answered
//   HTTP/2 103
//   link: </a/luna.*.css>; as=style; rel=preload, </a/nav.*.js>; as=script; rel=preload
// and `/` answered with the ten discovery links and no preload at all.
const HOMEPAGE_HEADERS = {
  ...GENERATED_PAGE_HEADERS,
  "link": `${SHELL_PRELOAD_LINK}, ${HOMEPAGE_DISCOVERY_LINK}`,
};

function routeHomepage(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  if (wantsMarkdown(request)) return serveMarkdown(request, env);
  ctx.waitUntil(warmGridData(env));
  return serveStaticPage(request, env, { headers: HOMEPAGE_HEADERS });
}
