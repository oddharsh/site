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
import { CACHE_EMPTY, CACHE_LIVE, CACHE_STATIC, mcpCorsHeaders, mcpGate, mcpServer } from "./lib/mcp-protocol.js";

// DUAL-ERA. The wire rules (versions, `_meta` keys, resultType, cache hints,
// error codes, the header check) live in lib/mcp-protocol.js because
// /serendipity/mcp is a second MCP server on this same origin and the two must
// not drift into different dialects. That file carries the full argument; what
// matters here is that a request with modern `_meta` is served statelessly
// under 2026-07-28 and an `initialize` request selects legacy semantics.
//
// This server was unusually well placed for the change. The header above has
// said "intentionally stateless" since it was written, and statelessness is
// precisely what the new revision assumes. There was nothing to unwind.
const MCP = mcpServer({
  // Self-reported and explicitly NOT a security signal — the spec says clients
  // should not change behavior on it. Display, logging, debugging.
  serverInfo: { name: "aadhar.sh", title: "Aadharsh Site", version: "2.0.0" },
  capabilities: { tools: {}, resources: {} },
  instructions: "Read-only public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, and Lens. resources/list enumerates the site's public pages; resources/read fetches one. No mutations or private data are exposed.",
});

// Which cache hint each surface earns. Tools are a static array in this file and
// resources are projected from site-manifest.json, so both change exactly at
// deploy; resources/read fetches a live page; prompts are permanently empty.
const CACHE_TOOLS     = CACHE_STATIC;
const CACHE_RESOURCES = CACHE_STATIC;
const CACHE_READ      = CACHE_LIVE;
const CACHE_PROMPTS   = CACHE_EMPTY;
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

const mcpCors = mcpCorsHeaders;

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
      // Version first, then the routing headers. Both rules are shared with
      // /serendipity/mcp (lib/mcp-protocol.js) so the two servers cannot
      // diverge on which requests they refuse.
      const refused = mcpGate(msg, request, id, hasId);
      if (refused !== null) return refused;

      // MUST be implemented as of 2026-07-28. Identity, capabilities and
      // supported versions in one round trip, so a client can render what this
      // server is without probing tools/list + resources/list + prompts/list.
      if (msg.method === "server/discover") return MCP.discover(id);

      // LEGACY ERA. Removed in 2026-07-28 and kept because deleting it strands
      // every pre-2026 client with no way forward.
      if (msg.method === "initialize") return MCP.initialize(id, msg.params?.protocolVersion);
      // Also removed in 2026-07-28, also kept for legacy callers. Cheap.
      if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };

      // tools/list order is deterministic because MCP_TOOLS is a literal array
      // and nothing sorts or filters it. 2026-07-28 asks for that so clients can
      // cache the list and so an LLM's prompt cache keeps hitting.
      if (msg.method === "tools/list") return MCP.result(id, { tools: MCP_TOOLS }, CACHE_TOOLS);
      if (msg.method === "resources/list") return MCP.result(id, { resources: mcpResources(new URL(request.url).origin) }, CACHE_RESOURCES);
      if (msg.method === "resources/templates/list") return MCP.result(id, { resourceTemplates: [] }, CACHE_RESOURCES);
      if (msg.method === "resources/read") {
        const uri = msg.params?.uri;
        const content = await readResource(uri, request);
        // -32602 rather than -32002: 2026-07-28 aligned resource-not-found with
        // JSON-RPC's Invalid Params, and this file already used the new code.
        if (!content) return rpcError(id, -32602, `Unknown or unreadable resource: ${uri}`);
        return MCP.result(id, { contents: [content] }, CACHE_READ);
      }
      if (msg.method === "prompts/list") return MCP.result(id, { prompts: [] }, CACHE_PROMPTS);
      if (msg.method.startsWith("notifications/")) return null;
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const out = await callTool(name, msg.params?.arguments, request, env, ctx);
        if (out?._unknown) return rpcError(id, -32602, `Unknown tool: ${name}`);
        // A tool that failed is a RESULT with isError, never a JSON-RPC error:
        // the call itself succeeded, and the model is supposed to read the text.
        if (out?._error) return MCP.result(id, { content: [{ type: "text", text: out._error }], isError: true });
        return MCP.result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
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
