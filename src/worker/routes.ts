// Every route the site Worker owns, as DATA: the one list the dispatcher, the
// `run_worker_first` allowlist, Workers Cache, the preview and early-data write
// guards, and the build's link checker all read.
//
// Before 2026-10-02 those were five hand-kept lists, joined only by build-time
// regexes over index.ts: ROUTE_TABLE and PREFIX in index.ts, the 96-row
// allowlist in cloudflare.config.ts, WORKERS_CACHEABLE_PATHS plus three prefixes
// hardcoded in lib/cache.ts, and the write list in lib/preview.ts. The regexes
// matched nothing twice (once for five weeks) and the lists drifted anyway. A
// route is now one record here, and everything else is computed from it.
//
// DATA ONLY, and that is the constraint the whole shape answers to. Handlers
// stay in index.ts, bound by id in a map typed `Record<RouteId, RouteHandler>`,
// so the compiler rejects a route with no handler and a handler with no route.
// This module imports nothing but albums.ts (node-safe), so cloudflare.config.ts,
// build.ts and the contract suite can load it. index.ts cannot be loaded outside
// workerd (gotcha 16), and cal's Worker, which /coffee reaches, imports
// `cloudflare:workers` too, so a list that carried handlers could be read by
// the Worker alone.
//
// An id is the string the site already used for the route: an exact route's
// path, a prefix route's label. Those are what dispatchTraced names its
// `route <template>` spans, so traces read the same across the move.
import { ALBUMS, albumPath } from "./albums.ts";

// ── the island URLs ──────────────────────────────────────────────────────────
// Each built page's live rows arrive from one of these (lib/island.ts). They
// were exported by the feature modules until the route list moved here; the
// arrow reversed because this module may not import a feature, and the URL a
// page answers on is a routing fact. The feature modules import them from here.
export const WHOAREYOU_VALUES_URL = "/whoareyou/values.html";
export const READING_LIST_URL = "/reading/list.html";
export const DYNO_PULLS_URL = "/garage/dyno/pulls.html";
export const CENSUS_TABLE_URL = "/lens/census/table.html";
export const LEDGER_LINES_URL = "/ledger/lines.html";
export const INBOX_MAIL_URL = "/inbox/mail.html";
export const AROUND_SNAPSHOT_URL = "/around/snapshot.html";

type ExactRoute = {
  path: string;
  // The run_worker_first rows this route needs. Omitted means the path itself.
  // A FOLD names a wildcard instead, and several routes naming one wildcard is
  // how 104 exact routes fit under wrangler's cap of 100 rows (gotcha 26).
  claim?: readonly string[];
  // Workers Cache may answer it (lib/cache.ts bails on everything that varies
  // by more than the path, and a route here must not).
  cacheable?: true;
  // "get": a GET that writes state, so a preview refuses it and 0-RTT early
  // data gets a 425 (lib/preview.ts, lib/early-data.ts). "per-tool": unsafe
  // methods are admitted on a preview and the WRITING tools are refused one
  // layer down (previewToolRefusal).
  writes?: "get" | "per-tool";
  // The handler reads this origin through env.SELF_FETCH, an in-process
  // dispatch (dispatch.ts withSelfFetch). Armed on these routes alone, because
  // building that env costs a copy of every binding on each request.
  selfFetch?: true;
};

type PrefixRoute = {
  label: string;
  match: (pathname: string) => boolean;
  // A real path this route answers, for checks that need one: claim coverage
  // today, the route oracle's presence row later.
  probe: string;
  claim: readonly string[];
  cacheable?: { paths?: readonly string[]; startsWith?: string };
  // GET-shaped writes under this prefix that another module routes (cal).
  getWrites?: readonly string[];
};

// ── exact routes ─────────────────────────────────────────────────────────────
// Order is irrelevant here (a Map lookup), and is kept as the table read before
// the move so the diff of index.ts stays legible.
export const EXACT_ROUTES = [
  { path: "/favicon.ico", cacheable: true },

  { path: "/auth.md", cacheable: true },
  // The agent-discovery namespace, FOLDED from five exact rows on 2026-09-16.
  // The fold also brings the static cards (mcp/*.json, ard.json,
  // ai-catalog.json) to the Worker for their q11 twins, which were the one
  // discovery surface still shipping at the edge's q4.
  { path: "/.well-known/api-catalog", claim: ["/.well-known/*"], cacheable: true },
  { path: "/.well-known/agent-card.json", claim: ["/.well-known/*"], cacheable: true },
  { path: "/.well-known/oauth-protected-resource", claim: ["/.well-known/*"], cacheable: true },
  { path: "/.well-known/oauth-authorization-server", claim: ["/.well-known/*"], cacheable: true },
  // signed per request (proof of possession), so it needs the Worker regardless
  { path: "/.well-known/http-message-signatures-directory", claim: ["/.well-known/*"] },
  { path: "/agent/auth", claim: ["/agent/*"] },
  { path: "/agent/auth/claim", claim: ["/agent/*"] },
  { path: "/oauth2/token", claim: ["/oauth2/*"] },
  { path: "/oauth2/revoke", claim: ["/oauth2/*"] },

  // ticks the visit-counter Durable Object
  { path: "/hit", writes: "get" },

  // /whoareyou (a built page), its JSON and its values island on one row,
  // folded 2026-09-25. /whoareyou.md is "/*.md"'s.
  { path: "/whoareyou", claim: ["/whoareyou*"] },
  { path: "/whoareyou.json", claim: ["/whoareyou*"] },
  { path: WHOAREYOU_VALUES_URL, claim: ["/whoareyou*"] },
  { path: "/security", claim: ["/security*"] },
  { path: "/security.json", claim: ["/security*"] },
  // nothing static lives under /reading
  { path: "/reading", claim: ["/reading*"], cacheable: true },
  { path: READING_LIST_URL, claim: ["/reading*"] },
  // the GitHub shortcut infotip reads this (github.ts); one row of its own
  { path: "/github.json" },
  { path: "/updates", cacheable: true },
  { path: "/updates.json", cacheable: true },
  { path: "/restore", cacheable: true },
  // /garage/* is worker-first for the section's static pages already
  { path: "/garage/dyno", claim: ["/garage/*"] },
  { path: DYNO_PULLS_URL, claim: ["/garage/*"] },
  { path: "/garage/dyno.json", claim: ["/garage/*"] },
  { path: "/perf" },
  { path: "/perf.json" },

  // FOLDED onto a wildcard 2026-08-11, from eight exact rows to two, when the
  // config sat at exactly 100 of 100 and /lens/wire could not be added at any
  // price. Safe because NOTHING static lives under /lens/: the client scripts
  // are top-level (/lens.js, /lens-browser.js, /lens-reader.js), "/lens.txt" has
  // its own row, and /lens/read belongs to the lens-reader Worker through a
  // ZONE ROUTE, which is matched before this allowlist is consulted.
  { path: "/lens", claim: ["/lens"], cacheable: true, selfFetch: true },
  { path: "/lens/", claim: ["/lens/*"] },
  { path: "/lens/fetch", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/shot", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/browser", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/wire", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/tools", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/nlweb", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/markdown", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/compare.json", claim: ["/lens/*"], selfFetch: true },
  { path: "/lens/census", claim: ["/lens/*"] },
  { path: CENSUS_TABLE_URL, claim: ["/lens/*"] },
  { path: "/lens/census.json", claim: ["/lens/*"] },

  { path: "/mcp", writes: "per-tool", selfFetch: true },

  // The retired console: one wildcard for the 410 at /terminal and under it.
  { path: "/terminal", claim: ["/terminal*"] },
  { path: "/terminal/", claim: ["/terminal*"] },

  // One wildcard per tool covers the bare route and its .txt frame. NOT
  // cosmetic: twelve exact rows put the config at 102 of 100.
  { path: "/finger", claim: ["/finger*"] }, { path: "/finger.txt", claim: ["/finger*"] },
  { path: "/radar", claim: ["/radar*"] }, { path: "/radar.txt", claim: ["/radar*"] },
  { path: "/dict", claim: ["/dict*"] }, { path: "/dict.txt", claim: ["/dict*"] },
  { path: "/cache", claim: ["/cache*"] }, { path: "/cache.txt", claim: ["/cache*"] },
  { path: "/agent-ready", claim: ["/agent-ready*"] }, { path: "/agent-ready.txt", claim: ["/agent-ready*"] },
  { path: "/encode", claim: ["/encode*"] }, { path: "/encode.txt", claim: ["/encode*"] },
  { path: "/photos.txt" },
  { path: "/lens.txt" },

  { path: "/search", cacheable: true },
  { path: "/search.json" },
  // NLWeb's REST convention: a client knocks on <origin>/ask and nothing else.
  // Never cacheable, since the answer is per query.
  { path: "/ask" },

  { path: "/llms-full.txt" },

  // the crawl ledger and its sub-routes; nothing static lives under /ledger/
  { path: "/ledger", cacheable: true },
  { path: LEDGER_LINES_URL, claim: ["/ledger/*"] },
  { path: "/ledger.json" },
  // the speculation ledger's numerator, so preview traffic would land in a
  // series about the real site
  { path: "/ledger/prefetch", claim: ["/ledger/*"], writes: "get" },
  { path: "/ledger/speculation.json", claim: ["/ledger/*"] },

  { path: "/writing", cacheable: true },
  { path: "/writing/", claim: ["/writing/*"] },

  // HMAC-signed host actions, the same construction as cal's booking approvals
  { path: "/webmention" },
  { path: "/webmention/approve", claim: ["/webmention/*"], writes: "get" },
  { path: "/webmention/decline", claim: ["/webmention/*"], writes: "get" },
  // the page and its island; nothing static lives under /inbox
  { path: "/inbox", claim: ["/inbox*"] },
  { path: INBOX_MAIL_URL, claim: ["/inbox*"] },

  { path: "/rn" },
  // carries an extension, so the asset layer would answer first and 404 it
  { path: "/rn.md" },
  { path: "/rn/tracks", cacheable: true },
  { path: "/rn/tracks.html", cacheable: true },
  { path: "/rn/admin" },
  { path: "/rn/set" },

  { path: "/bot", cacheable: true },
  // folds the page, its two JSON doors and its island; nothing static lives
  // under /around
  { path: "/around", claim: ["/around*"], cacheable: true },
  { path: AROUND_SNAPSHOT_URL, claim: ["/around*"] },
  { path: "/around/json", claim: ["/around*"], cacheable: true },
  { path: "/around/changes.json", claim: ["/around*"], cacheable: true },

  // "/photos/*" FOLDED three exact rows on 2026-09-12; nothing static lives
  // under /photos/ (no public/photos, no src/pages/photos)
  { path: "/photos", cacheable: true },
  { path: "/photos/", claim: ["/photos/*"] },
  { path: "/photos/query.json", claim: ["/photos/*"], cacheable: true },
  { path: "/photos/grid.html", claim: ["/photos/*"] },
  { path: "/coffee/availability.json", claim: ["/coffee/*"], cacheable: true },
  { path: "/run", cacheable: true },

  // the retired Apache-styled listings, which 301 to /photos
  { path: "/images" },
  { path: "/images/" },
  { path: "/images/full" },
  { path: "/images/full/", claim: ["/images/full/*"] },
  { path: "/images/manifest.json", cacheable: true },
  { path: "/images/metadata.json", cacheable: true },
  // root-level text assets served from their build-time q11 twin
  { path: "/search-index.json" },
  { path: "/llms.txt" },
  { path: "/sitemap.xml" },
  { path: "/resume.json" },

  { path: "/index.html" },
  { path: "/", cacheable: true },
] as const satisfies readonly ExactRoute[];

export type ExactPath = (typeof EXACT_ROUTES)[number]["path"];

// One generated page per album (albums.ts) plus its slashed twin. A root path
// has no wildcard to inherit, so each album costs two rows: fold before adding.
export const ALBUM_ROUTES: readonly ExactRoute[] = Object.values(ALBUMS).flatMap((album) => [
  { path: albumPath(album) },
  { path: `${albumPath(album)}/` },
]);

// ── prefix routes ────────────────────────────────────────────────────────────
// ORDERED: the dispatcher takes the first match, after the exact routes. Three
// orderings carry weight, and contract-the-route-list-derives-every-route-list
// names them:
//   - /coffee and /serendipity come before "/<path>.src.<ext>", so their own
//     readable twins reach the app that owns them
//   - "/<path>.src.<ext>" spans any depth and comes before the five static
//     sections, so /garage/horizon.src.html is answered as a text twin
//   - /images/meta and /images/<index>.json come before /images/<thumb>
export const PREFIX_ROUTES = [
  {
    label: "/coffee/<path>",
    match: (pathname: string) => pathname === "/coffee" || pathname.startsWith("/coffee/"),
    probe: "/coffee",
    claim: ["/coffee", "/coffee/*"],
    cacheable: { paths: ["/coffee"] },
    // cal routes these, stripping /coffee before it matches: confirm or refuse a
    // real booking and email a real person about it
    getWrites: ["/coffee/approve", "/coffee/decline"],
  },
  {
    label: "/serendipity/<path>",
    match: (pathname: string) => pathname === "/serendipity" || pathname.startsWith("/serendipity/"),
    probe: "/serendipity",
    claim: ["/serendipity", "/serendipity/*"],
  },
  {
    label: "/writing/<slug>",
    match: (pathname: string) => {
      if (!pathname.startsWith("/writing/")) return false;
      const slug = pathname.slice("/writing/".length);
      return !!slug && slug.indexOf("/") === -1 && slug.indexOf(".") === -1;
    },
    probe: "/writing/big-screens-and-small-screens",
    claim: ["/writing/*"],
    // everything under /writing/ varies by path alone
    cacheable: { startsWith: "/writing/" },
  },
  {
    // the section's data files: posts.json, feed.xml and each post's raw .txt
    label: "/writing/<file>.<ext>",
    match: (pathname: string) => /^\/writing\/[^/]+\.(json|txt|xml)$/i.test(pathname),
    probe: "/writing/posts.json",
    claim: ["/writing/*"],
  },
  {
    // the section favicons, loaded on 12 pages
    label: "/section-icons/<name>.svg",
    match: (pathname: string) => /^\/section-icons\/[^/]+\.svg$/i.test(pathname),
    probe: "/section-icons/garage.svg",
    claim: ["/section-icons/*"],
  },
  {
    label: "/terminal/<anything>",
    match: (pathname: string) => pathname.startsWith("/terminal/"),
    probe: "/terminal/finger",
    claim: ["/terminal*"],
  },
  {
    label: "/rn/art/<hash>-<width>-<v>.<ext>",
    match: (pathname: string) => pathname.startsWith("/rn/art/"),
    probe: "/rn/art/0123456789abcdef-160-1.jpg",
    claim: ["/rn/art/*"],
  },
  {
    label: "/images/meta/<stem>.json",
    match: (pathname: string) => /^\/images\/meta\/[^/]+\.json$/i.test(pathname),
    probe: "/images/meta/XT500010.json",
    claim: ["/images/meta/*"],
    cacheable: { startsWith: "/images/meta/" },
  },
  {
    // the photo data indexes beside meta/; manifest and metadata are exact
    // routes and win first
    label: "/images/<index>.json",
    match: (pathname: string) => /^\/images\/[^/]+\.json$/i.test(pathname),
    probe: "/images/exif.json",
    claim: ["/images/*.json"],
  },
  {
    // a root-level Markdown twin; /auth.md and /rn.md are exact and win first
    label: "/<page>.md",
    match: (pathname: string) => /^\/[^/]+\.md$/i.test(pathname),
    probe: "/index.md",
    // `*` spans slashes in this allowlist, so this claims every twin at any depth
    claim: ["/*.md"],
  },
  {
    // A readable twin at ANY depth: /nav.src.js, and /garage/horizon.src.html
    // too, since the pattern spans directories and this row precedes the
    // sections. Before 2026-10-02 the comment here said the section-level ones
    // went through serveStaticPage; the regex has always said otherwise, and
    // both serve the same twin.
    label: "/<path>.src.<ext>",
    match: (pathname: string) => /^\/(?:[^/]+\/)*[^/]+\.src\.(?:html|js|css)$/i.test(pathname),
    probe: "/nav.src.js",
    claim: ["/*.src.*"],
  },
  {
    // the static agent-discovery cards, after every exact /.well-known route
    label: "/.well-known/<card>",
    match: (pathname: string) => pathname.startsWith("/.well-known/"),
    probe: "/.well-known/ard.json",
    claim: ["/.well-known/*"],
  },
  {
    label: "/images/full/<key>",
    match: (pathname: string) => pathname.startsWith("/images/full/"),
    probe: "/images/full/XT500010.jpg",
    claim: ["/images/full/*"],
    cacheable: { startsWith: "/images/full/" },
  },
  {
    // worker-first for one narrow reason: a real 404 under /images/* must not
    // inherit the immutable thumbnail cache rule (gotcha 1)
    label: "/images/<thumb>",
    match: (pathname: string) => /^\/images\/[^/]+\.(avif|jpe?g|png|gif|heic|heif|hif)$/i.test(pathname),
    probe: "/images/XT500010.jpg",
    claim: [
      "/images/*.avif", "/images/*.jpg", "/images/*.jpeg", "/images/*.png",
      "/images/*.gif", "/images/*.heic", "/images/*.heif", "/images/*.hif",
    ],
  },
  // The static sections, worker-first for the dcz delta and the q11 twin. The
  // bare path is claimed SEPARATELY because "/garage/*" does not match
  // "/garage"; without it the section indexes never reached the Worker and
  // their twins were built and never served (2026-07-28).
  {
    label: "/garage/<page>",
    match: (pathname: string) => pathname === "/garage" || pathname.startsWith("/garage/"),
    probe: "/garage/horizon",
    claim: ["/garage", "/garage/*"],
  },
  {
    label: "/lwe/<page>",
    match: (pathname: string) => pathname === "/lwe" || pathname.startsWith("/lwe/"),
    probe: "/lwe/fhe",
    claim: ["/lwe", "/lwe/*"],
  },
  {
    label: "/pixel-peeper/<page>",
    match: (pathname: string) => pathname === "/pixel-peeper" || pathname.startsWith("/pixel-peeper/"),
    probe: "/pixel-peeper",
    claim: ["/pixel-peeper", "/pixel-peeper/*"],
  },
  {
    label: "/access",
    match: (pathname: string) => pathname === "/access" || pathname.startsWith("/access/"),
    probe: "/access",
    claim: ["/access", "/access/*"],
  },
  {
    label: "/dotfiles",
    match: (pathname: string) => pathname === "/dotfiles" || pathname.startsWith("/dotfiles/"),
    probe: "/dotfiles",
    claim: ["/dotfiles", "/dotfiles/*"],
  },
  {
    // the content-hashed shell, worker-first to hand out the q11 twin. The `.br`
    // suffix is excluded so the twin itself stays a plain static asset.
    label: "/a/<asset>",
    match: (pathname: string) => /^\/a\/[^/]+\.[0-9a-f]{8}\.(js|css|svg|json|dict)$/.test(pathname),
    probe: "/a/nav.0123abcd.js",
    claim: ["/a/*"],
  },
] as const satisfies readonly PrefixRoute[];

export type PrefixLabel = (typeof PREFIX_ROUTES)[number]["label"];

// cal.aadhar.sh is dispatched before any table (dispatch.ts route()), and these are
// its retired spellings. They route nothing on aadhar.sh; on the cal host the
// Worker sees them anyway while no static file sits at those paths. Kept as
// claims so a file that ever lands at /book cannot answer cal's host first.
export const CAL_HOST = { host: "cal.aadhar.sh", claim: ["/slots", "/book", "/approve", "/decline"] } as const;

// ── derived ──────────────────────────────────────────────────────────────────
const unique = (xs: Iterable<string>): string[] => [...new Set(xs)];
const claimsOf = (r: ExactRoute) => r.claim ?? [r.path];

/** Every exact path the dispatcher answers, albums included. */
export const EXACT_PATHS: readonly string[] = [...EXACT_ROUTES, ...ALBUM_ROUTES].map((r) => r.path);

/** cloudflare.config.ts's assets.runWorkerFirst. Wrangler caps it at 100 rows. */
export const RUN_WORKER_FIRST: readonly string[] = unique([
  ...[...EXACT_ROUTES, ...ALBUM_ROUTES].flatMap(claimsOf),
  ...PREFIX_ROUTES.flatMap((r) => r.claim),
  ...CAL_HOST.claim,
]);

/** Exact paths Workers Cache may answer (dispatch.ts isEdgeCacheable). */
export const CACHEABLE_PATHS: ReadonlySet<string> = new Set([
  ...(EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.cacheable).map((r) => r.path),
  ...(PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => r.cacheable?.paths ?? []),
]);

/** Exact paths whose handler is handed SELF_FETCH (dispatch.ts). */
export const SELF_FETCH_PATHS: ReadonlySet<string> =
  new Set((EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.selfFetch).map((r) => r.path));

/** Path prefixes Workers Cache may answer anything under (lib/cache.ts). */
export const CACHEABLE_PREFIXES: readonly string[] =
  (PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => (r.cacheable?.startsWith ? [r.cacheable.startsWith] : []));

/** GET-shaped writes: refused on a preview, 425 in early data. */
export const GET_WRITES: ReadonlySet<string> = new Set([
  ...(EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.writes === "get").map((r) => r.path),
  ...(PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => r.getWrites ?? []),
]);

/** Paths a preview admits unsafe methods on, refusing writes per tool instead. */
export const PER_TOOL_WRITES: ReadonlySet<string> =
  new Set((EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.writes === "per-tool").map((r) => r.path));

// The allowlist's glob as wrangler and build.ts read it: `*` spans slashes, and
// a row without one matches only itself. Negated rows (`!/x`) are dropped, as
// every reader here always has: none of them can make a path Worker-first.
const globRe = (glob: string) => new RegExp("^" + glob.replace(/[\\.+?^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$");

/** Does the Worker see `path` first? The one reader of the allowlist's globs:
 *  build.ts, link-integrity and the twin and /coffee tests all ask it here. */
export function claimedByWorker(allow: readonly string[] = RUN_WORKER_FIRST): (path: string) => boolean {
  const rows = allow.filter((a) => !a.startsWith("!")).map(globRe);
  return (path) => rows.some((re) => re.test(path));
}

/** Paths and probes no allowlist row reaches; a route here would serve static. */
export function uncoveredRoutes(allow: readonly string[] = RUN_WORKER_FIRST): string[] {
  const covered = claimedByWorker(allow);
  return [...EXACT_PATHS, ...PREFIX_ROUTES.map((r) => r.probe)].filter((p) => !covered(p));
}
