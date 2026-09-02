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
// ONE FILE FOR FOUR CONFIGS, and that is asserted rather than assumed. The
// runtime section is a function of compatibility date and flags, and the four
// Workers here sit on four different dates (2026-05-01 to 2026-07-02) with two
// flag sets. Generated separately, their runtime sections came back
// byte-identical below the header line. This script regenerates the two
// auxiliary configs wrangler can read alongside the site's and FAILS if any
// pair diverges, because that is the day the programs need a file each and a
// silent divergence would type one Worker against another's runtime.
// cf-garage is the one it cannot cross-check: `wrangler types` refuses
// `--x-new-config` (measured again today, "Unknown arguments"), so that
// Worker types against the shared file on the strength of the other three
// agreeing, and its dry-run in CI is the runtime check it gets.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

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
  h.update(JSON.parse(readFileSync(join(REPO, "node_modules", "wrangler", "package.json"), "utf8")).version);
  for (const c of CONFIGS) h.update("\0" + c.config + "\0").update(readFileSync(join(REPO, c.config)));
  return h.digest("hex").slice(0, 16);
};

const key = inputsKey();
if (!process.argv.includes("--force") && existsSync(OUT) && readFileSync(OUT, "utf8").startsWith(KEY_PREFIX + key + "\n")) {
  console.log(`gen-runtime-types: config/.generated/workers-runtime.d.ts is current (key ${key}); pass --force to regenerate`);
  process.exit(0);
}

function generate(config: string, out: string) {
  execFileSync(...wranglerCommand(["types", "-c", config, "--include-env=false", out]), {
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
