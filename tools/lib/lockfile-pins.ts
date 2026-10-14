// Hold bun.lock's RESOLUTION to the version its manifest declares.
//
// A bun lockfile states every direct dependency TWICE. `workspaces[<dir>]`
// carries a DECLARATION MIRROR, a copy of the manifest's own spec string, and
// `packages` carries the RESOLUTION, the version that actually lands in
// node_modules. `bun install --frozen-lockfile` compares the manifest against
// the mirror. Nothing compares the mirror against the resolution, so the two
// can disagree and the unchecked one is the one that decides what ships.
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

export const FLOOR_PINS = 12;

export type LockfileManifest = { manifest: string; wsKey: string; pkg: Record<string, unknown> };
export type LockfileInput = { lock: string; parsed: Record<string, unknown>; manifests: LockfileManifest[] };

const asMap = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

export function resolvedVersion(entry: unknown, name: string): string | null {
  const head = asText(asList(entry)[0]);
  if (head === null || !head.startsWith(`${name}@`)) return null;
  const version = head.slice(name.length + 1);
  return EXACT_PIN.test(version) ? version : null;
}

export function auditLockfilePins({ lockfiles, floor = FLOOR_PINS }: { lockfiles: LockfileInput[]; floor?: number }) {
  const problems: string[] = [];
  const checked: { lock: string; manifest: string; name: string; field: string; pin: string }[] = [];
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

        const fingerprint = JSON.stringify([lock, name]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        const entry = packages[name];
        if (entry === undefined) {
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
