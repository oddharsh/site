// trace.js — one wrapper over Workers Traces so every span in this worker has a
import { isCallable } from "./parse.js";
// single import site and a single failure story. Bundled by wrangler at deploy;
// not served.
//
// WHY THE TRACER IS INJECTED RATHER THAN IMPORTED HERE. This module does NOT
// `import { tracing } from "cloudflare:workers"`, and that is load-bearing:
// contract-tests.mjs imports around.js, webmention-send.js, photos.js, and a
// dozen other worker modules directly under PLAIN NODE, whose ESM loader rejects
// the `cloudflare:` scheme at link time with ERR_UNSUPPORTED_ESM_URL_SCHEME. A
// static import here would take the whole suite down at import, before a single
// assertion ran — which is exactly why counter.js hand-rolls its Durable Object
// instead of importing the base class. So the runtime's tracer is handed in by
// _worker.js/index.js (the one module only workerd ever loads) at module-scope
// init, which happens before any handler can run. Under node it is never
// installed, `tracing` stays null, and every span degrades to a direct call.
//
// The wrapper also earns its keep on:
//   1. FAIL-SOFT, IN ONE PLACE. `wrangler dev` and the Vitest pool both expose
//      the API and report `span.isTraced === false` — verified 2026-07-29 at
//      compatibility_date 2026-06-01, where the calls succeed and record
//      nothing. Instrumentation must never be why dev diverges from prod.
//   2. ATTRIBUTES AT OPEN. Nearly every span wants an attribute or two set
//      before the body runs. `attrs` keeps that metadata next to the span name.
//   3. NAMING. Span names are a flat global namespace in the dashboard, so they
//      are worth holding to one convention: `<surface>.<phase>`, lowercase and
//      dot-separated (`home.grid.manifest`, `lens.discovery`, `cron.around`).
//      The dispatcher's own spans are the deliberate exception — they are named
//      `route <template>` so a trace tree reads as a route, not a slug.
//
// What this deliberately does NOT do: wrap the callback in try/catch. A span
// that fails to open must not swallow the error or re-run the work — several of
// these callbacks write KV, so a silent retry is strictly worse than an untraced
// request. Errors propagate; the span records them and ends.
//
// Attribute discipline matches the photo pipeline's: an attribute whose value is
// undefined is SKIPPED, never fabricated. A span that says nothing about a
// dimension is honest; one that says 0 or "unknown" is a lie you later read as
// data.

let tracing = null;

// Called once from _worker.js/index.js with the `tracing` export of
// cloudflare:workers. Anything without a usable enterSpan is rejected, so a
// runtime that drops or renames the export leaves spans inert rather than
// throwing on every request.
export function installTracing(candidate) {
  tracing = isCallable(candidate?.enterSpan) ? candidate : null;
}

// Stand-in span for the not-installed case, so callbacks can always assume the
// argument is there and call setAttribute on it unconditionally.
const INERT = Object.freeze({
  setAttribute() {},
  end() {},
  isTraced: false,
});

function apply(span, attrs) {
  if (!attrs) return;
  for (const key in attrs) {
    const value = attrs[key];
    if (value !== undefined) span.setAttribute(key, value);
  }
}

// span(name, fn, attrs?) — run fn inside a span that ends when fn settles.
// Returns whatever fn returns (a promise stays a promise), so this can be
// dropped around an existing expression without changing its shape.
export function span(name, fn, attrs) {
  const t = tracing;
  if (!t) return fn(INERT);
  return t.enterSpan(name, (s) => {
    apply(s, attrs);
    return fn(s);
  });
}
