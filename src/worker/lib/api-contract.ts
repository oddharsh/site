// lib/api-contract.ts: what every documented API path promises, around its handler.
//
// lib/public-api.ts describes the keyless JSON API once. The handlers answer
// for their own query parameters and bodies; two promises belong to the API
// as a whole and are kept here, so no handler can forget one:
//
//   - the methods. A path in OPERATIONS answers the methods listed for it, plus
//     HEAD where it has GET, plus OPTIONS. Anything else is a JSON 405 with an
//     Allow header (RFC 9110 section 15.5.6), before the handler runs. Most of
//     these handlers never looked at the method, so a POST to /search.json used
//     to read like a GET.
//   - the rate. An operation with no limiter of its own (sharesReadBudget)
//     bills API_READ_BUDGET per caller and names it in RateLimit-Policy on
//     every answer; over it, a JSON 429 with Retry-After and RateLimit. The
//     Lens doors keep their own, stricter budgets (lens-pipeline.ts).
//
// Every API response also carries `Link: </openapi.json>; rel="service-desc"`
// (RFC 8631), so a client holding any one response can find the description.
// There is no version header and no deprecation machinery: LEAVES_OUT in
// public-api.ts says why, and /developers prints it.
//
// dispatch.ts calls apiPreflight before routing and withApiContract on every
// answer from an API path, the preflight's refusals included.
// Node-safe (gotcha 16).
import { OPENAPI_PATH, OPERATIONS, READ_POLICY, sharesReadBudget, type Operation } from "./public-api.ts";
import { API_READ_BUDGET } from "./api-limits.ts";
import { jsonResponse } from "./http.ts";
import { overBudget, rateLimitPolicy, rateLimitedHeaders } from "./ratelimit.ts";

const DOCS = "https://aadhar.sh/developers";

const BY_PATH: ReadonlyMap<string, readonly Operation[]> = OPERATIONS.reduce((m, op) => {
  m.set(op.path, [...(m.get(op.path) ?? []), op]);
  return m;
}, new Map<string, Operation[]>());

export function allowedMethods(ops: readonly Operation[]): string[] {
  const methods = new Set(ops.map((op) => op.method.toUpperCase()));
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return ["GET", "HEAD", "POST", "OPTIONS"].filter((m) => methods.has(m));
}

const READ_BUDGETED: ReadonlySet<string> = new Set([...BY_PATH].filter(([, ops]) => ops.every(sharesReadBudget)).map(([path]) => path));
const READ_POLICY_HEADER = rateLimitPolicy(...READ_POLICY);

/** A refusal this layer answers before the handler runs, or null to route. */
export async function apiPreflight(request: Request, pathname: string, env: unknown): Promise<Response | null> {
  const ops = BY_PATH.get(pathname);
  if (!ops) return null;
  const allow = allowedMethods(ops);
  if (!allow.includes(request.method)) {
    return contractError(
      405,
      "method_not_allowed",
      `${pathname} does not answer ${request.method}. It answers ${allow.join(", ")}.`,
      { allow },
      { allow: allow.join(", ") },
    );
  }
  // OPTIONS is a question about the API rather than a read of it, so it is free.
  if (request.method !== "OPTIONS" && READ_BUDGETED.has(pathname) && (await overBudget(API_READ_BUDGET, request, env))) {
    return contractError(
      429,
      "rate_limited",
      `Over the read budget of ${API_READ_BUDGET.max} requests a minute per caller. Retry after the Retry-After seconds.`,
      {},
      rateLimitedHeaders(...READ_POLICY),
    );
  }
  return null;
}

const SERVICE_DESC = `<${OPENAPI_PATH}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`;

export function withApiContract(response: Response, pathname: string): Response {
  if (!BY_PATH.has(pathname)) return response;
  // Rebuilt with the response as its own init, which keeps encodeBody (gotcha 13);
  // headers from the asset layer or a cache are immutable in place.
  const out = new Response(response.body, response);
  out.headers.append("link", SERVICE_DESC);
  if (READ_BUDGETED.has(pathname) && !out.headers.has("ratelimit-policy")) out.headers.set("ratelimit-policy", READ_POLICY_HEADER);
  return out;
}

function contractError(status: number, code: string, error: string, extra: Record<string, unknown>, headers: Record<string, string>): Response {
  return jsonResponse({ ok: false, error, code, status, ...extra, docs: DOCS }, status, headers);
}
