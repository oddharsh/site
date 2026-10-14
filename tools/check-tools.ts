// Check declared photo-tool prerequisites in three tiers:
// - Declaration: bounded shell patterns, documentation, callers, and minimums.
// - Presence: missing required binaries fail locally and are advisory in CI.
// - Version: unreadable versions/minimum violations fail; drift is advisory.
// Scanner floors catch lost matches. This is not a shell interpreter or a
// reconstruction of which executable produced each committed artifact.
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const IN_CI = Boolean(process.env.CI) && !STRICT;

const FLOOR_GUARD_LISTS = 4;
const FLOOR_BREW_HINTS = 4;
const FLOOR_MIN_GUARDS = 1;

type Tool = {
  bin: string;
  path?: string;
  install: string;
  why: string;
  optional?: boolean;
  optional_why?: string;
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

const REPO_PINNED = new Set(["node", "wrangler"]);

const scripts = execFileSync("git", ["ls-files", "-z", "*.sh"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean).sort();
const source = new Map();
for (const rel of scripts) source.set(rel, await readFile(path.join(ROOT, rel), "utf8"));

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

// The shape is `for <var> in <words>; do … command -v "$<var>" …`, which is how
// most of these scripts check their preconditions. A grep for the binary NAME
// cannot see these, because the name only exists as a loop word. That blind spot
// is gotcha 29's, in a different costume.
let guardLists = 0;
const guardPattern = /^[ \t]*for[ \t]+(\w+)[ \t]+in[ \t]+([^;\n]+);?[ \t]*(?:do)?[ \t]*$/gm;
for (const [rel, text] of source) {
  for (const match of text.matchAll(guardPattern)) {
    const [, variable, wordsRaw] = match;
    const after = text.slice(match.index, match.index + 400);
    if (!after.includes(`command -v "$${variable}"`) && !after.includes(`-x "$${variable}"`)) continue;
    guardLists += 1;
    for (const word of wordsRaw.trim().split(/\s+/)) {
      if (word.includes("$")) continue;
      const bin = word.replace(/^["']|["']$/g, "");
      if (!bin || declaredBins.has(bin) || REPO_PINNED.has(bin)) continue;
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

let literalProbes = 0;
for (const [rel, text] of source) {
  for (const match of text.matchAll(/command -v[ \t]+"?([A-Za-z][\w.-]*)"?/g)) {
    const bin = match[1];
    if (bin.startsWith("$")) continue;
    literalProbes += 1;
    if (declaredBins.has(bin) || REPO_PINNED.has(bin)) continue;
    errors.push(`${rel}: probes \`${bin}\`, which config/tools.json does not declare`);
  }
}

// A formula is not a binary (mozjpeg gives jpegtran and cjpeg, libavif gives
// avifenc, webp gives cwebp), so this matches on the install STRING rather than
// trying to translate. A new hint that nothing declares is a new prerequisite.
let brewHints = 0;
for (const [rel, text] of source) {
  for (const match of text.matchAll(/brew install ([a-z0-9][a-z0-9 -]*)/g)) {
    const hint = `brew install ${match[1].trim()}`;
    brewHints += 1;
    if (declaredInstalls.has(hint)) continue;
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

const DOCS = ["CLAUDE.md", "docs/MAINTENANCE.md"];
const docText = (await Promise.all(DOCS.map((d) => readFile(path.join(ROOT, d), "utf8")))).join("\n");
for (const tool of tools) {
  if (!docText.includes(tool.bin)) {
    errors.push(`neither ${DOCS.join(" nor ")} mentions \`${tool.bin}\`; an undocumented prerequisite is the bug this check exists for`);
  }
}

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

// Walk PATH directly rather than shelling out to `command -v`. Passing an
// argument array with `shell: true` concatenates instead of escaping, which
// node 26 deprecates (DEP0190), and a lookup needs no shell anyway.
const PATH_DIRS = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

async function present(tool: Tool): Promise<string | null> {
  const candidates = tool.path
    ? [path.resolve(ROOT, tool.path)]
    : PATH_DIRS.map((dir) => path.join(dir, tool.bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
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

const versionErrors: string[] = [];
const versionNotices: string[] = [];
const versionLines: string[] = [];
const noVersion: string[] = [];

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
    versionErrors.push(
      `${bin}: \`${spec.flag}\` no longer matches its declared pattern. It answered: ${JSON.stringify(text.split("\n")[0] ?? "")}`,
    );
    continue;
  }

  // A pattern may capture MORE THAN ONE component, and it has to when the
  // binary's own version is not the thing that decides the bytes. avifenc
  // answers `Version: 1.4.2 (dav1d [dec]:1.5.4, aom [enc/dec]:3.14.1)`, and aom
  // is the encoder: brew can relink libavif against a newer one without moving
  // 1.4.2, so a pattern reading the wrapper alone passes through exactly the
  // drift this tier exists to catch. NAMED groups join into the recorded string,
  // which keeps the names load-bearing rather than decorative: they are part of
  // the value compared against `recorded`.
  const groups = found_.groups;
  const version = groups
    ? Object.entries(groups)
        .map(([name, value]) => `${name} ${value}`)
        .join(", ")
    : found_[1];

  if (tool.min_version && groups) {
    versionErrors.push(
      `config/tools.json: ${bin} declares min_version ${tool.min_version} and a multi-part version pattern, which cannot be ordered`,
    );
    continue;
  }

  const marks: string[] = [];
  if (tool.min_version && olderThan(version, tool.min_version)) {
    versionErrors.push(`${bin} ${version} is older than the declared minimum ${tool.min_version}`);
    marks.push(`BELOW ${tool.min_version}`);
  }
  if (tool.bytes && tool.recorded && tool.recorded !== version) {
    versionNotices.push(
      `${bin} at ${where} reports ${version}; config/tools.json records ${tool.recorded}.`,
    );
    marks.push(`RECORDED ${tool.recorded}`);
  }
  versionLines.push(`  ${bin.padEnd(18)} ${version}${tool.bytes ? "  (bytes)" : ""}${marks.length ? `  <-- ${marks.join(", ")}` : ""}`);
}

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
  console.log("\nversion: reported versions differ from the recorded baselines.");
  for (const n of versionNotices) console.log(`  - ${n}`);
  console.log("  Advisory: review the callers that select these executables before regenerating artifacts.");
  console.log("  Verify affected outputs and derivations before updating `recorded` in config/tools.json.");
}

if (missing.length === 0) {
  console.log(`\npresence: all ${found.length} present`);
  process.exit(0);
}

const blocking = missing.filter((t) => !t.optional);
const lines = missing.map((t) => `  - ${t.bin}${t.optional ? " (optional)" : ""} — ${t.install}\n      ${t.why}`);

if (IN_CI) {
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
