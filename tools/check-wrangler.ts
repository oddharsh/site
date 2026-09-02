// Every Worker project on this account must run the SAME Wrangler, pinned
// exactly at the root. A drifting Wrangler is how a config key means one thing
// in CI and another on a workstation.
//
// This read the npm lockfile until the pnpm migration. It now reads the
// INSTALLED TREE instead, which is a stronger check rather than a weaker one:
// a lockfile records what should be there, node_modules records what is.
//
// Two assertions from the npm version are deliberately gone. Both compared the
// lockfile's declared spec against package.json's, and `pnpm install
// --frozen-lockfile` fails outright when those disagree, so CI performs that
// check before this script runs. An assertion that can only ever agree with a
// step that already passed is decoration.
//
// The cost of reading node_modules is that this script now REQUIRES an install
// first. CI installs before calling it. Run `pnpm install` if it reports that.
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = ["cf-garage", "lwe-ask"];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function exists(relativePath) {
  try {
    await access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

const rootPackage = await readJson("package.json");
const expected = (process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "").replace(/^v/, "");
const errors: string[] = [];

if (!(await exists("node_modules/wrangler/package.json"))) {
  console.error("Wrangler version check failed:");
  console.error("- node_modules/wrangler is missing. This check reads the installed tree; run `bun install` first.");
  process.exit(1);
}

const rootDeclared = rootPackage.devDependencies?.wrangler || rootPackage.dependencies?.wrangler || "";
const installed = (await readJson("node_modules/wrangler/package.json")).version || "";

// Transitive copies live under pnpm's content-addressed store link farm, one
// directory per resolved version (a peer-dependency suffix may follow the
// version, hence the prefix match rather than an equality test).
//
// NOTE: this tree is bun since 2026-08-20 and has no node_modules/.pnpm, so the
// catch below always fires and this count is always 0. The equality checks on
// the root pin still hold; what is no longer checked here is a SECOND wrangler
// version pulled in transitively. Finding one on a bun layout is a different
// search, because bun hoists flat and a duplicate would sit at
// node_modules/<pkg>/node_modules/wrangler. Nobody has written that yet.
let transitiveVersions = [];
try {
  transitiveVersions = (await readdir(path.join(ROOT, "node_modules/.pnpm")))
    .filter((entry) => entry.startsWith("wrangler@"))
    .map((entry) => entry.slice("wrangler@".length).split("_")[0])
    .filter((version) => version !== installed);
} catch {
  // no .pnpm directory (a hoisted or non-pnpm layout); the checks below still hold
}

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}
if (rootDeclared !== expected) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${expected}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
console.log(`root: Wrangler ${rootDeclared} (installed ${installed}; ${transitiveVersions.length} transitive ${transitiveVersions.length === 1 ? "copy" : "copies"})`);

for (const project of PROJECTS) {
  const pkg = await readJson(`${project}/package.json`);
  const declared = pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler || "";

  if (declared) errors.push(`${project}: package.json must not declare Wrangler; use the root pin ${expected}`);
  // Under pnpm a workspace's own dependencies materialise in its local
  // node_modules, so a direct declaration shows up here even when the root
  // package.json is clean.
  if (await exists(`${project}/node_modules/wrangler`)) {
    errors.push(`${project}: has its own Wrangler in node_modules; it must use the root pin ${expected}`);
  }
  console.log(`${project}: uses root Wrangler ${expected}`);
}

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`All ${PROJECTS.length + 1} Worker projects use the root Wrangler ${expected}.`);
