// LOCAL DEV: what the site Worker IS under `bun run dev`, written as production
// plus an overlay. Everything not named below (bindings, vars, crons, routes,
// run_worker_first, compatibility, secrets, the account pin) is production's,
// spread in, so the two cannot disagree about anything dev does not mean to
// change. The tooling half is wrangler.config.ts beside this file.
//
// It replaced a hand-kept wrangler.dev.jsonc on 2026-10-01. That file copied
// about 165 values out of cloudflare.config.ts, and four separate checks (a
// build warning, a contract test, check-infra, and a dev arm in eight more
// tests) existed only to keep the copy honest. They still let it drift: the
// "41 5 * * *" cron was missing for two weeks, and #876 shipped "/dotfiles"
// without the twin. A spread cannot drift, so all four went with it.
//
// WHO READS THIS TODAY. `bun run dev` runs `cf dev` in this directory, which
// reads the pair natively (tools/dev.ts; package.json here names the root's
// wrangler so cf can find its dev server). COUNTER binds a class in another
// Worker, which neither cf nor a TypeScript config will boot in-process (both
// refuse `-c`), so tools/dev.ts runs aadhar-counter as a second dev process on
// one shared registry, and the binding connects across them. Since 2026-10-05.
// `bun run dev:remote` still reads the projection tools/lib/site-config.ts
// writes to .wrangler.dev.jsonc.
//
// Paths here are relative to THIS directory, because that is how wrangler's
// loader resolves them. The projection rebases them to the repository root.
//
// WHAT THE INHERITED BINDINGS DO LOCALLY, since nothing below restates them:
//   - D1, KV and R2 are LOCAL simulations under .wrangler/state, keyed by
//     name, so /inbox and the webmention endpoint work end to end without
//     touching the remote databases. `bun run dev:remote` is the door to the
//     real ones (tools/gen-remote-config.ts; D1 stays local without --d1).
//   - The rate limiters count locally, so a dev session exercising /lens never
//     spends the production limiter, and overLensBudget fails open anyway.
//   - Spans open and record nothing (span.isTraced is false; there is no trace
//     backend locally), which is the property lib/trace.ts is built around.
//   - BROWSER, IMAGES and AI are remote: production declares them with
//     `dev: { remote: true }`, which only local development reads.
import { defineConfig, exports } from "@cloudflare/config/public";
import prod from "../../cloudflare.config.ts";

// Dev runs the READABLE Worker source. Production names its build-staged copy,
// and build.ts stages the Worker at a path that mirrors its source (CLAUDE.md's
// layout table calls that mirroring load-bearing), so dropping the `.build/`
// prefix IS the source path. Derived rather than typed, so a moved entrypoint
// moves both configs at once; refused rather than guessed if production ever
// stops naming a staged copy.
const STAGED = ".build/";
const prodEntry = prod.worker.entrypoint;
if (!prodEntry?.startsWith(STAGED)) {
  throw new Error(`config/dev: production's entrypoint ${JSON.stringify(prodEntry)} is not under ${STAGED}, so the source path cannot be derived from it`);
}

// Workers Cache is OFF on every entrypoint in dev, so edit->reload never
// observes a stale cached response. Production enables it for CachedPages.
// Mapped over production's exports rather than listed, so a third entrypoint
// added there is uncached here without an edit; Workflows pass through.
const devExports = Object.fromEntries(
  Object.entries(prod.worker.exports ?? {}).map(([name, decl]) => [
    name,
    decl.type === "worker" ? exports.worker({ ...decl, cache: { enabled: false } }) : decl,
  ]),
);

export default defineConfig({
  ...prod,
  worker: {
    ...prod.worker,
    entrypoint: `../../${prodEntry.slice(STAGED.length)}`,
    cache: { ...prod.worker.cache, enabled: false },
    exports: devExports,
  },
});
