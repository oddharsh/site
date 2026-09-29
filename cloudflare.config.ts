// The site Worker's config: WHAT the Worker is. How wrangler builds and uploads
// it is the other half, in wrangler.config.ts beside this file.
//
// This replaced wrangler.jsonc on 2026-09-28, translated by hand. `cf migrate`
// refused it, reporting that Workflow bindings "are not supported by the new
// config", which is a gap in the MIGRATOR rather than the format:
// @cloudflare/config has `exports.workflow` and `bindings.workflow`, and both
// Workflows below use them. The upload is byte-identical to the jsonc's, index.js
// sha256 for sha256 under `wrangler deploy --dry-run --outdir`.
//
// EVERY WRANGLER COMMAND THAT READS THIS FILE PASSES `--x-new-config` and runs
// from the repository root, because the loader reads the working directory and
// refuses `-c`. The release path needs no dashboard change for that: Workers
// Builds calls `.github/deploy-wrangler.sh`, which adds the flag itself whenever
// this file exists, so the switch lands atomically with the merge that adds it.
//
// Migrated from the Pages project of the same name. run_worker_first is an
// allowlist that mirrors src/worker/index.ts: static is the default, and compute
// only runs where a route earns it. Compression is NO LONGER left entirely to the
// platform: /a/* (the content-hashed shell) is worker-first so it can serve
// build.ts's brotli q11 twin. The edge fly-compresses at about q4 and prefers
// zstd when a browser offers everything, which measured LARGER than its own
// brotli here (homepage: 13,264 zstd vs 12,457 br vs 10,524 br q11, 2026-07-26).
// Everything else still takes the platform default. (The homepage used to be the
// stated exception, "cannot be precompressed at all, because its bytes differ
// per request". It is a deterministic document now and carries the same q11
// twin, dcz delta, and ETag as every other page.)
import { bindings, defineConfig, defineWorker, exports, triggers } from "@cloudflare/config/public";

const worker = defineWorker({
  name: "aadhar-sh",
  // The build stages the Worker at .build/src/worker and assets at .build/public;
  // wrangler.config.ts runs tools/build.ts before every upload or deploy, so no
  // path serves the readable originals by accident (which is exactly how prod
  // ended up on an unminified 78KB nav.js).
  entrypoint: ".build/src/worker/index.ts",
  compatibilityDate: "2026-06-01",
  // The incoming Request's `signal` fires when the CLIENT hangs up, so a handler
  // can attach an abort listener and learn that nobody is waiting any more. It is
  // NOT date-gated, so no compatibilityDate bump ever delivers it and this key is
  // the only door.
  //
  // A flag nothing reads is dead config, so this ships with its one reader:
  // dispatchTraced() in src/worker/index.ts records `route.aborted` on every
  // route span. The number it buys is the abandon rate, which nothing here can
  // currently count. /lens is the case that wants it: one scan fans out about 28
  // probes against the 50-subrequest cap Workers Free enforces (gotcha 36), and
  // whether visitors walk away mid-fan-out has only ever been argued.
  //
  // The sibling flag `request_signal_passthrough` is deliberately absent, and it
  // is the dangerous half. It forwards the signal to every subrequest, which
  // cancels the work that deliberately OUTLIVES the response. Two of those are
  // user-visible: cal/src/index.ts waitUntils six Resend sends, so a host who
  // approves a booking and closes the tab means the requester never gets the
  // invite, and webmention.ts:130 runs its whole job after a 202, by which point
  // the sender has always disconnected. A listener changes no subrequest
  // behaviour at all, which is why this half is safe to take alone.
  //
  // THE RUNTIME VALIDATES THIS ARRAY AND THE DRY RUN DOES NOT, which is the
  // reverse of where you would look. Measured 2026-08-28 on wrangler 4.127.0 with
  // "definitely_not_a_real_flag_xyz" in here: `wrangler deploy --dry-run` exits
  // 0 and says nothing, while booting the real Worker through
  // createTestHarness() dies with `No such compatibility flag:
  // definitely_not_a_real_flag_xyz`. So `bun run routes:check` is the gate that
  // makes acceptance mean something, and CI already runs it inside `validate`.
  // Same control idiom as --x-bogus-flag, aimed one layer lower.
  //
  // WHAT LOCAL DEV CANNOT TELL YOU, so nobody re-runs it: the in-process harness
  // never delivers a hang-up. A throwaway Worker booted four times (no flags,
  // enable_request_signal, disable_request_signal, request_signal_passthrough)
  // reported `signal` present, an AbortSignal, and listenable in ALL FOUR, and
  // `aborted` stayed false in all four after a raw socket was destroyed 120ms
  // into a 600ms handler. So the property is not what this flag adds here, the
  // FIRING is, and the firing is a production measurement. Expect route.aborted
  // to read false under `bun run dev` and routes:check by construction.
  //
  // `new_module_registry` is the rewritten module loader workerd shipped in
  // 2026-09 (blog.cloudflare.com/workers-module-registry-nodejs): specifiers
  // parse as real URLs, `node:` resolves to one instance whatever the import
  // path, `import.meta.url` / `.main` / `.resolve()` work, import attributes are
  // VALIDATED (`with { type: "json" }` on a non-JSON module throws, an unknown
  // attribute throws) instead of ignored, `require()` of a module with top-level
  // await throws ERR_REQUIRE_ASYNC_MODULE, and modules compile on first import.
  // It is NOT date-gated: no compatibilityDate bump ever delivers it, so like
  // the flag above this key is the only door. Same for the three auxiliary
  // Workers and cal's test config, which carry it too so nothing here boots on
  // a different loader from the rest.
  //
  // What it changes for THIS tree, checked before the flag went in (2026-09-11):
  // nothing at runtime. The five `with { type: "json" }` imports in src/worker
  // are the spec-correct form and esbuild inlines them before workerd ever sees
  // a specifier; there is no `import.meta`, no `require()`, no wasm, and no
  // query-string specifier in src/worker, cal/src, serendipity or the three
  // auxiliaries. The pinned workerd (1.20260908.1 behind wrangler 4.130.0)
  // knows the flag, and `bun run routes:check` boots the real Worker on it,
  // which is the gate the paragraph above says makes acceptance mean anything.
  compatibilityFlags: ["enable_request_signal", "new_module_registry"],

  // Workers Cache sits in front of the public-response entrypoint below. The
  // default dispatcher stays uncached because it owns mutations, per-visitor
  // views, content-negotiated representations, and request logging; response
  // Cache-Control remains the route-level freshness contract inside CachedPages.
  // (The homepage was on that list until 2026-07-31, when it became a
  // deterministic document; shouldUseWorkersCache in lib/cache.ts is the
  // authority on what routes here, and on the bails that send a request back
  // to the uncached gateway.)
  cache: { enabled: true, crossVersionCache: false },

  // `[dependencies_instrumentation] enabled = true` has no home in this format.
  // It costs nothing, for the reason cf-garage/cloudflare.config.ts measured:
  // wrangler tests the key as `enabled !== false`, so an absent block behaves
  // exactly like the explicit `true` wrangler.jsonc carried.

  // Serve only on the custom domain (aadhar.sh); no public *.workers.dev URL.
  workersDev: false,
  // Preview URLs, on PURPOSE and against the default. They used to default to
  // whatever `workers_dev` was, so the line above was silently turning these off
  // too, and every version this repo had uploaded was unservable.
  //
  // The two settings are independent and mean different things. `workersDev:
  // false` still holds: PRODUCTION has no workers.dev address, and the only way
  // to reach the deployed site remains aadhar.sh. What this adds is a per-VERSION
  // address, `<version-prefix>-aadhar-sh.<subdomain>.workers.dev`, which is the
  // one thing CI could not do before: prove a branch serves, at a real URL, on
  // real bindings, before it is production. `wrangler deploy --dry-run` and the
  // in-process route harness both stop short of that.
  //
  // STILL unservable, measured 2026-09-28: this Worker exports the `Counter`
  // Durable Object, and Cloudflare mints no preview URL for a Worker that
  // implements one. Every version reads `has_preview: false`. CLAUDE.md,
  // "Preview URLs are configured ON and have NEVER SERVED", has the evidence,
  // and "Moving Counter out" is the move that ends it. The line stays so
  // previews switch on by themselves once the class leaves.
  //
  // A preview runs production bindings and secrets (Cloudflare has no
  // per-version override), so the Worker guards the host: writes refused,
  // everything noindex. That guard is load-bearing, not decorative. Read
  // lib/preview.ts before touching this line, and do not enable previews with
  // the guard removed.
  previewUrls: true,

  triggers: [
    // The former coffee and Serendipity Workers are retired by this config.
    // These routes move their public paths onto the same deployment.
    triggers.fetch({ pattern: "aadhar.sh/coffee*", zone: "aadhar.sh" }),
    triggers.fetch({ pattern: "aadhar.sh/serendipity*", zone: "aadhar.sh" }),
    triggers.fetch({ pattern: "cal.aadhar.sh/*", zone: "aadhar.sh" }),
    // 17 8 * * 1: the weekly /lens/census sweep into D1 (index.ts switches on
    // event.cron). Odd minute so it doesn't collide with the :00/:30 crawl tick.
    // (The old 0 4 * * 7 coffee-booking sweep is retired: each pending booking
    // now carries its own BookingWorkflow expiry timer; see the exports below.)
    triggers.scheduled({ schedule: "17 8 * * 1" }),
    // 41 5 * * *: the DAILY OUTBOUND tick, and the only one that touches
    // somebody else's server. Two jobs, run sequentially so they do not double
    // the burst this site presents at one instant:
    //   - webmention-send: read this site's own mention-enabled pages, find the
    //     sources they cite, and tell those sources they were cited.
    //   - around.ts cronAround: crawl the twenty-origin neighborhood and write
    //     the KV snapshot /around reads. This had its own "*/30 * * * *" trigger
    //     until 2026-08-14. Twenty VC homepages do not change every half hour,
    //     and that cadence spent 960 signed third-party fetches, 960 D1
    //     row-writes and 48 KV snapshot writes a day to find that out. Merging
    //     cut all three by 48x and freed a trigger slot, which matters because
    //     Workers Free caps an account at five.
    // The crawl stays on a CRON rather than moving to the request path, and that
    // is load-bearing rather than incidental: dbbd44f moved it here so that no
    // visitor, crawler or speculative prerender can make this site fetch twenty
    // third-party homepages. /around carries no speculation exclusion precisely
    // BECAUSE its GET is pure, so putting the crawl back on a read would make a
    // taskbar hover fire a real crawl. Daily and off-peak because it probes
    // third-party hosts, and neither a citation graph nor a fund's homepage
    // changes by the half hour.
    triggers.scheduled({ schedule: "41 5 * * *" }),
    // 7,37 * * * *: the homepage perf probe (perf-probe.ts): render `/`
    // in-process, parse its own Server-Timing, write the spans to Analytics
    // Engine. Offset from the old */30 around-crawl so the two never shared a
    // tick. 48 samples/day.
    triggers.scheduled({ schedule: "7,37 * * * *" }),
    // 23 */6 * * *: the serendipity Luma re-sync (cronSerendipity): events per
    // enabled contributor, then the next guest lists, then a description
    // backfill. Four times daily keeps the pool honest AND the stored Luma
    // session warm (Luma sessions idle-expire in weeks, and before this tick
    // nothing exercised the stored cookie between pastes); rotations Luma issues
    // mid-run are persisted back to D1 by the cookie jar.
    triggers.scheduled({ schedule: "23 */6 * * *" }),
  ],

  assets: {
    // Canonical URLs carry NO trailing slash (sitemap.xml, both rel=canonical
    // tags, llms.txt and nav.js's own normalization all say so).
    // drop-trailing-slash makes the asset layer agree: /garage + /lwe serve
    // directly, /garage/ + /lwe/ 301 to the slashless form. MUST match
    // wrangler.dev.jsonc, or dev diverges from prod.
    htmlHandling: "drop-trailing-slash",
    // Worker-owned routes only. New static files do not cost invocations unless
    // they are added here and to the ROUTES/PREFIX tables in index.ts.
    //
    // /images/<thumb> stays worker-first for one narrow reason: a real 404 under
    // /images/* must not inherit the immutable thumbnail cache rule. The old
    // Pages SPA-fallback content-type sniff is gone; the Worker now only clamps
    // asset 404 cache-control and passes every non-404 response through.
    runWorkerFirst: [
      "/", "/index.html", "/favicon.ico", "/hit",
      // the content-hashed shell: worker-first so it can hand out the q11 .br twin
      "/a/*",
      // static pages: worker-first for the dcz delta + brotli q11 twin.
      // The bare section paths are listed SEPARATELY because "/garage/*" does not
      // match "/garage"; without them the two section indexes never reached the
      // worker at all, so their twins were built, uploaded, and never served
      // (2026-07-28). Same shape as "/lens", "/lens/" and "/photos", "/photos/".
      "/garage", "/garage/*", "/lwe", "/lwe/*",
      "/pixel-peeper", "/pixel-peeper/*",
      "/access", "/access/*",
      "/auth.md",
      // The whole agent-discovery namespace, FOLDED from five exact rows on
      // 2026-09-16 (api-catalog, agent-card.json, the two oauth documents, and
      // the signed http-message-signatures-directory, which needs the Worker for
      // its per-request proof of possession). The fold frees four rows and
      // brings the static cards (mcp/*.json, ard.json, ai-catalog.json) to the
      // Worker for their q11 twins; they were the one discovery surface still
      // shipping at the edge's q4.
      "/.well-known/*",
      "/agent/*", "/oauth2/*",
      // /whoareyou (a built page), /whoareyou.json, and the page's values island
      // at /whoareyou/values.html, folded onto one row 2026-09-25 like "/security*".
      // /whoareyou.md is already claimed by "/*.md" below.
      "/whoareyou*",
      // /security and /security.json (the page is built, the JSON is its three
      // live connection values). /security.md is already claimed by "/*.md" below.
      "/security*",
      "/reading", "/updates", "/updates.json",
      "/perf",
      "/perf.json", "/restore",
      // FOLDED onto a wildcard 2026-08-11, from eight exact rows ("/lens",
      // "/lens/", "/lens/fetch", "/lens/shot", "/lens/browser",
      // "/lens/compare.json", "/lens/census", "/lens/census.json") to two.
      // This config sat at exactly 100 of the 100 allowed rules, so /lens/wire
      // could not be added as a ninth row at any price (gotcha 26 in CLAUDE.md),
      // and the fold is the remedy that note recommends. It frees six.
      //
      // Safe because NOTHING static lives under /lens/: the three client scripts
      // are top-level (/lens.js, /lens-browser.js, /lens-reader.js) and a
      // wildcard on "/lens/" cannot reach them. "/lens.txt" is likewise outside
      // it and keeps its own row. /lens/read belongs to the separate lens-reader
      // Worker via a ZONE ROUTE, which is matched before this config is
      // consulted, so widening the site Worker's claim here does not touch it.
      "/lens", "/lens/*",
      "/mcp",
      // The retired console: one wildcard for the 410 at /terminal and under it.
      "/terminal*",
      // One wildcard per tool covers both the bare route and its .txt twin.
      // NOT cosmetic: run_worker_first caps at 100 RULES (wrangler refuses to
      // boot at 101), and twelve exact entries put this config at 102. A site
      // can only claim so many paths from the asset layer, which is a real
      // ceiling on how many surfaces you can add this way.
      "/finger*", "/radar*", "/dict*", "/cache*", "/agent-ready*", "/encode*",
      "/photos.txt", "/lens.txt",
      "/search", "/search.json", "/ask",
      "/coffee", "/coffee/*", "/serendipity", "/serendipity/*",
      "/slots", "/book", "/approve", "/decline",
      "/llms-full.txt", "/ledger", "/ledger.json",
      // one glob for the ledger's sub-routes: the activation beacon and the
      // speculation readback. Nothing static lives under /ledger/.
      "/ledger/*",
      "/writing", "/writing/*",
      // "/inbox*" covers the page and its island at /inbox/mail.html (2026-09-25);
      // nothing static lives under it, and /inbox.md is "/*.md"'s anyway.
      "/webmention", "/webmention/*", "/inbox*",
      // "/rn.md" carries an extension, so without it here the asset layer would
      // answer first and 404 a route the worker renders.
      "/rn", "/rn.md", "/rn/tracks", "/rn/tracks.html", "/rn/admin", "/rn/set", "/rn/art/*",
      // "/around*" folds "/around", "/around/json" and "/around/changes.json",
      // and covers the page's island at /around/snapshot.html (2026-09-25).
      // Nothing static lives under /around; /around.md is "/*.md"'s anyway.
      "/bot", "/around*",
      // "/photos/*" FOLDS the three exact sub-rows it replaced ("/photos/",
      // "/photos/query.json", "/photos/grid.html"), 2026-09-12. Nothing static
      // lives under /photos/ (no public/photos, no src/pages/photos), so the
      // wildcard claims only Worker routes. The two rows it freed pay for the
      // first album below; the config is back at 98 of 100 after it.
      "/photos", "/photos/*", "/run",
      // albums (src/worker/albums.ts): each is a root-level generated page plus
      // its slashed twin, and needs its own pair here because a root path has no
      // wildcard to inherit. The next album costs two rows; fold before adding.
      "/cota-wec", "/cota-wec/",
      "/images", "/images/", "/images/full", "/images/full/*",
      "/images/manifest.json", "/images/metadata.json", "/images/meta/*",
      "/images/*.avif", "/images/*.jpg", "/images/*.jpeg",
      "/images/*.png", "/images/*.gif",
      "/images/*.heic", "/images/*.heif", "/images/*.hif",
      // Five rules for the brotli q11 twins of static text assets, added
      // 2026-08-31. Without them these paths never reach the Worker and ship
      // edge-compressed at ~q4, 12-24% larger than the twin the build already
      // writes. /garage/*, /lwe/*, /writing/*, /pixel-peeper/* and
      // /images/meta/* were worker-first already and needed nothing here. `*`
      // spans slashes in this allowlist (build.ts's own coverage check reads it
      // that way), so "/*.md" claims every Markdown twin at any depth and
      // "/images/*.json" the data indexes beside meta/. This put the config at
      // 98 of the 100 rules wrangler allows; the /.well-known fold above
      // (gotcha 26's remedy) took it back down, and "/*.src.*" (the readable
      // twins at the root: index.src.html, nav.src.js, luna.src.css) spent one of
      // the freed rows.
      "/images/*.json", "/*.md", "/*.src.*", "/search-index.json", "/llms.txt", "/sitemap.xml",
      // q11 everywhere, 2026-09-26: the section icons (favicons on 12 pages) and
      // /resume.json, both at the edge's q4 until their twins had a route.
      "/section-icons/*", "/resume.json",
    ],
  },

  // `enabled` is Workers LOGS (the structured line serveWorkerRequest emits).
  // `traces` is the separate, newer thing: Workers Traces, which
  // auto-instruments every outbound fetch, binding call, and handler invocation
  // as a span tree, and which lib/trace.ts hangs named spans off. It is opt-in
  // until Cloudflare default-enables automatic tracing (that flip will want a
  // newer compatibilityDate; this API works at 2026-06-01, verified 2026-07-29).
  //
  // headSamplingRate is 1 (every request), which is also the default, stated
  // here because the value is a deliberate choice rather than an omission.
  // Sampling is per-WORKER, not per-route, so a fractional rate would thin the
  // rare-but-expensive events this was turned on for in the first place: a
  // /lens discovery fan-out that stalls, a cron target that has silently been
  // skipped for weeks, a coffee booking that fails closed on a stale calendar.
  //
  // The allowance is 200K events/DAY (the dashboard's own banner: observability
  // is on the free tier here, whatever the Workers plan is; an earlier version
  // of this comment claimed the Paid plan's 10M/month, which was wrong). Above
  // that, Cloudflare samples for you. 200K/day is ~2.3/sec sustained, and this
  // site's real traffic is a rounding error against it, but note that a /lens
  // scan is ~33-46 spans in ONE request: an event here is a SPAN, not a visit,
  // so a burst of scans consumes the budget far faster than the page views do.
  // If the banner ever says events are being sampled, lower this rather than
  // deleting spans. Same if a span ever shows up ON the critical path.
  // NO `issues` block (real-time error grouping, workers-sdk #15684). #950
  // turned it on 2026-09-26 and it blocked every ramp for the next five
  // releases: `versions upload` accepts the field, then `versions deploy`
  // PATCHes script-settings and the API refuses it, "observability.issues
  // requires the real-time issue detection feature to be enabled [code:
  // 100344]". The feature is gated per ACCOUNT, and this one does not have it.
  // Re-add it only after the account does, and prove it with a branch build
  // plus a ramp, since a dry run and an upload both pass while the deploy fails.
  observability: {
    enabled: true,
    traces: { enabled: true, headSamplingRate: 1 },
  },

  env: {
    // The static assets, served by the asset layer and read by the Worker for
    // every worker-first path above.
    ASSETS: bindings.assets(),
    // The deployed version id (changes every deploy). lib/cache.ts folds it into
    // the caches.default key for rendered shells, so a deploy orphans the old
    // edge entries atomically instead of waiting out their TTL. Not populated in
    // local dev (the key falls back to "dev" there).
    CF_VERSION_METADATA: bindings.versionMetadata(),

    RN_KV: bindings.kv({ id: "3cb8a107c58e47dc9244e75b33401f36" }),
    BOOKINGS: bindings.kv({ id: "37acb65118fe485583a90a94cb89365e" }),

    // The bot ledger: identified AI-crawler hits tick in here (ledger.ts);
    // /ledger reads them back via the SQL API (needs ANALYTICS_READ_TOKEN).
    BOT_LEDGER: bindings.analyticsEngineDataset({ name: "aadhar_bot_ledger" }),
    // The speculation ledger: Sec-Purpose prefetch/prerender requests, plus the
    // activation beacons that say which of them paid off (speculation.ts).
    SPECULATION: bindings.analyticsEngineDataset({ name: "aadhar_speculation" }),
    // The homepage perf probe's spans (perf-probe.ts); read back with the same
    // SQL API + ANALYTICS_READ_TOKEN as the ledger. AE datasets materialize on
    // first write: no id, nothing for infra:apply to provision.
    PERF_PROBE: bindings.analyticsEngineDataset({ name: "aadhar_perf_probe" }),

    PHOTOS_R2: bindings.r2({ name: "aadhar-photos" }),

    RESTORE_DB: bindings.d1({ name: "aadhar-restore", id: "88c8daf1-3a36-4f8e-a2ad-dba8a74e1b9f" }),
    SERENDIPITY_DB: bindings.d1({ name: "serendipity", id: "d3aa3215-17c3-4389-b224-cf465ddbb786" }),
    // Third-party social content (webmentions), deliberately its own database:
    // it is moderated, mutable, and written by strangers, where checkpoints is
    // this site's own append-only history. Created 2026-07-27 and the schema
    // applied from migrations/0001_webmentions.sql, so this id is real. A D1
    // binding pointing at an id that does not exist fails the deploy, and a
    // --dry-run will not catch it.
    SOCIAL_DB: bindings.d1({ name: "aadhar-social", id: "b3ab51c4-da04-40ec-9b36-c7e06611f4ab" }),

    // The Counter Durable Object lives in the aadhar-counter Worker (counter/)
    // since step 3 of "Moving Counter out" (CLAUDE.md): this Worker binds it
    // there and no longer implements it, which is what lets it have preview
    // URLs. Same class name, same instances, same storage: the namespace moved
    // by transfer, so "homepage-visits" and every coffee-slot claim came with it.
    COUNTER: bindings.durableObject({ worker: "aadhar-counter", exportName: "Counter" }),

    // One durable expiry timer per pending coffee booking (cal/src/workflow.ts,
    // re-exported from src/worker/index.ts). Replaced the weekly cron sweep.
    // Must match wrangler.dev.jsonc + cal/wrangler.test.toml.
    BOOKING_WORKFLOW: bindings.workflow({ name: "cal-booking-expiry", worker: "aadhar-sh", exportName: "BookingWorkflow" }),
    CENSUS_WORKFLOW: bindings.workflow({ name: "lens-census-host", worker: "aadhar-sh", exportName: "CensusWorkflow" }),

    // Browser Run Quick Actions. The binding is authenticated by Workers, so
    // Lens no longer needs a Browser Run API token for snapshots.
    BROWSER: bindings.browser(),
    // Image Workbench uses the managed Images transformation binding; outputs
    // are returned inline and are not written to PHOTOS_R2.
    IMAGES: bindings.images(),

    // Per-IP budgets for every public route that spends something on a caller's
    // say-so: /lens and the /mcp tools that share its crawler, the five /mcp
    // tools that fetch or write, and /webmention.
    // These were KV counters until 2026-08-04: a read plus a WRITE on every
    // allowed request, for a number that lived 120 seconds. RN_KV's write budget
    // is ~10K/day and /lens is the busiest writer on the site, so the counters
    // were the largest consumer of a budget CLAUDE.md still described as "we use
    // a handful". The binding costs no write and adds no meaningful latency.
    //
    // The periods are all 60 because the binding supports 10 or 60 and nothing
    // else, and every budget here was already per-minute. Limits are mirrored in
    // LENS_BUDGETS (lens.ts) because that is what the 429 message quotes; a
    // contract test pins the two together so the message cannot drift from the
    // ceiling. The namespace is an opaque integer-as-string and only has to be
    // unique within this Worker: it is not a resource id and infra:apply has
    // nothing to provision. MUST match wrangler.dev.jsonc.
    LENS_RL_INSPECT: bindings.rateLimit({ namespace: "1001", simple: { limit: 30, period: 60 } }),
    LENS_RL_SHOT: bindings.rateLimit({ namespace: "1002", simple: { limit: 3, period: 60 } }),
    LENS_RL_COMPARE: bindings.rateLimit({ namespace: "1003", simple: { limit: 4, period: 60 } }),
    LENS_RL_BROWSER: bindings.rateLimit({ namespace: "1004", simple: { limit: 3, period: 60 } }),
    // Shared across /lens/shot + /lens/browser, keyed on a CONSTANT rather than
    // the caller: Browser Run's free plan allows 6 Quick Actions a minute for the
    // whole ACCOUNT, so per-caller ceilings alone cannot keep the pair of them
    // inside it. Per-colo like every counter on this binding, so it bounds a
    // burst rather than guaranteeing the account total.
    LENS_RL_BROWSER_ALL: bindings.rateLimit({ namespace: "1005", simple: { limit: 4, period: 60 } }),
    // The wire trace is the most expensive thing on the site: a whole CDP
    // browser INSTANCE, held for a navigation plus a settle window, against a
    // free plan that mints one new instance every 20 seconds. Two a minute per
    // visitor is already more than the platform will actually serve; the real
    // controls are the 6h KV cache and the shared LENS_RL_BROWSER_ALL ceiling
    // this route also bills against.
    LENS_RL_WIRE: bindings.rateLimit({ namespace: "1006", simple: { limit: 2, period: 60 } }),
    // One POST to a foreign /mcp, answered from that server's own memory. Cheap
    // for us and cheap for them, so the per-caller ceiling is generous. The real
    // control is the 1h KV cache in lens-tools.ts, which exists to stop a public
    // button re-asking a stranger the same question on every click.
    LENS_RL_TOOLS: bindings.rateLimit({ namespace: "1007", simple: { limit: 10, period: 60 } }),
    // /lens/nlweb asks a foreign origin a real question rather than asking it to
    // describe itself, so it is metered harder than the catalogue read above.
    LENS_RL_NLWEB: bindings.rateLimit({ namespace: "1008", simple: { limit: 4, period: 60 } }),
    // /lens/markdown fetches ONE page ten times, once per distinct Accept header
    // it replays. Nothing on our side is expensive (no browser, no model), so
    // the ceiling is set by what it costs the target, which is ten plain GETs of
    // the same URL. The real control is the 1h KV cache, same as the catalogue
    // read.
    LENS_RL_MARKDOWN: bindings.rateLimit({ namespace: "1009", simple: { limit: 4, period: 60 } }),
    // The five /mcp tools that spend something, moved off KV counters on
    // 2026-08-27. FIVE buckets rather than one, because the ceilings span 5x and
    // the per-call costs span more: image_inspect on inlined base64 is a single
    // IMAGES.info call, image_compare runs up to three transforms, and
    // representation_capture is up to four third-party fetches plus four D1
    // writes. Mirrored in MCP_BUDGETS (mcp.ts), which is what the 429 quotes.
    MCP_RL_IMAGE_INSPECT: bindings.rateLimit({ namespace: "1010", simple: { limit: 20, period: 60 } }),
    MCP_RL_IMAGE_TRANSFORM: bindings.rateLimit({ namespace: "1011", simple: { limit: 8, period: 60 } }),
    MCP_RL_IMAGE_COMPARE: bindings.rateLimit({ namespace: "1012", simple: { limit: 4, period: 60 } }),
    MCP_RL_REPR_CAPTURE: bindings.rateLimit({ namespace: "1013", simple: { limit: 4, period: 60 } }),
    MCP_RL_REPR_COMPARE: bindings.rateLimit({ namespace: "1014", simple: { limit: 8, period: 60 } }),
    // The public webmention endpoint. One accepted POST costs a third-party
    // fetch, a D1 write and a Resend email, so this is the one budget here whose
    // overrun spends somebody else's quota as well as ours.
    WEBMENTION_RL: bindings.rateLimit({ namespace: "1015", simple: { limit: 10, period: 60 } }),

    // Not a secret: an account id is an identifier, and this one is already
    // committed as the default in tools/photos/gen-alt-text.ts. It is a VAR
    // because two features need it to build a REST URL and both fail SILENTLY
    // without it: /ledger's cost line read "unconfigured" in production, and the
    // Kitesurf path in lens-render.ts would have skipped straight to the binding
    // no matter how the token was set.
    CF_ACCOUNT_ID: bindings.text("1c99acdb6141579023fb97d24261ea58"),
    // Serendipity's Jev calls go through this gateway, to the account's
    // `custom-typesafe` provider (base_url https://api.typesafe.ai). A missing
    // gateway or provider FAILS those calls rather than bypassing the gateway
    // (gotcha 23), and the tag pass reports the status. "" is the off-switch:
    // TypeSafe directly, no code change.
    AI_GATEWAY: bindings.text("default"),
    HOST_TIMEZONE: bindings.text("America/New_York"),
    WORKING_HOURS_START: bindings.text("9"),
    WORKING_HOURS_END: bindings.text("18"),
    WORKING_DAYS: bindings.text("1,2,3,4,5"),
    SLOT_MINUTES: bindings.text("30"),
    BUFFER_MINUTES: bindings.text("15"),
    MIN_NOTICE_HOURS: bindings.text("24"),
    MAX_LOOKAHEAD_DAYS: bindings.text("14"),
    DAILY_LIMIT: bindings.text("3"),
    WEEKLY_LIMIT: bindings.text("5"),
    HOST_NAME: bindings.text("aadharsh"),
    HOST_EMAIL: bindings.text("coffee@aadhar.sh"),
    HOST_PUBLIC_URL: bindings.text("https://aadhar.sh"),
    EVENT_TITLE: bindings.text("coffee with aadharsh"),
    PENDING_TTL_DAYS: bindings.text("7"),

    // Secret VALUES are not here (set on the Worker with `wrangler versions
    // secret put`), but the NAMES are, because a comment cannot fail a deploy.
    // `wrangler deploy` and `wrangler versions upload` refuse to publish unless
    // every name below is configured on the Worker, so "the secret was never set
    // on the new Worker" stops being something you learn from a 500 on a route
    // nobody hits for a week. `bindings.secret()` is the new format's spelling of
    // wrangler.jsonc's `secrets.required`, and it types the name onto `env` too.
    //
    // The comment this replaced had drifted in BOTH directions, which is the
    // argument for the block. It listed EXA_API_KEY and PARALLEL_API_KEY, which
    // are set nowhere and read nowhere, and it omitted CENSUS_KEY and
    // RN_SIGNING_KEY_MLDSA_JWK, which the worker genuinely reads.
    //
    // The bar for this list is "read by code AND set on the Worker", because a
    // name here is a deploy gate. Live-or-referenced secrets deliberately OUT:
    //   BROWSER_RENDER_TOKEN  set on the Worker, read by nothing: the /lens REST
    //                         path it belonged to is retired in favour of the
    //                         BROWSER binding. It should be deleted, not declared.
    //   COVER_SECRET          read by code, never set. The path degrades without
    //                         it, so declaring it would fail the deploy over a
    //                         working site.
    //   ANALYTICS_READ_TOKEN  same shape: /ledger's SQL reads degrade without it.
    //   BILLING_READ_TOKEN    same shape again: /ledger's account cost line
    //                         renders a "not readable yet" note without it. Scope
    //                         it to Billing:Read and NOTHING else, and keep it off
    //                         the CI token, which is pinned at six reads and lives
    //                         in GitHub. Account spend is a category above
    //                         analytics; it belongs on the Worker alone.
    // Promote any of the last three the day it becomes load-bearing.
    CENSUS_KEY: bindings.secret(),
    ICAL_URL: bindings.secret(),
    RESEND_API_KEY: bindings.secret(),
    RN_BUST_SECRET: bindings.secret(),
    RN_SIGNING_KEY_JWK: bindings.secret(),
    RN_SIGNING_KEY_MLDSA_JWK: bindings.secret(),
    SIGNING_SECRET: bindings.secret(),
    SYNC_SECRET: bindings.secret(),
    WORK_CALENDAR_SLUG: bindings.secret(),
    WORK_CALENDAR_URL: bindings.secret(),
  },

  exports: {
    // The two entrypoints and their cache switch: `default` owns mutations and
    // per-visitor views and stays uncached, while CachedPages sits behind
    // Workers Cache (see `cache` above).
    default: exports.worker({ cache: { enabled: false } }),
    CachedPages: exports.worker({ cache: { enabled: true } }),

    // NO DURABLE OBJECT IS IMPLEMENTED HERE, and that is the point. Counter was
    // created in this Worker by a v1 migration, moved into this map as a
    // lifecycle state (#1004), and was transferred to aadhar-counter on
    // 2026-09-29 (#1006) with its storage; this is the step 5 that removes the
    // tombstone. A Worker that implements a DO gets no preview URLs, so a
    // durable-object entry reappearing here takes them away again, and
    // contract-the-perf-probe fails by name if one does.

    // The two Workflows, by the account-unique name wrangler.jsonc gave them, so
    // existing instances keep their identity across the format change.
    BookingWorkflow: exports.workflow({ name: "cal-booking-expiry" }),
    CensusWorkflow: exports.workflow({ name: "lens-census-host" }),
  },
});

export default defineConfig({
  // Pinned because wrangler picks an account only when the login has exactly
  // ONE, and that stopped being true on 2026-08-07: a second account appeared on
  // this login and every non-interactive wrangler call started failing with
  // "More than one account available but unable to select one". It reads as a
  // credential problem and is not one: nothing was revoked, wrangler simply
  // refuses to guess, and it had been guessing correctly by accident for as
  // long as there was only one candidate. Deleting the other account would also
  // fix it and is the wrong fix: the pin holds however many accounts the login
  // can see, which is the property worth having. Every wrangler caller here is
  // non-interactive (deploy, deploy:version, deploy:promote, dev:remote,
  // routes:check:remote, and Workers Builds), so this belongs in the config
  // rather than in whichever shell someone remembers to export it from.
  // infra.json's `account` block declares the same id and infra:check fails if
  // the two stop agreeing.
  accountId: "1c99acdb6141579023fb97d24261ea58",
  worker,
});
