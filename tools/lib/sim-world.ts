// sim-world.ts: one seeded world for the site Worker, its Counter Durable
// Object and KV, in the FoundationDB and TigerBeetle style. tools/sim.ts drives
// it; this file owns every source of nondeterminism a request can touch, so a
// run replays exactly from (seed, events).
//
// What it replaces, and where the real thing would differ:
//   clock        Date, performance.now, setTimeout, AbortSignal.timeout,
//                scheduler.wait all read one simulated clock in ms.
//   randomness   Math.random, crypto.getRandomValues, crypto.randomUUID draw
//                from the seeded generator. crypto.subtle is left real: the
//                Worker only uses its deterministic parts without secrets.
//   network      globalThis.fetch is a pending op the scheduler completes in
//                seeded order. Any host answers a small canned page; the
//                Worker's own host refuses, as production's error 1042 does.
//   KV, Cache    in-memory, each read and write a pending op. KV refuses a
//                second put to one key inside 1 s with 429, as production does.
//   Counter DO   the real class from counter/src/counter.ts over an in-memory
//                storage. One request holds the object at a time, which is
//                what input gates give a class that awaits only storage. The
//                reply travels back as its own op, so a restart can land
//                after the write committed and before the caller hears.
//   budget       every fetch, KV, Cache, R2, D1 and DO call counts against 50
//                per invocation, the Workers Free figure CLAUDE.md gives; the
//                51st throws the runtime's "Too many subrequests." error.
// Not modeled: CPU time and its clamps, isolate eviction of module state
// (each run is one fresh process instead), KV's cross-colo staleness beyond
// the one-shot `kv-stale` fault, and D1, R2, Browser, AI and Images beyond
// "answers empty".

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export const SUBREQUEST_CAP = 50;
const KV_PUT_SPACING_MS = 1000;
const KV_TYPES = ["text", "json", "arrayBuffer", "stream"] as const;
const WAITUNTIL_GRACE_MS = 30_000;
const HANG_RELEASE_MS = 30_000;

// ── seeded generator: splitmix32, small and good enough for scheduling ──────
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  return {
    u32: next,
    float: () => next() / 2 ** 32,
    int: (lo: number, hi: number) => lo + (next() % (hi - lo + 1)),
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error("pick from an empty list");
      return xs[next() % xs.length];
    },
  };
}
export type Rng = ReturnType<typeof rng>;

// ── invocations and faults ──────────────────────────────────────────────────
export type FaultKind = "fetch-drop" | "fetch-hang" | "kv-miss" | "kv-stale" | "kv-error" | "do-lost-reply" | "cap";
export const FAULT_KINDS: readonly FaultKind[] = ["fetch-drop", "fetch-hang", "kv-miss", "kv-stale", "kv-error", "do-lost-reply", "cap"];

export interface Invocation {
  id: number;
  label: string;
  startedAt: number;
  subrequests: number;
  cap: number;
  overCap: string[];
  faults: string[];
  tails: Promise<unknown>[];
  tailErrors: string[];
  /** How far this invocation moved each Counter instance's count. */
  increments: Map<string, number>;
  respondedAt: number | null;
  status: number | null;
  error: string | null;
  done: boolean;
}

interface Op {
  id: number;
  inv: Invocation | null;
  label: string;
  ready: () => boolean;
  complete: () => void;
  fail: (error: unknown) => void;
  hungUntil?: number;
}

export interface World {
  seed: number;
  rand: Rng;
  now: () => number;
  trace: string[];
  log: (line: string) => void;
  als: AsyncLocalStorage<Invocation>;
  env: Record<string, unknown>;
  invocations: Invocation[];
  pending: Op[];
  timers: Map<number, { at: number; fn: () => void }>;
  armed: FaultKind[];
  counterValue: (name: string) => number;
  kvValue: (key: string) => string | null;
  restartObjects: () => number;
  newInvocation: (label: string) => Invocation;
  findings: string[];
  step: (maxOps: number) => Promise<number>;
  advance: (ms: number) => Promise<void>;
  settle: () => Promise<void>;
}

// The real setImmediate, captured before anything patches globals: settling
// microtasks and Bun's own native promise work needs a real turn of the loop.
const realSetImmediate = globalThis.setImmediate;
const yieldReal = () =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });
const realSetTimeout = globalThis.setTimeout;
const sleepReal = (ms: number) =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

export function createWorld(seed: number, root: string) {
  const rand = rng(seed);
  let clock = Date.UTC(2026, 10, 21, 12, 0, 0);
  const clockStart = clock;
  const trace: string[] = [];
  const log = (line: string) => trace.push(`${clock - clockStart} ${line}`);
  const als = new AsyncLocalStorage<Invocation>();
  const pending: Op[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  const invocations: Invocation[] = [];
  const findings: string[] = [];
  const armed: FaultKind[] = [];
  let nextOp = 1;
  let nextTimer = 1;
  // Body reads the fakes start before an op exists. quiesce waits for these to
  // reach 0, because a big body can take more real turns than its heuristic.
  let inflight = 0;
  const tracked = <T>(p: Promise<T>): Promise<T> => {
    inflight += 1;
    return p.finally(() => {
      inflight -= 1;
    });
  };

  // ── globals ────────────────────────────────────────────────────────────────
  const RealDate = Date;
  class SimDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(clock);
      else super(...(args as [string]));
    }
    static now() {
      return clock;
    }
  }
  globalThis.Date = SimDate as DateConstructor;
  Object.defineProperty(performance, "now", { value: () => clock - clockStart, configurable: true });
  Math.random = () => rand.float();
  crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = rand.u32() & 0xff;
    }
    return array;
  };
  crypto.randomUUID = (): ReturnType<Crypto["randomUUID"]> => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const simTimeout = (fn: () => void, ms = 0) => {
    const id = nextTimer++;
    timers.set(id, { at: clock + Math.max(0, Number(ms) || 0), fn });
    const handle = { id, unref: () => handle, ref: () => handle, hasRef: () => true, refresh: () => handle, [Symbol.toPrimitive]: () => id };
    return handle;
  };
  // Only simTimeout's own handles ever come back here.
  const clearSim = (handle: { id: number } | null | undefined) => {
    if (handle) timers.delete(handle.id);
  };
  const g = globalThis as Record<string, unknown>;
  g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => simTimeout(() => fn(...args), ms);
  g.clearTimeout = clearSim;
  g.setInterval = () => {
    throw new Error("sim: setInterval has no bound; the Worker never calls it");
  };
  g.scheduler = {
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        simTimeout(resolve, ms);
      }),
  };
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    simTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  };

  // crypto.subtle runs on Bun's native thread pool, so its promises settle
  // in real time. Tracking them is what lets quiesce wait for each one.
  for (const method of ["digest", "sign", "verify", "importKey", "exportKey", "getPublicKey"] as const) {
    const subtle = crypto.subtle as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
    const original = subtle[method]?.bind(crypto.subtle);
    if (original) Object.defineProperty(crypto.subtle, method, { value: (...args: unknown[]) => tracked(original(...args)), configurable: true });
  }

  // ── the op queue ───────────────────────────────────────────────────────────
  const takeFault = (kinds: FaultKind[]): FaultKind | null => {
    const index = armed.findIndex((k) => kinds.includes(k));
    if (index < 0) return null;
    return armed.splice(index, 1)[0];
  };
  const charge = (inv: Invocation | null, what: string) => {
    if (!inv) return;
    inv.subrequests += 1;
    if (inv.subrequests > inv.cap) {
      inv.overCap.push(what);
      throw new Error("Too many subrequests.");
    }
  };
  function op<T>(
    label: string,
    run: (inv: Invocation | null) => T | Promise<T>,
    opts: { signal?: AbortSignal | null; ready?: () => boolean; hang?: boolean; charge?: boolean } = {},
  ): Promise<T> {
    const inv = als.getStore() ?? null;
    if (opts.charge !== false) charge(inv, label);
    return new Promise<T>((resolve, reject) => {
      const entry: Op = {
        id: nextOp++,
        inv,
        label,
        ready: opts.ready ?? (() => true),
        complete: () => {
          try {
            resolve(run(inv));
          } catch (error) {
            reject(error);
          }
        },
        fail: reject,
      };
      if (opts.hang) {
        entry.hungUntil = clock + HANG_RELEASE_MS;
        entry.ready = () => clock >= (entry.hungUntil ?? 0);
        entry.complete = () => {
          if (!opts.signal) findings.push(`unbounded wait: ${label} hung ${HANG_RELEASE_MS} ms with no AbortSignal (invocation ${inv?.label ?? "?"})`);
          reject(new TypeError("Network connection lost."));
        };
      }
      const signal = opts.signal;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
          log(`abort op${entry.id} ${label}`);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        });
      }
      if (process.env.SIM_TRACE_NEW) log(`new op${entry.id} ${label}`);
      pending.push(entry);
    });
  }

  // ── KV ───────────────────────────────────────────────────────────────────
  const kvStores = new Map<string, Map<string, { value: string; metadata: unknown; prev: { value: string; metadata: unknown } | null; putAt: number }>>();
  function kvNamespace(name: string) {
    const store = new Map<string, { value: string; metadata: unknown; prev: { value: string; metadata: unknown } | null; putAt: number }>();
    kvStores.set(name, store);
    const decode = (value: string | null, type: unknown) => {
      if (value === null) return null;
      // KV takes the type bare ("json") or in an options object ({ type: "json" }).
      const t = KV_TYPES.find((name) => type === name || Reflect.get(Object(type), "type") === name);
      if (t === "json") return JSON.parse(value);
      if (t === "arrayBuffer") return new TextEncoder().encode(value).buffer;
      if (t === "stream") return new Response(value).body;
      return value;
    };
    const read = (key: string | string[], type: unknown, withMeta: boolean) =>
      op(`kv.${name}.get ${[key].flat().join(",")}`, (inv) => {
        const fault = takeFault(["kv-miss", "kv-stale", "kv-error"]);
        if (fault) {
          inv?.faults.push(fault);
          log(`fault ${fault} kv.${name} ${[key].flat().join(",")}`);
        }
        if (fault === "kv-error") throw new Error(`KV GET failed: 500 Internal Server Error`);
        const one = (k: string) => {
          let entry: { value: string; metadata: unknown } | null = store.get(k) ?? null;
          if (fault === "kv-miss") entry = null;
          if (fault === "kv-stale") entry = store.get(k)?.prev ?? null;
          const value = decode(entry?.value ?? null, type);
          return withMeta ? { value, metadata: entry?.metadata ?? null, cacheStatus: null } : value;
        };
        // A bulk read (an array of keys) answers a Map, as KV does.
        return Array.isArray(key) ? new Map(key.map((k) => [k, one(k)])) : one(key);
      });
    return {
      get: (key: string, type?: unknown) => read(key, type, false),
      getWithMetadata: (key: string, type?: unknown) => read(key, type, true),
      put: async (key: string, value: BodyInit, opts?: { metadata?: unknown; expirationTtl?: number }) => {
        // Every value KV takes is also a body, so Response reads them all.
        const text = await tracked(new Response(value).text());
        return op(`kv.${name}.put ${key}`, (inv) => {
          const fault = takeFault(["kv-error"]);
          if (fault) {
            inv?.faults.push(fault);
            log(`fault ${fault} kv.${name}.put ${key}`);
            throw new Error("KV PUT failed: 500 Internal Server Error");
          }
          const old = store.get(key);
          if (old && clock - old.putAt < KV_PUT_SPACING_MS) throw new Error("KV PUT failed: 429 Too Many Requests");
          store.set(key, { value: text, metadata: opts?.metadata ?? null, prev: old ? { value: old.value, metadata: old.metadata } : null, putAt: clock });
          return undefined;
        });
      },
      delete: (key: string) =>
        op(`kv.${name}.delete ${key}`, () => {
          store.delete(key);
          return undefined;
        }),
      list: (opts: { prefix?: string; limit?: number } = {}) =>
        op(`kv.${name}.list ${opts.prefix ?? ""}`, () => {
          const keys = [...store.keys()]
            .filter((k) => k.startsWith(opts.prefix ?? ""))
            .sort()
            .slice(0, opts.limit ?? 1000)
            .map((k) => ({ name: k, metadata: store.get(k)?.metadata ?? undefined }));
          return { keys, list_complete: true, cursor: "", cacheStatus: null };
        }),
    };
  }

  // ── the Counter Durable Object ─────────────────────────────────────────────
  type CounterClass = new (state: unknown) => { fetch: (request: Request) => Promise<Response> };
  let CounterImpl: CounterClass | null = null;
  const objects = new Map<
    string,
    { storage: Map<string, unknown>; instance: { fetch: (r: Request) => Promise<Response> } | null; busy: boolean; epoch: number }
  >();
  const objectFor = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      o = { storage: new Map(), instance: null, busy: false, epoch: 0 };
      objects.set(name, o);
    }
    return o;
  };
  const storageApi = (storage: Map<string, unknown>) => ({
    get: async (key: string | string[]) =>
      Array.isArray(key) ? new Map(key.filter((k) => storage.has(k)).map((k) => [k, structuredClone(storage.get(k))])) : structuredClone(storage.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (key instanceof Object) for (const [k, v] of Object.entries(key)) storage.set(k, structuredClone(v));
      else storage.set(key, structuredClone(value));
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) return key.filter((k) => storage.delete(k)).length;
      return storage.delete(key);
    },
    list: async () => new Map([...storage.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    transaction: async (fn: (txn: unknown) => Promise<unknown>) => fn(storageApi(storage)),
  });
  const counterNamespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get(id: { name: string }) {
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const o = objectFor(id.name);
          const label = `do.${id.name} ${new URL(request.url).pathname}${new URL(request.url).search}`;
          const delivered = op<{ response: Response; epoch: number }>(
            label,
            (inv) => {
              if (!CounterImpl) throw new Error("sim: Counter class not loaded");
              o.instance ??= new CounterImpl({ storage: storageApi(o.storage) });
              o.busy = true;
              const epoch = o.epoch;
              const before = Number(o.storage.get("n") ?? 0);
              return o.instance
                .fetch(request)
                .then(async (response) => {
                  // Which visit moved the count, for the per-visit oracle.
                  const delta = Number(o.storage.get("n") ?? 0) - before;
                  if (inv && delta !== 0) inv.increments.set(id.name, (inv.increments.get(id.name) ?? 0) + delta);
                  return { response: new Response(await tracked(response.text()), response), epoch };
                })
                .finally(() => {
                  o.busy = false;
                });
            },
            { ready: () => !o.busy },
          );
          return delivered.then(({ response, epoch }) =>
            op(
              `${label} reply`,
              (inv) => {
                if (o.epoch !== epoch) {
                  inv?.faults.push("do-restart");
                  throw new Error("Durable Object reset because its code was updated.");
                }
                const fault = takeFault(["do-lost-reply"]);
                if (fault) {
                  inv?.faults.push(fault);
                  log(`fault ${fault} ${label}`);
                  throw new Error("Network connection lost.");
                }
                return response;
              },
              { charge: false },
            ),
          );
        },
      };
    },
  };
  const restartObjects = () => {
    for (const o of objects.values()) {
      o.instance = null;
      o.epoch += 1;
    }
    return objects.size;
  };

  // ── outbound fetch ─────────────────────────────────────────────────────────
  const ownHosts = new Set(["aadhar.sh", "www.aadhar.sh", "cal.aadhar.sh"]);
  g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const fault = takeFault(["fetch-drop", "fetch-hang"]);
    const inv = als.getStore() ?? null;
    if (fault) {
      inv?.faults.push(fault);
      log(`fault ${fault} fetch ${url.host}${url.pathname}`);
    }
    return op(
      `fetch ${request.method} ${url.host}${url.pathname}`,
      () => {
        if (fault === "fetch-drop") throw new TypeError("Network connection lost.");
        if (ownHosts.has(url.hostname)) return new Response("error code: 1042", { status: 403 });
        const json = url.pathname.endsWith(".json") || url.hostname.startsWith("api.") || /json/.test(request.headers.get("accept") ?? "");
        return json
          ? Response.json({})
          : new Response("<!doctype html><html><head><title>sim</title></head><body><p>sim</p></body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
      },
      { signal: request.signal ?? init?.signal ?? null, hang: fault === "fetch-hang" },
    );
  };

  // ── Cache API ──────────────────────────────────────────────────────────────
  const cacheStore = new Map<string, { body: string; init: ResponseInit }>();
  const cache = {
    match: (key: RequestInfo | URL) =>
      op(`cache.match`, () => {
        const hit = cacheStore.get(new Request(key).url);
        return hit ? new Response(hit.body, hit.init) : undefined;
      }),
    put: async (key: RequestInfo | URL, response: Response) => {
      const body = await tracked(response.text());
      const init = { status: response.status, headers: [...response.headers] };
      return op(`cache.put`, () => {
        cacheStore.set(new Request(key).url, { body, init });
        return undefined;
      });
    },
    delete: (key: RequestInfo | URL) => op(`cache.delete`, () => cacheStore.delete(new Request(key).url)),
  };
  g.caches = { default: cache, open: async () => cache };

  // ── static assets: public/ then src/pages/, at their served paths ─────────
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".xml": "application/xml",
  };
  const assetPath = (pathname: string) => {
    for (const dir of ["public", "src/pages"]) {
      for (const candidate of [pathname, pathname + ".html", join(pathname, "index.html")]) {
        const file = join(root, dir, candidate);
        if (existsSync(file) && statSync(file).isFile()) return file;
      }
    }
    return null;
  };
  const assets = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      return op(
        `assets ${url.pathname}`,
        () => {
          const file = assetPath(decodeURIComponent(url.pathname));
          if (!file) return new Response("Not Found", { status: 404 });
          return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
        },
        { charge: false },
      );
    },
  };

  // ── everything else answers empty ──────────────────────────────────────────
  const d1 = (name: string) => {
    const statement = (sql: string) => {
      const s = {
        bind: () => s,
        all: () => op(`d1.${name} ${sql.slice(0, 32)}`, () => ({ results: [], success: true, meta: {} })),
        first: () => op(`d1.${name} ${sql.slice(0, 32)}`, () => null),
        run: () => op(`d1.${name} ${sql.slice(0, 32)}`, () => ({ results: [], success: true, meta: { changes: 0 } })),
        raw: () => op(`d1.${name} ${sql.slice(0, 32)}`, () => []),
      };
      return s;
    };
    return {
      prepare: statement,
      batch: (stmts: unknown[]) => op(`d1.${name} batch`, () => stmts.map(() => ({ results: [], success: true, meta: {} }))),
      exec: () => op(`d1.${name} exec`, () => ({ count: 0 })),
    };
  };
  const analytics = (name: string) => ({ writeDataPoint: (point: unknown) => log(`ae.${name} ${JSON.stringify(point).slice(0, 80)}`) });
  const rateLimit = { limit: async () => ({ success: true }) };
  const r2 = {
    get: () => op("r2.get", () => null),
    head: () => op("r2.head", () => null),
    put: () => op("r2.put", () => null),
    list: () => op("r2.list", () => ({ objects: [], truncated: false })),
    delete: () => op("r2.delete", () => undefined),
  };
  const workflow = {
    create: (opts: { id?: string } = {}) => op("workflow.create", () => ({ id: opts.id ?? crypto.randomUUID() })),
    get: () => op("workflow.get", () => ({ status: async () => ({ status: "complete" }) })),
  };

  const env: Record<string, unknown> = {
    RN_KV: kvNamespace("RN_KV"),
    BOOKINGS: kvNamespace("BOOKINGS"),
    PHOTOS_R2: r2,
    RESTORE_DB: d1("RESTORE_DB"),
    SERENDIPITY_DB: d1("SERENDIPITY_DB"),
    SOCIAL_DB: d1("SOCIAL_DB"),
    ANALYTICS: { sql: () => op("analytics.sql", () => ({ data: [] })) },
    COUNTER: counterNamespace,
    ASSETS: assets,
    BOOKING_WORKFLOW: workflow,
    CENSUS_WORKFLOW: workflow,
    CF_VERSION_METADATA: { id: "sim-version", tag: "", timestamp: new RealDate(clockStart).toISOString() },
    CF_ACCOUNT_ID: "sim",
    AI_GATEWAY: "",
    HOST_TIMEZONE: "America/New_York",
    WORKING_HOURS_START: "10",
    WORKING_HOURS_END: "17",
    WORKING_DAYS: "1,2,3,4,5",
    SLOT_MINUTES: "30",
    BUFFER_MINUTES: "15",
    MIN_NOTICE_HOURS: "24",
    MAX_LOOKAHEAD_DAYS: "21",
    DAILY_LIMIT: "2",
    WEEKLY_LIMIT: "6",
    HOST_NAME: "Sim Host",
    HOST_EMAIL: "host@sim.invalid",
    HOST_PUBLIC_URL: "https://aadhar.sh",
    EVENT_TITLE: "Coffee",
    PENDING_TTL_DAYS: "3",
  };
  for (const name of ["BOT_LEDGER", "SPECULATION", "PERF_PROBE", "MISS_LEDGER", "VITALS"]) env[name] = analytics(name);
  for (const name of [
    "LENS_RL_INSPECT",
    "LENS_RL_SHOT",
    "LENS_RL_COMPARE",
    "LENS_RL_BROWSER",
    "LENS_RL_BROWSER_ALL",
    "LENS_RL_WIRE",
    "LENS_RL_TOOLS",
    "LENS_RL_NLWEB",
    "LENS_RL_MARKDOWN",
    "MCP_RL_IMAGE_INSPECT",
    "MCP_RL_IMAGE_TRANSFORM",
    "MCP_RL_IMAGE_COMPARE",
    "MCP_RL_REPR_CAPTURE",
    "MCP_RL_REPR_COMPARE",
    "WEBMENTION_RL",
    "PIXEL_PEEPER_RL",
    "GUESTBOOK_RL",
    "ASK_RL",
    "API_RL",
  ])
    env[name] = rateLimit;

  // ── stepping ───────────────────────────────────────────────────────────────
  // Let microtasks and Bun's native promise work run until the op queue stops
  // changing. Three quiet turns in a row is a heuristic; the trace-hash check
  // in tools/sim.ts is what says whether it held.
  const quiesce = async () => {
    let quiet = 0;
    let last = -1;
    for (let turn = 0; turn < 10_000 && (quiet < 3 || inflight > 0); turn++) {
      if (inflight > 0) await sleepReal(0);
      else await yieldReal();
      const sig = pending.length * 1_000_003 + nextOp;
      if (sig === last && inflight === 0) quiet += 1;
      else quiet = 0;
      last = sig;
    }
    if (inflight > 0) throw new Error(`sim: ${inflight} tracked native promises never settled`);
  };
  // Before time jumps or the queue reads empty: Bun runs some body work
  // (DecompressionStream, tee) on native threads that finish in real
  // milliseconds, past any number of setImmediate turns. Wait real time until
  // nothing changes for 3 rounds of 2 ms.
  const deepQuiesce = async () => {
    let quiet = 0;
    let last = -1;
    for (let round = 0; round < 500 && quiet < 3; round++) {
      await sleepReal(2);
      await quiesce();
      const sig = pending.length * 1_000_003 + nextOp;
      if (sig === last) quiet += 1;
      else quiet = 0;
      last = sig;
    }
  };
  const fireTimers = () => {
    const due = [...timers.entries()].filter(([, t]) => t.at <= clock).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
    return due.length;
  };
  const closeOut = () => {
    for (const inv of invocations) {
      if (inv.done || inv.respondedAt === null) continue;
      if (clock - inv.respondedAt > WAITUNTIL_GRACE_MS) {
        inv.done = true;
        inv.tailErrors.push(`waitUntil still running ${WAITUNTIL_GRACE_MS} ms after the response; the runtime cancels it`);
        log(`inv${inv.id} cut off`);
      }
    }
  };
  const step = async (maxOps: number) => {
    let ran = 0;
    for (; ran < maxOps; ran++) {
      let ready = pending.filter((p) => p.ready());
      // Only an open invocation with no op in the queue can be inside native
      // work; with none, the queue is truly empty and the wait is skipped.
      if (ready.length === 0 && invocations.some((i) => !i.done && !pending.some((p) => p.inv === i))) {
        await deepQuiesce();
        ready = pending.filter((p) => p.ready());
      }
      if (ready.length === 0) break;
      const chosen = rand.pick(ready);
      pending.splice(pending.indexOf(chosen), 1);
      clock += rand.int(0, 20);
      fireTimers();
      log(`op${chosen.id} ${chosen.inv ? `inv${chosen.inv.id}` : "-"} ${chosen.label}`);
      chosen.complete();
      await quiesce();
    }
    closeOut();
    return ran;
  };
  // Every op takes at most 20 ms, so a clock jump longer than that first lets
  // each ready op finish, in seeded order, before time moves past it.
  const advance = async (ms: number) => {
    const target = clock + ms;
    while (true) {
      while (clock < target && (await step(1)) > 0);
      const next = Math.min(...[...timers.values()].map((t) => t.at), ...pending.filter((p) => p.hungUntil !== undefined).map((p) => p.hungUntil ?? Infinity));
      if (!(next <= target)) break;
      clock = Math.max(clock, next);
      fireTimers();
      await quiesce();
    }
    clock = target;
    fireTimers();
    await quiesce();
    closeOut();
  };
  // Drain: run every op, then jump the clock to the next timer or hang, until
  // nothing is left or the bound trips.
  const settle = async () => {
    for (let round = 0; round < 10_000; round++) {
      if ((await step(1_000)) > 0) continue;
      const open = invocations.some((i) => !i.done);
      const nextAt = Math.min(...[...timers.values()].map((t) => t.at), ...pending.map((p) => p.hungUntil ?? Infinity));
      if (Number.isFinite(nextAt)) {
        await advance(Math.max(0, nextAt - clock));
        continue;
      }
      if (open) {
        await advance(WAITUNTIL_GRACE_MS + 1);
        if (invocations.some((i) => !i.done && i.respondedAt !== null)) continue;
      }
      return;
    }
    throw new Error("sim: settle did not converge in 10,000 rounds");
  };

  let nextInv = 1;
  const world: World = {
    seed,
    rand,
    now: () => clock,
    trace,
    log,
    als,
    env,
    invocations,
    pending,
    timers,
    armed,
    findings,
    counterValue: (name) => Number(objects.get(name)?.storage.get("n") ?? 0),
    kvValue: (key) => kvStores.get("RN_KV")?.get(key)?.value ?? null,
    restartObjects,
    newInvocation: (label) => {
      const inv: Invocation = {
        id: nextInv++,
        label,
        startedAt: clock,
        subrequests: 0,
        cap: SUBREQUEST_CAP,
        overCap: [],
        faults: [],
        tails: [],
        tailErrors: [],
        increments: new Map(),
        respondedAt: null,
        status: null,
        error: null,
        done: false,
      };
      const fault = takeFault(["cap"]);
      if (fault) {
        inv.cap = rand.int(0, 8);
        inv.faults.push(`cap=${inv.cap}`);
        log(`fault cap inv${inv.id} cap=${inv.cap}`);
      }
      invocations.push(inv);
      return inv;
    },
    step,
    advance,
    settle,
  };
  return Object.assign(world, {
    loadCounter: (impl: CounterClass) => {
      CounterImpl = impl;
    },
  });
}
