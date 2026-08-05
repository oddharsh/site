// The canonical site-level MCP surface. It is intentionally stateless and
// read-only: one JSON-RPC request in, one JSON response out, with the same
// functions used by the corresponding HTTP endpoints.
import { jsonResponse } from "./lib/http.js";
import { DATA_TOOLS, DATA_TOOL_NAMES, callDataTool } from "./lib/tools.js";
import { frameText, terminalToolFrame } from "./terminal.js";
import { radarFrame, readSamples } from "./radar.js";
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
  ...DATA_TOOLS,
  // ── the terminal programs ───────────────────────────────────────────────
  // These return a rendered 80-column FRAME as text, not a record. That is the
  // point rather than a limitation: the frame names its own controls, so a
  // caller learns the program by reading one instead of by being handed a
  // schema. Every frame also returns the `url` that produced it, which is the
  // whole state — resume, fork, or hand it to somebody else by passing it back.
  //
  // The structured twins already exist beside these (search_site, photo_query,
  // lens_inspect). A caller that wants fields should use those; these are for
  // the caller that wants to EXPLORE, and for the human reading over its
  // shoulder. Frames are never coloured here: an ANSI escape in a context
  // window is noise the model then has to be robust to.
  {
    name: "finger",
    description: "Look up who runs aadhar.sh, as a drivable terminal program. Panes: overview, writing, reading, listening, photos, around, coffee, deploys, search. Send `keys` to move (1-9 pane, j/k cursor, <cr> open, h back, ? help) and pass the returned `url`'s params back to continue. Returns a rendered 80-column frame.",
    inputSchema: { type: "object", properties: {
      keys: { type: "string", description: "a key sequence, up to 32 keys, e.g. \"2jj<cr>\"" },
      pane: { type: "string", enum: ["overview", "writing", "reading", "listening", "photos", "around", "coffee", "deploys", "search"] },
      cursor: { type: "integer", minimum: 0, maximum: 4999 },
      open: { type: "string", description: "id of the row to open (slug, index, or version number)" },
      q: { type: "string", description: "query for the search pane" },
    } },
  },
  {
    name: "photos",
    description: "Browse the published photo archive as a terminal frame, filterable by caption, film simulation, body, and lens. Opening a frame shows its exposure and the in-camera recipe it was shot with. Send `keys` (j/k cursor, <cr> open, n/p page).",
    inputSchema: { type: "object", properties: {
      keys: { type: "string" }, q: { type: "string" }, film: { type: "string" },
      camera: { type: "string" }, lens: { type: "string" },
      page: { type: "integer", minimum: 0, maximum: 200 },
      cursor: { type: "integer", minimum: 0, maximum: 4999 },
      open: { type: "string", description: "photo stem to open" },
    } },
  },
  {
    // The one tool here whose INPUT this server cannot produce. An agent with a
    // shell has an antenna; this origin does not. So the agent samples and this
    // draws — see radar.js on why a hosted radar is otherwise dishonest.
    name: "radar",
    description: "Render signal readings you have already measured (wifi/Bluetooth RSSI) as a terminal instrument: concentric strength bands, a meter and trend per source, and findphone's field calibration (-45 arm's reach, -60 same table, -72 same room). This origin has no antenna and does not sense anything; you supply the samples. Nothing is stored. Angles in the plot are decorative because RSSI carries no bearing.",
    inputSchema: { type: "object", properties: {
      samples: { type: "array", maxItems: 40, items: { type: "object", properties: {
        name: { type: "string" },
        rssi: { type: "number", description: "dBm, negative; e.g. -58" },
        kind: { type: "string", description: "optional tag, e.g. wifi or ble" },
        history: { type: "array", items: { type: "number" }, description: "optional trailing readings for the trend" },
      }, required: ["name", "rssi"] } },
      source: { type: "string", description: "optional label for what did the sampling" },
    }, required: ["samples"] },
  },
  {
    name: "dict",
    description: "Will a browser ever actually use the compression dictionary a URL is serving? Compression dictionaries fail in total silence — Chromium declines to register a perfectly good one because of a cache directive, with no warning anywhere. Returns a rendered frame grading every registration rule, plus whether a delta-serving response varies on available-dictionary. Same route as /dict.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "cache",
    description: "Does a URL's ETag ever actually 304? A BEHAVIORAL probe rather than a header read: fetches twice to see whether the validator survives two identical requests, then replays it with If-None-Match and reports what the origin did. Also checks Accept negotiation against Vary. Returns a rendered frame. Same route as /cache.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "lens",
    description: "Inspect one public HTTP(S) URL and render the observation as a terminal frame: readability, agent doors, and what a single scan costs to read. Same rate limit and same refusals as lens_inspect; use lens_inspect instead if you want the fields rather than the frame.",
    inputSchema: { type: "object", properties: {
      url: { type: "string" },
      doors: { type: "boolean", description: "also READ what is behind the agent doors: llms.txt, the markdown twin, the agent card, and a real tools/list against their MCP server. Their catalog is listed, never called." },
    }, required: ["url"] },
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
  // The seven data tools live in lib/tools.js, because /ask calls the
  // same seven through the same function. Dispatching them here would mean two
  // switch statements that have to agree.
  if (DATA_TOOL_NAMES.has(name)) return callDataTool(name, args, request, env, ctx);

  // The three frame tools share one implementation, because the HTTP route and
  // the tool are the same program read through different doors. terminal_lens does
  // NOT get its own rate-limit check here: lensFrame calls the same
  // overLensBudget bucket lens_inspect does, so the ceiling is shared whichever
  // door you knock on — the rule the crawl-tool note above already states.
  if (name === "finger") return terminalToolFrame("finger", args, request, env, ctx);
  if (name === "photos") return terminalToolFrame("photos", args, request, env, ctx);
  if (name === "lens") return terminalToolFrame("lens", args, request, env, ctx);
  if (name === "dict") return terminalToolFrame("dict", args, request, env, ctx);
  if (name === "cache") return terminalToolFrame("cache", args, request, env, ctx);
  if (name === "radar") {
    const samples = readSamples(args);
    return { frame: frameText(radarFrame(samples, { source: String(args?.source || "").slice(0, 60) }), { color: false }), sources: samples.length };
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
