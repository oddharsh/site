// trace.js — cal's own span helper over Workers Traces.
//
// DELIBERATELY a near-duplicate of src/worker/lib/trace.ts, and not a
// shared import. The dependency direction in this repo runs www -> cal:
// _worker.js/index.js imports cal/src/index.js to serve /coffee, and
// cal/wrangler.test.toml boots the Vitest pool from cal/src/index.js alone. An
// import pointing back at public/ would make cal untestable without the site
// tree around it, which is the one property cal/ is organized to keep. Twenty
// lines of duplication is the cheaper side of that trade — please don't
// "consolidate" these two files.
//
// Same injection design as the www copy, for the same reason: no
// `cloudflare:workers` import here, because contract-tests.mjs pulls
// cal/src/slots.js (and through it availability.js, and through that this file)
// into PLAIN NODE, whose ESM loader rejects the `cloudflare:` scheme at link
// time. src/worker/index.js installs the real tracer at init.
//
// Under cal's own Vitest pool nothing installs it, so cal's spans are inert in
// its unit tests. That is correct: those tests assert booking policy, not
// telemetry, and fetchBusySWR is legitimately called with a null ctx there.

let tracing = null;

export function installTracing(candidate) {
  // cal cannot import src/worker/lib/parse.ts: its Vitest pool boots from
  // cal/src/index.js alone, so that edge would make cal untestable without the
  // site tree. This file is already a deliberate duplicate for that same reason
  // (gotcha 16), and one capability check does not earn a second parse layer.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  tracing = typeof candidate?.enterSpan === "function" ? candidate : null;
}

const INERT = Object.freeze({
  setAttribute() {},
  end() {},
  isTraced: false,
});

export function span(name, fn, attrs) {
  const t = tracing;
  if (!t) return fn(INERT);
  return t.enterSpan(name, (s) => {
    if (attrs) {
      for (const key in attrs) {
        const value = attrs[key];
        if (value !== undefined) s.setAttribute(key, value);
      }
    }
    return fn(s);
  });
}
