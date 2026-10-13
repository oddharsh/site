// lib/openapi.ts: the OpenAPI 3.1 document build.ts writes to /openapi.json.
//
// The operations come from lib/public-api.ts, which /developers also renders,
// and every number in them is the constant its handler enforces. This module
// adds the component schemas (response shapes read from the handlers on
// 2026-10-13) and the document around them. Only build.ts and the contract
// tests import it, so none of it ships in the Worker bundle.
//
// Node-safe (gotcha 16).
import { LEAVES_OUT, OPERATIONS, READ_POLICY, arr, bool, budgeted, int, limited, nullStr, num, obj, ref, sharesReadBudget, str, type Operation, type Schema } from "./public-api.ts";
import { allowedMethods } from "./api-contract.ts";

export { OPENAPI_PATH } from "./public-api.ts";

// ── schemas ──────────────────────────────────────────────────────────────────
const intOrNull = (description?: string): Schema => ({ ...int(description), type: ["integer", "null"] });
/** An object whose every value is a string: headers, meta tags. */
const strMap = (description?: string): Schema =>
  description === undefined ? { type: "object", additionalProperties: str() } : { type: "object", additionalProperties: str(), description };
/** A recipe card value. */
const SCALAR: Schema = { type: ["string", "number", "boolean", "null"] };
/** A compared field's value on either side of /lens/compare.json. */
const CHANGED: Schema = { type: ["string", "integer", "boolean", "null"] };
/** A crawl column's value on either side of a change. */
const COLUMN: Schema = { type: ["string", "integer", "null"] };

export const SCHEMAS: Record<string, Schema> = {
  Error: obj({
    ok: bool("Always false on an error, where the endpoint uses an ok flag."),
    error: str("A sentence describing what went wrong, for a person or an agent to read."),
    code: str("A stable machine token, where the endpoint sets one: not_found, method_not_allowed, unsupported_api_version, rate_limited, storage_unavailable."),
    status: int("The HTTP status, repeated in the body."),
    hint: str("What to try next."),
    suggestions: arr(str(undefined, { format: "uri" }), "Absolute URLs of the closest real pages, on a 404."),
    docs: str("Where the API is documented.", { format: "uri" }),
    parameter: str("The query parameter that was rejected (/ask)."),
    allow: arr(str(), "The methods the path answers, on a 405."),
    supported: arr(str(), "The API versions served, on a 400 for API-Version."),
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
  PhotoMetadata: obj({
    camera: nullStr(), lens: nullStr(), aperture: nullStr("As written, for example f/2.8."), shutter: nullStr("As written, for example 1/60."),
    iso: intOrNull(), focal: nullStr(), ev: { type: ["number", "string", "null"], description: "Exposure compensation: a number, or a signed string such as +0.33." },
    date: nullStr("As EXIF writes it, YYYY:MM:DD HH:MM:SS, with no timezone."),
    width: intOrNull(), height: intOrNull(), color_space: nullStr(), white_balance: nullStr(), color_temp: intOrNull(), wb_shift: nullStr(),
    flash: nullStr(), exposure_mode: nullStr(), meter: nullStr(), focus_mode: nullStr(), drive: nullStr(), sharpness: nullStr(),
    noise_reduction: nullStr(), clarity: intOrNull(), film: nullStr("Fuji film simulation."), dr: nullStr(), dr_value: intOrNull(),
    chrome: nullStr(), chrome_blue: nullStr(), grain: nullStr(), grain_size: nullStr(), highlight_tone: nullStr(), shadow_tone: nullStr(), saturation: nullStr(),
    recipe: ref("FujiRecipe"),
  }, undefined, "Public-safe EXIF and Fuji fields, read from the file. A field the camera did not record is null and a field the extractor never read is absent: nothing is guessed."),
  FujiRecipe: {
    type: "object", description: "The frame's film recipe card, keyed the way a recipe is written down. Absent on frames with no recipe.",
    properties: Object.fromEntries(["Film Simulation", "Dynamic Range", "Grain Effect", "Color Chrome Effect", "Color Chrome FX Blue", "White Balance",
      "Highlight", "Shadow", "Color", "Sharpness", "High ISO NR", "Clarity", "ISO", "Exposure Compensation"].map((k) => [k, str()])),
    additionalProperties: SCALAR,
  },
  Photo: obj({
    stem: str("The photo's id."), alt: str("Caption, up to 240 characters."), full: nullStr("Full-resolution original URL."),
    thumb: obj({ avif: nullStr(), jpg: nullStr(), small: nullStr(), xs: nullStr() }),
    metadata: ref("PhotoMetadata"),
    score: num("Present when q was given."), matched: arr(str(), "Terms that matched, when q was given."),
  }, ["stem", "thumb", "metadata"]),
  PhotoQuery: obj({
    query: obj(Object.fromEntries(["q", "camera", "lens", "film", "recipe", "from", "to"].map((k) => [k, str()])), undefined, "The normalized filters, empty strings when absent."),
    ranking: obj({ mode: str(undefined, { enum: ["filters-only", "no-terms", "all-terms", "partial", "no-match"] }), terms: arr(str()), semantic: bool(),
      dropped: arr(str(), "Terms dropped as matching nothing; omitted when empty."), common: arr(str(), "Terms dropped as too common; omitted when empty.") }, ["mode", "terms", "semantic"]),
    total: int(), offset: int(), limit: int(), photos: arr(ref("Photo")),
  }, ["total", "photos"]),

  // ── /lens ──
  RelLink: obj({ rel: str(), href: str(), type: str(), title: str(), hreflang: str() }, ["rel", "href"], "A <link> or Link header entry."),
  Probe: { description: "One well-known path fetched from the target's origin.", anyOf: [
    obj({ ok: bool(), status: int(), url: str(), contentType: str(), headers: strMap(), body: str("The body, capped."), truncated: bool() }, ["ok", "status", "url"], "Reached with a 2xx."),
    obj({ ok: bool(), status: int(), url: str(), headers: strMap() }, ["ok", "status", "url"], "Answered with another status."),
    obj({ ok: bool(), error: str(), url: str() }, ["ok", "error", "url"], "Could not be fetched."),
  ] },
  LensPhases: obj({
    page: bool(), discovery: bool(), botViews: bool(), discoveryDeferred: bool(), discoveryCached: bool(), discoveryShared: bool(), subrequestCap: bool(),
    wallCheck: str("ok, none, no AI binding, or the error the wall check hit."),
  }, ["page", "discovery", "botViews"], "Which passes ran. A field from a pass that did not run is absent, never zero."),
  BotView: obj({
    key: str(), label: str(), owner: str(), userAgent: str(), role: str(undefined, { enum: ["control", "search", "train", "answers"] }),
    status: intOrNull(), contentType: str(), sampleBytes: int(), blocked: bool(), challenge: bool(), redirected: bool(), error: str(),
    wall: obj({ p: { type: ["number", "null"] }, model: str(), error: str() }, ["p", "model"], "A model's read of whether the sample is a bot wall."),
  }, ["key", "label", "role", "status", "blocked", "challenge"], "The target as one crawler's User-Agent sees it."),
  AgentDoor: { description: "A JSON discovery document on the target.", anyOf: [
    obj({ present: bool(), status: intOrNull(), unknown: bool() }, ["present", "status", "unknown"]),
    obj({ present: bool(), note: str() }, ["present", "note"]),
    obj({ present: bool(), detail: str() }, ["present", "detail"]),
  ] },
  AgentVerdict: obj({ verdict: str(undefined, { enum: ["yes", "likely", "maybe", "no", "unknown"] }), detail: str(), error: str() }, ["verdict", "detail"]),
  ReadinessCheck: obj({
    key: str(), category: str(), label: str(), status: str(undefined, { enum: ["pass", "fail", "unknown", "neutral"] }),
    detail: str(), optional: bool(), countInScore: bool(),
    notApplicable: bool("Present and true on a check the site has declared does not apply to it; its status is then neutral."),
  }, ["key", "status"]),
  LensObservation: obj({
    ok: bool(), url: str(undefined, { format: "uri" }), finalUrl: str(undefined, { format: "uri" }), redirected: bool(), status: int(),
    contentType: str(), binary: bool(), truncated: bool(), elapsedMs: int(), fetchedBy: str(), headers: strMap("Response headers, lowercased."),
    bodyUnreadable: obj({ reason: str(undefined, { enum: ["undecodable-content-encoding"] }), encoding: str() }, ["reason", "encoding"]),
    framable: bool(), frameReason: nullStr(), phases: ref("LensPhases"),
    anatomy: obj({
      rawHtml: str(), rawBytes: int(), parsedBytes: int(), parseTruncated: bool(), text: str(), wordCount: int(), imgTotal: int(), imgNoAlt: int(),
      headings: arr(obj({ level: int(undefined, { minimum: 1, maximum: 6 }), text: str() }, ["level", "text"])),
    }, undefined, "The document itself. parsedBytes and parseTruncated are HTML only."),
    structured: obj({
      title: str(), meta: strMap(), og: strMap(), twitter: strMap(),
      jsonld: arr({ anyOf: [
        obj({ valid: bool(), types: arr(str()), json: str("The block, re-serialized as indented JSON text.") }, ["valid", "types", "json"]),
        obj({ valid: bool(), error: str(), raw: str() }, ["valid", "error", "raw"]),
      ] }),
      microdata: obj({ itemtypes: arr(str()), props: arr(str()) }), rdfa: obj({ typeof: arr(str()), properties: arr(str()) }),
      microformats: arr(str()), relLinks: arr(ref("RelLink")),
    }, undefined, "Structured data on an HTML page."),
    ai: obj({
      markdown: str("The page as Markdown (HTML only)."), llmsTxtPresent: bool(),
      directives: obj({ metaRobots: nullStr(), xRobotsTag: nullStr(), namesAiCrawlers: bool() }),
    }),
    cost: { type: ["object", "null"], description: "What reading the page costs a model, per representation. Null when nothing could be priced.", properties: {
      tokenizer: str(), checked: str(), rates: arr(obj({ model: str(), usdPerMtok: num() }, ["model", "usdPerMtok"])),
      tiers: arr(obj({ key: str(undefined, { enum: ["html", "text", "markdown", "outline", "raw"] }), label: str(), note: str(), chars: int(), tokens: int() }, ["key", "chars", "tokens"])),
      partial: obj({ parsedBytes: int(), rawBytes: int() }),
    } },
    discovery: obj({
      origin: str(), feeds: arr(ref("RelLink")),
      oauthDiscovery: obj({ openidConfiguration: ref("Probe"), oauthAuthorizationServer: ref("Probe") }),
      commerce: obj({ ucp: ref("Probe"), acp: ref("Probe"), ap2: ref("Probe") }),
      ...Object.fromEntries(["robotsTxt", "sitemapXml", "llmsTxt", "llmsFullTxt", "aiTxt", "securityTxt", "webBotAuth", "oauthProtectedResource", "authMd", "mcpServerCard", "agentSkills"].map((k) => [k, ref("Probe")])),
      sitemapDeclared: { description: "The sitemap robots.txt declares, with an entries count when it parsed. Null when none is declared.", anyOf: [ref("Probe"), { type: "null" }] },
      dnsAid: { anyOf: [
        obj({ ok: bool(), found: bool(), dnssecValidated: bool(), names: arr(str()), records: arr(obj({ name: str(), status: int(), dnssecValidated: bool(), answers: int() })) }, ["ok", "found", "names", "records"]),
        obj({ ok: bool(), found: bool(), names: arr(str()), error: str() }, ["ok", "found", "error"]),
      ] },
      agentsMd: obj({ ok: bool(), present: bool(), unknown: bool(), variant: str(), status: int(), body: str(), truncated: bool(), note: str(), error: str() }, ["ok", "present"]),
    }, undefined, "Well-known paths on the target's origin. Present when the discovery pass ran."),
    wire: obj({
      dictionary: obj({ observed: bool(), offer: nullStr(), negotiates: bool(), activeEncoding: nullStr() }),
      ech: obj({ observed: bool(), recordPresent: bool(), parsed: bool(), dnssecValidated: bool(), error: str() }, ["observed", "recordPresent", "parsed"]),
    }, undefined, "Transport features: shared compression dictionaries and Encrypted Client Hello."),
    terms: obj({
      path: str(), robotsPresent: bool(), robotsUnknown: bool(), robotsError: nullStr(),
      scoreboard: arr(obj({ ua: str(), owner: str(), kind: str(), note: str(), verdict: str(undefined, { enum: ["allow", "block", "unknown"] }), matchedUa: nullStr(), rule: nullStr() }, ["ua", "verdict"])),
      signals: arr(obj({ agents: arr(str()), raw: str(), parsed: strMap() })),
      paid: obj({ http402: bool(), crawlerHeaders: strMap(), x402: nullStr() }),
      enforcement: obj({ status: int(), challenged: bool(), blocked: bool() }),
      directives: obj({ metaRobots: nullStr(), xRobotsTag: nullStr(), noai: bool() }),
      tdmrep: obj({ present: bool(), invalid: str(), body: str(), rules: int(), reserved: { type: ["boolean", "null"] }, location: nullStr(), policy: nullStr() }, ["present"], "TDMRep (W3C) at /.well-known/tdmrep.json."),
      spectrum: obj({ tier: str(undefined, { enum: ["open", "signaled", "enforced", "paid"] }), reasons: arr(str()) }, ["tier", "reasons"]),
    }, undefined, "What the target says AI crawlers may do, and whether it enforces it."),
    agent: obj({
      mcp: ref("AgentVerdict"), nlweb: ref("AgentVerdict"),
      webmcp: obj({ found: bool(), kind: str(undefined, { enum: ["inline", "bridge"] }), marker: str() }, ["found"]),
      agentCard: ref("AgentDoor"), openapi: ref("AgentDoor"), aiPlugin: ref("AgentDoor"), apiCatalog: ref("AgentDoor"),
      mdNegotiation: obj({ supported: bool(), contentType: str(), status: int(), note: str(), error: str() }, ["supported"]),
      llmsTxt: obj({ present: bool(), unknown: bool() }),
      strategy: obj({ verdict: str(undefined, { enum: ["agent-native", "agent-readable", "human-only"] }), note: str(), action: arr(str()), readable: arr(str()), unknowns: arr(str()) }, ["verdict"]),
    }, undefined, "The doors an agent could use."),
    botViews: arr(ref("BotView"), "Empty when the bot pass was skipped."),
    readiness: obj({
      overall: int(undefined, { minimum: 0, maximum: 100 }), level: int(undefined, { enum: [0, 1, 3, 5] }), levelName: str(), levelNote: nullStr(),
      categories: arr(obj({ key: str(), label: str(), score: int(), passed: int(), total: int(), checkCount: int(), countInScore: bool() })),
      checks: { type: "object", description: "One entry per check, keyed by its name.", additionalProperties: ref("ReadinessCheck") },
      counted: int(), passed: int(),
      keyless: nullStr("Why the authority checks do not apply, when the site's OpenAPI document declares every operation keyless; otherwise null."),
      scoringNote: str(), nextActions: arr(obj({ key: str(), label: str() }, ["key", "label"])), botViews: arr(ref("BotView")),
      field: obj({ overall: intOrNull(), scoringNote: str(),
        components: arr(obj({ key: str(undefined, { enum: ["identifiedFetch", "sampledBots", "usableBody", "agentDoor"] }), label: str(), score: intOrNull(), detail: str() })) }),
    }, undefined, "The agent-readiness score and the checks behind it."),
    available: bool("mode=cloudflare: false when Cloudflare's score could not be read, with error."), score: int("mode=cloudflare only: level times 20."),
    levelName: nullStr("mode=cloudflare only."), source: str("mode=cloudflare only."), sourceUrl: str("mode=cloudflare only.", { format: "uri" }),
    fromCache: bool("mode=cloudflare only."), error: str("mode=cloudflare only, when available is false."),
    level: int("mode=cloudflare only, 0-5.", { minimum: 0, maximum: 5 }),
  }, ["ok"], "One public URL as a machine reads it. The page-derived fields are always present; discovery, wire, terms, agent, botViews and readiness appear when the discovery pass ran (see phases). With mode=cloudflare the body is ok, available, level, score, levelName, source, sourceUrl and fromCache instead."),
  LensSummary: obj({
    url: str(), finalUrl: str(), redirected: bool(), status: intOrNull(), contentType: str(), elapsedMs: intOrNull(), truncated: bool(),
    title: str(), wordCount: int(), bytes: intOrNull(), parsedBytes: intOrNull(), parseTruncated: bool(),
    readiness: intOrNull(), fieldScore: intOrNull(), level: intOrNull(), levelName: nullStr(), levelNote: nullStr(),
    tier: nullStr("unknown or a spectrum tier when measured; null when discovery did not run."), doors: intOrNull(),
    cost: { type: ["object", "null"], properties: { tokens: int(), usdPerRead: num(), model: str() } },
    phases: ref("LensPhases"),
    surfaces: { type: ["object", "null"], description: "Null when discovery did not run.", properties: Object.fromEntries(["llms", "markdown", "mcp", "agentCard", "apiCatalog"].map((k) => [k, bool()])) },
  }, ["url", "finalUrl", "status", "phases"]),
  LensComparison: obj({
    ok: bool(), comparedAt: str(undefined, { format: "date-time" }), left: ref("LensSummary"), right: ref("LensSummary"),
    changes: arr(obj({ field: str(), label: str(), before: CHANGED, after: CHANGED }, ["field", "before", "after"])),
    discovery: obj({ left: str(undefined, { enum: ["none", "deferred", "cached", "shared", "refused", "live"] }), right: str(undefined, { enum: ["none", "deferred", "cached", "shared", "refused", "live"] }) }),
  }, ["ok", "left", "right", "changes"]),
  Census: obj({
    ok: bool(), roster: int(), snapshots: int(), firstYmd: nullStr(), lastYmd: nullStr(),
    lastSweep: { description: "The most recent weekly sweep. Null when none is recorded; only error when it could not be read.", anyOf: [
      { type: "null" },
      obj({ error: nullStr() }, ["error"]),
      obj({ ymd: str(), roster: int(), recorded: int(), written: int(), outcomes: { type: "object", additionalProperties: int(), description: "Hosts per outcome: dispatched, duplicate, dispatch_failed, written, cap, failed." },
        unfinished: arr(str()), problems: arr(obj({ host: str(), outcome: str(), detail: nullStr() })) }, ["ymd", "roster", "recorded", "written", "outcomes"]),
    ] },
    sites: arr(obj({ host: str(), url: str(), tier: str(), score: { type: ["number", "null"] }, level: intOrNull(), doors: int(), verdict: str(), delta: int(),
      surfaces: obj(Object.fromEntries(["llms", "md", "mcp", "agents", "jsonld", "webBotAuth"].map((k) => [k, bool()])), undefined, "Empty when the stored row could not be parsed."),
      series: arr(obj({ ymd: str(), score: { type: ["number", "null"] }, tier: str(), doors: int() })) })),
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
    results: arr(obj({ name: str(), url: str(), finalUrl: str(), status: int(), title: str(), description: str(), ogImage: str(),
      server: str(), lastModified: str("The Last-Modified header as sent, empty when absent."), contentType: str(), bodyHash: str("SHA-256 hex of the bytes read."),
      bytesRead: int(), truncated: bool(), robots: str(undefined, { enum: ["allow", "disallow", "undetermined"] }), robotsRule: str(),
      skipped: str(undefined, { enum: ["robots"] }), error: str(), elapsedMs: int() }, ["name", "url", "elapsedMs"],
      "A crawled page, a robots skip (skipped, robotsRule) or a failure (error).")),
  }, ["crawledAt", "results"]),
  Pending: obj({ pending: bool(), note: str() }, ["pending", "note"], "No snapshot exists yet."),
  AroundChanges: obj({
    ok: bool(), available: bool(), latestObservedAt: nullStr(), targetCount: int(), note: str(), error: str(),
    changes: arr(obj({ target: str(), name: str(), observedAt: str(undefined, { format: "date-time" }), previousObservedAt: str(undefined, { format: "date-time" }), ageMs: int(),
      severity: str(undefined, { enum: ["high", "medium", "low"] }),
      changes: arr(obj({ field: str(undefined, { enum: ["status", "final_url", "title", "description", "content_type", "robots", "skipped", "error", "content"] }),
        before: COLUMN, after: COLUMN, detail: str("content only, which carries no before or after.") }, ["field"])) })),
  }, ["ok", "available", "changes"]),
  Availability: obj({
    available: bool(), stale: bool(), source: str(undefined, { enum: ["fresh", "stale", "live", "none"] }), checkedAt: str(undefined, { format: "date-time" }),
    ageSeconds: { type: ["integer", "null"] }, timezone: str(), bookingUrl: str(undefined, { format: "uri" }), error: str(),
    slots: arr(obj({ start: str(undefined, { format: "date-time" }), end: str(undefined, { format: "date-time" }), startMs: int(), endMs: int(), durationMinutes: int() })),
  }, ["available", "slots"]),
  Ledger: obj({
    ok: bool(), via: str(undefined, { enum: ["binding", "token"] }), reason: str("Present when ok is false."), binding_fallback: str(),
    error: str("A sentence, present when ok is false."), code: str("not_configured or upstream_failed, present when ok is false."), window_days: int(), rate_usd: num(), note: str(),
    line_items: arr(obj({ bot: str(), owner: str(), kind: str(), hits: int(), amountUsd: num() })),
    total_hits: int(), total_usd: num(),
    cost: { description: "What the site itself cost over the window, from Cloudflare billing.", anyOf: [
      obj({ available: bool(), total_usd: num(), currency: str(), from: str(undefined, { format: "date" }), to: str(undefined, { format: "date" }), service_families: arr(str()), note: str() }, ["available", "total_usd", "currency"]),
      obj({ available: bool(), reason: str() }, ["available", "reason"]),
    ] },
  }, ["ok"]),
  PhotoManifest: obj({
    photos: arr(obj({ stem: str(), full: str(), thumb_avif: str(), thumb_jpg: str(), thumb_small: str(), thumb_xs: nullStr(),
      size: int(), uploaded: nullStr(), album: nullStr(), heif: nullStr() })),
    count: int(),
  }, ["photos", "count"]),
  Resume: obj({
    $schema: str(undefined, { format: "uri" }),
    meta: obj({ canonical: str(undefined, { format: "uri" }), version: str(), note: str() }),
    basics: obj({ name: str(), email: str(undefined, { format: "email" }), url: str(undefined, { format: "uri" }),
      profiles: arr(obj({ network: str(), username: str(), url: str(undefined, { format: "uri" }) }, ["network", "username"])) }, ["name"]),
    work: arr(obj({ name: str(), position: str(), location: str(), startDate: str("YYYY-MM."), endDate: str("YYYY-MM; absent for the current role."), summary: str(), highlights: arr(str()) }, ["name", "position", "startDate"])),
    education: arr(obj({ institution: str(), location: str(), area: str(), studyType: str(), score: str(), endDate: str() }, ["institution"])),
    volunteer: arr(obj({ organization: str(), position: str(), location: str(), startDate: str(), endDate: str(), highlights: arr(str()) }, ["organization", "position"])),
  }, ["basics", "work"], "A JSON Resume document (jsonresume.org)."),
};

// ── what lib/api-contract.ts adds to every operation ─────────────────────────
const CONTRACT_HEADERS = { Link: { $ref: "#/components/headers/ServiceDesc" } };

/** One operation as the spec prints it: the contract's 405, its read budget,
 *  and its response headers, on top of what public-api.ts says. */
function specOperation(op: Operation, allow: string[]) {
  const { path: _path, method: _method, example: _example, ...rest } = op;
  const responses: Record<string, any> = {};
  for (const [status, r] of Object.entries(op.responses)) responses[status] = { ...r };
  responses[405] ??= { description: `A method other than ${allow.join(", ")} (code method_not_allowed). The Allow header lists them.`, content: { "application/json": { schema: ref("Error") } } };
  // No limiter of its own, so it bills the shared read budget (api-contract.ts).
  if (sharesReadBudget(op)) {
    for (const status of Object.keys(responses)) if (status.startsWith("2")) responses[status] = budgeted(responses[status], [READ_POLICY]);
    responses[429] = limited(`Over the shared read budget of ${READ_POLICY[1]} requests a minute per caller (code rate_limited).`, [READ_POLICY]);
  }
  for (const r of Object.values(responses)) r.headers = { ...r.headers, ...CONTRACT_HEADERS };
  return { ...rest, responses };
}

/** The document build.ts writes to /openapi.json. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    paths[op.path] ??= {};
    paths[op.path][op.method] = specOperation(op, allowedMethods(OPERATIONS.filter((o) => o.path === op.path)));
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "aadhar.sh public API",
      // The document's own revision, which OpenAPI requires. It tracks nothing a
      // client can pin: LEAVES_OUT says why there is no API version.
      version: "1",
      summary: "Keyless, read-only JSON endpoints on aadhar.sh.",
      description: "The public HTTP API of aadhar.sh, Aadharsh Pannirselvam's personal site. Every endpoint is read-only and needs no key, account or signup: production is the sandbox. Errors are JSON with at least an `error` sentence (see the Error schema). The same capabilities are tools on the MCP server at https://aadhar.sh/mcp. Guide: https://aadhar.sh/developers.\n\nWhat it leaves out: " + LEAVES_OUT.map(({ what, why }) => `${what}. ${why}`).join(" "),
      contact: { name: "Aadharsh Pannirselvam", email: "coffee@aadhar.sh", url: "https://aadhar.sh/contact" },
    },
    externalDocs: { description: "Developer guide", url: "https://aadhar.sh/developers" },
    servers: [{ url: "https://aadhar.sh", description: "Production, which is also the sandbox: every endpoint is keyless and read-only, so a test call needs no account and cannot change anything." }],
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
    components: {
      schemas: SCHEMAS,
      headers: {
        ServiceDesc: { description: "Includes `</openapi.json>; rel=\"service-desc\"` (RFC 8631).", schema: str() },
      },
    },
  };
}
