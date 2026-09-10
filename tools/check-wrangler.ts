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
const expected = (process.env.WRANGLER_VERSION || rootPackage.devDependencies?.wrangler || "").replace(/^v/, "");
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

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`root package must declare an exact Wrangler version, got ${JSON.stringify(expected)}`);
}
if (rootDeclared !== expected) errors.push(`root: package.json declares ${JSON.stringify(rootDeclared)}, expected ${expected}`);
if (installed !== expected) errors.push(`root: node_modules resolves Wrangler ${JSON.stringify(installed)}, expected ${expected}`);
console.log(`root: Wrangler ${rootDeclared} (installed ${installed})`);

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
