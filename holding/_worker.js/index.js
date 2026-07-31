// _worker.js/index.js: the dispatcher. Handlers live in sibling modules;
// wrangler bundles this directory at deploy (its build, not ours). The ROUTES
// and PREFIX tables below mirror wrangler.jsonc's allowlist one-to-one; keep
// them in sync or a route silently goes static. Map in MAINTENANCE.md.

import { WorkerEntrypoint, tracing } from "cloudflare:workers";
import calWorker from "../../cal/src/index.js";
import { handleAgentAuthClaim, handleAgentAuthRegister, handleAgentAuthRevoke, handleAgentAuthToken } from "./agent.js";
import { cronAround, handleAround, handleAroundChangesJson, handleAroundJson } from "./around.js";
import { handleBotPage } from "./bot.js";
import { cronCensus, handleCensus, handleCensusJson } from "./census.js";
import { handleCoffeeAvailability } from "./coffee.js";
import { handleHit } from "./counter.js";
import { handlePhotoGrid, homepageHeadResponse, serveMarkdown } from "./home.js";
import { handleInbox } from "./inbox.js";
import { handleWebmention, handleWebmentionDecision } from "./webmention.js";
import { cronSendWebmentions } from "./webmention-send.js";
import { countCrawlerHit, handleLedger, handleLedgerJson } from "./ledger.js";
import { handleRumCollect, handleRumScript } from "./rum.js";
import { handleLens, handleLensBrowser, handleLensCompare, handleLensFetch, handleLensShot } from "./lens.js";
import { serveAssetWith404Clamp, serveFreshAsset, servePrecompressedShell, serveStaticPage } from "./lib/assets.js";
import { BOT_UA } from "./lib/botauth.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.js";
import { wantsMarkdown } from "./lib/http.js";
import { handleSiteMcp } from "./mcp.js";
import { withSecurityHeaders } from "./lib/security.js";
import { SHELL_PRELOAD_LINK } from "./lib/shell-assets.js";
import { cronJob } from "./lib/cron.js";
import { installTracing, span } from "./lib/trace.js";
import { installTracing as installCalTracing } from "../../cal/src/trace.js";
import { getThumbHashes, handleImagesManifest, handlePhotoQuery, handlePhotos, servePhotoFromR2 } from "./photos.js";
import { handleReading } from "./reading.js";
import { handleRun } from "./run.js";
import { handleRn, handleRnAdmin, handleRnArt, handleRnSet, handleRnTracks, handleRnTracksHtml } from "./rn.js";
import { cronHomeProbe } from "./perf-probe.js";
import { handleSearch, handleSearchJson } from "./search.js";
import { handleSecurityCenter } from "./security.js";
import { handleSystemRestore, handleUpdatesJson, handleWindowsUpdate } from "./updates.js";
import { handleWhoareyou, handleWhoareyouJson } from "./whoareyou.js";
import { handleWritingIndex, handleWritingPost } from "./writing.js";
import { handleLlmsFull } from "./x402.js";
import { cronSerendipity, handleSerendipity, withSerendipitySecurityHeaders } from "../../serendipity/serendipity.js";

// Hand the runtime's tracer to both span helpers. THIS is the only module that
// may import it: the rest of the worker is also imported by contract-tests.mjs
// under plain node, which cannot resolve the `cloudflare:` scheme (see
// lib/trace.js's header). Module-scope, so it completes at isolate init before
// any handler runs; without it every span is a harmless direct call, which is
// exactly the behavior the tests and `wrangler dev` get.
installTracing(tracing);
installCalTracing(tracing);

// the homepage visit-counter Durable Object, hosted in-house (see counter.js).
// must be a named export of the entry so the COUNTER binding can resolve it.
export { Counter } from "./counter.js";

// the coffee-booking expiry timer (Workflows). One durable instance per pending
// booking replaces the old weekly cron sweep; its class_name must resolve on
// this entry so the BOOKING_WORKFLOW binding can find it (see cal/src/workflow.js).
export { BookingWorkflow } from "../../cal/src/workflow.js";

// Workers Cache only fronts responses whose route contract is already public
// and reusable. Keep the default export as an uncached gateway: it handles the
// homepage, mutations, per-visitor views, and arbitrary inspection targets.
// Query strings are excluded deliberately so owner bust tokens and future
// query-bearing features cannot accidentally become shared cache keys.
const WORKERS_CACHEABLE_PATHS = new Set("/favicon.ico /auth.md /.well-known/api-catalog /.well-known/agent-card.json /.well-known/oauth-protected-resource /.well-known/oauth-authorization-server /reading /updates /updates.json /restore /lens /ledger /writing /bot /around /around/json /around/changes.json /photos /rn/tracks /rn/tracks.html /images/manifest.json /images/metadata.json /coffee /coffee/availability.json /search /photos/query.json".split(" "));

function shouldUseWorkersCache(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.has("range") || request.headers.has("if-none-match")) return false;
  const url = new URL(request.url);
  if (url.search) return false;
  if (WORKERS_CACHEABLE_PATHS.has(url.pathname)) return true;
  return url.pathname.startsWith("/writing/")
    || url.pathname.startsWith("/images/full/")
    || url.pathname.startsWith("/images/meta/");
}

async function serveWorkerRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.hostname.endsWith(".pages.dev")) {
    const target = `https://${CANONICAL_HOST}${url.pathname}${url.search}`;
    return new Response(null, {
      status: 301,
      headers: {
        "location":      target,
        "cache-control": "public, max-age=3600",
      },
    });
  }

  // SELF_FETCH — how /lens reads our own hostname without lying about it.
  // A plain fetch("https://aadhar.sh/") from inside this worker loops back
  // through the edge and dies as a 522; serving env.ASSETS instead returns the
  // PRE-enhancement static skeleton (wrong bytes, empty photo grid, zero alt
  // text), which a page whose whole claim is "what the server actually sent
  // back" must not show. Dispatching through route() yields the real response.
  // SELF_FETCH is nulled one level down, so a lens pointed at /lens/fetch
  // resolves once and cannot recurse.
  const selfEnv = {
    ...env,
    SELF_FETCH: async (req) =>
      withSecurityHeaders(await route(req, { ...env, SELF_FETCH: null }, ctx)),
  };

  // Workers Logs: one structured line per worker-owned request (path, method,
  // status, ms, country, bot), filterable in the dashboard. Edge-direct traffic
  // never reaches this code, so it never logs. Strippable: delete the wrapper,
  // keep `return withSecurityHeaders(await route(...))`.
  const t0 = Date.now();
  const response = await route(request, selfEnv, ctx);
  // the bot ledger: identified AI-crawler hits tick into Analytics Engine
  // (worker-owned routes only); /ledger prices them. Best-effort, non-blocking.
  countCrawlerHit(env, request, response, url.pathname);
  try {
    console.log(JSON.stringify({
      p: url.pathname,
      m: request.method,
      s: response.status,
      ms: Date.now() - t0,
      co: request.cf?.country,
      bot: request.cf?.botManagement?.verifiedBot || undefined,
    }));
  } catch {}
  return withSecurityHeaders(response);
}

// The named entrypoint is the only one configured to consult Workers Cache in
// production. A cache hit returns before this method runs; a miss gets the
// exact same dispatcher, security headers, and observability as the gateway.
export class CachedPages extends WorkerEntrypoint {
  async fetch(request) {
    return serveWorkerRequest(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (shouldUseWorkersCache(request) && ctx.exports?.CachedPages) {
      return ctx.exports.CachedPages.fetch(request);
    }
    return serveWorkerRequest(request, env, ctx);
  },

  // cron (wrangler.jsonc "triggers"): the /around crawl runs on the frequent
  // schedule so the request path stays a pure KV read and the page is safe to
  // prerender. The weekly schedule sweeps the /lens/census roster into D1.
  async scheduled(event, env, ctx) {
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
    const cron = (name, work) => { const p = span(name, work, { "cron.schedule": event.cron }); ctx.waitUntil(p); return p; };
    // Dispatch via cronJob() (lib/cron.js): minute+hour signatures, immune to
    // Cloudflare's cron-expression normalization ("* * 1" can come back
    // "* * MON", and the old exact match sent three straight Monday censuses
    // into the else-branch). Unknown expressions get their own traced event
    // instead of silently running somebody else's job.
    const job = cronJob(event.cron);
    if (job === "home_probe") {
      await cron("cron.home_probe", () => cronHomeProbe(env, ctx));   // :07/:37 — the two homepage fragments' KV latency -> Analytics Engine
    } else if (job === "census") {
      await cron("cron.census", () => cronCensus(env));   // Mondays 08:17 UTC — the longitudinal census, full roster in one awaited pass
    } else if (job === "webmention_send") {
      // 05:41 UTC daily — tell the sources these pages cite that they were
      // cited. Its own schedule (not the */30 tick) because it reads my own
      // pages and then probes third-party hosts: a slow, polite, once-a-day job.
      await cron("cron.webmention_send", () => cronSendWebmentions(env));
    } else if (job === "serendipity") {
      // 00/06/12/18:23 UTC — re-sync every enabled Luma feed into the
      // serendipity pool (serendipity.js cronSerendipity): events, then the
      // next few guest lists, then a description backfill. Four times daily
      // keeps the pool honest AND the stored Luma session warm; without this
      // tick the pool only refreshed on a cookie re-paste. Odd minute, same
      // collision-avoidance as the others.
      await cron("cron.serendipity", () => cronSerendipity(env));
    } else if (job === "around") {
      await cron("cron.around", () => cronAround(env));   // */30 — the neighborhood crawl
    } else {
      await cron("cron.unmatched", async () => ({ ok: false, cron: event.cron }));
    }
    // NOTE: the weekly coffee-booking sweep (0 4 * * 7) is gone — each pending
    // booking now carries its own BookingWorkflow expiry timer (cal/src/workflow.js).
  },
};

// Exact worker-owned routes. This table mirrors wrangler.jsonc's
// assets.run_worker_first allowlist: static is the default, and each entry here
// earns a Worker invocation because it renders, redirects, negotiates, proxies,
// writes, or needs a deliberate cache-policy override.
const ROUTES = new Map([
  ["/favicon.ico", routeFavicon],

  ["/auth.md", routeAuthMd],
  ["/.well-known/api-catalog", routeApiCatalog],
  ["/.well-known/agent-card.json", routeAgentCard],
  ["/.well-known/oauth-protected-resource", routeOAuthProtectedResource],
  ["/.well-known/oauth-authorization-server", routeOAuthAuthorizationServer],
  ["/agent/auth", handleAgentAuthRegister],
  ["/agent/auth/claim", handleAgentAuthClaim],
  ["/oauth2/token", handleAgentAuthToken],
  ["/oauth2/revoke", handleAgentAuthRevoke],

  ["/hit", handleHit],

  ["/whoareyou", handleWhoareyou],
  ["/whoareyou.json", handleWhoareyouJson],
  ["/security", handleSecurityCenter],
  ["/reading", handleReading],
  ["/updates", routeUpdates],
  ["/updates.json", handleUpdatesJson],
  ["/restore", routeRestore],

  ["/lens", routeLens],
  ["/lens/", routeDropSlash],
  ["/lens/fetch", handleLensFetch],
  ["/lens/shot", handleLensShot],
  ["/lens/browser", handleLensBrowser],
  ["/lens/compare.json", handleLensCompare],
  ["/lens/census", handleCensus],
  ["/lens/census.json", handleCensusJson],

  ["/mcp", handleSiteMcp],

  ["/search", handleSearch],
  ["/search.json", handleSearchJson],

  // the x402 bot paywall: llms.txt's map is free, the full corpus costs $0.01
  // by machine payment (ungated until X402_PAY_TO is set).
  ["/llms-full.txt", handleLlmsFull],

  // the crawl ledger: the month's AI-bot traffic as an invoice, issued
  // monthly, collected never.
  ["/ledger", handleLedger],
  ["/ledger.json", handleLedgerJson],

  // Cloudflare Web Analytics, both legs served from this origin. Not under
  // /cdn-cgi/: that prefix is handled at the edge before a Worker sees it.
  ["/ledger/rum.js", handleRumScript],
  ["/ledger/rum", handleRumCollect],

  ["/writing", routeWritingIndex],
  ["/writing/", routeDropSlash],

  // webmention: the open web's way to say "I linked to you." The endpoint takes
  // the POST; the approve/decline pair are HMAC-signed host actions (same
  // construction as cal's booking approvals); /inbox displays what I approved.
  ["/webmention", handleWebmention],
  ["/webmention/approve", handleWebmentionDecision],
  ["/webmention/decline", handleWebmentionDecision],
  ["/inbox", handleInbox],

  ["/rn", handleRn],
  ["/rn/tracks", handleRnTracks],
  ["/rn/tracks.html", handleRnTracksHtml],
  ["/rn/admin", handleRnAdmin],
  ["/rn/set", handleRnSet],

  ["/bot", routeBot],
  ["/around", handleAround],
  ["/around/json", handleAroundJson],
  ["/around/changes.json", handleAroundChangesJson],

  ["/photos", routePhotos],
  ["/photos/", routePhotosRedirect],
  ["/photos/query.json", handlePhotoQuery],
  // the homepage grid's random twelve, fetched by the inline hydrator
  ["/photos/grid.html", handlePhotoGrid],
  ["/coffee/availability.json", handleCoffeeAvailability],
  ["/run", handleRun],

  // the Apache-styled listings are retired (owner decree 2026-07-02): /photos
  // is the browse surface, so every listing URL 301s there instead of 404ing.
  ["/images", routePhotosRedirect],
  ["/images/", routePhotosRedirect],
  ["/images/full", routePhotosRedirect],
  ["/images/full/", routePhotosRedirect],
  ["/images/manifest.json", handleImagesManifest],
  ["/images/metadata.json", routeImagesMetadata],

  ["/index.html", routeIndexHtml],
  ["/", routeHomepage],
]);

// Ordered prefix/pattern routes. Order is load-bearing: R2 originals and
// per-photo metadata must win before the generic thumbnail clamp.
const PREFIX = [
  {
    label: "/coffee/<path>",
    match: (pathname) => pathname === "/coffee" || pathname.startsWith("/coffee/"),
    handle: routeCoffee,
  },
  {
    label: "/serendipity/<path>",
    match: (pathname) => pathname === "/serendipity" || pathname.startsWith("/serendipity/"),
    handle: routeSerendipity,
  },
  {
    label: "/writing/<slug>",
    match: (pathname) => {
      if (!pathname.startsWith("/writing/")) return false;
      const slug = pathname.slice("/writing/".length);
      return !!slug && slug.indexOf("/") === -1 && slug.indexOf(".") === -1;
    },
    handle: routeWritingPost,
  },
  {
    label: "/rn/art/<hash>-<width>-<v>.<ext>",
    match: (pathname) => pathname.startsWith("/rn/art/"),
    handle: handleRnArt,
    // Matches the whole prefix and lets the handler 404 a bad shape, rather than
    // duplicating its hash/width/format grammar here. One regex, in rn.js, is
    // what keeps this from becoming an open image proxy.
  },
  {
    label: "/images/meta/<stem>.json",
    match: (pathname) => /^\/images\/meta\/[^/]+\.json$/i.test(pathname),
    handle: routeImagesMeta,
  },
  {
    label: "/images/full/<key>",
    match: (pathname) => pathname.startsWith("/images/full/"),
    handle: servePhotoFromR2,
  },
  {
    label: "/images/<thumb>",
    match: (pathname) => /^\/images\/[^/]+\.(avif|jpe?g|png|gif|heic|heif|hif)$/i.test(pathname),
    handle: routeImageThumb,
  },
  // /a/<name>.<hash8>.<ext> — the content-hashed shell (nav.js, luna.css, lens.js,
  // icons.svg). This was edge-direct until 2026-07-26 and the _headers comment said
  // so deliberately; it moved behind the worker to hand out build.mjs's brotli q11
  // twin, which the edge would not have produced (it fly-compresses at ~q4 and
  // prefers zstd, measured LARGER than its own brotli here). The `.br` suffix is
  // excluded so the twin itself stays a plain static asset — the worker fetches it
  // through ASSETS, and matching it here would recurse.
  // the 30 static garage/lwe pages. Worker-first so they can be answered with a dcz delta
  // or the brotli q11 twin; a sub-resource under either prefix (images, ask.js) is matched
  // out by the extension test inside the handler and passes straight through.
  // The bare section path is matched alongside the prefix, because "/garage/" does
  // NOT match "/garage". Without it the two section indexes fell straight through
  // to the asset layer and their brotli q11 twins were built, uploaded, and never
  // served: /garage shipped 13,264 bytes against an 11,131-byte twin, /lwe 6,197
  // against 5,171 (2026-07-28). It hid because an unserved twin still returns a
  // correct page, only a larger one, and all 29 sub-pages were byte-exact.
  {
    label: "/garage/<page>",
    match: (pathname) => pathname === "/garage" || pathname.startsWith("/garage/"),
    handle: routeStaticPage,
  },
  {
    label: "/lwe/<page>",
    match: (pathname) => pathname === "/lwe" || pathname.startsWith("/lwe/"),
    handle: routeStaticPage,
  },
  {
    label: "/pixel-peeper/<page>",
    match: (pathname) => pathname === "/pixel-peeper" || pathname.startsWith("/pixel-peeper/"),
    handle: routeStaticPage,
  },
  {
    label: "/a/<asset>",
    match: (pathname) => /^\/a\/[^/]+\.[0-9a-f]{8}\.(js|css|svg|dict)$/.test(pathname),
    handle: routeShellAsset,
  },
];

async function route(request, env, ctx) {
  const url = new URL(request.url);
  // Preserve the legacy Cal subdomain while giving it a small, unlisted
  // work-calendar escape hatch. The bare host is public and goes to the
  // canonical booking page; only the exact secret slug redirects externally.
  // The slug and destination stay in Worker secrets so rotating either one
  // does not require a code change or a discoverable URL in the repository.
  if (url.hostname === "cal.aadhar.sh") return routeCalHost(request, env, ctx, url);

  // Every dispatch below runs inside one span named for the route TEMPLATE, not
  // the raw path: `/writing/<slug>` rather than `/writing/the-thing-i-wrote`.
  // Templates are what make a trace groupable — raw paths would mint a new span
  // name per photo stem and per post, and the interesting question is always
  // "how does this ROUTE behave", never "how did this one URL behave once".
  // Exact routes are already templates (a fixed ~60-entry table), so they use
  // their pathname as-is.
  //
  // This also gives every auto-instrumented child (KV get, R2 get, outbound
  // fetch) a named parent, which is the whole reason the span exists: the
  // platform already times the handler, but it cannot know that a given fetch
  // was part of serving /lens versus part of serving /around.
  //
  // route() re-enters itself through SELF_FETCH (lens reading this own host), so
  // these spans legitimately nest one level. That nesting is the point — it
  // shows a self-scan's inner work as inner work.
  const exact = ROUTES.get(url.pathname);
  if (exact) return dispatchTraced(url.pathname, "exact", exact, request, env, ctx, url);

  for (const r of PREFIX) {
    if (r.match(url.pathname)) return dispatchTraced(r.label, "prefix", r.handle, request, env, ctx, url);
  }

  // Static is the default: garage/lwe/cars/shell JS/discovery files fall through
  // to Workers static assets without a bespoke dispatcher branch. Deliberately
  // NOT wrapped: this arm is one auto-instrumented ASSETS call and a span around
  // it would only restate the child.
  return env.ASSETS.fetch(request);
}

function dispatchTraced(template, kind, handle, request, env, ctx, url) {
  return span(
    `route ${template}`,
    async (s) => {
      const response = await handle(request, env, ctx, url);
      // status lands on the span rather than only in the log line, so a trace
      // can be read end to end without cross-referencing Workers Logs.
      s.setAttribute("http.response.status_code", response.status);
      return response;
    },
    {
      "http.request.method": request.method,
      "route.template": template,
      "route.kind": kind,
      // the self-fetch marker: null SELF_FETCH means this dispatch IS the inner
      // one (route() nulls it one level down), so a nested span says which.
      "route.self_fetch": env.SELF_FETCH ? undefined : true,
    },
  );
}

// These two applications remain separate source modules, but the public route
// boundary is now owned by this Worker. Keeping the delegation here means the
// app-specific cache, auth, and persistence policies stay local to each module.
function routeCoffee(request, env, ctx) {
  return calWorker.fetch(request, env, ctx);
}

async function routeCalHost(request, env, ctx, url) {
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
async function resolveWorkCalendar(shortUrl, env, ctx) {
  if (env.RN_KV) {
    try {
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

async function routeSerendipity(request, env, ctx) {
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
function routeAuthMd(request, env) {
  return serveFreshAsset(request, env, "text/markdown; charset=utf-8");
}

function routeApiCatalog(request, env) {
  return serveFreshAsset(request, env, "application/linkset+json");
}

function routeAgentCard(request, env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routeOAuthProtectedResource(request, env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routeOAuthAuthorizationServer(request, env) {
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

async function routeWritingPost(request, env, ctx, url) {
  const slug = url.pathname.slice("/writing/".length);
  const response = await serveGeneratedWriting(request, env);
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleWritingPost(request, slug, env, ctx);
}

// stale-while-revalidate rather than must-revalidate, matching the `/garage/*` and
// `/lwe/*` rules in _headers and for the same reason: it is the difference between a
// page that can be its own compression dictionary and one whose offer every browser
// throws away. The window is also the dictionary's lifetime. See the long note there,
// and the measured policy table in lib/assets.js.
const GENERATED_PAGE_HEADERS = {
  "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
  "link": SHELL_PRELOAD_LINK,
};

function routeLens(request, env, ctx, url) {
  // A target-bearing Lens response spends crawler/browser budget and contains
  // third-party data, so it remains the live no-store Worker path. The bare,
  // deterministic shell is now a built q11/DCZ/304 static page.
  if (url.searchParams.get("url")) return handleLens(request, env, ctx);
  return serveStaticPage(request, env, { headers: GENERATED_PAGE_HEADERS });
}

async function routeWritingIndex(request, env, ctx) {
  const response = await serveGeneratedWriting(request, env);
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleWritingIndex(request, env, ctx);
}

// /photos and /bot join the generated-page tier, same shape as /writing above: the
// build emits their HTML (build.mjs step 1e), so they earn the q11 twin and the dcz
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
async function routeUpdates(request, env, ctx) {
  const response = await serveStaticPage(request, env, { headers: GENERATED_PAGE_HEADERS });
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleWindowsUpdate(request, env, ctx);
}

async function routeRestore(request, env, ctx) {
  const response = await serveStaticPage(request, env, { headers: GENERATED_PAGE_HEADERS });
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleSystemRestore(request, env, ctx);
}

async function routePhotos(request, env, ctx) {
  const response = await serveStaticPage(request, env, { headers: PHOTOS_PAGE_HEADERS });
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handlePhotos(request, env, ctx);
}

async function routeBot(request, env, ctx) {
  const response = await serveStaticPage(request, env, { headers: GENERATED_PAGE_HEADERS });
  if (response.status !== 404) return response;
  try { await response.body?.cancel(); } catch {}
  return handleBotPage(request, env, ctx);
}

function serveGeneratedWriting(request, env) {
  return serveStaticPage(request, env, {
    headers: {
      ...GENERATED_PAGE_HEADERS,
      "link": `${SHELL_PRELOAD_LINK}, </webmention>; rel="webmention"`,
    },
  });
}

function routeImagesMetadata(request, env) {
  return serveAssetWith404Clamp(request, env, {
    headers: { "cache-control": "public, max-age=60, s-maxage=60, must-revalidate" },
    notFoundBody: '{"error":"not found"}',
    notFoundType: "application/json; charset=utf-8",
  });
}

function routeImagesMeta(request, env) {
  return serveAssetWith404Clamp(request, env, {
    notFoundBody: '{"error":"not found"}',
    notFoundType: "application/json; charset=utf-8",
  });
}

// legacy thumbnail URLs (/images/<stem>.<ext>[?v=N]) 301 into their content-
// addressed /i/ twins, so every old link, bookmark, and cached page keeps
// resolving for at least a year after the hash cutover. Unknown names fall
// through to the asset layer with the 404 cache-clamp, same as before.
function routeStaticPage(request, env) {
  return serveStaticPage(request, env);
}

function routeShellAsset(request, env) {
  return servePrecompressedShell(request, env);
}

async function routeImageThumb(request, env, _ctx, url) {
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
// The cache policy stays PRIVATE and no-cache rather than picking up the static
// pages' s-maxage. The document is identical for everyone, but it is still the
// front door and the one page whose visit the /hit beacon counts; keeping it
// out of shared caches costs nothing now that the body revalidates to an empty
// 304 instead of retransmitting.
//
// That also makes `/` the ONE page outside the per-page dictionary tier, and
// deliberately so rather than by oversight. `no-cache` bars reuse without
// revalidation, which is exactly the permission RFC 9842 requires, so Chromium will
// not keep a dictionary offered here no matter what else the header says — adding
// stale-while-revalidate alongside it changed nothing when measured. Buying `/` into
// the tier means dropping no-cache, and the front door's revalidate-every-time
// posture is worth more than one page's delta. serveStaticPage drops the offer on
// its own (canRegisterAsDictionary), so nothing here advertises what it cannot keep,
// and `/` still gets the family dictionary through the Link header like every other
// HTML surface.
const HOMEPAGE_HEADERS = {
  "cache-control": "private, no-cache, must-revalidate",
  "link": HOMEPAGE_DISCOVERY_LINK,
};

function routeHomepage(request, env, ctx) {
  if (request.method === "HEAD") return homepageHeadResponse(request);
  if (wantsMarkdown(request)) return serveMarkdown(request, env);
  return serveStaticPage(request, env, { headers: HOMEPAGE_HEADERS });
}
