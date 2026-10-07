// ── the dispatch pipeline, called rather than read ──────────────────────────
// src/worker/dispatch.ts owns the order a request meets things in (preview
// guard, early-data guard, host handling, routing, 404 recovery, ledgers, log
// line, security headers), and src/worker/routes.ts owns the route facts. Both
// load outside workerd, so these tests hand createDispatch() fake handlers and a
// fake env.ASSETS and watch what a request does. Until 2026-10-02 the same claims
// were pinned by `indexOf` offsets and regexes over index.ts's source text,
// because index.ts imports `cloudflare:workers` and cannot load here (gotcha 16).
import { assert, context, handleSiteMcp, test } from "./contract-shared.ts";
import { createDispatch, isEdgeCacheable } from "../src/worker/dispatch.ts";
import { ALBUMS, albumPath } from "../src/worker/albums.ts";
import { CACHEABLE_PATHS, EXACT_PATHS, EXACT_ROUTES, PREFIX_ROUTES, SELF_FETCH_PATHS } from "../src/worker/routes.ts";
import { _resetSitemap } from "../src/worker/lib/not-found.ts";

const html = (body) => new Response(`<!doctype html><title>${body}</title>`, { headers: { "content-type": "text/html; charset=utf-8" } });

// Typed `any`: the fakes stand in for Records over every route id.
/** @param {(call: any) => void} [record] @returns {any} */
function fakeHandlers(record = () => {}) {
  const fake = (id) => (request, env) => { record({ id, env, request }); return html(id); };
  return {
    exact: Object.fromEntries(EXACT_ROUTES.map((r) => [r.path, fake(r.path)])),
    prefix: Object.fromEntries(PREFIX_ROUTES.map((r) => [r.label, fake(r.label)])),
    album: (album, request, env) => { record({ id: `album:${album.slug}`, env, request }); return html(album.slug); },
    calHost: fake("calHost"),
  };
}

// One fake handler per route id, each recording which id answered and the env
// it was handed, plus an ASSETS binding that serves a two-page sitemap and 404s
// everything else, the way the asset layer does.
function rig(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  const handlers = { ...fakeHandlers((c) => calls.push(c)), ...overrides };
  const assetPaths = [];
  /** @type {any} */
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(typeof request === "string" ? request : request.url).pathname;
        if (path === "/sitemap.xml") {
          return new Response("<urlset><url><loc>https://aadhar.sh/reading</loc></url><url><loc>https://aadhar.sh/garage/horizon</loc></url></urlset>");
        }
        assetPaths.push(path);
        return new Response("", { status: 404 });
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const dispatch = createDispatch(handlers);
  return {
    calls, assetPaths, env, ctx,
    ids: () => calls.map((c) => c.id),
    serve: (url, init) => dispatch.serveWorkerRequest(new Request(url, init), env, ctx),
    route: (url, init) => dispatch.route(new Request(url, init), env, ctx),
  };
}

test("the early-data guard answers before any route handler runs", async () => {
  const r = rig();
  const early = await r.serve("https://aadhar.sh/hit", { headers: { "early-data": "1" } });
  assert.equal(early.status, 425, "a replayable GET-shaped write is refused in early data");
  assert.deepEqual(r.ids(), [], "the /hit handler must not run: a guard after routing has already lost");
  // the control: the same request after the handshake reaches the handler, so
  // the empty list above is the guard and not a rig that cannot see calls
  const plain = await r.serve("https://aadhar.sh/hit");
  assert.equal(plain.status, 200);
  assert.deepEqual(r.ids(), ["/hit"]);
});

test("the preview guard answers before routing, and a preview read is noindexed", async () => {
  const r = rig();
  const host = "https://abc12345-aadhar-sh.example.workers.dev";
  assert.equal((await r.serve(`${host}/webmention`, { method: "POST", body: "source=a&target=b" })).status, 403, "a POST on a preview is refused");
  assert.equal((await r.serve(`${host}/hit`)).status, 403, "a GET-shaped write on a preview is refused");
  assert.deepEqual(r.ids(), [], "neither handler ran on the preview host");
  // the control: a read passes straight through, which is what the URL is for
  const read = await r.serve(`${host}/reading`);
  assert.equal(read.status, 200);
  assert.deepEqual(r.ids(), ["/reading"]);
  assert.equal(read.headers.get("x-robots-tag"), "noindex, nofollow");
});

// It used to key on `onPreview` alone, which left cal.aadhar.sh publishing
// /coffee at a second hostname (cal's templates carry no rel=canonical).
test("every hostname but the canonical one is noindexed, and the canonical one is not", async () => {
  const r = rig();
  const cal = await r.serve("https://cal.aadhar.sh/coffee");
  assert.deepEqual(r.ids(), ["calHost"], "cal.aadhar.sh goes to the cal host handler before any table");
  assert.equal(cal.headers.get("x-robots-tag"), "noindex, nofollow", "the booking page must not be indexable at a second hostname");
  // the control, and the regression that would matter most: a bug here deindexes the real site
  const site = await r.serve("https://aadhar.sh/reading");
  assert.equal(site.headers.get("x-robots-tag"), null);
  assert.ok(site.headers.get("content-security-policy"), "the security headers are applied on the way out");
});

test("a .pages.dev host is redirected to the canonical one without routing", async () => {
  const r = rig();
  const res = await r.serve("https://aadhar-sh.pages.dev/reading?x=1");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://aadhar.sh/reading?x=1");
  assert.deepEqual(r.ids(), []);
});

test("a 404 is recovered on the site and left alone on cal.aadhar.sh", async () => {
  _resetSitemap();
  try {
    const r = rig({ calHost: () => new Response("not found", { status: 404 }) });
    // a careless spelling of a sitemap page is redirected to it
    const typo = await r.serve("https://aadhar.sh/Reading/");
    assert.equal(typo.status, 301);
    assert.equal(typo.headers.get("location"), "https://aadhar.sh/reading");
    // a generic miss names itself and points at the sitemap
    const miss = await r.serve("https://aadhar.sh/no-such-page");
    assert.equal(miss.status, 404);
    assert.ok(r.assetPaths.includes("/no-such-page"), "an unrouted path falls through to the asset layer");
    assert.match(await miss.text(), /no-such-page/);
    assert.match(miss.headers.get("link") || "", /sitemap/, "the miss carries the discovery Link set");
    // the controls: a POST is not a lookup, and cal's misses would be pointed
    // at paths on a different host
    const post = await r.serve("https://aadhar.sh/no-such-page", { method: "POST", body: "x" });
    assert.equal(await post.text(), "", "a POST 404 keeps the asset layer's body");
    const cal = await r.serve("https://cal.aadhar.sh/Reading/");
    assert.equal(cal.status, 404, "cal.aadhar.sh is not redirected into the site's pages");
    assert.equal(await cal.text(), "not found");
    assert.equal(cal.headers.get("link"), null);
  } finally {
    _resetSitemap();
  }
});

test("exact routes win first, then the prefix table in routes.ts's order", async () => {
  const r = rig();
  const answered = async (path) => { r.calls.length = 0; await r.route(`https://aadhar.sh${path}`); return r.ids()[0] ?? "static"; };
  // each pair is a path two rows could claim, and the row that must win
  const cases = [
    ["/images/manifest.json", "/images/manifest.json"],          // exact before "/images/<index>.json"
    ["/images/meta/XT500010.json", "/images/meta/<stem>.json"],  // before "/images/<index>.json"
    ["/images/exif.json", "/images/<index>.json"],
    ["/images/full/XT500010.jpg", "/images/full/<key>"],         // R2 originals before the thumbnail clamp
    ["/images/XT500010.jpg", "/images/<thumb>"],
    ["/auth.md", "/auth.md"],                                    // exact before "/<page>.md"
    ["/garage.md", "/<page>.md"],
    ["/serendipity/app.src.js", "/serendipity/<path>"],          // before "/<path>.src.<ext>"
    ["/garage/horizon.src.html", "/<path>.src.<ext>"],           // before "/garage/<page>"
    ["/garage/dyno", "/garage/dyno"],                            // exact before "/garage/<page>"
    ["/garage/horizon", "/garage/<page>"],
    ["/.well-known/api-catalog", "/.well-known/api-catalog"],    // exact before "/.well-known/<card>"
    ["/.well-known/ard.json", "/.well-known/<card>"],
    ["/a/nav.0123abcd.js", "/a/<asset>"],
    ["/a/nav.0123abcd.js.br", "static"],                         // the twin itself stays a plain asset
    ["/robots.txt", "static"],
  ];
  for (const [path, want] of cases) assert.equal(await answered(path), want, `${path} must be answered by ${want}`);
  // the control: /garage/dyno matches a prefix too, so only exact-first explains the row above
  assert.ok(PREFIX_ROUTES.find((p) => p.label === "/garage/<page>")?.match("/garage/dyno"));
});

test("album pages route from the registry, and the slashed twin redirects", async () => {
  const albums = Object.values(ALBUMS);
  // The registry has been empty since /cota-wec left on 2026-10-07, so the loop
  // below covers whichever album comes next. Until then the registry still
  // decides the allowlist the other way: an album it no longer names is a path
  // nothing claims, which verify-routes.ts's 404 row checks end to end.
  assert.ok(!EXACT_PATHS.includes("/cota-wec") && !EXACT_PATHS.includes("/cota-wec/"), "a removed album must leave the route allowlist");
  const r = rig();
  for (const album of albums) {
    r.calls.length = 0;
    await r.route(`https://aadhar.sh${albumPath(album)}`);
    assert.deepEqual(r.ids(), [`album:${album.slug}`]);
    const twin = await r.route(`https://aadhar.sh${albumPath(album)}/`);
    assert.equal(twin.status, 301);
    assert.equal(twin.headers.get("location"), `https://aadhar.sh${albumPath(album)}`);
    assert.ok(EXACT_PATHS.includes(albumPath(album)) && EXACT_PATHS.includes(`${albumPath(album)}/`), "the allowlist claims what the dispatcher answers");
  }
});

test("self-dispatch is armed on the routes routes.ts marks, and on no other", async () => {
  assert.equal(SELF_FETCH_PATHS.size, 10, "nine /lens routes and /mcp read this origin in-process");
  const r = rig();
  await r.route("https://aadhar.sh/lens");
  await r.route("https://aadhar.sh/reading");
  const [lens, reading] = r.calls;
  assert.equal(typeof lens.env.SELF_FETCH, "function", "/lens reads this origin through SELF_FETCH");
  assert.equal(reading.env.SELF_FETCH, undefined, "the control: a route that never self-dispatches gets the env it was given");

  // the inner dispatch: routed once, marked so it cannot re-arm, body left readable
  r.calls.length = 0;
  const inner = await lens.env.SELF_FETCH(new Request("https://aadhar.sh/lens/fetch"));
  assert.equal(inner.status, 200);
  assert.equal(r.calls[0].id, "/lens/fetch");
  assert.equal(r.calls[0].env.SELF_FETCH, null, "the inner dispatch is not armed again, so a lens pointed at itself cannot recurse");
  assert.equal(r.calls[0].env.IDENTITY_BODY, true, "an in-process dispatch has no transport to undo an encoding");
  assert.ok(inner.headers.get("content-security-policy"), "the self-dispatched response carries the headers a wire response would");
});

test("every Workers Cache path is a real route, and the predicate reads that set", () => {
  const routed = (path) => EXACT_PATHS.includes(path) || PREFIX_ROUTES.some((p) => p.match(path));
  for (const path of CACHEABLE_PATHS) assert.ok(routed(path), `${path} is admitted to Workers Cache but no route serves it`);
  assert.equal(routed("/definitely-not-a-route"), false, "the control: the check can fail");

  const get = (url) => new Request(url, { headers: { accept: "text/html" } });
  assert.equal(isEdgeCacheable(get("https://aadhar.sh/")), true);
  assert.equal(isEdgeCacheable(get("https://aadhar.sh/hit")), false, "a write is never fronted by the cache");
  assert.equal(isEdgeCacheable(get("https://cal.aadhar.sh/reading")), false, "the cache answers before the host check, so it bails off the canonical host");
});

test("a route with no handler fails at isolate init rather than serving static", () => {
  const { exact, prefix, ...rest } = fakeHandlers();
  assert.doesNotThrow(() => createDispatch({ ...rest, exact, prefix }), "the control: a complete table builds");
  const { "/hit": _hit, ...withoutHit } = exact;
  assert.throws(() => createDispatch({ ...rest, prefix, exact: withoutHit }), /no handler for \/hit/);
  const { "/a/<asset>": _shell, ...withoutShell } = prefix;
  assert.throws(() => createDispatch({ ...rest, exact, prefix: withoutShell }), /no handler for \/a\/<asset>/);
});

// noteEra() tags each request an MCP server parses; the log line is what makes
// that tag readable over a window (contract-mcp-era-is-recorded-per-request).
test("the per-request log line carries the MCP era, and only on MCP requests", async () => {
  const handlers = fakeHandlers();
  const dispatch = createDispatch({ ...handlers, exact: { ...handlers.exact, "/mcp": (request, env) => handleSiteMcp(request, env, context()) } });
  /** @type {any} */
  const env = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old-client" } } };
    await dispatch.serveWorkerRequest(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify(initialize) }), env, ctx);
    await dispatch.serveWorkerRequest(new Request("https://aadhar.sh/reading"), env, ctx);
  } finally {
    console.log = log;
  }
  const [mcp, page] = lines.map((l) => JSON.parse(l));
  assert.equal(mcp.p, "/mcp");
  assert.equal(mcp.mcp, "legacy");
  assert.equal(mcp.mv, "2025-06-18");
  assert.equal(mcp.mc, "old-client");
  // the control: a request no MCP server parsed carries no era at all
  assert.equal(page.p, "/reading");
  assert.equal("mcp" in page, false);
});
