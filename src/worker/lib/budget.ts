// budget.ts — the per-invocation subrequest ledger. Bundled by wrangler at
// deploy; not served, and node-safe so the contract suite can import it.
//
//   Workers Free allows 50 subrequests per invocation. KV, R2 and D1 operations
//   were believed to COUNT toward it, and production contradicts that for KV
//   and D1 (2026-10-14, below). Cross it and the runtime throws `Too many
//   subrequests by single Worker invocation`. That arrives as an
//   ordinary Error, so a fan-out with a per-item try/catch catches it once per
//   remaining item and reports N item failures. Every downstream check then
//   passes, because there really are N results — they are just all empty.
//
// WHAT COUNTS, measured 2026-10-14. On four days in September and October the
// daily /around crawl recorded this exact refusal against its last neighbors,
// and then, in the same invocation, its KV snapshot put and its D1 history
// batch both succeeded (around_crawl_history holds those rows). A KV write and
// a D1 batch after the ceiling had refused a fetch cannot be counted against
// it. The ledgers here still charge internal calls where they did before:
// overcounting costs a little work per run, and undercounting is the outage.

import { asText } from "./parse.ts";
import type { PublicTransport } from "./public-fetch.ts";
import type { Span } from "./span-vocabulary.ts";

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

export function isSubrequestLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : asText(error) ?? "";
  return SUBREQUEST_LIMIT_PATTERN.test(message);
}

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

export type Fault = "cap" | "item";

export interface Budget {
  readonly limit: number;
  readonly spent: number;
  readonly left: number;
  readonly exhausted: boolean;
  readonly overrun: boolean;

  afford(n?: number): boolean;
  charge(n?: number): void;
  fault(error: unknown): Fault;
}

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
      if (spent < limit) overrun = true;
      return "cap";
    },
  };
  return ledger;
}

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

export type BudgetedRun<T> = {
  results: T[];
  failed: number;
  skipped: number;
  hitCap: boolean;
};

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
