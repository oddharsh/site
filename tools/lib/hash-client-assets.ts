// build.ts step 6's core, as an operation over a DIRECTORY: content-hash every
// registered client asset into <root>/public/a/<base>.<hash8>.<ext> and repoint
// every loader that names it. It takes the staged root, so the contract suite
// runs it against a temp dir of three fixture files instead of a full build.
//
// The interface is one call and one map back. Behind it:
//
//   - the ORDER, derived from the registry's loadedBy edges (leaves first).
//     Each asset's rewrites land in the staged tree right after it is hashed,
//     so a dependent hashed later reads bytes that already carry its
//     dependency's /a/ URL. The rewrite passes skip a/ on purpose (those copies
//     are final bytes), which is exactly why the order matters.
//   - the rewrite PATTERNS, exact call or attribute syntax per loader shape
//     (client-assets.ts loaderRewrites), over two target sets.
//   - the WITNESSES. Every declared loader must end up carrying the hashed URL,
//     and a rewrite that lands in a registered asset the registry does not
//     list is refused. Together they hold the edges to the truth in both
//     directions, which is what the ~20 hand-written `includes()` throws and
//     the "ORDER IS LOAD-BEARING" comment did by hand until 2026-10-02.
//
// Layout it assumes under root, each optional except public/: public/ (the
// served tree), src/worker/, cal/src/, serendipity/serendipity.ts.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  CLIENT_ASSETS, assetBase, assetExt, hashOrder, loaderNeedles, loaderRewrites, registryProblems, stagedPath,
  type ClientAsset,
} from "./client-assets.ts";

const hash8 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

export type HashedAssets = {
  // asset file ("nav.js", "lwe/ask.js") -> its /a/ URL
  urls: Record<string, string>;
  // how many staged files a rewrite changed, counted per asset then summed
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

  // Targets for the JS-STRING loaders (import(), from, script.src, fetch, a
  // keyed path): every staged surface that can carry one. HTML pages, the
  // top-level scripts themselves (nav.js imports hoist), the serendipity shell.
  // NOT the .src twins, and NOT a/.
  const stringTargets = ["serendipity/serendipity.ts"];
  for (const rel of publicFiles) {
    if (rel.includes(".src.")) continue;
    if (rel.endsWith(".html") || (rel.endsWith(".js") && !rel.startsWith("a/"))) stringTargets.push(`public/${rel}`);
  }
  // Targets for the ATTRIBUTE loaders: every served HTML file, the Worker's tag
  // emitters, cal's SSR templates and the serendipity shell. NOT the top-level
  // scripts or luna.css (nav.js carries its own /luna.css fallback string, which
  // must stay plain), and NOT the readable *.src.html twin, which stays
  // byte-identical to its source for perf-budget's twin check.
  const attrTargets = ["serendipity/serendipity.ts"];
  for (const rel of await under("cal/src", false)) if (rel.endsWith(".ts")) attrTargets.push(`cal/src/${rel}`);
  for (const rel of publicFiles) if (rel.endsWith(".html") && !rel.endsWith(".src.html")) attrTargets.push(`public/${rel}`);
  for (const rel of await under("src/worker", true)) if (rel.endsWith(".js") || rel.endsWith(".ts")) attrTargets.push(`src/worker/${rel}`);

  // Every target is read ONCE and held as text. The loop below used to re-read
  // all of them for every loader of every asset and run each pattern over each,
  // nearly always to change nothing: about 670 ms of CPU, step 6 entire, on
  // 2026-10-08. A rewrite now edits the held copy and writes that one file
  // straight away, so disk and memory never disagree, and an asset that is
  // itself a target (nav.js) is still hashed from its rewritten bytes.
  const text = new Map<string, string | null>();
  await Promise.all([...new Set([...stringTargets, ...attrTargets])].map(async (rel) => {
    text.set(rel, await readFile(`${root}/${rel}`, "utf8").catch(() => null));
  }));

  const urls: Record<string, string> = {};
  let filesTouched = 0;
  for (const a of order) {
    let bytes = await readFile(`${root}/public/${a.file}`);   // exact served bytes (banner incl.)
    // A JSON asset takes compact-data's canonical form HERE, before its hash,
    // and the plain copy with it. compact-data runs long after step 6 and skips
    // a/, so it can never rewrite bytes a hash already names.
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
        // no pattern can match a file without one of its literals
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
        // An edge the registry does not know. The order was derived without it,
        // so this dependent may already have been hashed with the plain URL.
        if (registered.has(rel) && !a.loadedBy.includes(rel)) {
          throw new Error(`client assets: ${rel} loads /${a.file}, but ${a.file}'s loadedBy does not list it, so the hash order was derived without that edge. Add "${rel}" to its loadedBy.`);
        }
      }
    }
    log(`hashed asset: /${a.file} -> ${to} (${bytes.length} bytes)`);
  }

  // Witnesses. A loader that is itself a registered asset is read from its /a/
  // copy: those are the bytes a browser gets, and the copy an out-of-order hash
  // would have left pointing at the plain URL.
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
