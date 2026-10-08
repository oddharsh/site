// served-tree.ts: the one PLAN for the served URL root.
//
// The served tree is authored across five directories and merged into one URL
// root. This module owns that merge: which roots, in what order, which paths
// are left out, and the rule that every served path has exactly one owner. It
// yields a plan (served path -> source path) and two adapters consume it:
//
//   - the build COPIES the plan into .build/public        (copyServedTree)
//   - local dev SYMLINKS the plan into .dev-assets        (linkServedTree)
//
// Before this module the same facts were stated four times (build.ts's
// collision walk, its cp() calls, its skip set, and dev-stage.ts's own roots,
// skip set and merge), and a contract test held two of the copies together by
// regexing cp() calls out of build.ts. The copies had already drifted: the
// build's collision walk skipped one derived path where its copy skipped
// three, and dev's skip set never applied at all (see linkServedTree).
import { copyFile, mkdir, readdir, rm, rmdir, stat, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { cloneTree } from "./clone-tree.ts";

// What a root HOLDS decides which questions it answers. The test for where a
// new file belongs is CLAUDE.md's: a build step transforms it (src/) or it
// ships byte for byte (public/).
export type ServedRoot = {
  dir: string;
  holds: "bytes" | "documents" | "prose" | "client" | "styles";
};

// The declaration. ORDER is the canonical staging order; it decides nothing
// about the output, because a path two roots both provide is refused rather
// than resolved by order.
export const SERVED_ROOTS: readonly ServedRoot[] = [
  { dir: "public", holds: "bytes" },
  { dir: "src/pages", holds: "documents" },
  { dir: "src/content", holds: "prose" },
  { dir: "src/client", holds: "client" },
  { dir: "src/styles", holds: "styles" },
];

const rootsHolding = (...kinds: ServedRoot["holds"][]): string[] =>
  SERVED_ROOTS.filter((root) => kinds.includes(root.holds)).map((root) => root.dir);

// Three projections of the one declaration. They answer different questions,
// so they stay three names rather than one list with callers picking indexes.

// Every root that composes the URL root. The build and dev both stage these.
export const STAGED_ROOTS: readonly string[] = SERVED_ROOTS.map((root) => root.dir);

// The roots that used to be www/: assets, documents and prose. build.ts's
// tripwires (the taste scan, the view-transition scan) walk these recursively.
// The client and stylesheet roots are NOT in it: they left www/ before the
// 2026-08-18 split, and each tripwire that wants them names them itself.
export const AUTHORED_ROOTS: readonly string[] = rootsHolding("bytes", "documents", "prose");

// The roots an absolute browser import (`import "/hoist.js"`) can resolve in.
// config/tsconfig.browser.json maps `/*` across exactly these. JSON cannot
// import, so a contract test holds that file to this projection.
export const BROWSER_IMPORT_ROOTS: readonly string[] = rootsHolding("client", "styles", "bytes");

// Source paths the build DERIVES rather than stages (build.ts steps 1a, 1a2).
// Nothing writes them into the source tree any more, so a file at one of them
// can only be a leftover from an older checkout, and staging it would make the
// served tree depend on whatever a given machine happens to still hold.
export const DERIVED_PATHS: readonly string[] = [
  "public/images/meta",
  "public/images/exif.json",
  "public/images/fingerprints.json",
];

export type ServedTreePlan = {
  // The roots that were merged, in order.
  roots: string[];
  // served path -> source path (root-relative to the working directory).
  files: Map<string, string>;
  // served directory -> every root that provides it. "" is the URL root.
  directories: Map<string, string[]>;
  // Derived source paths that EXIST on this machine and were left out.
  skipped: string[];
};

// One owner per served path. Thrown once, by the planner, naming every
// contested path, so neither adapter needs a collision rule of its own.
export class ServedTreeCollision extends Error {
  paths: string[];
  constructor(claims: Map<string, string[]>) {
    const lines = [...claims].map(([path, roots]) => `served path ${path} is authored by both ${roots.join(" and ")}`);
    super(`${lines.join("; ")}. A served path belongs to exactly one root, and staging has no overwrite order.`);
    this.name = "ServedTreeCollision";
    this.paths = [...claims.keys()];
  }
}

type PlanOptions = {
  // Where the roots live. Defaults to the working directory.
  cwd?: string;
  roots?: readonly string[];
  derived?: readonly string[];
};

export async function planServedTree(options: PlanOptions = {}): Promise<ServedTreePlan> {
  const cwd = options.cwd ?? ".";
  const roots = [...(options.roots ?? STAGED_ROOTS)];
  const derived = new Set(options.derived ?? DERIVED_PATHS);

  const files = new Map<string, string>();
  const directories = new Map<string, string[]>();
  const skipped: string[] = [];
  const claims = new Map<string, string[]>();
  const contest = (path: string, prior: string, root: string) => {
    const seen = claims.get(path) ?? [];
    for (const owner of [prior, root]) if (!seen.includes(owner)) seen.push(owner);
    claims.set(path, seen);
  };

  const walk = async (root: string, rel: string): Promise<void> => {
    const provided = directories.get(rel);
    if (provided) provided.push(root);
    else directories.set(rel, [root]);
    for (const entry of await readdir(resolve(cwd, root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const source = `${root}/${child}`;
      if (derived.has(source)) {
        skipped.push(source);
        continue;
      }
      const priorFile = files.get(child);
      if (entry.isDirectory()) {
        // A file in one root and a directory in another is the same mistake as
        // two files: one URL, two owners.
        if (priorFile) contest(child, priorFile.slice(0, -child.length - 1), root);
        await walk(root, child);
        continue;
      }
      const priorDirectory = directories.get(child);
      if (priorFile) contest(child, priorFile.slice(0, -child.length - 1), root);
      else if (priorDirectory) for (const owner of priorDirectory) contest(child, owner, root);
      else files.set(child, source);
    }
  };

  for (const root of roots) {
    // A root renamed out from under this list is the failure dev-stage was
    // first written to repair (dev named a deleted `www` for a day after the
    // 2026-08-18 split). Fail by NAME rather than plan a partial tree.
    const ok = await stat(resolve(cwd, root)).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) throw new Error(`served-tree: root "${root}" does not exist. Has the served tree been rearranged again? Update SERVED_ROOTS in tools/lib/served-tree.ts.`);
    await walk(root, "");
  }

  for (const owners of claims.values()) owners.sort((a, b) => roots.indexOf(a) - roots.indexOf(b));
  if (claims.size) throw new ServedTreeCollision(claims);
  return { roots, files, directories, skipped };
}

type AdapterOptions = { cwd?: string };

// The first root (public/, about 900 of the 1,000 staged files) cloned whole
// with one clonefile(2) where the platform allows (tools/lib/clone-tree.ts),
// then held to the plan: the derived paths the plan skips are deleted from the
// clone, and the clone must hold exactly the plan's files from that root and no
// link. Anything else deletes the clone and returns null, and the caller copies
// every file as before, so this path can only ever produce the planned tree.
async function cloneFirstRoot(plan: ServedTreePlan, out: string, cwd: string): Promise<string | null> {
  const root = plan.roots[0];
  if (!root) return null;
  await rmdir(out).catch(() => {}); // an empty destination may exist; a full one fails the clone
  if (!(await cloneTree(resolve(cwd, root), out))) return null;
  const prefix = `${root}/`;
  await Promise.all(plan.skipped.filter((p) => p.startsWith(prefix))
    .map((p) => rm(resolve(out, p.slice(prefix.length)), { recursive: true, force: true })));
  const want = new Set([...plan.files].filter(([rel, source]) => source === `${prefix}${rel}`).map(([rel]) => rel));
  let same = true, seen = 0;
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const rel = relative(out, resolve(entry.parentPath, entry.name)).split("\\").join("/");
    if (entry.isSymbolicLink() || !want.has(rel)) { same = false; break; }
    seen++;
  }
  if (same && seen === want.size) return root;
  await rm(out, { recursive: true, force: true });
  return null;
}

// THE BUILD ADAPTER: copy every planned file to `dest`. Directories are made
// first, from the plan's union, so no two copies race through mkdir for a
// directory several roots share, and an empty authored directory still ships.
const COPY_WIDTH = 64;
export async function copyServedTree(plan: ServedTreePlan, dest: string, options: AdapterOptions = {}): Promise<{ files: number; dirs: number; cloned: string | null }> {
  const cwd = options.cwd ?? ".";
  const out = resolve(cwd, dest);
  const cloned = await cloneFirstRoot(plan, out, cwd);
  await Promise.all([...plan.directories.keys()].map((dir) => mkdir(resolve(out, dir), { recursive: true })));
  const pending = cloned ? [...plan.files].filter(([rel, source]) => source !== `${cloned}/${rel}`) : [...plan.files];
  const worker = async () => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      await copyFile(resolve(cwd, next[1]), resolve(out, next[0]));
    }
  };
  await Promise.all(Array.from({ length: COPY_WIDTH }, worker));
  return { files: plan.files.size, dirs: plan.directories.size, cloned };
}

// THE DEV ADAPTER: a symlink farm at `dest`, which must not exist yet.
//
//   - a directory ONE root provides becomes a single directory symlink, so a
//     file created inside it later is served with no re-stage
//   - a directory SEVERAL roots provide is made for real and recursed into,
//     because a symlink can only point at one of them
//
// One more case makes a real directory: a single-owner directory that holds a
// skipped (derived) path. A whole-directory symlink would expose the leftover,
// which is what dev-stage.ts did until this module: its skip set only ran
// inside merged directories, and public/images is not one, so a leftover
// public/images/meta was served in dev while the comment above it said it
// could not be. On a checkout with no leftovers the farm is link-for-link what
// it was.
//
// Links are relative, so `ls -l .dev-assets` names the directory a file
// authors in.
export async function linkServedTree(plan: ServedTreePlan, dest: string, options: AdapterOptions = {}): Promise<{ links: number; dirs: number }> {
  const cwd = options.cwd ?? ".";
  const out = resolve(cwd, dest);

  const children = new Map<string, Set<string>>();
  const adopt = (path: string) => {
    if (!path) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const names = children.get(parent) ?? new Set<string>();
    names.add(path);
    children.set(parent, names);
  };
  for (const dir of plan.directories.keys()) adopt(dir);
  for (const file of plan.files.keys()) adopt(file);

  let links = 0;
  let dirs = 0;
  const link = async (served: string, source: string) => {
    const at = served ? resolve(out, served) : out;
    await symlink(relative(dirname(at), resolve(cwd, source)), at);
    links++;
  };
  const hidesSkipped = (source: string) => plan.skipped.some((path) => path.startsWith(`${source}/`));

  const place = async (dir: string): Promise<void> => {
    const providers = plan.directories.get(dir) ?? [];
    const source = dir ? `${providers[0]}/${dir}` : providers[0];
    if (providers.length === 1 && !hidesSkipped(source)) {
      await link(dir, source);
      return;
    }
    await mkdir(dir ? resolve(out, dir) : out, { recursive: true });
    dirs++;
    for (const child of children.get(dir) ?? []) {
      const file = plan.files.get(child);
      if (file) await link(child, file);
      else await place(child);
    }
  };
  await place("");
  return { links, dirs };
}
