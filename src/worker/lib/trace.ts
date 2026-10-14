// trace.ts — one wrapper over Workers Traces so every span in this worker has a
// single import site and a single failure story. Bundled by wrangler at deploy;
// not served.

import { isCallable } from "./parse.ts";
import type { Span, SpanAttrs, SpanAttrValue, SpanName } from "./span-vocabulary.ts";
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

type Tracing = {
  enterSpan<T>(name: string, fn: (span: Span) => T): T;
};

let tracing: Tracing | null = null;

export function installTracing(candidate) {
  tracing = isCallable(candidate?.enterSpan) ? candidate : null;
}

const INERT: Span = Object.freeze({
  setAttribute() {},
  end() {},
  isTraced: false,
});

function apply(span: Span, attrs: SpanAttrs<string> | undefined) {
  if (!attrs) return;
  for (const key in attrs) {
    const value = (attrs as Record<string, SpanAttrValue>)[key];
    // The one cast in this module, and it is at the only place a key stops
    // being statically known: `for...in` widens to string no matter what the
    // object's type is. Callers are checked at the call site, which is where
    // the name and the attribute literal are both in hand.
    if (value !== undefined) span.setAttribute(key as never, value);
  }
}

export function setAttributes<N extends SpanName>(span: Span<N>, attrs: SpanAttrs<N>): void {
  apply(span, attrs);
}

export function span<N extends SpanName, T>(
  name: N,
  fn: (span: Span<N>) => T,
  attrs?: SpanAttrs<N>,
): T {
  const t = tracing;
  if (!t) return fn(INERT as Span<N>);
  return t.enterSpan(name, (s) => {
    apply(s, attrs);
    return fn(s as Span<N>);
  });
}
