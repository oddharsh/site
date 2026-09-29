// The TOOLING half of the site Worker's config: how wrangler builds and uploads
// it. What the Worker IS lives in cloudflare.config.ts beside this file. Both
// replaced wrangler.jsonc on 2026-09-28.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // tools/build.ts runs before every upload or deploy, so `wrangler deploy`,
  // `bun run deploy:direct` and Workers Builds all ship the minified shells +
  // luna.css. In Workers Builds, leave the dashboard's separate Build command
  // blank and set its Deploy command to the `bash .github/deploy-wrangler.sh
  // versions upload` recorded in config/infra.json under `release`. That wrapper
  // runs the installed Wrangler entrypoint under Node, which Wrangler requires,
  // and adds `--x-new-config` because this file exists; Wrangler then owns this
  // one build instead of running it twice. Local dev must NOT use this config (it
  // would pay the full public/ -> .build copy on every reload); wrangler.dev.jsonc
  // uses source code and staged .dev-assets.
  build: { command: "bun tools/build.ts" },
  assetsDirectory: ".build/public",

  // Deploy-only. Measured 2026-08-16: 274.45 -> 227.67 KiB gzip (17.0% off).
  // Keep the local-dev twin readable; uploaded source maps retain original stack
  // locations in Workers Logs without shipping to clients.
  minify: true,
  uploadSourceMaps: true,
  // OFF, against wrangler's default. esbuild's keep-names injects a helper call
  // per function and class so `fn.name` survives minification, and the pinned
  // wrangler turns it ON for you (`keepNames: config.keep_names ?? true`, in the
  // same options object as `minify` above). Measured 2026-08-28 over two
  // `deploy --dry-run` runs, each reproduced exactly: 715.83 -> 698.63 KiB
  // upload, 244.60 -> 236.18 KiB gzip. That is 8.42 KiB of gzip (3.44%) across
  // 717 helper call sites. Both runs go through node, since bun's zlib-ng gzips
  // ~0.55% heavier (gotcha 38) and would corrupt the comparison.
  //
  // Nothing here reads a function or class NAME at runtime. Every `.name` in
  // src/worker, cal/src and serendipity is a data field, except lens.ts's
  // `e.name === "AbortError"`, which is an Error property keep-names never sets.
  // The Counter DO and the Workflows resolve by EXPORT NAME, which this leaves
  // alone. Source maps keep their names[], so Workers Logs frames stay legible.
  keepNames: false,

  // Left on, `wrangler dev` and `wrangler build` write an inferred-Env .d.ts into
  // .cloudflare/types/; the site's programs read config/.generated instead.
  types: { generate: false },
});
