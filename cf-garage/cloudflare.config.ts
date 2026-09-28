// cf-garage's Worker config, in Wrangler's EXPERIMENTAL TypeScript format.
//
// This replaced `wrangler.toml` on 2026-08-23. It is the first config in this
// repository on the new format, and cf-garage was chosen precisely because it is
// the cheapest place to be wrong: a demo Worker behind /garage/cf/*, deployed by
// hand from this directory, whose failure costs a live demo rather than the site.
//
// EVERY COMMAND THAT READS THIS FILE MUST PASS `--x-new-config`. The flag is
// `hidden: true` in wrangler 4.124.0 and `@cloudflare/config`'s own README says
// "not yet stable enough for external use — APIs may change without notice", so
// treat the shape below as something that will move under us. Deploy with:
//
//     cd cf-garage && bun x --no-install wrangler deploy --x-new-config
//
// `--config`/`-c` is REFUSED alongside the flag ("--config is not supported with
// --experimental-new-config"), because the loader reads cloudflare.config.ts from
// the CURRENT WORKING DIRECTORY. That is why CI's step keeps its
// `working-directory: cf-garage` and drops the `-c wrangler.toml` it used to pass.
//
// BUN STILL RUNS THIS, which was the condition the conversion had to meet.
// Measured 2026-08-23 on wrangler 4.124.0, and the two invocations differ:
//
//     bun x --no-install wrangler deploy --dry-run --x-new-config   loads, deploys
//     bun ./node_modules/wrangler/bin/wrangler.js ... --x-new-config   REFUSED
//
// The refusal is real and it names itself ("cloudflare.config.ts loading is not
// supported on Bun. Please use Node.js v22.18.0 or higher."), so it looks like a
// blocker until you notice which door it comes through. `bun x` and `bun run`
// resolve node_modules/.bin/wrangler, whose `#!/usr/bin/env node` shebang hands
// the process to node; only invoking wrangler's entry FILE under bun puts bun in
// front of the loader. Every invocation in this repo already takes the first
// path (gotcha 38 pinned tool spawns to node, and .github/deploy-wrangler.sh runs
// the release under node for both trees), so nothing about bun changed here.
//
// WHAT IS NOT EXPRESSIBLE, and it cost nothing: `[dependencies_instrumentation]
// enabled = true`. The new schema has no field for it and `unsafe` carries only
// `metadata` and `capnp`, so the line could not come across. It was a no-op
// anyway — wrangler reads it as `config.dependencies_instrumentation?.enabled
// !== false`, so an ABSENT block collects package dependencies exactly like an
// explicit `true` does. Verified by reading wrangler's own upload path rather
// than by dry-run, since a dry run never reports it.
// THE `cf` CLI RUNS HERE since 2026-09-28, the day Cloudflare launched it as
// wrangler's successor. It was trialled on 2026-09-08 and refused for two
// reasons, and both are resolved, one by us and one by them:
//
// 1. `cf build` wants a dev server in THIS project's manifest ("A project must
//    declare exactly one of the following in its manifest") and does not walk
//    up to the workspace root. package.json now names the root's exact wrangler
//    URL, which bun links to the same store entry, and `tools/check-wrangler.ts`
//    became an EQUALITY test to allow it, where it used to fail on any
//    declaration at all.
// 2. `cf deploy --dry-run` no longer asks for a credential. Measured with no
//    token and no login on cf 1.0.0-beta.5: plain and `--prebuilt` both print
//    8.84 KiB / 3.07 KiB gzip and exit 0.
//
// For a JavaScript Worker cf DELEGATES to wrangler ("Delegating to Wrangler"),
// so `cf build` writes the same three files under .cloudflare/output/v0/ that
// `wrangler build --x-new-config --x-cf-build-output` writes, sha256 for sha256.
// cf is a workstation global (`bun add -g cf`), never a tree dependency,
// because its CLI half pins a second Miniflare and Workerd; CI stays on the
// wrangler step above.

// THE HELPERS MOVED AGAIN, and this import is ahead of the wrangler pin on
// purpose. workers-sdk#15914 took them out of `wrangler/experimental-config`
// (which keeps only `defineWranglerConfig`) and published them as `cf/config`,
// in the `cf` CLI package. The wrangler commit after f96458c refuses the old
// import with "does not provide an export named 'bindings'", and because
// gen-runtime-types builds this Worker first, that one line reds lint,
// typecheck and lens-reader along with it (measured 2026-09-28 on 3bdcd0d).
//
// `cf/config` is one line, `export * from "@cloudflare/config/public"`, so this
// imports the package it re-exports. `cf` itself pins its own miniflare and
// workerd for the CLI half, which measured about 580 MB of node_modules (two
// workerd binaries) for helpers that need 0.2 MB plus zod. The generated types
// still name `cf/config`, so config/tsconfig.cf-garage.json maps that
// specifier here. Both pins pass lint, typecheck and the dry-run this way.
import { bindings, defineConfig, defineWorker, exports, triggers } from "@cloudflare/config/public";

// THE SHAPE MOVED UNDER US ON 2026-09-21, which the header above said it would.
// workers-sdk#15713 ("Define experimental Cloudflare configuration with a single
// default export") deleted `defineSettings` and the separate `settings` export
// this file carried from 2026-08-23. The loader now reads `mod.default` and
// nothing else, so the old two-export file failed twice on the wrangler pin
// that carried it: `tsc` with TS2305 on the missing name, and the dry-run with
// "does not provide an export named 'defineSettings'". A `settings` export
// that survived by accident would have been IGNORED rather than refused, so
// the account pin below is on the one object wrangler reads.
//
// The worker is a named const so the default export can be the whole
// configuration (`CloudflareConfig extends Settings`, so `accountId` sits
// beside `worker` and `containers`). The generated types follow that nesting:
// `wrangler types` now emits `UnwrapConfig<typeof default>["worker"]` and
// reads `InferEnv` off that, so the binding names still type `env`.
const worker = defineWorker({
  name: "cf-garage",
  compatibilityDate: "2026-06-16",
  // `new_module_registry` is not date-gated; the argument is at the same key in
  // the root wrangler.jsonc, and every Worker here carries it.
  compatibilityFlags: ["nodejs_compat", "new_module_registry"],

  // `main` is `entrypoint` here, and it is the same file it always was.
  entrypoint: "./src/index.ts",

  // Routes became a fetch TRIGGER, alongside scheduled/queue/email/connect, so
  // "what wakes this Worker" is one list instead of a key per mechanism. The
  // zone key shortened from `zone_name` to `zone`.
  //
  // Intercepts /garage/cf/* ahead of the site Worker, which serves the rest of
  // /garage/*.
  triggers: [triggers.fetch({ pattern: "aadhar.sh/garage/cf/*", zone: "aadhar.sh" })],

  // Workers Logs (free, 200k events/day) plus Workers tracing, which records our
  // custom spans and is what /garage/cf/trace demonstrates. Nesting replaces the
  // `[observability]` / `[observability.traces]` table pair, and
  // `head_sampling_rate` is `headSamplingRate`.
  observability: {
    enabled: true,
    traces: { enabled: true, headSamplingRate: 1 },
  },

  // BINDINGS ARE `env`, which is the change that pays for the whole format: the
  // generated types read `InferEnv` off the default export's `worker`, so the
  // names below ARE the type of `env` rather than a snapshot some earlier
  // `wrangler types` run happened to take.
  env: {
    // Workers AI (the image-captioning demo).
    AI: bindings.ai(),

    // Routes the caption call through AI Gateway. A VAR rather than a const in
    // the source, because the id names a resource this repo cannot create (no
    // deploy path here may mint Cloudflare resources) and a missing gateway
    // FAILS the live demo rather than degrading it. Emptying this string is the
    // off-switch, one line, no code change.
    AI_GATEWAY: bindings.text("default"),

    // Browser Run (the screenshot demo); needs the binding enabled on the zone.
    BROWSER: bindings.browser(),

    // The atomic visitor counter. A DO binding now names the worker and the
    // export it points at, which is the same shape a cross-script binding takes,
    // so a self-binding and a foreign one stop being two different spellings.
    COUNTER: bindings.durableObject({ worker: "cf-garage", exportName: "Counter" }),
  },

  // THE MIGRATION LIST IS GONE, and this is the replacement rather than an
  // omission. `[[migrations]] tag = "v1" new_sqlite_classes = ["Counter"]`
  // becomes a STATE on the export: a bare `{ storage: "sqlite" }` is the created
  // form, and `state` carries "deleted" / "renamed" / "transferred" /
  // "expecting-transfer" when a class moves. Wrangler's
  // `resolveDoLifecyclePayload` sends `{ migrations: undefined, exports }` the
  // moment a config declares DO exports, so this takes the newer exports-based
  // upload path instead of the cumulative tag list.
  //
  // WHAT A DRY RUN CANNOT TELL YOU, and the reason this is written down: whether
  // the API accepts the exports form for a class that already exists under
  // migration tag v1. A dry run never computes a migration at all, so the first
  // real `wrangler deploy` from this directory is the measurement.
  //
  // MEASURED 2026-09-21, and the answer is yes. The first deploy on this format
  // (wrangler 4.136.0 main, pin b168333, version 3706d928) uploaded in 1.25 s,
  // reconciled the trigger, and left the `Counter` namespace and its storage in
  // place: `/garage/cf/counter` answered 18 then 20 across the calls after,
  // where a recreated namespace would have restarted from 0. So the declarative
  // export against a class created under `[[migrations]] tag = "v1"` is
  // accepted by plain `wrangler deploy`. That says nothing about `versions
  // upload`, which this Worker never uses and which refuses DO lifecycle
  // changes on its own path (the DO note in CLAUDE.md). The toml fallback is
  // still one `git revert` away and is no longer the expected outcome.
  exports: {
    Counter: exports.durableObject({ storage: "sqlite" }),
  },
});

export default defineConfig({
  // The account pin is unchanged and load-bearing for the same reason it always
  // was: this Worker deploys from its own directory, so wrangler resolves the
  // account here rather than from the root wrangler.jsonc, and auto-selection
  // only works while the login sees exactly one account (a second appeared
  // 2026-08-07). Must equal wrangler.jsonc's account_id; check-infra.ts fails
  // on drift and reads this file for the value, by a line-anchored regex, so
  // keep `accountId:` on a line of its own.
  accountId: "1c99acdb6141579023fb97d24261ea58",
  worker,
});
