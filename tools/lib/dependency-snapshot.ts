// Turn a bun.lock into the dependency graph GitHub's Dependabot alerts read.
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";
import { EXACT_PIN } from "./exact-pin.ts";

const asMap = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

const EDGE_FIELDS = ["dependencies", "optionalDependencies"] as const;
const ROOT_FIELDS = { dependencies: "runtime", optionalDependencies: "runtime", devDependencies: "development" } as const;

type Scope = "runtime" | "development";
export type Resolved = {
  package_url: string;
  relationship: "direct" | "indirect";
  scope: Scope;
  dependencies: string[];
};

/** `pkg:npm/%40scope/name@1.2.3`. The `@` of a scope is percent-encoded
 *  because the purl spec reserves `@` for the version separator. */
export function npmPurl(name: string, version: string) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

export function keySegments(key: string) {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return out;
}

export function resolveKey(packages: Record<string, unknown>, fromKey: string, name: string) {
  const segs = fromKey ? keySegments(fromKey) : [];
  for (let i = segs.length; i >= 0; i--) {
    const key = [...segs.slice(0, i), name].join("/");
    if (key in packages) return key;
  }
  return null;
}

/** The `<name>@<version>` head of an entry, or null for a URL, git or
 *  workspace head. The metadata is the first object after the head: a
 *  registry entry carries a registry string between them, a URL entry does not. */
function readEntry(entry: unknown) {
  const list = asList(entry);
  const head = asText(list[0]) ?? "";
  const at = head.lastIndexOf("@");
  const name = at > 0 ? head.slice(0, at) : head;
  const version = at > 0 ? head.slice(at + 1) : "";
  const meta = asMap(list.slice(1).find((x) => asRecord(x) !== null));
  return { name, version: EXACT_PIN.test(version) ? version : null, meta };
}

export function snapshotResolved(parsed: Record<string, unknown>) {
  const packages = asMap(parsed.packages);
  const workspaces = asMap(parsed.workspaces);

  const scope = new Map<string, Scope>();
  const direct = new Set<string>();
  const queue: [string, Scope][] = [];
  const reach = (key: string | null, s: Scope) => {
    if (key === null || scope.get(key) === "runtime" || scope.get(key) === s) return;
    scope.set(key, s);
    queue.push([key, s]);
  };

  for (const ws of Object.values(workspaces)) {
    const block = asMap(ws);
    // A workspace whose pin disagrees with the hoisted copy gets its own,
    // keyed under the workspace's package name, the way a package nests one.
    const from = asText(block.name) ?? "";
    for (const [field, s] of Object.entries(ROOT_FIELDS)) {
      for (const name of Object.keys(asMap(block[field]))) {
        const key = resolveKey(packages, from, name);
        if (key !== null) direct.add(key);
        reach(key, s);
      }
    }
  }
  for (const name of Object.keys(asMap(parsed.overrides))) {
    const key = resolveKey(packages, "", name);
    if (key !== null) direct.add(key);
  }
  while (queue.length) {
    const [key, s] = queue.shift()!;
    const { meta } = readEntry(packages[key]);
    for (const field of EDGE_FIELDS) for (const dep of Object.keys(asMap(meta[field]))) reach(resolveKey(packages, key, dep), s);
  }

  const resolved: Record<string, Resolved> = {};
  const declined: string[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    const { name, version, meta } = readEntry(entry);
    if (version === null) {
      declined.push(asText(asList(entry)[0]) ?? key);
      continue;
    }
    const purl = npmPurl(name, version);
    const deps = new Set<string>();
    for (const field of EDGE_FIELDS) {
      for (const dep of Object.keys(asMap(meta[field]))) {
        const depKey = resolveKey(packages, key, dep);
        const child = depKey === null ? null : readEntry(packages[depKey]);
        if (child?.version) deps.add(npmPurl(child.name, child.version));
      }
    }
    resolved[purl] = {
      package_url: purl,
      relationship: direct.has(key) ? "direct" : "indirect",
      scope: scope.get(key) ?? "development",
      dependencies: [...deps].sort(),
    };
  }
  return { resolved, declined };
}

/** The request body for POST /repos/{owner}/{repo}/dependency-graph/snapshots.
 *  One correlator for both lockfiles, so each submission replaces the last. */
export function buildSnapshot({ lockfiles, sha, ref, runId, scanned, repoUrl }: {
  lockfiles: { path: string; parsed: Record<string, unknown> }[];
  sha: string;
  ref: string;
  runId: string;
  scanned: string;
  repoUrl: string;
}) {
  const manifests: Record<string, { name: string; file: { source_location: string }; resolved: Record<string, Resolved> }> = {};
  const declined: Record<string, string[]> = {};
  for (const { path, parsed } of lockfiles) {
    const out = snapshotResolved(parsed);
    manifests[path] = { name: path, file: { source_location: path }, resolved: out.resolved };
    declined[path] = out.declined;
  }
  return {
    snapshot: {
      version: 0,
      sha,
      ref,
      job: { correlator: "dependency-snapshot bun.lock", id: runId },
      detector: { name: "tools/dependency-snapshot.ts", version: "1", url: `${repoUrl}/blob/main/tools/lib/dependency-snapshot.ts` },
      scanned,
      manifests,
    },
    declined,
  };
}
