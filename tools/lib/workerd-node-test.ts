// ── the slice of node:test the contract suite uses, for running it in workerd ──
//
// tools/test-workerd.ts aliases `node:test` to this file when it bundles the
// suite for workerd, which has no node:test. Tests register at import; the
// harness takes the queue with __take() and runs it with __run(). Each result
// carries the host-only packages the test touched (TOUCHED below), which is how
// the lane tells "needs a host process" from "behaves differently in workerd"
// without reading error text.
const KEY = Symbol.for("aadhar.sh/workerd-node-test");
export const TOUCHED = Symbol.for("aadhar.sh/workerd-host-touched");
const fresh = () => ({ tests: [], hooks: { before: [], after: [], beforeEach: [], afterEach: [] }, prefix: [] });
const state = (globalThis[KEY] ??= fresh());
const touched = (): Set<string> => (globalThis[TOUCHED] ??= new Set());

class SkipSignal extends Error {}

// node:test takes (name?, options?, fn): an argument that is a function is the body.
function norm(name, opts, fn) {
  if (name instanceof Function) return { name: name.name || "<anonymous>", opts: {}, fn: name };
  if (opts instanceof Function) return { name, opts: {}, fn: opts };
  return { name, opts: opts ?? {}, fn };
}

export function test(name, opts?, fn?) {
  const t = norm(name, opts, fn);
  state.tests.push({ ...t, name: [...state.prefix, t.name].join(" > ") });
  return Promise.resolve();
}
test.skip = (n, o?, f?) => {
  const t = norm(n, o, f);
  return test(t.name, { ...t.opts, skip: true }, t.fn);
};
test.todo = (n, o?, f?) => {
  const t = norm(n, o, f);
  return test(t.name, { ...t.opts, todo: true }, t.fn);
};
test.only = test;

export function describe(name, opts?, fn?) {
  const d = norm(name, opts, fn);
  if (d.opts.skip) return;
  state.prefix.push(d.name);
  try {
    const r = d.fn?.();
    if (r instanceof Promise) throw new Error("workerd node:test: async describe is not supported");
  } finally {
    state.prefix.pop();
  }
}
describe.skip = () => {};
export const it = test;
export const suite = describe;
export const before = (fn) => void state.hooks.before.push(fn);
export const after = (fn) => void state.hooks.after.push(fn);
export const beforeEach = (fn) => void state.hooks.beforeEach.push(fn);
export const afterEach = (fn) => void state.hooks.afterEach.push(fn);
export const mock = new Proxy(
  {},
  {
    get(_, k) {
      throw new Error(`workerd node:test: mock.${String(k)} is not implemented`);
    },
  },
);
Object.assign(test, { test, describe, it, suite, before, after, beforeEach, afterEach, mock });
export default test;

export function __take() {
  const { tests, hooks } = state;
  Object.assign(state, fresh());
  return { tests, hooks };
}

/** Host packages touched outside any test (at import), then cleared. */
export function __takeTouched(): string[] {
  const out = [...touched()];
  touched().clear();
  return out;
}

const withTimeout = (p, ms, what) => {
  let id;
  const timer = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(`workerd node:test: ${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(id));
};

interface Result {
  name: string;
  status: "pass" | "fail" | "skip";
  error?: string;
  ms: number;
  touched: string[];
}

const errText = (e) => (e && e.stack ? String(e.stack) : String(e));

async function runOne(name, opts, fn, defaultTimeout, hooks): Promise<Result[]> {
  if (opts.skip || opts.todo) return [{ name, status: "skip", ms: 0, touched: [] }];
  touched().clear();
  const afters: Array<() => unknown> = [];
  const subresults: Result[] = [];
  const ac = new AbortController();
  const ctx = {
    name,
    signal: ac.signal,
    after: (f) => void afters.push(f),
    before: () => {},
    beforeEach: () => {},
    afterEach: () => {},
    skip: (msg) => {
      throw new SkipSignal(msg ?? "skipped");
    },
    todo: () => {},
    diagnostic: () => {},
    plan: () => {},
    mock,
    test: async (n, o, f) => {
      const t = norm(n, o, f);
      subresults.push(...(await runOne(`${name} > ${t.name}`, t.opts, t.fn, defaultTimeout, { beforeEach: [], afterEach: [] })));
    },
  };
  const t0 = performance.now();
  let status: Result["status"] = "pass";
  let error;
  try {
    for (const h of hooks.beforeEach) await h(ctx);
    const body =
      fn.length >= 2
        ? new Promise<void>((resolve, reject) => {
            fn(ctx, (err) => (err ? reject(err) : resolve()));
          })
        : Promise.resolve().then(() => fn(ctx));
    await withTimeout(body, opts.timeout ?? defaultTimeout, `test "${name}"`);
    for (const h of hooks.afterEach) await h(ctx);
  } catch (e) {
    if (e instanceof SkipSignal) status = "skip";
    else {
      status = "fail";
      error = errText(e);
    }
  } finally {
    ac.abort();
    for (const f of afters.reverse()) {
      try {
        await f();
      } catch (e) {
        if (status !== "fail") {
          status = "fail";
          error = "after hook: " + errText(e);
        }
      }
    }
  }
  if (subresults.some((r) => r.status === "fail") && status === "pass") {
    status = "fail";
    error = "a subtest failed";
  }
  const mine: Result = { name, status, error, ms: Math.round(performance.now() - t0), touched: [...touched()] };
  return [mine, ...subresults];
}

export async function __run({ tests, hooks }, defaultTimeout: number): Promise<Result[]> {
  const results: Result[] = [];
  try {
    for (const h of hooks.before) await h();
  } catch (e) {
    return tests.map((t) => ({ name: t.name, status: "fail", error: "before hook: " + errText(e), ms: 0, touched: [] }));
  }
  for (const t of tests) results.push(...(await runOne(t.name, t.opts, t.fn, defaultTimeout, hooks)));
  for (const h of hooks.after) {
    try {
      await h();
    } catch (e) {
      results.push({ name: "<after hook>", status: "fail", error: errText(e), ms: 0, touched: [] });
    }
  }
  return results;
}
