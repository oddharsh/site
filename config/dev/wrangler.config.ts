// LOCAL DEV: how wrangler serves the site Worker under `bun run dev`. The
// production tooling is ../../wrangler.config.ts; this is a second value at the
// same seam, and every difference from it is deliberate.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // NO `build`. Dev serves READABLE source, so the edit->reload loop never pays
  // the full minify/hash/precompress build (about 2.8s per edit). A source
  // Worker against the BUILT tree would also 404 its own shell, since the
  // staged shell-assets.ts and csp-hashes.ts maps only agree with hashed refs.
  //
  // `.dev-assets` IS NOT A SOURCE DIRECTORY. The served URL root is composed
  // from five authored directories (public/, src/pages/, src/content/,
  // src/client/, src/styles/), so no single one of them can be pointed at.
  // tools/dev-stage.ts builds this symlink farm over them before wrangler
  // boots. Wrangler serves through the symlinks and an edit to a TARGET is
  // picked up live; a file CREATED in one of the four merged directories (the
  // root, garage, lwe, pixel-peeper) needs a dev restart. dev-stage.ts's header
  // has the merge rule.
  assetsDirectory: "../../.dev-assets",

  // Readable in, readable out: no deploy-time minification, and no source maps
  // to upload, since local stack locations already point at source.
  minify: false,
  uploadSourceMaps: false,

  // As in production: the site's programs read config/.generated instead.
  types: { generate: false },
});
