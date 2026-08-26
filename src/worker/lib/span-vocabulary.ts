// span-vocabulary.ts — the span names and attribute shapes this Worker may
// emit, as types. Bundled by wrangler at deploy; not served. Types only, so the
// whole module erases and nothing here reaches the wire.
//
// WHY THIS IS A FILE AND NOT A COMMENT. Span names are a FLAT GLOBAL NAMESPACE
// in the dashboard, which lib/trace.ts's header has said since the day it was
// written, and a flat global namespace with no registry is how you get
// `lens.inspect.parse` and `lens.parse.inspect` both in production and neither
// one findable. The convention was documented and unenforced: nothing failed if
// a new span misspelled its surface, and nothing listed what already existed,
// so the only way to answer "what does this Worker emit" was to grep.
//
// The cost of that is not hypothetical and it is not really about typos. The
// covers-pending outage went undiagnosed twice, and part of why is that
// `rn.track_embeds_failed` was already being recorded and nobody knew to read
// it. An attribute nobody can discover is an attribute nobody reads, and a span
// vocabulary is worth exactly as much as its discoverability.
//
// This file is that registry. It is also the reason the contract test beside it
// can compare declaration against use in both directions.

/**
 * What a span attribute may hold.
 *
 * `undefined` is IN the union deliberately, and it is the one part of this file
 * that encodes a rule rather than a shape. The attribute discipline here
 * matches the photo pipeline's: a value that is not known is SKIPPED, never
 * fabricated as 0 or "unknown", because a span saying nothing about a dimension
 * is honest and one saying 0 is a lie you later read as data. `apply()` in
 * trace.ts drops undefined rather than setting it, so allowing it here is what
 * lets a caller write `{ "rn.playlist_id": maybeId }` without a conditional.
 */
export type SpanAttrValue = string | number | boolean | undefined;

/**
 * Every span this Worker opens. Adding a span means adding it here, which is
 * the point: the alternative is a name that exists only at its one call site.
 *
 * Grouped by surface, in the order lib/trace.ts's header describes them.
 */
export type SpanName =
  // The dispatcher. Named `route <template>` rather than a slug so a trace tree
  // reads as a route, which is the deliberate exception to <surface>.<phase>.
  | `route ${string}`

  // The two homepage hydration fragments.
  | "home.grid.manifest"
  | "home.grid.alt"
  | "home.grid.hist"
  | "home.grid.render"

  // The three-tier Spotify scrape and the cover-enrichment cron.
  | "rn.tracks.swr"
  | "rn.tracks.load"
  | "rn.tracks.bust"
  | "rn.tracks.playlist_id"
  | "rn.scrape.playlist"
  | "rn.scrape.meta"
  | "rn.art.warm"
  | "rn.enrich"

  // /lens. The discovery fan-out is 28 probes and was entirely unmeasured
  // before these existed, because out.elapsedMs is fixed before it runs.
  | "lens.inspect"
  | "lens.inspect.fetch"
  | "lens.inspect.parse"
  | "lens.discovery"
  | "lens.discovery.per_url"
  | "lens.discovery.bot_views"
  | "lens.shot"
  | "lens.shot.quick_action"
  | "lens.browser"
  | "lens.browser.quick_action"
  | "lens.wire"
  | "lens.wire.session"
  | "lens.tools"
  | "lens.nlweb"

  // The neighborhood crawl, where every degradation is designed to be quiet.
  // `around.neighbor` is the per-host span the rollup is built from, and it is
  // worth noting HOW it and rn.scrape.playlist got here: both were missed by
  // the grep that seeded this list, because that grep required the quote to
  // follow `span(` on the same line and both call sites wrap. The compiler
  // caught both the moment this type existed. That is the fourth naive scanner
  // this repo has recorded and the first one aimed at its own span vocabulary,
  // which is a reasonable argument for the type over the grep.
  | "around.neighbor"
  | "around.crawl"
  | "around.robots_gate"
  | "around.publish"
  | "around.persist_history"

  | "census.sweep"
  | "census.host"
  | "census.ensure_table"

  | "webmention.send"
  | "webmention.discover"
  | "webmention.own_pages"
  | "webmention.fetch_own_page"
  | "webmention.post"

  | "nlweb.ask"
  | "dyno.fetch"

  // Coffee. These are opened by cal/src/trace.ts, which is a deliberate
  // near-duplicate of lib/trace.ts (gotcha 16: cal's Vitest pool boots from
  // cal/src/index.ts alone, so a cal to src/worker import would make cal
  // untestable without the site tree). The NAMES still belong in one registry,
  // and the contract test reads both files against this list, which is how the
  // two vocabularies are kept together without creating that import.
  | "cal.busy"
  | "cal.refresh"
  | "cal.refresh_background"

  // Crons. A cron has no response, no status, and no visitor to complain.
  | "cron.home_probe"
  | "cron.rn_enrich"
  | "cron.around"
  | "cron.census"
  | "cron.serendipity"
  | "cron.webmention_send"
  | "cron.unmatched";

/**
 * The surface a span name belongs to, which is its first dot-separated segment.
 * `route <template>` is the one span shape that is not dotted, so it is matched
 * first and mapped to `route` by hand.
 */
export type SpanSurface<N extends string> =
  N extends `route ${string}` ? "route"
  : N extends `${infer S}.${string}` ? S
  : N;

/**
 * Attribute keys any span may set, whatever its surface.
 *
 * Keep this list SHORT and argued. Every entry is a hole in the surface rule
 * below, so the bar is that the attribute genuinely describes something other
 * than the surface: the first two are OpenTelemetry's own semantic conventions
 * for an HTTP span, and `cron.schedule` is stamped on every cron span by one
 * wrapper in index.ts rather than by the jobs themselves.
 */
export type SharedSpanAttr =
  | "http.request.method"
  | "http.response.status_code"
  | "cron.schedule";

/**
 * The attributes a span of name `N` may carry: anything under its own surface,
 * plus the shared keys.
 *
 * WHAT THIS CATCHES AND WHAT IT DOES NOT, measured on the pinned tsc rather
 * than assumed. It catches an attribute belonging to another surface
 * (`rn.covers_pending` on a `lens.*` span) and an attribute under no surface at
 * all (`nope.x`), both as TS2353 naming the key. It does NOT catch a typo
 * WITHIN a surface: `cal.typoo` satisfies `cal.${string}` and always will.
 *
 * That limit is deliberate rather than a gap to close later. Pinning the exact
 * key set would mean every new attribute is a two-file change, which is the
 * friction that stops people adding attributes, and attributes are the half of
 * a span that carries the information. The rule worth enforcing is the one that
 * makes a vocabulary navigable: an attribute lives under the surface that
 * emitted it, so `lens.*` in a trace is all of and only /lens.
 */
export type SpanAttrs<N extends string> = Partial<
  Record<`${SpanSurface<N>}.${string}` | SharedSpanAttr, SpanAttrValue>
>;

/**
 * The span handle a callback receives. Cloudflare's own object carries more
 * than this; what is declared here is what this Worker actually uses, so the
 * INERT stand-in in trace.ts can satisfy it in full and the two cannot drift.
 */
export interface Span<N extends string = string> {
  // `keyof SpanAttrs<N>` is already string-keyed, so the `& string` this
  // carried at first was redundant and oxlint's type-aware pass said so.
  setAttribute(key: keyof SpanAttrs<N>, value: SpanAttrValue): void;
  end(): void;
  readonly isTraced?: boolean;
}
