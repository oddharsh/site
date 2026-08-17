// The external binaries the photo and encoding pipelines shell out to.
//
// Two tiers, split on what the environment can reach, the same way infra:check
// splits on what its credential can reach:
//
//   1. DECLARATION, from source text alone. No binary has to exist, so this runs
//      on every PR and on a fresh Linux runner. It is the tier that catches the
//      bug this script was written for: a script acquiring a prerequisite that
//      no documentation mentions.
//   2. PRESENCE, by probing the machine. Only a workstation can pass this, so it
//      degrades to a report in CI rather than a failure.
//
// The scanners in tier 1 read shell source, which is exactly the fragile thing
// CLAUDE.md keeps warning about, so two rules apply to every one of them. They
// match a BOUNDED set of shapes rather than trying to understand shell. And each
// one carries a floor: a scanner that suddenly matches nothing reports a pass
// while checking nothing, which is how the Markdown-twin test went green for
// months on the wrong field names.
import { readFile, readdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const IN_CI = Boolean(process.env.CI) && !STRICT;

// Floors. Each is comfortably under today's count and above zero, so ordinary
// edits never trip them and a scanner that stops matching always does.
let declaredScripts = 0;
// The shell scanners are VESTIGIAL and shrinking. Every script converted to Bun
// Shell exports its binaries as values instead (tier 1a2 above), so a constant
// floor here rots the moment a conversion lands: it fired on the seventh one,
// correctly, because there genuinely was less shell to scan.
//
// So the floors track the shell that is LEFT rather than a number someone typed.
// One guard list and one brew hint per remaining script is the weakest claim
// that still catches a scanner which has stopped matching, and when the last .sh
// goes both scanners retire themselves rather than passing on an empty set.

const errors = [];

const declaration = JSON.parse(await readFile(path.join(ROOT, "config/tools.json"), "utf8"));
const tools = declaration.tools ?? [];
if (tools.length === 0) {
  console.error("config/tools.json declares no tools");
  process.exit(1);
}



// ── the shell corpus ─────────────────────────────────────────────────────────
async function shellScripts() {
  const dirs = ["tools/photos", "scripts"];
  const found = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await readdir(path.join(ROOT, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".sh")) found.push(`${dir}/${entry}`);
    }
  }
  return found.sort();
}

const scripts = await shellScripts();
const source = new Map();
for (const rel of scripts) source.set(rel, await readFile(path.join(ROOT, rel), "utf8"));

// ── tier 1a: every declared file exists and names its tool ───────────────────
//
// Catches a declaration that has gone stale, which is the failure mode a list
// like this acquires once the scripts move on without it.
for (const tool of tools) {
  for (const rel of tool.required_by ?? []) {
    let text = source.get(rel);
    if (text === undefined) {
      try {
        text = await readFile(path.join(ROOT, rel), "utf8");
      } catch {
        errors.push(`config/tools.json: ${tool.bin} claims ${rel}, which does not exist`);
        continue;
      }
    }
    if (!text.includes(tool.bin)) {
      errors.push(`config/tools.json: ${tool.bin} claims ${rel}, which never mentions it`);
    }
  }
}

// ── tier 1a2: converted scripts DECLARE their binaries ───────────────────────
//
// This is the tier the shell scanners below are a workaround for. A script
// converted to Bun Shell says
//
//     export const REQUIRES = ["sips", "avifenc"] as const;
//
// so the binary names are values: greppable, importable, and checkable by
// READING rather than by regex. No floor is needed here, because there is no
// pattern that can silently stop matching — if the export is gone, the import
// throws.
//
// Every name must be declared in config/tools.json, and tools.json must name
// the script back. The two directions catch different mistakes: a new binary
// nobody documented, and a declaration left behind after a script stopped
// using it.
{
  const converted = (await readdir(new URL("photos/", import.meta.url)))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => `tools/photos/${n}`);

  for (const rel of converted) {
    const mod = await import(new URL(`../${rel}`, import.meta.url).href).catch(() => null);
    const requires = mod?.REQUIRES;
    if (!requires) continue;                       // not every .ts declares one
    declaredScripts++;
    for (const bin of requires) {
      const tool = tools.find((t) => t.bin === bin);
      if (!tool) {
        errors.push(`${rel} REQUIRES ${bin}, which config/tools.json does not declare`);
        continue;
      }
      if (!tool.required_by?.includes(rel)) {
        errors.push(`${rel} REQUIRES ${bin}, but tools.json's ${bin}.required_by does not list it`);
      }
    }
  }
}

// ── tiers 1b/1c/1d: RETIRED ─────────────────────────────────────────────────
//
// Three scanners used to read shell source here: `for cmd in …` guard lists,
// literal `command -v` probes, and `brew install` hints. Each carried a FLOOR,
// because a source scanner that stops matching otherwise reports a pass.
//
// They existed for ONE reason: shell hid the binary names. A prerequisite
// written `for cmd in sips exif-sooc` puts the name in a loop word, so a grep
// for it finds nothing, and four prerequisites stayed undocumented until these
// scanners went looking.
//
// There is no shell left in this repository. All ten scripts in tools/photos
// export their binaries as values (tier 1a2 above), which is checkable by
// READING rather than by regex and needs no floor, because there is no pattern
// that can silently stop matching.
//
// So the scanners are gone rather than left reporting `0 scanned` and passing.
// A check whose population is empty is decoration, and this file's own comments
// have said so about every other check in it.
//
// If shell ever comes back, `git log -- tools/check-tools.mjs` has them.

// ── tier 1e: the docs name every tool ────────────────────────────────────────
//
// The whole reason this file exists is that a prerequisite can be real and
// undocumented. Asserting the docs mention it is what keeps that from recurring.
const DOCS = ["CLAUDE.md", "docs/MAINTENANCE.md"];
const docText = (await Promise.all(DOCS.map((d) => readFile(path.join(ROOT, d), "utf8")))).join("\n");
for (const tool of tools) {
  if (!docText.includes(tool.bin)) {
    errors.push(`neither ${DOCS.join(" nor ")} mentions \`${tool.bin}\`; an undocumented prerequisite is the bug this check exists for`);
  }
}

// ── tier 2: presence ─────────────────────────────────────────────────────────
// Walk PATH directly rather than shelling out to `command -v`. Passing an
// argument array with `shell: true` concatenates instead of escaping, which
// node 26 deprecates (DEP0190), and a lookup needs no shell anyway.
const PATH_DIRS = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

async function present(tool) {
  const candidates = tool.path ? [tool.path] : PATH_DIRS.map((dir) => path.join(dir, tool.bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

const missing = [];
const found = [];
for (const tool of tools) {
  const where = await present(tool);
  if (where) found.push([tool.bin, where]);
  else missing.push(tool);
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`tools: ${tools.length} declared`);
console.log(`declaration: ${declaredScripts} converted script(s) declare their binaries as values`);

if (errors.length) {
  console.error("\ndeclaration check FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("declaration: every guarded binary is declared, and every declared binary is documented");

if (missing.length === 0) {
  console.log(`presence: all ${found.length} present`);
  process.exit(0);
}

const blocking = missing.filter((t) => !t.optional);
const lines = missing.map((t) => `  - ${t.bin}${t.optional ? " (optional)" : ""} — ${t.install}\n      ${t.why}`);

if (IN_CI) {
  // A hosted runner has none of these and is not supposed to. Reporting keeps
  // the tier visible in the log; failing would make every PR red for a machine
  // that never runs the photo pipeline.
  console.log(`\npresence: ${missing.length} not on this machine (advisory in CI)`);
  for (const line of lines) console.log(line);
  process.exit(0);
}

console.log(`\npresence: ${found.length} present, ${missing.length} missing`);
for (const line of lines) console.log(line);
if (blocking.length) {
  console.error(`\n${blocking.length} required tool(s) missing. The pipelines that need them will exit.`);
  process.exit(1);
}
process.exit(0);
