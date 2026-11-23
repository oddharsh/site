// contract-config.ts: configText, apart from contract-shared.ts because it
// loads lib/site-config.ts, which imports src/worker/lib/parse.ts and
// import()s cloudflare.config.ts. Only the tests that read a config pay that.

import { readFile } from "node:fs/promises";
import { DEV_CONFIG_DIR, devSiteConfig, siteConfig } from "../lib/site-config.ts";

// A Worker config as TEXT, by the file name a test names. The site config is
// cloudflare.config.ts since 2026-09-28 and is read through its legacy-shape
// projection (lib/site-config.ts), pretty-printed, so parseJsonc and the
// regex readers both see the shape they were written against. LOCAL DEV is
// "config/dev", its projection with root-relative paths (the same object
// `bun run dev` boots from .wrangler.dev.jsonc). Any other config is its bytes
// on disk.
async function configText(name) {
  if (name === "cloudflare.config.ts") return JSON.stringify(await siteConfig(), null, 2);
  if (name === DEV_CONFIG_DIR) return JSON.stringify(await devSiteConfig(), null, 2);
  return readFile(new URL(`../../${name}`, import.meta.url), "utf8");
}

export { configText };
