// served-tree.ts: the one PLAN for the served URL root.
import { copyFile, mkdir, readdir, rm, rmdir, stat, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { cloneTree } from "./clone-tree.ts";

export type ServedRoot = {
  dir: string;
  holds: "bytes" | "documents" | "prose" | "client" | "styles";
};

export const SERVED_ROOTS: readonly ServedRoot[] = [
  { dir: "public", holds: "bytes" },
  { dir: "src/pages", holds: "documents" },
  { dir: "src/content", holds: "prose" },
  { dir: "src/client", holds: "client" },
  { dir: "src/styles", holds: "styles" },
];

const rootsHolding = (...kinds: ServedRoot["holds"][]): string[] =>
  SERVED_ROOTS.filter((root) => kinds.includes(root.holds)).map((root) => root.dir);

export const STAGED_ROOTS: readonly string[] = SERVED_ROOTS.map((root) => root.dir);

export const AUTHORED_ROOTS: readonly string[] = rootsHolding("bytes", "documents", "prose");

export const BROWSER_IMPORT_ROOTS: readonly string[] = rootsHolding("client", "styles", "bytes");

export const DERIVED_PATHS: readonly string[] = [
  "public/images/meta",
  "public/images/exif.json",
  "public/images/fingerprints.json",
];

export type ServedTreePlan = {
  roots: string[];
  files: Map<string, string>;
  directories: Map<string, string[]>;
  skipped: string[];
};

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
    const ok = await stat(resolve(cwd, root)).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) throw new Error(`served-tree: root "${root}" does not exist. Has the served tree been rearranged again? Update SERVED_ROOTS in tools/lib/served-tree.ts.`);
    await walk(root, "");
  }

  for (const owners of claims.values()) owners.sort((a, b) => roots.indexOf(a) - roots.indexOf(b));
  if (claims.size) throw new ServedTreeCollision(claims);
  return { roots, files, directories, skipped };
}

type AdapterOptions = { cwd?: string };

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
