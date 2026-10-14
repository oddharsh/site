// lib/doors.ts — read what is actually BEHIND another origin's agent doors.

import { outboundRead, type OutboundRefusal } from "./outbound.ts";
import { readResponseCapped } from "./crawl.ts";
import { ERR_HEADER_MISMATCH, MCP_MODERN, META_PROTOCOL, META_CLIENT_CAPS, parseMcpBody, rpcErrorDetail } from "./mcp-protocol.ts";
import { lensProbe, originDiscovery } from "../lens.ts";
import { asRecord, asScalarText, asText } from "./parse.ts";
import { sseEvents } from "./sse.ts";

export const DOOR_LIMITS = {
  corpus: 6000,
  tools: 24,
  toolDesc: 160,
  schemaBytes: 6000,
  askResults: 10,
  askText: 240,
  askSchemaBytes: 4000,
};

function capSchema(schema) {
  if (!asRecord(schema) && !Array.isArray(schema)) return { schema: null };
  let encoded;
  try { encoded = JSON.stringify(schema); } catch { return { schema: null, oversize: false }; }
  if (encoded.length > DOOR_LIMITS.schemaBytes) return { schema: null, oversize: true, bytes: encoded.length };
  return { schema };
}

const trim = (text, max) => {
  const value = String(text || "").replace(/\r/g, "").trim();
  return value.length > max ? value.slice(0, max) + "\n…[truncated]" : value;
};

const LIST_METHOD = "tools/list";
const LIST_REQUEST_ID = 1;

const CATALOG_CAP = 256 * 1024;

const PROTOCOL_HEADER = "mcp-protocol-version";

export function wantsProtocolHeader(payload) {
  const error = payload && payload.error;
  if (!error || error.code !== ERR_HEADER_MISMATCH) return false;
  return new RegExp(PROTOCOL_HEADER.replace(/-/g, "[- ]?"), "i").test(String(error.message || ""));
}

export function gatedDoor(res): { ok: false; unreadable: true; gated: true; detail: string } {
  const challenge = String((res.headers && res.headers.get("www-authenticate")) || "").trim();
  const how = /oauth|resource_metadata/i.test(challenge)
    ? "OAuth"
    : challenge ? challenge.split(/[\s,;]/)[0] : "credentials";
  return { ok: false, unreadable: true, gated: true, detail: `needs ${how} (HTTP ${res.status})` };
}

function refusedDoor(refusal: OutboundRefusal): { ok: false; unreadable: true; detail: string } {
  return {
    ok: false,
    unreadable: true,
    detail: refusal.reason === "robots" ? refusal.error.slice(0, 80) : "redirected somewhere this reader will not follow",
  };
}

export async function foreignMcpTools(origin, env, opts: { schemas?: boolean } = {}): Promise<Record<string, any>> {
  const url = origin.replace(/\/+$/, "") + "/mcp";
  // Both `_meta` keys are REQUIRED on a modern request. `clientCapabilities` is
  // empty because this probe reads a catalogue and offers the server nothing:
  // no roots, no sampling, no elicitation. Sending it matters twice over — a
  // strict foreign server is entitled to refuse us with -32602 without it, and
  // the self-scan below loops back into our own /mcp, which does exactly that.
  // The values come from the server module so this client cannot advertise a
  // revision the site itself has stopped speaking.
  const body = JSON.stringify({
    jsonrpc: "2.0", id: LIST_REQUEST_ID, method: LIST_METHOD,
    params: { _meta: {
      [META_PROTOCOL]: MCP_MODERN,
      [META_CLIENT_CAPS]: {},
    } },
  });
  const deadline = AbortSignal.timeout(8000);
  const send = (extra) => outboundRead(url, env, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Both framings, because the server picks. DeepWiki refuses a
      // JSON-only Accept outright (406, "Client must accept both") rather
      // than downgrading to the one framing we said we could read.
      accept: "application/json, text/event-stream",
      "mcp-method": LIST_METHOD,
      ...extra,
    },
    body,
    signal: deadline,
    identity: { as: "aadharshbot" },
    maxHops: 4,
  });

  const read = async (res) => {
    const got = await readResponseCapped(res, CATALOG_CAP);
    if (got.truncated) return { over: true };
    return parseMcpBody(got.text, res.headers.get("content-type"), LIST_REQUEST_ID);
  };

  try {
    let sent = await send(null);
    if (!sent.ok) return refusedDoor(sent);
    let res = sent.response;

    if (res.status === 401 || res.status === 403) return gatedDoor(res);

    let parsed = await read(res);
    if ("over" in parsed) return { ok: false, unreadable: true, detail: `catalogue over ${CATALOG_CAP / 1024} KB — not read` };

    // Some servers require the revision as a HEADER as well as in `_meta` and
    // refuse without it (mcp.svelte.dev: -32020 "MCP-Protocol-Version is
    // required"). Sending it unconditionally is NOT the fix — mcp.deepwiki.com
    // and mcp.exa.ai serve happily WITHOUT it and refuse the byte-identical
    // request WITH it, because they validate the header against their own
    // supported list and neither speaks 2026-07-28. All three measured
    // 2026-08-14. So it goes only to a server that has just said it needs one,
    // which costs a round trip on nobody who works without it, and it carries
    // the version the body already declared because a header disagreeing with
    // the body is the other half of what -32020 refuses.
    if (parsed.ok && wantsProtocolHeader(parsed.payload)) {
      sent = await send({ [PROTOCOL_HEADER]: MCP_MODERN });
      if (!sent.ok) return refusedDoor(sent);
      res = sent.response;
      if (res.status === 401 || res.status === 403) return gatedDoor(res);
      parsed = await read(res);
      if ("over" in parsed) return { ok: false, unreadable: true, detail: `catalogue over ${CATALOG_CAP / 1024} KB — not read` };
    }

    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    const payload = parsed.payload;
    if (payload?.error) return { ok: false, detail: rpcErrorDetail(payload) };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const tools = payload?.result?.tools;
    if (!Array.isArray(tools)) return { ok: false, detail: "no `tools` array in the response" };
    return {
      ok: true,
      count: tools.length,
      tools: tools.slice(0, DOOR_LIMITS.tools).map((tool) => {
        const toolRecord = asRecord(tool) || {};
        const row: {
          name: string;
          description: string;
          inputSchema?: unknown;
          schemaOversize?: number;
          title?: string;
          annotations?: Record<string, unknown>;
        } = {
          name: asScalarText(toolRecord.name || "").slice(0, 60),
          description: trim(toolRecord.description, DOOR_LIMITS.toolDesc),
        };
        if (!opts.schemas) return row;
        const capped = capSchema(toolRecord.inputSchema);
        row.inputSchema = capped.schema;
        if (capped.oversize) row.schemaOversize = capped.bytes;
        if (toolRecord.title) row.title = asScalarText(toolRecord.title).slice(0, 80);
        const annotations = asRecord(toolRecord.annotations);
        if (annotations) row.annotations = annotations;
        return row;
      }),
    };
  } catch (error) {
    return { ok: false, unreadable: true, detail: String(error?.message || error).slice(0, 80) };
  }
}

// So three politenesses are structural rather than optional. `mode=list` is
// sent EXPLICITLY, because it is the one mode the spec defines as pure
// retrieval and the default could be reconfigured server-side. `streaming=0`
// asks for a single JSON body. And the route above this caches, so a public
// button cannot re-ask the same origin the same question on every click.
const ASK_CAP = 512 * 1024;
const ASK_FIELDS = ["url", "name", "site", "score", "description", "schema_object"];

export type ForeignNlwebProbe =
  | { ok: false; unreadable?: boolean; gated?: boolean; detail: string }
  | {
      ok: true;
      total: number;
      framing: string;
      dialect: string;
      coverage: Record<string, number>;
      [field: string]: unknown;
    };

export async function foreignNlwebAsk(origin, env, opts: { query?: string } = {}): Promise<ForeignNlwebProbe> {
  const base = origin.replace(/\/+$/, "") + "/ask";
  const query = String(opts.query || "").trim().slice(0, 200) || "what is this site about";
  const url = `${base}?query=${encodeURIComponent(query)}&streaming=0&mode=list`;

  const deadline = AbortSignal.timeout(8000);

  try {
    // Both framings on Accept. A server is entitled to stream even when asked
    // not to, and one that does is answering rather than failing.
    const read = await outboundRead(url, env, {
      method: "GET",
      headers: { accept: "application/json, text/event-stream" },
      signal: deadline,
      identity: { as: "aadharshbot" },
      maxHops: 4,
    });
    if (!read.ok) return refusedDoor(read);
    const res = read.response;

    if (res.status === 401 || res.status === 403) return gatedDoor(res);
    if (res.status === 404) return { ok: false, detail: "no /ask" };

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (/text\/html/.test(contentType)) return { ok: false, detail: "HTML at /ask (a page, not an endpoint)" };

    const got = await readResponseCapped(res, ASK_CAP);
    if (got.truncated) return { ok: false, unreadable: true, detail: `answer over ${ASK_CAP / 1024} KB — not read` };

    const framing = /event-stream/.test(contentType) || /^\s*(event|data):/m.test(got.text) ? "sse" : "json";
    const parsed = framing === "sse" ? parseAskStream(got.text) : parseAskJson(got.text);
    if (!parsed.ok) {
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      return { ok: false, detail: parsed.detail };
    }
    if (!res.ok && !parsed.results.length) return { ok: false, detail: `HTTP ${res.status}` };

    return { ok: true, endpoint: base, query, framing, dialect: parsed.dialect, ...gradeAskResults(parsed) };
  } catch (error) {
    return { ok: false, unreadable: true, detail: String(error?.message || error).slice(0, 80) };
  }
}

/** What either ask parser reads off a body: a refusal with its reason, or the
 *  results plus what the framing says about the server. */
type AskParse =
  | { ok: false; detail: string }
  | { ok: true; dialect: "json" | "v0.55" | "legacy"; queryId: string | null; results: unknown[]; attributes: string[]; events?: string[] };

function parseAskJson(text): AskParse {
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, detail: "that is not JSON" }; }
  const record = asRecord(payload);
  if (!record) return { ok: false, detail: "the answer is not a JSON object" };
  const results = Array.isArray(record.results) ? record.results
    // ItemList is the richer structure the spec says results are moving to, so
    // a server that has already moved is read rather than called malformed.
    : Array.isArray(record.itemListElement) ? record.itemListElement
      : null;
  if (!results) return { ok: false, detail: "no `results` array in the answer" };
  return { ok: true, dialect: "json", queryId: asText(record.query_id), results, attributes: Object.keys(record).filter((k) => k !== "results") };
}

/**
 * The streamed answer, in either of the two dialects the reference server
 * emits. They are genuinely different wire formats and which one arrives says
 * something real about the server, so the dialect is reported rather than
 * normalised away:
 *
 *   legacy  data: {"message_type":"result","content":[...]}
 *   v0.55   event: result\n data: {"index":0,"item":{...}}
 */
function parseAskStream(text): AskParse {
  const results: unknown[] = [];
  const seen = new Set<string>();
  let queryId: string | null = null;
  let named = false;

  for (const { event: eventName, data } of sseEvents(text)) {
    if (!data) continue;
    let frame;
    try { frame = JSON.parse(data); } catch { continue; }
    const record = asRecord(frame);
    if (!record) continue;
    if (eventName) { named = true; seen.add(eventName); }
    const type = asText(record.message_type);
    if (type) seen.add(type);
    queryId = queryId || asText(record.query_id) || asText(record.conversation_id);
    if (eventName === "result" && asRecord(record.item)) results.push(record.item);
    else if (Array.isArray(record.content)) results.push(...record.content);
    else if (Array.isArray(record.results)) results.push(...record.results);
  }

  if (!results.length && !seen.size) return { ok: false, detail: "no readable SSE frames" };
  return { ok: true, dialect: named ? "v0.55" : "legacy", queryId, results, events: [...seen].slice(0, 12), attributes: [] };
}

function gradeAskResults(parsed) {
  const coverage = Object.fromEntries(ASK_FIELDS.map((f) => [f, 0]));
  const types = new Map();
  let schemaBytes = 0;

  for (const raw of parsed.results) {
    const item = asRecord(raw) || {};
    for (const field of ASK_FIELDS) if (item[field] !== undefined && item[field] !== null && item[field] !== "") coverage[field] += 1;
    const schema = asRecord(item.schema_object);
    if (schema) {
      const t = schema["@type"] ?? schema.type;
      for (const name of (Array.isArray(t) ? t : [t]).filter(Boolean)) {
        const key = String(name).slice(0, 40);
        types.set(key, (types.get(key) || 0) + 1);
      }
      try { schemaBytes += JSON.stringify(schema).length; } catch {}
    }
  }

  return {
    queryId: parsed.queryId,
    total: parsed.results.length,
    shown: Math.min(parsed.results.length, DOOR_LIMITS.askResults),
    coverage,
    conformant: ASK_FIELDS.every((f) => coverage[f] === parsed.results.length) && parsed.results.length > 0,
    schemaTypes: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    schemaBytes,
    attributes: (parsed.attributes || []).slice(0, 12),
    events: parsed.events,
    results: parsed.results.slice(0, DOOR_LIMITS.askResults).map((raw) => {
      const item = asRecord(raw) || {};
      const row: {
        url?: string;
        name: string;
        site?: string;
        description: string;
        score?: number;
        schema_object?: Record<string, unknown>;
        schemaOversize?: number;
      } = {
        url: asText(item.url)?.slice(0, 300),
        name: trim(item.name, DOOR_LIMITS.askText),
        site: asText(item.site)?.slice(0, 80),
        description: trim(item.description, DOOR_LIMITS.askText),
      };
      const score = Number(item.score);
      if (Number.isFinite(score)) row.score = score;
      const schema = asRecord(item.schema_object);
      if (schema) {
        let json;
        try { json = JSON.stringify(schema); } catch { json = null; }
        if (json && json.length <= DOOR_LIMITS.askSchemaBytes) row.schema_object = schema;
        else row.schemaOversize = json ? json.length : 0;
      }
      return row;
    }),
  };
}

export function classifyDoor(probe, wanted) {
  if (probe?.error) return { ok: false, unreadable: true, why: String(probe.error).slice(0, 60) };
  if (!probe?.ok) return { ok: false, why: probe?.status ? `HTTP ${probe.status}` : "no answer" };
  if (!probe.body) return { ok: false, why: "empty" };
  const type = (probe.contentType || "").toLowerCase();
  // A 200 is not an answer either. Plenty of origins serve their SPA shell for
  // every unknown path, so an llms.txt request comes back 200 text/html, and
  // counting that as present would make this reader agree with every site that
  // has no agent surface at all.
  if (wanted && !type.includes(wanted)) return { ok: false, wrongType: type.split(";")[0] || "unknown type" };
  return { ok: true, text: trim(probe.body, DOOR_LIMITS.corpus), bytes: probe.body.length };
}

export async function readDoors(target, env) {
  const origin = new URL(target).origin;
  const hostname = new URL(target).hostname;
  const [markdown, disco, mcp] = await Promise.all([
    lensProbe(target, env, "text/markdown"),
    originDiscovery(origin, hostname, env),
    foreignMcpTools(origin, env),
  ]);
  const { llms, agentCard, apiCatalog } = disco;

  const readable = classifyDoor;

  return {
    origin,
    target,
    markdown: readable(markdown, "markdown"),
    llms: readable(llms, "text/plain"),
    agentCard: readable(agentCard, "json"),
    apiCatalog: readable(apiCatalog, "json"),
    mcp,
  };
}
