// The canonical site-level MCP surface. It is intentionally stateless and
// read-only: one JSON-RPC request in, one JSON response out, with the same
// functions used by the corresponding HTTP endpoints.
import { readAroundChanges } from "./around.js";
import { readCoffeeAvailability } from "./coffee.js";
import { LENS_BUDGETS, compareLensTargets, lensInspect, lensObservationSummary, overLensBudget, validateLensTarget } from "./lens.js";
import { jsonResponse } from "./lib/http.js";
import { queryPhotos } from "./photos.js";
import { RN_FALLBACK, getTracksSWR } from "./rn.js";
import { searchSite } from "./search.js";
import { AGENT_SURFACES } from "./lib/site-manifest.js";

// DUAL-ERA, which the 2026-07-28 spec explicitly sanctions: "A dual-era server
// selects its behavior from how the client opens. A request carrying modern
// per-request `_meta` is served statelessly according to this revision. An
// `initialize` request selects legacy semantics."
//
// 2026-07-28 deleted the `initialize`/`notifications/initialized` handshake and
// made every request carry its own protocol version, client identity, and
// capabilities in `_meta`. That is a hard break for the three revisions this
// server already advertised, and legacy clients have NO fall-forward mechanism —
// a legacy client against a modern-only server just fails. So both eras are
// served on this one endpoint, and the client's own opening move decides which.
//
// This site was unusually well placed for the change. The header above has said
// "intentionally stateless" since it was written, and statelessness is precisely
// what the new revision assumes: no sessions, no `Mcp-Session-Id`, list results
// that do not vary per connection. There was nothing to unwind.
const MCP_MODERN = "2026-07-28";
const MCP_LEGACY = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SUPPORTED = [MCP_MODERN, ...MCP_LEGACY];
// What a legacy `initialize` gets when it asks for something we do not know.
const MCP_PROTOCOL = "2025-06-18";

// `_meta` keys are namespaced by the spec and the prefix is mandatory.
const META = "io.modelcontextprotocol/";
const META_PROTOCOL = `${META}protocolVersion`;
const META_SERVER_INFO = `${META}serverInfo`;

// Self-reported and explicitly NOT a security signal — the spec says clients
// should not change behavior on it. Display, logging, debugging.
const SERVER_INFO = { name: "aadhar.sh", title: "Aadharsh Site", version: "2.0.0" };
const CAPABILITIES = { tools: {}, resources: {} };
const INSTRUCTIONS = "Read-only public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, and Lens. resources/list enumerates the site's public pages; resources/read fetches one. No mutations or private data are exposed.";

// Error codes. -32022 and its siblings come from the 2026-07-28 allocation
// policy, which reserved -32020..-32099 for the spec and grandfathered existing
// SDK use of -32000..-32019. Resource-not-found moved from -32002 to -32602 in
// the same revision; this file already used -32602, so that one needed no edit.
const ERR_HEADER_MISMATCH = -32020;
const ERR_UNSUPPORTED_PROTOCOL = -32022;

// CacheableResult (`ttlMs` + `cacheScope`) is required on list and read results
// in 2026-07-28. It is a freshness HINT that lets a client cache instead of
// poll, and it complements listChanged notifications rather than replacing them.
//
// The numbers follow what actually changes each surface. Tools are a static
// array in this file, and resources are projected from site-manifest.json, so
// both change exactly at deploy: an hour is a fair bet against a site that
// deploys a few times a week, and a stale entry costs a client one 404 it
// already has to handle. resources/read fetches a live page, so it gets the
// shorter window. Prompts are permanently empty, so a day is honest.
//
// `public` throughout because every one of these surfaces is public: this
// server has no auth, no per-caller view, and nothing an intermediary would be
// wrong to share. That is the same property that lets `resources/read` exist.
const CACHE_DISCOVER  = { ttlMs: 3_600_000,  cacheScope: "public" };
const CACHE_TOOLS     = { ttlMs: 3_600_000,  cacheScope: "public" };
const CACHE_RESOURCES = { ttlMs: 3_600_000,  cacheScope: "public" };
const CACHE_READ      = { ttlMs:   300_000,  cacheScope: "public" };
const CACHE_PROMPTS   = { ttlMs: 86_400_000, cacheScope: "public" };
// Generous for a real client (they batch a handful of calls, not hundreds) and
// small enough that a batch can't outrun the per-IP crawl budgets. See the note
// at the batch branch in handleSiteMcp.
const MCP_MAX_BATCH = 16;

const MCP_TOOLS = [
  {
    name: "search_site",
    description: "Search the public pages, writing, garage notes, and utility descriptions on aadhar.sh.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "case-insensitive search query" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["q"] },
  },
  {
    name: "now_playing",
    description: "Read the cached current rn playlist and its tracks. A cold cache may refresh from the public Spotify embed using AadharshBot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "photo_query",
    description: "Query the published photo archive by caption, camera, lens, film simulation, film-recipe setting, or date range. Each result carries a `recipe` card naming the in-camera settings the shot was made with, so a look can be read back and re-shot. GPS and unlisted EXIF fields are never returned.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, camera: { type: "string" }, lens: { type: "string" }, film: { type: "string", description: "film simulation name, e.g. \"Classic Chrome\", \"Nostalgic Neg\", \"Acros\"" }, recipe: { type: "string", description: "substring match anywhere in the recipe card, e.g. \"DR400\", \"Clarity: -2\", \"Grain Effect: Strong, Large\", \"+2 Red\"" }, from: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, to: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 10000 } } },
  },
  {
    name: "coffee_availability",
    description: "Read bookable coffee slots in the host timezone. If the calendar is stale or unavailable, the result is explicitly unavailable and contains no slots.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "change_radar",
    description: "Read the bounded historical diff of the latest AadharshBot neighborhood observations. Raw crawled bodies are not stored or returned.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
  },
  {
    name: "lens_inspect",
    description: "Inspect one public HTTP(S) URL through Lens and return a compact agent-readiness observation. Private, local, and non-HTTP targets are rejected.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "lens_compare",
    description: "Inspect two public HTTP(S) URLs and compare status, content, readiness, spectrum, agent doors, and discovery surfaces.",
    inputSchema: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] },
  },
];

// The site's public surfaces as MCP resources, projected from the generated
// agent catalog (lib/site-manifest.js, itself derived from site-manifest.json).
// name is the stable path; uri is absolute so a client can dereference it
// directly. resources/read below fetches these same paths, so listing here
// promises nothing the server can't serve.
const MCP_RESOURCE_PATHS = new Set(AGENT_SURFACES.map((s) => s.path));
function mcpResources(origin) {
  return AGENT_SURFACES.map((s) => ({
    uri: origin + s.path,
    name: s.path,
    title: s.title,
    description: s.description,
    mimeType: "text/html",
  }));
}

// resources/read: fetch one listed surface, same-origin only. Restricting to
// MCP_RESOURCE_PATHS keeps this from being a general-purpose fetcher (no SSRF to
// other hosts, no arbitrary path), and every listed resource is genuinely
// readable, so list and read stay in lockstep.
async function readResource(uri, request) {
  let target;
  try { target = new URL(uri); } catch { return null; }
  const origin = new URL(request.url).origin;
  if (target.origin !== origin || !MCP_RESOURCE_PATHS.has(target.pathname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(origin + target.pathname, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const mimeType = (res.headers.get("content-type") || "text/html").split(";")[0].trim();
    const text = (await res.text()).slice(0, 200000);
    return { uri, mimeType, text };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function mcpCors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    // mcp-session-id is still allowed even though 2026-07-28 removed sessions
    // and this server never had one: a legacy client may still send it, and
    // rejecting the preflight over a header we intend to ignore would break it.
    // mcp-method/mcp-name are the 2026-07-28 routing headers (see headerMismatch).
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, authorization",
    "access-control-max-age": "86400",
  };
}

// Every modern result carries `resultType` and the server's identity in `_meta`,
// and list/read results add the cache hint. Emitted UNCONDITIONALLY, including
// to legacy clients, which is safe in both directions: JSON-RPC clients ignore
// unknown result fields, and the spec tells modern clients to read a missing
// `resultType` as "complete" anyway. One code path beats two that must agree.
function mcpResult(id, payload, cache) {
  return { jsonrpc: "2.0", id, result: {
    resultType: "complete",
    ...payload,
    ...(cache || {}),
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  } };
}

// The version this request declares, or null for a legacy caller. `_meta` is
// the ONLY modern signal: the MCP-Protocol-Version header predates this
// revision (2025-06-18 introduced it for HTTP), so a header alone would
// misclassify a legacy client as modern.
function declaredVersion(msg) {
  const v = msg?.params?._meta?.[META_PROTOCOL];
  return typeof v === "string" && v ? v : null;
}

// 2026-07-28 requires Mcp-Method and Mcp-Name on Streamable HTTP POSTs so
// intermediaries can route and authorize without parsing a JSON-RPC body.
//
// DELIBERATE DEVIATION: they are validated when present and never required.
// Requiring them would reject every legacy client at the transport layer, which
// is exactly the "Legacy client, Modern server -> Fails" row of the spec's own
// compatibility matrix, and this server exists to be reachable. A mismatch is
// still an error, because a header that disagrees with the body is the case the
// header exists to prevent — a proxy authorizing `tools/list` while the body
// calls a tool.
function headerMismatch(msg, request) {
  const method = request.headers.get("mcp-method");
  if (method && msg?.method && method !== msg.method) {
    return `Mcp-Method header says ${method} but the body calls ${msg.method}`;
  }
  const name = request.headers.get("mcp-name");
  const bodyName = msg?.params?.name || msg?.params?.uri;
  if (name && bodyName && name !== bodyName) {
    return `Mcp-Name header says ${name} but the body targets ${bodyName}`;
  }
  return null;
}

function errorResult(message) { return { _error: String(message).slice(0, 400) }; }

// The crawl tools bill against the SAME per-IP buckets as their HTTP twins
// (lens.js LENS_BUDGETS), not a private `mcp:lensrl:` one. A separate bucket let
// a caller stack budgets: 30 inspections via /lens/fetch AND another 8 here, and
// lens_compare was metered at 8/min through JSON-RPC while /lens/compare allows
// 4, so the cheaper door was the expensive operation. One bucket, one ceiling,
// whichever door you knock on.

async function callTool(name, args, request, env, ctx) {
  args = args && typeof args === "object" ? args : {};
  if (name === "search_site") return searchSite(env, args.q, args.limit);
  if (name === "photo_query") return queryPhotos(env, args, ctx);
  if (name === "coffee_availability") return readCoffeeAvailability(env, ctx);
  if (name === "change_radar") return readAroundChanges(env, args.limit);
  if (name === "now_playing") {
    const playlistId = env.RN_KV ? await env.RN_KV.get("playlist-id") : null;
    const pid = /^[0-9A-Za-z]{22}$/.test(playlistId || "") ? playlistId : RN_FALLBACK.split("/").pop();
    try {
      const tracks = await getTracksSWR(env, ctx, pid, { buildOnMiss: true });
      return tracks || { available: false, playlist_id: pid, tracks: [] };
    } catch { return errorResult("the playlist is temporarily unavailable"); }
  }
  if (name === "lens_inspect") {
    const target = validateLensTarget(args.url || "");
    if (!target.ok) return errorResult(target.error);
    if (await overLensBudget(LENS_BUDGETS.inspect, request, env)) return errorResult("Lens lookups are rate-limited to 30/min, shared with /lens/fetch.");
    try { return lensObservationSummary(await lensInspect(target.url, env, { skipBotViews: true })); }
    catch { return errorResult("Lens inspection failed."); }
  }
  if (name === "lens_compare") {
    const left = validateLensTarget(args.left || "");
    const right = validateLensTarget(args.right || "");
    if (!left.ok) return errorResult(`left: ${left.error}`);
    if (!right.ok) return errorResult(`right: ${right.error}`);
    if (await overLensBudget(LENS_BUDGETS.compare, request, env)) return errorResult("Lens comparisons are rate-limited to 4/min, shared with /lens/compare.");
    try { return await compareLensTargets(left.url, right.url, env); }
    catch { return errorResult("Lens comparison failed."); }
  }
  return { _unknown: true };
}

export async function handleSiteMcp(request, env, ctx) {
  const cors = mcpCors();
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const respond = (body, status = 200) => body === null
    ? new Response(null, { status, headers: cors })
    : jsonResponse(body, status, { ...cors, "cache-control": "no-store" });
  if (request.method !== "POST") return respond({ error: "Use POST with JSON-RPC 2.0." }, 405);

  let payload;
  try { payload = await request.json(); } catch { return respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
  const handleOne = async (msg) => {
    const hasId = !!msg && typeof msg === "object" && "id" in msg;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return hasId ? rpcError(msg.id, -32600, "Invalid Request") : null;
    const id = msg.id;
    try {
      // Version gate, before anything else. A modern caller declares its
      // revision per request; if we cannot speak it, the spec requires -32022
      // carrying the list we DO speak, so the client can pick one and retry
      // rather than guess. This is also the probe a dual-era client uses to
      // recognise a modern server, so the error shape is load-bearing.
      const declared = declaredVersion(msg);
      if (declared && !MCP_SUPPORTED.includes(declared)) {
        return hasId ? { jsonrpc: "2.0", id, error: {
          code: ERR_UNSUPPORTED_PROTOCOL,
          message: "Unsupported protocol version",
          data: { supported: MCP_SUPPORTED, requested: declared },
        } } : null;
      }
      const mismatch = headerMismatch(msg, request);
      if (mismatch) return hasId ? rpcError(id, ERR_HEADER_MISMATCH, mismatch) : null;

      // MUST be implemented as of 2026-07-28. Answers identity, capabilities,
      // and supported versions in one round trip, so a client can render what
      // this server is without probing tools/list + resources/list + prompts/list.
      if (msg.method === "server/discover") {
        return mcpResult(id, {
          supportedVersions: MCP_SUPPORTED,
          capabilities: CAPABILITIES,
          instructions: INSTRUCTIONS,
        }, CACHE_DISCOVER);
      }

      // LEGACY ERA. Removed in 2026-07-28 and kept because deleting it strands
      // every pre-2026 client with no way forward. A legacy client that asks for
      // a version we do not know is answered in the newest LEGACY revision
      // rather than in the modern one: it cannot speak modern, so handing it
      // 2026-07-28 would be a handshake it fails on the next request.
      if (msg.method === "initialize") {
        const requested = msg.params?.protocolVersion;
        return { jsonrpc: "2.0", id, result: {
          protocolVersion: MCP_LEGACY.includes(requested) ? requested : MCP_PROTOCOL,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        } };
      }
      // Also removed in 2026-07-28, also kept for legacy callers. Cheap.
      if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };

      // tools/list order is deterministic because MCP_TOOLS is a literal array
      // and nothing sorts or filters it. 2026-07-28 asks for that so clients can
      // cache the list and so an LLM's prompt cache keeps hitting.
      if (msg.method === "tools/list") return mcpResult(id, { tools: MCP_TOOLS }, CACHE_TOOLS);
      if (msg.method === "resources/list") return mcpResult(id, { resources: mcpResources(new URL(request.url).origin) }, CACHE_RESOURCES);
      if (msg.method === "resources/templates/list") return mcpResult(id, { resourceTemplates: [] }, CACHE_RESOURCES);
      if (msg.method === "resources/read") {
        const uri = msg.params?.uri;
        const content = await readResource(uri, request);
        // -32602 rather than -32002: 2026-07-28 aligned resource-not-found with
        // JSON-RPC's Invalid Params, and this file already used the new code.
        if (!content) return rpcError(id, -32602, `Unknown or unreadable resource: ${uri}`);
        return mcpResult(id, { contents: [content] }, CACHE_READ);
      }
      if (msg.method === "prompts/list") return mcpResult(id, { prompts: [] }, CACHE_PROMPTS);
      if (msg.method.startsWith("notifications/")) return null;
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const out = await callTool(name, msg.params?.arguments, request, env, ctx);
        if (out?._unknown) return rpcError(id, -32602, `Unknown tool: ${name}`);
        // A tool that failed is a RESULT with isError, never a JSON-RPC error:
        // the call itself succeeded, and the model is supposed to read the text.
        if (out?._error) return mcpResult(id, { content: [{ type: "text", text: out._error }], isError: true });
        return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
      }
      return hasId ? rpcError(id, -32601, `Method not found: ${msg.method}`) : null;
    } catch (error) {
      return hasId ? rpcError(id, -32603, `Internal error: ${String(error?.message || error).slice(0, 240)}`) : null;
    }
  };
  if (Array.isArray(payload)) {
    // Cap the batch. The crawl budgets are not atomic under concurrency: a batch
    // runs through Promise.all, so N simultaneous tool calls can all observe an
    // under-budget counter and all proceed. Unbounded, one POST carrying N
    // lens_inspect calls turns a 30/min ceiling into N outbound crawls.
    //
    // This survived the move off KV counters onto the Rate Limiting binding
    // (2026-08-04) and the reason is worth keeping straight. The old note blamed
    // KV's read-then-write and concluded "KV can't be made atomic without a
    // Durable Object". The binding is not read-then-write, and it is STILL not
    // atomic here: its own docs say counters are locally cached and updated
    // asynchronously, and that it is "intentionally designed to not be used as
    // an accurate accounting system". So the cap is what makes the ceiling mean
    // anything, exactly as before, for a different underlying reason.
    if (payload.length > MCP_MAX_BATCH) {
      return respond(rpcError(null, -32600, `Batch too large: ${payload.length} messages, limit ${MCP_MAX_BATCH}.`), 413);
    }
    const output = (await Promise.all(payload.map(handleOne))).filter(Boolean);
    return output.length ? respond(output) : respond(null, 202);
  }
  const output = await handleOne(payload);
  return output === null ? respond(null, 202) : respond(output);
}
