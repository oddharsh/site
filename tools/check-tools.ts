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
import { spawnSync } from "node:child_process";
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
const FLOOR_MIN_GUARDS = 5;

/** One entry of config/tools.json. Declared rather than inferred from JSON.parse,
 *  which hands back `any` and takes every downstream field with it. */
type Tool = {
  bin: string;
  path?: string;
  install: string;
  why: string;
  optional?: boolean;
  required_by?: string[];
  min_version?: string;
  bytes?: boolean;
  bytes_why?: string;
  recorded?: string;
  version?: { flag?: string; match?: string; reports?: boolean; why?: string };
};

const errors: string[] = [];

const declaration = JSON.parse(await readFile(path.join(ROOT, "config/tools.json"), "utf8"));
const tools: Tool[] = declaration.tools ?? [];
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
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
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

// ── tier 1d: every `<TOOL>_MIN=` guard agrees with the declaration ───────────
//
// THE LIST WAS CONSOLIDATED HERE AND THE VERSION WAS NOT. `EXIF_SOOC_MIN=0.2.0`
// is written out in five shell scripts, config/tools.json carries a sixth copy
// as `min_version`, and until this scanner nothing read that field at all: the
// one place designed to be the single declaration was the only one nobody
// consulted. That is the same failure the $comment at the top of tools.json
// says the file was created to fix, one field further in.
//
// The shape is `<NAME>_MIN=<version>` on its own line, and the tool it governs
// is the name lowercased with underscores as dashes, so EXIF_SOOC_MIN governs
// exif-sooc. Bounded, like every other scanner here, and floored for the same
// reason: one that stops matching reports a pass while checking nothing.
//
// Note it asserts AGREEMENT where a guard exists rather than requiring one
// everywhere. download-remote-photos.sh uses exif-sooc to READ two dimensions
// and needs no write-capability floor, which is why it correctly has none.
let minGuards = 0;
const minPattern = /^[ \t]*([A-Z][A-Z0-9_]*)_MIN=([0-9][0-9A-Za-z.-]*)[ \t]*$/gm;
for (const [rel, text] of source) {
  for (const match of text.matchAll(minPattern)) {
    const [, name, declared] = match;
    const bin = name.toLowerCase().replace(/_/g, "-");
    const tool = byBin.get(bin);
    if (!tool) {
      errors.push(`${rel}: guards a minimum for \`${bin}\`, which config/tools.json does not declare`);
      continue;
    }
    minGuards += 1;
    if (!tool.min_version) {
      errors.push(`${rel}: floors ${bin} at ${declared}, and config/tools.json declares no min_version for it`);
    } else if (tool.min_version !== declared) {
      errors.push(`${rel}: floors ${bin} at ${declared} while config/tools.json declares ${tool.min_version}`);
    }
  }
}
// The other direction, so a declared floor cannot become decorative the way
// min_version already had: something must actually enforce it.
for (const tool of tools) {
  if (!tool.min_version) continue;
  const enforced = [...source.values()].some((text) =>
    new RegExp(`^[ \t]*${tool.bin.toUpperCase().replace(/-/g, "_")}_MIN=`, "m").test(text),
  );
  if (!enforced) {
    errors.push(`config/tools.json: ${tool.bin} declares min_version ${tool.min_version}, and no script enforces it`);
  }
}
if (minGuards < FLOOR_MIN_GUARDS) {
  errors.push(
    `minimum-version scanner matched ${minGuards} guards, below the floor of ${FLOOR_MIN_GUARDS}. ` +
      `The shell changed shape and this scanner is now checking nothing.`,
  );
}

// ── tier 2: presence ─────────────────────────────────────────────────────────
// Walk PATH directly rather than shelling out to `command -v`. Passing an
// argument array with `shell: true` concatenates instead of escaping, which
// node 26 deprecates (DEP0190), and a lookup needs no shell anyway.
const PATH_DIRS = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

async function present(tool: Tool): Promise<string | null> {
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

const missing: Tool[] = [];
const found: [string, string][] = [];
for (const tool of tools) {
  const where = await present(tool);
  if (where) found.push([tool.bin, where]);
  else missing.push(tool);
}

// ── tier 3: version, and what the version DECIDES ────────────────────────────
//
// The tier the other two could not reach. Presence answers "is avifenc here",
// and the question that actually costs something is "is it the avifenc that
// baked the library". `/i/` is content-addressed, so re-encoding under a
// different encoder mints new URLs, orphans every a-dict snapshot naming the
// old hash, and can leave derived data describing pixels nobody serves, which
// is gotcha 41 written down as a check instead of a postmortem.
//
// So this is a RECORD rather than an updater, and that is deliberate. For an
// encoder whose output ships, "newer" is not "take it": a bump means re-encoding
// 632 files, re-hashing them, and rolling the dictionaries. `brew outdated`
// already answers whether something newer exists. What nothing answered until
// now is whether the binary on this machine is the one the committed bytes came
// from, and that question only has a local answer.
const versionErrors: string[] = [];
const versionNotices: string[] = [];
const versionLines: string[] = [];
const noVersion: string[] = [];

/** Numeric per component, so 1.10.0 reads as newer than 1.4.0. */
function olderThan(have: string, want: string): boolean {
  const a = String(have).split(".").map(Number);
  const b = String(want).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

for (const [bin, where] of found) {
  const tool = byBin.get(bin);
  const spec = tool?.version;
  if (!spec) continue;
  if (spec.reports === false) {
    noVersion.push(`${bin} — ${spec.why}`);
    continue;
  }

  // A spec that neither reports nor says how to ask is a malformed declaration,
  // and saying so beats narrowing it away: the alternative is a tool that is
  // silently never version-checked, which is the shape of every absence here.
  if (!spec.flag || !spec.match) {
    versionErrors.push(`config/tools.json: ${bin} declares a version block with no flag or match, and does not say it reports none`);
    continue;
  }

  // Both streams, because mozjpeg answers on stderr, and only the first few
  // lines, because ffmpeg follows its version with a wall of build flags.
  const out = spawnSync(where, [spec.flag], { encoding: "utf8" });
  const text = `${out.stdout ?? ""}\n${out.stderr ?? ""}`.split("\n").slice(0, 4).join("\n").trim();
  const found_ = new RegExp(spec.match, "m").exec(text);

  if (!found_) {
    // NOT a skip. A declared pattern that stops matching is the naive-scanner
    // rot this file's own header warns about: the tier would go on reporting a
    // pass while reading nothing. The tool changed its output, and that is worth
    // knowing on the day it happens rather than on the day bytes move.
    versionErrors.push(
      `${bin}: \`${spec.flag}\` no longer matches its declared pattern. It answered: ${JSON.stringify(text.split("\n")[0] ?? "")}`,
    );
    continue;
  }

  const version = found_[1];
  const marks: string[] = [];
  if (tool.min_version && olderThan(version, tool.min_version)) {
    versionErrors.push(`${bin} ${version} is older than the declared minimum ${tool.min_version}`);
    marks.push(`BELOW ${tool.min_version}`);
  }
  if (tool.bytes && tool.recorded && tool.recorded !== version) {
    versionNotices.push(
      `${bin} is ${version} and the committed artifacts are recorded against ${tool.recorded}. ` +
        `Re-running the pipeline now encodes under a different ${bin} from the rest of the library.`,
    );
    marks.push(`RECORDED ${tool.recorded}`);
  }
  versionLines.push(`  ${bin.padEnd(18)} ${version}${tool.bytes ? "  (bytes)" : ""}${marks.length ? `  <-- ${marks.join(", ")}` : ""}`);
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

if (versionLines.length) {
  console.log(`version: ${versionLines.length} read${noVersion.length ? `, ${noVersion.length} report none` : ""}`);
  for (const line of versionLines) console.log(line);
  for (const line of noVersion) console.log(`  ${line}`);
}
if (versionErrors.length) {
  console.error("\nversion check FAILED:");
  for (const e of versionErrors) console.error(`  - ${e}`);
  process.exit(1);
}
if (versionNotices.length) {
  console.log("\nversion: the recorded provenance has drifted.");
  for (const n of versionNotices) console.log(`  - ${n}`);
  console.log("  This is a NOTICE rather than a failure: a newer encoder is normal, and taking it");
  console.log("  is a deliberate job (re-encode, re-hash, `bun run dict:roll`), not a side effect.");
  console.log("  Update `recorded` in config/tools.json in the commit that re-encodes.");
}

if (missing.length === 0) {
  console.log(`\npresence: all ${found.length} present`);
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
