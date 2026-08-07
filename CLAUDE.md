# aadhar.sh

This repository builds one personal site and one bounded Cloudflare Worker.
`AGENTS.md` is a symlink to this file; keep one source of truth.

## Working agreement

- Treat `origin/main`, the live origin, remote bindings, and CI as authoritative.
- Start substantial work from a fresh `origin/main` in a named branch/worktree.
- Assume other sessions may use the primary checkout. Inspect status and reflog;
  never absorb, revert, or reformat changes you did not make.
- Keep changes reviewable, run the relevant gates, push a branch, and open a
  draft PR. A branch, commit, PR, merge, uploaded version, and traffic shift are
  distinct events.
- Never deploy or mutate Cloudflare resources merely to validate a change.
- Preserve public URLs, representations, persisted data, and authorization
  behavior unless the change deliberately migrates them and tests the result.
- Generated files come from their canonical source. Do not hand-edit `dist/` or
  the generated discovery cards under `public/.well-known/`.

## Architecture

```text
content/                 prose and durable structured records
assets/                  photographs and study artifacts
src/site/                semantic document renderer and the one stylesheet
src/worker/              typed live routes and scheduled work
src/contracts/           machine-readable tool and crawler contracts
public/                  hand-authored public files and generated agent cards
scripts/build-site.mjs   deterministic compiler
tools/media/             offline photo and study pipeline
dist/                    generated static-asset tree; never authored
```

The build emits complete documents. Ordinary pages load one content-hashed CSS
file and no JavaScript. Pixel Peeper is the sole exception: one route-scoped,
bounded module because concealing and revealing image labels is the subject of
the page. The Worker runs only where headers, live data, writes, or bounded
transformations require it. There is no framework, hydration layer, client
router, webfont, or active service worker. `public/sw.js` remains only as an
unregister stub for old visitors.

`site-manifest.json` is the public page registry. Writing has its own registry
at `content/writing/posts.json`; photographs are keyed by
`content/data/photo-index.json` and `assets/photos/data/hashes.json`. MCP cards,
the agent card, API catalog, and skills are projections of
`src/contracts/mcp.json`.

The visual and performance constitution is [design/BLANK-SLATE.md](design/BLANK-SLATE.md).
The canonical CSS is `src/site/styles/site.css`.

## Commands

```bash
npm ci
npm run build                 # regenerate cards and dist/
npm test                      # compiler and Worker unit/contract tests
npm run perf-budget           # deterministic wire-shape budgets
npm run photos:check          # all 158 photos and their metadata graph
npm run types:check           # wrangler-generated Env stays current
npm run routes:check          # boot production config in-process; 148-route sweep
npm run check-wrangler        # one exact Wrangler pin across all workspaces
npm run infra:check -- --offline
npx wrangler deploy --dry-run
```

Run the full local gate before publication:

```bash
npm run build
npm test
npm run perf-budget
npm run photos:check
npm run types:check
npm run check-wrangler
npm run routes:check
npm run infra:check -- --offline
npx wrangler deploy --dry-run
npx wrangler deploy --dry-run -c cf-garage/wrangler.toml
npx wrangler deploy --dry-run -c lwe-ask/wrangler.toml
```

`routes:check` needs a real loopback socket. A restricted environment may return
`listen EPERM`; that is an environment limitation, not a source failure.
Wrangler may likewise fail to write its user-level debug log while still
completing the requested check.

For local browsing:

```bash
npm run dev -- --port 8790
```

`npm run dev:remote` derives `.wrangler.remote.jsonc` and points supported
bindings at production. It is workstation-only and read/write against live
resources. D1 stays local unless `--d1` is passed deliberately. Secrets cannot
be remoted.

## Site invariants

- Complete semantic HTML is the no-JavaScript behavior, not a fallback.
- Every generated page has one `h1`, a canonical URL, a webmention endpoint,
  security headers, and the shared Explorer information hierarchy.
- Authored pages that advertise Markdown must answer an explicit
  `Accept: text/markdown`; explicit `.md` URLs remain available.
- Writing, Garage, and LWE advertise compiler-generated RSS 2.0 feeds. Their
  XML is build output, never an authored or separately committed twin.
- CSS stays within 8 KiB Brotli. Ordinary documents stay within 24 KiB Brotli
  excluding two named long-form text exceptions. A page may not add a script
  without a measured, reviewed exception.
- Images reserve intrinsic space. Photo URLs are content-addressed and immutable.
- Do not add `innerHTML` from untrusted input. Validate URLs before fetches,
  bound body size, redirect count, deadlines, and private-network targets, and
  obey `robots.txt` for crawler-shaped work.
- Public machine surfaces are read-only unless the human route explicitly owns
  a write. Input schemas use `additionalProperties: false` and bounded limits.
- Preview hosts are `noindex` and default-deny unsafe methods and GET-shaped
  mutations through `src/worker/preview.ts`.
- Calendar uncertainty fails closed. A booking must atomically hold one slot,
  roll back when notification fails, and expire durably when abandoned.
- Webmentions verify that the source publicly links the exact allowlisted target
  and remain moderated before display.
- The Serendipity public pool is read-only. Legacy cookie ingestion and remote
  sync paths intentionally return `410 Gone`.

## Cloudflare boundaries

`wrangler.jsonc` is the production declaration; `wrangler.dev.jsonc` mirrors its
bindings for local work. Keep both aligned. Current state boundaries:

- `RN_KV`: playlist and scheduled public snapshots.
- `BOOKINGS`: calendar snapshot and booking records.
- `PHOTOS_R2`: full-resolution public photo objects.
- `RESTORE_DB`: release history and bounded observation history.
- `SERENDIPITY_DB`: public event pool.
- `SOCIAL_DB`: moderated webmentions.
- `COUNTER`, `BOOKING_SLOTS`, `BOOKING_WORKFLOW`: atomic count/slot state and
  booking expiry.
- `BROWSER`, `IMAGES`, rate limits, and Analytics Engine: bounded live tools.

Required secrets are `ICAL_URL`, `RESEND_API_KEY`, `RN_SIGNING_KEY_JWK`, and
`SIGNING_SECRET`. Add or rotate secrets with the versions command so no traffic
moves as a side effect:

```bash
npx wrangler versions secret put -c wrangler.jsonc <NAME>
```

No deploy path may provision resources. Keep `--x-provision=false` and
`--x-auto-create=false` on every publish command. Resource mutation belongs to
the explicitly confirmed, workstation-only `npm run infra:apply` path.

## Release path

1. Merge a green PR into protected `main`.
2. CI advances the machine-owned `production` branch only to the exact tested
   merged commit.
3. Workers Builds runs `wrangler versions upload`; it uploads a previewable
   version and moves no traffic.
4. A human runs `npm run deploy:promote` to ramp 10% → 50% → 100% while checking
   logs and the site. `--status` and `--rollback` are available.

`npm run deploy` is the explicit straight-to-100% fallback. Never use either
release command as part of ordinary validation.

Stage a release note before merge with:

```bash
./scripts/bump-checkpoint.sh <slug> "<title>"
```

It edits only `content/data/checkpoints.json`. The promotion script records a
staged checkpoint in D1 only after traffic reaches 100%.

## Photo maintenance

See [PHOTO-PIPELINE.md](PHOTO-PIPELINE.md). The short form is:

```bash
cargo build --release --manifest-path tools/media/zenc/Cargo.toml
npm run photos -- "/path/to/photo.HIF" "/path/to/folder/"
npm run photos:check
```

Original HEIF files remain outside git. Committed output is the responsive,
content-addressed thumbnail graph plus allowlisted EXIF, captions, semantics,
fingerprints, and the public index. Never infer a camera recipe from
visual similarity; the exact matcher is grounded in published bytes.
