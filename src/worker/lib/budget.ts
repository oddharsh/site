import { asText } from "./parse.ts";
import type { Span } from "./span-vocabulary.ts";

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
