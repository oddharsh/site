import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = ["", "cal", "cf-garage", "lwe-ask", "serendipity"];

async function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

const rootPackage = await readJson("package.json");
const lock = await readJson("package-lock.json");
const expected = (process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "").replace(/^v/, "");
const errors = [];

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}

for (const project of PROJECTS) {
  const label = project || "root";
  const packagePath = project ? `${project}/package.json` : "package.json";
  const pkg = await readJson(packagePath);
  const declared = pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler || "";
  const lockPackage = lock.packages?.[project || ""] || {};
  const lockDeclared = lockPackage.devDependencies?.wrangler || lockPackage.dependencies?.wrangler || "";
  const installed = lock.packages?.["node_modules/wrangler"]?.version || "";
  const transitiveVersions = Object.entries(lock.packages || {})
    .filter(([key]) => key.endsWith("/node_modules/wrangler"))
    .map(([, value]) => value.version)
    .filter(Boolean);

  if (declared !== expected) errors.push(`${label}: package.json declares ${JSON.stringify(declared)}, expected ${expected}`);
  if (lockDeclared !== declared) errors.push(`${label}: package-lock root declares ${JSON.stringify(lockDeclared)}, package.json declares ${JSON.stringify(declared)}`);
  if (installed !== expected) errors.push(`${label}: package-lock resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
  console.log(`${label}: Wrangler ${declared} (root lock ${installed}; ${transitiveVersions.length} transitive ${transitiveVersions.length === 1 ? "copy" : "copies"})`);
}

for (const project of PROJECTS.filter(Boolean)) {
  const key = `${project}/node_modules/wrangler`;
  if (lock.packages?.[key]) errors.push(`${project}: direct Wrangler was not hoisted to the root lock`);
}

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`All ${PROJECTS.length} Worker projects use Wrangler ${expected}.`);
