// Every Worker project on this account must run the SAME Wrangler. The root
// carries the pin; a project may RESTATE it exactly (cf-garage does, because
// the `cf` CLI reads the project's own manifest) and may not diverge from it. A drifting Wrangler is how a config key means one thing
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

  // A declaration is ALLOWED when it is exactly the root pin, and forbidden
  // otherwise. This was an absence test until 2026-09-08 ("must not declare"),
  // which made drift impossible by making declaration impossible. The `cf` CLI
  // needs the declaration: it looks for a dev server in the project's OWN
  // manifest and does not walk up to the workspace root, so `cf build` refuses
  // cf-garage outright without it.
  //
  // Equality is the property this file has always been about ("every Worker
  // project on this account must run the SAME Wrangler"), and checking it
  // directly is stronger than the proxy it replaces: absence could not catch a
  // root bump that left a project behind, because under the old rule no project
  // could name a version to be left behind at. Now that one can, this fails.
  if (declared && declared !== expected) {
    errors.push(`${project}: package.json declares Wrangler ${JSON.stringify(declared)}, expected the root pin ${expected}`);
  }

  // Bun symlinks a workspace dependency to the one hoisted copy rather than
  // installing a second, so the presence of this path is not evidence of a
  // duplicate. Measured 2026-09-08: cf-garage/node_modules/wrangler is a
  // symlink into node_modules/.bun/wrangler@4.129.0 and shares an inode with
  // the root copy. What matters is the version it resolves to, so read that.
  const localManifest = `${project}/node_modules/wrangler/package.json`;
  if (await exists(localManifest)) {
    const localVersion = (await readJson(localManifest)).version || "";
    if (localVersion !== expected) {
      errors.push(`${project}: node_modules resolves Wrangler ${JSON.stringify(localVersion)}, expected ${expected}`);
    }
  }
  console.log(`${project}: ${declared ? `declares Wrangler ${declared}` : `uses root Wrangler ${expected}`}`);
}

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`All ${PROJECTS.length + 1} Worker projects use the root Wrangler ${expected}.`);
