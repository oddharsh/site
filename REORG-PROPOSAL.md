# Reorg proposal: aadhar.sh repo skeuomorphism

> **REVISION (no-build):** the owner chose to keep the site no-build, so the
> esbuild/`package.json`/`build.mjs`/committed-bundle machinery below is dropped.
> Instead, `holding/_worker.js` becomes a **directory** (`_worker.js/index.js` +
> per-route modules) that wrangler/Cloudflare bundle at deploy via built-in
> esbuild (confirmed: wrangler "traverse[s] all the imports... and generate[s] a
> single entry-point file"). Everything inside the `_worker.js/` directory is
> worker source, not served, so the `_src/` source-leak caveat (footgun #11) goes
> away too. Same module tree, same phases, same `verify-routes.mjs` gating; only
> the bundling is now the platform's job, not ours. Where the text below says
> "esbuild build step" or "committed built artifact," read "Cloudflare bundles the
> `_worker.js/` directory at deploy."

## 1. Executive recommendation

Adopt **Scheme C (skeuomorphic source tree, single bundled worker entry)** as the spine, but ship it in phases where **Phase 1 is a pure documentation + verification pass with zero file moves**, and the build step (the only real risk) lands last and is independently revertable. Scheme C is the only candidate that survived adversarial review, because it gives every route a folder home (the user's actual ask) without betting the production deploy on undocumented Cloudflare behavior the way the trailing-slash flip (Scheme A) and the `functions/` rewrite (Scheme B) both do. The honest cost: the deployed artifact stays one bundled `_worker.js`, so the skeuomorphism is real in the repo but not in the running worker, and we take on a one-time esbuild build step that must be wired into the Cloudflare dashboard, not just committed.

## 2. The key tension, stated plainly

The site has two kinds of routes, and only one kind has a file on disk.

**Static-backed routes** (garage prototypes, lwe explainers, writing `.txt`, photos, `.well-known` docs) already have files. For these, URL-equals-folder is achievable. The catch: they are *already* skeuomorphic at the URL level. `/garage/scroll` is served by `garage/scroll.html` today, and the no-slash URL works *because* the file is flat. Moving to `garage/scroll/index.html` makes the repo prettier but flips ~30 live URLs into 308 redirects (Cloudflare canonicalizes `foo/index.html` to `/foo/`). That regresses the very URLs nav.js, sitemap.xml, llms.txt, and the Speculation Rules all hardcode. So the static "win" is mostly cosmetic and carries real URL churn.

**Worker-generated routes** (`/around`, `/whoareyou`, `/bot`, `/lens`, `/security`, `/updates`, `/restore`, `/reading`, `/rn`, the `/writing` index, and all dynamic `/images/*`) have **no file at all**. A reader who looks for "lens" in the repo finds nothing; the code lives 2700 lines deep in one 4106-line `_worker.js`. This is the bigger readability problem, and it's the one the user feels.

There is no way to make URL literally equal folder for the worker routes without either (a) Pages Functions file-based routing (Scheme B, which the original author explicitly rejected on line 9 of `_worker.js`, and which the audit confirms touches the exact mechanism that caused the recent outage), or (b) fabricating placeholder files (dishonest, and shadowing-prone).

**The honest tradeoff we're taking:** we make the *source tree* skeuomorphic to the URL space (open `_src/lens/handler.js` for `/lens`), keep every public URL byte-identical, and keep the deploy model that production just stabilized on. We trade "the live worker mirrors folders" (impossible without the risky rewrite) for "the repo mirrors folders" (the user's stated goal: *easier to read and access*). Scheme C scores 8/10 skeuomorphism, 8/10 readability, medium risk. Scheme B scores a perfect 10 on skeuomorphism but does not survive review. That 2-point skeuomorphism gap is the premium we pay to not re-break production.

## 3. Recommended target repo structure

```
site/
├── package.json                  # NEW: esbuild devDep + "build" + "verify" scripts
├── build.mjs                     # NEW: esbuild bundle _src/index.js -> _worker.js + copy lens client
├── verify-routes.mjs             # NEW: the route oracle (curl matrix, status+ctype+markers)
├── MAINTENANCE.md                # deploy runbook updated: build is part of the pipeline
└── holding/                      # OUTPUT DIRECTORY — unchanged Pages root, unchanged deploy
    ├── _worker.js                # BUILT artifact, COMMITTED. single bundled entry (unchanged shape)
    ├── _headers                  # UNCHANGED (every path rule still matches)
    ├── _src/                     # NEW source tree. mirrors URL space. NOT served (leading _)
    │   ├── index.js              #   export default {fetch}; canonical-host 301; structured logging
    │   ├── route.js              #   the dispatcher. SAME pathname checks + SAME order as today
    │   ├── lib/                  #   genuinely cross-cutting helpers
    │   │   ├── http.js           #     escHtml, escAttr, errorResp, jsonResp, jsonResponse
    │   │   ├── security.js       #     withSecurityHeaders, SECURITY_HEADERS, appendVary
    │   │   ├── chrome.js         #     shared XP window CSS/HTML shell
    │   │   ├── assets.js         #     serveFreshAsset, ASSETS "https://a/" fetch helper
    │   │   └── const.js          #     THUMB_VERSION, THUMB_SMALL_PX, BOT_UA, NEIGHBORS, RN_FALLBACK
    │   ├── home/
    │   │   ├── handler.js        #   / prerender, HEAD, markdown negotiation
    │   │   └── discovery.js      #   HOMEPAGE_DISCOVERY_LINKS, Link header injection
    │   ├── whoareyou/handler.js  #   /whoareyou + /whoareyou.json
    │   ├── security/handler.js   #   /security
    │   ├── reading/handler.js    #   /reading
    │   ├── updates/handler.js    #   /updates + /updates.json  (reads D1 RESTORE_DB)
    │   ├── restore/handler.js    #   /restore                  (reads D1 RESTORE_DB)
    │   ├── lens/
    │   │   ├── handler.js        #   /lens, /lens/, /lens/fetch, /lens/shot
    │   │   └── client.js         #   SOURCE of lens.js. build copies -> holding/lens.js
    │   ├── writing/
    │   │   ├── handler.js        #   /writing index + /writing/<slug>  (chrome over .txt data)
    │   │   └── notepad.css.js    #   NOTEPAD_CSS
    │   ├── rn/
    │   │   ├── handler.js        #   /rn (302)
    │   │   ├── tracks.js         #   /rn/tracks  (Spotify scraper, SWR, module-scoped caches)
    │   │   └── admin.js          #   /rn/admin + /rn/set (secret-gated)
    │   ├── bot/handler.js        #   /bot
    │   ├── around/handler.js     #   /around + /around/json  (AadharshBot crawl, NEIGHBORS)
    │   ├── agent/handler.js      #   /agent/auth*, /oauth2/*, /.well-known/oauth-*, /auth.md, api-catalog
    │   └── images/
    │       ├── r2.js             #   /images/full/<key>  (servePhotoFromR2)
    │       ├── manifest.js       #   /images/manifest.json  (buildImagesManifest)
    │       ├── listing.js        #   /images/ + /images/full/  (Apache-style listings + 301s)
    │       └── meta.js           #   /images/metadata.json, /images/meta/<stem>.json, thumbnail guard
    │
    ├── index.html  index.md      # UNCHANGED (still the / template + markdown rep)
    ├── lens.js                   # BUILT/COMMITTED, copied from _src/lens/client.js (URL unchanged)
    ├── nav.js  notepad.js  sw.js # UNCHANGED at root (phase 1 keeps shell assets put)
    ├── llms.txt  sitemap.xml  robots.txt  auth.md  bimi.svg  README.md   # UNCHANGED
    ├── .well-known/              # UNCHANGED — RFC-fixed paths, must not move
    ├── writing/                  # UNCHANGED — .txt + posts.json stay FLAT (no nesting; see footguns)
    ├── garage/                   # UNCHANGED — flat .html stays flat (no per-folder index.html)
    ├── lwe/                      # UNCHANGED — flat .html + ask.js
    ├── cars/                     # UNCHANGED — flat content-addressed
    ├── images/                   # UNCHANGED — content-addressed, load-bearing for cache-busting
    └── scripts/                  # UNCHANGED — photo pipeline still writes images/
```

The decisive design choice: **`_src/` is source-side skeuomorphism, and the static trees do NOT move.** This sidesteps both the trailing-slash 308 regression (Scheme A's fatal flaw) and the `functions/` shadowing footgun (Scheme B's fatal flaw). The repo reads like the sitemap; the served URLs never change.

## 5. Phased migration plan (low-risk first, each phase independently shippable)

Each phase ends with the same gate: **push, run the route oracle, confirm every route returns its expected status + content-type, confirm the deploy log uploaded a Function (not static-only). Only then start the next phase.** Work on a branch off `main` until each phase's cutover.

### Phase 0 — Build the regression oracle (no repo change, pure safety net)
Write `verify-routes.mjs`: curls every route, asserts status + content-type + a body marker. Run it against **production now** to capture the golden baseline.

### Phase 1 — Documentation + binding codification (zero file moves, zero behavior change)
Cheapest, highest-leverage, lowest-risk; delivers most of the "easier to read" goal on its own.
- Add `holding/wrangler.toml` codifying the dashboard-only bindings: `RN_KV`, `PHOTOS_R2`, `RESTORE_DB` (D1), plus `pages_build_output_dir`, and the ones the reviewer flagged: `COUNTER` (cross-script DO), `RN_SIGNING_KEY_JWK`, `CF_ACCOUNT_ID`, `BROWSER_RENDER_TOKEN`. Make it a COMPLETE superset before it becomes authoritative. Secrets stay Pages secrets.
- Write `MAINTENANCE.md` / update `README.md` with a route-to-handler map (URL, current `_worker.js` line, what it does). A paper version of the skeuomorphism, shippable in an hour.

### Phase 2 — Build toolchain + pass-through skeleton (proves bundling before any code moves)
Add `package.json` (esbuild), `build.mjs` (`esbuild holding/_src/index.js --bundle --format=esm --outfile=holding/_worker.js` + copy lens client). Create `_src/index.js` + `_src/route.js` as a literal paste of today's worker, handlers still inline. Build, diff against committed `_worker.js`: must be functionally identical.

### Phase 3 — Extract `lib/` (lowest-risk code move, highest reuse)
Move cross-cutting helpers to `_src/lib/*.js` with named exports.

### Phase 4 — Extract one leaf route end-to-end (the pattern proof)
`/bot` (pure static HTML, no env). Validates the per-folder handler contract on the safest route.

### Phase 5 — Extract the rest, one route per commit (strangler-fig)
Order: simple worker pages -> `lens` (+ move client.js, wire build copy) -> `rn` (keep module-scoped caches with their consumer) -> `around` -> `agent`/`oauth` -> `writing` -> `images`. Verify after EACH route.

### Phase 6 — Harden the deploy + prove no source leak
Wire the dashboard build command to `npm run build`, pin Node. Add a pre-deploy guard (assert `_worker.js` exists, non-trivial, contains `export default`). Curl `/_src/route.js` on preview: MUST 404.

## 6. Blast-radius checklist

Because **no public URL moves**, almost everything stays byte-identical; the checklist is to *confirm* untouched.

**Stays identical:** nav.js PAGES array + manifest fetches + Speculation Rules; index.html car paths + footer; sw.js CACHE_VERSION (bump once as precaution) + regexes + SWR list; `_worker.js` route checks (logic verbatim in `route.js`); THUMB_VERSION/BOT_UA (move to `lib/const.js`, values unchanged); `ASSETS.fetch("https://a/...")` convention; `_headers` rules; sitemap/robots/llms; photo scripts.

**Actually changes:** `holding/_worker.js` becomes a built artifact (still committed, same shape); `holding/lens.js` becomes a built copy of `_src/lens/client.js`; `MAINTENANCE.md`/`README.md`/`CLAUDE.md` deploy runbook adds `npm run build`; Cloudflare dashboard build command (outside repo).

## 7. Rollback story

Every phase is a single revertable commit. Bindings, URLs, asset bytes, headers all preserved, so rollback is a pure code revert with no data migration. The committed `holding/_worker.js` is always a valid last-good worker, so even a git deploy that skips the build ships it (closes the static-only outage class). Tag the pre-migration commit. The oracle is the tripwire.

## 8. Do NOT do this (footguns, ranked by blast radius)

1. **Do NOT convert garage/lwe to per-folder `index.html`** — flips ~30 live URLs to 308 redirects (Scheme A's fatal flaw).
2. **Do NOT add a `functions/` directory** — `_worker.js` silently wins, the whole tree becomes dead code under a green build (Scheme B's footgun).
3. **Do NOT add `import` to the current hand-bundled `_worker.js` and deploy as-is** — no build step exists yet; ships a worker that fails to start = static-only outage. Imports only work AFTER Phase 2.
4. **Do NOT nest the writing `.txt` files** — the route guard only intercepts dot-less `/writing/` paths; `.txt` falls through to ASSETS today. Nesting SPA-404s a sitemap-listed canonical URL.
5. **Do NOT move `garage/enc/` without rewriting its 30+ root-absolute refs.** (Moot since garage doesn't move.)
6. **Do NOT move `pretext.lib.js`** — `pretext.html` loads it via relative `import("./pretext.lib.js")`; silent runtime breakage.
7. **Do NOT touch `images/` or `.well-known/`** — content-addressed / RFC-fixed; renaming risks 4-hour edge 404-poisoning.
8. **Do NOT make `holding/wrangler.toml` authoritative before it's a complete binding superset** — a missing `COUNTER`/`RN_SIGNING_KEY_JWK`/`CF_ACCOUNT_ID`/`BROWSER_RENDER_TOKEN` silently vanishes on cutover.
9. **Do NOT add a `Cache-Control` rule to `/*` in `_headers`** — it merges with `/images/*` immutable and the most-restrictive value wins.
10. **Do NOT delete the committed `holding/_worker.js`** as "cleanup" — it's the deployed artifact and the rollback net.
11. **Do NOT skip the `/_src/*` 404 verification on preview before merging Phase 6.**

**One load-bearing caveat:** the `_src/` no-leak property rests on Cloudflare excluding `_`-prefixed *directories* from Pages uploads (documented firmly for special files, not arbitrary dirs). Phase 6's preview curl-404 proves it. Fallback if it fails: move `_src/` to a sibling `site/src/` *outside* `holding/` (output still lands at `holding/_worker.js`).
