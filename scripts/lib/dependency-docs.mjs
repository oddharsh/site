// docs/DEPENDENCIES.md is the stated entry point for an agent reviewing a
// dependency PR, and it restates pins in PROSE, so it drifts the moment
// dependabot merges. Measured twice in one day on 2026-08-14: found claiming
// Wrangler 4.112.0 against a 4.120.0 pin, corrected in #371, then wrong again
// within hours when #377 took wrangler to 4.120.1.
//
// THIS FILE IS THE COLLAPSE OF TWO CHECKS THAT LANDED THE SAME DAY. #382 added a
// contract test and #384 added this module, independently, hours apart. Two
// checks over one file is worse than one: they drift, and the weaker one then
// reads as coverage that is not there. Each caught something the other did not,
// so neither was simply deleted.
//
//   from #382 — scope the scan to the `## Current baseline` section; REJECT a
//     range-pinned package in the alias table rather than stripping the caret
//     and comparing, which would let `^1.2.3` agree with a doc claiming
//     `1.2.3`; and say so explicitly when a declared package loses its sentence.
//   from #384 — the REVERSE direction over the whole manifest, which is what
//     caught @noble/post-quantum being undocumented (it was absent from #382's
//     seven-row table, so that check could never have seen it); named
//     exemptions carrying their reason; and a pure core with negative tests.
//
// Same shape as checkTwinFacts() in gen-md-twins.mjs, which pins the
// load-bearing strings in www/md/*.md against the Worker in both directions.
// Same shape as check-tools.mjs #375 in intent, with one difference worth
// keeping in mind: tools.json had to DECLARE what no manifest recorded, while
// every number here already lives in package.json or requirements.txt. So this
// adds no third copy. It reads the manifests as truth and holds the prose to them.
//
// The scanner is deliberately NOT a general "Name 1.2.3" sweep. That would be
// the fourth naive scanner this repo has caught, and this doc's own text breaks
// it four ways: `CSS Overflow 5` and `Vite 8` are not packages, `TypeScript 7.0`
// is prose about a major line rather than the pin, and `0.28.1` / `0.28.2` sit
// in the paragraph explaining that esbuild is no longer a direct dependency and
// that the two remaining copies belong to wrangler and vitest. A sweep would
// demand those match a manifest entry that is correctly absent. This matches a
// KNOWN ALIAS followed by a FULL three-component version, inside the baseline
// section only.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default to THIS repo, so callers cannot pass the wrong kind of root. The
// contract-test caller holds a URL rather than a path, and path.join on a URL
// fails in a way that reads like a missing file.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The heading the claims live under. Scoping to it keeps the intro prose, which
// discusses review policy rather than pins, out of the scan entirely.
export const BASELINE_HEADING = "## Current baseline";

// prose name -> manifest key. This mapping is the one copy the check adds, and
// it is the thing the check exists to hold, so it is explicit rather than
// inferred (nobody writes "@minify-html/node" or "lightningcss" in a sentence).
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
// prose about a major line ("TypeScript 7.0 ships no stable API"), not a claim.
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

// Isolate the baseline section. A missing heading is REPORTED rather than
// silently sliced: indexOf returning -1 would make slice(-1) one character,
// which scans clean and asserts nothing.
export function baselineSection(doc, heading = BASELINE_HEADING) {
  const at = doc.indexOf(heading);
  return at === -1 ? null : doc.slice(at);
}

// Floor: one per alias, plus Pillow. Set AT today's count rather than under it,
// because every alias is separately required to appear, so this can only fall
// by the scanner breaking. Without it a regex that quietly stops matching
// reports a clean pass over nothing, which is the failure this repo has now
// shipped twice.
export const FLOOR_CLAIMS = 8;

// PURE, so the negative cases can run against two-line fixtures. Policy
// (aliases, exemptions, floor, heading) is a PARAMETER rather than a closed-over
// constant, so one rule can be exercised without reconstructing the whole real
// manifest to keep the others quiet. The defaults are the real policy, and the
// live check overrides none of them.
export function auditDependencyDocs({
  doc,
  pins,
  requirements = "",
  aliases = DOC_ALIASES,
  versionless = VERSIONLESS,
  floor = FLOOR_CLAIMS,
  heading = BASELINE_HEADING,
}) {
  const problems = [];

  const baseline = baselineSection(doc, heading);
  if (baseline === null) {
    problems.push(
      `docs/DEPENDENCIES.md has no "${heading}" section, so there is nothing to check. ` +
      `If the heading was renamed, update BASELINE_HEADING in scripts/lib/dependency-docs.mjs.`
    );
    return { claims: [], problems, pillow: null };
  }

  const claims = findClaims(baseline, aliases);
  if (claims.length < floor) {
    problems.push(
      `only ${claims.length} version claim(s) matched in the baseline section, below the floor of ${floor}. ` +
      `The scanner has probably stopped matching rather than the doc having shrunk; check DOC_ALIASES against the prose.`
    );
  }

  const claimed = new Set(claims.map((c) => c.pkg));

  // Every declared alias must still be pinned AND still be claimed. The two
  // halves stop the alias table going stale in opposite directions: a package
  // that leaves package.json has to leave the table, and deleting its sentence
  // must not silently drop it from the check.
  for (const { prose, pkg: key } of aliases) {
    const pinned = pins[key];
    if (!pinned) {
      problems.push(
        `${key} is declared in DOC_ALIASES but package.json no longer pins it. ` +
        `Remove it from the table, and say so in prose without restating a version: ` +
        `a stale number written inside its own correction is still a stale number.`
      );
      continue;
    }
    // Exact pins only. Stripping a caret and comparing would let "^1.2.3" agree
    // with a doc claiming "1.2.3", which is a range the doc cannot honestly
    // state. A range-pinned package belongs in VERSIONLESS with its reason.
    if (!/^\d/.test(pinned)) {
      problems.push(
        `${key} is range-pinned (${pinned}) but declared in DOC_ALIASES, which is for exact pins. ` +
        `Move it to VERSIONLESS with the reason the range is deliberate.`
      );
      continue;
    }
    if (!claimed.has(key)) {
      problems.push(`docs/DEPENDENCIES.md no longer states a version for ${prose} (${key}).`);
    }
  }

  // Forward: every stated version matches the manifest.
  for (const { prose, pkg: key, version } of claims) {
    const pinned = pins[key];
    if (pinned && /^\d/.test(pinned) && pinned !== version) {
      problems.push(
        `docs/DEPENDENCIES.md states "${prose} ${version}" but package.json pins ${key} at ${pinned}. ` +
        `Update the prose to ${pinned}.`
      );
    }
  }

  // Reverse: every root dependency is documented, or exempted by name. This is
  // the direction a fixed alias table structurally cannot have, and it is what
  // makes a NEW dependency force a documentation decision rather than landing
  // unmentioned. It is how @noble/post-quantum was found undocumented.
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
      problems.push(`${key} is exempted in VERSIONLESS but is no longer a root dependency. Remove the exemption.`);
    }
  }

  // Pillow lives in requirements.txt, the one non-npm pin the doc names.
  const pillowDoc = /(?<![\w-])Pillow\s+v?(\d+\.\d+\.\d+[\w.-]*)/i.exec(baseline);
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
