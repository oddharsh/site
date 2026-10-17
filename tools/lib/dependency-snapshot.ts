// Turn a bun.lock into the dependency graph GitHub's Dependabot alerts read.
//
// THE GAP THIS CLOSES. GitHub's dependency graph does not parse bun.lock. Read
// on 2026-10-07 through the `dependencyGraphManifests` GraphQL field: it lists
// the seven package.json files and no lockfile, and the repo's SBOM held 99
// packages, none of them transitive npm. So alerts saw the 18 direct pins and
// none of the other ~150 packages in the tree. The sharp 0.35.4 high
// (GHSA-wq5f-xc86-pv6w), which arrives through miniflare, raised no alert;
// only deps-pin.yml's `bun audit` saw it, as a warning in a run summary.
//
// The dependency submission API is GitHub's door for exactly this: a build
// that knows its resolved tree states it, and alerts match against it like any
// parsed lockfile. .github/workflows/dependency-snapshot.yml posts what this
// builds on every push to main that moves a lockfile.
//
// WHAT IS LEFT OUT, on purpose. A package whose lockfile head is not
// `<name>@<semver>` (wrangler and miniflare from pkg.pr.new, timbrado from
// git, the workspace links) has no npm version an advisory range can match,
// and a purl without a version would match every advisory ever filed against
// the name. Their package.json declarations already reach the graph, and
// their dependencies are still walked, which is how sharp under miniflare
// gets in.
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";
import { EXACT_PIN } from "./exact-pin.ts";

const asMap = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

// `optionalDependencies` covers sharp's 20-odd platform builds, which are real
// packages a machine installs. `peerDependencies` is left out: a peer is
// whatever the consumer resolved, which is already its own entry.
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

/** A `packages` key is a path of package names: `dom-serializer/entities` is
 *  the copy of entities nested under dom-serializer. Scoped names take two
 *  slash-separated parts, so a plain split would cut `@img/sharp` in half. */
export function keySegments(key: string) {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return out;
}

/** Node's lookup, as bun lays it out: the nearest nested copy wins, then each
 *  ancestor's, then the hoisted one. */
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

/** PURE. One lockfile's `resolved` block for a snapshot manifest, plus the
 *  heads it declined, so the caller can say what was left out and why. */
export function snapshotResolved(parsed: Record<string, unknown>) {
  const packages = asMap(parsed.packages);
  const workspaces = asMap(parsed.workspaces);

  // Walk from every workspace's declarations. A package reached from any
  // `dependencies` root is runtime; one reached only through devDependencies
  // is development. A runtime reach upgrades an earlier development one.
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
    // An unreached entry is one no workspace leads to (a stale or optional
    // leftover). It still sits in the lockfile, so it is reported, as
    // development, rather than hidden.
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
