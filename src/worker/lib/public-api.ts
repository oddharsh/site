// lib/public-api.ts: the keyless JSON API, described once.
//
// build.ts writes /openapi.json from these operations (lib/openapi.ts adds the
// component schemas and the document around them), and /developers (trust.ts)
// renders its endpoint list and examples from OPERATIONS, so the spec, the
// page and the handlers cannot disagree about a number: every cap, default and
// rate budget below is the constant the handler itself enforces
// (lib/api-limits.ts, LENS_BUDGETS, ASK_BUDGET), and the census roster is
// counted. Shapes were read from the handlers on 2026-10-13;
// contract-openapi-describes-only-real-endpoints holds each path to a real
// route.
//
// The component schemas live in lib/openapi.ts, which only build.ts and the
// tests import: /developers needs the operations, and the Worker bundle has no
// use for response shapes it never serves itself.
//
// Node-safe (gotcha 16): build.ts imports it from the staged tree.
import { API_READ_BUDGET, ASK_LIMITS, CHANGE_RADAR_LIMITS, LENS_FETCH_TIMEOUT_MS, PHOTO_QUERY_LIMITS, SEARCH_LIMITS } from "./api-limits.ts";
import { ASK_BUDGET } from "../ask-rank.ts";
import { RATE_WINDOW_S, rateLimitPolicy } from "./ratelimit.ts";
import { LENS_BUDGETS, type LensBudget } from "../lens-pipeline.ts";
import { CENSUS_ROSTER } from "../census.ts";

export type Schema = Record<string, unknown>;
type Param = { name: string; in: "query"; required: boolean; description: string; schema: Schema };
type Responses = Record<string, { description: string; content: Record<string, { schema: Schema }>; headers?: Record<string, Schema> }>;
export type Operation = {
  path: string;
  method: "get" | "post";
  operationId: string;
  tags: string[];
  summary: string;
  description: string;
  parameters?: Param[];
  requestBody?: Schema;
  responses: Responses;
  /** A query that answers something real, for /developers and its curl lines. */
  example?: string;
};

export const OPENAPI_PATH = "/openapi.json";

/** The machinery a public API usually carries that this one skips, and why.
 *  /developers and /openapi.json both print it, so each absence reads as a
 *  decision rather than a gap for the next readiness audit to fill. The site
 *  shipped OAuth tokens, version headers and Deprecation headers for a scanner
 *  and removed them on 2026-10-13, since no caller needed any of the three. */
export const LEAVES_OUT: readonly { what: string; why: string }[] = [
  { what: "Keys, accounts and OAuth",
    why: "Every endpoint is free, public and read-only, so there is nothing to sign up for and a credential would unlock nothing. The site once issued anonymous OAuth tokens that no endpoint checked, and dropped them." },
  { what: "A sandbox or test mode",
    why: "Production is the sandbox. Every endpoint is read-only, so a test call changes nothing, and a separate copy would only drift from the real API. On the MCP server, representation_capture and representation_compare each store a snapshot row, and their descriptions say so." },
  { what: "Version headers and pinning",
    why: "One person maintains the API, and it has one live shape: the one /openapi.json describes. New endpoints, parameters and fields arrive without notice, so ignore fields you don't know." },
  { what: "Deprecation and Sunset headers",
    why: "A notice period protects clients that depend on an exact shape, and none is known here. A breaking change lands in /openapi.json the day it ships." },
];

// Schema helpers, exported because openapi.ts builds the component schemas
// with them.
/** Set `key` only when there is a value, so an absent description is absent. */
function withField(schema: Schema, key: string, value: unknown): Schema {
  if (value !== undefined) schema[key] = value;
  return schema;
}
export const str = (description?: string, extra: Schema = {}): Schema => withField({ type: "string", ...extra }, "description", description);
export const int = (description?: string, extra: Schema = {}): Schema => withField({ type: "integer", ...extra }, "description", description);
export const num = (description?: string): Schema => withField({ type: "number" }, "description", description);
export const bool = (description?: string): Schema => withField({ type: "boolean" }, "description", description);
export const nullStr = (description?: string): Schema => withField({ type: ["string", "null"] }, "description", description);
export const arr = (items: Schema, description?: string): Schema => withField({ type: "array", items }, "description", description);
export const obj = (properties: Record<string, Schema>, required?: string[], description?: string): Schema =>
  withField(withField({ type: "object", properties }, "required", required), "description", description);
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const q = (name: string, schema: Schema, description: string, required = false): Param => ({ name, in: "query", required, description, schema });
const json = (description: string, schema: Schema): Responses[string] => ({ description, content: { "application/json": { schema } } });
const err = (description: string) => json(description, ref("Error"));
// The RateLimit fields as draft-ietf-httpapi-ratelimit-headers-11 writes them:
// Structured Field Lists, one member per policy, named by budget.
export type Policy = readonly [name: string, max: number];
const lensPolicy = (b: LensBudget): Policy => [b, LENS_BUDGETS[b].max];
/** The policy every operation without a 429 of its own shares (api-contract.ts). */
export const READ_POLICY: Policy = ["read", API_READ_BUDGET.max];
/** True for an operation that bills the shared read budget: one whose own
 *  description declares no 429, because it has no limiter of its own. */
export const sharesReadBudget = (op: Operation): boolean => !("429" in op.responses);
const policyHeader = (policies: readonly Policy[]): Schema => ({
  description: `The quota this endpoint bills, as a Structured Field List: ${policies.map(([n, max]) => rateLimitPolicy(n, max)).join(", ")}. q is requests and w the window in seconds.`,
  schema: str(),
});
/** A 2xx from a budgeted door, which names its policy. */
export const budgeted = (response: Responses[string], policies: readonly Policy[]): Responses[string] =>
  ({ ...response, headers: { ...response.headers, "RateLimit-Policy": policyHeader(policies) } });
/** A 429 from the site's own limiter, which always says when to come back. */
export const limited = (description: string, policies: readonly Policy[]): Responses[string] => ({
  ...err(description),
  headers: {
    "Retry-After": { description: `Seconds until the per-minute budget resets; at most ${RATE_WINDOW_S}. Takes precedence over RateLimit.`, schema: int(undefined, { minimum: 1, maximum: RATE_WINDOW_S }) },
    "RateLimit-Policy": policyHeader(policies),
    "RateLimit": { description: `The policy that refused the request, with nothing remaining (r=0) for up to t=${RATE_WINDOW_S} seconds.`, schema: str() },
  },
});
const CLAMPED = "Values outside the range are clamped, and a non-number falls back to the default.";

const inspect = LENS_BUDGETS.inspect.max;
const compare = LENS_BUDGETS.compare.max;
const askRanked = ASK_BUDGET.max;

export const OPERATIONS: readonly Operation[] = [
  {
    path: "/search.json", method: "get", operationId: "searchSite", tags: ["search"], summary: "Search the site",
    description: "Lexical search over the public pages, writing, garage notes and utility descriptions. Use it to find a page by topic before fetching that page's Markdown twin.",
    parameters: [
      q("q", str(undefined, { maxLength: SEARCH_LIMITS.queryMax }), "Search terms. Stopwords are dropped and at most 12 terms are used.", true),
      q("limit", int(undefined, { minimum: 1, maximum: SEARCH_LIMITS.limitMax, default: SEARCH_LIMITS.limitDefault }), `Maximum results. ${CLAMPED}`),
    ],
    responses: { 200: json("Ranked results.", ref("SearchResults")), 400: err("q is missing or blank.") },
    example: "q=fhe&limit=3",
  },
  {
    path: "/ask", method: "get", operationId: "askSite", tags: ["search"], summary: "Ask a natural-language question (NLWeb)",
    description: `NLWeb's REST endpoint over the same corpus as /search.json. Streaming is on by default, per the protocol: a bare GET is a server-sent event stream, and streaming=0 returns one JSON body. Results are ranked by Clef, a decision model that chooses among every page on the site, so a page can answer a question it shares no word with; score is then the probability Clef puts on that page. When Clef is slow, unavailable or past its ${askRanked} questions per caller per minute, ranking falls back to lexical and _meta.ranking says which ran. Descriptions are extractive: this origin runs no generative model, so it never writes an answer, and mode=summarize or generate is refused by name. The same answer is the ask tool on /mcp.`,
    parameters: [
      q("query", str(), "The question.", true),
      q("streaming", str(undefined, { default: "1" }), "0, false, no or off returns one JSON body. Any other value, or none, streams text/event-stream."),
      q("mode", str(undefined, { enum: ["list", "summarize", "generate"], default: "list" }), "Only list is served. summarize and generate return 501 with supported_modes."),
      q("site", str(undefined, { enum: ["", "all", "aadhar.sh", "https://aadhar.sh"] }), "The only site is aadhar.sh."),
      q("top_k", int(undefined, { minimum: 1, maximum: ASK_LIMITS.topKMax, default: ASK_LIMITS.topKDefault }), "Maximum results. `limit` is read when top_k is absent."),
      q("prev", str(), `Earlier queries in the conversation, comma-separated, at most ${ASK_LIMITS.prevMax}.`),
      q("decontextualized_query", str(), "If present, this string is searched instead of query."),
      q("query_id", str(), "Echoed back. A UUID is generated when absent."),
    ],
    responses: {
      200: { description: "One JSON body when streaming=0, otherwise an NLWeb event stream.",
        content: { "application/json": { schema: ref("AskResponse") }, "text/event-stream": { schema: str() } } },
      400: err("query is missing, or site or mode is unknown."), 501: err("mode is summarize or generate."),
    },
    example: "query=how+does+the+site+sign+requests&streaming=0",
  },
  {
    path: "/ask", method: "post", operationId: "askSiteStructured", tags: ["search"], summary: "Ask with an NLWeb v0.55 body",
    description: "The NLWeb v0.55 dialect: a JSON body whose query is an object selects it, and streaming answers use named start, result and complete events. Body fields win over query-string fields.",
    requestBody: { required: true, content: { "application/json": { schema: obj({
      query: obj({ text: str(), site: str() }, ["text"]),
      prefer: obj({ streaming: bool(), mode: str(undefined, { enum: ["list"] }) }),
      context: obj({ prev: arr(str()) }), query_id: str(), top_k: int(undefined, { minimum: 1, maximum: ASK_LIMITS.topKMax }),
    }, ["query"]) } } },
    responses: {
      200: { description: "One JSON body when prefer.streaming is false, otherwise named server-sent events.",
        content: { "application/json": { schema: ref("AskResponse") }, "text/event-stream": { schema: str() } } },
      400: err("The body is not JSON, or a field is invalid."), 405: err("A method other than GET, POST or HEAD."),
    },
  },
  {
    path: "/photos/query.json", method: "get", operationId: "queryPhotos", tags: ["photos"], summary: "Query the photo archive",
    description: "Filter the published photo archive by caption, camera, lens, film simulation, Fuji recipe or date. Returned EXIF is a public-safe allowlist. Every Fuji frame carries a recipe card naming the settings it was shot with (film simulation, dynamic range, grain, color chrome, white balance shift, tone, color, sharpness, clarity), and recipe= matches anywhere inside it, as in recipe=DR400 or recipe=Clarity:%20-2, so a look can be read back and re-shot.",
    parameters: [
      q("q", str(undefined, { maxLength: PHOTO_QUERY_LIMITS.textMax }), "Caption search; the only ranked field."),
      q("camera", str(undefined, { maxLength: PHOTO_QUERY_LIMITS.textMax }), "Case-insensitive substring of the camera."),
      q("lens", str(undefined, { maxLength: PHOTO_QUERY_LIMITS.textMax }), "Case-insensitive substring of the lens."),
      q("film", str(undefined, { maxLength: PHOTO_QUERY_LIMITS.textMax }), "Case-insensitive substring of the film simulation."),
      q("recipe", str(undefined, { maxLength: PHOTO_QUERY_LIMITS.textMax }), "Case-insensitive substring anywhere in the recipe card, for example DR400."),
      q("from", str(undefined, { format: "date" }), "Earliest date, YYYY-MM-DD."),
      q("to", str(undefined, { format: "date" }), "Latest date, YYYY-MM-DD."),
      q("limit", int(undefined, { minimum: 1, maximum: PHOTO_QUERY_LIMITS.limitMax, default: PHOTO_QUERY_LIMITS.limitDefault }), `Page size. ${CLAMPED}`),
      q("offset", int(undefined, { minimum: 0, maximum: PHOTO_QUERY_LIMITS.offsetMax, default: 0 }), "Rows to skip."),
    ],
    responses: { 200: json("Matching photos.", ref("PhotoQuery")) },
    example: "recipe=DR400&limit=5",
  },
  {
    path: "/lens/fetch", method: "get", operationId: "inspectUrl", tags: ["lens"], summary: "Inspect how a machine reads a URL",
    description: `Fetch one public URL server-side as AadharshBot and return what a machine sees: status, headers, structured data, the token cost of the HTML, per-bot robots verdicts, discovery surfaces and an agent-readiness score. Shares a ${inspect} per minute per-caller budget with ${LENS_BUDGETS.inspect.shares.replace("/lens/fetch, ", "")}.`,
    parameters: [
      q("url", str(), "The public http or https URL. https:// is assumed when no scheme is given. Ports other than 80 and 443, credentials, and private or link-local hosts are refused.", true),
      q("phases", str(undefined, { enum: ["page"] }), "page limits the scan to fields derived from the page itself (one subrequest)."),
      q("mode", str(undefined, { enum: ["cloudflare"] }), "cloudflare returns the Cloudflare Agent Readiness level instead of the full observation."),
    ],
    responses: {
      200: budgeted(json("The observation.", ref("LensObservation")), [lensPolicy("inspect")]), 400: err("The URL is missing or refused."),
      429: limited(`Over the ${inspect} per minute budget.`, [lensPolicy("inspect")]), 502: err(`The target timed out (${LENS_FETCH_TIMEOUT_MS / 1000} seconds) or failed.`),
    },
    example: "url=example.com",
  },
  {
    path: "/lens/compare.json", method: "get", operationId: "compareUrls", tags: ["lens"], summary: "Compare two URLs",
    description: `Inspect two public URLs and report the differences in status, content, readiness, tier and agent surfaces. Limited to ${compare} comparisons per caller per minute.`,
    parameters: [q("left", str(), "The first URL, validated like /lens/fetch.", true), q("right", str(), "The second URL.", true)],
    responses: {
      200: budgeted(json("The comparison.", ref("LensComparison")), [lensPolicy("compare")]), 400: err("left or right is missing or refused."),
      429: limited(`Over the ${compare} per minute budget.`, [lensPolicy("compare")]), 502: err("The comparison failed."),
    },
    example: "left=example.com&right=aadhar.sh",
  },
  {
    path: "/lens/census.json", method: "get", operationId: "getCensus", tags: ["lens"], summary: "Read the weekly agent-readiness census",
    description: `A weekly, longitudinal record of how agent-ready ${CENSUS_ROSTER.length} representative sites are, with each site's score and tier over time.`,
    responses: { 200: json("The census.", ref("Census")), 503: err("Census storage is unavailable.") },
  },
  {
    path: "/rn/tracks", method: "get", operationId: "getNowPlaying", tags: ["music"], summary: "Read the current playlist",
    description: "The tracks on Aadharsh's current \"rn\" Spotify playlist. Each track has a title, its artists, a song.link URL that opens in the listener's own music service, its duration, a preview URL and an explicit flag. Cached for an hour.",
    responses: {
      200: json("The playlist.", ref("Tracks")), 500: err("Storage is not configured."),
      502: err("The playlist could not be read from Spotify."), 503: err("No playlist is set (code no_playlist), or storage could not be read (code storage_unavailable)."),
    },
  },
  {
    path: "/around/json", method: "get", operationId: "getNeighborhood", tags: ["around"], summary: "Read the neighborhood crawl",
    description: "The latest AadharshBot crawl of a small list of crypto venture firm homepages: status, title, description and robots verdict for each. The same data as the /around page.",
    responses: { 200: json("The latest snapshot.", ref("AroundReport")), 503: json("No snapshot exists yet. Retry after a day.", ref("Pending")) },
  },
  {
    path: "/around/changes.json", method: "get", operationId: "getChangeRadar", tags: ["around"], summary: "Read what changed in the neighborhood",
    description: "A bounded history of changes between crawls of the neighborhood: status, title, description, robots and content changes. Never returns crawled page bodies.",
    parameters: [q("limit", int(undefined, { minimum: 1, maximum: CHANGE_RADAR_LIMITS.limitMax, default: CHANGE_RADAR_LIMITS.limitDefault }), `Maximum change records. ${CLAMPED}`)],
    responses: { 200: json("Recent changes.", ref("AroundChanges")), 503: err("Change history is temporarily unavailable.") },
  },
  {
    path: "/coffee/availability.json", method: "get", operationId: "getCoffeeAvailability", tags: ["contact"], summary: "List open coffee slots",
    description: "Bookable coffee slots in New York, in the host's timezone. Fails closed: when the calendar is stale or unreachable it returns no slots. Booking happens at bookingUrl and is confirmed by hand.",
    responses: {
      200: json("Open slots.", ref("Availability")), 503: json("The calendar is unavailable; slots is empty. Retry after 60 seconds.", ref("Availability")),
      405: err("A method other than GET or HEAD."),
    },
  },
  {
    path: "/ledger.json", method: "get", operationId: "getCrawlLedger", tags: ["lens"], summary: "Read the AI-crawler ledger",
    description: "The last 30 days of identified AI-crawler visits to this site, priced at one cent a page as commentary.",
    responses: {
      200: json("The ledger.", ref("Ledger")),
      502: json("Analytics could not be read (code upstream_failed).", ref("Ledger")),
      503: json("Analytics is not configured on this deployment (code not_configured).", ref("Ledger")),
    },
  },
  {
    path: "/images/manifest.json", method: "get", operationId: "getPhotoManifest", tags: ["photos"], summary: "List every published photo",
    description: "Every published photo with its thumbnail URLs, full-resolution key, size and upload date. The homepage grid draws from it.",
    responses: { 200: json("The manifest.", ref("PhotoManifest")) },
  },
  {
    path: "/resume.json", method: "get", operationId: "getResume", tags: ["about"], summary: "Read the resume",
    description: "Aadharsh Pannirselvam's resume as JSON Resume. The same content is at /resume.md and /resume.pdf.",
    responses: { 200: json("The resume.", ref("Resume")) },
  },
];

/** The operation with this id; throws so a renamed endpoint fails the build. */
export function operation(operationId: string): Operation {
  const op = OPERATIONS.find((o) => o.operationId === operationId);
  if (!op) throw new Error(`public-api: no operation ${operationId}`);
  return op;
}

export function exampleUrl(op: Operation): string {
  return op.example ? `${op.path}?${op.example}` : op.path;
}
