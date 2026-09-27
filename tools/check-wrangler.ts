// Every repository project must resolve the root's exact Wrangler installation.
// Read tracked manifests and the installed resolution, including standalone
// projects. Package-store directories can retain unused versions after an
// install, so counting them says nothing about what a project will load.
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMIT_PIN, STALE_INSTALL_REMEDY, installedSha, pinnedSha } from "./lib/wrangler-provenance.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

const rootPackage = await readJson("package.json");
const rootPin = process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "";
// TWO PIN SHAPES, both exact. A release is a plain `4.131.1`. A COMMIT of
// workers-sdk main is a pkg.pr.new tarball URL naming the sha
// (`https://pkg.pr.new/cloudflare/workers-sdk/wrangler@b149147`), which is
// what a prerelease pin looks like since 2026-09-14: the sha is the identity,
// bun.lock records the tarball's sha512, and the version the tarball carries
// is read from the install rather than declared twice. `@main`, a PR number
// or anything else that FLOATS is refused, because a floating pin rewrites
// the lockfile on the next install and `--frozen-lockfile` would fail on it.
const RELEASE_PIN = /^\d+\.\d+\.\d+$/;
const pinKind = COMMIT_PIN.test(rootPin) ? "commit" : RELEASE_PIN.test(rootPin.replace(/^v/, "")) ? "release" : "invalid";
const errors: string[] = [];

let rootManifest = path.join(ROOT, "node_modules/wrangler/package.json");
let installed = "";
try {
  rootManifest = await realpath(rootManifest);
  installed = JSON.parse(await readFile(rootManifest, "utf8")).version || "";
} catch {
  console.error("Wrangler version check failed:");
  console.error("- root Wrangler installation is missing or unreadable; run `bun install` first.");
  process.exit(1);
}

const rootDeclared = rootPackage.devDependencies?.wrangler || rootPackage.dependencies?.wrangler || "";

// For a release the expected version is the pin; for a commit it is whatever
// the tarball carries, so `expected` is the installed version and the version
// comparison below cannot fail for a commit pin. It is NOT the assertion for
// that shape, and this comment used to imply it was. Two commits of main carry
// the same version routinely, so the pin is asserted twice by its sha instead:
// against the install's store path, and against the lockfile.
const expected = pinKind === "release" ? rootPin.replace(/^v/, "") : installed;
if (pinKind === "invalid") {
  errors.push(`root package must declare an exact Wrangler version or a pkg.pr.new commit URL, got ${JSON.stringify(rootPin)}`);
}
if (rootDeclared !== rootPin && !process.env.WRANGLER_VERSION) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${rootPin}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
if (pinKind === "commit") {
  // The INSTALL has to be the pinned tarball. Until 2026-09-27 this block read
  // only the lockfile below, which is committed and therefore agrees with the
  // pin on every checkout, stale node_modules or not: a tree holding
  // @b168333 under a pin of @3572193 printed "All 6 projects use the root
  // Wrangler 4.136.0." and exited 0. bun's store path is the one place the
  // installed tarball's sha is written down, so read it there.
  const pinned = pinnedSha(rootPin);
  const onDisk = installedSha(rootManifest);
  if (!onDisk) {
    // Fail closed. A commit pin whose install records no sha is an install we
    // cannot identify, and passing it is exactly the self-agreeing check this
    // block exists to replace.
    errors.push(`root: node_modules/wrangler resolves to ${rootManifest}, which names no workers-sdk commit, so the install cannot be matched to the pin @${pinned}; run \`${STALE_INSTALL_REMEDY}\``);
  } else if (onDisk !== pinned) {
    errors.push(`root: node_modules holds wrangler@${onDisk} (${installed}) but package.json pins @${pinned}; that is a stale install, run \`${STALE_INSTALL_REMEDY}\``);
  }
  // The lockfile has to name the same tarball, or the install and the pin
  // are two different wranglers that happen to share a version number.
  const lock = await readFile(path.join(ROOT, "bun.lock"), "utf8");
  if (!lock.includes(`"wrangler@${rootPin}"`)) errors.push(`root: bun.lock does not resolve wrangler to ${rootPin}; run \`bun install\` so the lockfile records that tarball`);
}
console.log(`root: Wrangler ${rootDeclared} (installed ${installed}, ${pinKind} pin)`);

const manifests = execFileSync("git", ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"], {
  cwd: ROOT, encoding: "utf8",
}).split("\0").filter(Boolean);
if (!manifests.includes("package.json")) throw new Error("Wrangler check found no tracked root package.json");

for (const manifest of manifests.filter((name) => name !== "package.json")) {
  const project = path.dirname(manifest);
  const pkg = await readJson(manifest);
  if (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((kind) => pkg[kind]?.wrangler !== undefined)) {
    errors.push(`${project}: package.json must not declare Wrangler; use the root pin ${expected}`);
  }
  try {
    const resolved = await realpath(createRequire(path.join(ROOT, manifest)).resolve("wrangler/package.json"));
    if (resolved !== rootManifest) errors.push(`${project}: resolves a separate installation; must use the root Wrangler ${expected}`);
    else console.log(`${project}: uses root Wrangler ${installed}`);
  } catch {
    errors.push(`${project}: cannot resolve installed Wrangler; run \`bun install\` first.`);
  }
}

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`All ${manifests.length} projects use the root Wrangler ${expected}.`);
