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
const FLOOR_GUARD_LISTS = 4;
const FLOOR_BREW_HINTS = 4;

const errors = [];

const declaration = JSON.parse(await readFile(path.join(ROOT, "config/tools.json"), "utf8"));
const tools = declaration.tools ?? [];
if (tools.length === 0) {
  console.error("config/tools.json declares no tools");
  process.exit(1);
}

const byBin = new Map(tools.map((t) => [t.bin, t]));
const declaredBins = new Set(byBin.keys());
const declaredInstalls = new Set(tools.map((t) => t.install).filter(Boolean)) as Set<string>;

// wrangler is guarded like a system binary and is not one: it comes from the
// workspace install, is pinned exactly at the root, and check-wrangler.mjs
// already asserts that. Declaring it here would put one version pin in two
// files, which is the drift this repo keeps writing gotchas about.
const NOT_SYSTEM = new Set(["wrangler"]);

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

// ── tier 1b: every `for cmd in …` guard list is declared ─────────────────────
//
// The shape is `for <var> in <words>; do … command -v "$<var>" …`, which is how
// most of these scripts check their preconditions. A grep for the binary NAME
// cannot see these, because the name only exists as a loop word. That blind spot
// is gotcha 29's, in a different costume.
let guardLists = 0;
const guardPattern = /^[ \t]*for[ \t]+(\w+)[ \t]+in[ \t]+([^;\n]+);?[ \t]*(?:do)?[ \t]*$/gm;
for (const [rel, text] of source) {
  for (const match of text.matchAll(guardPattern)) {
    const [, variable, wordsRaw] = match;
    // Only a loop whose body probes the loop variable is a precondition guard.
    const after = text.slice(match.index, match.index + 400);
    if (!after.includes(`command -v "$${variable}"`) && !after.includes(`-x "$${variable}"`)) continue;
    guardLists += 1;
    for (const word of wordsRaw.trim().split(/\s+/)) {
      // Words that are themselves variables hold a path resolved earlier; the
      // binary they point at is declared under its own name instead.
      if (word.includes("$")) continue;
      const bin = word.replace(/^["']|["']$/g, "");
      if (!bin || declaredBins.has(bin) || NOT_SYSTEM.has(bin)) continue;
      errors.push(`${rel}: guards on \`${bin}\`, which config/tools.json does not declare`);
    }
  }
}
if (guardLists < FLOOR_GUARD_LISTS) {
  errors.push(
    `guard-list scanner matched ${guardLists} loops, below the floor of ${FLOOR_GUARD_LISTS}. ` +
      `The shell changed shape and this scanner is now checking nothing.`,
  );
}

// ── tier 1c: every `command -v <literal>` is declared ────────────────────────
let literalProbes = 0;
for (const [rel, text] of source) {
  for (const match of text.matchAll(/command -v[ \t]+"?([A-Za-z][\w.-]*)"?/g)) {
    const bin = match[1];
    if (bin.startsWith("$")) continue;
    literalProbes += 1;
    if (declaredBins.has(bin) || NOT_SYSTEM.has(bin)) continue;
    errors.push(`${rel}: probes \`${bin}\`, which config/tools.json does not declare`);
  }
}

// ── tier 1d: every `brew install …` hint maps to a declaration ───────────────
//
// A formula is not a binary (mozjpeg gives jpegtran and cjpeg, libavif gives
// avifenc, webp gives cwebp), so this matches on the install STRING rather than
// trying to translate. A new hint that nothing declares is a new prerequisite.
let brewHints = 0;
for (const [rel, text] of source) {
  for (const match of text.matchAll(/brew install ([a-z0-9][a-z0-9 -]*)/g)) {
    const hint = `brew install ${match[1].trim()}`;
    brewHints += 1;
    if (declaredInstalls.has(hint)) continue;
    // A multi-formula hint is satisfied when every formula in it is declared
    // somewhere, since the docs write them as one line.
    const formulae = match[1].trim().split(/\s+/);
    const covered = formulae.every((f) => [...declaredInstalls].some((i) => i.split(/\s+/).includes(f)));
    if (!covered) {
      errors.push(`${rel}: suggests \`${hint}\`, which config/tools.json does not account for`);
    }
  }
}
if (brewHints < FLOOR_BREW_HINTS) {
  errors.push(
    `brew-hint scanner matched ${brewHints} hints, below the floor of ${FLOOR_BREW_HINTS}. ` +
      `The install hints moved and this scanner is now checking nothing.`,
  );
}

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
console.log(`tools: ${tools.length} declared across ${scripts.length} shell scripts`);
console.log(`declaration: ${guardLists} guard loops, ${literalProbes} literal probes, ${brewHints} brew hints scanned`);

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
