// docs/DEPENDENCIES.md states version pins in prose, and the manifests move
// under it on dependabot's daily schedule. That drift is not bad luck, it is
// structural: the file hand-transcribes numbers that a bot rewrites, so it goes
// stale on a cadence. It has now done so twice in two days (#371 corrected
// Wrangler 4.112.0 -> 4.120.0 and merged; #377 bumped the pin to 4.120.1 hours
// later), and both times a human found it rather than a check.
//
// Same shape as check-tools.mjs: the fix is not to fix the number, it is to make
// the claim checkable. The difference is that tools.json had to DECLARE what no
// manifest recorded, while every number here is already in package.json or
// requirements.txt. So this adds no third copy. It reads the manifests as the
// source of truth and holds the prose to them.
//
// TWO DIRECTIONS, because either alone is decoration:
//   - forward: every version this doc states for a known package must match.
//   - reverse: every root dependency must be documented, or exempted by name
//     with a reason, so ADDING a dependency forces a documentation decision
//     instead of silently landing undocumented.
//
// The scanner is deliberately NOT a general "Name 1.2.3" sweep over prose. That
// is the fourth naive scanner this repo would have written, and this file's own
// text breaks it three ways: `CSS Overflow 5`, `Vite 8`, and `TypeScript 7.0`
// (two components, discussing the major line, not the pin) all read as version
// claims. It matches a KNOWN ALIAS followed by a FULL three-component version,
// which excludes all three by construction.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default to THIS repo, so callers cannot pass the wrong kind of root. The one
// caller in contract-tests.mjs holds a URL rather than a path, and path.join on
// a URL fails in a way that reads like a missing file.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// prose name -> manifest key. This mapping is the one copy this check adds, and
// it is the thing the check exists to hold, so it is small and explicit rather
// than inferred from the package name (nobody writes "@minify-html/node" or
// "lightningcss" in a sentence).
export const DOC_ALIASES = [
  { prose: "Wrangler", pkg: "wrangler" },
  { prose: "Oxc Minify", pkg: "oxc-minify" },
  { prose: "Lightning CSS", pkg: "lightningcss" },
  { prose: "Oxlint", pkg: "oxlint" },
  { prose: "oxlint-tsgolint", pkg: "oxlint-tsgolint" },
  { prose: "minify-html", pkg: "@minify-html/node" },
  { prose: "TypeScript", pkg: "typescript" },
  // The one entry whose prose name IS the package name, because it is the one
  // package this doc discusses as a shipped dependency rather than as a tool.
  { prose: "@noble/post-quantum", pkg: "@noble/post-quantum" },
];

// Documented on purpose WITHOUT a version, each for a stated reason. An entry
// here is a decision; a package in neither list fails the reverse direction.
export const VERSIONLESS = new Map([
  ["@cloudflare/workers-types", "a date-stamped pin dependabot rolls most days; the doc names the package and its purpose, and a version would be stale on arrival"],
  ["playwright-core", "caret-ranged on purpose (it drives the locally installed Chrome), so there is no exact pin to state"],
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A claim is an alias followed by a THREE-component version. Two components is
// prose about a major line ("TypeScript 7.0 ships no stable API") and is not a
// claim about the pin.
const claimPattern = (prose) =>
  new RegExp(`(?<![\\w-])${escape(prose)}\\s+v?(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, "gi");

export function findClaims(doc, aliases = DOC_ALIASES) {
  const claims = [];
  for (const { prose, pkg } of aliases) {
    for (const m of doc.matchAll(claimPattern(prose))) {
      claims.push({ prose, pkg, version: m[1], index: m.index });
    }
  }
  return claims;
}

// Floor. Comfortably under today's count (8) and above zero, so ordinary edits
// never trip it and a scanner that stops matching always does. Without it a
// regex that quietly matches nothing reports a clean pass while checking
// nothing, which is the failure mode this repo has now shipped twice.
export const FLOOR_CLAIMS = 5;

// PURE, so the negative cases below can be exercised against synthetic input.
// The same reasoning as lib/cron.js: a rule that can only be tested by being
// true of the current tree is a rule nobody can prove has teeth, and this repo
// has shipped two checks that passed while asserting nothing.
// Policy (aliases, exemptions, floor) is a PARAMETER rather than a closed-over
// constant, so a negative case can exercise one rule against a two-line fixture
// instead of having to reconstruct the whole real manifest to keep the other
// rules quiet. The defaults are the real policy, and the live check passes none
// of them.
export function auditDependencyDocs({
  doc,
  pins,
  requirements = "",
  aliases = DOC_ALIASES,
  versionless = VERSIONLESS,
  floor = FLOOR_CLAIMS,
}) {
  const problems = [];

  const claims = findClaims(doc, aliases);
  if (claims.length < floor) {
    problems.push(
      `only ${claims.length} version claim(s) matched in docs/DEPENDENCIES.md, below the floor of ${floor}. ` +
      `The scanner has probably stopped matching rather than the doc having shrunk; check DOC_ALIASES against the prose.`
    );
  }

  // Forward: every stated version matches the manifest.
  for (const { prose, pkg: key, version } of claims) {
    const pinned = pins[key];
    if (!pinned) {
      problems.push(
        `docs/DEPENDENCIES.md states "${prose} ${version}", but ${key} is not a root dependency. ` +
        `If it was removed, say so in prose without restating a version: a stale number written as ` +
        `"${prose} ${version}" inside its own correction is still a stale number.`
      );
      continue;
    }
    const exact = pinned.replace(/^[\^~]/, "");
    if (exact !== version) {
      problems.push(
        `docs/DEPENDENCIES.md states "${prose} ${version}" but package.json pins ${key} at ${pinned}. ` +
        `Update the prose to ${exact}.`
      );
    }
  }

  // Reverse: every root dependency is documented, or exempted by name.
  const claimed = new Set(claims.map((c) => c.pkg));
  for (const key of Object.keys(pins)) {
    if (claimed.has(key) || versionless.has(key)) continue;
    problems.push(
      `${key} is a root dependency and docs/DEPENDENCIES.md does not state its version. ` +
      `Add a line for it, or add it to VERSIONLESS in scripts/lib/dependency-docs.mjs with the reason.`
    );
  }

  // A VERSIONLESS entry for a package that has left is a stale exemption, and a
  // stale exemption is how a real gap gets waved through later.
  for (const key of versionless.keys()) {
    if (!pins[key]) {
      problems.push(
        `${key} is exempted in VERSIONLESS but is no longer a root dependency. Remove the exemption.`
      );
    }
  }

  // Pillow lives in requirements.txt, not package.json.
  const pillowDoc = /(?<![\w-])Pillow\s+v?(\d+\.\d+\.\d+[\w.-]*)/i.exec(doc);
  const pillowPin = /^\s*Pillow==([^\s#]+)/im.exec(requirements);
  if (pillowPin && !pillowDoc) {
    problems.push(`www/scripts/requirements.txt pins Pillow==${pillowPin[1]} and docs/DEPENDENCIES.md states no version for it.`);
  } else if (pillowPin && pillowDoc && pillowPin[1] !== pillowDoc[1]) {
    problems.push(`docs/DEPENDENCIES.md states "Pillow ${pillowDoc[1]}" but requirements.txt pins ${pillowPin[1]}.`);
  } else if (!pillowPin && pillowDoc) {
    problems.push(`docs/DEPENDENCIES.md states "Pillow ${pillowDoc[1]}" but requirements.txt no longer pins it.`);
  }

  return { claims, problems, pillow: pillowPin ? pillowPin[1] : null };
}

// The thin I/O shell. Everything decidable lives in auditDependencyDocs above.
export async function checkDependencyDocs(root = REPO_ROOT) {
  const read = (p) => readFile(path.join(root, p), "utf8");
  const [doc, pkgRaw, requirements] = await Promise.all([
    read("docs/DEPENDENCIES.md"),
    read("package.json"),
    read("www/scripts/requirements.txt").catch(() => ""),
  ]);
  const pkg = JSON.parse(pkgRaw);
  return auditDependencyDocs({
    doc,
    pins: { ...pkg.dependencies, ...pkg.devDependencies },
    requirements,
  });
}
