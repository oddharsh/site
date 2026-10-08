// What `bun run deps:pin` would bump, as a pure function of the manifests and
// the registry. tools/bump-deps.ts does the fetching and the writing; this file
// decides, so the decision is testable with no network and no tree.
//
// WHY THIS EXISTS: Dependabot stopped bumping npm here on 2026-09-25. Its npm
// updater refuses any directory holding a bun.lock (dependabot-core#16220), and
// its bun updater refuses a lockfile above version 1
// (`MAX_SUPPORTED_LOCKFILE_VERSION = 1`, dependabot-core#16026), while bun 1.4
// writes version 2. Nothing errored where anyone looked: the npm jobs failed in
// the Dependabot Updates log, and the cargo and actions jobs kept opening PRs,
// so the queue never looked empty. oxc-minify 0.152 and 0.153 and two oxlint
// releases went by with no PR before anyone noticed.
//
// THE POLICY IS DEPENDABOT'S, carried over rather than redesigned:
//   - A version younger than bunfig.toml's `minimumReleaseAge` is invisible.
//     That is the same 24 hours Dependabot's `cooldown` stated, and here it is
//     load-bearing: bun refuses to resolve an exact pin younger than the window,
//     so proposing one would open a PR nobody can install.
//   - Prereleases are skipped unless the pin is itself a prerelease.
//   - Deprecated versions are skipped.
//   - The named groups below are the ones .github/dependabot.yml declared. A
//     named group takes every update type, majors included; whatever is left
//     goes to `minor-and-patch` when it is minor or patch, and to a PR of its
//     own when it is major.
//
// Only EXACT pins are planned. A range, a URL (the wrangler pin is a pkg.pr.new
// commit with its own job, wrangler-pin.yml), `workspace:` or a git spec is
// left alone, because nothing here can say what "newer" means for it.

import { EXACT_PIN } from "./dependency-docs.ts";

export type Manifest = {
  /** Repo-relative path, "package.json" for the root. */
  path: string;
  json: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
};

/** The two fields of a registry document the plan reads. */
export type RegistryDoc = {
  versions?: Record<string, { deprecated?: string }>;
  time?: Record<string, string>;
};

export type UpdateType = "major" | "minor" | "patch" | "prerelease";

export type Bump = {
  pkg: string;
  from: string;
  to: string;
  type: UpdateType;
  group: string;
  /** Every manifest that pins `pkg` at `from`; they move together. */
  manifests: string[];
};

export type Group = { name: string; patterns: string[] };

// Carried from .github/dependabot.yml on 2026-10-06, reasons included. A
// pattern is an exact name or a scope glob (`@cloudflare/*`); the FIRST group
// that matches wins, so order is load-bearing.
//
// Groups replaced `open-pull-requests-limit: 1`, which queued every pin behind
// one PR: seven packages were outdated at once on 2026-08-19 with zero PRs
// open, because the fastest-releasing four outran a serialized queue.
export const GROUPS: Group[] = [
  // The linter ABI. `@oxlint/plugins` is the interface between oxlint and the
  // three rules vendored at tools/oxlint/anti-slop; the two ship one version
  // number and a mismatch fails at PLUGIN LOAD, so moving one without the other
  // reds `validate` on unchanged code.
  { name: "oxlint", patterns: ["oxlint", "@oxlint/plugins"] },
  // tsgolint tracks the TYPESCRIPT pin, not the oxlint one. TypeScript 7.0
  // ships no stable programmatic API, so tsgolint is the only door to the
  // type-aware rules, and its releases pair with TypeScript's.
  { name: "typescript", patterns: ["typescript", "oxlint-tsgolint"] },
  // One resolved Cloudflare stack: one miniflare, one workerd, one undici. A
  // @cloudflare/* package carrying its own wrangler, bumped apart, splits that
  // stack in two. wrangler itself is a pkg.pr.new commit URL today, owned by
  // wrangler-pin.yml and skipped here as a non-exact pin; the pattern stays for
  // the day it returns to a release number.
  { name: "cloudflare-toolchain", patterns: ["wrangler", "@cloudflare/*"] },
  // The three packages that REWRITE BUILT BYTES, in their own lane so a
  // content-hash re-mint is always one identifiable PR. Measured 2026-08-19 on
  // oxc-minify 0.144.0 -> 0.145.0: 10 hashed /a/ assets re-minted for 22 B of
  // brotli, and a new hash costs returning visitors the shell dictionary tier
  // until dictionary-roll.yml catches up that night.
  { name: "minifiers", patterns: ["oxc-minify", "lightningcss"] },
];
export const CATCH_ALL = "minor-and-patch";

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

type Semver = { major: number; minor: number; patch: number; pre: string[] };

export function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver 2.0 precedence: negative when a < b. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not semver: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  // A release outranks every prerelease of the same triple.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export function updateType(from: string, to: string): UpdateType {
  const a = parseSemver(from)!;
  const b = parseSemver(to)!;
  if (b.pre.length) return "prerelease";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  return "patch";
}

function matches(pattern: string, pkg: string) {
  return pattern.endsWith("/*") ? pkg.startsWith(pattern.slice(0, -1)) : pattern === pkg;
}

export function groupFor(pkg: string, type: UpdateType, groups = GROUPS): string {
  const named = groups.find((g) => g.patterns.some((p) => matches(p, pkg)));
  if (named) return named.name;
  return type === "major" ? pkg : CATCH_ALL;
}

/**
 * The newest version of a package that is old enough, not deprecated, and a
 * release (or a prerelease, when `from` is one). Null when nothing beats `from`.
 */
export function newestEligible(doc: RegistryDoc, from: string, nowMs: number, minAgeSeconds: number): string | null {
  const allowPre = (parseSemver(from)?.pre.length ?? 0) > 0;
  let best: string | null = null;
  for (const [v, meta] of Object.entries(doc.versions ?? {})) {
    const sv = parseSemver(v);
    if (!sv) continue;
    if (sv.pre.length && !allowPre) continue;
    if (meta?.deprecated) continue;
    const published = Date.parse(doc.time?.[v] ?? "");
    // No timestamp means no proof of age, which reads as too young.
    if (!Number.isFinite(published) || nowMs - published < minAgeSeconds * 1000) continue;
    if (compareSemver(v, from) <= 0) continue;
    if (!best || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** Every exact pin across the manifests, as name -> version -> manifest paths. */
export function exactPins(manifests: Manifest[]) {
  const pins = new Map<string, Map<string, string[]>>();
  for (const m of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [pkg, spec] of Object.entries(m.json[field] ?? {})) {
        if (!EXACT_PIN.test(spec)) continue;
        const byVersion = pins.get(pkg) ?? new Map<string, string[]>();
        const paths = byVersion.get(spec) ?? [];
        if (!paths.includes(m.path)) paths.push(m.path);
        byVersion.set(spec, paths);
        pins.set(pkg, byVersion);
      }
    }
  }
  return pins;
}

export function planBumps({
  manifests,
  registry,
  nowMs,
  minAgeSeconds,
  groups = GROUPS,
}: {
  manifests: Manifest[];
  registry: Map<string, RegistryDoc>;
  nowMs: number;
  minAgeSeconds: number;
  groups?: Group[];
}): Bump[] {
  const bumps: Bump[] = [];
  for (const [pkg, byVersion] of exactPins(manifests)) {
    const doc = registry.get(pkg);
    if (!doc) continue;
    for (const [from, paths] of byVersion) {
      const to = newestEligible(doc, from, nowMs, minAgeSeconds);
      if (!to) continue;
      const type = updateType(from, to);
      bumps.push({ pkg, from, to, type, group: groupFor(pkg, type, groups), manifests: paths });
    }
  }
  return bumps.sort((a, b) => a.group.localeCompare(b.group) || a.pkg.localeCompare(b.pkg));
}

/**
 * Rewrite one manifest's text so every exact pin of `pkg` at `from` reads `to`,
 * in each dependency field and in `overrides`, without reformatting the file.
 * An override that holds the old version moves with it, since an override left
 * behind would force the old version back underneath the bump.
 */
export function rewriteManifest(text: string, pkg: string, from: string, to: string): string {
  const key = JSON.stringify(pkg).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const val = JSON.stringify(from).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replace(new RegExp(`(${key}\\s*:\\s*)${val}`, "g"), `$1${JSON.stringify(to)}`);
}

export function branchFor(group: string) {
  return `chore/deps-${group.replace(/^@/, "").replace(/[^\w.-]+/g, "-")}`;
}
