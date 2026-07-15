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
const expected = (process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "").replace(/^v/, "");
const errors = [];

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}

for (const project of PROJECTS) {
  const label = project || "root";
  const packagePath = project ? `${project}/package.json` : "package.json";
  const lockPath = project ? `${project}/package-lock.json` : "package-lock.json";
  const pkg = await readJson(packagePath);
  const lock = await readJson(lockPath);
  const declared = pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler || "";
  const lockDeclared = lock.packages?.[""]?.devDependencies?.wrangler || lock.packages?.[""]?.dependencies?.wrangler || "";
  const installed = lock.packages?.["node_modules/wrangler"]?.version || "";
  const transitiveVersions = Object.entries(lock.packages || {})
    .filter(([key]) => key === "node_modules/wrangler" || key.endsWith("/node_modules/wrangler"))
    .map(([, value]) => value.version)
    .filter(Boolean);

  if (declared !== expected) errors.push(`${label}: package.json declares ${JSON.stringify(declared)}, expected ${expected}`);
  if (lockDeclared !== declared) errors.push(`${label}: package-lock root declares ${JSON.stringify(lockDeclared)}, package.json declares ${JSON.stringify(declared)}`);
  if (installed !== expected) errors.push(`${label}: package-lock resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
  for (const version of transitiveVersions) {
    if (version !== expected) errors.push(`${label}: package-lock contains transitive Wrangler ${version}, expected ${expected}`);
  }

  console.log(`${label}: Wrangler ${declared} (lock ${installed}; ${transitiveVersions.length} resolved copy)`);
}

if (errors.length) {
  console.error("Wrangler version check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`All ${PROJECTS.length} Worker projects use Wrangler ${expected}.`);
