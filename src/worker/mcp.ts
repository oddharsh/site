// @ts-nocheck — declared in config/ts-migration.json, which may only SHRINK.
// This module carried type errors when the Worker moved from JavaScript to
// TypeScript on 2026-08-16. The code is unchanged and runs identically; what
// changed is that tsc stopped being lenient. In a .js file TypeScript treats
// every parameter as optional and infers loosely, so none of this was visible.
// Remove this line, fix what tsc then reports, and delete the entry from
// config/ts-migration.json. A contract test fails if the two disagree.
// The canonical site-level MCP surface. It is intentionally stateless: one
// JSON-RPC request in, one JSON response out, with the same functions used by
// the corresponding HTTP endpoints. Almost every tool is read-only too, but the
// two representation-vault tools INSERT a D1 row, so this header no longer
// claims otherwise — a header that said "read-only" is what let /mcp sit on the
// preview guard's safe list long after it stopped being true.
import { jsonResponse } from "./lib/http.ts";
import { imageCompare, imageInspect, imageTransform, photoRecipe } from "./image-tools.ts";
import { DATA_TOOLS, DATA_TOOL_NAMES, callDataTool } from "./lib/tools.ts";
import { captureRepresentation, compareRepresentation, readRepresentation } from "./representation.ts";
import { frameText, terminalToolFrame } from "./terminal.ts";
import { radarFrame, readSamples } from "./radar.ts";
import { AGENT_SURFACES } from "./lib/site-manifest.ts";
import { CACHE_EMPTY, CACHE_LIVE, CACHE_STATIC, mcpCorsHeaders, mcpGate, mcpHttpStatus, mcpServer } from "./lib/mcp-protocol.ts";
import { mcpTool } from "./lib/mcp-tools.ts";
import { previewToolRefusal } from "./lib/preview.ts";
import { asRecord, asText } from "./lib/parse.ts";

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
// Exported because the published server card is a PROJECTION of this server,
// not a second hand-maintained description of it. tools/gen-mcp-cards.mjs
// imports these three, so the card cannot claim an identity the Worker does not
// report at `initialize`.
export const SITE_MCP_SERVER_INFO = { name: "aadhar.sh", title: "Aadharsh Site", version: "2.1.0" };
export const SITE_MCP_CAPABILITIES = { tools: {}, resources: {} };
export const SITE_MCP_INSTRUCTIONS = "Bounded public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, Lens, ephemeral image inspection/transforms, exact published-photo recipe matching, and an HTTP representation vault. Image inputs are not persisted; the vault stores normalized headers, metadata, and body digests only. resources/list enumerates the site's public pages; resources/read fetches one. No private data is exposed.";

const MCP = mcpServer({
  // Self-reported and explicitly NOT a security signal — the spec says clients
  // should not change behavior on it. Display, logging, debugging.
  serverInfo: SITE_MCP_SERVER_INFO,
  capabilities: SITE_MCP_CAPABILITIES,
  instructions: SITE_MCP_INSTRUCTIONS,
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

const HOSTED_TOOLS = [
  {
    name: "image_inspect",
    description: "Inspect an image's dimensions, format, and animation/frame information. Image bytes are processed ephemerally and are not stored.",
    inputSchema: { type: "object", properties: {
      image_data: { type: "string", description: "base64 image bytes, optionally as a data URL" },
      mime_type: { type: "string" },
      source_url: { type: "string", description: "public HTTPS image URL" },
    } },
  },
  {
    name: "image_transform",
    description: "Run a bounded web image transform through Cloudflare Images and return the transformed image inline plus an exact byte receipt. The output is ephemeral.",
    inputSchema: { type: "object", properties: {
      image_data: { type: "string" }, mime_type: { type: "string" }, source_url: { type: "string" },
      preset: { type: "string", enum: ["web", "thumbnail", "universal", "og"] },
      width: { type: "integer", minimum: 1, maximum: 2400 }, height: { type: "integer", minimum: 1, maximum: 2400 },
      fit: { type: "string", enum: ["cover", "contain", "crop", "scale-down", "pad", "squeeze"] },
      format: { type: "string", enum: ["avif", "webp", "jpeg"] },
      quality: { type: "integer", minimum: 1, maximum: 100 },
      rotate: { type: "integer", enum: [0, 90, 180, 270] },
    } },
  },
  {
    name: "image_compare",
    description: "Encode one image into up to three bounded format variants and report exact byte sizes and hashes. It does not pretend to score visual quality.",
    inputSchema: { type: "object", properties: {
      image_data: { type: "string" }, mime_type: { type: "string" }, source_url: { type: "string" },
      formats: { type: "array", maxItems: 3, items: { type: "string", enum: ["avif", "webp", "jpeg"] } },
      preset: { type: "string", enum: ["web", "thumbnail", "universal", "og"] },
      width: { type: "integer", minimum: 1, maximum: 2400 }, height: { type: "integer", minimum: 1, maximum: 2400 },
      fit: { type: "string" }, quality: { type: "integer", minimum: 1, maximum: 100 },
    } },
  },
  {
    name: "photo_recipe",
    description: "Return the exact public Fuji recipe for a named archive photo, archive URL, or exact published thumbnail bytes. Arbitrary visual lookalikes are not treated as matches.",
    inputSchema: { type: "object", properties: {
      stem: { type: "string" }, source_url: { type: "string" },
      image_data: { type: "string", description: "base64 bytes from a published thumbnail" },
    } },
  },
  {
    // The two vault WRITERS, and the only tools on this server that are not
    // read-only. Each call persists a fresh snapshot row keyed by a new id, so
    // neither is idempotent either: calling twice leaves two observations, which
    // is the point of a vault. Nothing is destroyed, hence destructiveHint stays
    // false. Saying so here rather than in lib/mcp-tools.js keeps the claim
    // beside the INSERT that decides it.
    //
    // The write is ALSO stated in the description, which reads as redundant and
    // is not. Cloudflare's WebMCP bridge builds its registerTool() call from
    // exactly {name, description, inputSchema, execute}, so `annotations` is
    // dropped on the way to the browser and these two arrive looking like every
    // read-only tool (measured 2026-08-07 against the shipped bridge.js, by
    // shimming document.modelContext and capturing all 24 registrations). The
    // field is not the API's limit — developers.cloudflare.com hand-rolls its
    // own registration on the same API and passes both `title` and
    // `annotations` — it is this bridge not forwarding them. Description is the
    // one field that survives, so the claim rides there too. Delete the prose
    // only once a bridge is observed forwarding annotations.
    name: "representation_capture",
    description: "Capture bounded public HTTP representations under browser, bot, Markdown, or identity request profiles and store only normalized headers, metadata, and body digests. Writes: each call persists a new snapshot row, so this tool is not read-only and not idempotent.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    inputSchema: { type: "object", properties: {
      url: { type: "string" }, profiles: { type: "array", maxItems: 4, items: { type: "string", enum: ["browser", "bot", "markdown", "identity"] } },
    }, required: ["url"] },
  },
  {
    name: "representation_read",
    description: "Read one normalized HTTP representation snapshot from the vault. Raw response bodies are never returned because they are never stored.",
    inputSchema: { type: "object", properties: { snapshot_id: { type: "string" } }, required: ["snapshot_id"] },
  },
  {
    name: "representation_compare",
    description: "Refetch the same HTTP representation profile, compare it with a stored snapshot, and persist the new normalized observation. Writes: each call persists a new snapshot row, so this tool is not read-only and not idempotent.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    inputSchema: { type: "object", properties: {
      snapshot_id: { type: "string" }, url: { type: "string", description: "optional replacement URL, otherwise the snapshot URL" },
    }, required: ["snapshot_id"] },
  },
];

const MCP_TOOL_DEFINITIONS = [
  ...DATA_TOOLS,
  ...HOSTED_TOOLS,
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
    name: "encode",
    description: "Read a JPEG or AVIF at a URL and report what its encoder actually did: chroma subsampling, baseline vs progressive and the scan count, an estimated quality with the deviation from the IJG Annex K table shown, AVIF bit depth, and whether ICC/EXIF/XMP is riding along. NO PIXELS ARE DECODED — every fact comes from the container — so this works on files a Worker could never decode.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "agent_ready",
    description: "Grade how much of an origin a machine can actually use: llms.txt, a markdown twin, an agent card, an API catalog, and a real tools/list against its MCP server. Doors are COUNTED, never scored — a check that could not run is reported as unreadable rather than as a failure. Called with no url it audits aadhar.sh itself and prints what building that cost in files and lines.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
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

export const MCP_TOOLS = MCP_TOOL_DEFINITIONS.map((tool) => mcpTool(tool));

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

async function overMcpBudget(name, max, request, env, ctx) {
  if (!env.RN_KV) return false;
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const bucket = `mcp:${name}:${ip}:${Math.floor(Date.now() / 60000)}`;
  let n = 0;
  try { n = parseInt((await env.RN_KV.get(bucket)) || "0", 10) || 0; } catch {}
  if (n >= max) return true;
  const write = env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
  return false;
}

// The crawl tools bill against the SAME per-IP buckets as their HTTP twins
// (lens.js LENS_BUDGETS), not a private `mcp:lensrl:` one. A separate bucket let
// a caller stack budgets: 30 inspections via /lens/fetch AND another 8 here, and
// lens_compare was metered at 8/min through JSON-RPC while /lens/compare allows
// 4, so the cheaper door was the expensive operation. One bucket, one ceiling,
// whichever door you knock on.

async function callTool(name, args, request, env, ctx) {
  args = asRecord(args) || {};
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
  if (name === "encode") return terminalToolFrame("encode", args, request, env, ctx);
  if (name === "agent_ready") return terminalToolFrame("agent-ready", args, request, env, ctx);
  if (name === "dict") return terminalToolFrame("dict", args, request, env, ctx);
  if (name === "cache") return terminalToolFrame("cache", args, request, env, ctx);
  if (name === "radar") {
    const samples = readSamples(args);
    return { frame: frameText(radarFrame(samples, { source: String(args?.source || "").slice(0, 60) })), sources: samples.length };
  }
  if (name === "image_inspect") {
    if (await overMcpBudget("image-inspect", 20, request, env, ctx)) return errorResult("Image inspections are rate-limited to 20/min.");
    return imageInspect(args, env);
  }
  if (name === "image_transform") {
    if (await overMcpBudget("image-transform", 8, request, env, ctx)) return errorResult("Image transforms are rate-limited to 8/min.");
    return imageTransform(args, env);
  }
  if (name === "image_compare") {
    if (await overMcpBudget("image-compare", 4, request, env, ctx)) return errorResult("Image comparisons are rate-limited to 4/min.");
    return imageCompare(args, env);
  }
  if (name === "photo_recipe") return photoRecipe(args, env);
  if (name === "representation_capture") {
    if (await overMcpBudget("representation-capture", 4, request, env, ctx)) return errorResult("Representation captures are rate-limited to 4/min.");
    return captureRepresentation(args, env);
  }
  if (name === "representation_read") return readRepresentation(args, env);
  if (name === "representation_compare") {
    if (await overMcpBudget("representation-compare", 8, request, env, ctx)) return errorResult("Representation comparisons are rate-limited to 8/min.");
    return compareRepresentation(args, env);
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
    const hasId = asRecord(msg) !== null && "id" in msg;
    if (!msg || msg.jsonrpc !== "2.0" || asText(msg.method) === null) return hasId ? rpcError(msg.id, -32600, "Invalid Request") : null;
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
        // A preview runs production bindings, and two tools here write D1. The
        // transport guard admits /mcp as a whole (lib/preview.js says why), so
        // the refusal has to happen where the tool is known.
        const refusedOnPreview = previewToolRefusal(request, MCP_TOOLS, name);
        if (refusedOnPreview) return MCP.result(id, { content: [{ type: "text", text: refusedOnPreview }], isError: true });
        const out = await callTool(name, msg.params?.arguments, request, env, ctx);
        if (out?._unknown) return rpcError(id, -32602, `Unknown tool: ${name}`);
        // A tool that failed is a RESULT with isError, never a JSON-RPC error:
        // the call itself succeeded, and the model is supposed to read the text.
        if (out?._error) return MCP.result(id, { content: [{ type: "text", text: out._error }], isError: true });
        if (out?._mcp) return MCP.result(id, { content: out._mcp.content, structuredContent: out._mcp.structured });
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
  // 200 unless the request was malformed under the required-`_meta` rule, which
  // 2026-07-28 pins to 400 on HTTP. Batches stay 200 (see mcpHttpStatus).
  return output === null ? respond(null, 202) : respond(output, mcpHttpStatus(payload));
}
