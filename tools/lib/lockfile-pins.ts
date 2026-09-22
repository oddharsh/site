// Hold bun.lock's RESOLUTION to the version its manifest declares.
//
// A bun lockfile states every direct dependency TWICE. `workspaces[<dir>]`
// carries a DECLARATION MIRROR, a copy of the manifest's own spec string, and
// `packages` carries the RESOLUTION, the version that actually lands in
// node_modules. `bun install --frozen-lockfile` compares the manifest against
// the mirror. Nothing compares the mirror against the resolution, so the two
// can disagree and the unchecked one is the one that decides what ships.
//
// MEASURED 2026-09-22 on bun 1.4.2 (744846f84), one dependency, one lockfile
// hand-edited so the mirror agrees with the manifest and `packages` does not:
//
//   | lockfile state                         | frozen install | installed          |
//   |----------------------------------------|---------------:|--------------------|
//   | mirror disagrees with the manifest     |         exit 1 | nothing            |
//   | mirror agrees, resolution is different |     **exit 0** | **the resolution** |
//
// It is not a --frozen-lockfile bug. A plain `bun install` on that state is
// also exit 0, also installs the denied version, and REWRITES NOTHING, and so
// is `bun ci`. `bun update <name>` is the only command of the four that repairs
// it, which is why the messages below name that and not a reinstall: the
// obvious first attempt, `rm -rf node_modules && bun install`, leaves the
// resolution exactly where it was. It is not exact-pin-specific either: a
// manifest asking for `^2.0.0` installs a resolved 1.0.0 the same silent way.
//
// A RANGE is out of scope here, deliberately. Judging `^1.2.0` against a
// resolution needs a semver implementation this repository does not carry, and
// a checker that guessed would report a satisfied range as drift. Exact pins
// are the shape a lockfile can be flatly wrong about, and every pin this
// repository actually declares is exact or a URL.
//
// FILED as oven-sh/bun#43795, and DELIBERATELY NOT an upstream-watch row. The
// three neighbouring reports (#13823 and #24223 closed, #22689 open) are all
// the MIRROR half, which bun does now refuse; this is the residue of that fix,
// one block further down. It is not in tools/lib/upstream-watches.ts for two
// measured reasons. Every watch there is an in-process `bun -e` probe, and this
// one is an INSTALLER behaviour: it needs a spawned `bun install` over a scratch
// package tree, which makes it the only row that could fail for a reason other
// than the fix. And the network-free form does not survive rule 3 (a crash must
// read `null`, never either answer): with the registry pointed at a dead port
// the drift lock fails with `ConnectionRefused downloading tarball
// boolbase@1.0.0` and a healthy one with the same string naming 2.0.0, so the
// only offline discriminator is a version inside an error message, and a
// reworded message would read as landed. Nor is the repository WAITING on it,
// which is what a watch row schedules: this check is local, complete and 21 ms
// (median of 7 on this tree, most of it the `git ls-files` spawn),
// it also covers the mirror half without anyone running an install, and it stays
// worth keeping the day bun fixes its side.
//
// THE PROVENANCE IS VERSION CONTROL rather than bun. The state that motivated
// this arrived on PR #880: a human merge of `main` into a dependabot branch
// resolved a package.json conflict by taking main's side whole, which reverted
// the bump and left the lockfile's resolution ahead of it. Every dependabot PR
// that needs a `main` merge is a candidate, so this is a cadence rather than an
// accident, the same argument docs/DEPENDENCIES.md's prose check rests on.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";
import { EXACT_PIN } from "./dependency-docs.ts";
import { parseJsonc } from "./jsonc.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The four npm dependency fields, plus `overrides`, which is handled apart
// because bun records it at the lockfile's TOP LEVEL rather than per workspace.
export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

// A scanner that has quietly stopped matching must not report a clean pass over
// nothing. 16 pins are checked today (11 root devDependencies plus the `sharp`
// override, 3 lens-reader dependencies plus the `htmlparser2` override); the
// floor sits far enough below that a deliberate removal does not trip it and a
// broken walk does.
export const FLOOR_PINS = 12;

export type LockfileManifest = { manifest: string; wsKey: string; pkg: Record<string, unknown> };
export type LockfileInput = { lock: string; parsed: Record<string, unknown>; manifests: LockfileManifest[] };

// A lockfile and a manifest are both somebody else's JSON, so every field is
// parsed at this boundary through src/worker/lib/parse.ts rather than narrowed
// with `typeof` at each use. An absent block reads as an empty one so callers
// can iterate without a guard; absence is then reported by the rules below,
// which is where it means something.
const asMap = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

/** The version a `packages` entry resolves to, or null when the entry is not
 *  the `<name>@<version>` shape (a tarball URL, a git ref, a workspace link).
 *  Those are the specs EXACT_PIN already declines, so a null here is only ever
 *  reached by a lockfile whose own head string disagrees with its key. */
export function resolvedVersion(entry: unknown, name: string): string | null {
  const head = asText(asList(entry)[0]);
  if (head === null || !head.startsWith(`${name}@`)) return null;
  const version = head.slice(name.length + 1);
  return EXACT_PIN.test(version) ? version : null;
}

/** PURE, so the negative cases run against two-object fixtures rather than a
 *  reconstructed tree. The I/O shell is readLockfilePins below. */
export function auditLockfilePins({ lockfiles, floor = FLOOR_PINS }: { lockfiles: LockfileInput[]; floor?: number }) {
  const problems: string[] = [];
  const checked: { lock: string; manifest: string; name: string; field: string; pin: string }[] = [];
  // One resolution is one fact, and `htmlparser2` is both a dependency and an
  // override in lens-reader. Checking it twice would report one drift twice.
  const seen = new Set<string>();

  for (const { lock, parsed, manifests } of lockfiles) {
    const workspaces = asMap(parsed.workspaces);
    const packages = asMap(parsed.packages);
    const lockOverrides = asMap(parsed.overrides);

    for (const { manifest, wsKey, pkg } of manifests) {
      const ws = asMap(workspaces[wsKey]);
      const declarations: { field: string; name: string; pin: string; mirror: unknown }[] = [];

      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, spec] of Object.entries(asMap(pkg[field]))) {
          const pin = asText(spec);
          if (pin === null || !EXACT_PIN.test(pin)) continue;
          declarations.push({ field, name, pin, mirror: asMap(ws[field])[name] });
        }
      }
      // `overrides` is the root manifest's alone, and bun mirrors it outside the
      // workspace blocks. A non-root workspace declaring one is not something
      // bun honours, so it is not something this can hold it to.
      if (wsKey === "") {
        for (const [name, spec] of Object.entries(asMap(pkg.overrides))) {
          const pin = asText(spec);
          if (pin === null || !EXACT_PIN.test(pin)) continue;
          declarations.push({ field: "overrides", name, pin, mirror: lockOverrides[name] });
        }
      }

      for (const { field, name, pin, mirror } of declarations) {
        checked.push({ lock, manifest, name, field, pin });
        const where = `${lock} ${field === "overrides" ? "overrides" : `workspaces[${JSON.stringify(wsKey)}].${field}`}`;

        if (mirror === undefined) {
          problems.push(
            `${manifest} declares ${field}.${name} at ${pin} and ${where} does not record it. ` +
            `Run \`bun update ${name}\` and commit ${lock}.`,
          );
        } else if (mirror !== pin) {
          problems.push(
            `${manifest} declares ${field}.${name} at ${pin} but ${where} mirrors ${JSON.stringify(mirror)}. ` +
            `Run \`bun update ${name}\` and commit ${lock}. ` +
            `(A frozen install DOES catch this one, so it is a lockfile nobody has reinstalled from.)`,
          );
        }

        // JSON rather than a separator character: a NUL would work and would
        // also make this file read as BINARY to grep and `git grep`, which in a
        // repository whose checks are scanners over `git ls-files` is a file the
        // next scanner skips without saying so.
        const fingerprint = JSON.stringify([lock, name]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        const entry = packages[name];
        if (entry === undefined) {
          // Fail CLOSED. A pin whose resolution cannot be found is exactly as
          // unverifiable as one that is wrong, and reading absence as consent
          // is how this check would come to pass over a lockfile it no longer
          // understands.
          problems.push(
            `${manifest} declares ${field}.${name} at ${pin} and ${lock} resolves no package by that name. ` +
            `If bun has changed how it keys resolutions, fix tools/lib/lockfile-pins.ts rather than the pin.`,
          );
          continue;
        }
        const version = resolvedVersion(entry, name);
        if (version === null) {
          problems.push(
            `${lock} resolves ${name} to something that is not a \`${name}@<version>\` entry, ` +
            `while ${manifest} pins it at ${pin}. Read the lockfile entry before trusting any install from it.`,
          );
          continue;
        }
        if (version !== pin) {
          problems.push(
            `${manifest} pins ${name} at ${pin} and ${lock} RESOLVES ${version}. ` +
            `A frozen install exits 0 on this and installs ${version}; so does a plain \`bun install\`. ` +
            `Run \`bun update ${name}\` and commit ${lock}, because a reinstall does not repair it.`,
          );
        }
      }
    }
  }

  if (checked.length < floor) {
    problems.push(
      `only ${checked.length} exact pin(s) were checked against a lockfile, below the floor of ${floor}. ` +
      `The walk has probably stopped finding manifests rather than the tree having shrunk; ` +
      `check readLockfilePins in tools/lib/lockfile-pins.ts.`,
    );
  }

  return { checked, problems };
}

/** Every COMMITTED bun lockfile, and for each one the manifests it governs.
 *
 *  Both halves are derived rather than listed, and that is the point. The
 *  lockfile set comes from `git ls-files`, so a new sub-project is covered the
 *  day it is committed; the manifest set comes from each lockfile's own
 *  `workspaces` keys, so a new workspace is covered by the lockfile that
 *  already had to record it. A hand-kept list (SUB_MANIFEST_POLICY is one) goes
 *  stale without failing anything: it names four manifests while the root
 *  lockfile governs five workspaces, so `lwe-ask` and `serendipity` sit outside
 *  it today and inside this.
 */
export function readLockfilePins(root: string = REPO_ROOT): LockfileInput[] {
  const listed = execFileSync("git", ["ls-files", "-z", "bun.lock", "*/bun.lock"], { cwd: root, encoding: "utf8" });
  const locks = listed.split("\0").filter(Boolean).sort();

  return locks.map((lock) => {
    const parsed = parseJsonc(readFileSync(path.join(root, lock), "utf8"));
    const base = path.dirname(lock);
    const manifests: LockfileManifest[] = [];
    for (const wsKey of Object.keys(asMap(parsed.workspaces))) {
      const manifest = path.join(base, wsKey, "package.json").replaceAll(path.sep, "/");
      manifests.push({ manifest, wsKey, pkg: JSON.parse(readFileSync(path.join(root, manifest), "utf8")) });
    }
    return { lock, parsed, manifests };
  });
}
