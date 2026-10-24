// budget.ts — the per-invocation subrequest ledger. Bundled by wrangler at
// deploy; not served, and node-safe so the contract suite can import it.
//
// THE FAILURE THIS EXISTS FOR, which this repo has now hit three times in three
// different surfaces:
//
//   Workers Free allows 50 subrequests per invocation. KV, R2 and D1 operations
//   were believed to COUNT toward it, and production contradicts that for KV
//   and D1 (2026-10-14, below). Cross it and the runtime throws `Too many
//   subrequests by single Worker invocation`. That arrives as an
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
// WHAT COUNTS, measured 2026-10-14. On four days in September and October the
// daily /around crawl recorded this exact refusal against its last neighbors,
// and then, in the same invocation, its KV snapshot put and its D1 history
// batch both succeeded (around_crawl_history holds those rows). A KV write and
// a D1 batch after the ceiling had refused a fetch cannot be counted against
// it. The ledgers here still charge internal calls where they did before:
// overcounting costs a little work per run, and undercounting is the outage.
//
// So the rule this module encodes is one sentence: A PLATFORM CEILING IS NEVER
// THE CURRENT ITEM'S FAULT, and code that cannot tell the two apart will report
// the wrong one. `fault()` is the whole point of the file; the counting is
// bookkeeping around it.
//
// WHY A LIBRARY RATHER THAN A LOCAL FIX PER SURFACE. Each surface had solved
// its own half without seeing the others: serendipity hand-rolled a
// `{ left, spent }` ledger and a `/too many subrequests/i` regex, and rn.ts
// capped a batch with a constant. None of them had the reconciliation below,
// which is the only thing here that finds a bug nobody already knew about.
//
// WHAT IT CANNOT DO, stated up front because it bounds every number this
// reports. A WORKER CANNOT READ ITS OWN SUBREQUEST COUNT. The runtime exposes
// no counter, so this ledger knows only what callers route through it, and an
// unmetered `fetch()` elsewhere in the invocation is invisible to it. That limit
// is permanent, and it is the reason `overrun` exists.

import { asText } from "./parse.ts";
import type { PublicTransport } from "./public-fetch.ts";
import type { Span } from "./span-vocabulary.ts";

/**
 * Subrequests allowed per invocation on Workers Free. This account is on Free,
 * measured rather than assumed: the 2026-08-15 covers outage was a 21-track
 * scrape that crossed it.
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
 * is nothing else to match on. The full text, read off around_crawl_history's
 * error column on 2026-10-14, is `Too many subrequests by single Worker
 * invocation. To configure this limit, refer to
 * https://developers.cloudflare.com/workers/wrangler/configuration/#limits`.
 * The pattern is loose enough to survive
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
  const message = error instanceof Error ? error.message : (asText(error) ?? "");
  return SUBREQUEST_LIMIT_PATTERN.test(message);
}

/**
 * Whether the platform's ceiling is buried anywhere in a result tree.
 *
 * A fan-out that catches per item stores the refusal as `{ ok: false, error }`
 * on whichever item it landed on, so the question "did the platform refuse to
 * look" has to be asked of the whole tree rather than of one field. census.ts
 * asks it before publishing a row, and lens.ts before caching a discovery blob.
 *
 * A GENERIC WALK rather than a list of fields, because a list of fields is the
 * thing that rots: the next probe is covered by existing. Only an `error`
 * property is read, so a body string that happens to contain the words is
 * never mistaken for a refusal, and strings are never descended into.
 */
export function subrequestLimitIn(result: unknown, maxDepth = 6): boolean {
  const isObj = (v: unknown) => v !== null && Object(v) === v;
  const stack: Array<[any, number]> = [[result, 0]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [node, depth] = next;
    if (!isObj(node) || depth > maxDepth) continue;
    if (isSubrequestLimit(node.error)) return true;
    for (const value of Object.values(node)) if (isObj(value)) stack.push([value, depth + 1]);
  }
  return false;
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
 * recorded what happened being the call that failed. serendipity reserves 8
 * (CRON_BUDGET_HEADROOM).
 */
export function createBudget(cap: number, opts: { reserve?: number } = {}): Budget {
  const reserve = Math.max(0, opts.reserve ?? 0);
  const limit = Math.max(0, Math.floor(cap) - reserve);
  let spent = 0;
  let overrun = false;

  const ledger: Budget = {
    get limit() {
      return limit;
    },
    get spent() {
      return spent;
    },
    get left() {
      return Math.max(0, limit - spent);
    },
    get exhausted() {
      return spent >= limit;
    },
    get overrun() {
      return overrun;
    },

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

/**
 * A network adapter that charges `budget` one unit per request and refuses once
 * the ledger is spent.
 *
 * THIS IS HOW A LEDGER SEES REDIRECTS. A caller that charges per fetch() call
 * undercounts every redirect chain, because each hop is its own subrequest and
 * the hops happen inside a helper. lib/public-fetch.ts follows redirects one
 * hop at a time through its `transport` argument, and lib/botauth.ts passes
 * `env.OUTBOUND_TRANSPORT` there for both robots.txt and the signed read, so a
 * job that installs this on its env has every hop it makes counted before it
 * is dispatched. Hand it the env's own adapter as `inner` so a test's fake
 * network still answers; absent, each hop goes to the global fetch, read at
 * call time.
 *
 * The refusal says "too many subrequests" on purpose, so isSubrequestLimit()
 * and every caller that already rethrows the platform's ceiling (botauth's
 * robots read, census) treat a spent ledger exactly like the real thing. The
 * rest of the message names the ledger, so a log never confuses the two.
 */
export function meteredTransport(budget: Budget, inner?: PublicTransport | null): PublicTransport {
  return (url, init) => {
    if (!budget.afford(1)) {
      return Promise.reject(new Error(`Too many subrequests for this job's ledger (${budget.spent} of ${budget.limit} spent)`));
    }
    return inner ? inner(url, init) : fetch(url, init);
  };
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
