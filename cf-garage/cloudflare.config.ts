// cf-garage's Worker config: the demo Worker behind /garage/cf/*, in Wrangler's
// experimental TypeScript format. wrangler.config.ts beside it holds the
// bundling settings.
//
// It replaced `wrangler.toml` on 2026-08-23, the first config in this repo on
// the new format. cf-garage went first because it was the cheapest place to be
// wrong: a failure here costs a live demo, never the site.
//
// EVERY COMMAND THAT READS THIS FILE MUST PASS `--x-new-config` and run from
// this directory, because `--config`/`-c` is refused alongside the flag and the
// loader reads cloudflare.config.ts from the working directory (gotcha 41). The
// flag was `hidden: true` in wrangler 4.124.0, and `@cloudflare/config`'s README
// calls the format not yet stable for external use, so expect the shape to
// move. Workers Builds deploys this Worker through .github/deploy-wrangler.sh
// with WRANGLER_CWD=cf-garage, which adds the flag (docs/MAINTENANCE.md,
// "Auxiliary Workers deploy themselves"). By hand:
//
//     cd cf-garage && bun x --no-install wrangler deploy --x-new-config
//
// The loader refuses bun ("cloudflare.config.ts loading is not supported on
// Bun"), and only one door reaches it. Measured 2026-08-23 on wrangler 4.124.0:
//
//     bun x --no-install wrangler deploy --dry-run --x-new-config   loads, deploys
//     bun ./node_modules/wrangler/bin/wrangler.js ... --x-new-config   REFUSED
//
// `bun x` and `bun run` resolve node_modules/.bin/wrangler, whose
// `#!/usr/bin/env node` shebang hands the process to node. Only running
// wrangler's entry FILE under bun puts bun in front of the loader (gotcha 38).
//
// NOT EXPRESSIBLE, at no cost: `[dependencies_instrumentation] enabled = true`.
// The new schema has no field for it and `unsafe` carries only `metadata` and
// `capnp`. Wrangler reads it as `config.dependencies_instrumentation?.enabled
// !== false`, so an ABSENT block collects package dependencies exactly like an
// explicit `true`. Verified by reading wrangler's upload path, since a dry run
// never reports it. tools/lib/site-config.ts points here for this read.
//
// THE `cf` CLI RUNS HERE since 2026-09-28. `cf build` wants a dev server in
// THIS project's manifest and does not walk up to the workspace root, so
// package.json names the root's exact wrangler URL and `tools/check-wrangler.ts`
// tests for equality. `cf deploy --dry-run` needs no credential: measured on cf
// 1.0.0-beta.5 with no token or login, plain and `--prebuilt` both print 8.84
// KiB / 3.07 KiB gzip and exit 0. For a JavaScript Worker cf delegates to
// wrangler, so `cf build` writes the same three files under
// .cloudflare/output/v0/ as `wrangler build --x-new-config --x-cf-build-output`,
// sha256 for sha256. cf is a workstation global (`bun add -g cf`), never a tree
// dependency, because its CLI half pins a second Miniflare and workerd. Deploys
// stay on wrangler (gotcha 50), and a leftover .cloudflare/output/ makes
// wrangler refuse to deploy from here (gotcha 59).

// The helpers live in `cf/config` since workers-sdk#15914, which left
// `wrangler/experimental-config` with only `defineWranglerConfig`. The old
// import fails with "does not provide an export named 'bindings'", and because
// gen-runtime-types builds this Worker first, it reds lint, typecheck and
// lens-reader with it (measured 2026-09-28 on 3bdcd0d).
//
// `cf/config` is one line, `export * from "@cloudflare/config/public"`, so this
// imports the package it re-exports. `cf` pins its own miniflare and workerd,
// about 580 MB of node_modules (two workerd binaries), for helpers that need
// 0.2 MB plus zod. The generated types still name `cf/config`, so
// config/tsconfig.cf-garage.json maps that specifier here.
import { bindings, defineConfig, defineWorker, exports, triggers } from "@cloudflare/config/public";

// ONE DEFAULT EXPORT since 2026-09-21. workers-sdk#15713 deleted
// `defineSettings` and the separate `settings` export, and the loader now reads
// `mod.default` and nothing else. A `settings` export left behind would be
// IGNORED rather than refused, so the account pin sits on the one object
// wrangler reads.
//
// The worker is a named const so the default export can be the whole
// configuration (`CloudflareConfig extends Settings`, so `accountId` sits
// beside `worker`). `wrangler types` emits `UnwrapConfig<typeof
// default>["worker"]` and reads `InferEnv` off that, so the binding names still
// type `env`.
const worker = defineWorker({
  name: "cf-garage",
  compatibilityDate: "2026-06-16",
  // `new_module_registry` is not date-gated; the argument is at the same key in
  // the root cloudflare.config.ts, and every Worker here carries it.
  compatibilityFlags: ["nodejs_compat", "new_module_registry"],

  // toml's `main`.
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

  // THE MIGRATION LIST IS REPLACED by a STATE on the export.
  // `[[migrations]] tag = "v1" new_sqlite_classes = ["Counter"]` becomes a bare
  // `{ storage: "sqlite" }` (the created form), and `state` carries "deleted" /
  // "renamed" / "transferred" / "expecting-transfer" when a class moves.
  // Wrangler's `resolveDoLifecyclePayload` sends `{ migrations: undefined,
  // exports }` the moment a config declares DO exports, so this takes the
  // exports-based upload path instead of the cumulative tag list.
  //
  // A dry run never computes a migration, so it can't say whether the API
  // accepts the exports form for a class created under tag v1. A real deploy
  // did, 2026-09-21 (wrangler 4.136.0 main, pin b168333, version 3706d928): it
  // uploaded in 1.25 s and kept the `Counter` namespace and its storage, since
  // `/garage/cf/counter` answered 18 then 20 where a recreated namespace would
  // restart from 0. That holds for plain `wrangler deploy` only; `versions
  // upload` refuses DO lifecycle changes (CLAUDE.md, "Release path"), and this
  // Worker never uses it.
  exports: {
    Counter: exports.durableObject({ storage: "sqlite" }),
  },
});

export default defineConfig({
  // The account pin is load-bearing: this Worker deploys from its own
  // directory, so wrangler resolves the account here rather than from the root
  // cloudflare.config.ts, and auto-selection only works while the login sees
  // exactly one account (a second appeared 2026-08-07). Must equal the root
  // cloudflare.config.ts's accountId. check-infra fails on drift and reads the
  // value with a line-anchored regex (AUX_CONFIGS in tools/lib/infra-compare.ts),
  // so keep `accountId:` on a line of its own.
  accountId: "1c99acdb6141579023fb97d24261ea58",
  worker,
});
