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

// The site's one per-caller rate limiter, shared by /lens, /mcp's spending
// tools, /webmention and others, so it is named after none of them. Every lens
// door reaches it through lens-pipeline.ts, which charges the budgets in a
// fixed order.
//
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
// that writes per request is an unbounded-by-design writer. (KV operations were
// also believed to count against the 50-subrequest cap; production contradicted
// that on 2026-10-14, lib/budget.ts.)
//
// The binding's counters are per-colo and eventually consistent, which sounds
// like a downgrade and is not: the KV buckets were already per-colo and
// eventually consistent, because a KV write is not visible everywhere
// immediately either. What actually changes is that the counter no longer costs
// a write, and no longer sits on the request path waiting for one.
//
// FAILS OPEN when the binding is absent, exactly as the KV versions failed open
// without RN_KV. This is abuse control, not authorization; the SSRF guard in
// validateLensTarget is what enforces safety, and it has no fallback.
//
// Keyed on IP, which Cloudflare's own docs advise against because users share
// them. Kept deliberately: the thing being limited is a server-side crawler
// being pointed at third parties, there is no account to key on, and the
// alternative to an imperfect key here is no limit at all.
export async function overBudget(budget, request, env) {
  const limiter = env && env[budget.binding];
  if (!limiter || !isCallable(limiter.limit)) return false;
  // A budget carrying a fixed `key` is a SHARED ceiling rather than a per-caller
  // one: everybody bills against the same bucket on purpose.
  const ip = budget.key || request.headers.get("cf-connecting-ip") || "0.0.0.0";
  try {
    const { success } = await limiter.limit({ key: ip });
    return !success;
  } catch {
    // A limiter blip should cost the rate limit, never the route.
    return false;
  }
}
