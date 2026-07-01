// _worker.js/index.js — request dispatcher + entry. The per-route handlers and
// shared helpers live in sibling modules; wrangler/Cloudflare bundle this
// directory at deploy (no build step). See MAINTENANCE.md for the route map.

import { handleAgentAuthClaim, handleAgentAuthRegister, handleAgentAuthRevoke, handleAgentAuthToken } from "./agent.js";
import { handleAround, handleAroundJson } from "./around.js";
import { handleBotPage } from "./bot.js";
import { homepageHeadResponse, serveHomepageWithPrerenderedTracks, serveMarkdown } from "./home.js";
import { handleLens, handleLensFetch, handleLensShot } from "./lens.js";
import { serveFreshAsset } from "./lib/assets.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { errorResp, wantsMarkdown } from "./lib/http.js";
import { withSecurityHeaders } from "./lib/security.js";
import { handleImagesFullIndex, handleImagesIndex, handleImagesManifest, servePhotoFromR2 } from "./photos.js";
import { handleReading } from "./reading.js";
import { handleRn, handleRnAdmin, handleRnSet, handleRnTracks } from "./rn.js";
import { handleSecurityCenter } from "./security.js";
import { handleSystemRestore, handleUpdatesJson, handleWindowsUpdate } from "./updates.js";
import { handleWhoareyou, handleWhoareyouJson } from "./whoareyou.js";
import { handleWritingIndex, handleWritingPost } from "./writing.js";

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

    // Workers Logs (observability): one compact structured line per request —
    // path / method / status / ms / country / bot — queryable + filterable in the
    // dashboard once observability is enabled on the Pages project. lean and fully
    // strippable: delete this wrapper (keep `return withSecurityHeaders(await
    // route(...))`) to revert. short keys keep each event tiny.
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
  }
};

async function route(request, env, ctx) {
    const url = new URL(request.url);

    // /favicon.ico — serve the inline traffic-cone SVG directly. without this,
    // legacy/bot probes for /favicon.ico SPA-fall-back to the full ~75KB homepage.
    // (modern browsers use the inline <link rel=icon> data-URI and never hit this.)
    if (url.pathname === "/favicon.ico") {
      return new Response(
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='4' y='25' width='24' height='3' rx='0.5' fill='#1a1a1a'/><path d='M 16 4 L 9 25 L 23 25 Z' fill='#ff6600'/><path d='M 11.3 18 L 20.7 18 L 21.7 21 L 10.3 21 Z' fill='#ffffff'/><path d='M 13.7 11 L 18.3 11 L 19 13 L 13 13 Z' fill='#ffffff'/></svg>`,
        { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }
      );
    }

    // agent-discovery docs (auth.md + the RFC 9727 api-catalog). these are
    // static files, but they're extensionless / iterated, and a long Cache-
    // Control once poisoned the read-through asset cache for the canonical URL
    // (a ?query bust returned fresh while the bare URL served a stale copy).
    // serve them through a per-request cache-bust so the canonical URL is
    // always the freshly-deployed bytes, with the right content-type + a short
    // edge cache. (the .json cards under /.well-known/ are extension-typed and
    // served straight from ASSETS.)
    if (url.pathname === "/auth.md") return serveFreshAsset(request, env, "text/markdown; charset=utf-8");
    if (url.pathname === "/.well-known/api-catalog") return serveFreshAsset(request, env, "application/linkset+json");
    if (url.pathname === "/.well-known/oauth-protected-resource") return serveFreshAsset(request, env, "application/json; charset=utf-8");
    if (url.pathname === "/.well-known/oauth-authorization-server") return serveFreshAsset(request, env, "application/json; charset=utf-8");
    if (url.pathname === "/agent/auth") return handleAgentAuthRegister(request);
    if (url.pathname === "/agent/auth/claim") return handleAgentAuthClaim(request);
    if (url.pathname === "/oauth2/token") return handleAgentAuthToken(request);
    if (url.pathname === "/oauth2/revoke") return handleAgentAuthRevoke(request);

    if (url.pathname === "/whoareyou") {
      return handleWhoareyou(request);
    }
    // fields-only JSON for the taskbar's System Properties popout (nav.js fetches
    // it on open). same data the /whoareyou page shows, minus all the prose.
    if (url.pathname === "/whoareyou.json") {
      return handleWhoareyouJson(request);
    }
    if (url.pathname === "/security") {
      return handleSecurityCenter(request);
    }
    if (url.pathname === "/reading") {
      return handleReading(request, env, ctx);
    }
    if (url.pathname === "/updates") {
      return handleWindowsUpdate(request, env);
    }
    // brief build + changelog JSON for the Windows Update tray balloon (nav.js)
    if (url.pathname === "/updates.json") {
      return handleUpdatesJson(request, env);
    }
    if (url.pathname === "/restore") {
      return handleSystemRestore(request, env);
    }
    // /lens — "the other web": see any URL the way a machine does.
    if (url.pathname === "/lens" || url.pathname === "/lens/") {
      return handleLens(request, env, ctx);
    }
    if (url.pathname === "/lens/fetch") {
      return handleLensFetch(request, env, ctx);
    }
    if (url.pathname === "/lens/shot") {
      return handleLensShot(request, env, ctx);
    }

    // /writing — the Notepad-view writing index + per-post pages. The .txt + posts.json
    // static assets (paths with a dot) fall through to ASSETS untouched, so the raw
    // canonical text is always fetchable too.
    if (url.pathname === "/writing" || url.pathname === "/writing/") {
      return handleWritingIndex(env, ctx);
    }
    if (url.pathname.startsWith("/writing/")) {
      const slug = url.pathname.slice("/writing/".length);
      if (slug && slug.indexOf("/") === -1 && slug.indexOf(".") === -1) {
        return handleWritingPost(slug, env, ctx);
      }
    }

    if (url.pathname === "/rn") {
      return handleRn(request, env);
    }

    if (url.pathname === "/rn/tracks") {
      return handleRnTracks(request, env, ctx);
    }

    if (url.pathname === "/rn/admin") {
      return handleRnAdmin(request, env);
    }

    if (url.pathname === "/rn/set") {
      return handleRnSet(request, env);
    }

    // NB: /coffee is owned by the standalone cal-aadhar-sh Worker (route
    // aadhar.sh/coffee*). It used to 302 to cal.com here while that worker was
    // unbuilt; the native booking app is deployed now, so this Pages worker no
    // longer touches /coffee — the Worker route serves it directly.

    if (url.pathname === "/bot") {
      return handleBotPage(request);
    }

    if (url.pathname === "/around") {
      return handleAround(request, env, ctx);
    }

    if (url.pathname === "/around/json") {
      return handleAroundJson(request, env, ctx);
    }

    // no-trailing-slash → with-slash for directory listings. without this,
    // relative links in the listing (href="01.jpg") resolve from the
    // document root and 404 back to home.
    if (url.pathname === "/images") {
      return Response.redirect(url.origin + "/images/" + url.search, 301);
    }
    if (url.pathname === "/images/full") {
      return Response.redirect(url.origin + "/images/full/" + url.search, 301);
    }

    // classic Apache-style directory listings (1999-vibe easter egg).
    // /images/      → enumerate thumbnails in the Pages static bundle
    // /images/full/ → enumerate R2 objects in the aadhar-photos bucket
    if (url.pathname === "/images/") {
      return handleImagesIndex(request, env, ctx);
    }
    if (url.pathname === "/images/full/") {
      return handleImagesFullIndex(request, env, ctx);
    }

    // manifest of available photos for the homepage grid. derived from
    // R2 keys (which preserve SOOC filenames). thumbnail names are
    // inferred by replacing the original extension with .avif / .jpg.
    if (url.pathname === "/images/manifest.json") {
      return handleImagesManifest(request, env, ctx);
    }

    // photo EXIF, generated locally by holding/scripts/extract-photo-metadata.sh
    // and committed as a static file. when absent, return empty JSON
    // rather than letting Pages SPA-fall back to index.html (which the
    // tooltip JS would then try to parse as JSON and fail).
    //
    // also overrides the cache-control: the /images/* rule in _headers
    // pins everything in that directory to 1-year immutable (correct for
    // content-addressed photos, wrong for this file which updates each
    // time photos are added/removed). short cache so changes propagate.
    if (url.pathname === "/images/metadata.json") {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "public, max-age=60, s-maxage=60, must-revalidate");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      try { await res.body?.cancel(); } catch {}
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type":  "application/json; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=60, must-revalidate",
        },
      });
    }

    // /images/meta/<stem>.json — per-photo EXIF for the hover tooltip.
    // same SPA-fallback hazard as metadata.json above, but worse: a
    // missing file would fall through to Pages' index.html fallback
    // (200 text/html) and the /images/* _headers rule would stamp it
    // 1-year immutable — poisoning that photo's tooltip in the browser
    // HTTP cache until META_V is bumped. guard: real JSON passes
    // through, anything else becomes an uncacheable 404.
    if (/^\/images\/meta\/[^/]+\.json$/i.test(url.pathname)) {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (ct.includes("json")) return res;
      try { await res.body?.cancel(); } catch {}
      return new Response('{"error":"not found"}', {
        status: 404,
        headers: {
          "content-type":  "application/json; charset=utf-8",
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    }

    // full-res photos live in R2 (aadhar-photos bucket, bound as
    // PHOTOS_R2). thumbnails stay inline in /images/ — they're tiny and
    // benefit from being on the same edge. only the chonky originals
    // get the R2 trip.
    if (url.pathname.startsWith("/images/full/")) {
      return servePhotoFromR2(request, env, ctx);
    }

    // /images/<stem>.<ext> thumbnail proxy. Cloudflare Pages's default
    // 404 response is `cache-control: max-age=14400`, which is fine for
    // truly-missing assets but catastrophic when a transient miss happens
    // during a deploy race — the edge then serves a stale 404 for 4 hours
    // even after the asset becomes available. We intercept here, pass to
    // Pages, and rewrite cache-control on any non-200 response so the
    // edge won't poison itself. Successful responses pass through with
    // Pages's normal long-cache (correct for content-addressed thumbs
    // because we bump THUMB_VERSION's `?v=N` on each deploy).
    // gate on CONTENT-TYPE, not res.ok: Cloudflare Pages' SPA fallback
    // returns a missing /images/* asset as a 200 text/html (index.html),
    // which would sail through an ok-check and get stamped with the
    // _headers 1-year immutable cache — poisoning that thumb URL at the
    // edge with homepage HTML until a THUMB_VERSION bump. a real thumb
    // always serves image/*; anything else becomes an uncacheable 404.
    if (/^\/images\/[^/]+\.(avif|jpe?g|png|gif|heic|heif|hif)$/i.test(url.pathname)) {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (res.ok && ct.startsWith("image/")) return res;
      try { await res.body?.cancel(); } catch {}
      return errorResp("not found", 404);
    }

    // markdown content negotiation: when an agent sends
    //   Accept: text/markdown
    // on the homepage, serve the hand-maintained index.md with
    //   Content-Type: text/markdown
    // and a rough x-markdown-tokens header. browsers asking for text/html
    // (or anything else) keep getting the HTML version as default —
    // with the music section pre-rendered for zero-flash arrival.
    // /index.html → / — the _headers no-store rule matches the literal "/"
    // path only, so serving the randomized homepage at this alias would let
    // browsers heuristically cache a page that's supposed to re-randomize
    // (and tick the counter) per visit. canonicalize instead.
    if (url.pathname === "/index.html") {
      url.pathname = "/";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/") {
      if (request.method === "HEAD") {
        return homepageHeadResponse(request);
      }
      if (wantsMarkdown(request)) {
        return serveMarkdown(request, env);
      }
      return serveHomepageWithPrerenderedTracks(request, env, ctx);
    }

    // everything else: serve the static asset that lives at this path
    return env.ASSETS.fetch(request);
}
