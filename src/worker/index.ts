import { hit, Counter } from "./counter";
import { assetRequest, json, prefersMarkdown, redirect, text, withSiteHeaders } from "./http";
import { previewRefusal } from "./preview";
import { BookingWorkflow } from "./workflow";

export { BookingWorkflow, Counter };

const markdownPages = new Set([
  "/", "/photos", "/writing", "/garage", "/lwe",
  "/security", "/whoareyou", "/updates", "/restore", "/access",
]);

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

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  if (pathname === "/index.html") return redirect(request, "/");
  if (pathname !== "/" && pathname.endsWith("/")) return redirect(request, pathname.slice(0, -1));
  if (pathname === "/favicon.ico") return asset(request, env, "/favicon.svg");
  if (pathname === "/hit") return hit(request, env, ctx);

  if (isAuthoredPage(pathname) && prefersMarkdown(request)) {
    const response = await asset(request, env, markdownPath(pathname));
    if (response.ok) return withSiteHeaders(response, request);
  }

  if (pathname === "/whoareyou.json") {
    const cf = request.cf ?? {};
    return json({
      request: {
        ip: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
        acceptLanguage: request.headers.get("accept-language"),
        referer: request.headers.get("referer"),
        dnt: request.headers.get("dnt") === "1",
      },
      edge: {
        colo: cf.colo ?? null,
        country: cf.country ?? null,
        region: cf.region ?? null,
        city: cf.city ?? null,
        timezone: cf.timezone ?? null,
        asn: cf.asn ?? null,
        organization: cf.asOrganization ?? null,
        httpProtocol: cf.httpProtocol ?? null,
        tlsVersion: cf.tlsVersion ?? null,
      },
      servedAt: new Date().toISOString(),
      version: env.CF_VERSION_METADATA?.id ?? null,
      retention: "none",
    }, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
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

  const response = await asset(request, env);
  return withSiteHeaders(response, request);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return fetchHandler(request, env, ctx).catch((error: unknown) => {
      console.error("request failed", { path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) });
      return text("internal error\n", { status: 500, headers: { "cache-control": "no-store" } });
    });
  },
} satisfies ExportedHandler<Env>;
