// lens-pipeline.ts: the one request pipeline every lens door runs through.

import { sha256Hex, validateLensTarget } from "./lib/public-fetch.ts";
import { overBudget, rateLimitedHeaders, rateLimitPolicy } from "./lib/ratelimit.ts";
import { jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { asRecord, asText, isCallable } from "./lib/parse.ts";
import { hasRenderEngine } from "./lens-render.ts";
import type { Span } from "./lib/span-vocabulary.ts";

type LensBudgetDecl = {
  binding: string;
  max: number;
  label: string;
  why?: string;
  shares?: string;
  key?: string;
};

// Browser Run's FREE plan allows one Quick Action every 10 seconds ACCOUNT-WIDE
// (6/min), 3 concurrent browsers, and 10 minutes of browser time a day.
// Measured 2026-08-06: two Quick Actions ~2s apart, and the second came back
// 429. The per-IP ceilings below were written against no such limit. `shot`
// alone allowed 8/min to a SINGLE visitor, so one person could spend the whole
// account's minute and the next visitor got a failure that read like a bug.
export const LENS_BUDGETS = {
  inspect: { binding: "LENS_RL_INSPECT", max: 30, label: "Lens lookups", shares: "/lens/fetch, /mcp and the terminal tools" },
  shot:    { binding: "LENS_RL_SHOT",    max: 3,  label: "Snapshots" },
  compare: { binding: "LENS_RL_COMPARE", max: 4,  label: "Lens comparisons", shares: "/lens/compare and /mcp" },
  browser: { binding: "LENS_RL_BROWSER", max: 3,  label: "Browser Run snapshots" },
  wire:    { binding: "LENS_RL_WIRE",    max: 2,  label: "Wire traces" },
  tools:   { binding: "LENS_RL_TOOLS",   max: 10, label: "Catalogue reads" },
  nlweb:   { binding: "LENS_RL_NLWEB",   max: 4,  label: "NLWeb reads", why: "because each one asks somebody else's server a real question" },
  markdown: { binding: "LENS_RL_MARKDOWN", max: 4, label: "Markdown checks", why: "because each one fetches the same page ten times from somebody else's origin" },
  // Honest about what this is: the Rate Limiting binding counts per COLO, so a
  // fixed key buys per-colo-global, not truly account-wide. Traffic spread over
  // N colos can still total N x max. That is a large improvement over per-IP and
  // is not a guarantee. The guarantee is the 429 handling in each browser run,
  // which treats an upstream refusal as a normal outcome rather than a fault.
  browserAll: { binding: "LENS_RL_BROWSER_ALL", max: 4, label: "The shared browser budget", key: "browser-run" },
} satisfies Record<string, LensBudgetDecl>;

export type LensBudget = keyof typeof LENS_BUDGETS;

export function budgetMessage(name: LensBudget): string {
  const b: LensBudgetDecl = LENS_BUDGETS[name];
  if (b.key) return `${b.label} (${b.max}/min across every visitor) is spent for this minute. Try again shortly.`;
  const why = b.why ? `, ${b.why}` : "";
  const shares = b.shares ? `, shared with ${b.shares}` : "";
  return `${b.label} are rate-limited to ${b.max}/min${why}${shares}. Hang on a moment.`;
}

export { sha256Hex as lensSha256Hex };

export function lensPngHeaders(cached: boolean) {
  return { "content-type": "image/png", "cache-control": "public, max-age=3600", "x-robots-tag": "noindex", "x-lens-cache": cached ? "hit" : "miss" };
}

const NO_ENGINE = "Browser Run is not configured on this deployment.";

// KV's own ceiling is 25 MB. Applied to every lens, where it used to guard
// /lens/browser alone: KV rejects an oversize value, and because the put runs in
// waitUntil the throw lands where nobody is listening, so the only symptom was a
// page that re-rendered from scratch on every visit.
export const LENS_KV_MAX = 20_000_000;

export type LensSpanName =
  | "lens.shot" | "lens.browser" | "lens.wire" | "lens.tools" | "lens.nlweb" | "lens.markdown";

export type LensRan<V> =
  | { ok: true; value: V; store?: unknown; outcome?: string }
  | { ok: false; status: number; payload: Record<string, unknown>; outcome: string };

export type LensOutcome<V> =
  | { kind: "ok"; value: V; fromCache?: boolean; budgets?: LensBudget[] }
  | { kind: "failed"; status: number; payload: Record<string, unknown> }
  | {
      kind: "refused";
      status: 400 | 429 | 503;
      reason: "bad_target" | "unavailable" | "over_budget";
      error: string;
      budget?: LensBudget;
      extra?: Record<string, unknown>;
    };

export class LensArgsRefusal {
  readonly error: string;
  readonly extra?: Record<string, unknown>;
  constructor(error: string, extra?: Record<string, unknown>) {
    this.error = error;
    this.extra = extra;
  }
}

export interface LensRunContext<T, A> {
  target: T;
  args: A;
  env: any;
  request: Request;
  ctx: any;
  span: Span<LensSpanName>;
}

export interface LensCacheSpec<T, A> {
  prefix: `lens:${string}:`;
  ttl: number;
  key?: (target: T, args: A) => string;
  suffix?: (args: A) => string | null | undefined;
  usable?: (entry: any) => boolean;
}

export interface LensSpec<In, T extends string | Record<string, string>, A, V> {
  span?: LensSpanName;
  budget: LensBudget;
  browser?: "render" | "cdp";
  body?: "json" | "png";
  targets: (input: In) => T;
  args?: (input: In, target: T) => A | LensArgsRefusal;
  cache?: LensCacheSpec<T, A>;
  run: (c: LensRunContext<T, A>) => Promise<LensRan<V>>;
  onThrow?: (error: unknown) => { status: number; payload: Record<string, unknown> };
}

export interface Lens<In, V> {
  run(input: In, request: Request, env: any, ctx?: any): Promise<LensOutcome<V>>;
  handle(request: Request, env: any, ctx?: any): Promise<Response>;
}

const PREFIXES = new Set<string>();

const INERT_SPAN: Span<LensSpanName> = Object.freeze({ setAttribute() {}, end() {}, isTraced: false });

function withSpan<R>(name: LensSpanName | undefined, fn: (s: Span<LensSpanName>) => R): R {
  return name ? span(name, fn) : fn(INERT_SPAN);
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function refused<V>(status: 400 | 429 | 503, reason: "bad_target" | "unavailable" | "over_budget", error: string, extra?: { budget?: LensBudget; extra?: Record<string, unknown> }): LensOutcome<V> {
  return { kind: "refused", status, reason, error, ...extra };
}

function defaultUsable(body: "json" | "png") {
  return body === "png"
    ? (entry) => entry instanceof ArrayBuffer && entry.byteLength > 0
    : (entry) => asRecord(entry) !== null && entry.ok !== false;
}

function browserReady(kind: "render" | "cdp", env): boolean {
  return kind === "render" ? hasRenderEngine(env) : !!(env && env.BROWSER && isCallable(env.BROWSER.fetch));
}

export function lensErrorText(e: unknown): string {
  return asText(asRecord(e)?.message) ?? String(e);
}

export function defineLens<In, T extends string | Record<string, string>, A = undefined, V = any>(
  spec: LensSpec<In, T, A, V>,
): Lens<In, V> {
  if (!(spec.budget in LENS_BUDGETS) || spec.budget === "browserAll") {
    throw new Error(`defineLens: ${String(spec.budget)} is not a per-route budget`);
  }
  if (spec.cache) {
    if (PREFIXES.has(spec.cache.prefix)) throw new Error(`defineLens: cache prefix ${spec.cache.prefix} is declared twice`);
    PREFIXES.add(spec.cache.prefix);
  }
  const body = spec.body || "json";
  const usable = spec.cache?.usable || defaultUsable(body);

  const ttl = spec.cache?.ttl;

  async function run(input: In, request: Request, env: any, ctx?: any): Promise<LensOutcome<V>> {
    const raw = spec.targets(input);
    let target: T;
    let first: string;
    const pair: Record<string, string> | null = asRecord(raw);
    if (!pair) {
      const v = validateLensTarget(raw || "");
      if (!v.ok) return refused(400, "bad_target", String(v.error));
      target = v.url as T;
      first = v.url;
    } else {
      const out: Record<string, string> = {};
      for (const [label, value] of Object.entries(pair)) {
        const v = validateLensTarget(value || "");
        if (!v.ok) return refused(400, "bad_target", `${label}: ${v.error}`);
        out[label] = v.url;
      }
      target = out as T;
      first = Object.values(out)[0] ?? "";
    }

    let args = undefined as A;
    if (spec.args) {
      const a = spec.args(input, target);
      if (a instanceof LensArgsRefusal) return refused(400, "bad_target", a.error, { extra: a.extra });
      args = a;
    }

    if (spec.browser && !browserReady(spec.browser, env)) return refused(503, "unavailable", NO_ENGINE);

    const budgets: LensBudget[] = spec.browser ? [spec.budget, "browserAll"] : [spec.budget];

    const host = hostOf(first);
    let key: string | null = null;
    if (spec.cache) {
      key = spec.cache.prefix + (await sha256Hex(spec.cache.key ? spec.cache.key(target, args) : first));
      const suffix = spec.cache.suffix?.(args);
      if (suffix) key += ":" + suffix;
    }
    if (key && env && env.RN_KV) {
      let read: any = null;
      try { read = await env.RN_KV.get(key, body === "png" ? "arrayBuffer" : "json"); }
      catch { read = null; }
      const hit = read;
      if (hit !== null && usable(hit)) {
        return withSpan(spec.span, (s) => {
          s.setAttribute("lens.target_host", host);
          s.setAttribute("lens.cache", "hit");
          if (body === "png") s.setAttribute("lens.png_bytes", hit.byteLength);
          return { kind: "ok", value: hit as V, fromCache: true, budgets };
        });
      }
    }

    if (await overBudget(LENS_BUDGETS[spec.budget], request, env)) {
      return refused(429, "over_budget", budgetMessage(spec.budget), { budget: spec.budget });
    }
    if (spec.browser && await overBudget(LENS_BUDGETS.browserAll, request, env)) {
      return refused(429, "over_budget", budgetMessage("browserAll"), { budget: "browserAll" });
    }

    return withSpan(spec.span, async (s) => {
      s.setAttribute("lens.target_host", host);
      if (spec.cache) s.setAttribute("lens.cache", "miss");
      let ran: LensRan<V>;
      try {
        ran = await spec.run({ target, args, env, request, ctx, span: s });
      } catch (e) {
        s.setAttribute("lens.outcome", "threw");
        s.setAttribute("lens.error", lensErrorText(e));
        const t = spec.onThrow ? spec.onThrow(e) : { status: 502, payload: { ok: false, error: "The lens failed: " + lensErrorText(e) } };
        return { kind: "failed", status: t.status, payload: t.payload };
      }
      if (!ran.ok) {
        s.setAttribute("lens.outcome", ran.outcome);
        return { kind: "failed", status: ran.status, payload: ran.payload };
      }
      s.setAttribute("lens.outcome", ran.outcome || "ok");
      if (key && env && env.RN_KV) {
        const stored = ran.store === undefined ? ran.value : ran.store;
        if (usable(stored)) {
          const bytes = body === "png" ? stored : JSON.stringify(stored);
          const size = body === "png" ? (stored as ArrayBuffer).byteLength : (bytes as string).length;
          if (size > LENS_KV_MAX) {
            s.setAttribute("lens.cache_skipped", size);
          } else {
            const write = (async () => env.RN_KV.put(key, bytes, { expirationTtl: ttl }))().catch(() => {});
            if (ctx && isCallable(ctx.waitUntil)) ctx.waitUntil(write);
            else await write;
          }
        }
      }
      return { kind: "ok", value: ran.value, fromCache: spec.cache ? false : undefined, budgets };
    });
  }

  return {
    run,
    async handle(request, env, ctx) {
      const outcome = await run(new URL(request.url).searchParams as In, request, env, ctx);
      return body === "png" ? lensPng(outcome as LensOutcome<ArrayBuffer>) : lensJson(outcome);
    },
  };
}

export function lensJson(o: LensOutcome<any>): Response {
  if (o.kind === "ok") {
    return jsonResponse(o.fromCache === undefined ? { ok: true, ...o.value } : { ok: true, ...o.value, fromCache: o.fromCache }, 200, policyHeaders(o.budgets));
  }
  if (o.kind === "failed") return jsonResponse(o.payload, o.status);
  return jsonResponse({ ok: false, error: o.error, ...o.extra }, o.status, refusalHeaders(o));
}

function refusalHeaders(o: LensOutcome<any>): Record<string, string> {
  if (o.kind !== "refused" || o.status !== 429 || !o.budget) return {};
  return rateLimitedHeaders(o.budget, LENS_BUDGETS[o.budget].max);
}

/** RateLimit-Policy for a served answer: one List member per budget the door
 *  bills (draft-ietf-httpapi-ratelimit-headers-11, section 3). */
export function policyHeaders(budgets: LensBudget[] | undefined): Record<string, string> {
  if (!budgets || budgets.length === 0) return {};
  return { "ratelimit-policy": budgets.map((b) => rateLimitPolicy(b, LENS_BUDGETS[b].max)).join(", ") };
}

export function lensPng(o: LensOutcome<ArrayBuffer>): Response {
  if (o.kind === "ok") return new Response(o.value, { headers: { ...lensPngHeaders(o.fromCache === true), ...policyHeaders(o.budgets) } });
  return lensJson(o);
}

export function lensStatusPayload(o: LensOutcome<any>): { status: number; payload: Record<string, unknown>; headers: Record<string, string> } {
  if (o.kind === "ok") return { status: 200, payload: o.value, headers: policyHeaders(o.budgets) };
  if (o.kind === "failed") return { status: o.status, payload: o.payload, headers: {} };
  return { status: o.status, payload: { ok: false, error: o.error, ...o.extra }, headers: refusalHeaders(o) };
}
