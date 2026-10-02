// lens-guard.ts — a guarded third-party read. Bundled by wrangler at deploy;
// not served.
//
// Every /lens tab that aims this Worker at somebody else's origin runs the same
// shell around different work: refuse a bad target, answer from the cache,
// charge the caller, do the work, keep the answer. Six handlers each carried a
// copy of that shell, and the copies had drifted: three awaited the cache write
// behind a catch, three handed it to waitUntil with none, and the order between
// the cache read and the budgets regressed once already (the note on step 4).
//
// This module owns the shell. A tab says WHAT it reads (a span name, a budget,
// a cache identity and TTL, and the work); the ORDER, the refusal shapes, the
// hit/miss span convention and the cache write live here and nowhere else.
//
// The order, which is the invariant:
//
//   1. the target is validated, and a bad one is a 400 that spends nothing
//   2. a tab's own parameter refusal, when it has one
//   3. a tab that needs Browser Run answers 503 where there is none
//   4. THE CACHE IS READ BEFORE ANY BUDGET. Every limit exists to ration the
//      work behind it. A hit spends none of that, so refusing one protects
//      nothing and costs the reader a 429 for an answer this Worker is already
//      holding. It reads as a bug at the worst moment, because the cache is
//      fullest exactly when demand is highest. Measured 2026-08-15 against a
//      warmed cache: one visitor clicking through the seeded chips got 429 on
//      the third, with all seven entries in KV the whole time.
//   5. the per-caller budget, then
//   6. the shared Browser Run ceiling, AFTER the per-caller one, so a single
//      heavy visitor is turned away by their own budget before they can spend
//      everyone's
//   7. the work, inside one span
//   8. the cache write, which can never fail the response
//
// What stays in the tab: the work itself and every status it can end in. A run
// that returns a Response is a finished answer that is NOT cached (a refusal, a
// shut door, an upstream fault); anything else is a result to keep.
import { jsonResponse } from "./lib/http.ts";
import { isCallable } from "./lib/parse.ts";
import { validateLensTarget } from "./lib/public-fetch.ts";
import { overBudget } from "./lib/ratelimit.ts";
import { span } from "./lib/trace.ts";
import type { Span, SpanName } from "./lib/span-vocabulary.ts";

export const LENS_BUDGETS = {
  inspect: { binding: "LENS_RL_INSPECT", max: 30 },
  shot:    { binding: "LENS_RL_SHOT",    max: 3  },
  compare: { binding: "LENS_RL_COMPARE", max: 4  },
  browser: { binding: "LENS_RL_BROWSER", max: 3  },
  wire:    { binding: "LENS_RL_WIRE",    max: 2  },
  tools:   { binding: "LENS_RL_TOOLS",   max: 10 },
  // Tighter than the catalogue read it sits beside, and deliberately so: a
  // catalogue read costs a foreign server a lookup, and an /ask costs it a
  // retrieval and possibly a model call.
  nlweb:   { binding: "LENS_RL_NLWEB",   max: 4  },
  // Ten plain GETs of one URL per run, deduped by Accept string. No browser
  // and no model, so it is cheaper than the tabs above it on OUR side; what it
  // spends is somebody else's bandwidth, ten times over, on one page. Sat
  // between the catalogue read and the /ask question for that reason.
  markdown: { binding: "LENS_RL_MARKDOWN", max: 4 },
  // The shared ceiling. Keyed on a CONSTANT rather than the caller's IP, so
  // every browser-consuming route bills against one bucket and no single
  // visitor can spend the account's allowance.
  //
  // Honest about what this is: the Rate Limiting binding counts per COLO, so a
  // fixed key buys per-colo-global, not truly account-wide. Traffic spread over
  // N colos can still total N x max. That is a large improvement over per-IP and
  // is not a guarantee — the guarantee is the 429 handling in each browser tab,
  // which treats an upstream refusal as a normal outcome rather than a fault.
  browserAll: { binding: "LENS_RL_BROWSER_ALL", max: 4, key: "browser-run" },
};

// A per-caller budget a read may name. The shared ceiling is not one of them:
// it is charged by saying the read needs Browser Run, never by name.
export type LensBudgetName = Exclude<keyof typeof LENS_BUDGETS, "browserAll">;

type LensSpanName = Extract<SpanName, `lens.${string}`>;
type LensSpan = Span<LensSpanName>;

export async function lensSha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf).toHex();
}

// The one spelling of a /lens cache key. `variant` APPENDS to the plain key
// rather than joining the hash, so adding a variant to a tab never moves the
// keys it already wrote (the /lens/browser recipe note has the cost of that).
export async function lensCacheKey(tab: string, identity: string, variant?: string | null): Promise<string> {
  const key = "lens:" + tab + ":" + (await lensSha256Hex(identity));
  return variant ? key + ":" + variant : key;
}

// Written once. It is also what a tab answers when its engine seam comes back
// empty mid-run, so the two cannot drift into different sentences.
export function browserRunMissing(): Response {
  return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);
}

// How a result is stored and answered. Three adapters exist: the JSON default
// below (four tabs), the PNG bytes of /lens/shot, and the size-capped snapshot
// of /lens/browser.
export type LensCacheForm<T> = {
  as: "json" | "arrayBuffer";
  // False sends a cached entry back through the miss path.
  usable?(cached: any): boolean;
  hit(cached: any, s: LensSpan): Response;
  fresh(result: T): Response;
  // Null skips the write.
  stored(result: T, s: LensSpan): string | ArrayBuffer | null;
};

const JSON_FORM: LensCacheForm<any> = {
  as: "json",
  // `fromCache`, NEVER `cached`. /lens/wire's summary already owns `cached` as
  // the number of the TARGET's requests the browser served from ITS cache, and
  // spelling this one the same way overwrote that count with a boolean: the
  // pane rendered "true served from cache". Two subjects, two keys.
  hit: (cached) => jsonResponse({ ...cached, fromCache: true }),
  fresh: (result) => jsonResponse(result),
  stored: (result) => JSON.stringify(result),
};

export type GuardedRead<T> = {
  // One span name for hit and miss, differing on `lens.cache`, so the hit rate
  // is a group-by rather than a join.
  span: LensSpanName;
  // The caller's raw `url` parameter. Validated here, never by the tab.
  url: string;
  // A 400 the tab found in its OWN parameters. Answered after the target's 400
  // and before anything is read or charged.
  refuse?: Response | null;
  budget: LensBudgetName;
  // The 429 sentence. It is handed the ceiling so the number it quotes can only
  // be the one LENS_BUDGETS holds.
  limited(max: number): string;
  // Set by a tab that spends Browser Run: whether this deployment can render at
  // all. Saying so is also what charges the shared ceiling.
  browser?(env: any): boolean;
  cache: {
    tab: string;
    // What the key hashes; the validated URL when omitted.
    identity?(url: string): string;
    variant?: string | null;
    ttl: number;
    form?: LensCacheForm<T>;
  };
  run(url: string, s: LensSpan): Promise<Response | T>;
};

function hostOf(url: string): string | undefined {
  // hostname only, never the full URL: a span attribute is the wrong place for
  // a third party's query string, which can carry their tokens and identifiers.
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

export async function guardedRead<T>(request: Request, env: any, ctx: any, read: GuardedRead<T>): Promise<Response> {
  const v = validateLensTarget(read.url);
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (read.refuse) return read.refuse;
  if (read.browser && !read.browser(env)) return browserRunMissing();

  const form = read.cache.form || JSON_FORM;
  const key = await lensCacheKey(read.cache.tab, read.cache.identity ? read.cache.identity(v.url) : v.url, read.cache.variant);
  const host = hostOf(v.url);
  const kv = env && env.RN_KV;

  if (kv) {
    let cached = null;
    // A cache that throws or holds a corrupt entry is a miss, never a
    // user-visible failure. An unhandled throw here does not produce a JSON
    // error, it produces Cloudflare's HTML 1101 page, which the pane then
    // tries to JSON.parse.
    try { cached = await kv.get(key, form.as); } catch (_e) { cached = null; }
    if (cached && (!form.usable || form.usable(cached))) {
      return span(read.span, (s) => {
        s.setAttribute("lens.target_host", host);
        s.setAttribute("lens.cache", "hit");
        return form.hit(cached, s);
      });
    }
  }

  const budget = LENS_BUDGETS[read.budget];
  if (await overBudget(budget, request, env)) {
    return jsonResponse({ ok: false, error: read.limited(budget.max) }, 429);
  }
  if (read.browser && await overBudget(LENS_BUDGETS.browserAll, request, env)) {
    return jsonResponse({ ok: false, error: "The shared browser budget for this minute is spent. Try again shortly." }, 429);
  }

  return span(read.span, async (s) => {
    s.setAttribute("lens.target_host", host);
    s.setAttribute("lens.cache", "miss");
    const result = await read.run(v.url, s);
    if (result instanceof Response) return result;
    if (kv) {
      const value = form.stored(result, s);
      if (value != null) {
        // A cache write is never worth failing the read for. With a `ctx` it
        // rides waitUntil so the reader is not kept waiting on KV; without one
        // it is awaited, because nothing else would keep the isolate alive.
        let write: Promise<unknown>;
        try { write = Promise.resolve(kv.put(key, value, { expirationTtl: read.cache.ttl })).catch(() => {}); }
        catch (_e) { write = Promise.resolve(); }
        if (ctx && isCallable(ctx.waitUntil)) ctx.waitUntil(write);
        else await write;
      }
    }
    return form.fresh(result);
  });
}
