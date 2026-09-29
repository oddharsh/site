// The TOOLING half of lens-reader's config: how wrangler builds and uploads,
// as opposed to what the Worker is (cloudflare.config.ts). Written by
// `cf migrate` on 2026-09-28 from the toml's top-level keys.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // Deploy-only. Minification measured 2026-08-16: 148.92 -> 113.09 KiB gzip.
  // The aligned parser dependency graph measured 80.56 KiB gzip on 2026-08-20.
  // Source maps preserve original stack locations in Workers Logs; local
  // development still reads the authored modules.
  minify: true,
  uploadSourceMaps: true,
  // `cf migrate` sets this. Left on, `wrangler dev` writes an inferred-Env
  // .d.ts into .cloudflare/types/ that no program here reads.
  types: { generate: false },
});
