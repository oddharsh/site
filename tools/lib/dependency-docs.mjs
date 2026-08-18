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
// load-bearing strings in src/content/md/*.md against the Worker in both directions.
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
  // The one entry whose prose name is the package name again, for the reason
  // the note below gives about @noble/post-quantum: nobody writes "@oxlint/
  // plugins" in a sentence any other way, so there is no friendlier alias to
  // pick. It is the ABI for the vendored anti-slop rules and moves with oxlint.
  { prose: "@oxlint/plugins", pkg: "@oxlint/plugins" },
  { prose: "minify-html", pkg: "@minify-html/node" },
  { prose: "TypeScript", pkg: "typescript" },
  // @noble/post-quantum sat here as the one entry whose prose name WAS the
  // package name, because it was the only package this repo shipped to a
  // visitor rather than used as a tool. It left with sig2 on 2026-08-15, so
  // every entry above is build or test tooling again and this repo declares no
  // runtime dependencies at all.
];

// Documented on purpose WITHOUT a version, each for a stated reason. An entry
// here is a decision; a package in neither list fails the reverse direction.
export const VERSIONLESS = new Map([
  ["@cloudflare/workers-types", "a date-stamped pin dependabot rolls most days; the doc names the package and its purpose, and a version would be stale on arrival"],
  ["playwright-core", "caret-ranged on purpose (it drives the locally installed Chrome), so there is no exact pin to state"],
]);

// Cargo, narrowly. Only the [dependencies] table, and only the two shapes this
// repo uses: `name = "1.2.3"` and `name = { version = "1.2.3", ... }`. A general
// TOML parser would be a dependency, and this file exists to avoid adding
// copies of things, so it stays a reader for the manifest we actually have.
export function parseCargoDeps(toml) {
  // Split at the next section header rather than anchoring the end. The first
  // draft used `(?=^\[|\Z)`, and oxlint caught it: JavaScript has no \Z, so that
  // arm matched a literal "Z" and the table could only be found when ANOTHER
  // section followed it. It passed against the real Cargo.toml purely because
  // [profile.release] sits after [dependencies], and would have returned an
  // empty set, silently, for a manifest whose dependencies came last.
  const section = /^\[dependencies\]\s*$([\s\S]*)/m.exec(toml);
  if (!section) return {};
  const body = section[1].split(/^\[/m)[0];
  const out = {};
  for (const line of body.split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^\s*([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*?\bversion\s*=\s*"([^"]+)")/.exec(line);
    if (m) out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

// The four manifests outside package.json. Each carries its own alias table and
// exemptions where it has dependencies, for the same reason the root does: the
// mapping from prose to package key is the copy the check adds, so it is explicit.
//
// Note which packages are NOT here as exact claims. cal pins every dependency
// with a caret, and Cargo treats a bare `"0.25"` as a caret range, so those
// entries are exempted rather than stated. That split is the point: a range is a
// version the prose cannot honestly state. cf-garage stays in this list with an
// empty policy so a future dependency cannot arrive undocumented.
export const SUB_MANIFEST_POLICY = [
  {
    manifest: "lens-reader/package.json",
    kind: "npm",
    aliases: [
      { prose: "@mozilla/readability", pkg: "@mozilla/readability" },
      { prose: "linkedom", pkg: "linkedom" },
    ],
    versionless: new Map(),
  },
  {
    manifest: "cal/package.json",
    kind: "npm",
    aliases: [],
    versionless: new Map([
      ["vitest", "caret-ranged; it is the test runner for cal alone and pulls the Vite 8 chain, so the exact resolution is the lockfile's business"],
      ["@cloudflare/vitest-pool-workers", "caret-ranged; it must track the vitest above and the miniflare wrangler carries, so pinning it here would fight both"],
    ]),
  },
  {
    manifest: "cf-garage/package.json",
    kind: "npm",
    aliases: [],
    versionless: new Map(),
  },
  {
    manifest: "tools/photos/zenc/Cargo.toml",
    kind: "cargo",
    aliases: [{ prose: "zenjpeg", pkg: "zenjpeg" }],
    versionless: new Map([
      ["image", "Cargo reads a bare \"0.25\" as a caret range, so there is no exact pin to state; it decodes pipeline input and never touches output bytes"],
      ["serde_json", "Cargo reads a bare \"1.0\" as a caret range. It arrived with the histogram bake in #373 and was undocumented until this check's reverse direction found it, which is the second time that direction has caught a real gap"],
    ]),
  },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A claim is an alias followed by a THREE-component version. Two components is
// prose about a major line ("TypeScript 7.0 ships no stable API"), not a claim.
// The optional backtick matters: this doc writes package names as `code` far
// more often than bare, so requiring `name 1.2.3` would silently match nothing
// for every entry written in the file's own house style. Found the moment the
// sub-manifest entries were added, where every name is backticked.
const claimPattern = (prose) =>
  new RegExp(`(?<![\\w-])${escape(prose)}\`?\\s+v?(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, "gi");

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

// Floor: one per alias across ALL FIVE manifests (7 root + 4 in the three
// sub-manifests that carry exact pins). Set AT today's count rather than under
// it, because every alias is separately required to appear, so this can only
// fall by the scanner breaking. Without it a regex that quietly stops matching
// reports a clean pass over nothing, which is the failure this repo has now
// shipped twice, and which the backtick gap below would have been a third of.
//
// 12 until 2026-08-15, when @noble/post-quantum left with sig2. Lower this ONLY
// alongside a dependency that genuinely went away, and never to quiet a red
// check: a drop with the manifests unchanged is the scanner breaking, which is
// the entire thing this number exists to catch.
export const FLOOR_CLAIMS = 12;

// ONE manifest's worth of checking, in all four directions. Extracted from the
// root path on 2026-08-14 so the four manifests outside package.json get the
// same rules rather than a weaker second implementation, which is the trap #386
// had just finished cleaning up after (two checks over one file, the weaker one
// reading as coverage that was not there).
//
// The root's message strings are preserved BYTE-FOR-BYTE through `manifest`,
// `membership`, `table` and `exemptList`, because the negative tests assert on
// them and a refactor that quietly reworded them would be asserting less while
// still passing.
export function auditManifest({
  claims, claimed, problems, pins, aliases, versionless,
  manifest, membership, table, exemptList,
}) {
  // Every declared alias must still be pinned AND still be claimed. The two
  // halves stop the alias table going stale in opposite directions: a package
  // that leaves the manifest has to leave the table, and deleting its sentence
  // must not silently drop it from the check.
  for (const { prose, pkg: key } of aliases) {
    const pinned = pins[key];
    if (!pinned) {
      problems.push(
        `${key} is declared in ${table} but ${manifest} no longer pins it. ` +
        `Remove it from the table, and say so in prose without restating a version: ` +
        `a stale number written inside its own correction is still a stale number.`
      );
      continue;
    }
    // Exact pins only. Stripping a caret and comparing would let "^1.2.3" agree
    // with a doc claiming "1.2.3", which is a range the doc cannot honestly
    // state. A range-pinned package belongs in the exemption list with its
    // reason. Cargo counts a bare `"0.25"` as a caret range too, so it fails
    // here for the same reason a `^` would.
    if (!/^\d+\.\d+\.\d/.test(pinned)) {
      problems.push(
        `${key} is range-pinned (${pinned}) but declared in ${table}, which is for exact pins. ` +
        `Move it to ${exemptList} with the reason the range is deliberate.`
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
        `docs/DEPENDENCIES.md states "${prose} ${version}" but ${manifest} pins ${key} at ${pinned}. ` +
        `Update the prose to ${pinned}.`
      );
    }
  }

  // Reverse: every dependency is documented, or exempted by name. This is the
  // direction a fixed alias table structurally cannot have, and it is what makes
  // a NEW dependency force a documentation decision rather than landing
  // unmentioned. It is how @noble/post-quantum was found undocumented.
  for (const key of Object.keys(pins)) {
    if (claimed.has(key) || versionless.has(key)) continue;
    problems.push(
      `${key} is ${membership} and docs/DEPENDENCIES.md does not state its version. ` +
      `Add a line for it, or add it to ${exemptList} in tools/lib/dependency-docs.mjs with the reason.`
    );
  }

  // An exemption for a package that has left is stale, and a stale exemption is
  // how a real gap gets waved through later.
  for (const key of versionless.keys()) {
    if (!pins[key]) {
      problems.push(`${key} is exempted in ${exemptList} but is no longer ${membership}. Remove the exemption.`);
    }
  }
}

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
  subManifests = [],
}) {
  const problems = [];

  const baseline = baselineSection(doc, heading);
  if (baseline === null) {
    problems.push(
      `docs/DEPENDENCIES.md has no "${heading}" section, so there is nothing to check. ` +
      `If the heading was renamed, update BASELINE_HEADING in tools/lib/dependency-docs.mjs.`
    );
    return { claims: [], problems, pillow: null };
  }

  // Claims are gathered for EVERY manifest before the floor is judged. Checking
  // the floor against the root's claims alone would fail the moment a
  // sub-manifest alias existed, which is exactly what it did the first time this
  // ran: 8 root claims measured against a floor of 12 that counts all five
  // manifests. The floor is a scanner-broke tripwire, so it has to see the whole
  // scan.
  const claims = findClaims(baseline, aliases);
  const claimed = new Set(claims.map((c) => c.pkg));

  const subScans = [];
  for (const sub of subManifests) {
    if (sub.missing) continue;
    // Per manifest, against that manifest's OWN alias table. Reusing the root's
    // claims would scan for the root's names only, so every sub-manifest entry
    // would read as undocumented no matter what the prose said.
    const subClaims = findClaims(baseline, sub.aliases);
    subScans.push({ sub, subClaims, subClaimed: new Set(subClaims.map((c) => c.pkg)) });
    claims.push(...subClaims);
  }

  if (claims.length < floor) {
    problems.push(
      `only ${claims.length} version claim(s) matched in the baseline section, below the floor of ${floor}. ` +
      `The scanner has probably stopped matching rather than the doc having shrunk; check DOC_ALIASES against the prose.`
    );
  }

  auditManifest({
    claims, claimed, problems,
    pins, aliases, versionless,
    manifest: "package.json",
    membership: "a root dependency",
    table: "DOC_ALIASES",
    exemptList: "VERSIONLESS",
  });

  // The four manifests OUTSIDE the root, added 2026-08-14. Each is read with
  // the same rules, its own alias table, and its own exemptions. Passing them in
  // rather than closing over them is what lets a negative test exercise one
  // manifest without reconstructing the other three.
  for (const sub of subManifests) {
    if (!sub.missing) continue;
    problems.push(
      `${sub.manifest} is declared in SUB_MANIFEST_POLICY but could not be read. ` +
      `If it moved, update the path; if the project is gone, remove the entry.`
    );
  }

  for (const { sub, subClaims, subClaimed } of subScans) {
    auditManifest({
      claims: subClaims, claimed: subClaimed, problems,
      pins: sub.pins,
      aliases: sub.aliases,
      versionless: sub.versionless,
      manifest: sub.manifest,
      membership: `a ${sub.manifest} dependency`,
      table: `SUB_MANIFESTS[${JSON.stringify(sub.manifest)}]`,
      exemptList: `that entry's versionless map`,
    });
  }

  // Pillow lives in requirements.txt, the one non-npm pin the doc names.
  const pillowDoc = /(?<![\w-])Pillow\s+v?(\d+\.\d+\.\d+[\w.-]*)/i.exec(baseline);
  const pillowPin = /^\s*Pillow==([^\s#]+)/im.exec(requirements);
  if (pillowPin && !pillowDoc) {
    problems.push(`tools/photos/requirements.txt pins Pillow==${pillowPin[1]} and docs/DEPENDENCIES.md states no version for it.`);
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
    read("tools/photos/requirements.txt").catch(() => ""),
  ]);
  const pkg = JSON.parse(pkgRaw);

  // A manifest that cannot be READ is a problem rather than an empty pin set:
  // silently auditing {} would report a clean pass over a file somebody moved.
  const subManifests = [];
  for (const entry of SUB_MANIFEST_POLICY) {
    let raw;
    try {
      raw = await read(entry.manifest);
    } catch {
      subManifests.push({ ...entry, pins: {}, missing: true });
      continue;
    }
    const pins = entry.kind === "cargo"
      ? parseCargoDeps(raw)
      : (() => { const m = JSON.parse(raw); return { ...m.dependencies, ...m.devDependencies }; })();
    subManifests.push({ ...entry, pins });
  }

  return auditDependencyDocs({
    doc,
    pins: { ...pkg.dependencies, ...pkg.devDependencies },
    requirements,
    subManifests,
  });
}
