// Keep current dependency version claims aligned with their manifests. The
// reader and relock writer share the same alias scanner, scoped to the current
// baseline so historical measurements and major-version prose stay untouched.
// Every dependency needs a claim or an explicit versionless policy; removed
// dependencies invalidate both aliases and exemptions.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "./toml.ts";
import { asRecord, asText } from "../../src/worker/lib/parse.ts";
import { EXACT_PIN } from "./exact-pin.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BASELINE_HEADING = "## Current baseline";

export const DOC_ALIASES = [
  { prose: "Oxc Minify", pkg: "oxc-minify" },
  { prose: "Lightning CSS", pkg: "lightningcss" },
  { prose: "@oxlint/plugins", pkg: "@oxlint/plugins" },
  { prose: "@types/bun", pkg: "@types/bun" },
  { prose: "@cloudflare/config", pkg: "@cloudflare/config" },
  { prose: "playwright-core", pkg: "playwright-core" },
];

export const VERSIONLESS = new Map<string, string>([
  ["av2-tone", "a git dependency pinned to a full commit sha of github.com/oddharsh/av2-tone since 2026-10-14: the AV2 tooling that moved out of tools/photos (the pinned libavif + AVM build, the tuned encoder patches, the WebAssembly decoder, GDF on Metal), unpublished on npm (its package.json is private), so the sha in package.json is the identity and bun.lock records the tarball's sha512. It is version 0.0.0 by design until the Rust decoder publishes to crates.io, and the prose names the shape rather than a number"],
  ["timbrado", "a git dependency pinned to a full commit sha of github.com/oddharsh/timbrado since 2026-09-15: the tool extracted from the canary legs (the watch runner, a Rust engine built on demand since 0.2.0; the reporter; the digest), unpublished on npm like halflight, so the sha in package.json is the identity and bun.lock records the tarball's sha512. Bumping it is a hand edit of the sha plus a relock, and the prose names the shape rather than a number"],
  ["wrangler", "pinned to a COMMIT of cloudflare/workers-sdk main through a pkg.pr.new tarball URL since 2026-09-14, so there is no release number to state: the sha in the URL is the identity, bun.lock records the tarball's sha512, and `bun run check-wrangler` holds the URL, the lockfile and the installed version together. The prose names the channel and the reason; a number written there would be the tarball's own version, which the next nightly advance moves"],
]);

export type DependencyVersions = Record<string, string | null>;
export function parseCargoDeps(toml: string): DependencyVersions {
  const raw = parseToml(toml).dependencies;
  if (raw === undefined) return {};
  const dependencies = asRecord(raw);
  if (!dependencies) throw new Error("Cargo dependencies must be a table");
  return Object.fromEntries(Object.entries(dependencies).map(([name, value]) => {
    const spec = asRecord(value);
    const version = spec ? spec.version : value;
    if (spec && version === undefined && !(value instanceof Date)) return [name, null];
    const text = asText(version);
    if (text === null) throw new Error(`Cargo dependency ${name} must declare a string version or a source table`);
    return [name, text];
  }));
}

export const SUB_MANIFEST_POLICY = [
  {
    manifest: "lens-reader/package.json",
    kind: "npm",
    aliases: [
      { prose: "@mozilla/readability", pkg: "@mozilla/readability" },
      { prose: "htmlparser2", pkg: "htmlparser2" },
      { prose: "linkedom", pkg: "linkedom" },
    ],
    versionless: new Map(),
  },
  {
    manifest: "cal/package.json",
    kind: "npm",
    aliases: [],
    versionless: new Map(),
  },
  {
    manifest: "cf-garage/package.json",
    kind: "npm",
    aliases: [],
    versionless: new Map([
      ["wrangler", "the root's exact pkg.pr.new commit URL, restated so the `cf` CLI finds a dev server in cf-garage's own manifest; check-wrangler holds the two byte-equal and bump-wrangler-pin moves both, so the root line in DEPENDENCIES.md is its version"],
    ]),
  },
  {
    manifest: "config/dev/package.json",
    kind: "npm",
    aliases: [],
    versionless: new Map([
      ["wrangler", "the root's exact pkg.pr.new commit URL, restated so `cf dev` (tools/dev.ts) finds a dev server in config/dev's own manifest; check-wrangler holds the two byte-equal and bump-wrangler-pin moves both, so the root line in DEPENDENCIES.md is its version"],
    ]),
  },
  {
    manifest: "tools/photos/zenc/Cargo.toml",
    kind: "cargo",
    aliases: [{ prose: "zenjpeg", pkg: "zenjpeg" }],
    versionless: new Map([
      ["halflight", "Pinned by git revision in Cargo.toml and Cargo.lock, with no semantic version to state; docs/DEPENDENCIES.md records its manual update and output-parity requirements"],
      ["image", "Cargo reads a bare \"0.25\" as a caret range, so there is no exact pin to state; it decodes pipeline input and never touches output bytes"],
      ["serde_json", "Cargo reads a bare \"1.0\" as a caret range. It arrived with the histogram bake in #373 and was undocumented until this check's reverse direction found it, which is the second time that direction has caught a real gap"],
    ]),
  },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const claimPattern = (prose) =>
  new RegExp(`(?<![\\w-])${escape(prose)}\`?\\s+v?(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, "gi");

export function findClaims(doc: string, aliases: DocAlias[] = DOC_ALIASES): DocClaim[] {
  const claims: DocClaim[] = [];
  for (const { prose, pkg } of aliases) {
    for (const m of doc.matchAll(claimPattern(prose))) {
      claims.push({ prose, pkg, version: m[1], index: m.index });
    }
  }
  return claims;
}

export function baselineSection(doc, heading = BASELINE_HEADING) {
  const at = doc.indexOf(heading);
  return at === -1 ? null : doc.slice(at);
}

export const FLOOR_CLAIMS = 11;

export function auditManifest({
  claims, claimed, problems, pins, aliases, versionless,
  manifest, membership, table, exemptList,
}) {
  for (const { prose, pkg: key } of aliases) {
    const pinned = pins[key];
    if (!Object.hasOwn(pins, key)) {
      problems.push(
        `${key} is declared in ${table} but ${manifest} no longer pins it. ` +
        `Remove it from the table, and say so in prose without restating a version: ` +
        `a stale number written inside its own correction is still a stale number.`
      );
      continue;
    }
    if (pinned === null) {
      problems.push(`${key} has no semantic version in ${manifest}; move it to ${exemptList} with the reason.`);
      continue;
    }
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

  for (const { prose, pkg: key, version } of claims) {
    const pinned = pins[key];
    if (pinned && /^\d/.test(pinned) && pinned !== version) {
      problems.push(
        `docs/DEPENDENCIES.md states "${prose} ${version}" but ${manifest} pins ${key} at ${pinned}. ` +
        `Update the prose to ${pinned}.`
      );
    }
  }

  for (const key of Object.keys(pins)) {
    if (claimed.has(key) || versionless.has(key)) continue;
    problems.push(
      `${key} is ${membership} and docs/DEPENDENCIES.md does not state its version. ` +
      `Add a line for it, or add it to ${exemptList} in tools/lib/dependency-docs.ts with the reason.`
    );
  }

  for (const key of versionless.keys()) {
    if (!Object.hasOwn(pins, key)) {
      problems.push(`${key} is exempted in ${exemptList} but is no longer ${membership}. Remove the exemption.`);
    }
  }
}

export function auditDependencyDocs({
  doc,
  pins,
  aliases = DOC_ALIASES,
  versionless = VERSIONLESS,
  floor = FLOOR_CLAIMS,
  heading = BASELINE_HEADING,
  subManifests = [],
}: {
  doc: string;
  pins: DependencyVersions;
  aliases?: DocAlias[];
  versionless?: Map<string, unknown>;
  floor?: number;
  heading?: string;
  subManifests?: AuditedManifest[];
}) {
  const problems: string[] = [];

  const baseline = baselineSection(doc, heading);
  if (baseline === null) {
    problems.push(
      `docs/DEPENDENCIES.md has no "${heading}" section, so there is nothing to check. ` +
      `If the heading was renamed, update BASELINE_HEADING in tools/lib/dependency-docs.ts.`
    );
    return { claims: [], problems, pillow: null };
  }

  const claims = findClaims(baseline, aliases);
  const claimed = new Set(claims.map((c) => c.pkg));

  const subScans: { sub: AuditedManifest; subClaims: DocClaim[]; subClaimed: Set<string> }[] = [];
  for (const sub of subManifests) {
    if (sub.missing) continue;
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

  if (/(?<![\w-])Pillow\s+v?\d+\.\d+/i.test(baseline)) {
    problems.push("docs/DEPENDENCIES.md states a Pillow version, and there is no Python in the tree to pin it (retired 2026-09-15).");
  }

  return { claims, problems };
}

export async function checkDependencyDocs(root = REPO_ROOT) {
  const read = (p) => readFile(path.join(root, p), "utf8");
  const [doc, pkgRaw] = await Promise.all([
    read("docs/DEPENDENCIES.md"),
    read("package.json"),
  ]);
  const pkg = JSON.parse(pkgRaw);

  const subManifests: AuditedManifest[] = [];
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
    subManifests,
  });
}

export { EXACT_PIN };

type DocAlias = { prose: string; pkg: string };
type DocClaim = { prose: string; pkg: string; version: string; index: number };
type DocPinScan = { aliases: DocAlias[]; pins: DependencyVersions; versionless: Map<string, unknown> };
export type DocPinEdit = { pkg: string; prose: string; from: string; to: string; start: number };
type SubManifestScan = { missing?: boolean; aliases: DocAlias[]; pins: DependencyVersions; versionless?: Map<string, unknown> };
type AuditedManifest = SubManifestScan & { manifest: string; versionless: Map<string, unknown> };
type PlanDocPinRewritesInput = {
  doc: string;
  pins: DependencyVersions;
  aliases?: DocAlias[];
  versionless?: Map<string, unknown>;
  subManifests?: SubManifestScan[];
  heading?: string;
};

export function planDocPinRewrites({
  doc,
  pins,
  aliases = DOC_ALIASES,
  versionless = VERSIONLESS,
  subManifests = [],
  heading = BASELINE_HEADING,
}: PlanDocPinRewritesInput): { updated: string; edits: DocPinEdit[] } {
  const at = doc.indexOf(heading);
  if (at === -1) return { updated: doc, edits: [] };
  const baseline = doc.slice(at);

  const scans: DocPinScan[] = [{ aliases, pins, versionless }];
  for (const sub of subManifests) {
    if (sub.missing) continue;
    scans.push({ aliases: sub.aliases, pins: sub.pins, versionless: sub.versionless ?? new Map() });
  }

  const edits: DocPinEdit[] = [];
  for (const scan of scans) {
    for (const claim of findClaims(baseline, scan.aliases)) {
      if (scan.versionless?.has?.(claim.pkg)) continue;
      const want = scan.pins[claim.pkg];
      if (!want || !EXACT_PIN.test(want)) continue;
      if (want === claim.version) continue;
      const rel = baseline.indexOf(claim.version, claim.index);
      if (rel === -1) continue;
      edits.push({ pkg: claim.pkg, prose: claim.prose, from: claim.version, to: want, start: at + rel });
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let updated = doc;
  for (const e of edits) {
    updated = updated.slice(0, e.start) + e.to + updated.slice(e.start + e.from.length);
  }
  return { updated, edits: edits.slice().reverse() };
}
