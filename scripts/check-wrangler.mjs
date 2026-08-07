import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

const rootPackage = await readJson("package.json");
const lock = await readJson("package-lock.json");
const expected = (process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "").replace(/^v/, "");
const errors = [];
const rootLockPackage = lock.packages?.[""] || {};
const rootDeclared = rootPackage.devDependencies?.wrangler || rootPackage.dependencies?.wrangler || "";
const rootLockDeclared = rootLockPackage.devDependencies?.wrangler || rootLockPackage.dependencies?.wrangler || "";
const installed = lock.packages?.["node_modules/wrangler"]?.version || "";
const transitiveVersions = Object.entries(lock.packages || {})
  .filter(([key]) => key.endsWith("/node_modules/wrangler") && key !== "node_modules/wrangler")
  .map(([, value]) => value.version)
  .filter(Boolean);

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}
if (rootDeclared !== expected) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${expected}`);
if (rootLockDeclared !== rootDeclared) errors.push(`root: package-lock declares ${JSON.stringify(rootLockDeclared)}, package.json declares ${JSON.stringify(rootDeclared)}`);
if (installed !== expected) errors.push(`root: package-lock resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
console.log(`root: Wrangler ${rootDeclared} (root lock ${installed}; ${transitiveVersions.length} transitive ${transitiveVersions.length === 1 ? "copy" : "copies"})`);

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`The root toolchain pins Wrangler ${expected}; migration adapters use it through npx.`);
