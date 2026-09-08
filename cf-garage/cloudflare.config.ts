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
// THE `cf` CLI WAS TRIALLED HERE ON 2026-09-08 AND CANNOT TAKE THIS WORKER YET,
// for two independent reasons that are both structural rather than polish. It is
// Cloudflare's own (workers-sdk maintainers, MIT, depends on the same Miniflare 5
// wrangler already pulls), and their blog calls it a technical preview and
// explicitly not production-ready. This directory is where it WOULD land first,
// on the same argument that put the experimental config here: cheapest place to
// be wrong, and already on `cf`'s native config format.
//
// 1. `cf build` REFUSES a project whose own manifest declares no dev server:
//    "A project must declare exactly one of the following in its manifest",
//    listing @cloudflare/vite-plugin, wrangler, and the Python and Rust servers.
//    It checks `cf-garage/package.json` alone and does not walk up to the
//    workspace root. Declaring wrangler here is precisely what
//    `tools/check-wrangler.ts` fails on ("package.json must not declare
//    Wrangler; use the root pin"), so satisfying `cf` breaks a required check.
//
// 2. `cf deploy --dry-run` REQUIRES a credential, and wrangler's does not.
//    Measured the same day with no token in the environment: `cf deploy
//    --prebuilt --dry-run` stops at "No authentication token found", while
//    `wrangler deploy --dry-run --x-new-config` prints all four bindings and
//    exits 0. CI dry-runs this config with no Cloudflare credential at all, by
//    the no-write-token rule, so `cf` cannot stand in for that step.
//
// THE SEAM THAT DOES WORK, and it is the interesting half. `wrangler build
// --x-cf-build-output --x-new-config` writes the Build Output API tree that
// `cf deploy --prebuilt` is designed to consume:
//
//     .cloudflare/output/v0/workers/default/{config.json,bundle/index.js}
//
// That config.json carries the name, compatibility date and flags, the fetch
// trigger, all four bindings and the declarative `Counter` DO export. So the
// handoff exists today and only the credential rule stands between it and a
// working `cf` deploy from a built tree. Re-try when `cf` either reads a
// workspace root for its dev server or stops asking for auth on a dry run;
// re-trying on a version bump alone measures nothing.

import { bindings, defineSettings, defineWorker, exports, triggers } from "wrangler/experimental-config";

// `accountId` lives on a SEPARATE `settings` export rather than on the worker,
// which is the one field placement most likely to send you looking in the wrong
// object. The pin itself is unchanged and load-bearing for the same reason it
// always was: this Worker deploys from its own directory, so wrangler resolves
// the account here rather than from the root wrangler.jsonc, and auto-selection
// only works while the login sees exactly one account (a second appeared
// 2026-08-07). Must equal wrangler.jsonc's account_id; check-infra.ts fails on
// drift and reads this file for the value.
export const settings = defineSettings({
  accountId: "1c99acdb6141579023fb97d24261ea58",
});

export default defineWorker({
  name: "cf-garage",
  compatibilityDate: "2026-06-16",
  compatibilityFlags: ["nodejs_compat"],

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
  // generated types read `InferEnv<typeof cloudflare.config.default>`, so the
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
  // real `wrangler deploy` from this directory is the measurement. If it
  // refuses, `git revert` restores the toml and nothing is lost but the trip.
  exports: {
    Counter: exports.durableObject({ storage: "sqlite" }),
  },
});
