// cf-garage's TOOLING settings, the other half of wrangler's experimental
// config. cloudflare.config.ts describes the Worker (bindings, triggers,
// exports); how wrangler BUNDLES it lives here, because the new format splits
// runtime from tooling and `@cloudflare/config`'s schema has no bundling field.
// `--x-new-config` reads both files from the working directory, so the deploy
// command in cloudflare.config.ts's header is unchanged.
//
// Deploy-only, the same pair lens-reader, lwe-ask and the site Worker carry.
// Source maps keep the original stack locations in Workers Logs.
//
// `keepNames` is left at wrangler's default (on). The site Worker turns it off
// for 3.4% of its gzip, and it is safe here too (Counter resolves by export
// binding name), but on a Worker this small the helper calls are not worth an
// argument.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  minify: true,
  uploadSourceMaps: true,
});
