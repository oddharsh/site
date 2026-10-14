// span-vocabulary.ts — the span names and attribute shapes this Worker may
// emit, as types. Bundled by wrangler at deploy; not served. Types only, so the
// whole module erases and nothing here reaches the wire.

export type SpanAttrValue = string | number | boolean | undefined;

export type SpanName =
  | `route ${string}`

  | "home.grid.manifest"
  | "home.grid.alt"
  | "home.grid.hist"
  | "home.grid.render"

  | "rn.tracks.swr"
  | "rn.tracks.load"
  | "rn.tracks.bust"
  | "rn.tracks.playlist_id"
  | "rn.scrape.playlist"
  | "rn.scrape.meta"
  | "rn.art.warm"
  | "rn.enrich"

  | "lens.inspect"
  | "lens.inspect.fetch"
  | "lens.inspect.parse"
  | "lens.discovery"
  | "lens.discovery.per_url"
  | "lens.discovery.bot_views"
  | "lens.discovery.walls"
  | "lens.shot"
  | "lens.shot.quick_action"
  | "lens.browser"
  | "lens.browser.quick_action"
  | "lens.wire"
  | "lens.wire.session"
  | "lens.tools"
  | "lens.nlweb"
  | "lens.markdown"

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
  | "webmention.sort"

  | "reading.hn"

  | "serendipity.sync"

  | "nlweb.ask"
  | "dyno.fetch"

  | "cal.busy"
  | "cal.refresh"
  | "cal.refresh_background"

  | "cron.home_probe"
  | "cron.rn_enrich"
  | "cron.reading_hn"
  | "cron.around"
  | "cron.census"
  | "cron.serendipity"
  | "cron.webmention_send"
  | "cron.unmatched";

export type SpanSurface<N extends string> =
  N extends `route ${string}` ? "route"
  : N extends `${infer S}.${string}` ? S
  : N;

export type SharedSpanAttr =
  | "http.request.method"
  | "http.response.status_code"
  | "cron.schedule"
  | "budget.limit"
  | "budget.spent"
  | "budget.exhausted"
  | "budget.overrun";

export type SpanAttrs<N extends string> = Partial<
  Record<`${SpanSurface<N>}.${string}` | SharedSpanAttr, SpanAttrValue>
>;

export interface Span<N extends string = string> {
  setAttribute(key: keyof SpanAttrs<N>, value: SpanAttrValue): void;
  end(): void;
  readonly isTraced?: boolean;
}
