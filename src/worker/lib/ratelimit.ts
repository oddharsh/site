import { isCallable } from "./parse.ts";

/** Every ratelimit binding counts over this window (cloudflare.config.ts
 *  ratelimits; the binding accepts 10 or 60, and every budget here uses 60).
 *  contract-lens-per-ip-crawl-budgets holds the config to it. */
export const RATE_WINDOW_S = 60;

/** The headers a 429 from overBudget carries. Retry-After is the whole window:
 *  the limiter does not say how far into it the caller is, so the honest
 *  answer is the longest wait that can be needed. A 429 passed through from an
 *  upstream (Browser Run) does NOT take these, because its window is not ours. */
export const RATE_LIMITED_HEADERS: Readonly<Record<string, string>> = { "retry-after": String(RATE_WINDOW_S) };

// The site's one per-caller rate limiter. It lived in lens.ts until /mcp's five
// spending tools and /webmention needed it too; a helper that guards three
// surfaces should not be named after one of them, which is the move
// validateLensTarget already made into lib/crawl.ts. Every lens door reaches it
// through lens-pipeline.ts, which charges the budgets in a fixed order.
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
// that writes per request is an unbounded-by-design writer. It also spends two
// KV operations, and KV operations count against the 50-subrequest per-invocation
// cap (gotcha 36), on routes that already fan out.
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
    // A limiter blip should cost the rate limit, never the route — the same
    // reasoning the /lens/browser call site used to spell out inline.
    return false;
  }
}
