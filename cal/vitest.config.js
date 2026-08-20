// Local-only test harness for the cal/ booking worker. NOT deployed: `wrangler
// deploy` bundles only src/index.js + its imports, so nothing under test/ (or
// this config, or the devDependencies) ever ships. Runs the suite inside the
// real Workers runtime (workerd via @cloudflare/vitest-pool-workers) so KV,
// WebCrypto, and the env vars behave exactly as in production.
//
//   pnpm test            # run once
//   bun run test:watch  # watch mode
//
// vitest-pool-workers v0.16 / vitest 4 model: the pool is wired as a Vite
// plugin — `cloudflareTest({ wrangler })` — rather than via test.poolOptions
// (the older defineWorkersConfig/"/config" entry is gone). wrangler.test.toml
// carries the test [vars] block and the BOOKINGS KV
// namespace load automatically (the KV id is ignored locally — miniflare
// simulates it). Secrets (SIGNING_SECRET, ICAL_URL, RESEND_API_KEY) are NOT in
// wrangler.test.toml, so tests that need them pass values explicitly.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
    }),
  ],
});
