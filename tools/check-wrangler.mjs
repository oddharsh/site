// Every Worker project on this account must run the SAME Wrangler, pinned
// exactly at the root. A drifting Wrangler is how a config key means one thing
// in CI and another on a workstation.
//
// This read a lockfile until the pnpm era. It now reads the
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
// first. CI installs before calling it. Run `bun install` if it reports that.
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
const errors = [];

if (!(await exists("node_modules/wrangler/package.json"))) {
  console.error("Wrangler version check failed:");
  console.error("- node_modules/wrangler is missing. This check reads the installed tree; run `bun install` first.");
  process.exit(1);
}

const rootDeclared = rootPackage.devDependencies?.wrangler || rootPackage.dependencies?.wrangler || "";
const installed = (await readJson("node_modules/wrangler/package.json")).version || "";

// Transitive copies live under the isolated linker's content-addressed store,
// one directory per resolved version. bun spells that node_modules/.bun and
// suffixes the entry with +<hash>; pnpm spelled it node_modules/.pnpm and used
// _<peer-suffix>. Both are handled, because a tree can be either.
//
// THIS SILENTLY DEGRADED FOR THE WHOLE BUN MIGRATION. It read .pnpm alone, that
// directory stopped existing, the catch swallowed the ENOENT, and the check
// reported "0 transitive copies" on every run: a clean pass that had inspected
// nothing. Exactly the shape this repo warns about, a check that can only ever
// agree with itself. The floor below is what makes the next spelling change
// LOUD rather than green.
const STORES = ["node_modules/.bun", "node_modules/.pnpm"];
let transitiveVersions = [];
let storeSeen = null;
for (const store of STORES) {
  let entries;
  try {
    entries = await readdir(path.join(ROOT, store));
  } catch {
    continue;                       // this tree uses the other linker
  }
  storeSeen = store;
  transitiveVersions = entries
    .filter((entry) => entry.startsWith("wrangler@"))
    .map((entry) => entry.slice("wrangler@".length).split(/[_+]/)[0])
    .filter((version) => version !== installed);
  break;
}
if (!storeSeen) {
  // A hoisted layout has no store at all, which is legitimate. Say so, rather
  // than reporting a scan that never happened as a clean result.
  console.warn("- no isolated store (.bun or .pnpm) found; transitive-copy scan skipped, not passed.");
}

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}
if (rootDeclared !== expected) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${expected}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
// A transitive copy at a DIFFERENT version is precisely the drift this script
// exists to catch, and it was only ever PRINTED. That was survivable while the
// scan was silently reading a directory that did not exist, since the count was
// always 0; with the scan working it would be a scanner nobody reads.
if (transitiveVersions.length) {
  errors.push(`transitive Wrangler copies at other versions: ${[...new Set(transitiveVersions)].join(", ")} (root is ${installed}) — a drifting Wrangler is how a config key means one thing in CI and another on a workstation`);
}
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
