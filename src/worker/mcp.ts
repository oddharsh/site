import { jsonResponse } from "./lib/http.ts";
import { deadline } from "./lib/cache.ts";
import { readResponseCapped } from "./lib/crawl.ts";
import type { Env } from "./lib/env.ts";
import { imageCompare, imageInspect, imageTransform, photoRecipe } from "./image-tools.ts";
import { DATA_TOOLS, DATA_TOOL_NAMES, callDataTool } from "./lib/tools.ts";
import { captureRepresentation, compareRepresentation, readRepresentation } from "./representation.ts";
import { frameText, terminalToolFrame } from "./terminal.ts";
import { radarFrame, readSamples } from "./radar.ts";
import { AGENT_SURFACES } from "./lib/site-manifest.ts";
import { CACHE_EMPTY, CACHE_LIVE, CACHE_STATIC, mcpCorsHeaders, mcpError, mcpHttpStatus, mcpRequest, mcpServer } from "./lib/mcp-protocol.ts";
import { mcpTool } from "./lib/mcp-tools.ts";
import { previewToolRefusal } from "./lib/preview.ts";
import { overBudget } from "./lib/ratelimit.ts";
import { asRecord, asText } from "./lib/parse.ts";

export const SITE_MCP_SERVER_INFO = { name: "aadhar.sh", title: "Aadharsh Site", version: "2.1.0" };
export const SITE_MCP_CAPABILITIES = { tools: {}, resources: {} };
export const SITE_MCP_INSTRUCTIONS = "Bounded public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, Lens, ephemeral image inspection/transforms, exact published-photo recipe matching, and an HTTP representation vault. Image inputs are not persisted; the vault stores normalized headers, metadata, and body digests only. resources/list enumerates the site's public pages; resources/read fetches one. No private data is exposed.";

const MCP = mcpServer({
  serverInfo: SITE_MCP_SERVER_INFO,
  capabilities: SITE_MCP_CAPABILITIES,
  instructions: SITE_MCP_INSTRUCTIONS,
});

const CACHE_TOOLS     = CACHE_STATIC;
const CACHE_RESOURCES = CACHE_STATIC;
const CACHE_READ      = CACHE_LIVE;
const CACHE_PROMPTS   = CACHE_EMPTY;
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

const MCP_RESOURCE_TYPES = new Map(AGENT_SURFACES.map((s) => [s.path, s.mimeType]));
function mcpResources(origin) {
  return AGENT_SURFACES.map((s) => ({
    uri: origin + s.path,
    name: s.path,
    title: s.title,
    description: s.description,
    mimeType: s.mimeType,
  }));
}

async function readResource(uri: unknown, request: Request, env: Env) {
  const resourceUri = asText(uri);
  const selfFetch = env.SELF_FETCH;
  if (!resourceUri || !selfFetch) return null;
  let target;
  try { target = new URL(resourceUri); } catch { return null; }
  const origin = new URL(request.url).origin;
  const resourceType = MCP_RESOURCE_TYPES.get(target.pathname);
  if (target.origin !== origin || !resourceType) return null;
  const ctrl = new AbortController();
  const read = async () => {
    const res = await selfFetch(new Request(origin + target.pathname, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: resourceType },
      redirect: "manual",
      signal: ctrl.signal,
    }));
    if (!res.ok || ctrl.signal.aborted) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const mimeType = (res.headers.get("content-type") || resourceType).split(";")[0].trim();
    const { text, truncated } = await readResponseCapped(res, 512 * 1024, ctrl.signal);
    return truncated ? null : { uri: resourceUri, mimeType, text };
  };
  try { return await deadline(read(), 8000, null, () => ctrl.abort()); }
  catch { return null; }
}

function errorResult(message) { return { _error: String(message).slice(0, 400) }; }

export const MCP_BUDGETS = {
  imageInspect:   { binding: "MCP_RL_IMAGE_INSPECT",   max: 20, what: "Image inspections" },
  imageTransform: { binding: "MCP_RL_IMAGE_TRANSFORM", max: 8,  what: "Image transforms" },
  imageCompare:   { binding: "MCP_RL_IMAGE_COMPARE",   max: 4,  what: "Image comparisons" },
  reprCapture:    { binding: "MCP_RL_REPR_CAPTURE",    max: 4,  what: "Representation captures" },
  reprCompare:    { binding: "MCP_RL_REPR_COMPARE",    max: 8,  what: "Representation comparisons" },
};

const budgetRefusal = (budget) => errorResult(`${budget.what} are rate-limited to ${budget.max}/min.`);

type ToolOutcome = Record<string, any> & {
  _unknown?: boolean;
  _error?: string;
  _mcp?: { content: unknown; structured?: unknown };
};

async function callTool(name, args, request, env, ctx): Promise<ToolOutcome> {
  args = asRecord(args) || {};
  if (DATA_TOOL_NAMES.has(name)) return callDataTool(name, args, request, env, ctx);

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
    if (await overBudget(MCP_BUDGETS.imageInspect, request, env)) return budgetRefusal(MCP_BUDGETS.imageInspect);
    return imageInspect(args, env);
  }
  if (name === "image_transform") {
    if (await overBudget(MCP_BUDGETS.imageTransform, request, env)) return budgetRefusal(MCP_BUDGETS.imageTransform);
    return imageTransform(args, env);
  }
  if (name === "image_compare") {
    if (await overBudget(MCP_BUDGETS.imageCompare, request, env)) return budgetRefusal(MCP_BUDGETS.imageCompare);
    return imageCompare(args, env);
  }
  if (name === "photo_recipe") return photoRecipe(args, env);
  if (name === "representation_capture") {
    if (await overBudget(MCP_BUDGETS.reprCapture, request, env)) return budgetRefusal(MCP_BUDGETS.reprCapture);
    return captureRepresentation(args, env);
  }
  if (name === "representation_read") return readRepresentation(args, env);
  if (name === "representation_compare") {
    if (await overBudget(MCP_BUDGETS.reprCompare, request, env)) return budgetRefusal(MCP_BUDGETS.reprCompare);
    return compareRepresentation(args, env);
  }
  return { _unknown: true };
}

export async function handleSiteMcp(request, env, ctx) {
  const cors = mcpCorsHeaders();
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const respond = (body, status = 200) => body === null
    ? new Response(null, { status, headers: cors })
    : jsonResponse(body, status, { ...cors, "cache-control": "no-store" });
  if (request.method !== "POST") return respond({ error: "Use POST with JSON-RPC 2.0." }, 405);

  let payload;
  try { payload = await request.json(); } catch { return respond(mcpError(null, -32700, "Parse error")); }
  const dispatch = async (msg) => {
    const id = msg.id;
    try {
      // MUST be implemented as of 2026-07-28. Identity, capabilities and
      // supported versions in one round trip, so a client can render what this
      // server is without probing tools/list + resources/list + prompts/list.
      if (msg.method === "server/discover") return MCP.discover(id);

      if (msg.method === "initialize") return MCP.initialize(id, msg.params?.protocolVersion);
      if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };

      // tools/list order is deterministic because MCP_TOOLS is a literal array
      // and nothing sorts or filters it. 2026-07-28 asks for that so clients can
      // cache the list and so an LLM's prompt cache keeps hitting.
      if (msg.method === "tools/list") return MCP.result(id, { tools: MCP_TOOLS }, CACHE_TOOLS);
      if (msg.method === "resources/list") return MCP.result(id, { resources: mcpResources(new URL(request.url).origin) }, CACHE_RESOURCES);
      if (msg.method === "resources/templates/list") return MCP.result(id, { resourceTemplates: [] }, CACHE_RESOURCES);
      if (msg.method === "resources/read") {
        const uri = msg.params?.uri;
        const content = await readResource(uri, request, env);
        // -32602 rather than -32002: 2026-07-28 aligned resource-not-found with
        // JSON-RPC's Invalid Params, and this file already used the new code.
        if (!content) return mcpError(id, -32602, `Unknown or unreadable resource: ${uri}`);
        return MCP.result(id, { contents: [content] }, CACHE_READ);
      }
      if (msg.method === "prompts/list") return MCP.result(id, { prompts: [] }, CACHE_PROMPTS);
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const refusedOnPreview = previewToolRefusal(request, MCP_TOOLS, name);
        if (refusedOnPreview) return MCP.result(id, { content: [{ type: "text", text: refusedOnPreview }], isError: true });
        const out = await callTool(name, msg.params?.arguments, request, env, ctx);
        if (out?._unknown) return mcpError(id, -32602, `Unknown tool: ${name}`);
        // A tool that failed is a RESULT with isError, never a JSON-RPC error:
        // the call itself succeeded, and the model is supposed to read the text.
        if (out?._error) return MCP.result(id, { content: [{ type: "text", text: out._error }], isError: true });
        if (out?._mcp) return MCP.result(id, { content: out._mcp.content, structuredContent: out._mcp.structured });
        return MCP.result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
      }
      return mcpError(id, -32601, `Method not found: ${msg.method}`);
    } catch (error) {
      return mcpError(id, -32603, `Internal error: ${String(error?.message || error).slice(0, 240)}`);
    }
  };
  const handleOne = (msg) => mcpRequest(msg, request, dispatch);
  if (Array.isArray(payload)) {
    if (payload.length === 0) return respond(mcpError(null, -32600, "Invalid Request"));
    // Cap the batch. The crawl budgets are not atomic under concurrency: a batch
    // runs through Promise.all, so N simultaneous tool calls can all observe an
    // under-budget counter and all proceed. Unbounded, one POST carrying N
    // lens_inspect calls turns a 30/min ceiling into N outbound crawls.
    if (payload.length > MCP_MAX_BATCH) {
      return respond(mcpError(null, -32600, `Batch too large: ${payload.length} messages, limit ${MCP_MAX_BATCH}.`), 413);
    }
    const output = (await Promise.all(payload.map(handleOne))).filter(Boolean);
    return output.length ? respond(output) : respond(null, 202);
  }
  const output = await handleOne(payload);
  // 200 unless the request was malformed under the required-`_meta` rule, which
  // 2026-07-28 pins to 400 on HTTP. Batches stay 200 (see mcpHttpStatus).
  return output === null ? respond(null, 202) : respond(output, mcpHttpStatus(payload));
}
