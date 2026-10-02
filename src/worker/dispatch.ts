// The site Worker's request PIPELINE, as a module anything can import.
//
// createDispatch(handlers) returns what index.ts wires into the runtime. A
// request meets, in this order: the preview guard, the early-data guard, the
// .pages.dev redirect, the cal.aadhar.sh hand-off, the exact routes, the prefix
// routes in routes.ts's order, the asset layer, the 404 recovery arm, the two
// ledgers, the per-request log line, and the security headers. The route FACTS
// are routes.ts's; this module owns the order and what happens around a handler.
//
// It lived in index.ts until 2026-10-02, and index.ts imports
// `cloudflare:workers` (gotcha 16), so the order above could only be pinned by
// comparing `indexOf` offsets in its source text. Here a test hands in fake
// handlers and a fake env.ASSETS and watches what a request does
// (contract-the-dispatch-pipeline).
//
// The handlers arrive by injection, the way lib/trace.ts receives its tracer:
// index.ts is the one module that may import every handler (cal's among them,
// which reaches `cloudflare:workers` too), so it binds one per route id and
// this module never imports a page.
import type { Env, SiteRequest } from "./lib/env.ts";
import { ALBUMS, albumPath, type Album } from "./albums.ts";
import { withBotPolicyCache } from "./lib/botauth.ts";
import { shouldUseWorkersCache } from "./lib/cache.ts";
import { CANONICAL_HOST, isCanonicalHost } from "./lib/const.ts";
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

// A worker-owned route handler, as dispatchTraced() calls one. This was a
// `@typedef` a .ts file ignores, so the route table it typed fell back to the
// `Function` its annotation named — a precise signature documented and an
// imprecise one enforced. index.ts's handler maps are typed with it.
export type RouteHandler = (request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) => Response | Promise<Response>;

// What index.ts hands over. The two tables are Records over routes.ts's id
// unions, so a route with no handler and a handler with no route are both
// compile errors at index.ts's declaration.
export type DispatchHandlers = {
  exact: Record<ExactPath, RouteHandler>;
  prefix: Record<PrefixLabel, RouteHandler>;
  // one generated page per album (albums.ts); the slashed twin's 301 is built here
  album: (album: Album, request: SiteRequest, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  // everything arriving on cal.aadhar.sh, before any table is consulted
  calHost: RouteHandler;
};

// Workers Cache only fronts responses whose route contract is already public
// and reusable. Keep index.ts's default export as an uncached gateway: it handles
// mutations, per-visitor views, and arbitrary inspection targets.
// Query strings are excluded deliberately so owner bust tokens and future
// query-bearing features cannot accidentally become shared cache keys.
//
// `/` joined the set on 2026-07-31, when it stopped being a per-request document
// and picked up PAGE_CACHE_CONTROL. It is the highest-traffic entry here and the
// one route where skipping the worker matters most, because the cold external
// arrival is the single navigation no speculation rule can prerender.
//
// The hazard worth naming, since a wrong answer here is a white screen rather
// than a slow page: these routes can answer `content-encoding: dcz`, and handing
// a delta to a client that lacks the dictionary is ERR_CONTENT_DECODING_FAILED.
// Safety rests on the cache honouring `vary: accept-encoding, available-dictionary`.
// VERIFIED against production 2026-07-31 on /lens, which was already in this set:
// priming with the family dictionary cached a 13,983 B dcz, a no-dictionary client
// then MISSed and cached its own 15,047 B brotli, and the dictionary client came
// back to a HIT of its own variant. Two entries, no crossover. Re-run that probe
// before adding any dcz-capable route here.
//
// Note the if-none-match bail in shouldUseWorkersCache: a returning visitor
// revalidates and therefore always reaches the worker. That is correct (a 304 needs
// the validator compared) and it bounds what this buys to first-contact requests.
//
// A SECOND axis the cache key cannot see, learned in production the same day `/`
// joined this set: a route here may answer more than one media type at one URL.
// `Accept: text/markdown` on `/` came back as HTML off a cache HIT, because the
// stored HTML says `vary: accept-encoding, available-dictionary` and nothing about
// `accept`. The predicate now bails on a negotiated request; the reasoning and the
// production evidence are in lib/cache.js, next to the code.
//
// A THIRD axis, and the same shape a third time: the HOST. Three hostnames reach
// this Worker and only one is the site, but a hit answers before the dispatcher,
// so cal.aadhar.sh's 404 and a preview's noindex were both being skipped.
// Measured on production 2026-08-08: cal.aadhar.sh/reading served the canonical
// 91,980-byte page at the same cache `age` as aadhar.sh/reading, on a host whose
// origin 404s it. The predicate bails off the canonical host now.
//
// Worth stating as a rule rather than three fixes: THIS CACHE ANSWERS BEFORE
// EVERY DECISION MADE BELOW IT. Anything the dispatcher varies on that the key
// cannot see needs a bail here — and the key sees the path and nothing else.
//
// The predicate itself moved to lib/cache.js so it can be unit-tested. That is the
// actual lesson here: it was a private function in index.ts, which cannot
// be imported under plain node (see gotcha 16), and so nothing in the 78-test suite
// could reach it. The bug shipped through a green CI.
// Derived from routes.ts's `cacheable` flags since 2026-10-02.
export const isEdgeCacheable = (request: Request): boolean => shouldUseWorkersCache(request, CACHEABLE_PATHS);

export function createDispatch(handlers: DispatchHandlers) {
  // Lens and MCP dispatch back into this Worker. Building that derived env
  // in serveWorkerRequest made every favicon, redirect, JSON endpoint and static
  // page copy the whole binding object for a callback it could never call. Keep
  // the capability at the routes that consume it instead (routes.ts
  // `selfFetch`). A null marker means the request is the inner self-dispatch
  // and must not be armed again. Seven
  // alternating 1000-request in-process harness trials on 2026-09-01 moved the
  // median from 1674.83ms to 1594.44ms; the paired median saved 68.66ms (4.1%),
  // with the candidate winning five of seven pairs.
  const withSelfFetchHandler = (handle: RouteHandler): RouteHandler =>
    (request, env, ctx, url) =>
      handle(request, env.SELF_FETCH === null ? env : withSelfFetch(env, ctx), ctx, url);

  // The types already refuse a missing handler. This repeats it at isolate init
  // because the failure it guards is silent: a route with no handler would fall
  // through to the asset layer and serve static.
  const need = (handle: RouteHandler, id: string): RouteHandler => {
    if (!isCallable(handle)) throw new Error(`dispatch: no handler for ${id}`);
    return handle;
  };

  const exactRoutes = new Map<string, RouteHandler>();
  for (const { path } of EXACT_ROUTES) {
    const handle = need(handlers.exact[path], path);
    exactRoutes.set(path, SELF_FETCH_PATHS.has(path) ? withSelfFetchHandler(handle) : handle);
  }
  // one page per album (albums.ts), generated at deploy like /photos, with the
  // dynamic handler as the 404 fallback and the slashed twin 301ing to it
  for (const album of Object.values(ALBUMS)) {
    exactRoutes.set(albumPath(album), (request, env, ctx) => handlers.album(album, request, env, ctx));
    exactRoutes.set(`${albumPath(album)}/`, (_request, _env, _ctx, url) => Response.redirect(url.origin + albumPath(album), 301));
  }
  // Walked in routes.ts's order, which is load-bearing (its PREFIX_ROUTES header).
  const prefixRoutes = PREFIX_ROUTES.map((r) => ({ label: r.label, match: r.match, handle: need(handlers.prefix[r.label], r.label) }));

  // The self-dispatcher itself, factored out because the CRON needs it too and a
  // second copy is how the two drift. `scheduled()` has no request to build one
  // from, and webmention-send's outbound half reads this site's own pages: a plain
  // fetch() there is the error-1042 recursion perf-probe.js already documents.
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

    // Workers preview URLs (see lib/preview.js). A preview serves the real site
    // from a *.workers.dev host on PRODUCTION bindings and secrets, so writes are
    // refused and every response is marked noindex. Reads pass straight through,
    // which is what the URL is for. Deliberately ABOVE the .pages.dev arm and
    // everything else: a guard that runs after routing has already lost.
    const onPreview = isPreviewHost(url.hostname);
    if (onPreview) {
      const denied = previewDenial(url.pathname, request.method);
      if (denied) return denied;
    }

    // 0-RTT: a request that arrived as TLS early data is replayable, so the
    // GET-shaped writes answer 425 and the client retries after the handshake.
    // Same position as the preview guard, and for the same reason: a guard that
    // runs after routing has already lost (lib/early-data.ts).
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

    // SELF_FETCH — how /lens reads our own hostname without lying about it.
    // A plain fetch("https://aadhar.sh/") from inside this worker loops back
    // through the edge and dies as a 522; serving env.ASSETS instead returns the
    // PRE-enhancement static skeleton (wrong bytes, empty photo grid, zero alt
    // text), which a page whose whole claim is "what the server actually sent
    // back" must not show. Dispatching through route() yields the real response.
    // SELF_FETCH is nulled one level down, so a lens pointed at /lens/fetch
    // resolves once and cannot recurse.
    //
    // IDENTITY_BODY is what keeps that dispatch READABLE, and it exists because an
    // in-process call has no transport to undo an encoding. A real fetch() to an
    // external origin is decoded by the runtime, which strips content-encoding on
    // the way in — that is why /lens reports cloudflare.com and github.com as plain
    // HTML with no encoding header at all. This dispatch skips every one of those
    // layers, so the precompressed q11 twin (and the dcz delta) came back as raw
    // compressed bytes with `content-encoding: br` still set, and lens decoded them
    // as UTF-8. The result was mojibake on exactly the pages a visitor tries first,
    // including the featured "Try: aadhar.sh" example, while every third-party URL
    // looked perfect — which is why it survived.
    //
    // The worker cannot decode its way out. Probed against workerd at this repo's
    // compatibility_date (2026-08-09): `new DecompressionStream("br")` throws "the
    // compression format must be either 'deflate', 'deflate-raw' or 'gzip'", and an
    // invented format throws the byte-identical error, so that is a real refusal
    // rather than a name it did not recognise. Same control idiom as the
    // `--x-bogus-flag` check on wrangler. So the body has to arrive uncompressed.
    //
    // Asking via `accept-encoding: identity` would NOT work: the precompressed page
    // path deliberately never consults that header (gotcha 13 — the edge rewrites it
    // to a constant, so branching on it is dead code). A flag on the child env is
    // also the safer seam, because env is not caller-controllable and no external
    // request can ask production to stop serving its precompressed bodies.
    // Workers Logs: one structured line per worker-owned request (path, method,
    // status, ms, version, country, bot, protocol), filterable in the dashboard. Edge-direct
    // traffic never reaches this code, so it never logs. Strippable: delete the
    // wrapper, keep `return withSecurityHeaders(await route(...))`.
    //
    // `v` is the deployed version's id, truncated to the 8-char prefix Cloudflare
    // itself displays and puts in a preview URL. It exists for GRADUAL DEPLOYMENTS:
    // during a ramp two versions serve the same routes at once, and status + ms are
    // only comparable if you can tell which one answered. Without it a canary is a
    // deploy you cannot read. Eight characters because the full uuid is 36 and this
    // line is emitted on every worker-owned request; the prefix is unique across any
    // two versions that will ever be live together.
    const t0 = Date.now();
    let response = await route(request, env, ctx);
    // A 404 gets one more look before it leaves (lib/not-found.ts): a redirect
    // where one URL is unambiguously meant, otherwise a 404 that names the
    // sitemap and the closest real pages. cal.aadhar.sh is skipped because its
    // misses would be pointed at paths on a different host. The miss ledger
    // counts every one, recovered or not, by caller class and path bucket.
    if (response.status === 404 && (request.method === "GET" || request.method === "HEAD") && url.hostname !== CAL_HOST.host) {
      const miss = await recoverNotFound(request, env, response);
      countMiss(env, request, url.pathname, miss);
      response = miss.response;
    }
    // the bot ledger: identified AI-crawler hits tick into Analytics Engine
    // (worker-owned routes only); /ledger prices them. Best-effort, non-blocking.
    countCrawlerHit(env, request, response, url.pathname);
    // the speculation ledger's denominator: every Sec-Purpose prefetch/prerender
    // request. Its numerator (the activation beacon) arrives at /ledger/prefetch.
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
        // `h` answers the SHARE question. infra:check asserts HTTP/3 is ON (alt-svc
        // plus the HTTPS DNS record); nothing before 2026-09-21 said whether it was
        // USED. Read it grouped over a tail. Expect a mix rather than a switch:
        // Chrome learns h3 from Alt-Svc after the first response and keeps a healthy
        // h2 connection, so a cold visit's document reads HTTP/2 by design and the
        // assets it discovers a moment later read HTTP/3.
        h: request.cf?.httpProtocol,
        // The MCP era, set only on requests one of the two MCP servers parsed
        // (lib/mcp-protocol.ts noteEra). `mcp` is modern, legacy or mixed; `mv`
        // the revision it declared; `mc` the client a legacy `initialize` named.
        // Group `mcp` over a window to see whether the legacy door still has
        // callers, and `mv` to see which legacy revisions they speak.
        mcp: mcpEra?.era,
        mv: mcpEra?.version,
        mc: mcpEra?.client,
      }));
    } catch {}
    // noindex EVERY hostname that is not the canonical site, not just previews.
    // `cal.aadhar.sh` is a declared zone route that mostly 404s, but /coffee* really
    // does serve there, and cal's own templates carry no rel=canonical — so the
    // booking page was publishable at two hostnames. Keying on "is this aadhar.sh"
    // rather than listing the hosts that are not means the next alias is covered by
    // arriving, which is the same argument the preview guard's default-deny wins on.
    return withSecurityHeaders(response, url.pathname, { noindex: !isCanonicalHost(url.hostname) });
  }

  async function route(request: SiteRequest, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Preserve the legacy Cal subdomain while giving it a small, unlisted
    // work-calendar escape hatch. The bare host is public and goes to the
    // canonical booking page; only the exact secret slug redirects externally.
    // The slug and destination stay in Worker secrets so rotating either one
    // does not require a code change or a discoverable URL in the repository.
    if (url.hostname === CAL_HOST.host) return handlers.calHost(request, env, ctx, url);

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
    const exact = exactRoutes.get(url.pathname);
    if (exact) return dispatchTraced(url.pathname, "exact", exact, request, env, ctx, url);

    for (const r of prefixRoutes) {
      if (r.match(url.pathname)) return dispatchTraced(r.label, "prefix", r.handle, request, env, ctx, url);
    }

    // Static is the default: garage/lwe/cars/shell JS/discovery files fall through
    // to Workers static assets without a bespoke dispatcher branch. Deliberately
    // NOT wrapped: this arm is one auto-instrumented ASSETS call and a span around
    // it would only restate the child.
    return env.ASSETS.fetch(request);
  }

  return { route, serveWorkerRequest, withSelfFetch };
}

function dispatchTraced(template: string, kind: string, handle: RouteHandler, request: SiteRequest, env: Env, ctx: ExecutionContext, url: URL) {
  return span(
    `route ${template}`,
    async (s) => {
      // DID THE VISITOR HANG UP WHILE WE WERE STILL WORKING? `route.aborted`
      // answers that, and it is what cloudflare.config.ts's `enable_request_signal`
      // was taken for: nothing on this origin can currently count an abandoned
      // request. /lens is the surface that wants the number and needs no
      // attribute of its own, since /lens is an exact ROUTES entry: its dispatch
      // lands here and the rate is a group-by on route.template. A second
      // spelling of one fact is what lib/span-vocabulary.ts exists to prevent.
      //
      // THE TYPE SAYS `signal: AbortSignal` AND THAT IS A GUARANTEE ABOUT ONE
      // RUNTIME, which is why this widens rather than trusting workers-types.
      // The contract suite imports this module under bun, outside workerd, and a
      // future runtime may rename the property. `isCallable` is the same guard
      // lib/trace.ts puts on its injected tracer, for the same reason:
      // instrumentation must never be why a request fails.
      const signal: AbortSignal | undefined = request.signal;
      // unbound-method guards against `const f = obj.m; f()`, and `isCallable`
      // only reads `typeof value === "function"` and never calls what it is
      // handed. lib/trace.ts writes the same probe and escapes the rule only
      // because its parameter is untyped, which is luck rather than a pattern.
      // oxlint-disable-next-line typescript/unbound-method
      const listening = isCallable(signal?.addEventListener);
      let hungUp = false;
      const onAbort = () => { hungUp = true; };
      // `once` so one signal cannot double-fire, and the removal below so the
      // listener cannot outlive the dispatch that registered it. A request
      // reaches here exactly once anyway (route() returns on its first match,
      // and a /lens self-scan builds a NEW Request), so this makes that true by
      // construction rather than by reading the caller.
      if (listening) signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await handle(request, env, ctx, url);
        // status lands on the span rather than only in the log line, so a trace
        // can be read end to end without cross-referencing Workers Logs.
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
        //
        // EXPECT FALSE EVERYWHERE LOCALLY. The in-process harness never delivers
        // a hang-up to a Worker at all, measured across four flag settings on
        // 2026-08-28 (the argument is at compatibility_flags in cloudflare.config.ts),
        // so a green routes:check says this line does not throw and says nothing
        // about the number. Production is the only place it can answer.
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
      // the self-fetch marker: null SELF_FETCH means this dispatch IS the inner
      // one (route() nulls it one level down), so a nested span says which.
      "route.self_fetch": env.SELF_FETCH ? undefined : true,
    },
  );
}
