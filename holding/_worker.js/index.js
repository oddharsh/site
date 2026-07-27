// _worker.js/index.js: the dispatcher. Handlers live in sibling modules;
// wrangler bundles this directory at deploy (its build, not ours). The ROUTES
// and PREFIX tables below mirror wrangler.jsonc's allowlist one-to-one; keep
// them in sync or a route silently goes static. Map in MAINTENANCE.md.

import { WorkerEntrypoint } from "cloudflare:workers";
import calWorker from "../../cal/src/index.js";
import { handleAgentAuthClaim, handleAgentAuthRegister, handleAgentAuthRevoke, handleAgentAuthToken } from "./agent.js";
import { cronAround, handleAround, handleAroundChangesJson, handleAroundJson } from "./around.js";
import { handleBotPage } from "./bot.js";
import { cronCensus, handleCensus, handleCensusJson } from "./census.js";
import { handleCoffeeAvailability } from "./coffee.js";
import { handleHit } from "./counter.js";
import { homepageHeadResponse, serveHomepageWithPrerenderedTracks, serveMarkdown } from "./home.js";
import { countCrawlerHit, handleLedger, handleLedgerJson } from "./ledger.js";
import { handleLens, handleLensBrowser, handleLensCompare, handleLensFetch, handleLensShot } from "./lens.js";
import { serveAssetWith404Clamp, serveEncodingSelfTest, serveFreshAsset, servePrecompressedShell } from "./lib/assets.js";
import { BOT_UA } from "./lib/botauth.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { wantsMarkdown } from "./lib/http.js";
import { handleSiteMcp } from "./mcp.js";
import { withSecurityHeaders } from "./lib/security.js";
import { getThumbHashes, handleImagesManifest, handlePhotoQuery, handlePhotos, servePhotoFromR2 } from "./photos.js";
import { handleReading } from "./reading.js";
import { handleRun } from "./run.js";
import { handleRn, handleRnAdmin, handleRnSet, handleRnTracks, handleRnTracksHtml } from "./rn.js";
import { handleSearch, handleSearchJson } from "./search.js";
import { handleSecurityCenter } from "./security.js";
import { handleSystemRestore, handleUpdatesJson, handleWindowsUpdate } from "./updates.js";
import { handleWhoareyou, handleWhoareyouJson } from "./whoareyou.js";
import { handleWritingIndex, handleWritingPost } from "./writing.js";
import { handleLlmsFull } from "./x402.js";
import { handleSerendipity, withSerendipitySecurityHeaders } from "../../serendipity/serendipity.js";

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
    if (event.cron === "17 8 * * 1") {
      ctx.waitUntil(cronCensus(env));   // Mondays 08:17 UTC — the longitudinal census
    } else {
      ctx.waitUntil(cronAround(env));   // */30 — the neighborhood crawl
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
  ["/updates", handleWindowsUpdate],
  ["/updates.json", handleUpdatesJson],
  ["/restore", handleSystemRestore],

  ["/lens", handleLens],
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

  ["/writing", handleWritingIndex],
  ["/writing/", routeDropSlash],

  ["/rn", handleRn],
  ["/rn/tracks", handleRnTracks],
  ["/rn/tracks.html", handleRnTracksHtml],
  ["/rn/admin", handleRnAdmin],
  ["/rn/set", handleRnSet],

  ["/bot", handleBotPage],
  ["/around", handleAround],
  ["/around/json", handleAroundJson],
  ["/around/changes.json", handleAroundChangesJson],

  ["/photos", handlePhotos],
  ["/photos/", routePhotosRedirect],
  ["/photos/query.json", handlePhotoQuery],
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
  // temporary: isolates whether the double compression comes from the static-assets
  // layer or from every worker response. Remove once gotcha 13 is settled.
  ["/encoding-test", (request) => serveEncodingSelfTest(request)],

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
  {
    label: "/a/<asset>",
    match: (pathname) => /^\/a\/[^/]+\.[0-9a-f]{8}\.(js|css|svg)$/.test(pathname),
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
  const exact = ROUTES.get(url.pathname);
  if (exact) return exact(request, env, ctx, url);

  for (const r of PREFIX) {
    if (r.match(url.pathname)) return r.handle(request, env, ctx, url);
  }

  // Static is the default: garage/lwe/cars/shell JS/discovery files fall through
  // to Workers static assets without a bespoke dispatcher branch.
  return env.ASSETS.fetch(request);
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

function routeWritingPost(request, env, ctx, url) {
  const slug = url.pathname.slice("/writing/".length);
  return handleWritingPost(request, slug, env, ctx);
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

function routeHomepage(request, env, ctx) {
  if (request.method === "HEAD") return homepageHeadResponse(request);
  if (wantsMarkdown(request)) return serveMarkdown(request, env);
  return serveHomepageWithPrerenderedTracks(request, env, ctx);
}
