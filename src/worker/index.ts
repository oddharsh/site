import { hit, Counter } from "./counter";
import { assetRequest, json, prefersMarkdown, redirect, text, withSiteHeaders } from "./http";
import { previewRefusal } from "./preview";
import { BookingWorkflow } from "./workflow";
import { requestDetailsHtml, requestProfile } from "./whoareyou";
import { terminalTool } from "./tools";
import { aroundChanges, aroundJson, aroundResponse, countCrawler, ledgerJson, ledgerResponse, readingResponse } from "./live";
import { photoQuery } from "./photos";
import { rnMarkdown, rnRedirect, rnTracks, rnTracksHtml } from "./rn";
import { lensBrowser, lensCompare, lensFetch, lensPage, lensShot } from "./lens";
import { coffeeAvailability, coffeeBook, coffeeDecision, coffeePage, coffeeSlots } from "./coffee";
import { retiredSerendipityWrite, serendipityEvent, serendipityEventsJson, serendipityMcp, serendipityPage } from "./serendipity";
import { censusJson, censusPage, inboxPage, utilityPage } from "./utilities";
import { siteMcp } from "./mcp";
import { decideWebmention, receiveWebmention } from "./webmention";
import { runScheduled } from "./scheduled";

export { BookingWorkflow, Counter };

const markdownPages = new Set([
  "/", "/photos", "/writing", "/garage", "/lwe",
  "/access", "/bot", "/pixel-peeper", "/security", "/terminal", "/whoareyou", "/updates", "/restore",
  "/coffee",
  "/serendipity",
]);

const utilityPages = new Set(["finger", "radar", "dict", "cache", "encode", "agent-ready"]);

function markdownPath(pathname: string): string {
  return pathname === "/" ? "/index.md" : `${pathname}.md`;
}

function isAuthoredPage(pathname: string): boolean {
  return markdownPages.has(pathname)
    || pathname.startsWith("/writing/")
    || pathname.startsWith("/garage/")
    || pathname.startsWith("/lwe/");
}

async function asset(request: Request, env: Env, pathname = new URL(request.url).pathname): Promise<Response> {
  return env.ASSETS.fetch(assetRequest(request, pathname));
}

async function fetchHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const preview = previewRefusal(request);
  if (preview) return preview;

  const url = new URL(request.url);
  const { pathname } = url;

  // The former calendar Worker also lived at cal.aadhar.sh. Keep that public
  // hostname as a thin canonical redirect while one implementation owns every
  // booking path and all new links point at /coffee.
  if (url.hostname === "cal.aadhar.sh") {
    const suffix = pathname.startsWith("/coffee") ? pathname.slice("/coffee".length) || "/" : pathname;
    const target = new URL(`/coffee${suffix === "/" ? "" : suffix}${url.search}`, "https://aadhar.sh");
    return Response.redirect(target, 308);
  }

  if (request.method === "POST" && pathname === "/coffee/book") return coffeeBook(request, env, ctx);
  if (pathname === "/webmention") return receiveWebmention(request, env, ctx);
  if (pathname === "/webmention/approve") return decideWebmention(request, env, "approve");
  if (pathname === "/webmention/decline") return decideWebmention(request, env, "decline");
  if (pathname === "/mcp") return siteMcp(request, env, ctx);
  if (pathname === "/serendipity/mcp") return serendipityMcp(request, env);
  if (["/serendipity/sync", "/serendipity/sync-descriptions", "/serendipity/enrich", "/serendipity/cookies", "/serendipity/add-event", "/serendipity/cover"].includes(pathname)) return retiredSerendipityWrite();

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  if (pathname === "/index.html") return redirect(request, "/");
  if (pathname !== "/" && pathname.endsWith("/")) return redirect(request, pathname.slice(0, -1));
  if (pathname === "/favicon.ico") return asset(request, env, "/favicon.svg");
  if (pathname === "/hit") return hit(request, env, ctx);
  const tool = terminalTool(request);
  if (tool) return tool;

  if (isAuthoredPage(pathname) && prefersMarkdown(request)) {
    const response = await asset(request, env, markdownPath(pathname));
    if (response.ok) return withSiteHeaders(response, request);
  }

  if (pathname === "/whoareyou.json") {
    const profile = requestProfile(request, env);
    return json({
      ...profile,
      servedAt: new Date().toISOString(),
      version: env.CF_VERSION_METADATA?.id ?? null,
      retention: "none",
    }, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  if (pathname === "/lens/fetch") return lensFetch(request, env);
  if (pathname === "/lens/browser") return lensBrowser(request, env);
  if (pathname === "/lens/shot") return lensShot(request, env);
  if (pathname === "/lens/compare.json") return lensCompare(request, env);
  if (pathname === "/lens/census.json") return censusJson(env);
  if (pathname === "/lens/census") return censusPage(request, env);
  if (pathname === "/lens") return lensPage(request, env);
  if (pathname === "/coffee/availability.json") return coffeeAvailability(env, ctx);
  if (pathname === "/coffee/slots") return coffeeSlots(env, ctx);
  if (pathname === "/coffee/approve") return coffeeDecision(request, env, "approve");
  if (pathname === "/coffee/decline") return coffeeDecision(request, env, "decline");
  if (pathname === "/coffee") return coffeePage(request, env, ctx);
  if (pathname === "/serendipity/events.json") return serendipityEventsJson(env, request);
  if (pathname.startsWith("/serendipity/event/")) return serendipityEvent(request, env, decodeURIComponent(pathname.slice("/serendipity/event/".length)));
  if (pathname === "/serendipity") return serendipityPage(request, env);
  if (pathname === "/inbox") return inboxPage(request, env);
  if (utilityPages.has(pathname.slice(1))) return utilityPage(request, env, pathname.slice(1));

  if (pathname === "/reading") return readingResponse(request, env);
  if (pathname === "/around") return aroundResponse(request, env);
  if (pathname === "/around/json") return aroundJson(env);
  if (pathname === "/around/changes.json") return aroundChanges(env, url.searchParams.get("limit"));
  if (pathname === "/ledger") return ledgerResponse(request, env);
  if (pathname === "/ledger.json") return ledgerJson(env);
  if (pathname === "/photos/query.json") return photoQuery(request, env);
  if (pathname === "/rn/admin") return text("forbidden\n", { status: 403, headers: { "cache-control": "no-store" } });
  if (pathname === "/rn/tracks") return rnTracks(env);
  if (pathname === "/rn/tracks.html") return rnTracksHtml(env);
  if (pathname === "/rn.md" || (pathname === "/rn" && prefersMarkdown(request))) return rnMarkdown(env);
  if (pathname === "/rn") return rnRedirect(env);

  if (pathname === "/search.json") {
    const response = await asset(request, env, "/search-index.json");
    const records = await response.json<Array<{ path: string; title: string; description: string; section: string }>>();
    const query = url.searchParams.get("q")?.trim().toLowerCase().slice(0, 120) ?? "";
    const terms = query.split(/\s+/).filter(Boolean);
    const results = records.filter((record) => terms.every((term) => `${record.title} ${record.description} ${record.section}`.toLowerCase().includes(term))).slice(0, 50);
    return json({ query, count: results.length, results }, { headers: { "cache-control": "public, max-age=60" } });
  }

  if (pathname === "/run") {
    const command = url.searchParams.get("cmd")?.trim().replace(/^\//, "") ?? "";
    if (command) {
      const indexResponse = await asset(request, env, "/search-index.json");
      const records = await indexResponse.json<Array<{ path: string; title: string }>>();
      const match = records.find((record) => record.path.slice(1) === command || record.title.toLowerCase() === command.toLowerCase());
      if (match) return redirect(request, match.path, 302);
      const response = await asset(request, env, "/run");
      const transformed = new HTMLRewriter().on(".document header", {
        element(element) { element.after(`<p class="command-error">Windows cannot find “${command.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}”. Check the spelling and try again.</p>`, { html: true }); },
      }).transform(response);
      return withSiteHeaders(transformed, request);
    }
  }

  if (pathname === "/whoareyou") {
    const profile = requestProfile(request, env);
    const response = await asset(request, env);
    const transformed = new HTMLRewriter()
      .on("#request-details", {
        element(element) { element.setInnerContent(requestDetailsHtml(profile.groups), { html: true }); },
      })
      .transform(response);
    const secured = withSiteHeaders(transformed, request);
    secured.headers.set("cache-control", "no-store");
    secured.headers.set("x-robots-tag", "noindex");
    return secured;
  }

  if (pathname.startsWith("/images/full/")) {
    const key = decodeURIComponent(pathname.slice("/images/full/".length));
    if (!key || key.includes("..")) return text("not found\n", { status: 404 });
    const object = await env.PHOTOS_R2.get(key, { range: request.headers });
    if (!object) return text("not found\n", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(object.body, { status: object.range ? 206 : 200, headers });
  }

  if (["/images", "/images/full"].includes(pathname)) return redirect(request, "/photos");

  const legacyThumb = pathname.match(/^\/images\/([A-Za-z0-9._-]+?)(-400)?\.(avif|jpe?g)$/i);
  if (legacyThumb) {
    const [, stem, small, extension] = legacyThumb;
    const response = await asset(request, env, "/images/hashes.json");
    const hashes = await response.json<Record<string, { a?: string; j?: string; s?: string }>>();
    const hash = small ? hashes[stem]?.s : extension.toLowerCase() === "avif" ? hashes[stem]?.a : hashes[stem]?.j;
    if (hash) return redirect(request, `/i/${stem}${small ?? ""}.${hash}.${extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase()}`);
  }

  const response = await asset(request, env);
  const headers = new Headers(response.headers);
  if (pathname === "/.well-known/api-catalog") headers.set("content-type", "application/linkset+json; charset=utf-8");
  if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-authorization-server") {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return withSiteHeaders(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }), request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const response = await fetchHandler(request, env, ctx);
      countCrawler(env, request, response, ctx);
      return response;
    } catch (error: unknown) {
      console.error("request failed", { path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) });
      return text("internal error\n", { status: 500, headers: { "cache-control": "no-store" } });
    }
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(controller.cron, env).catch((error) => console.error("scheduled task failed", { cron: controller.cron, error: error instanceof Error ? error.message : String(error) })));
  },
} satisfies ExportedHandler<Env>;
