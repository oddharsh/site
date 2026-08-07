# Dependencies

The runtime intentionally has no application framework and no client-side
package graph.

## Node

- Node is pinned by `.node-version` and required by `package.json`.
- `wrangler` is exact-pinned at the root. The two temporary migration adapters
  use the same root executable for dry-run validation.
- `playwright-core` is a development-only browser driver for explicit lab work;
  no build or request path imports it.

The package lock overrides `undici` only while Miniflare's exact transitive pin
lags its security patch. The explanatory note lives beside the override in
`package.json`; remove both when upstream catches up.

## Media toolchain

- `tools/media/zenc/Cargo.lock` pins the zenjpeg encoder graph. Dependabot checks
  `tools/media/zenc` as a Cargo project.
- Workstation and macOS Action tools: exiftool, jq, libavif, mozjpeg, ffmpeg,
  and WebP utilities. They generate committed assets and never ship in the
  Worker.

## Cloudflare services

Bindings are platform capabilities, not npm dependencies. Their contract is
declared in `wrangler.jsonc` and described in `CLAUDE.md`. The Worker uses the
standards APIs supplied by Workers, D1, KV, R2, Durable Objects, Workflows,
Browser Rendering, rate limits, and Analytics Engine.
