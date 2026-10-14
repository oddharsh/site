// ── the revisions ───────────────────────────────────────────────────
// 2026-07-28 deleted the initialize handshake, deleted protocol-level sessions
// and Mcp-Session-Id, and moved protocol version, client identity and
// capabilities into per-request `_meta`. Both servers here are DUAL-ERA, which
// the spec sanctions: a request carrying modern `_meta` is served statelessly
// under the new revision, an `initialize` request selects legacy semantics.
//
// The legacy list stays because legacy clients have NO fall-forward mechanism.
// Pointed at a modern-only server they fail outright, with no diagnostic they
// can surface to a user.
import { asNumber, asRecord, asText } from "./parse.ts";
import { sseEvents } from "./sse.ts";

export const MCP_MODERN = "2026-07-28";
export const MCP_LEGACY = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_SUPPORTED = [MCP_MODERN, ...MCP_LEGACY];
// What a legacy `initialize` gets when it asks for something we do not know.
// Deliberately the newest LEGACY revision and never MCP_MODERN: a client coming
// in through the legacy door cannot speak modern, so handing it 2026-07-28
// would be a negotiation it fails on its very next request.
export const MCP_LEGACY_DEFAULT = "2025-06-18";

// `_meta` keys are namespaced by the spec and the prefix is mandatory.
const META = "io.modelcontextprotocol/";
export const META_PROTOCOL = `${META}protocolVersion`;
export const META_CLIENT_CAPS = `${META}clientCapabilities`;
export const META_SERVER_INFO = `${META}serverInfo`;

// From the 2026-07-28 error-code allocation policy, which reserved
// -32020..-32099 for the spec and grandfathered existing SDK use of
// -32000..-32019. (Resource-not-found also moved -32002 -> -32602 in the same
// revision; both servers already used -32602, so nothing needed renumbering.)
export const ERR_HEADER_MISMATCH = -32020;
export const ERR_UNSUPPORTED_PROTOCOL = -32022;
// Plain JSON-RPC Invalid Params, NOT from the reserved range above. The spec
// pins the malformed-request case to this code rather than minting a new one.
export const ERR_INVALID_PARAMS = -32602;

// CacheableResult freshness hints, required on list and read results. These are
// hints that let a client cache instead of poll; they complement listChanged
// notifications rather than replacing them. `public` throughout because every
// surface on both servers is public: no auth, no per-caller view, nothing an
// intermediary would be wrong to share.
export const CACHE_STATIC = { ttlMs: 3_600_000,  cacheScope: "public" };
export const CACHE_LIVE   = { ttlMs:   300_000,  cacheScope: "public" };
export const CACHE_EMPTY  = { ttlMs: 86_400_000, cacheScope: "public" };

// `_meta` is the ONLY modern signal. The MCP-Protocol-Version header predates
// this revision (2025-06-18 introduced it for HTTP), so treating a header as
// proof of modernity would misclassify a legacy client and answer it in a
// dialect it cannot read.
//
// DELIBERATE DEVIATION, shared by both servers, and it is now HALF the size it
// used to be. 2026-07-28 marks both `protocolVersion` and `clientCapabilities`
// required on every modern request, and says a request missing either is
// malformed and MUST be refused with -32602 (and HTTP 400). The
// `clientCapabilities` half is enforced below. The `protocolVersion` half
// cannot be, and the asymmetry is the whole design:
//
// An absent `_meta` is precisely how a LEGACY client presents itself, so
// refusing on a missing `protocolVersion` would fail every pre-2026 caller at
// the gate: the "Legacy client, Modern server -> Fails" row a dual-era server
// exists to avoid. A dual-era server cannot both read absence as an era signal
// and call absence malformed. It has to pick one, and this one picks the era
// signal.
export function declaredVersion(msg) {
  const v = msg?.params?._meta?.[META_PROTOCOL];
  return asText(v);
}

// `clientCapabilities` must be an OBJECT. The spec types it as
// ClientCapabilities, and a client sending `true` or `"none"` has not declared
// capabilities in any readable sense; accepting the key's mere presence would
// make this a spelling check rather than a contract. An EMPTY object is valid
// and is the correct declaration for a client that supports no client features
// at all, which is what both of this repo's own MCP clients send.
export function missingRequiredMeta(msg) {
  if (!declaredVersion(msg)) return null;
  const caps = msg?.params?._meta?.[META_CLIENT_CAPS];
  const ok = asRecord(caps) !== null;
  return ok ? null : META_CLIENT_CAPS;
}

export function malformedRequest(id, missing) {
  return { jsonrpc: "2.0", id, error: {
    code: ERR_INVALID_PARAMS,
    message: `Missing required _meta field: ${missing}`,
    data: { missing: [missing] },
  } };
}

// The HTTP status one JSON-RPC response goes out with. The spec pins the
// malformed case to 400; everything else, including in-band JSON-RPC errors
// like an unknown tool, stays 200.
//
// SINGLE messages only. A batch has no one request whose status this could
// describe, and a batch of five where the third is malformed is not a bad
// batch. Those keep 200 and carry the per-message error in the array, which is
// how JSON-RPC batching works everywhere else.
export function mcpHttpStatus(payload) {
  return !Array.isArray(payload) && missingRequiredMeta(payload) ? 400 : 200;
}

// The refusal a client retries from. `data.supported` is the load-bearing part:
// without it the client has nothing to fall back to. This shape is ALSO how a
// dual-era client recognises a modern server at all, so it is a protocol
// feature rather than a courtesy.
export function unsupportedVersion(id, requested) {
  return { jsonrpc: "2.0", id, error: {
    code: ERR_UNSUPPORTED_PROTOCOL,
    message: "Unsupported protocol version",
    data: { supported: MCP_SUPPORTED, requested },
  } };
}

// 2026-07-28 requires Mcp-Method and Mcp-Name on Streamable HTTP POSTs so an
// intermediary can route and authorize without parsing a JSON-RPC body.
//
// DELIBERATE DEVIATION, shared by both servers: validated when present, never
// required. Requiring them would reject every legacy client at the transport
// layer, which is exactly the "Legacy client, Modern server -> Fails" row of the
// spec's own compatibility matrix — the row a dual-era server exists to avoid.
// A MISMATCH is still an error, because a header disagreeing with the body is
// the precise case the header exists to prevent: a proxy authorizing
// `tools/list` while the body calls a tool.
export function headerMismatch(msg, request) {
  const method = request.headers.get("mcp-method");
  if (method && msg?.method && method !== msg.method) {
    return `Mcp-Method header says ${method} but the body calls ${msg.method}`;
  }
  const name = request.headers.get("mcp-name");
  const target = msg?.params?.name || msg?.params?.uri;
  if (name && target && name !== target) {
    return `Mcp-Name header says ${name} but the body targets ${target}`;
  }
  return null;
}

// CORS headers both servers answer with. mcp-session-id stays allowed even
// though 2026-07-28 removed sessions and neither server ever had one: a legacy
// client may still send it, and failing its preflight over a header we intend
// to ignore would break it for no gain.
export function mcpCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, authorization",
    "access-control-max-age": "86400",
  };
}

// Results carry `resultType` and `_meta` serverInfo UNCONDITIONALLY, including
// to legacy callers. Safe in both directions: JSON-RPC clients ignore unknown
// result fields, and the spec tells modern clients to read a missing
// `resultType` as "complete" anyway. One code path beats two that must agree.
export function mcpServer({ serverInfo, capabilities, instructions }) {
  const result = (id, payload, cache = {}) => ({ jsonrpc: "2.0", id, result: {
    resultType: "complete",
    ...payload,
    ...cache,
    _meta: { [META_SERVER_INFO]: serverInfo },
  } });

  return {
    serverInfo,
    capabilities,
    instructions,
    result,

    // `server/discover`, which the spec says servers MUST implement. Identity,
    // capabilities and supported versions in one round trip, so a client can
    // render what a server is without probing tools/list + resources/list +
    // prompts/list separately.
    discover: (id) => result(id, {
      supportedVersions: MCP_SUPPORTED,
      capabilities,
      instructions,
    }, CACHE_STATIC),

    initialize: (id, requested) => ({ jsonrpc: "2.0", id, result: {
      protocolVersion: MCP_LEGACY.includes(requested) ? requested : MCP_LEGACY_DEFAULT,
      capabilities,
      serverInfo,
      instructions,
    } }),
  };
}

function mcpGate(msg, request) {
  const id = msg.id;
  const declared = declaredVersion(msg);
  if (declared && !MCP_SUPPORTED.includes(declared)) {
    return unsupportedVersion(id, declared);
  }
  const missing = missingRequiredMeta(msg);
  if (missing) return malformedRequest(id, missing);
  const mismatch = headerMismatch(msg, request);
  if (mismatch) {
    return { jsonrpc: "2.0", id, error: { code: ERR_HEADER_MISMATCH, message: mismatch } };
  }
  return null;
}

export const mcpError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

type McpEra = { era: "modern" | "legacy" | "mixed"; version?: string; client?: string };
const ERAS = new WeakMap<Request, McpEra>();

const REVISION = /^\d{4}-\d{2}-\d{2}$/;
function revision(value) {
  const text = asText(value);
  return text && REVISION.test(text) ? text : undefined;
}
function clientName(value) {
  const text = asText(value)?.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40);
  return text || undefined;
}

// A modern message declares its revision in `_meta`; everything else is legacy,
// which is the same era signal mcpGate reads (see declaredVersion). A legacy
// message names its revision in `initialize` params, or on the
// MCP-Protocol-Version header that 2025-06-18 added for every later request.
// Only `initialize` carries a client name in the legacy era, so a legacy
// session is named once, on the request that opened it.
function noteEra(request: Request, msg) {
  const declared = declaredVersion(msg);
  const era = declared ? "modern" : "legacy";
  const version = declared
    ? revision(declared)
    : revision(msg.params?.protocolVersion) ?? revision(request.headers.get("mcp-protocol-version"));
  const client = declared ? undefined : clientName(asRecord(msg.params?.clientInfo)?.name);
  const seen = ERAS.get(request);
  if (!seen) {
    ERAS.set(request, { era, version, client });
    return;
  }
  if (seen.era !== era) seen.era = "mixed";
  if (seen.version !== version) seen.version = undefined;
  seen.client ??= client;
}

export function mcpEraOf(request: Request): McpEra | undefined {
  return ERAS.get(request);
}

// Only a valid request without an ID is a notification. Malformed envelopes
// get Invalid Request with an unknown ID, even when they have no ID member.
export async function mcpRequest(msg, request, dispatch) {
  if (asRecord(msg) === null || msg.jsonrpc !== "2.0" || asText(msg.method) === null ||
    (Object.hasOwn(msg, "id") && msg.id !== null && msg.id !== "" && asText(msg.id) === null && asNumber(msg.id) === null) ||
    (Object.hasOwn(msg, "params") && asRecord(msg.params) === null && !Array.isArray(msg.params))) {
    return mcpError(null, -32600, "Invalid Request");
  }
  noteEra(request, msg);
  const reply = mcpGate(msg, request) ?? await dispatch(msg);
  return Object.hasOwn(msg, "id") ? reply : null;
}

export function rpcErrorDetail(payload) {
  const error = payload && payload.error;
  const code = Number.isInteger(error && error.code) ? error.code : null;
  const message = String(
    (error && error.message)
    || (payload && payload.error_description)
    || asText(error)
    || "",
  ).trim();
  if (code !== null) return `${code}: ${message.slice(0, 80) || "no message"}`;
  if (message) return message.slice(0, 90);
  try { return JSON.stringify(error).slice(0, 90); } catch { return "an error with no readable message"; }
}

// A Streamable HTTP response can be JSON or SSE. Select the requested reply,
// not a notification, server request or another call's result/error. The
// content type is a hint: some servers send SSE under text/plain.
export function parseMcpBody(text, contentType, expectedId: string | number) {
  const type = String(contentType || "").toLowerCase();
  const body = String(text || "");
  const streamed = type.includes("text/event-stream") || /^(?:event|data)(?::|$)/m.test(body);
  const framing = streamed ? "sse" : "json";
  for (const { data } of streamed ? sseEvents(body) : [{ data: body }]) {
    let payload;
    try { payload = JSON.parse(data); }
    catch {
      if (!streamed) return { ok: false, detail: `answered ${type.split(";")[0] || "no content-type"}, not JSON` };
      continue;
    }
    const reply = asRecord(payload);
    if (reply?.jsonrpc === "2.0" && reply.id === expectedId && !("method" in reply)
      && Object.hasOwn(reply, "result") !== Object.hasOwn(reply, "error")) {
      return { ok: true, payload, framing };
    }
    if (!streamed && reply?.error && !reply.jsonrpc) return { ok: false, detail: rpcErrorDetail(reply) };
  }
  return { ok: false, detail: `${streamed ? "SSE stream carried" : "answer contained"} no matching JSON-RPC response` };
}
