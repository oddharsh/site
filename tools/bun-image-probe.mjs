// bun-image-probe.mjs — what does the Workers Builds image actually give us?
//
// TWO OPEN QUESTIONS, one build. Both are undocumented, and neither can be
// answered from a workstation, because the thing under test is Cloudflare's
// build image rather than anything in this repository.
//
//   1. Does BUN_VERSION=canary RESOLVE? Bun's own installer takes a release TAG
//      and builds releases/download/$TAG/bun-$target.zip, and `canary` is a real
//      tag, so if the image shells out to that script the override lands on the
//      exact asset config/bun-canary.json pins. If it instead templates a semver
//      (the docs list the default as a bare 1.2.15), `canary` becomes bun-vcanary
//      and 404s. The log below says which.
//
//   2. Does the image honour .node-version = 26? Its default is Node 24.18.0 and
//      it preinstalls 22 and 24. This matters independently of question 1: the
//      ONLY thing on this branch that needs bun 1.4 is zstdCompressSync's
//      `dictionary` option, and node 26 honours that, so a node that new is an
//      unblock with no canary anywhere near production.
//
// PARKED WITH THE BRANCH. This answered its questions on 2026-08-18 (the record
// is in docs/BUN-MIGRATION.md) and is kept because the day bun 1.4 goes GA every
// one of them has to be asked again: which bun the image resolves, whether the
// lockfile it wants parses, and what node it carries. Point wrangler.jsonc build
// command at this on a throwaway branch to re-run it.
//
// HOW IT RUNS. wrangler.jsonc's build.command points here on this branch only,
// so the image installs, the dashboard's deploy command starts wrangler, and
// wrangler runs this instead of the real build. It EXITS 1 on purpose: the probe
// is the whole point of the run, and a non-zero build aborts `versions upload`
// before anything is uploaded. No version, no traffic, nothing to clean up.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);
const attempt = (label, fn) => { try { return fn(); } catch (error) { return `FAILED: ${error.message.split("\n")[0]}`; } };

console.log("\n=== Workers Builds image probe ===\n");

console.log("what this repo declares:");
const declared = attempt("declared", () => JSON.parse(readFileSync("config/bun-canary.json", "utf8")));
line("bun revision", declared.revision ?? declared);
line("bun linux-x64 sha256", declared.platforms?.["linux-x64"]?.binary_sha256 ?? "?");
line(".node-version", attempt("node-version", () => readFileSync(".node-version", "utf8").trim()));

console.log("\nwhat the build variables say:");
for (const key of ["BUN_VERSION", "NODE_VERSION", "PNPM_VERSION", "WORKERS_CI", "WORKERS_CI_BRANCH"]) {
  line(key, process.env[key] ?? "(unset)");
}

console.log("\nwhat is actually running this file:");
line("runtime", typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.revision ?? Bun.version}`);
line("platform", `${process.platform} ${process.arch}`);
line("execPath", process.execPath);
const digest = attempt("digest", () => createHash("sha256").update(readFileSync(process.execPath)).digest("hex"));
line("execPath sha256", digest);
// The verdict rather than two hex strings to eyeball. Resolving `canary` and
// resolving to the asset CI verified are different outcomes, because the tag
// rolls in between, and only one of them is a pin.
const key = process.platform === "darwin" ? "darwin-aarch64" : "linux-x64";
const want = declared.platforms?.[key]?.binary_sha256;
line("matches the declared pin", want === digest ? `yes (${key})` : `NO (declared ${String(want).slice(0, 12)}…, running ${String(digest).slice(0, 12)}…)`);

// QUESTION 1's real payload. A version string proves which build was installed,
// and the digest proves whether it is the SAME binary this repo pins. Those are
// different questions: `canary` resolving is not the same as `canary` resolving
// to the asset CI verified, since the tag rolls between them.
console.log("\nthe capability that decides the version:");
const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
const zstd = (options) => zstdCompressSync(probe, { ...options, params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } }).length;
const none = attempt("zstd", () => zstd({}));
const dict = attempt("zstd", () => zstd({ dictionary: probe }));
line("zstd, no dictionary", none);
line("zstd, with dictionary", dict);
line("verdict", Number(dict) < Number(none) * 0.5 ? "HONOURED, this runtime can build" : "IGNORED, this runtime ships no-op deltas");

// QUESTION 2. Asked of node ITSELF rather than of bun's node-compat shim, which
// reports its own version and would answer for the wrong binary.
console.log("\nwhat node in this image can do:");
line("node --version", attempt("node", () => execFileSync("node", ["--version"], { encoding: "utf8" }).trim()));
line("node zstd probe", attempt("node", () => execFileSync("node", ["-e", `
  const { constants, zstdCompressSync } = require("node:zlib");
  const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
  const at = (o) => zstdCompressSync(probe, { ...o, params: { [constants.ZSTD_c_compressionLevel]: 19 } }).length;
  const none = at({}), dict = at({ dictionary: probe });
  process.stdout.write(dict < none * 0.5 ? \`HONOURED (\${dict} vs \${none})\` : \`IGNORED (\${dict} vs \${none})\`);
`], { encoding: "utf8" })));

// The image resolves `packageManager` as a RELEASE, so the run of 2026-08-17
// never reached the question we were asking: it read bun@1.4.0-canary.1, found
// no release tagged that, and stopped. This branch names a released bun there,
// which leaves BUN_VERSION as the only variable. Bun own installer takes a
// release TAG and `canary` is one, so the three outcomes are: the log says
// bun@canary and installs (the override wins and tags resolve), says bun@canary
// and fails (a semver is templated, so the tag route is dead), or says
// bun@1.3.14 (packageManager wins and only that field can carry a canary).
console.log("\nwhat the image resolved, read from the build log above this script:");
line("packageManager declares", attempt("pkg", () => JSON.parse(readFileSync("package.json", "utf8")).packageManager));

console.log("\nwhat else is on PATH:");
for (const [tool, args] of [["bun", ["--revision"]], ["node", ["--version"]], ["pnpm", ["--version"]], ["npm", ["--version"]], ["zstd", ["--version"]]]) {
  line(tool, attempt(tool, () => execFileSync(tool, args, { encoding: "utf8" }).trim()));
}

console.log("\nprobe complete. Exiting 1 so wrangler uploads nothing.\n");
process.exit(1);
