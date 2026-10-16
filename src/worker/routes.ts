// Every route the site Worker owns, as DATA: the one list the dispatcher, the
// `run_worker_first` allowlist, Workers Cache, the preview and early-data write
// guards, and the build's link checker all read.
//
// DATA ONLY, and that is the constraint the whole shape answers to. Handlers
// stay in index.ts, bound by id in a map typed `Record<RouteId, RouteHandler>`,
// so the compiler rejects a route with no handler and a handler with no route.
// This module imports nothing but albums.ts (node-safe), so cloudflare.config.ts,
// build.ts and the contract suite can load it. index.ts cannot be loaded outside
// workerd (gotcha 16), and cal's Worker, which /coffee reaches, imports
// `cloudflare:workers` too, so a list that carried handlers could be read by
// the Worker alone.
import { ALBUMS, albumPath } from "./albums.ts";

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
  cacheable?: true;
  writes?: "get" | "per-tool";
  selfFetch?: true;
};

type PrefixRoute = {
  label: string;
  match: (pathname: string) => boolean;
  probe: string;
  claim: readonly string[];
  cacheable?: { paths?: readonly string[]; startsWith?: string };
  getWrites?: readonly string[];
};

export const EXACT_ROUTES = [
  { path: "/favicon.ico", cacheable: true },

  { path: "/.well-known/api-catalog", claim: ["/.well-known/*"], cacheable: true },
  { path: "/.well-known/agent-card.json", claim: ["/.well-known/*"], cacheable: true },
  { path: "/.well-known/http-message-signatures-directory", claim: ["/.well-known/*"] },

  { path: "/hit", writes: "get" },

  { path: "/whoareyou", claim: ["/whoareyou*"] },
  { path: "/whoareyou.json", claim: ["/whoareyou*"] },
  { path: WHOAREYOU_VALUES_URL, claim: ["/whoareyou*"] },
  { path: "/security", claim: ["/security*"] },
  { path: "/security.json", claim: ["/security*"] },
  { path: "/reading", claim: ["/reading*"], cacheable: true },
  { path: READING_LIST_URL, claim: ["/reading*"] },
  { path: "/github.json" },
  { path: "/updates", claim: ["/updates*"], cacheable: true },
  { path: "/updates.json", claim: ["/updates*"], cacheable: true },
  { path: "/restore", cacheable: true },
  { path: "/garage/dyno", claim: ["/garage/*"] },
  { path: DYNO_PULLS_URL, claim: ["/garage/*"] },
  { path: "/garage/dyno.json", claim: ["/garage/*"] },
  { path: "/perf", claim: ["/perf*"] },
  { path: "/perf.json", claim: ["/perf*"] },

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

  { path: "/terminal", claim: ["/terminal*"] },
  { path: "/terminal/", claim: ["/terminal*"] },

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

  { path: "/ledger", cacheable: true },
  { path: LEDGER_LINES_URL, claim: ["/ledger/*"] },
  { path: "/ledger.json" },
  { path: "/ledger/prefetch", claim: ["/ledger/*"], writes: "get" },
  { path: "/ledger/speculation.json", claim: ["/ledger/*"] },

  { path: "/writing", cacheable: true },
  { path: "/writing/", claim: ["/writing/*"] },

  { path: "/webmention" },
  { path: "/webmention/approve", claim: ["/webmention/*"], writes: "get" },
  { path: "/webmention/decline", claim: ["/webmention/*"], writes: "get" },
  { path: "/inbox", claim: ["/inbox*"] },
  { path: INBOX_MAIL_URL, claim: ["/inbox*"] },

  { path: "/rn" },
  { path: "/rn.md" },
  { path: "/rn/tracks", cacheable: true },
  { path: "/rn/tracks.html", cacheable: true },
  { path: "/rn/admin" },
  { path: "/rn/set" },

  // Pixel Peeper's pooled picks (pixel-peeper-crowd.ts). Both sit under the
  // section's own "/pixel-peeper/*" claim, so they cost no allowlist row. The
  // POST is an unsafe method, which preview.ts and early-data.ts already refuse
  // on a preview and on 0-RTT without a `writes` flag.
  { path: "/pixel-peeper/runs", claim: ["/pixel-peeper/*"] },
  { path: "/pixel-peeper/crowd.json", claim: ["/pixel-peeper/*"] },

  { path: "/bot", cacheable: true },
  { path: "/about", cacheable: true },
  { path: "/contact", cacheable: true },
  { path: "/privacy", cacheable: true },
  { path: "/developers", cacheable: true },
  { path: "/around", claim: ["/around*"], cacheable: true },
  { path: AROUND_SNAPSHOT_URL, claim: ["/around*"] },
  { path: "/around/json", claim: ["/around*"], cacheable: true },
  { path: "/around/changes.json", claim: ["/around*"], cacheable: true },

  { path: "/photos", cacheable: true },
  { path: "/photos/", claim: ["/photos/*"] },
  { path: "/photos/query.json", claim: ["/photos/*"], cacheable: true },
  { path: "/photos/grid.html", claim: ["/photos/*"] },
  { path: "/coffee/availability.json", claim: ["/coffee/*"], cacheable: true },
  { path: "/run", cacheable: true },

  { path: "/images" },
  { path: "/images/" },
  { path: "/images/full" },
  { path: "/images/full/", claim: ["/images/full/*"] },
  { path: "/images/manifest.json", cacheable: true },
  { path: "/images/metadata.json", cacheable: true },
  { path: "/search-index.json" },
  { path: "/llms.txt" },
  { path: "/sitemap.xml" },
  { path: "/resume.json" },

  { path: "/index.html" },
  { path: "/", cacheable: true },
] as const satisfies readonly ExactRoute[];

export type ExactPath = (typeof EXACT_ROUTES)[number]["path"];

export const ALBUM_ROUTES: readonly ExactRoute[] = Object.values(ALBUMS).flatMap((album) => [
  { path: albumPath(album) },
  { path: `${albumPath(album)}/` },
]);

export const PREFIX_ROUTES = [
  {
    label: "/coffee/<path>",
    match: (pathname: string) => pathname === "/coffee" || pathname.startsWith("/coffee/"),
    probe: "/coffee",
    claim: ["/coffee", "/coffee/*"],
    cacheable: { paths: ["/coffee"] },
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
    cacheable: { startsWith: "/writing/" },
  },
  {
    label: "/writing/<file>.<ext>",
    match: (pathname: string) => /^\/writing\/[^/]+\.(json|txt|xml)$/i.test(pathname),
    probe: "/writing/posts.json",
    claim: ["/writing/*"],
  },
  {
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
    label: "/images/<index>.json",
    match: (pathname: string) => /^\/images\/[^/]+\.json$/i.test(pathname),
    probe: "/images/exif.json",
    claim: ["/images/*.json"],
  },
  {
    label: "/<page>.md",
    match: (pathname: string) => /^\/[^/]+\.md$/i.test(pathname),
    probe: "/index.md",
    // `*` spans slashes in this allowlist, so this claims every twin at any depth
    claim: ["/*.md"],
  },
  {
    label: "/<path>.src.<ext>",
    match: (pathname: string) => /^\/(?:[^/]+\/)*[^/]+\.src\.(?:html|js|css)$/i.test(pathname),
    probe: "/nav.src.js",
    claim: ["/*.src.*"],
  },
  {
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
    label: "/a/<asset>",
    match: (pathname: string) => /^\/a\/[^/]+\.[0-9a-f]{8}\.(js|css|svg|json|dict)$/.test(pathname),
    probe: "/a/nav.0123abcd.js",
    claim: ["/a/*"],
  },
] as const satisfies readonly PrefixRoute[];

export type PrefixLabel = (typeof PREFIX_ROUTES)[number]["label"];

export const CAL_HOST = { host: "cal.aadhar.sh", claim: ["/slots", "/book", "/approve", "/decline"] } as const;

const unique = (xs: Iterable<string>): string[] => [...new Set(xs)];
const claimsOf = (r: ExactRoute) => r.claim ?? [r.path];

export const EXACT_PATHS: readonly string[] = [...EXACT_ROUTES, ...ALBUM_ROUTES].map((r) => r.path);

export const RUN_WORKER_FIRST: readonly string[] = unique([
  ...[...EXACT_ROUTES, ...ALBUM_ROUTES].flatMap(claimsOf),
  ...PREFIX_ROUTES.flatMap((r) => r.claim),
  ...CAL_HOST.claim,
]);

export const CACHEABLE_PATHS: ReadonlySet<string> = new Set([
  ...(EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.cacheable).map((r) => r.path),
  ...(PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => r.cacheable?.paths ?? []),
]);

export const SELF_FETCH_PATHS: ReadonlySet<string> =
  new Set((EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.selfFetch).map((r) => r.path));

export const CACHEABLE_PREFIXES: readonly string[] =
  (PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => (r.cacheable?.startsWith ? [r.cacheable.startsWith] : []));

export const GET_WRITES: ReadonlySet<string> = new Set([
  ...(EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.writes === "get").map((r) => r.path),
  ...(PREFIX_ROUTES as readonly PrefixRoute[]).flatMap((r) => r.getWrites ?? []),
]);

export const PER_TOOL_WRITES: ReadonlySet<string> =
  new Set((EXACT_ROUTES as readonly ExactRoute[]).filter((r) => r.writes === "per-tool").map((r) => r.path));

// The allowlist's glob as wrangler and build.ts read it: `*` spans slashes, and
// a row without one matches only itself. Negated rows (`!/x`) are dropped, as
// every reader here always has: none of them can make a path Worker-first.
const globRe = (glob: string) => new RegExp("^" + glob.replace(/[\\.+?^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$");

export function claimedByWorker(allow: readonly string[] = RUN_WORKER_FIRST): (path: string) => boolean {
  const rows = allow.filter((a) => !a.startsWith("!")).map(globRe);
  return (path) => rows.some((re) => re.test(path));
}

export function uncoveredRoutes(allow: readonly string[] = RUN_WORKER_FIRST): string[] {
  const covered = claimedByWorker(allow);
  return [...EXACT_PATHS, ...PREFIX_ROUTES.map((r) => r.probe)].filter((p) => !covered(p));
}
