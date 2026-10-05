// lens-pipeline.ts: the one request pipeline every lens door runs through.
//
// Seventeen callers used to hand-copy the same steps: validate the target,
// check a precondition, read the KV cache, charge a per-IP budget and then the
// shared browser one, run, write the cache back. The copies drifted the way
// copies do. /lens/fetch?mode=cloudflare charged its budget BEFORE reading its
// cache, five routes read KV with no guard (a throw there is Cloudflare's HTML
// 1101 page, which the client then JSON.parses), the cache-hit flag was spelled
// three ways, and nine 429 messages quoted numbers nothing checked.
//
// `defineLens(spec)` owns all of that now. A spec says WHAT differs per lens:
// its budget, whether it spends Browser Run, its cache key and TTL, and its own
// `run`. The pipeline owns the ORDER, and the order is not configurable:
//
//   validate → args → browser precondition → cache read → own budget →
//   browserAll → run → cache write
//
// A cache hit returns before any budget is consulted, because the budgets exist
// to ration the work a hit does not do. The cache is fullest exactly when
// demand is highest, so charging a hit refuses readers hardest at the moment
// the Worker is already holding their answer (measured 2026-08-15, /lens/shot).
//
// The result is an OUTCOME, never a Response, because the callers answer in
// different shapes: a JSON route, a PNG, an 80-column terminal frame, an MCP
// tool result, and the SSR shell's status/payload pair. Each shape is an
// encoder over the same outcome (`lensJson` and `lensPng` here, `asFrame` in
// terminal.ts, `asToolResult` in lib/tools.ts), which is where the callers
// really differ and the only seam this module needed.
//
// What it deliberately does NOT wrap: KV and the rate limiter. Both are
// already reachable through `env` and both already have fakes in the contract
// suite, so a port in front of either would be a second name for the same
// thing. The guarded read lives HERE rather than in an adapter, so a fake KV
// that throws or returns garbage exercises the guard itself.
import { sha256Hex, validateLensTarget } from "./lib/public-fetch.ts";
import { overBudget } from "./lib/ratelimit.ts";
import { jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { asRecord, asText, isCallable } from "./lib/parse.ts";
import { hasRenderEngine } from "./lens-render.ts";
import type { Span } from "./lib/span-vocabulary.ts";

// ── budgets ────────────────────────────────────────────────────────────────

type LensBudgetDecl = {
  binding: string;
  max: number;
  // What the 429 calls the thing being rationed, plural: "Snapshots are…".
  label: string;
  // Why this ceiling is tighter than the ones beside it, said to the reader.
  why?: string;
  // Which other doors bill the same bucket, so a refusal at one door explains
  // why the other one also says no.
  shares?: string;
  // A fixed key makes the budget SHARED rather than per-caller.
  key?: string;
};

// Browser Run's FREE plan allows one Quick Action every 10 seconds ACCOUNT-WIDE
// (6/min), 3 concurrent browsers, and 10 minutes of browser time a day.
// Measured 2026-08-06: two Quick Actions ~2s apart, and the second came back
// 429. The per-IP ceilings below were written against no such limit. `shot`
// alone allowed 8/min to a SINGLE visitor, so one person could spend the whole
// account's minute and the next visitor got a failure that read like a bug.
//
// Every 429 the lens doors send is DERIVED from this table by budgetMessage().
// It used to be hand-typed at nine call sites, and the numbers in those strings
// were checked by nothing: the contract test pinned this table to the config,
// and the strings were a third copy. A contract test now fails on a literal
// "N/min" in a lens door.
export const LENS_BUDGETS = {
  inspect: { binding: "LENS_RL_INSPECT", max: 30, label: "Lens lookups", shares: "/lens/fetch, /mcp and the terminal tools" },
  shot:    { binding: "LENS_RL_SHOT",    max: 3,  label: "Snapshots" },
  compare: { binding: "LENS_RL_COMPARE", max: 4,  label: "Lens comparisons", shares: "/lens/compare and /mcp" },
  browser: { binding: "LENS_RL_BROWSER", max: 3,  label: "Browser Run snapshots" },
  wire:    { binding: "LENS_RL_WIRE",    max: 2,  label: "Wire traces" },
  tools:   { binding: "LENS_RL_TOOLS",   max: 10, label: "Catalogue reads" },
  // Tighter than the catalogue read it sits beside, and deliberately so: a
  // catalogue read costs a foreign server a lookup, and an /ask costs it a
  // retrieval and possibly a model call.
  nlweb:   { binding: "LENS_RL_NLWEB",   max: 4,  label: "NLWeb reads", why: "because each one asks somebody else's server a real question" },
  // Ten plain GETs of one URL per run, deduped by Accept string. No browser
  // and no model, so it is cheaper than the tabs above it on OUR side; what it
  // spends is somebody else's bandwidth, ten times over, on one page. Sat
  // between the catalogue read and the /ask question for that reason.
  markdown: { binding: "LENS_RL_MARKDOWN", max: 4, label: "Markdown checks", why: "because each one fetches the same page ten times from somebody else's origin" },
  // The shared ceiling. Keyed on a CONSTANT rather than the caller's IP, so
  // every browser-consuming route bills against one bucket and no single
  // visitor can spend the account's allowance.
  //
  // Honest about what this is: the Rate Limiting binding counts per COLO, so a
  // fixed key buys per-colo-global, not truly account-wide. Traffic spread over
  // N colos can still total N x max. That is a large improvement over per-IP and
  // is not a guarantee. The guarantee is the 429 handling in each browser run,
  // which treats an upstream refusal as a normal outcome rather than a fault.
  browserAll: { binding: "LENS_RL_BROWSER_ALL", max: 4, label: "The shared browser budget", key: "browser-run" },
} satisfies Record<string, LensBudgetDecl>;

export type LensBudget = keyof typeof LENS_BUDGETS;

// The one place a lens 429 is worded. The shared budget reads differently
// because it is not the reader's own allowance that ran out, and saying "you"
// to somebody who made one request would be wrong.
export function budgetMessage(name: LensBudget): string {
  const b: LensBudgetDecl = LENS_BUDGETS[name];
  if (b.key) return `${b.label} (${b.max}/min across every visitor) is spent for this minute. Try again shortly.`;
  const why = b.why ? `, ${b.why}` : "";
  const shares = b.shares ? `, shared with ${b.shares}` : "";
  return `${b.label} are rate-limited to ${b.max}/min${why}${shares}. Hang on a moment.`;
}

// ── shared helpers the lens modules used to import from lens.ts ────────────

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

// ── the interface ──────────────────────────────────────────────────────────

// The span names a cached lens owns. One name for a hit and a miss, differing
// on `lens.cache`, so a hit rate is a group-by rather than a join.
export type LensSpanName =
  | "lens.shot" | "lens.browser" | "lens.wire" | "lens.tools" | "lens.nlweb" | "lens.markdown";

// What `run` hands back. `ok: false` is a result the lens reached and does not
// want cached (a shut door, an unreadable origin, Browser Run refusing US),
// which is a different thing from the payload's own `ok`: the tools and nlweb
// lenses answer 200 with `ok: false` for a door that is shut, and that answer
// must not sit in KV for an hour.
export type LensRan<V> =
  | { ok: true; value: V; store?: unknown; outcome?: string }
  | { ok: false; status: number; payload: Record<string, unknown>; outcome: string };

export type LensOutcome<V> =
  | { kind: "ok"; value: V; fromCache?: boolean }
  | { kind: "failed"; status: number; payload: Record<string, unknown> }
  | {
      kind: "refused";
      status: 400 | 429 | 503;
      reason: "bad_target" | "unavailable" | "over_budget";
      error: string;
      budget?: LensBudget;
      extra?: Record<string, unknown>;
    };

// A 400 a spec's `args` step can raise after the target is valid (an unknown
// recipe id). A class rather than a shape, so a legitimate args value can never
// be mistaken for one.
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
  // Kept literal and greppable in KV; defineLens refuses a duplicate.
  prefix: `lens:${string}:`;
  ttl: number;
  // The string that is hashed into the key. Defaults to the (first) target
  // URL. Every input that changes the answer belongs here: keying nlweb on the
  // origin alone would serve one visitor's answer to another's question.
  key?: (target: T, args: A) => string;
  // Appended after the hash, unhashed, so a recipe run sits beside the plain
  // key it extends instead of replacing every key in one deploy.
  suffix?: (args: A) => string | null | undefined;
  // Whether a stored or about-to-be-stored entry may serve a hit. Checked on
  // read AND on write, so a failure shaped like a success cannot be cached.
  usable?: (entry: any) => boolean;
}

export interface LensSpec<In, T extends string | Record<string, string>, A, V> {
  span?: LensSpanName;
  budget: LensBudget;
  // Spends Browser Run. "render" is a Quick Action (either door counts),
  // "cdp" is a DevTools session on the binding. Either one adds the 503
  // precondition AND the shared browserAll budget, after the route's own.
  browser?: "render" | "cdp";
  // "png" stores raw bytes and answers an image; the default is JSON.
  body?: "json" | "png";
  targets: (input: In) => T;
  args?: (input: In, target: T) => A | LensArgsRefusal;
  cache?: LensCacheSpec<T, A>;
  run: (c: LensRunContext<T, A>) => Promise<LensRan<V>>;
  // How an unexpected throw from `run` reads. Defaults to a 502 that names it.
  onThrow?: (error: unknown) => { status: number; payload: Record<string, unknown> };
}

export interface Lens<In, V> {
  run(input: In, request: Request, env: any, ctx?: any): Promise<LensOutcome<V>>;
  // The JSON or PNG route, reading its input from the query string.
  handle(request: Request, env: any, ctx?: any): Promise<Response>;
}

// ── implementation ─────────────────────────────────────────────────────────

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
    // 1. Validate every target through the shared SSRF guard. A pair reports
    //    the label that failed, left before right.
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

    // 2. Arguments derived after the target is valid. Before the precondition
    //    on purpose, so a typo'd recipe answers the same 400 on a deployment
    //    with no Browser Run as on one with it.
    let args = undefined as A;
    if (spec.args) {
      const a = spec.args(input, target);
      if (a instanceof LensArgsRefusal) return refused(400, "bad_target", a.error, { extra: a.extra });
      args = a;
    }

    // 3. The engine has to exist before a cached render is worth serving.
    if (spec.browser && !browserReady(spec.browser, env)) return refused(503, "unavailable", NO_ENGINE);

    // 4. The cache. Any failure to read it is a miss, never the route's failure.
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
      catch { read = null; /* a corrupt or unreadable entry is a miss */ }
      const hit = read;
      if (hit !== null && usable(hit)) {
        return withSpan(spec.span, (s) => {
          s.setAttribute("lens.target_host", host);
          s.setAttribute("lens.cache", "hit");
          if (body === "png") s.setAttribute("lens.png_bytes", hit.byteLength);
          return { kind: "ok", value: hit as V, fromCache: true };
        });
      }
    }

    // 5. Budgets, own first. The shared ceiling comes second so a single heavy
    //    visitor is turned away by their own budget before spending everyone's.
    if (await overBudget(LENS_BUDGETS[spec.budget], request, env)) {
      return refused(429, "over_budget", budgetMessage(spec.budget), { budget: spec.budget });
    }
    if (spec.browser && await overBudget(LENS_BUDGETS.browserAll, request, env)) {
      return refused(429, "over_budget", budgetMessage("browserAll"), { budget: "browserAll" });
    }

    // 6. The work, then the write.
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
            // A cache write is never worth failing the read for. The IIFE calls
            // put synchronously, so a fake KV still sees it before this returns.
            const write = (async () => env.RN_KV.put(key, bytes, { expirationTtl: ttl }))().catch(() => {});
            if (ctx && isCallable(ctx.waitUntil)) ctx.waitUntil(write);
            else await write;
          }
        }
      }
      return { kind: "ok", value: ran.value, fromCache: spec.cache ? false : undefined };
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

// ── encoders ───────────────────────────────────────────────────────────────

// A cached lens says where its answer came from on every response, `true` or
// `false`, so a client never has to tell a missing field from a miss. An
// uncached lens never carries the field.
export function lensJson(o: LensOutcome<any>): Response {
  if (o.kind === "ok") {
    return jsonResponse(o.fromCache === undefined ? { ok: true, ...o.value } : { ok: true, ...o.value, fromCache: o.fromCache });
  }
  if (o.kind === "failed") return jsonResponse(o.payload, o.status);
  return jsonResponse({ ok: false, error: o.error, ...o.extra }, o.status);
}

// The PNG lens reports its cache state in a header, because the body is an
// image; every refusal or failure is still JSON.
export function lensPng(o: LensOutcome<ArrayBuffer>): Response {
  if (o.kind === "ok") return new Response(o.value, { headers: lensPngHeaders(o.fromCache === true) });
  return lensJson(o);
}

// The SSR shell and /lens/fetch answer a { status, payload } pair.
export function lensStatusPayload(o: LensOutcome<any>): { status: number; payload: Record<string, unknown> } {
  if (o.kind === "ok") return { status: 200, payload: o.value };
  if (o.kind === "failed") return { status: o.status, payload: o.payload };
  return { status: o.status, payload: { ok: false, error: o.error, ...o.extra } };
}
