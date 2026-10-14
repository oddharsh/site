import { isCallable } from "./parse.ts";

/** Every ratelimit binding counts over this window (cloudflare.config.ts
 *  ratelimits; the binding accepts 10 or 60, and every budget here uses 60).
 *  contract-lens-per-ip-crawl-budgets holds the config to it. */
export const RATE_WINDOW_S = 60;

/** The RateLimit-Policy item for one budget (draft-ietf-httpapi-ratelimit-
 *  headers-11, section 3): a String naming the policy, `q` the quota in
 *  requests, `w` the window in seconds. Static, so it is sent on every response
 *  a budgeted door gives, served or refused. */
export function rateLimitPolicy(name: string, max: number): string {
  return `"${name}";q=${max};w=${RATE_WINDOW_S}`;
}

/** The headers a 429 from overBudget carries. The binding answers a boolean,
 *  never a count or a reset time, so the only RateLimit (section 4) this side
 *  can state truthfully is the refused one: nothing left (r=0) within at most
 *  the whole window (t). Retry-After says the same, and the draft lets it take
 *  precedence. A 429 passed through from an upstream (Browser Run) does NOT
 *  take these, because its window is not ours to promise. */
export function rateLimitedHeaders(name: string, max: number): Record<string, string> {
  return {
    "retry-after": String(RATE_WINDOW_S),
    "ratelimit-policy": rateLimitPolicy(name, max),
    "ratelimit": `"${name}";r=0;t=${RATE_WINDOW_S}`,
  };
}

// A BUDGET is `{ binding, max }`: the name of a Rate Limiting binding, and the
// ceiling the module's own 429 message quotes. The two are mirrored rather than
// derived because the binding hands back a boolean and never a limit, so the
// number in the message can only come from our side. A contract test pins every
// budget against both wrangler configs.
//
// BACKED BY THE RATE LIMITING BINDING, where /lens used to be a KV read plus a
// KV write per allowed request. The KV version worked, and the reason to move is
// that it charged a durable write for a counter with a one-minute life. Against
// the 1,000-writes-a-day Workers Free ceiling this account is on, a public route
// that writes per request is an unbounded-by-design writer. It also spends two
// KV operations, and KV operations count against the 50-subrequest per-invocation
// cap (gotcha 36), on routes that already fan out.
export async function overBudget(budget, request, env) {
  const limiter = env && env[budget.binding];
  if (!limiter || !isCallable(limiter.limit)) return false;
  const ip = budget.key || request.headers.get("cf-connecting-ip") || "0.0.0.0";
  try {
    const { success } = await limiter.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}
