import contracts from "../contracts/mcp.json";
import { coffeeAvailability } from "./coffee.ts";
import { json } from "./http.ts";
import { aroundChanges } from "./live.ts";
import { inspectLens, lensCompare } from "./lens.ts";
import { photoQuery } from "./photos.ts";
import { rnTracks } from "./rn.ts";
import { serendipityEventsJson } from "./serendipity.ts";

type Row = Record<string, unknown>;

const server = contracts.servers.site;
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const siteTools = server.tools.map((tool) => ({ ...tool, outputSchema: { type: "object", additionalProperties: true }, annotations: { ...annotations, openWorldHint: tool.name.startsWith("lens_") } }));

const resources = [
  { uri: "https://aadhar.sh/llms.txt", name: "Site guide", title: "aadhar.sh for language models", mimeType: "text/plain" },
  { uri: "https://aadhar.sh/index.md", name: "Homepage", title: "aadhar.sh", mimeType: "text/markdown" },
  { uri: "https://aadhar.sh/images/manifest.json", name: "Photo manifest", title: "Published photographs", mimeType: "application/json" },
  { uri: "https://aadhar.sh/rn/tracks", name: "Now playing", title: "Current playlist", mimeType: "application/json" },
  { uri: "https://aadhar.sh/serendipity/events.json", name: "Events", title: "Serendipity event pool", mimeType: "application/json" }
] as const;

function result(id: unknown, value: unknown): Row { return { jsonrpc: "2.0", id, result: value }; }
function error(id: unknown, code: number, message: string): Row { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

function boundedString(value: unknown, length = 2048): string { return typeof value === "string" ? value.slice(0, length) : ""; }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback; }

async function parsed(response: Response): Promise<{ value: unknown; failed: boolean }> {
  const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  return { value, failed: !response.ok };
}

async function searchSite(env: Env, args: Row): Promise<unknown> {
  const response = await env.ASSETS.fetch("https://assets.invalid/search-index.json");
  const records = await response.json<Array<{ path: string; title: string; description: string; section: string }>>();
  const query = boundedString(args.q, 120).trim().toLowerCase();
  if (!query) return { error: "q is required" };
  const terms = query.split(/\s+/).filter(Boolean);
  const limit = boundedInteger(args.limit, 20, 1, 50);
  const matches = records.filter((record) => terms.every((term) => `${record.title} ${record.description} ${record.section}`.toLowerCase().includes(term))).slice(0, limit);
  return { query, count: matches.length, results: matches };
}

async function callTool(request: Request, env: Env, ctx: ExecutionContext, name: string, args: Row): Promise<{ value: unknown; failed: boolean }> {
  if (name === "search_site") { const value = await searchSite(env, args); return { value, failed: Boolean((value as Row).error) }; }
  if (name === "now_playing") return parsed(await rnTracks(env));
  if (name === "coffee_availability") return parsed(await coffeeAvailability(env, ctx));
  if (name === "change_radar") return parsed(await aroundChanges(env, String(boundedInteger(args.limit, 50, 1, 100))));
  if (name === "photo_query") {
    const url = new URL("https://aadhar.sh/photos/query.json");
    for (const key of ["q", "camera", "lens", "film", "recipe", "from", "to"] as const) { const value = boundedString(args[key], 160); if (value) url.searchParams.set(key, value); }
    url.searchParams.set("limit", String(boundedInteger(args.limit, 25, 1, 100)));
    url.searchParams.set("offset", String(boundedInteger(args.offset, 0, 0, 10000)));
    return parsed(await photoQuery(new Request(url, request), env));
  }
  if (name === "lens_inspect") {
    const inspected = await inspectLens(request, env, boundedString(args.url));
    return { value: inspected.payload, failed: inspected.status >= 400 };
  }
  if (name === "lens_compare") {
    const url = new URL("https://aadhar.sh/lens/compare.json");
    url.searchParams.set("left", boundedString(args.left)); url.searchParams.set("right", boundedString(args.right));
    return parsed(await lensCompare(new Request(url, request), env));
  }
  return { value: { error: `unknown tool: ${name}` }, failed: true };
}

async function readResource(env: Env, uri: string): Promise<{ contents: Row[] } | { error: string }> {
  const resource = resources.find((entry) => entry.uri === uri);
  if (!resource) return { error: "Resource not found" };
  const path = new URL(uri).pathname;
  const response = path === "/rn/tracks" ? await rnTracks(env)
    : path === "/serendipity/events.json" ? await serendipityEventsJson(env, new Request(uri))
      : await env.ASSETS.fetch(`https://assets.invalid${path}`);
  if (!response.ok) return { error: `Resource unavailable (${response.status})` };
  const text = await response.text();
  return { contents: [{ uri, mimeType: resource.mimeType, text: text.slice(0, 512 * 1024) }] };
}

async function message(request: Request, env: Env, ctx: ExecutionContext, input: unknown): Promise<Row | null> {
  if (!input || typeof input !== "object") return error(null, -32600, "Invalid Request");
  const rpc = input as Row; const id = rpc.id; const hasId = "id" in rpc;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return hasId ? error(id, -32600, "Invalid Request") : null;
  if (String(rpc.method).startsWith("notifications/")) return null;
  if (rpc.method === "server/discover") return result(id, { protocolVersion: contracts.protocolVersion, capabilities: server.capabilities, serverInfo: server.serverInfo, instructions: "Read-only access to public aadhar.sh data and bounded web inspection." });
  if (rpc.method === "initialize") return result(id, { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: server.serverInfo, instructions: "Read-only access to public aadhar.sh data and bounded web inspection." });
  if (rpc.method === "ping") return result(id, {});
  if (rpc.method === "tools/list") return result(id, { tools: siteTools });
  if (rpc.method === "resources/list") return result(id, { resources });
  if (rpc.method === "resources/templates/list") return result(id, { resourceTemplates: [] });
  if (rpc.method === "prompts/list") return result(id, { prompts: [] });
  if (rpc.method === "resources/read") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Row : {};
    const read = await readResource(env, boundedString(params.uri));
    return "error" in read ? error(id, -32002, read.error) : result(id, read);
  }
  if (rpc.method === "tools/call") {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Row : {};
    const name = boundedString(params.name, 100);
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Row : {};
    const output = await callTool(request, env, ctx, name, args);
    return result(id, { content: [{ type: "text", text: JSON.stringify(output.value, null, 2) }], structuredContent: output.value, ...(output.failed ? { isError: true } : {}) });
  }
  return hasId ? error(id, -32601, `Method not found: ${rpc.method}`) : null;
}

export async function siteMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-method, mcp-name", "access-control-max-age": "86400" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ jsonrpc: "2.0", error: { code: -32600, message: "POST a JSON-RPC request." }, id: null }, { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  if (Number(request.headers.get("content-length") || 0) > 32 * 1024) return json(error(null, -32600, "Request too large"), { status: 413, headers: cors });
  let payload: unknown; try { payload = await request.json(); } catch { return json(error(null, -32700, "Parse error"), { headers: cors }); }
  const output = Array.isArray(payload) ? (await Promise.all(payload.map((item) => message(request, env, ctx, item)))).filter(Boolean) : await message(request, env, ctx, payload);
  return output === null || (Array.isArray(output) && !output.length) ? new Response(null, { status: 202, headers: { ...cors, "cache-control": "no-store" } }) : json(output, { headers: { ...cors, "cache-control": "no-store" } });
}
