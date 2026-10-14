// build.ts step 6's core, as an operation over a DIRECTORY: content-hash every
// registered client asset into <root>/public/a/<base>.<hash8>.<ext> and repoint
// every loader that names it. It takes the staged root, so the contract suite
// runs it against a temp dir of three fixture files instead of a full build.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  CLIENT_ASSETS, assetBase, assetExt, hashOrder, loaderNeedles, loaderRewrites, registryProblems, stagedPath,
  type ClientAsset,
} from "./client-assets.ts";

const hash8 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

export type HashedAssets = {
  urls: Record<string, string>;
  filesTouched: number;
};

export async function hashClientAssets(
  root: string,
  opts: { assets?: readonly ClientAsset[]; log?: (line: string) => void } = {},
): Promise<HashedAssets> {
  const assets = opts.assets ?? CLIENT_ASSETS;
  const log = opts.log ?? (() => {});
  const problems = registryProblems(assets);
  if (problems.length) throw new Error(`client assets: ${problems.join("; ")}`);
  const order = hashOrder(assets);
  const registered = new Map(assets.map((a) => [stagedPath(a), a]));

  await mkdir(`${root}/public/a`, { recursive: true });
  const publicFiles = (await readdir(`${root}/public`, { recursive: true })) as string[];
  const under = async (dir: string, recursive: boolean): Promise<string[]> =>
    ((await readdir(`${root}/${dir}`, { recursive }).catch(() => [])) as string[]);

  const stringTargets = ["serendipity/serendipity.ts"];
  for (const rel of publicFiles) {
    if (rel.includes(".src.")) continue;
    if (rel.endsWith(".html") || (rel.endsWith(".js") && !rel.startsWith("a/"))) stringTargets.push(`public/${rel}`);
  }
  const attrTargets = ["serendipity/serendipity.ts"];
  for (const rel of await under("cal/src", false)) if (rel.endsWith(".ts")) attrTargets.push(`cal/src/${rel}`);
  for (const rel of publicFiles) if (rel.endsWith(".html") && !rel.endsWith(".src.html")) attrTargets.push(`public/${rel}`);
  for (const rel of await under("src/worker", true)) if (rel.endsWith(".js") || rel.endsWith(".ts")) attrTargets.push(`src/worker/${rel}`);

  const text = new Map<string, string | null>();
  await Promise.all([...new Set([...stringTargets, ...attrTargets])].map(async (rel) => {
    text.set(rel, await readFile(`${root}/${rel}`, "utf8").catch(() => null));
  }));

  const urls: Record<string, string> = {};
  let filesTouched = 0;
  for (const a of order) {
    let bytes = await readFile(`${root}/public/${a.file}`);
    if (assetExt(a) === "json") {
      const compact = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))));
      if (compact.length < bytes.length) {
        bytes = compact;
        await writeFile(`${root}/public/${a.file}`, bytes);
      }
    }
    const to = `/a/${assetBase(a)}.${hash8(bytes)}.${assetExt(a)}`;
    await writeFile(`${root}/public${to}`, bytes);
    urls[a.file] = to;

    for (const loader of a.load) {
      const reps = loaderRewrites(a, loader, to);
      const needles = loaderNeedles(a, loader);
      const targets = loader.via === "attr" ? attrTargets : stringTargets;
      const touched = await Promise.all(targets.map(async (rel) => {
        const before = text.get(rel);
        if (before == null || !needles.some((n) => before.includes(n))) return null;
        let after = before;
        for (const [re, sub] of reps) after = after.replace(re, sub);
        if (after === before) return null;
        text.set(rel, after);
        await writeFile(`${root}/${rel}`, after);
        return rel;
      }));
      for (const rel of touched) {
        if (rel === null) continue;
        filesTouched++;
        if (registered.has(rel) && !a.loadedBy.includes(rel)) {
          throw new Error(`client assets: ${rel} loads /${a.file}, but ${a.file}'s loadedBy does not list it, so the hash order was derived without that edge. Add "${rel}" to its loadedBy.`);
        }
      }
    }
    log(`hashed asset: /${a.file} -> ${to} (${bytes.length} bytes)`);
  }

  for (const a of order) {
    for (const rel of a.loadedBy) {
      const dependent = registered.get(rel);
      const witness = dependent ? `public${urls[dependent.file]}` : rel;
      let body: string;
      try { body = await readFile(`${root}/${witness}`, "utf8"); }
      catch { throw new Error(`client assets: ${rel}, declared in ${a.file}'s loadedBy, is not in the staged tree`); }
      if (!body.includes(urls[a.file])) {
        throw new Error(`client assets: ${witness} was not repointed to ${urls[a.file]}; did the way ${rel} loads /${a.file} change?`);
      }
    }
  }
  return { urls, filesTouched };
}
