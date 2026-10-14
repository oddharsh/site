#!/usr/bin/env bun
// gen-runtime-types.ts — the Workers runtime declarations, generated from the
// PINNED workerd rather than depended on as a package.
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
// RUNTIME ONLY. `--include-env=false`, because the Env half wrangler would
// write types COUNTER and the two Workflows by importing `.build/src/worker/
// index`, which is build output that does not exist in a fresh checkout;
// src/worker/lib/env.ts's header has the long version of why the site's Env is
// hand-written and checked against cloudflare.config.ts instead.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { parseJsonc } from "./lib/jsonc.ts";
import { asList, asRecord, asText } from "../src/worker/lib/parse.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUT = join(REPO, "config", ".generated", "workers-runtime.d.ts");
export const AUX_OUT = join(REPO, "config", ".generated", "workers-runtime-aux.d.ts");
const KEY_PREFIX = "// gen-runtime-types key ";

const CONFIGS = [
  { name: "site", config: "cloudflare.config.ts" },
  { name: "lwe-ask", config: "lwe-ask/cloudflare.config.ts" },
  { name: "lens-reader", config: "lens-reader/cloudflare.config.ts" },
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

// The path is wrangler's constant (NEW_CONFIG_TYPES_OUTPUT_PATH), resolved
// against the working directory, which is why the spawn runs in cf-garage/.
// Both `.cloudflare/` trees are gitignored by the root rule.
export const CF_GARAGE_OUT = join(REPO, "cf-garage", ".cloudflare", "types", "index.d.ts");
// Kept beside this script's other output rather than inside the file, because
// wrangler owns that file and rewrites it whenever its content differs, which a
// key line of ours would guarantee on every `wrangler dev`.
const CF_GARAGE_KEY = join(REPO, "config", ".generated", "cf-garage-types.key");
// Gotcha 59. The build below also writes a Build Output tree nothing here reads, and
// since 4d90f32 (workers-sdk#16128, #1271) its root config makes `wrangler
// deploy`, `versions upload` and `preview` REFUSE to run from cf-garage/
// ("builds for the Cloudflare CLI"). Measured 2026-10-11 on the pin c09832d
// with no credential: refused with the tree present, and past the guard to the
// API-token error with it gone. `--dry-run` skips the guard, so a dry run
// cannot show this. Workers Builds clones clean and never sees the tree; a
// workstation deploy after any typecheck or lint did. So the tree goes on
// EVERY run, the cached path included, which also clears one an older run
// left behind.
export const CF_GARAGE_BUILD_OUTPUT = join(REPO, "cf-garage", ".cloudflare", "output");

function generateCfGarage() {
  const h = createHash("sha256").update(wranglerVersion()).update("\0");
  h.update(readFileSync(join(REPO, "cf-garage", "cloudflare.config.ts")));
  const cfKey = h.digest("hex").slice(0, 16);
  if (!FORCE && existsSync(CF_GARAGE_OUT) && existsSync(CF_GARAGE_KEY) && readFileSync(CF_GARAGE_KEY, "utf8").trim() === cfKey) {
    rmSync(CF_GARAGE_BUILD_OUTPUT, { recursive: true, force: true });
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
  // .cloudflare/output/ tree (deleted right after, see CF_GARAGE_BUILD_OUTPUT):
  // 1.3 s, no credential, no network. It also spawns
  // `docker` to tidy container image tags even with no container configured,
  // which prints a daemon error on a machine without one and changes nothing.
  // WRANGLER_SEND_METRICS=false keeps the telemetry POST off the wire.
  const out = spawnSync(...wranglerCommand(["build", "--x-new-config", "--x-cf-build-output"]), {
    cwd: join(REPO, "cf-garage"),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  rmSync(CF_GARAGE_BUILD_OUTPUT, { recursive: true, force: true });
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
const current = (file: string) => existsSync(file) && readFileSync(file, "utf8").startsWith(KEY_PREFIX + key + "\n");
if (!FORCE && current(OUT) && current(AUX_OUT)) {
  console.log(`gen-runtime-types: config/.generated/workers-runtime{,-aux}.d.ts are current (key ${key}); pass --force to regenerate`);
  process.exit(0);
}

async function runtimeFields(config: string) {
  const source = readFileSync(join(REPO, config), "utf8");
  if (config.endsWith(".ts")) {
    const worker = asRecord(asRecord((await import(join(REPO, config))).default)?.worker);
    if (!worker) throw new Error(`gen-runtime-types: ${config} does not default-export a config object with a \`worker\``);
    return { compatibility_date: asText(worker.compatibilityDate), compatibility_flags: asList(worker.compatibilityFlags) };
  }
  const parsed = config.endsWith(".toml") ? Bun.TOML.parse(source) : parseJsonc(source);
  return { compatibility_date: parsed.compatibility_date, compatibility_flags: parsed.compatibility_flags ?? [] };
}

const FIELDS = new Map();
for (const c of CONFIGS) FIELDS.set(c.config, await runtimeFields(c.config));

function generate(config: string, out: string) {
  // Runtime declarations depend only on these two fields (Wrangler's
  // generateRuntimeTypes), but `types` still resolves `main` and runs its custom
  // build with --include-env=false. Projecting the runtime inputs avoids a full
  // site build and makes cold lint/typecheck safe alongside the contract suite.
  // The projection is disposable; the original configs still own every value
  // and the cache key above covers their complete bytes.
  const runtimeConfig = out.replace(/\.d\.ts$/, ".json");
  const fields = FIELDS.get(config);
  if (!fields.compatibility_date) throw new Error(`gen-runtime-types: no compatibility date read from ${config}`);
  writeFileSync(runtimeConfig, JSON.stringify(fields));
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
  const [site, aux, ...others] = results;
  for (const other of others) {
    if (other.body !== aux.body) {
      throw new Error(
        `gen-runtime-types: ${other.config} generates a different runtime surface from ${aux.config} ` +
        `(${other.body.length} vs ${aux.body.length} bytes). The shared auxiliary file no longer fits both; ` +
        `give that program its own generated file rather than typing it against another Worker's runtime.`,
      );
    }
  }
  for (const r of [site, aux]) {
    if (r.body.length < 400_000) throw new Error(`gen-runtime-types: ${r.config} runtime surface is only ${r.body.length} bytes; expected ~620 KB`);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, KEY_PREFIX + key + "\n" + site.text);
  writeFileSync(AUX_OUT, KEY_PREFIX + key + "\n" + aux.text);
  const header = site.text.split("\n").find((l) => l.startsWith("// Runtime types generated with")) ?? "";
  console.log(`gen-runtime-types: ${site.body.length} bytes -> workers-runtime.d.ts, ${aux.body.length} bytes -> workers-runtime-aux.d.ts (${header.replace("// ", "")}; ${others.length + 1} auxiliary configs agree)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
