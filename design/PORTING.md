<!-- design/PORTING.md — what the rewrite carries over from the as-built site.
Compiled 2026-07-02 from three full-repo sweeps (client, worker, content+tooling)
plus this session's measurements. Companion to GREENFIELD.md: that file says what
the greenfield looks like; this file says which of the current site's hard-won
tricks and which of its voice survive the move, verbatim. Organized by the moment
the user feels it, because "snappy" is a per-moment property. -->

# The porting manifest

Two kinds of cargo: the **snappiness kit** (tricks, each tagged with where it
lives today and where it lands in the greenfield), and the **voice pack**
(flavortext and content that port verbatim; the rewrite changes the vessel,
never the copy).

## 1. The first paint (cold load)

| trick | today | in the rewrite |
|---|---|---|
| Inline critical geometry at HIGHER specificity than the deferred shell, so first paint is already the windowed layout and nothing pops when shell JS lands | index.html ~813 + every page (the teardown's biggest perceived-speed fix) | the ~2KB inline critical-chrome subset; keep the specificity trick so a stale cached luna.css can never cause a pop |
| `html`-level Bliss gradient present at parse time so cross-doc View Transitions never flash white | index.html:151-171 | inline critical subset + solid `#3A6EA5` paint-behind |
| Scrollbar gutter reserved at first paint (`padding-right: 28px !important` beats the shell's later rule) | index.html:835 | same trick, luna.css + inline |
| 12 pre-reserved aspect-ratio grid slots; layout is final before any data arrives; CLS 0 | index.html:920-940 | unchanged; slots are real `<picture>` markup so the preload scanner sees slot 1 |
| Slot 1 `loading=eager fetchpriority=high`, slots 4-12 lazy + `decoding=async`; the LCP is DESIGNED, not discovered | index.html:939,1047 + home.js:236 | unchanged |
| In-document `<link rel=preload>` instead of HTTP Link headers (a stale Link header replays the wrong random photo) | home.js:224-239 | unchanged; 103 hints carry only the 4 immutable shared assets |
| Zero font bytes; local stacks only | everywhere | law; add `font-size-adjust: 0.52` for Linux fallbacks |
| Heavy inline script at END of body (the parser blocks on inline JS; below-script content painted late until it moved) | index.html:1299-1305 lesson | moot for shell.js (external, defer) but stays the rule for any inline block |

## 2. The hop (navigation, the McMaster moment)

| trick | today | in the rewrite |
|---|---|---|
| bfcache-first discipline: `no-store` banned, dynamic docs `private, no-cache`; back/forward is ~0ms on every engine | _headers + worker handlers | law (GREENFIELD "no-store goes from lesson to law") |
| Speculation rules with SIDE-EFFECT-chosen exclusions (prerender fires crawls, ticks counters, burns fingerprints) | index.html:1250-1297, every page | ported; GET purity shrinks the denylist to /whoareyou + /lens* |
| Directional View Transitions: pageswap/pagereveal compare activation indexes to tag axp-open vs axp-close, so Back animates the window closing and Forward animates it opening | nav.js:34-47 | port as-is; this is the subtle gem that makes the desktop metaphor read on history traversal |
| Close-button upgrade: plain href for cold arrivals, history.back() when you came from home, so close rides bfcache instead of re-rendering | nav.js initCloseBack + histnav canGoBack/canGoForward sync | ported into shell.js |
| Internal-scroller position: sessionStorage save on scrollend, restore ONLY on reload (fresh navs start at top; back/forward left to bfcache) | nav.js rememberScroll | ported |
| SW static routing to skip service-worker boot on network-only paths | sw.js:87-102 | N/A if the no-SW bet holds; if field data reverses that bet (GREENFIELD risk 2), this comes back with it |
| Run palette lazy-loads its 146-photo destination list on first open, never on page load | nav.js Run palette | ported; the /run fallback page bakes the list statically |

## 3. The hover (interaction)

| trick | today | in the rewrite |
|---|---|---|
| Cursor-follow via CSS custom props + `translate(clamp())`: pointermove writes two vars, no rAF, no getBoundingClientRect, edge-clamping in pure CSS | index.html:581-621 | OWNER-KEPT for ALL pointer tips (re-ruled 2026-07-03 after the anchored-hover experiment rolled back; the album art glides like the camera back) |
| `will-change: transform` as an earn-it hint: promoted on tooltip open, released on close | index.html:1683-1699 | ported with the follow loop |
| Scroll suppression + 60ms settle + `elementFromPoint` retarget (fixed tip + wheel scroll = cursor never moves, no pointerover fires) | index.html:1703-1764 | ported with the follow loop |
| Touch gating as a media query: `@media (hover: hover)` retires the synthetic-touch-hover bug | index.html tooltip IIFE (JS check today) | promoted from JS check to pure CSS gate |
| Keyboard fallback: anchor positioning + `position-try`, gated on `CSS.supports("position-area: bottom")`, fires only for :focus-visible | index.html:1795-1824 | ported; stays KEYBOARD-ONLY (the promote-to-primary experiment was rolled back by owner ruling 2026-07-03) |
| On-demand dns-prefetch: inject hints for Spotify CDNs on FIRST hover, once per session; visitors who never hover pay nothing | index.html:1336-1356 | ported as the pattern for any third-party media |
| Lazy-fetch with in-flight sentinel + self-healing (`map[k]=null` marks in-flight; failure deletes the sentinel so the next hover retries) | index.html:1452-1482 | the EXIF use dies (data bakes at encode time) but the pattern ports for any lazy data |
| Chunked list rendering: ~8 rows per `scheduler.yield()` (front-of-queue resume), setTimeout(0) shim | index.html:1140-1154 | ported for the stand-down fetchers + demos |
| Temporal discipline: EXIF wall-clock via PlainDateTime (never shifts per viewer), upload instants via toZonedDateTimeISO; 0.4KB Date branch | index.html:1366-1400 | ported into the upload-time bake (the bake must apply the same rule) |
| Histogram canvas hints: `willReadFrequently: true`, lazy single canvas, 64-bin Rec.709 luma | index.html:1410-1451 | dies at runtime; photo-histograms.py (parked, already computes 64-bin RGB+L) resurrects at UPLOAD time, pointed at the shipped JPG thumbnail so measure-what-you-see honesty survives. Bins + precomputed SVG path land in meta/<stem>.json; the RGB channels the client compromise dropped come back free. Deploy-time cost: zero |

## 4. The data (freshness nobody waits for)

| trick | today | in the rewrite |
|---|---|---|
| Two-key SWR: persistent value + `:fresh` TTL sentinel; stale serves instantly, rebuild rides ctx.waitUntil; empty-rebuild guard protects good stale data | lib/cache.js swrKV (just consolidated from 4 hand-rolled copies) | the cron lanes' cache shape; the guard is now a built-in option |
| Stream-overlap reads: fire per-request reads concurrently, await them INSIDE the late HTMLRewriter handler so they overlap the streaming body and never gate TTFB | home.js:69-72 (the counter) | the counter leaves the document (hit.svg) but the trick ports for ANY per-request data on the streamed homepage |
| SSR + stand-down client fallback: ~30 lines that detect "already populated" and quit; catches cold KV, stale HTML, edge hiccups | index.html:1020-1159 | invariant on every dynamic surface (`data-ssr` stamp) |
| Bad-cached-response retry: entity-looks-empty detect, then one retry with cacheTtl:0 + cache-busting query | rn.js:264-313 | ported into the cron scraper |
| The playlist-listing fetch always bypasses the CDN cache; near-immutable track/artist embeds keep 24h | rn.js (this week's staleness fix) | ported; the cron thinks per generation |
| Outbound deadline discipline: AbortSignal.timeout on every crawl/scrape (2-5s), failures degrade to error rows | around.js, rn.js, whoareyou.js | law for every cron lane |
| cachedRender: caches.default with 200-ONLY puts (the 404-poison scar), honest TTLs (deploys do not flush), x-edge-cache/x-photo-cache observability headers | lib/cache.js | ported for the few per-request renders that remain |
| ?bust=SECRET evicts KV AND the edge entry | reading.js | ported per cron lane |
| 404 cache-control clamp under /images/* (a miss must never inherit the immutable rule) | index.js (the one guard GPT's cleanup kept) | ported; content-hashed image URLs make it belt-and-suspenders |
| Counter purity: HEAD never ticks, verified bots peek, prerender ticks exactly once on activation | home.js + counter.js | already the hit.svg design |

## 5. The long game (what keeps it snappy in year 3)

| trick | today | in the rewrite |
|---|---|---|
| The route oracle: 43 curl assertions (status + content-type + body markers) gating every deploy | verify-routes.mjs | ported; grows the constitution greps (motion, GET purity, byte ceilings) |
| bump-version.sh: one script bumps the version AND inserts the D1 checkpoint both /updates and /restore read, so the changelog cannot drift | scripts/bump-version.sh | keeps only the deploy-log insert (no SW to bump); the D1 table IS content, port the history |
| Build tripwires: the deploy fails if minification eats a load-bearing string | build.mjs | ported; every transform gets a tripwire |
| Readable-source twins + banner pointers (`/nav.src.js`) | build.mjs | ported (`/shell.src.js`) |
| Measure at the compression the page actually gets (q11 for static, ~gzip for per-request) before believing any byte win | this session's lab | doctrine |

## 6. The voice pack (ports verbatim)

Flavortext is content. The rewrite may re-house these lines; it may not rewrite them.

- **Window titles as paths**: "aadhar.sh/garage/bytes on the wire" in every title bar; boxed `_ □ ×`; close buttons titled "back to aadhar.sh".
- **/writing**: "Notes, in flux", "editable by nature, ephemeral by nature", reload-restores-canonical; the 404 note "(not found).txt — This note doesn't exist yet. Maybe I haven't written it."; the F5 timestamp; folder status bar counting documents + characters.
- **/around**: "A peek at what folks in crypto VC are up to", "curious, not competitive", the latency leaderboard with errors sinking to the bottom, "Last crawl:" meta box, the signed-crawler explainer linking the JWKS.
- **/images/ + /images/full/**: RETIRED BY OWNER DECREE (2026-07-02); the Run palette + hover preview supersede them, and the mod_autoindex pastiche dies with the handlers. The one line that must survive is the doctrinal joke: `<address>handwritten worker at aadhar.sh</address>` relocates to the /photos archive footer (the surface that replaces the listings), and manifest.json gains an `"_address"` field so the machine surface keeps the signature too. Deletion is gated on the mitigations in GREENFIELD (301s + machine-index discoverability).
- **/whoareyou**: System Properties framing + the nothing-logged, no-third-party privacy stance (and the honesty rule that spawned it: never advertise capability the site doesn't serve).
- **/updates + /restore**: Windows Update and System Restore skins over the REAL deploy log; the "You are here" banner; the running build number.
- **/bot**: the crawler methodology + ethics page; robots.txt Content Signals; llms.txt; auth.md; the .well-known cards. The agent surface is part of the site's manners.
- **/lens**: "The Other Web", the IE6 address bar with the globe, honest 503-to-reader fallbacks.
- **Garage**: the mule-gallery metaphor and hall of fame (the Ultima GTR + Saab Paddan photos, the Top Gear lore credit), status chips (shipped/watching/sketch/dead), "the failures stay parked next to the wins", "shape: … · added …" metadata lines, the 2-engine graduation rule stated on /garage/horizon, and every per-demo `.unsupported` honesty line.
- **lwe**: the MSN Messenger buddy-list idiom; the photo-CAPTCHA on /lwe/ask.
- **Empty/error states**: greyed period-correct panels ("Now Playing is unavailable") with `cursor: progress`; never skeletons, never shimmer.
- **Easter eggs**: the Run palette's `confetti 🎉` (Raycast), the traffic-cone favicon, the counter odometer, per-section favicons.
- **View Source as product**: the homepage's essay comments ship; minified files open with "minified at deploy - readable source: /<name>.src.js"; the stylesheet ships commented.
- **Credits**: jry.io/bagel (Jacob Young) on /coffee; photo credits on the mule gallery.

## 7. The design-system contract (CSS alignment)

The rewrite's luna.css is an ARRANGEMENT of the design system, never a fork of it.
Verified 2026-07-02: `design/tokens/` and the aadhar-sh-design skill package are
byte-identical, so there is one source of truth with a packaged mirror.

- `design/tokens/` (colors, bevels, fonts, typography; 115 properties) folds into
  luna.css UNMODIFIED as the `tokens` layer. luna.css derives; it never redefines.
- Theming stays knob-based: `--hue-luna` / `--hue-chrome` / `--chroma-luna` /
  `--chroma-chrome` + the semantic hue knobs. Relative color syntax only for
  state derivations, with literal fallbacks.
- Radii only via `--radius-*` (control 0 / title 3px / gel 3px / window-top 8px);
  bevels only via `--bevel-*` / `--frame-window`; gradients via `--grad-*`.
  Deploy greps enforce: no radius/bevel/gradient literals outside the tokens.
- Fonts: `--font-*` stacks ship; the `src: local()` @font-face blocks stay
  reference-only (house rule: never inlined into a served page). Zero font bytes.
- New primitives the greenfield wants (e.g. `font-size-adjust: 0.52`) land in
  `design/tokens/` FIRST, then flow into luna.css, so the skill package and any
  future surface (coffee/cal, mocks) inherit them too.

**The encoder recipe ports verbatim** (it is content, not incidental). Thumbnails stay dual-tier squares: JPG universal fallback via `cjpegli -q 82 -p 2` (jpegli, q82, progressive) with EXIF baked in losslessly by `jpegtran` before encode then stripped; AVIF primary via `avifenc -q 63 --speed 4 --yuv 420` (`--yuv 400` for grayscale), `--ignore-icc/exif/xmp`, `sips formatOptions 60` as the no-avifenc fallback. Two tiers, 600px desktop + 400px mobile. jpegli stays the encoder (~25% under mozjpeg at indistinguishable quality). The rewrite changes the render pipeline (histogram/EXIF bake, hover engine), never the pixels: same bytes on the wire, so the measured tier sizes (~22KB / ~12KB avif, ~38KB jpg) hold.

**The encoder recipe ports verbatim** (it is content, not incidental). Thumbnails
stay dual-tier squares: JPG universal fallback via `cjpegli -q 82 -p 2` (jpegli,
q82, progressive) with EXIF orientation baked in losslessly by `jpegtran` before
encode then stripped; AVIF primary via `avifenc -q 63 --speed 4 --yuv 420`
(`--yuv 400` for grayscale), `--ignore-icc/exif/xmp`, `sips formatOptions 60` as
the no-avifenc fallback. Two tiers, 600px desktop + 400px mobile. jpegli stays
the encoder (~25% under mozjpeg at indistinguishable quality). The rewrite
changes the render pipeline (histogram/EXIF bake, hover engine), never the
pixels: same bytes on the wire, so the measured tier sizes (~22KB / ~12KB avif,
~38KB jpg) hold.

**Encoder A/B, run 2026-07-02 (aom vs SVT-AV1 mainline vs SVT-AV1-PSYEX), for the
record.** Built PSYEX from source + a custom libavif to test it properly; swept all
three with their still-image tunes and judged size-matched zoom crops on a color
Fuji frame and a Leica monochrome. Findings: (1) at byte parity all three are
visually indistinguishable at the 600px tier; (2) mainline SVT (tune iq) lands
~6-7% under aom at parity, 6.3% across a 148-photo fleet run; (3) PSYEX matches
mainline byte-for-byte and adds nothing here, because its still-picture work
already merged upstream (mainline 4.0 tune iq; libaom >= 3.13 defaults to TUNE_IQ
for stills inside libavif, so production aom was already still-tuned); (4) SVT is
4:2:0-only, so monochrome frames would lose their yuv400 tier under any SVT path.
RULING: the recipe above stays aom for now; PSYEX is refused (source-build burden,
3.0.2 base, zero measured gain). The mainline-SVT option (~6% on color thumbs,
brew-only dep, keep aom yuv400 for mono) is PARKED with a bundling condition: only
worth its re-encode + re-download cost if executed together with the blueprint's
content-hashed-image migration, one cache invalidation instead of two.

**Content that ports as data**: the 146 photos (3 tiers + full-res masters + EXIF incl. Fuji recipes + alt.json captions), writing/*.txt + posts.json, the playlist + artist caches, all 24 garage/lwe essays with their live demos, the D1 checkpoint history, cars/ tooltip photos, sitemap/robots/llms/bimi/JSON-LD identity graph.

## 8. The migration ledger (audited 2026-07-02: deployed vs wave-1 tree vs blueprint)

**Route parity, verified mechanically.** Every branch of HEAD's route() maps 1:1
onto the wave-1 ROUTES/PREFIX tables + allowlist; oracle 42/43 against the staged
tree (the miss is the empty local R2, not a route). Wave-1 also fixes two real
HEAD bugs: empty SWR rebuilds can no longer pin over good stale data, and 304
revalidations no longer get converted to 404s by the old content-type gates.
One deliberate reversal to decide at reconciliation: /images/*.avif returns to
worker-first (for the 404 cache-clamp), undoing the edge-direct cut shipped
2026-07-01; the clamp wins until content-hashed /i/* URLs land, then avif goes
edge-direct again permanently.

**Owner rulings (found by the audit, absent from the blueprint): all closed.**
1. RULED (owner, 2026-07-02): the tray SOUND PACK is KEPT. GREENFIELD's refusal
   priced "commissioned sound-alikes, 36KB"; the deployed pack is 0-byte
   Web-Audio synthesis (nav.js), no recordings, default-muted. It joins the
   shell.js ledger (~1.2KB raw) and stays opt-in via the tray toggle.
2. RULED (owner, 2026-07-02): the System Properties tray popout and the Windows
   Update balloon are KEPT; both added to the shell.js ledger (~0.4KB each) and
   /whoareyou.json + /updates.json stay served.

**Seven migration duties the deletions impose:**
1. DONE (2026-07-03, v136): /sw.js is the unregister stub (skipWaiting; delete
   all caches; claim; unregister) and all 24 registration snippets left in the
   same deploy. The stub must keep serving 200 for >= 1 year (_headers pins it
   max-age=0 must-revalidate; the oracle asserts the 200 + "unregister" marker).
2. DONE (2026-07-03, same commit): build.mjs dropped sw.js from SHELLS (the
   stub ships readable, no twin, no CACHE_VERSION tripwire) and bump-version.sh
   now derives vnum from SELECT MAX(vnum) in D1 and touches no file.
3. IN EFFECT: /nav.js + /notepad.js keep serving 200 through the stub window
   (old SWR caches return the cached copy on 404 forever); 410 only after.
4. DONE for the hash half (2026-07-03): /i/<stem>.<hash8>.<ext> serves the 438
   tier files immutable + edge-direct (OUT of the allowlist), hashes.json +
   scripts/hash-thumbnails.sh feed the manifest bake, /images/<thumb> is the
   301 layer (worker-first, known stems redirect, unknown still 404-clamp),
   every consumer (home SSR + inline fallback + /photos + masonry) reads
   manifest URLs verbatim with an abs() shim so a stale pre-hash manifest
   can't break the cutover window, and add-photos.sh hashes new tiers + busts
   value AND :fresh sentinel. THE SVT RE-ENCODE WAS SPLIT OUT, deliberately
   breaking the bundling condition: the A/B's parity crf didn't survive the
   session, and re-deriving it inside the atomic cutover would have stacked an
   unverified fleet re-encode on the riskiest migration. The bundle's economics
   also softened: with hashed URLs a later re-encode invalidates per file and
   costs returning visitors only the thumbs they actually browse, not a global
   re-download. SVT stays PARKED with its own checklist: re-derive parity crf
   (sweep 4 crfs on ~10 photos against current aom sizes), fleet-encode color
   thumbs via ffmpeg/libsvtav1 tune=iq (mono keeps aom yuv400 bytes), visual
   spot-check at 2x, then hash-thumbnails.sh + manifest bust does the rest.
5. DONE (2026-07-02, v133), amended: the footer is <img src="/hit.svg"> + the
   prerenderingchange beacon, but the store stayed the Counter DO (hit.svg
   ticks it directly), which deleted the KV-seeding step and kept increments
   atomic. The COUNTER binding therefore stays; COUNTER_SEED can retire once
   the DO's self-seed is confirmed moot.
6. IN EFFECT (hit.svg, /photos, /run all registered 3x): every NEW route needs
   wrangler allowlist + index.js ROUTES/PREFIX + verify-routes.mjs.
7. DONE (2026-07-02): no-store -> private,no-cache on /updates + /restore keeps
   them origin-fresh (the owner's freshness intent) while restoring bfcache
   eligibility. The balloon's /updates.json stays no-store (subresource, no
   bfcache stake).

**Before -> after (br wire bytes, measured live 2026-07-02; blueprint = projected):**

| surface | deployed (measured) | wave-1 | blueprint target |
|---|---|---|---|
| shell, first visit | nav.js 20,379 + sw.js 977 | identical | luna.css ~9K + shell.js ~3.1K + icons ~3K (+ bliss 24K once); 0 on repeat |
| homepage | 31,425 (one draw) | identical | ~14K fly, 17K drift ceiling |
| essay (garage/wire) | 11,077 | identical | 5-10K (q11) |
| /writing | 5,566 | identical | 3-6K |
| /reading | 14,230 | identical | 4-7K |
| /around | 6,415 | identical | 4-7K |
| /whoareyou | 7,155 | identical | ~4K |

**TTFB medians (fresh connection, ~70ms handshake floor, one colo):** / 98ms;
static garage 80ms; /writing edge-hit 90ms / miss 114ms; /reading hit 79ms;
/updates 114ms (no-store + D1 per request); /whoareyou 74ms. Wave-1: identical
(same render paths and headers). Blueprint (PROJECTED): cold-4G choreography
TTFB ~260ms / FCP <=600ms / LCP <=1000ms p75; warm hops 100-250ms on Safari and
Firefox, ~0ms prerendered on Chromium, back/forward ~0ms bfcache everywhere.

**Shell rewrite phase ledger (task 9, started 2026-07-03):**
- PHASE A SHIPPED (v140): /luna.css extracted from nav.js's injected <style>
  with design/tokens/ folded in verbatim (fonts.css reference-only). Present
  at parse time, cacheable independently of nav.js (107KB -> 77KB raw), same
  cascade order via link-after-inline-style, fallback link injection for
  stale HTML. Parity verified on every page class; oracle 54/54.
- PHASE B SHIPPED (v141): the desktop is static markup in every document
  (wallpaper div after <body>, icons + full taskbar before </body>), CLS 0,
  curl-able, JS-off visible. scripts/gen-desktop-partial.mjs GENERATES the
  partial from nav.js's own data blocks (evaled from source, so no silent
  drift), writes lib/desktop.js for lunaPage + writing, and patches the 27
  static pages between idempotent markers. nav.js builders are
  adopt-or-build (wireTaskbar binds behavior either way; buildIcons replays
  localStorage positions over shipped defaults). Deliberate deltas: start
  orb is <a href="/run"> (the no-script ladder, intercepted when JS runs),
  sound toggle ships hidden until wired, clock ships empty, tray popup ARIA
  arrives with wiring. Costs ~3KB br per document. The Run dialog stays
  lazily built (invisible pre-open; /run covers JS-off).
- PHASE C SHIPPED IN PART (v142): print coverage (strip the OS, flatten the
  window into a document) + forced-colors coverage (the engine strips
  backgrounds/bevels itself; luna.css adds only the boundaries flattening
  can't infer). Reduced-motion was already covered. DEFERRED, each its own
  future unit needing side-by-side review: dialog-element Run, native
  ::-webkit-scrollbar replacing the JS scrollbar widget, CSS resize:both
  replacing the JS grip. REJECTED for this site's shape: checkbox minimize
  (one window per page; nothing to minimize INTO) and popover Start (no
  Start menu exists; Start IS Run, and the /run ladder shipped in B).
- TOOLTIP RE-RULING (owner, 2026-07-03, v142): the anchored-hover
  experiment from the task-8 pass shipped and was rolled back the same
  day. Pointer tips ALL cursor-follow again, instantly — gliding the album
  art with the cursor is the site's identity, same as the camera back, and
  the 500ms cold-hover delay read as lag. Anchor positioning survives as
  the KEYBOARD path only (its original role). The baked-histogram half of
  task 8 is untouched and stays.
- PHASE D (open): the inline chrome dedup — pages drop window-chrome rules
  luna.css could carry (index.html's copy, xpChromeCss's overlap). Needs a
  unified chrome audit first: per-page hand-tuned diffs mean a shared rule
  could clobber deliberate variation. The homepage keeps its soul inline
  per the blueprint's critical-subset rule regardless.
- shell.js NAMING: nav.js keeps its URL (old HTML references it); it now IS
  the blueprint's shell.js in role — wiring, not construction — name last.

**What a returning visitor notices.** Wave-1: nothing (forensic deltas only: a
missing thumbnail serves the platform 404 body, and static hits stop emitting
Workers Logs lines). Blueprint cutover: one re-download (~38KB shell + whatever
re-hashed thumbs they browse), the listings 301 to /photos, track/artist tips
anchor at the row instead of following the cursor (the photo camera-back still
glides), /around stops advancing its own clock (a cron does), and warm hops land
at 100-250ms or prerendered-instant.
