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

const MCP_PROTOCOL = "2025-06-18";
const MCP_SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
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
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
    "access-control-max-age": "86400",
  };
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
    if (await overLensBudget(LENS_BUDGETS.inspect, request, env, ctx)) return errorResult("Lens lookups are rate-limited to 30/min, shared with /lens/fetch.");
    try { return lensObservationSummary(await lensInspect(target.url, env, { skipBotViews: true })); }
    catch { return errorResult("Lens inspection failed."); }
  }
  if (name === "lens_compare") {
    const left = validateLensTarget(args.left || "");
    const right = validateLensTarget(args.right || "");
    if (!left.ok) return errorResult(`left: ${left.error}`);
    if (!right.ok) return errorResult(`right: ${right.error}`);
    if (await overLensBudget(LENS_BUDGETS.compare, request, env, ctx)) return errorResult("Lens comparisons are rate-limited to 4/min, shared with /lens/compare.");
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
      if (msg.method === "initialize") {
        const requested = msg.params?.protocolVersion;
        return { jsonrpc: "2.0", id, result: {
          protocolVersion: MCP_SUPPORTED.includes(requested) ? requested : MCP_PROTOCOL,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "aadhar.sh", title: "Aadharsh Site", version: "1.0.0" },
          instructions: "Read-only public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, and Lens. resources/list enumerates the site's public pages; resources/read fetches one. No mutations or private data are exposed.",
        } };
      }
      if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (msg.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
      if (msg.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: mcpResources(new URL(request.url).origin) } };
      if (msg.method === "resources/read") {
        const uri = msg.params?.uri;
        const content = await readResource(uri, request);
        if (!content) return rpcError(id, -32602, `Unknown or unreadable resource: ${uri}`);
        return { jsonrpc: "2.0", id, result: { contents: [content] } };
      }
      if (msg.method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
      if (msg.method.startsWith("notifications/")) return null;
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const out = await callTool(name, msg.params?.arguments, request, env, ctx);
        if (out?._unknown) return rpcError(id, -32602, `Unknown tool: ${name}`);
        if (out?._error) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out._error }], isError: true } };
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out } };
      }
      return hasId ? rpcError(id, -32601, `Method not found: ${msg.method}`) : null;
    } catch (error) {
      return hasId ? rpcError(id, -32603, `Internal error: ${String(error?.message || error).slice(0, 240)}`) : null;
    }
  };
  if (Array.isArray(payload)) {
    // Cap the batch. Every rate limit here is a KV read-then-write, which is not
    // atomic: a batch runs through Promise.all, so N concurrent tool calls all
    // read the same pre-increment count and all decide they're under budget.
    // Unbounded, one POST carrying N lens_inspect calls turns a 30/min ceiling
    // into N outbound crawls. KV can't be made atomic without a Durable Object,
    // so bounding the batch is what makes the ceiling mean anything.
    if (payload.length > MCP_MAX_BATCH) {
      return respond(rpcError(null, -32600, `Batch too large: ${payload.length} messages, limit ${MCP_MAX_BATCH}.`), 413);
    }
    const output = (await Promise.all(payload.map(handleOne))).filter(Boolean);
    return output.length ? respond(output) : respond(null, 202);
  }
  const output = await handleOne(payload);
  return output === null ? respond(null, 202) : respond(output);
}
