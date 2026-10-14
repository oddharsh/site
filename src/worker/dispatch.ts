// The site Worker's request PIPELINE, as a module anything can import.
//
// It lived in index.ts until 2026-10-02, and index.ts imports
// `cloudflare:workers` (gotcha 16), so the order above could only be pinned by
// comparing `indexOf` offsets in its source text. Here a test hands in fake
// handlers and a fake env.ASSETS and watches what a request does
// (contract-the-dispatch-pipeline).
import type { Env, SiteRequest } from "./lib/env.ts";
import { ALBUMS, albumPath, type Album } from "./albums.ts";
import { withBotPolicyCache } from "./lib/botauth.ts";
import { shouldUseWorkersCache } from "./lib/cache.ts";
import { CANONICAL_HOST, isCanonicalHost } from "./lib/const.ts";
import { apiPreflight, withApiContract } from "./lib/api-contract.ts";
import { earlyDataDenial } from "./lib/early-data.ts";
import { mcpEraOf } from "./lib/mcp-protocol.ts";
import { countMiss, recoverNotFound } from "./lib/not-found.ts";
import { isCallable } from "./lib/parse.ts";
import { isPreviewHost, previewDenial } from "./lib/preview.ts";
import { withSecurityHeaders } from "./lib/security.ts";
import { span } from "./lib/trace.ts";
import { countCrawlerHit } from "./ledger.ts";
import { countSpeculativeLoad } from "./speculation.ts";
import { CACHEABLE_PATHS, CAL_HOST, EXACT_ROUTES, PREFIX_ROUTES, SELF_FETCH_PATHS, type ExactPath, type PrefixLabel } from "./routes.ts";

export type RouteHandler = (request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) => Response | Promise<Response>;

export type DispatchHandlers = {
  exact: Record<ExactPath, RouteHandler>;
  prefix: Record<PrefixLabel, RouteHandler>;
  album: (album: Album, request: SiteRequest, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  calHost: RouteHandler;
};

// The predicate itself moved to lib/cache.js so it can be unit-tested. That is the
// actual lesson here: it was a private function in index.ts, which cannot
// be imported under plain node (see gotcha 16), and so nothing in the 78-test suite
// could reach it. The bug shipped through a green CI.
// Derived from routes.ts's `cacheable` flags since 2026-10-02.
export const isEdgeCacheable = (request: Request): boolean => shouldUseWorkersCache(request, CACHEABLE_PATHS);

export function createDispatch(handlers: DispatchHandlers) {
  const withSelfFetchHandler = (handle: RouteHandler): RouteHandler =>
    (request, env, ctx, url) =>
      handle(request, env.SELF_FETCH === null ? env : withSelfFetch(env, ctx), ctx, url);

  const need = (handle: RouteHandler, id: string): RouteHandler => {
    if (!isCallable(handle)) throw new Error(`dispatch: no handler for ${id}`);
    return handle;
  };

  const exactRoutes = new Map<string, RouteHandler>();
  for (const { path } of EXACT_ROUTES) {
    const handle = need(handlers.exact[path], path);
    exactRoutes.set(path, SELF_FETCH_PATHS.has(path) ? withSelfFetchHandler(handle) : handle);
  }
  for (const album of Object.values(ALBUMS)) {
    exactRoutes.set(albumPath(album), (request, env, ctx) => handlers.album(album, request, env, ctx));
    exactRoutes.set(`${albumPath(album)}/`, (_request, _env, _ctx, url) => Response.redirect(url.origin + albumPath(album), 301));
  }
  const prefixRoutes = PREFIX_ROUTES.map((r) => ({ label: r.label, match: r.match, handle: need(handlers.prefix[r.label], r.label) }));

  function withSelfFetch(env: Env, ctx: ExecutionContext) {
    return {
      ...env,
      SELF_FETCH: async (req) =>
        withSecurityHeaders(await route(req, { ...env, SELF_FETCH: null, IDENTITY_BODY: true }, ctx)),
    };
  }

  async function serveWorkerRequest(request: SiteRequest, env: Env, ctx: ExecutionContext) {
    env = withBotPolicyCache(env);
    const url = new URL(request.url);

    const onPreview = isPreviewHost(url.hostname);
    if (onPreview) {
      const denied = previewDenial(url.pathname, request.method);
      if (denied) return denied;
    }

    const tooEarly = earlyDataDenial(request, url.pathname);
    if (tooEarly) return tooEarly;

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

    // Asking via `accept-encoding: identity` would NOT work: the precompressed page
    // path deliberately never consults that header (gotcha 13 — the edge rewrites it
    // to a constant, so branching on it is dead code). A flag on the child env is
    // also the safer seam, because env is not caller-controllable and no external
    // request can ask production to stop serving its precompressed bodies.
    const t0 = Date.now();
    const onApiHost = url.hostname !== CAL_HOST.host;
    let response = (onApiHost ? await apiPreflight(request, url.pathname, env) : null) ?? await route(request, env, ctx);
    if (response.status === 404 && (request.method === "GET" || request.method === "HEAD") && url.hostname !== CAL_HOST.host) {
      const miss = await recoverNotFound(request, env, response);
      countMiss(env, request, url.pathname, miss);
      response = miss.response;
    }
    if (onApiHost) response = withApiContract(response, url.pathname);
    countCrawlerHit(env, request, response, url.pathname);
    countSpeculativeLoad(env, request, response, url.pathname);
    const mcpEra = mcpEraOf(request);
    try {
      console.log(JSON.stringify({
        p: url.pathname,
        m: request.method,
        s: response.status,
        ms: Date.now() - t0,
        v: env.CF_VERSION_METADATA?.id?.slice(0, 8),
        co: request.cf?.country,
        bot: request.cf?.botManagement?.verifiedBot || undefined,
        h: request.cf?.httpProtocol,
        mcp: mcpEra?.era,
        mv: mcpEra?.version,
        mc: mcpEra?.client,
      }));
    } catch {}
    return withSecurityHeaders(response, url.pathname, { noindex: !isCanonicalHost(url.hostname) });
  }

  async function route(request: SiteRequest, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.hostname === CAL_HOST.host) return handlers.calHost(request, env, ctx, url);

    const exact = exactRoutes.get(url.pathname);
    if (exact) return dispatchTraced(url.pathname, "exact", exact, request, env, ctx, url);

    for (const r of prefixRoutes) {
      if (r.match(url.pathname)) return dispatchTraced(r.label, "prefix", r.handle, request, env, ctx, url);
    }

    return env.ASSETS.fetch(request);
  }

  return { route, serveWorkerRequest, withSelfFetch };
}

function dispatchTraced(template: string, kind: string, handle: RouteHandler, request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  return span(
    `route ${template}`,
    async (s) => {
      const signal: AbortSignal | undefined = request.signal;
      const listening = signal instanceof EventTarget;
      let hungUp = false;
      const onAbort = () => { hungUp = true; };
      if (listening) signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await handle(request, env, ctx, url);
        s.setAttribute("http.response.status_code", response.status);
        // Recorded as a real boolean and SKIPPED entirely when there is no
        // signal to read, which is the attribute discipline working in both
        // directions: absent means the instrument is not there, false means it
        // is there and the visitor stayed. Emitting only the true case would
        // make a flag that silently stopped working read as a site nobody ever
        // abandons, which is the failure shape gotcha 36 already cost twice.
        //
        // `signal.aborted` is read beside the listener rather than instead of
        // it, because a signal already aborted on arrival never fires an abort
        // event and the listener alone would miss it. What neither catches is a
        // hang-up AFTER the handler settles, since the span ends with this
        // callback. That is out of scope on purpose: the question is wasted work.
        if (listening) s.setAttribute("route.aborted", hungUp || signal?.aborted === true);
        return response;
      } finally {
        if (listening) signal?.removeEventListener("abort", onAbort);
      }
    },
    {
      "http.request.method": request.method,
      "route.template": template,
      "route.kind": kind,
      "route.self_fetch": env.SELF_FETCH ? undefined : true,
    },
  );
}
