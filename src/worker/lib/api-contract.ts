// lib/api-contract.ts: what every documented API path promises, around its handler.
//
// lib/public-api.ts describes the keyless JSON API once. The handlers answer
// for their own query parameters and bodies; three promises belong to the API
// as a whole and are kept here, so no handler can forget one:
//
//   - the methods. A path in OPERATIONS answers the methods listed for it, plus
//     HEAD where it has GET, plus OPTIONS. Anything else is a JSON 405 with an
//     Allow header (RFC 9110 section 15.5.6), before the handler runs. Most of
//     these handlers never looked at the method, so a POST to /search.json used
//     to read like a GET.
//   - the version. API-Version is sent on every response from an API path, and
//     a request that pins any other version is a JSON 400 (VERSION_POLICY).
//   - deprecation. An operation marked `deprecated` answers with Deprecation
//     (RFC 9745) and Sunset (RFC 8594), and a Link to its successor.
//
// Every API response also carries `Link: </openapi.json>; rel="service-desc"`
// (RFC 8631), so a client holding any one response can find the description.
//
// dispatch.ts calls apiPreflight before routing and withApiContract on every
// answer from an API path, the preflight's refusals included.
// Node-safe (gotcha 16).
import { API_VERSION, API_VERSION_HEADER, OPENAPI_PATH, OPERATIONS, type Deprecation, type Operation } from "./public-api.ts";
import { jsonResponse } from "./http.ts";

const DOCS = "https://aadhar.sh/developers";

/** The documented operations on one path, keyed by path for the hot check. */
const BY_PATH: ReadonlyMap<string, readonly Operation[]> = OPERATIONS.reduce((m, op) => {
  m.set(op.path, [...(m.get(op.path) ?? []), op]);
  return m;
}, new Map<string, Operation[]>());

/** The methods a documented path answers, in Allow order. */
export function allowedMethods(ops: readonly Operation[]): string[] {
  const methods = new Set(ops.map((op) => op.method.toUpperCase()));
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return ["GET", "HEAD", "POST", "OPTIONS"].filter((m) => methods.has(m));
}

/** A refusal this layer answers before the handler runs, or null to route. */
export function apiPreflight(request: Request, pathname: string): Response | null {
  const ops = BY_PATH.get(pathname);
  if (!ops) return null;
  const allow = allowedMethods(ops);
  if (!allow.includes(request.method)) {
    return contractError(405, "method_not_allowed",
      `${pathname} does not answer ${request.method}. It answers ${allow.join(", ")}.`,
      { allow }, { allow: allow.join(", ") });
  }
  const pinned = request.headers.get(API_VERSION_HEADER);
  if (pinned !== null && pinned.trim() !== API_VERSION) {
    return contractError(400, "unsupported_api_version",
      `${API_VERSION_HEADER} ${JSON.stringify(pinned.trim())} is not a version this server serves. The live version is ${API_VERSION}.`,
      { supported: [API_VERSION] }, {});
  }
  return null;
}

const SERVICE_DESC = `<${OPENAPI_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`;

/** The response with the API-wide headers on it. Untouched off the API paths. */
export function withApiContract(response: Response, pathname: string, method: string): Response {
  const ops = BY_PATH.get(pathname);
  if (!ops) return response;
  // Rebuilt with the response as its own init, which keeps encodeBody (gotcha 13);
  // headers from the asset layer or a cache are immutable in place.
  const out = new Response(response.body, response);
  out.headers.set(API_VERSION_HEADER, API_VERSION);
  out.headers.append("link", SERVICE_DESC);
  // One path can carry two operations (GET and POST /ask), and a deprecation
  // is per operation, so it follows the method this request used.
  const want = method === "HEAD" ? "get" : method.toLowerCase();
  const deprecated = ops.find((op) => op.method === want)?.deprecated;
  if (deprecated) {
    for (const [name, value] of Object.entries(deprecationHeaders(deprecated))) {
      if (name === "link") out.headers.append(name, value);
      else out.headers.set(name, value);
    }
  }
  return out;
}

/** The Deprecation, Sunset and Link headers for an operation on its way out. */
export function deprecationHeaders(d: Deprecation): Record<string, string> {
  // RFC 9745 section 3: rel="deprecation" points at the policy; RFC 5829's
  // successor-version at the replacement, when there is one.
  const links = [`<${DOCS}#versioning>; rel="deprecation"; type="text/html"`];
  if (d.successor) links.push(`<${d.successor}>; rel="successor-version"`);
  return {
    // RFC 9745: an Item Date, `@` and the epoch seconds it took effect.
    deprecation: `@${Date.parse(`${d.since}T00:00:00Z`) / 1000}`,
    // RFC 8594: an HTTP-date.
    sunset: new Date(`${d.sunset}T00:00:00Z`).toUTCString(),
    link: links.join(", "),
  };
}

function contractError(status: number, code: string, error: string, extra: Record<string, unknown>, headers: Record<string, string>): Response {
  return jsonResponse({ ok: false, error, code, status, ...extra, docs: DOCS }, status, headers);
}
