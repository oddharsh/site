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

const expected = pinKind === "release" ? rootPin.replace(/^v/, "") : installed;
if (pinKind === "invalid") {
  errors.push(`root package must declare an exact Wrangler version or a pkg.pr.new commit URL, got ${JSON.stringify(rootPin)}`);
}
if (rootDeclared !== rootPin && !process.env.WRANGLER_VERSION) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${rootPin}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
if (pinKind === "commit") {
  const pinned = pinnedSha(rootPin);
  const onDisk = installedSha(rootManifest);
  if (!onDisk) {
    errors.push(`root: node_modules/wrangler resolves to ${rootManifest}, which names no workers-sdk commit, so the install cannot be matched to the pin @${pinned}; run \`${STALE_INSTALL_REMEDY}\``);
  } else if (onDisk !== pinned) {
    errors.push(`root: node_modules holds wrangler@${onDisk} (${installed}) but package.json pins @${pinned}; that is a stale install, run \`${STALE_INSTALL_REMEDY}\``);
  }
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
  // EQUALITY, not absence, since 2026-09-28. The `cf` CLI finds a project's dev
  // server by reading THAT project's manifest and does not walk up to the
  // workspace root, so cf-garage has to name wrangler for `cf build` to run at
  // all. A declaration is allowed when it is the root pin byte for byte, and
  // only as a devDependency; under bun's isolated linker the same URL resolves
  // to the same store entry, which the realpath check below still asserts.
  // Absence could never catch a root bump leaving a project behind, because no
  // project could name a version; equality can.
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const declared = pkg[kind]?.wrangler;
    if (declared === undefined) continue;
    if (kind !== "devDependencies") errors.push(`${project}: declares Wrangler under ${kind}; only devDependencies may name it, and only as the root pin ${rootDeclared}`);
    else if (declared !== rootDeclared) errors.push(`${project}: declares Wrangler ${JSON.stringify(declared)}, which is not the root pin ${JSON.stringify(rootDeclared)}`);
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
