// lib/openapi.ts: the OpenAPI 3.1 document build.ts writes to /openapi.json.
//
// The operations come from lib/public-api.ts, which /developers also renders,
// and every number in them is the constant its handler enforces. This module
// adds the component schemas (response shapes read from the handlers on
// 2026-10-13) and the document around them. Only build.ts and the contract
// tests import it, so none of it ships in the Worker bundle.
//
// Node-safe (gotcha 16).
import { OPERATIONS, arr, bool, int, nullStr, num, obj, open, ref, str, type Schema } from "./public-api.ts";

export { OPENAPI_PATH } from "./public-api.ts";

// ── schemas ──────────────────────────────────────────────────────────────────
export const SCHEMAS: Record<string, Schema> = {
  Error: obj({
    ok: bool("Always false on an error, where the endpoint uses an ok flag."),
    error: str("A sentence describing what went wrong, for a person or an agent to read."),
    code: str("A stable machine token, where the endpoint sets one: not_found, method_not_allowed, storage_unavailable."),
    status: int("The HTTP status, repeated in the body."),
    hint: str("What to try next."),
    suggestions: arr(str(undefined, { format: "uri" }), "Absolute URLs of the closest real pages, on a 404."),
    docs: str("Where the API is documented.", { format: "uri" }),
    parameter: str("The query parameter that was rejected (/ask)."),
  }, ["error"], "The site's error shape. Every JSON endpoint answers its errors in JSON with at least `error`. Endpoints may add their own fields (for example /ask echoes `query_id` and `results`, /rn/tracks keeps `tracks: []`)."),
  SearchResult: obj({
    url: str(undefined, { format: "uri-reference" }), title: str(), description: str(),
    kind: str(undefined, { enum: ["page", "writing", "document", "utility"] }), snippet: str(),
  }, ["url", "title", "kind"]),
  SearchResults: obj({ query: str(), total: int("Matches before the limit."), returned: num("Rows returned."), results: arr(ref("SearchResult")) }, ["query", "total", "results"]),
  AskResult: obj({
    url: str(undefined, { format: "uri" }), name: str(), site: str(undefined, { const: "aadhar.sh" }),
    score: int("0-100. With Clef ranking, the probability Clef puts on this page.", { minimum: 0, maximum: 100 }),
    description: str("An extractive snippet, never model-written."),
    schema_object: obj({ "@context": str(), "@type": str(undefined, { enum: ["WebPage", "BlogPosting", "DigitalDocument", "WebAPI"] }), "@id": str(), url: str(), name: str(), description: str() }, undefined, "A schema.org node for the result."),
  }, ["url", "name", "score"]),
  AskResponse: obj({
    query_id: str(), query: str(), site: str(undefined, { const: "aadhar.sh" }), mode: str(undefined, { const: "list" }),
    decontextualized_query: str(), total: int(), results: arr(ref("AskResult")),
    _meta: obj({ version: str(), dialect: str(undefined, { enum: ["legacy", "0.55"] }), retrieval: str(), ranking: str("Which ranker ran: Clef, or lexical with the reason."), description: str(undefined, { const: "extractive" }), modes_supported: arr(str()) }),
  }, ["query_id", "results"], "NLWeb /ask answer, returned as one JSON body when streaming=0."),
  Photo: obj({
    stem: str("The photo's id."), alt: str("Caption, up to 240 characters."), full: nullStr("Full-resolution original URL."),
    thumb: obj({ avif: nullStr(), jpg: nullStr(), small: nullStr(), xs: nullStr() }),
    metadata: open("Public-safe EXIF and Fuji recipe fields that are present for this frame (camera, lens, aperture, shutter, iso, focal, date, film, dr, grain, recipe and others). Absent fields are omitted, never guessed."),
    score: num("Present when q was given."), matched: arr(str(), "Terms that matched, when q was given."),
  }, ["stem", "thumb", "metadata"]),
  PhotoQuery: obj({
    query: obj(Object.fromEntries(["q", "camera", "lens", "film", "recipe", "from", "to"].map((k) => [k, str()])), undefined, "The normalized filters, empty strings when absent."),
    ranking: obj({ mode: str(undefined, { enum: ["filters-only", "no-terms", "all-terms", "partial", "no-match"] }), terms: arr(str()), semantic: bool() }),
    total: int(), offset: num(), limit: num(), photos: arr(ref("Photo")),
  }, ["total", "photos"]),
  LensObservation: { type: "object", additionalProperties: true, required: ["ok", "url"],
    description: "One public URL as a machine reads it. The page-derived fields are always present; discovery, wire, terms, agent, botViews and readiness appear when the discovery pass ran. With mode=cloudflare the body is the Cloudflare Agent Readiness level instead.",
    properties: {
      ok: bool(), url: str(undefined, { format: "uri" }), finalUrl: str(undefined, { format: "uri" }), redirected: bool(), status: int(),
      contentType: str(), elapsedMs: int(), fetchedBy: str(), headers: { type: "object", additionalProperties: str() },
      anatomy: open(), structured: open(), ai: open(), readiness: open(),
      available: bool("mode=cloudflare only."), level: int("mode=cloudflare only, 0-5.", { minimum: 0, maximum: 5 }), score: int("mode=cloudflare only, level times 20."),
    } },
  LensSummary: { type: "object", additionalProperties: true, properties: {
    url: str(), finalUrl: str(), status: int(), title: { type: ["string", "null"] }, wordCount: { type: ["integer", "null"] },
    readiness: { type: ["number", "null"] }, level: { type: ["integer", "null"] }, tier: { type: ["string", "null"] },
    surfaces: { type: ["object", "null"], additionalProperties: true },
  } },
  LensComparison: obj({
    ok: bool(), comparedAt: str(undefined, { format: "date-time" }), left: ref("LensSummary"), right: ref("LensSummary"),
    changes: arr(obj({ field: str(), label: str(), before: {}, after: {} })),
    discovery: obj({ left: str(undefined, { enum: ["none", "deferred", "cached", "shared", "refused", "live"] }), right: str(undefined, { enum: ["none", "deferred", "cached", "shared", "refused", "live"] }) }),
  }, ["ok", "left", "right", "changes"]),
  Census: obj({
    ok: bool(), roster: int(), snapshots: int(), firstYmd: nullStr(), lastYmd: nullStr(),
    lastSweep: { type: ["object", "null"], additionalProperties: true },
    sites: arr(obj({ host: str(), url: str(), tier: str(), score: num(), level: int(), doors: int(), verdict: str(), delta: num(),
      series: arr(obj({ ymd: str(), score: num(), tier: str(), doors: int() })) })),
  }, ["ok", "sites"]),
  Track: obj({
    id: str(), title: str(), artists_text: str(), spotify_url: str(undefined, { format: "uri" }),
    song_link_url: str("A song.link forwarder to the listener's own music service.", { format: "uri" }),
    duration_ms: { type: ["integer", "null"] }, preview_url: nullStr(), is_explicit: bool(), image_url: nullStr(),
    artists: arr(obj({ id: str(), name: str(), spotify_url: str(), image_url: nullStr() })),
  }, ["id", "title", "song_link_url"]),
  Tracks: obj({ playlist_id: str(), playlist_name: str(), tracks: arr(ref("Track")), fetched_at: str(undefined, { format: "date-time" }),
    error: str("Present, with an empty tracks list, when no playlist is set.") }, ["tracks"]),
  AroundReport: obj({
    crawledBy: str(), crawledAt: str(undefined, { format: "date-time" }), signedWith: str(), count: int(),
    results: arr(obj({ name: str(), url: str(), finalUrl: str(), status: int(), title: str(), description: str(),
      robots: str(undefined, { enum: ["allow", "disallow", "undetermined"] }), skipped: str(), error: str(), elapsedMs: int() })),
  }, ["crawledAt", "results"]),
  Pending: obj({ pending: bool(), note: str() }, ["pending", "note"], "No snapshot exists yet."),
  AroundChanges: obj({
    ok: bool(), available: bool(), latestObservedAt: nullStr(), targetCount: int(), note: str(),
    changes: arr(obj({ target: str(), name: str(), observedAt: str(undefined, { format: "date-time" }), previousObservedAt: str(undefined, { format: "date-time" }), ageMs: int(),
      severity: str(undefined, { enum: ["high", "medium", "low"] }),
      changes: arr(obj({ field: str(undefined, { enum: ["status", "final_url", "title", "description", "content_type", "robots", "skipped", "error", "content"] }), before: {}, after: {}, detail: str() })) })),
  }, ["ok", "available", "changes"]),
  Availability: obj({
    available: bool(), stale: bool(), source: str(undefined, { enum: ["fresh", "stale", "live", "none"] }), checkedAt: str(undefined, { format: "date-time" }),
    ageSeconds: { type: ["integer", "null"] }, timezone: str(), bookingUrl: str(undefined, { format: "uri" }), error: str(),
    slots: arr(obj({ start: str(undefined, { format: "date-time" }), end: str(undefined, { format: "date-time" }), startMs: int(), endMs: int(), durationMinutes: int() })),
  }, ["available", "slots"]),
  Ledger: obj({
    ok: bool(), via: str(undefined, { enum: ["binding", "token"] }), reason: str("Present when ok is false."),
    error: str("A sentence, present when ok is false."), code: str("not_configured or upstream_failed, present when ok is false."), window_days: int(), rate_usd: num(), note: str(),
    line_items: arr(obj({ bot: str(), owner: str(), kind: str(), hits: int(), amountUsd: num() })),
    total_hits: int(), total_usd: num(), cost: open(),
  }, ["ok"]),
  PhotoManifest: obj({
    photos: arr(obj({ stem: str(), full: str(), thumb_avif: str(), thumb_jpg: str(), thumb_small: str(), thumb_xs: nullStr(),
      size: int(), uploaded: nullStr(), album: nullStr(), heif: nullStr() })),
    count: int(),
  }, ["photos", "count"]),
  Resume: { type: "object", description: "A JSON Resume document (jsonresume.org).", additionalProperties: true,
    properties: { basics: open(), work: arr(open()), education: arr(open()) } },
};

/** The document build.ts writes to /openapi.json. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { path, method, example: _example, ...op } of OPERATIONS) {
    paths[path] ??= {};
    paths[path][method] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "aadhar.sh public API",
      version: "2026-10-13",
      summary: "Keyless, read-only JSON endpoints on aadhar.sh.",
      description: "The public HTTP API of aadhar.sh, Aadharsh Pannirselvam's personal site. Every endpoint is read-only and needs no key, account or signup: production is the sandbox. Errors are JSON with at least an `error` sentence (see the Error schema). The same capabilities are tools on the MCP server at https://aadhar.sh/mcp. Guide: https://aadhar.sh/developers.",
      contact: { name: "Aadharsh Pannirselvam", email: "coffee@aadhar.sh", url: "https://aadhar.sh/contact" },
    },
    externalDocs: { description: "Developer guide", url: "https://aadhar.sh/developers" },
    servers: [{ url: "https://aadhar.sh" }],
    security: [],
    tags: [
      { name: "search", description: "Find pages on the site." },
      { name: "photos", description: "The photo archive and its Fuji recipes." },
      { name: "lens", description: "How machines read the web." },
      { name: "music", description: "What is playing right now." },
      { name: "around", description: "The crawled neighborhood of venture firm homepages." },
      { name: "contact", description: "Reaching Aadharsh." },
      { name: "about", description: "Who runs the site." },
    ],
    paths,
    components: { schemas: SCHEMAS },
  };
}
