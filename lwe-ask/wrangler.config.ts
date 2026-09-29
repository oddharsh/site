// The TOOLING half of lwe-ask's config: how wrangler builds and uploads, as
// opposed to what the Worker is (cloudflare.config.ts). `--x-new-config` reads
// both files from this directory.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // Deploy-only, the same pair lens-reader, cf-garage and the site Worker carry
  // (#992 set it in wrangler.toml the day that file was migrated). Source maps
  // keep the original stack locations in Workers Logs, and `wrangler dev` still
  // reads the authored module.
  minify: true,
  uploadSourceMaps: true,
});
