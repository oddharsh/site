// budget.ts — the per-invocation subrequest ledger. Bundled by wrangler at
// deploy; not served, and node-safe so the contract suite can import it.
//
// THE FAILURE THIS EXISTS FOR, which this repo has now hit three times in three
// different surfaces:
//
//   Workers Free allows 50 subrequests per invocation. KV, R2 and D1 operations
//   COUNT toward it, which is the half everyone forgets. Cross it and the
//   runtime throws `Too many subrequests by single Worker`. That arrives as an
//   ordinary Error, so a fan-out with a per-item try/catch catches it once per
//   remaining item and reports N item failures. Every downstream check then
//   passes, because there really are N results — they are just all empty.
//
//   The homepage album covers went missing TWICE that way (`catch { trackFailed++ }`
//   over 21 track embeds). Seven Luma rosters parked in a retry queue that
//   re-spent the same doomed budget every tick and failed the same way. Both
//   were diagnosed as upstream flakiness first, because that is exactly what
//   they look like.
//
// So the rule this module encodes is one sentence: A PLATFORM CEILING IS NEVER
// THE CURRENT ITEM'S FAULT, and code that cannot tell the two apart will report
// the wrong one. `fault()` is the whole point of the file; the counting is
// bookkeeping around it.
//
// WHY A LIBRARY RATHER THAN THE THIRD LOCAL FIX. Each surface solved its own
// half and none of them could see the others: serendipity hand-rolled a
// `{ left, spent }` ledger and a `/too many subrequests/i` regex, rn.ts capped a
// batch with a constant, and `50` is currently typed out in two files that do
// not know about each other. What none of them has is the reconciliation below,
// which is the only thing here that finds a bug nobody already knew about.
//
// WHAT IT CANNOT DO, stated up front because it bounds every number this
// reports. A WORKER CANNOT READ ITS OWN SUBREQUEST COUNT. The runtime exposes
// no counter, so this ledger knows only what callers route through it, and an
// unmetered `fetch()` elsewhere in the invocation is invisible to it. That is
// not a flaw to fix later; it is the reason `overrun` exists.

import type { Span } from "./span-vocabulary.ts";

/**
 * Subrequests allowed per invocation on Workers Free. This account is on Free,
 * measured rather than assumed: the 2026-08-15 covers outage was a 21-track
 * scrape spending ~67 (37 fetches, 15 KV reads, 15 KV writes) against it.
 *
 * Paid raises this to 1000. The number is deliberately NOT read from a binding
 * or a var, because a Worker cannot ask which plan it is on and a wrong guess
 * in the permissive direction is exactly the outage this file is about.
 */
export const SUBREQUEST_CAP_FREE = 50;
export const SUBREQUEST_CAP_PAID = 1000;

/**
 * What the runtime says when the cap is crossed.
 *
 * A STRING MATCH, and it is worth being honest about what that costs: the
 * runtime throws a plain Error with no code and no class of its own, so there
 * is nothing else to match on. The full text observed here is `Too many
 * subrequests by single Worker`; the pattern is loose enough to survive
 * Cloudflare rewording the tail and specific enough that no application error
 * in this repo matches it. Kept as one exported constant so a reword is a
 * one-line fix rather than a hunt through three surfaces.
 */
const SUBREQUEST_LIMIT_PATTERN = /too many subrequests/i;

/**
 * Whether a thrown value is the platform's subrequest ceiling rather than a
 * fault of the work.
 *
 * Errors and strings are read; everything else is `item` by construction. A
 * blanket `String(error)` would be worse than useless here, since it turns a
 * thrown object into `[object Object]` and invites the pattern to be loosened
 * until it matches something. The runtime throws an Error, and a thrown string
 * is admitted only because a catch really does receive them.
 */
export function isSubrequestLimit(error: unknown): boolean {
  // A `catch` binding is the I/O boundary the no-runtime-typeof rule points at,
  // and THIS FUNCTION IS THE PARSE it asks for: it takes `unknown` off that
  // boundary and returns a domain answer every caller branches on instead of
  // re-testing the shape. There is no earlier place to do it, because the
  // language hands a catch an untyped value and nothing upstream can promise
  // what a third-party library threw. Kept narrow deliberately: two known
  // representations in, boolean out, and anything else is an item fault.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const thrownString = typeof error === "string" ? error : "";
  const message = error instanceof Error ? error.message : thrownString;
  return SUBREQUEST_LIMIT_PATTERN.test(message);
}

/** Who a failure belongs to. `cap` is the platform refusing; `item` is the work being wrong. */
export type Fault = "cap" | "item";

export interface Budget {
  /** The ceiling this ledger was opened against, after reserve. */
  readonly limit: number;
  /** Units charged so far. */
  readonly spent: number;
  /** Units still affordable. Never negative. */
  readonly left: number;
  /** True once the ledger has nothing left to spend. */
  readonly exhausted: boolean;
  /**
   * True once the PLATFORM refused while this ledger still showed headroom.
   *
   * This is the reconciliation, and it is the one thing here no local fix had.
   * The ledger counts only what is routed through it, so `overrun` means the
   * invocation spent subrequests this ledger never saw. It is a real, findable
   * bug (an unmetered fetch, a KV read nobody counted, a helper that fans out
   * on its own) reported as a number instead of as a mystery. Read it in
   * `budget.overrun` on any span that carries these attributes; it should be
   * false forever, and the day it is not, the count is wrong rather than the
   * ceiling.
   */
  readonly overrun: boolean;

  /**
   * Reserve `n` units. Returns false, and charges nothing, when they cannot be
   * afforded — so a caller stops before doing work rather than after failing.
   */
  afford(n?: number): boolean;
  /** Charge `n` units already spent, whether or not they were afforded first. */
  charge(n?: number): void;
  /**
   * Classify a thrown value, and record an overrun if the platform refused
   * while this ledger showed headroom.
   *
   * The one call that matters. In a fan-out's catch:
   *
   *   catch (e) {
   *     if (budget.fault(e) === "cap") { exhausted = true; break; }
   *     failed++;
   *   }
   *
   * without which `failed++` counts the ceiling once per remaining item.
   */
  fault(error: unknown): Fault;
}

/**
 * Open a ledger against a ceiling.
 *
 * `reserve` is held back from the cap and is not optional in spirit: an
 * invocation that spends its last subrequest has none left to write its own
 * result, and both real outages here ended with the write that would have
 * recorded what happened being the call that failed. serendipity reserves 6.
 */
export function createBudget(
  cap: number,
  opts: { reserve?: number } = {},
): Budget {
  const reserve = Math.max(0, opts.reserve ?? 0);
  const limit = Math.max(0, Math.floor(cap) - reserve);
  let spent = 0;
  let overrun = false;

  const ledger: Budget = {
    get limit() { return limit; },
    get spent() { return spent; },
    get left() { return Math.max(0, limit - spent); },
    get exhausted() { return spent >= limit; },
    get overrun() { return overrun; },

    afford(n = 1) {
      const cost = Math.max(0, Math.floor(n));
      if (spent + cost > limit) return false;
      spent += cost;
      return true;
    },
    charge(n = 1) {
      spent += Math.max(0, Math.floor(n));
    },
    fault(error) {
      if (!isSubrequestLimit(error)) return "item";
      // The platform said no. If we thought we had room, our count is wrong,
      // which is a fact worth surfacing rather than swallowing.
      if (spent < limit) overrun = true;
      return "cap";
    },
  };
  return ledger;
}

/**
 * Stamp a ledger onto a span.
 *
 * The parameter is the DEFAULT `Span` rather than a `Span<N>`, which is a real
 * constraint rather than laziness. `budget.*` lives in SharedSpanAttr precisely
 * so any surface may set it, but with `N` left generic `SpanSurface<N>` stays
 * deferred and the compiler cannot prove a shared key belongs to the union — the
 * same wall the cron helper in index.ts hits. `Span` resolves the surface to
 * `${string}.${string}`, every call site passes a narrower span, and parameter
 * positions are bivariant here because the Worker program runs `strict: false`.
 *
 * `overrun` is set only when true, so a trace carries the field exactly when it
 * means something.
 */
export function recordBudget(span: Span, budget: Budget): void {
  span.setAttribute("budget.limit", budget.limit);
  span.setAttribute("budget.spent", budget.spent);
  span.setAttribute("budget.exhausted", budget.exhausted);
  if (budget.overrun) span.setAttribute("budget.overrun", true);
}

/** What a budgeted fan-out did, as counts rather than as a pile of nulls. */
export type BudgetedRun<T> = {
  /** One entry per item that ran and returned, in input order. */
  results: T[];
  /** Items that ran and threw an error of their own. */
  failed: number;
  /** Items never attempted, because the ledger could not afford them. */
  skipped: number;
  /** True if the platform refused mid-run. */
  hitCap: boolean;
};

/**
 * Fan out over `items`, charging `cost` per item, stopping when the ledger runs
 * dry or the platform refuses.
 *
 * THE POINT IS THE CATCH, not the concurrency. A caller writing this loop by
 * hand writes `catch { failed++ }`, and that single line is what turned both
 * outages into a quiet wrong answer. Here a cap error ends the run and is
 * counted as `hitCap` plus `skipped`, and only a genuine item error reaches
 * `failed` — so "Spotify was flaky for 15 tracks" and "we ran out of budget
 * after 6" stop looking identical in the logs.
 *
 * Sequential on purpose. Concurrency buys latency and costs precision: with N
 * requests in flight the ledger cannot say which of them the ceiling landed on,
 * and every one already dispatched is spent whether or not it returns. Where
 * latency matters more than the count, use mapWithConcurrency and charge the
 * ledger yourself.
 */
export async function mapWithBudget<I, T>(
  items: Iterable<I>,
  budget: Budget,
  fn: (item: I, index: number) => Promise<T>,
  opts: { cost?: number } = {},
): Promise<BudgetedRun<T>> {
  const cost = Math.max(1, Math.floor(opts.cost ?? 1));
  const values = Array.from(items ?? []);
  const results: T[] = [];
  let failed = 0;
  let skipped = 0;
  let hitCap = false;

  for (let i = 0; i < values.length; i++) {
    if (hitCap || !budget.afford(cost)) {
      // Everything from here on is unattempted rather than failed, including
      // the item the ceiling landed on: it never got to run.
      skipped += values.length - i;
      break;
    }
    try {
      results.push(await fn(values[i], i));
    } catch (error) {
      if (budget.fault(error) === "cap") {
        hitCap = true;
        skipped += values.length - i;
        break;
      }
      failed++;
    }
  }

  return { results, failed, skipped, hitCap };
}
