// _worker.js/index.js: the dispatcher. Handlers live in sibling modules;
// wrangler bundles this directory at deploy (its build, not ours). The ROUTES
// and PREFIX tables below mirror wrangler.jsonc's allowlist one-to-one; keep
// them in sync or a route silently goes static. Map in MAINTENANCE.md.

import { handleAgentAuthClaim, handleAgentAuthRegister, handleAgentAuthRevoke, handleAgentAuthToken } from "./agent.js";
import { cronAround, handleAround, handleAroundJson } from "./around.js";
import { handleBotPage } from "./bot.js";
import { handleHitSvg } from "./counter.js";
import { homepageHeadResponse, serveHomepageWithPrerenderedTracks, serveMarkdown } from "./home.js";
import { handleLens, handleLensFetch, handleLensShot } from "./lens.js";
import { serveAssetWith404Clamp, serveFreshAsset } from "./lib/assets.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { wantsMarkdown } from "./lib/http.js";
import { withSecurityHeaders } from "./lib/security.js";
import { getThumbHashes, handleImagesManifest, handlePhotos, servePhotoFromR2 } from "./photos.js";
import { handleReading } from "./reading.js";
import { handleRun } from "./run.js";
import { handleRn, handleRnAdmin, handleRnSet, handleRnTracks } from "./rn.js";
import { handleSecurityCenter } from "./security.js";
import { handleSystemRestore, handleUpdatesJson, handleWindowsUpdate } from "./updates.js";
import { handleWhoareyou, handleWhoareyouJson } from "./whoareyou.js";
import { handleWritingIndex, handleWritingPost } from "./writing.js";
import { handleLlmsFull } from "./x402.js";

// the homepage visit-counter Durable Object, hosted in-house (see counter.js).
// must be a named export of the entry so the COUNTER binding can resolve it.
export { Counter } from "./counter.js";

export default {
  async fetch(request, env, ctx) {
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

    // Workers Logs: one structured line per worker-owned request (path, method,
    // status, ms, country, bot), filterable in the dashboard. Edge-direct traffic
    // never reaches this code, so it never logs. Strippable: delete the wrapper,
    // keep `return withSecurityHeaders(await route(...))`.
    const t0 = Date.now();
    const response = await route(request, env, ctx);
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
  },

  // cron (wrangler.jsonc "triggers"): the /around crawl runs here, per
  // generation, so the request path stays a pure KV read and the page is
  // safe to prerender. One schedule today; switch on event.cron if more land.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronAround(env));
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
  ["/.well-known/oauth-protected-resource", routeOAuthProtectedResource],
  ["/.well-known/oauth-authorization-server", routeOAuthAuthorizationServer],
  ["/agent/auth", handleAgentAuthRegister],
  ["/agent/auth/claim", handleAgentAuthClaim],
  ["/oauth2/token", handleAgentAuthToken],
  ["/oauth2/revoke", handleAgentAuthRevoke],

  ["/hit.svg", handleHitSvg],

  ["/whoareyou", handleWhoareyou],
  ["/whoareyou.json", handleWhoareyouJson],
  ["/security", handleSecurityCenter],
  ["/reading", handleReading],
  ["/updates", handleWindowsUpdate],
  ["/updates.json", handleUpdatesJson],
  ["/restore", handleSystemRestore],

  ["/lens", handleLens],
  ["/lens/", handleLens],
  ["/lens/fetch", handleLensFetch],
  ["/lens/shot", handleLensShot],

  // the x402 bot paywall: llms.txt's map is free, the full corpus costs $0.01
  // by machine payment (ungated until X402_PAY_TO is set).
  ["/llms-full.txt", handleLlmsFull],

  ["/writing", handleWritingIndex],
  ["/writing/", handleWritingIndex],

  ["/rn", handleRn],
  ["/rn/tracks", handleRnTracks],
  ["/rn/admin", handleRnAdmin],
  ["/rn/set", handleRnSet],

  ["/bot", handleBotPage],
  ["/around", handleAround],
  ["/around/json", handleAroundJson],

  ["/photos", handlePhotos],
  ["/photos/", routePhotosRedirect],
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
];

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const exact = ROUTES.get(url.pathname);
  if (exact) return exact(request, env, ctx, url);

  for (const r of PREFIX) {
    if (r.match(url.pathname)) return r.handle(request, env, ctx, url);
  }

  // Static is the default: garage/lwe/cars/shell JS/discovery files fall through
  // to Workers static assets without a bespoke dispatcher branch.
  return env.ASSETS.fetch(request);
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

function routeOAuthProtectedResource(request, env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routeOAuthAuthorizationServer(request, env) {
  return serveFreshAsset(request, env, "application/json; charset=utf-8");
}

function routePhotosRedirect(_request, _env, _ctx, url) {
  return Response.redirect(url.origin + "/photos", 301);
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
