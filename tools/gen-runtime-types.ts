#!/usr/bin/env bun
// gen-runtime-types.ts — the Workers runtime declarations, generated from the
// PINNED workerd rather than depended on as a package.
//
// WHY. `@cloudflare/workers-types` was 12 of the 29 Dependabot PRs in the
// thirty days to 2026-09-02, each a date-stamped release describing a runtime
// this repo does not yet run on, and each needing the hand relock commit
// (bun run deps:relock). Wrangler ships the same declarations itself:
// `wrangler types --include-runtime` boots the pinned workerd's own types
// worker (workerd/worker.mjs, no network) and asks it for the surface at a
// given compatibility date and flag set. Wrangler's own migration notice says
// the command "supersedes @cloudflare/workers-types" and to uninstall it. So
// the types move when wrangler moves, which is a lane this repo already
// reviews, and they describe the workerd that actually runs the dry-runs, the
// route oracle and the cal harness instead of a newer one.
//
// Measured before switching, 2026-09-02, wrangler 4.127.1 / workerd
// 1.20260828.1: all four Worker programs (site, cf-garage, lwe-ask,
// lens-reader) produced the SAME diagnostics against the generated file as
// against the package, 259 / 0 / 0 / 3, every line identical. The package
// carried 23 names the generated set does not (Buffer, process, setImmediate,
// the Performance* family, two Hyperdrive and one Browser Run shape): none of
// them is referenced anywhere in the tree, which is what an identical count
// proves.
//
// ONE FILE FOR THREE CONFIGS (it was four until cf-garage got its own, below),
// and that is asserted rather than assumed. The
// runtime section is a function of compatibility date and flags, and the four
// Workers here sit on four different dates (2026-05-01 to 2026-07-02) with two
// flag sets. Generated separately, their runtime sections came back
// byte-identical below the header line. This script regenerates the two
// auxiliary configs wrangler can read alongside the site's and FAILS if any
// pair diverges, because that is the day the programs need a file each and a
// silent divergence would type one Worker against another's runtime.
//
// CF-GARAGE GETS ITS OWN FILE, FROM ITS OWN CONFIG, since 2026-09-26. It is the
// one Worker on wrangler's experimental cloudflare.config.ts (gotcha 41), and
// `wrangler types` still refuses `--x-new-config`. What changed is a second
// door: workers-sdk#15778 made wrangler write `.cloudflare/types/index.d.ts`
// itself whenever it reads that config for `dev` or for the build-output
// `build`. The file carries an `Env` INFERRED from the config's `env` block
// (so a binding renamed there and not in the source is a type error without
// any regeneration) plus the runtime surface at cf-garage's own compatibility
// date and flags. So this script runs the cheapest command that reaches the
// door, below, and tsconfig.cf-garage.json includes what it writes in place of
// the site's file.
//
// Measured the day it moved (wrangler 3572193, workerd 1.20260925.1): the
// runtime section at 2026-06-16 + nodejs_compat,new_module_registry is
// BYTE-IDENTICAL to the site's at 2026-06-01 + enable_request_signal,
// new_module_registry (604,981 B each). nodejs_compat adds nothing to the
// generated declarations, since workerd's types describe the Workers globals
// and leave `node:*` to @types/node. So the switch buys the Env, not a
// different runtime, and it will start buying the runtime the day cf-garage's
// date or flags move somewhere the site's do not.
//
// RUNTIME ONLY. `--include-env=false`, because the Env half wrangler would
// write types COUNTER and the two Workflows by importing `.build/src/worker/
// index`, which is build output that does not exist in a fresh checkout;
// src/worker/lib/env.ts's header has the long version of why the site's Env is
// hand-written and checked against wrangler.jsonc instead.
//
// The output is NOT COMMITTED. It is a pure function of the wrangler pin and
// the config, the same argument the Markdown twins and the search index won,
// so `bun run typecheck` runs this first and config/.generated/ is ignored.
// Running tsc on one of these programs without it fails on the missing include
// rather than silently checking against nothing.
//
// IT IS CACHED ON ITS INPUTS, because three `wrangler types` runs cost 5.3s of
// wrangler startup (3.1s for one, measured 2026-09-02) on a typecheck that
// took 2.6s before this step existed. The first line of the output names a
// key over everything the surface can depend on: wrangler's version (which
// pins workerd) and the bytes of the three configs (which carry the dates and
// flags). A matching key skips the whole run; anything else regenerates. Note
// what the key does NOT cover, on purpose: a config edit that leaves the file
// byte-identical cannot change the output, and a workerd that moved without
// wrangler moving cannot happen under an exact pin.
//
// On Wrangler 4.129.0, `types --include-env=false` also resolves the entrypoint
// and runs its custom build. The temporary runtime-only configs below removed
// that extra build: 6.15s -> 3.03s in a 2026-09-08 workstation comparison,
// with byte-identical declarations and no writes to the staged site.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { parseJsonc } from "./lib/jsonc.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUT = join(REPO, "config", ".generated", "workers-runtime.d.ts");
const KEY_PREFIX = "// gen-runtime-types key ";

// The site config is the one whose output ships; the others are the control.
const CONFIGS = [
  { name: "site", config: "wrangler.jsonc" },
  { name: "lwe-ask", config: "lwe-ask/wrangler.toml" },
  { name: "lens-reader", config: "lens-reader/wrangler.toml" },
];

const MARKER = "// Begin runtime types";

const inputsKey = () => {
  const h = createHash("sha256");
  h.update(wranglerVersion());
  for (const c of CONFIGS) h.update("\0" + c.config + "\0").update(readFileSync(join(REPO, c.config)));
  return h.digest("hex").slice(0, 16);
};

const FORCE = process.argv.includes("--force");
const wranglerVersion = () => JSON.parse(readFileSync(join(REPO, "node_modules", "wrangler", "package.json"), "utf8")).version;

// ── cf-garage: wrangler writes this one, from cloudflare.config.ts ─────────
//
// The path is wrangler's constant (NEW_CONFIG_TYPES_OUTPUT_PATH), resolved
// against the working directory, which is why the spawn runs in cf-garage/.
// Both `.cloudflare/` trees are gitignored by the root rule.
export const CF_GARAGE_OUT = join(REPO, "cf-garage", ".cloudflare", "types", "index.d.ts");
// Kept beside this script's other output rather than inside the file, because
// wrangler owns that file and rewrites it whenever its content differs, which a
// key line of ours would guarantee on every `wrangler dev`.
const CF_GARAGE_KEY = join(REPO, "config", ".generated", "cf-garage-types.key");

function generateCfGarage() {
  const h = createHash("sha256").update(wranglerVersion()).update("\0");
  h.update(readFileSync(join(REPO, "cf-garage", "cloudflare.config.ts")));
  const cfKey = h.digest("hex").slice(0, 16);
  if (!FORCE && existsSync(CF_GARAGE_OUT) && existsSync(CF_GARAGE_KEY) && readFileSync(CF_GARAGE_KEY, "utf8").trim() === cfKey) {
    console.log(`gen-runtime-types: cf-garage/.cloudflare/types/index.d.ts is current (key ${cfKey})`);
    return;
  }
  // Removed first, because wrangler SWALLOWS a type-generation failure: the
  // generator logs the error and returns, and the build carries on to exit 0.
  // A stale file left in place would then read as a fresh one.
  rmSync(CF_GARAGE_OUT, { force: true });
  // `build --x-new-config --x-cf-build-output` rather than the three commands
  // that look cheaper, each measured 2026-09-26 on wrangler 3572193:
  //   - `types --x-new-config` is refused ("Unknown arguments").
  //   - `deploy --dry-run --x-new-config` bundles and prints the bindings but
  //     never reaches the generator.
  //   - `build --x-new-config` WITHOUT the output flag is that same dry run with
  //     `--outdir=dist`, so it writes an unignored cf-garage/dist/ and no types.
  // This one reads the config, writes the types, then bundles into the ignored
  // .cloudflare/output/ tree: 1.3 s, no credential, no network. It also spawns
  // `docker` to tidy container image tags even with no container configured,
  // which prints a daemon error on a machine without one and changes nothing.
  // WRANGLER_SEND_METRICS=false keeps the telemetry POST off the wire.
  const out = spawnSync(...wranglerCommand(["build", "--x-new-config", "--x-cf-build-output"]), {
    cwd: join(REPO, "cf-garage"),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  const text = existsSync(CF_GARAGE_OUT) ? readFileSync(CF_GARAGE_OUT, "utf8") : "";
  const at = text.indexOf(MARKER);
  if (out.status !== 0 || at < 0 || !text.includes("InferEnv<") || text.length - at < 400_000) {
    process.stderr.write(`${out.stdout ?? ""}${out.stderr ?? ""}`);
    throw new Error(
      `gen-runtime-types: \`wrangler build --x-new-config --x-cf-build-output\` in cf-garage/ exited ${out.status} ` +
      `and left ${text ? `${text.length} bytes without a full Env + runtime surface` : "no file"} at cf-garage/.cloudflare/types/index.d.ts`,
    );
  }
  mkdirSync(dirname(CF_GARAGE_KEY), { recursive: true });
  writeFileSync(CF_GARAGE_KEY, cfKey + "\n");
  const header = text.split("\n").find((l) => l.startsWith("// Runtime types generated with")) ?? "";
  console.log(`gen-runtime-types: ${text.length - at} bytes + inferred Env -> cf-garage/.cloudflare/types/index.d.ts (${header.replace("// ", "")})`);
}

generateCfGarage();

const key = inputsKey();
if (!FORCE && existsSync(OUT) && readFileSync(OUT, "utf8").startsWith(KEY_PREFIX + key + "\n")) {
  console.log(`gen-runtime-types: config/.generated/workers-runtime.d.ts is current (key ${key}); pass --force to regenerate`);
  process.exit(0);
}

function generate(config: string, out: string) {
  // Runtime declarations depend only on these two fields (Wrangler's
  // generateRuntimeTypes), but `types` still resolves `main` and runs its custom
  // build with --include-env=false. Projecting the runtime inputs avoids a full
  // site build and makes cold lint/typecheck safe alongside the contract suite.
  // The projection is disposable; the original configs still own every value
  // and the cache key above covers their complete bytes.
  const source = readFileSync(join(REPO, config), "utf8");
  const parsed = config.endsWith(".toml") ? Bun.TOML.parse(source) : parseJsonc(source);
  const runtimeConfig = out.replace(/\.d\.ts$/, ".json");
  writeFileSync(runtimeConfig, JSON.stringify({
    compatibility_date: parsed.compatibility_date,
    compatibility_flags: parsed.compatibility_flags ?? [],
  }));
  execFileSync(...wranglerCommand(["types", "-c", runtimeConfig, "--include-env=false", out]), {
    cwd: REPO, stdio: ["ignore", "ignore", "inherit"],
  });
  const text = readFileSync(out, "utf8");
  const at = text.indexOf(MARKER);
  if (at < 0) throw new Error(`gen-runtime-types: no "${MARKER}" in the output for ${config}`);
  return { text, body: text.slice(at) };
}

const scratch = mkdtempSync(join(tmpdir(), "workers-runtime-"));
try {
  const results = CONFIGS.map((c) => ({ ...c, ...generate(c.config, join(scratch, `${c.name}.d.ts`)) }));
  const [site, ...others] = results;
  for (const other of others) {
    if (other.body !== site.body) {
      throw new Error(
        `gen-runtime-types: ${other.config} generates a different runtime surface from wrangler.jsonc ` +
        `(${other.body.length} vs ${site.body.length} bytes). The shared file no longer fits every Worker; ` +
        `give that program its own generated file rather than typing it against the site's runtime.`,
      );
    }
  }
  // A floor, because a generator that writes an empty file passes every include.
  if (site.body.length < 400_000) throw new Error(`gen-runtime-types: runtime surface is only ${site.body.length} bytes; expected ~590 KB`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, KEY_PREFIX + key + "\n" + site.text);
  const header = site.text.split("\n").find((l) => l.startsWith("// Runtime types generated with")) ?? "";
  console.log(`gen-runtime-types: ${site.body.length} bytes -> config/.generated/workers-runtime.d.ts (${header.replace("// ", "")}; ${others.length} auxiliary configs agree)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
