// Every repository project must resolve the root's exact Wrangler installation.
// Read tracked manifests and the installed resolution, including standalone
// projects. Package-store directories can retain unused versions after an
// install, so counting them says nothing about what a project will load.
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const COMMIT_PIN = /^https:\/\/pkg\.pr\.new\/cloudflare\/workers-sdk\/wrangler@[0-9a-f]{7,40}$/;
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
// the tarball carries, so `expected` is the installed version and the pin is
// asserted by its sha in the lockfile instead.
const expected = pinKind === "release" ? rootPin.replace(/^v/, "") : installed;
if (pinKind === "invalid") {
  errors.push(`root package must declare an exact Wrangler version or a pkg.pr.new commit URL, got ${JSON.stringify(rootPin)}`);
}
if (rootDeclared !== rootPin && !process.env.WRANGLER_VERSION) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${rootPin}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
if (pinKind === "commit") {
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
