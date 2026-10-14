// build.ts: the site's one build step, and it runs only at deploy.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

const BUILD_NONCE = process.hrtime.bigint().toString(36);
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompressSync, constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { siteConfig } from "./lib/site-config.ts";
import { AUTHORED_ROOTS, copyServedTree, planServedTree, ServedTreeCollision, type ServedTreePlan } from "./lib/served-tree.ts";
import { transform as transformCss } from "lightningcss";
import { minifySync, type MinifyOptions } from "oxc-minify";
import { OXC_MINIFY_OPTIONS } from "./lib/oxc-minify-options.ts";
import { readManifest, workerModule, navFenceBody, readFenceBody, runProfilesBody } from "./gen-manifest.ts";
import { parseCss } from "./lib/css-parse.ts";
import { spliceMinLiterals } from "./lib/css-literal.ts";
import { isJsonScriptType, minifyJsonScript } from "./lib/json-script.ts";
import { HTML_MARKERS } from "./lib/html-markers.ts";
import { buildExifIndex, buildImageFingerprints, serializeExifIndex, serializeFingerprints } from "./lib/photo-indexes.ts";
import { dczEncode, dictionaryTag, frameDcz } from "./lib/dcz.ts";
import { DCZ_ZSTD_LEVEL, familyDictionaryName, pageDeltaName, pageSlug, parsePageSnapshot, parseShellAsset, shellDeltaName } from "../src/worker/lib/dictionary-names.ts";
import { chooseFamilyDictionary, FAMILY_DICT_DIR, FAMILY_FRESH, FAMILY_REPORT, hash8, readCommittedFamily } from "./lib/page-family.ts";
import { unpackHistogram } from "./photos/build-histogram-index.ts";
import { clientScriptProblems, minifiedScripts, minifiedStyles, shellRankedFiles } from "./lib/client-assets.ts";
import { hashClientAssets } from "./lib/hash-client-assets.ts";
import { foldLongProse } from "./lib/prose-fold.ts";
import { minifyHtml } from "./lib/html-minify.ts";
import { patchStaticShell, renderDesktopArtifacts, staticShellPages } from "../tools/photos/gen-desktop-partial.ts";
import { phaseClock, phaseSummary } from "./lib/build-phases.ts";
import { cloneTree } from "./lib/clone-tree.ts";
import { repoPathTokens } from "./lib/repo-path-tokens.ts";
import { buildCache, buildCacheEnabled } from "./lib/build-cache.ts";
import { zstdCompressDictionaryBatch } from "./lib/zstd-batch.ts";

const { phase, finish: finishPhases } = phaseClock();

const OUT = ".build";
process.env.UV_THREADPOOL_SIZE ||= String(Math.max(4, Math.min(8, availableParallelism())));
const brotliCompressAsync = promisify(brotliCompress);

function compressQ11(bytes) {
  return brotliCompressAsync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      // 24 is the largest window legal for Content-Encoding: br (RFC 7932 §4).
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}
const cache = buildCache({ enabled: buildCacheEnabled() });
const RUNTIME = `bun@${Bun.revision}`;
const Q11 = {
  name: `brotli ${createHash("sha256").update(compressQ11.toString()).digest("hex")} ${RUNTIME}`,
  keyOf: (bytes: Buffer) => [bytes],
  verify: (bytes: Buffer, out: Buffer) => brotliDecompressSync(out).equals(bytes),
  encode: async ([bytes]: Buffer[]) => [await compressQ11(bytes)],
};
const brotliQ11 = async (bytes: Buffer): Promise<Buffer> => (await cache.many([bytes], Q11))[0];
const twinHeadStart = (body: string) => { brotliQ11(Buffer.from(body)).catch(() => {}); };
const digests = new WeakMap<Uint8Array, string>();
const digestOf = (bytes: Uint8Array) => {
  let d = digests.get(bytes);
  if (!d) digests.set(bytes, d = createHash("sha256").update(bytes).digest("hex"));
  return d;
};
type ZstdJob = { bytes: Uint8Array; dictionary: Uint8Array };
const ZSTD = {
  name: `zstd level${DCZ_ZSTD_LEVEL} raw-dictionary ${RUNTIME}`,
  keyOf: ({ bytes, dictionary }: ZstdJob) => [digestOf(dictionary), bytes],
  verify: ({ bytes, dictionary }: ZstdJob, out: Buffer) => zstdDecompressSync(out, { dictionary }).equals(bytes),
  encode: (jobs: ZstdJob[]) => zstdCompressDictionaryBatch(jobs),
};
const zstdBatch = (jobs: ZstdJob[]) => cache.many(jobs, ZSTD);

function containsRetiredRumHost(source) {
  if (!/cloudflareinsights/i.test(source)) return false;
  const candidates = source.match(/\b(?:https?:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?/gi) || [];
  for (const candidate of candidates) {
    const withoutWildcard = candidate.replace(/^\*\./, "");
    let hostname;
    try {
      hostname = new URL(/^[a-z]+:\/\//i.test(withoutWildcard)
        ? withoutWildcard
        : `https://${withoutWildcard}`).hostname.toLowerCase();
    } catch {
      continue;
    }
    const labels = hostname.split(".");
    if (labels.at(-2) === "cloudflareinsights" && labels.at(-1) === "com") return true;
  }
  return false;
}

const SERVED_SOURCES = AUTHORED_ROOTS;
const servedFiles = async (filter?: (rel: string) => boolean): Promise<string[]> => {
  const out: string[] = [];
  for (const root of SERVED_SOURCES) {
    for (const rel of await readdir(root, { recursive: true })) {
      if (filter && !filter(rel)) continue;
      out.push(`${root}/${rel}`);
    }
  }
  return out;
};
// The two roots SERVED_SOURCES leaves out: client islands and stylesheets.
// Recursive, because src/client/garage/ and src/client/lwe/ serve at /garage/
// and /lwe/. Every tripwire that reads these roots reads them through here;
// until 2026-10-08 the taste scan never named them at all, so a web font in
// prose.css built clean, and the flat readdirs elsewhere missed both subtrees
// (gotcha 55).
const shellFiles = async (): Promise<string[]> => [
  ...(await readdir("src/client", { recursive: true })).filter((r) => r.endsWith(".js")).map((r) => `src/client/${r}`),
  ...(await readdir("src/styles", { recursive: true })).filter((r) => r.endsWith(".css")).map((r) => `src/styles/${r}`),
];

const jsoncStringArray = (configSrc: string, key: string): string[] => {
  const block = (configSrc.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`)) || [, ""])[1];
  return [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

// The run_worker_first allowlist. Entries starting with "!" are wrangler's
// negation form and are left in; a caller wanting only positive patterns filters
// them itself.
const runWorkerFirst = (configSrc: string): string[] => jsoncStringArray(configSrc, "run_worker_first");

const siteConfigText = async (): Promise<string> => JSON.stringify(await siteConfig(), null, 2);

async function checkInvariants() {
  const reads = new Map<string, Promise<string>>();
  const read = (p: string): Promise<string> => {
    let text = reads.get(p);
    if (!text) reads.set(p, text = readFile(p, "utf8"));
    return text;
  };
  const readAll = (files: string[]): Promise<(string | null)[]> => Promise.all(files.map((f) => read(f).catch(() => null)));
  const hard: string[] = [], warn: string[] = [];

  let servedPlan: ServedTreePlan | null = null;
  try {
    servedPlan = await planServedTree();
  } catch (error) {
    if (!(error instanceof ServedTreeCollision)) throw error;
    hard.push(error.message);
  }

  const wrangler = await siteConfigText();
  const routeModule = await import(pathToFileURL(resolve("src/worker/routes.ts")).href);
  const routeKeys: readonly string[] = routeModule.EXACT_PATHS;
  const prefixProbes: string[] = routeModule.PREFIX_ROUTES.map((r) => r.probe);
  if (routeKeys.length < 60) hard.push(`route invariant read only ${routeKeys.length} exact routes from routes.ts — the list has lost its routes`);
  const allow = runWorkerFirst(wrangler);
  if (allow.length < 60) hard.push(`route invariant scanned only ${allow.length} run_worker_first entries — the scanner has lost the allowlist, not the config its rules`);
  for (const p of routeModule.uncoveredRoutes(allow)) hard.push(`route ${p} is not in wrangler run_worker_first (route would silently serve static)`);

  for (const f of ["public/_headers", "src/worker/lib/security.ts", "serendipity/serendipity.ts", "cal/src/templates.ts", "cal/src/index.ts"]) {
    let s; try { s = await read(f); } catch { continue; }
    for (const m of s.matchAll(/style-src([^;'"]*(?:'[^']*')?[^;'"]*)*/g)) {
      const dir = m[0];
      if (!dir.includes("'self'")) hard.push(`${f}: a CSP style-src omits 'self' (would block /luna.css): ${dir.slice(0, 60)}`);
    }
  }

  const VT_DIAGNOSTIC = /^garage\/vt-(check|b)\.html$/;
  const vtSources = [
    ...(await servedFiles((r) => /\.(html|css|js)$/.test(r) && !VT_DIAGNOSTIC.test(r))),
    ...(await shellFiles()),
    "cal/src/templates.ts", "serendipity/serendipity.ts", "pipelines/lwe/generate.mjs",
  ];
  const vtTexts = await readAll(vtSources);
  for (const [i, f] of vtSources.entries()) {
    const s = vtTexts[i];
    if (s === null) continue;
    if (!s.includes("@view-transition")) continue;
    const css = f.endsWith(".html")
      ? [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n")
      : s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/@view-transition\s*\{/.test(css)) hard.push(`${f}: re-opts into View Transitions (@view-transition), removed site-wide 2026-07-30`);
  }
  const luna = await read("src/styles/luna.css");

  try {
    const res = transformCss({ filename: "src/styles/luna.css", code: Buffer.from(luna), minify: false });
    for (const w of res.warnings) hard.push(`luna.css CSS parse warning: ${w.message}${w.loc ? ` (line ${w.loc.line})` : ""}`);
  } catch (e) {
    hard.push(`luna.css failed to parse as CSS: ${e.message.split("\n")[0]}`);
  }

  try {
    const artifacts = renderDesktopArtifacts();
    if (await read("src/worker/lib/desktop.ts") !== artifacts.moduleSource) {
      hard.push("lib/desktop.js drifted from shell-data.ts/site-manifest.json — run bun run gen:shell");
    }
    if (await read("public/icons.svg") !== artifacts.sprite) {
      hard.push("icons.svg drifted from shell-data.ts — run bun run gen:shell");
    }
    for (const [name, svg] of Object.entries(artifacts.favicons)) {
      if (await read(`public/section-icons/${name}.svg`) !== svg) {
        hard.push(`section-icons/${name}.svg drifted from shell-data.ts — run bun run gen:shell`);
      }
    }
    for (const file of staticShellPages()) {
      const source = await read(file);
      if (patchStaticShell(source, artifacts) !== source) {
        hard.push(`${file}: static desktop partial drifted — run bun run gen:shell`);
      }
    }
  } catch (e) { hard.push(`desktop generator freshness check could not run: ${e.message}`); }

  const floors = new Map();
  for (const f of ["src/styles/luna.css", "src/pages/index.html", "cal/src/templates.ts"]) {
    let s; try { s = await read(f); } catch { continue; }
    for (const m of s.matchAll(/(?<!max-)height:\s*calc\(100dvh\s*-\s*(\d+)px\)/g)) floors.set(f, m[1]);
    if (!floors.has(f)) warn.push(`${f}: no taskbar-floor calc found; the geometry check has nothing to compare against luna.css`);
  }
  const floorVals = new Set(floors.values());
  if (floorVals.size > 1) warn.push(`taskbar-floor height disagrees across the critical-geometry copies (${[...floors].map(([f, v]) => `${f.split("/").pop()}:${v}px`).join(", ")}) — luna.css and the inline copies must match`);

  if (!clientEdgeDecl(await read("src/styles/luna.css"))) hard.push("luna.css: the client-edge declaration went missing (search \"THE CLIENT EDGE\") — build.ts injects it into every windowed page and has nothing to inject");

  let skillsChecked = 0;
  try {
    const idx = JSON.parse(await read("public/.well-known/agent-skills/index.json"));
    for (const s of idx.skills || []) {
      const path = "public" + new URL(s.url).pathname;
      const actual = "sha256:" + createHash("sha256").update(await readFile(path)).digest("hex");
      if (s.digest !== actual) hard.push(`agent-skills: ${s.name} digest is stale — index.json says ${s.digest.slice(0, 20)}…, ${path} hashes to ${actual.slice(0, 20)}… (regenerate index.json)`);
      skillsChecked++;
    }
  } catch (e) { warn.push(`agent-skills digest check could not run: ${e.message}`); }

  try {
    const runtimeFiles = [
      "src/pages/index.html",
      "src/worker/index.ts",
      "cloudflare.config.ts",
      "wrangler.config.ts",
      "config/dev/cloudflare.config.ts",
      "config/dev/wrangler.config.ts",
    ];
    const forbidden = ["/ledger/rum", "data-cf-beacon", "cloudflareinsights.com"];
    for (const name of runtimeFiles) {
      const source = await read(name);
      for (const marker of forbidden) {
        if (source.includes(marker)) hard.push(`${name}: browser RUM is retired; remove ${marker}`);
      }
    }
    if ((await readdir("src/worker")).some((f) => f === "rum.js" || f === "rum.ts")) {
      hard.push("src/worker/rum.js: browser RUM is retired; remove the proxy module");
    }
    for (const [name, text] of [
      ["public/_headers", await read("public/_headers")],
      ["src/worker/lib/security.ts", await read("src/worker/lib/security.ts")],
    ]) {
      if (containsRetiredRumHost(text)) {
        hard.push(`${name}: browser RUM is retired; remove the Cloudflare Insights CSP allowance`);
      }
    }
  } catch (e) { warn.push(`no-RUM check could not run: ${e.message}`); }

  let manifestChecked = 0;
  try {
    const { surfaces } = readManifest();
    const nav = await read("src/client/nav-run.js");
    const desktop = await read("src/worker/lib/desktop.ts");

    const modActual = (await read("src/worker/lib/site-manifest.ts")).trim();
    if (modActual !== workerModule(surfaces).trim()) hard.push("lib/site-manifest.js drifted from site-manifest.json — run bun run gen:manifest");
    for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
      if (readFenceBody(nav, marker) !== navFenceBody(surfaces, section)) hard.push(`nav-run.js generated:${marker} drifted from site-manifest.json — run bun run gen:manifest`);
    }
    if (readFenceBody(nav, "run-profiles") !== runProfilesBody()) hard.push("nav-run.js profiles drifted from shell-data.ts — run bun run gen:manifest");

    const navPagesBlock = (nav.match(/var PAGES = \[([\s\S]*?)\n {2}\];/) || [, ""])[1];
    const navRun = new Set([...navPagesBlock.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]));
    const navTaskbar = new Set([...desktop.matchAll(/class=\\"axp-pin\\"[^>]*href=\\"([^"]+)\\"/g)].map((m) => m[1]));
    const sitemap = await read("public/sitemap.xml");
    const smLocs = new Set([...sitemap.matchAll(/<loc>https:\/\/aadhar\.sh([^<]*)<\/loc>/g)].map((m) => m[1] || "/"));
    const gallery = (await read("src/pages/garage/index.html"))
      .replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, "");
    const galLinks = new Set([...gallery.matchAll(/href="(\/(?:garage\/[a-z0-9][a-z0-9-]*|pixel-peeper))"/g)].map((m) => m[1]));

    const want = (f) => surfaces.filter((s) => s.flags[f]).map((s) => s.path);
    const bidi = (label, wantPaths, have, opts: { subsetOnly?: boolean } = {}) => {
      const w = new Set(wantPaths) as Set<string>;
      for (const p of w) if (!have.has(p)) hard.push(`${label}: ${p} is flagged in site-manifest.json but missing from the surface`);
      if (!opts.subsetOnly) for (const p of have) if (!w.has(p)) hard.push(`${label}: ${p} is in the surface but not flagged in site-manifest.json`);
    };
    bidi("run/nav-run.js PAGES", want("run"), navRun);
    bidi("taskbar/compiled desktop", want("taskbar"), navTaskbar);
    bidi("gallery/garage index", want("gallery"), galLinks);
    for (const p of want("sitemap")) if (!smLocs.has(p)) hard.push(`sitemap: ${p} is flagged sitemap in site-manifest.json but has no <loc>`);
    for (const p of smLocs) if (/^\/(garage|lwe)\//.test(p) && !surfaces.some((s) => s.path === p)) hard.push(`sitemap: ${p} has a <loc> but is not registered in site-manifest.json`);
    const posts = JSON.parse(await read("src/content/writing/posts.json"));
    for (const post of posts) if (!smLocs.has(`/writing/${post.slug}`)) hard.push(`sitemap: /writing/${post.slug} is in posts.json but has no <loc>`);

    const BARE = new Set(["index.html", "vt-b.html", "vt-check.html"]);
    const known = new Set(surfaces.map((s) => s.path));
    for (const dir of ["garage", "lwe"]) {
      for (const f of await readdir(`public/${dir}`)) {
        if (!f.endsWith(".html") || BARE.has(f)) continue;
        const p = `/${dir}/${f.slice(0, -5)}`;
        if (!known.has(p)) hard.push(`${p} exists on disk but is not registered in site-manifest.json`);
      }
    }
    manifestChecked = surfaces.length;
  } catch (e) { hard.push(`site-manifest check could not run: ${e.message}`); }

  let tasteScanned = 0, tasteOk = [];
  try {
    const activeText = (rel: string): boolean =>
      rel === "_headers" || /\.(?:[cm]?[jt]sx?|css|html?|xhtml|xml|svg)$/i.test(rel);
    const programFiles = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true }))
      .filter((rel) => /\.(?:[cm]?[jt]sx?)$/i.test(rel))
      .map((rel) => `${root}/${rel}`);
    const served = [
      ...await servedFiles(activeText),
      ...await shellFiles(),
      ...await programFiles("src/worker"),
      ...await programFiles("cal/src"),
      ...await programFiles("serendipity"),
    ];
    const isDemo = (p) => /^(?:public|src\/pages|src\/client)\/(?:garage|lwe)\//.test(p);
    const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

    const servedTexts = await readAll(served);
    for (const [i, f] of served.entries()) {
      const raw = servedTexts[i];
      if (raw === null) continue;
      const src = blank(raw);
      let lines: string[] | null = null;
      const lineAt = (off) => (lines ??= raw.split("\n"))[src.slice(0, off).split("\n").length - 1] || "";
      const okOn = (off) => {
        const m = /taste-ok:\s*([^*/]+)/.exec(lineAt(off));
        if (!m) return false;
        tasteOk.push(`${f}: ${m[1].trim()}`);
        return true;
      };
      tasteScanned++;

      if (/@font-face\s*\{[^}]*url\(/i.test(src)) hard.push(`${f}: @font-face with url() — the site ships 0 font bytes (local() reference rules belong in design/tokens/fonts.css, never in a served file)`);
      if (/@import[^;]*(font|typekit)/i.test(src)) hard.push(`${f}: @import of a font stylesheet — the site ships 0 font bytes`);
      if (/as\s*=\s*"?font"?/i.test(src)) hard.push(`${f}: rel=preload as=font — the site ships 0 font bytes`);
      for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "fonts.bunny.net"]) {
        if (src.includes(host)) hard.push(`${f}: references ${host} — the site ships 0 font bytes`);
      }

      for (const m of src.matchAll(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)) {
        const [y1, y2] = [Number(m[2]), Number(m[4])];
        if (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1) hard.push(`${f}: ${m[0]} overshoots — springy easing reads as a different era`);
      }
      if (isDemo(f)) continue;

      for (const m of src.matchAll(/cubic-bezier\([^)]*\)/g)) {
        const v = m[0].replace(/\s+/g, "");
        if (!["cubic-bezier(.4,0,1,1)", "cubic-bezier(0,0,.2,1)"].includes(v) && !okOn(m.index)) warn.push(`${f}: ${m[0]} is not one of the two window-morph curves — taste review`);
      }
      for (const m of src.matchAll(/border-radius:\s*([^;}"']+)/g)) {
        if (m[1].includes("/")) continue;
        for (const px of m[1].matchAll(/([\d.]+)px/g)) {
          if (Number(px[1]) > 8 && !okOn(m.index)) warn.push(`${f}: border-radius ${m[1].trim()} exceeds --radius-window (8px) — taste review`);
        }
      }
      for (const m of src.matchAll(/box-shadow:\s*([^;}"']+)/g)) {
        if (/\binset\b/.test(m[1])) continue;
        for (const px of m[1].matchAll(/-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+)px/g)) {
          if (Number(px[1]) > 12 && !okOn(m.index)) warn.push(`${f}: box-shadow blur ${px[1]}px reads as a modern elevation shadow — taste review`);
        }
      }
      const sb = /scroll-behavior:\s*smooth/.exec(src);
      if (sb && !okOn(sb.index)) warn.push(`${f}: scroll-behavior: smooth — XP scrolled instantly`);
    }
  } catch (e) { warn.push(`taste tripwire could not run: ${e.message}`); }

  let conflictScanned = 0;
  try {
    const collect = async (dir, match, skip = /^$/, out = []) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!skip.test(e.name)) await collect(p, match, skip, out); }
        else if (match.test(e.name)) out.push(p);
      }
      return out;
    };
    const flat = async (dir, match) =>
      (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && match.test(e.name)).map((e) => `${dir}/${e.name}`);
    const files = [
      ...await collect("src/pages", /\.html$/, /^(i|images|og|cars|node_modules)$/),
      ...await shellFiles(),
      ...await collect("src/worker", /\.ts$/),
      ...await flat("cal/src", /\.ts$/),
      ...await flat("serendipity", /\.js$/),
    ];
    const MARKER = /^(<{7} |={7}$|>{7} )/;
    const conflictTexts = await readAll(files);
    for (const [i0, f] of files.entries()) {
      const src = conflictTexts[i0];
      if (src === null) continue;
      conflictScanned++;
      if (!src.includes("<<<<<<< ") && !src.includes("=======") && !src.includes(">>>>>>> ")) continue;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (MARKER.test(line)) hard.push(`${f}:${i + 1}: git conflict marker in a served file — ${line.slice(0, 60)}`);
      }
    }
  } catch (e) { hard.push(`conflict-marker check could not run: ${e.message}`); }

  if (warn.length) console.warn("build: invariant WARNINGS (deploy continues):\n  - " + warn.join("\n  - "));
  if (hard.length) throw new Error("build: invariant tripwires FAILED, deploy blocked:\n  - " + hard.join("\n  - "));
  if (!servedPlan) throw new Error("build: the served tree was never planned");
  console.log(`invariants ok: ${servedPlan.files.size} staged paths collision-free, ${routeKeys.length + prefixProbes.length} routes mirrored (${prefixProbes.length} prefix), CSP style-src, blink-fix, generator, geometry, ${skillsChecked} skill digest${skillsChecked === 1 ? "" : "s"}, ${manifestChecked} surfaces registered, ${tasteScanned} files taste-scanned${tasteOk.length ? ` (${tasteOk.length} taste-ok: ${tasteOk.join("; ")})` : ""}, ${conflictScanned} files conflict-free${warn.length ? " (with warnings above)" : ""}`);
  return servedPlan;
}

phase("invariants");
const clientEdgeDecl = (luna) => {
  const m = /\.window>\.content,\.window>\.body\{(border:\d+px solid (?:#ece9d8|var\(--face,#ece9d8\))[^}]*outline-offset:-\d+px)\}/.exec(luna);
  return m ? m[1] : null;
};

const GEOMETRY_MIRROR = /^([ \t]*)(\.window\s*>\s*\.content(?:\s*,\s*\.window\s*>\s*\.body)?\s*\{[^}]*overflow:\s*auto[^}]*\})[ \t]*$/m;

const clientEdgeMirror = (source, decl) => {
  const m = GEOMETRY_MIRROR.exec(source);
  if (!m) return null;
  const [, indent, rule] = m;
  const sel = rule.slice(0, rule.indexOf("{")).trim();
  const spaced = sel.includes(" > ");
  const body = spaced ? decl.replace(/([:,])(?! )/g, "$1 ").replace(/;/g, "; ") : decl;
  const line = spaced
    ? `${indent}/* client edge — generated by build.ts from luna.css */\n${indent}${sel} { ${body}; }`
    : `${indent}/* client edge — generated by build.ts from luna.css */\n${indent}${sel}{${body}}`;
  return source.slice(0, m.index + m[0].length) + "\n" + line + source.slice(m.index + m[0].length);
};

{
  const problems = clientScriptProblems(await readdir("src/client", { recursive: true }));
  if (problems.length) throw new Error(`client assets: ${problems.join("; ")}`);
}

const servedPlan = await checkInvariants();

phase("clean .build");
for (const dead of ["public/ad"]) {
  await rm(dead, { recursive: true, force: true });
}
const BUILD_TRASH = "node_modules/.cache/aadhar-build-trash";
let sweep: Promise<void> = Promise.resolve();
if (existsSync(OUT)) {
  try {
    await mkdir(BUILD_TRASH, { recursive: true });
    await rename(OUT, `${BUILD_TRASH}/${process.pid}-${Date.now()}`);
    sweep = new Promise((resolve) => {
      const child = spawn("rm", ["-rf", BUILD_TRASH], { stdio: ["ignore", "ignore", "inherit"] });
      child.once("error", (e) => { console.warn(`clean: could not sweep ${BUILD_TRASH}: ${e.message}`); resolve(); });
      child.once("exit", (code) => { if (code) console.warn(`clean: rm -rf ${BUILD_TRASH} exited ${code}`); resolve(); });
    });
  } catch {
    await rm(OUT, { recursive: true, force: true });
  }
}
await mkdir(OUT, { recursive: true });

phase("1 stage");
await Promise.all([
  mkdir(`${OUT}/public`, { recursive: true }),
  mkdir(`${OUT}/src`, { recursive: true }),
  mkdir(`${OUT}/cal`, { recursive: true }),
  mkdir(`${OUT}/serendipity`, { recursive: true }),
]);
await Promise.all([
  copyServedTree(servedPlan, `${OUT}/public`),
  cloneTree(resolve("src/worker"), resolve(`${OUT}/src/worker`)).then(async (cloned) => { if (!cloned) await cp("src/worker", `${OUT}/src/worker`, { recursive: true }); }),
  cloneTree(resolve("cal/src"), resolve(`${OUT}/cal/src`)).then(async (cloned) => { if (!cloned) await cp("cal/src", `${OUT}/cal/src`, { recursive: true }); }),
  cp("serendipity", `${OUT}/serendipity`, {
    recursive: true,
    filter: (source) => !source.includes(`${sep}migrations`) && (!/\.\w+$/.test(source) || source.endsWith(".ts")),
  }),
]);

{
  const svgs = ["icons.svg", ...(await readdir(`${OUT}/public/section-icons`)).map((f) => `section-icons/${f}`)]
    .filter((rel) => rel.endsWith(".svg"));
  let stripped = 0;
  for (const rel of svgs) {
    const path = `${OUT}/public/${rel}`;
    const src = await readFile(path, "utf8");
    const out = src.replace(/^(<svg\b[^>]*>)<!--[\s\S]*?-->/, "$1");
    if (out !== src) { await writeFile(path, out); stripped += src.length - out.length; }
  }
  console.log(`svg: generator comments stripped from ${svgs.length} files, ${stripped} bytes raw`);

  const bimi = `${OUT}/public/bimi.svg`;
  const bimiSrc = await readFile(bimi, "utf8");
  let bimiOut = bimiSrc;
  for (let prev = ""; prev !== bimiOut;) {
    prev = bimiOut;
    bimiOut = bimiOut.replace(/<!--[\s\S]*?-->/g, "");
  }
  if (bimiOut.includes("<!--")) throw new Error("bimi.svg: an unterminated <!-- survived the comment strip");
  bimiOut = bimiOut.replace(/>\s+</g, "><").trim();
  if (!bimiOut.includes('baseProfile="tiny-ps"') || !bimiOut.includes("<title>")) {
    throw new Error("bimi.svg: minified copy lost the Tiny-PS profile or its <title>, which BIMI validators require");
  }
  await writeFile(bimi, bimiOut);
  console.log(`svg: bimi.svg ${bimiSrc.length} -> ${bimiOut.length} bytes raw`);
}
phase("1a photo indexes");
{
  const exif = await buildExifIndex(".");
  const stems = Object.keys(exif);
  if (stems.length < 100) {
    throw new Error(`exif index: only ${stems.length} stems (expected 100+) — is public/images/metadata.json readable and whole?`);
  }
  const hashes = JSON.parse(await readFile("public/images/hashes.json", "utf8"));
  const uncovered = Object.keys(hashes).filter((stem) => !exif[stem]);
  if (uncovered.length) {
    throw new Error(`exif index: ${uncovered.length} published photo(s) carry no EXIF record: ${uncovered.slice(0, 8).join(", ")}${uncovered.length > 8 ? " …" : ""} — re-run tools/photos/extract-photo-metadata.sh`);
  }
  await writeFile(`${OUT}/public/images/exif.json`, serializeExifIndex(exif));

  const { index, photos, tiers } = await buildImageFingerprints(".");
  if (tiers < 400) {
    throw new Error(`image fingerprints: only ${tiers} tiers digested (expected 400+) — is public/images/hashes.json readable and whole?`);
  }
  await writeFile(`${OUT}/public/images/fingerprints.json`, serializeFingerprints(index));
  console.log(`photo indexes: exif.json ${stems.length} stems, fingerprints.json ${tiers} tiers across ${photos} photos`);
}

{
  const exif = JSON.parse(await readFile(`${OUT}/public/images/exif.json`, "utf8").catch(() => "{}"));
  const packed = JSON.parse(await readFile(`${OUT}/public/images/histograms.json`, "utf8").catch(() => "{}"));
  await mkdir(`${OUT}/public/images/meta`, { recursive: true });
  const entries = Object.entries(exif) as [string, Record<string, any>][];
  await Promise.all(entries.map(async ([stem, record]) => {
    const out = { ...record };
    const hi = unpackHistogram(packed[stem]);
    if (hi) out.hi = hi;
    await writeFile(`${OUT}/public/images/meta/${stem}.json`, JSON.stringify(out));
  }));
  const written = entries.length;
  if (written < 30) throw new Error(`meta twins: only ${written} per-photo files generated — is images/exif.json staged?`);
  console.log(`meta twins: ${written} per-photo files derived from exif.json + histograms.json`);
}


phase("1b client edge");
{
  const decl = clientEdgeDecl(await readFile("src/styles/luna.css", "utf8"));
  const targets = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((f) => /\.(html|js)$/.test(f) && !/\.src\.|^(i|images|og|cars)\//.test(f))
    .map((f) => `${OUT}/public/${f}`)
    .concat((await readdir(`${OUT}/src/worker`, { recursive: true }))
      .filter((f) => f.endsWith(".js") || f.endsWith(".ts"))
      .map((f) => `${OUT}/src/worker/${f}`))
    .concat([`${OUT}/cal/src/templates.ts`, `${OUT}/serendipity/serendipity.ts`]);

  const outcomes = await Promise.all(targets.map(async (f) => {
    let src; try { src = await readFile(f, "utf8"); } catch { return null; }
    if (!GEOMETRY_MIRROR.test(src)) return false;
    const out = clientEdgeMirror(src, decl);
    if (!out) throw new Error(`client edge: ${f} matched the geometry mirror but the injection did not fire`);
    await writeFile(f, out);
    return true;
  }));
  const mirrored = outcomes.filter((outcome) => outcome === true).length;
  const skipped = outcomes.filter((outcome) => outcome === false).length;
  if (outcomes[targets.indexOf(`${OUT}/public/index.html`)] !== true) throw new Error(`client edge: the homepage was not mirrored (${mirrored} files were); did the geometry-mirror shape change in src/pages/index.html or luna.css?`);
  console.log(`client edge: mirrored into ${mirrored} staged pages from luna.css (${skipped} files carry no window geometry)`);
}

phase("1c minifier setup");

const minifyJavaScript = (filename, sourceText, options: MinifyOptions = OXC_MINIFY_OPTIONS) => {
  const result = minifySync(filename, sourceText, options);
  if (result.errors.length) {
    throw new Error(`${filename}: Oxc parse/minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.code;
};

const minifyCss = (filename, sourceText) => parseCss(filename, sourceText, { minify: true });

const RAW_HTML_TAGS = new Set(["pre", "script", "style", "textarea"]);

const toolVersion = (pkg: string): string => `${pkg}@${JSON.parse(readFileSync(Bun.resolveSync(`${pkg}/package.json`, import.meta.dir), "utf8")).version}`;
const digestFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const INLINE_CSS = `${toolVersion("lightningcss")} css-parse ${digestFile("tools/lib/css-parse.ts")} custom-media ${digestFile("src/styles/custom-media.css")} ${minifyCss.toString()}`;
const INLINE_JS = `${toolVersion("oxc-minify")} ${JSON.stringify(OXC_MINIFY_OPTIONS)} ${minifyJavaScript.toString()}`;
const DOCUMENT = `html-minify ${digestFile("tools/lib/html-minify.ts")}`;

const findHtmlTagEnd = (source, start) => {
  let quote = "";
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  throw new Error("HTML inline transform: unterminated tag at byte " + start);
};

const scriptType = (openTag) => {
  const match = openTag.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
  return (match ? (match[1] || match[2] || match[3] || "") : "").toLowerCase();
};

const isJavaScriptScript = (openTag) => {
  const type = scriptType(openTag);
  return !type || ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"].includes(type);
};

const transformInlineHtmlBlocks = (source, label = "src/pages/index.html") => {
  let out = "";
  let cursor = 0;

  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor);
    if (lt === -1) {
      out += source.slice(cursor);
      break;
    }

    out += source.slice(cursor, lt);
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("HTML inline transform: unterminated comment at byte " + lt);
      out += source.slice(lt, end + 3);
      cursor = end + 3;
      continue;
    }

    const gt = findHtmlTagEnd(source, lt);
    const token = source.slice(lt, gt + 1);
    out += token;
    cursor = gt + 1;

    const match = token.match(/^<\s*(\/?)\s*([A-Za-z][^\s/>]*)/);
    if (!match || match[1] || !RAW_HTML_TAGS.has(match[2].toLowerCase())) continue;

    const tag = match[2].toLowerCase();
    const close = new RegExp("<\\/\\s*" + tag + "\\s*>", "i").exec(source.slice(cursor));
    if (!close) throw new Error("HTML inline transform: unterminated <" + tag + "> element");
    const closeAt = cursor + close.index;
    const body = source.slice(cursor, closeAt);

    if (tag === "style") {
      out += cache.memo(INLINE_CSS, [body], () => minifyCss(`${label} inline <style>`, body));
    } else if (tag === "script" && isJavaScriptScript(token)) {
      out += cache.memo(INLINE_JS, [body], () => minifyJavaScript(`${label} inline <script>`, body));
    } else if (tag === "script" && isJsonScriptType(scriptType(token)) && !body.trim() && /\sdata-src=/i.test(token)) {
      out += body;
    } else if (tag === "script" && isJsonScriptType(scriptType(token))) {
      out += minifyJsonScript(`${label} inline <script type=${scriptType(token)}>`, body);
    } else {
      out += body;
    }

    out += source.slice(closeAt, closeAt + close[0].length);
    cursor = closeAt + close[0].length;
  }

  return out;
};

const minifiedPage = (staged, rel) => {
  const twinRel = rel.replace(/\.html$/, ".src.html");
  const banner = `<!-- minified at deploy; readable source: /${twinRel} -->\n`;
  const body = transformInlineHtmlBlocks(staged, `public/${rel}`);
  return banner + cache.memo(DOCUMENT, [body], () => minifyHtml(body));
};

const inlineProbe = transformInlineHtmlBlocks(
  '<style>/* probe */ .x { color: red; }</style>\n' +
  '<script>/* probe */ const x = 1 + 2;</script>\n' +
  '<script type="application/ld+json">\n{ "x": 1 }\n</script>'
);
if (inlineProbe.includes("/* probe */") ||
    !inlineProbe.includes('<script type="application/ld+json">{"x":1}</script>')) {
  throw new Error("inline CSS/JS/JSON transform self-test failed");
}


phase("1d homepage grid");
{
  const nonce = `?build=${BUILD_NONCE}`;
  const grid = await import(pathToFileURL(resolve(OUT, "src/worker/lib/photo-grid.ts")).href + nonce);
  const photos = await import(pathToFileURL(resolve(OUT, "src/worker/photos.ts")).href + nonce);
  const pool = photos.curatedPool(photos.derivePhotoPool(
    JSON.parse(await readFile(`${OUT}/src/worker/photo-index.json`, "utf8")),
    JSON.parse(await readFile(`${OUT}/public/images/hashes.json`, "utf8")),
  ));
  if (!pool.length) throw new Error("homepage bake: the photo pool is empty — the grid fallback would ship as bare frames");
  const altMap = JSON.parse(await readFile(`${OUT}/public/images/alt.json`, "utf8").catch(() => "{}"));
  const histograms = JSON.parse(await readFile(`${OUT}/public/images/histograms.json`, "utf8").catch(() => "{}"));
  const twelve = grid.deterministicTwelve(pool);
  if (twelve.length !== 12) throw new Error(`homepage bake: expected 12 fallback tiles, pool yielded ${twelve.length}`);
  const histed = twelve.filter((p) => histograms[p.stem]).length;
  if (histed !== 12) throw new Error(`homepage bake: ${histed} of 12 baked tiles carry a histogram — run bun run photos or bun tools/photos/build-histogram-index.ts`);
  const slots = grid.renderPhotoSlots(twelve, altMap, { histograms });

  let html = await readFile(`${OUT}/public/index.html`, "utf8");
  const section = /(<section class="photos"[^>]*>)([\s\S]*?)(<\/section>)/;
  if (!section.test(html)) throw new Error("homepage bake: no <section class=\"photos\"> to fill — did the grid markup move?");
  html = html.replace(section, (_m, open, _inner, close) => open + slots + close);

  let newest = 0;
  for (const p of pool) { const t = p.uploaded ? Date.parse(p.uploaded) : NaN; if (!isNaN(t) && t > newest) newest = t; }
  if (newest > 0) {
    const d = new Date(newest);
    const iso = d.toISOString().slice(0, 10);
    const shown = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    html = html.replace(/<time datetime="([^"]*)"[^>]*>([^<]*)<\/time>/, (m, floor) =>
      iso >= floor ? `<time datetime="${iso}">${shown}</time>` : m);
  }
  await writeFile(`${OUT}/public/index.html`, html);
  console.log(`homepage bake: 12 deterministic fallback tiles + last-modified ${new Date(newest).toISOString().slice(0, 10)}`);
}

phase("1e photos + bot");
{
  const nonce = `?build=${BUILD_NONCE}`;
  const photos = await import(pathToFileURL(resolve(OUT, "src/worker/photos.ts")).href + nonce);
  const bot = await import(pathToFileURL(resolve(OUT, "src/worker/bot.ts")).href + nonce);
  const trust = await import(pathToFileURL(resolve(OUT, "src/worker/trust.ts")).href + nonce);
  const publicApi = await import(pathToFileURL(resolve(OUT, "src/worker/lib/openapi.ts")).href + nonce);

  const pool = photos.derivePhotoPool(
    JSON.parse(await readFile(`${OUT}/src/worker/photo-index.json`, "utf8")),
    JSON.parse(await readFile(`${OUT}/public/images/hashes.json`, "utf8")),
  );
  if (!pool.length) throw new Error("photos page: the pool is empty — the contact sheet would ship with no tiles");
  const altMap = JSON.parse(await readFile(`${OUT}/public/images/alt.json`, "utf8").catch(() => "{}"));

  const photosHtml = await photos.renderPhotosPage(pool, altMap).text();
  if (!photosHtml.includes("class=\"ph\"")) throw new Error("photos page: rendered document has no tiles — did the markup move?");
  await writeFile(`${OUT}/public/photos.html`, photosHtml);

  await writeFile(`${OUT}/public/images/manifest.json`, photos.imagesManifestJson(pool));

  const albums: typeof import("../src/worker/albums.ts") = await import(pathToFileURL(resolve(OUT, "src/worker/albums.ts")).href + nonce);
  const { ALBUMS, albumPath } = albums;
  const albumSizes: string[] = [];
  for (const album of Object.values(ALBUMS)) {
    const response = photos.renderAlbumPage(album, pool, altMap);
    if (response.status !== 200) throw new Error(`album page ${albumPath(album)}: no photo in the pool carries album "${album.slug}" — run add-photos.sh with ALBUM=${album.slug}, or remove the registry entry`);
    const html = await response.text();
    if (!html.includes("class=\"ph\"")) throw new Error(`album page ${albumPath(album)}: rendered document has no tiles — did the markup move?`);
    await writeFile(`${OUT}/public${albumPath(album)}.html`, html);
    albumSizes.push(`${albumPath(album)}.html ${html.length}B (${photos.albumPool(pool, album).length} tiles)`);
  }

  const imageSitemap = photos.imageSitemapXml(pool, Object.values(ALBUMS));
  const imageCount = (imageSitemap.match(/<image:image>/g) || []).length;
  if (imageCount < 100) throw new Error(`sitemap-images.xml: only ${imageCount} images from a pool of ${pool.length}`);
  await writeFile(`${OUT}/public/sitemap-images.xml`, imageSitemap);

  const botHtml = await bot.renderBotPage().text();
  if (!botHtml.includes("AadharshBot")) throw new Error("bot page: rendered document does not name the crawler — did the copy move?");
  await writeFile(`${OUT}/public/bot.html`, botHtml);

  const spec = publicApi.openApiDocument();
  if (Object.keys(spec.paths).length < 10) throw new Error(`openapi.json: only ${Object.keys(spec.paths).length} paths described`);
  await writeFile(`${OUT}/public${publicApi.OPENAPI_PATH}`, `${JSON.stringify(spec, null, 2)}\n`);

  const trustSizes: string[] = [];
  for (const [name, render, marker] of [
    ["about", trust.renderAboutPage, "Archetype"],
    ["contact", trust.renderContactPage, trust.CONTACT_EMAIL],
    ["privacy", trust.renderPrivacyPage, "serendipity-uid"],
    ["developers", trust.renderDevelopersPage, "/openapi.json"],
  ] as const) {
    const pageHtml = await render().text();
    if (!pageHtml.includes(marker)) throw new Error(`${name} page: rendered document does not mention ${marker} — did the copy move?`);
    await writeFile(`${OUT}/public/${name}.html`, pageHtml);
    trustSizes.push(`${name}.html ${pageHtml.length}B`);
  }

  console.log(`pages(gen): photos.html ${photosHtml.length}B (${photos.curatedPool(pool).length} tiles), ${albumSizes.join(", ")}${albumSizes.length ? ", " : ""}bot.html ${botHtml.length}B, ${trustSizes.join(", ")}, sitemap-images.xml ${imageCount} images`);
}

phase("1f updates + restore");
{
  const nonce = `?build=${BUILD_NONCE}`;
  const updates = await import(pathToFileURL(resolve(OUT, "src/worker/updates.ts")).href + nonce);
  const points = JSON.parse(await readFile(`${OUT}/src/worker/checkpoints.json`, "utf8"));
  if (!points.length) throw new Error("updates/restore: the checkpoint projection is empty — both pages would ship with no log");
  const cp = { points, state: "ok" };

  const updatesHtml = await (await updates.renderWindowsUpdate(cp)).text();
  if (!updatesHtml.includes("wu-tag")) throw new Error("updates page: no changelog rows rendered — did the markup move?");
  await writeFile(`${OUT}/public/updates.html`, updatesHtml);

  const restoreHtml = await (await updates.renderSystemRestore(cp)).text();
  if (!restoreHtml.includes("srList")) throw new Error("restore page: no restore-point stage rendered — did the markup move?");
  await writeFile(`${OUT}/public/restore.html`, restoreHtml);

  console.log(`pages(gen): updates.html ${updatesHtml.length}B, restore.html ${restoreHtml.length}B (${points.length} checkpoints, newest ${points[points.length - 1].version})`);
}

phase("1g markdown twins");
let twinFiles;
let dressPage: (html: string, rel: string) => { html: string; addedLink: boolean; addedChrome: boolean } =
  () => { throw new Error("explorer: dressPage used before 1g2 defined it"); };
{
  const { agentSurfacesWithoutTwin, buildTwins, checkTwinFacts, readManifest } = await import("./gen-md-twins.ts");
  const drift = checkTwinFacts(".");
  if (drift.length) {
    throw new Error("md twins: a hand-authored twin disagrees with the Worker that renders its page:\n  - " + drift.join("\n  - "));
  }
  const { files, skipped, generated, committed } = buildTwins(".", { generatedRoot: OUT });
  const untwinned = agentSurfacesWithoutTwin(readManifest(".").surfaces, [...files.keys(), ...committed]);
  if (untwinned.length) {
    throw new Error(`md twins: agents:true surfaces with no Markdown twin: ${untwinned.join(", ")}. Give each a hand twin in src/content/md/ (a page baked after this step cannot be generated), declare the representation its route serves with mimeType, or drop flags.agents`);
  }
  twinFiles = files;
  await Promise.all([...files].map(async ([rel, body]) => {
    const dest = `${OUT}/public${rel}`;
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await writeFile(dest, body);
  }));
  const twins = [...files.keys()].filter((k) => k.endsWith(".md")).length;
  const indexes = [...files.keys()].filter((k) => k.endsWith("llms.txt")).length;
  if (twins < 30) throw new Error(`md twins: generated only ${twins} twins (expected 30+) — did site-manifest.json or the page shape change?`);
  if (!generated.length) throw new Error("md twins: no twin came from the generated tier — did the twin step move back above the deploy-time page renders?");
  console.log(`md twins: ${twins} pages + ${indexes} section indexes staged (${generated.length} from generated HTML: ${generated.join(", ")}; ${skipped.length} Worker-rendered surfaces carry no prose source)`);
}

{
  const { PLACES, addressBar, taskPane, taskRow } = await import("../src/worker/lib/explorer.ts");
  const { paneOffersTwin } = await import("./lib/twin-links.ts");

  const manifest = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
  const pinned = manifest.surfaces.filter((s) => s.flags && s.flags.taskbar).map((s) => s.path).sort();
  const declared = PLACES.map((p) => p.path).sort();
  if (pinned.join(",") !== declared.join(",")) {
    throw new Error(`explorer: lib/explorer.js PLACES disagrees with site-manifest.json taskbar surfaces\n  manifest: ${pinned.join(" ")}\n  explorer: ${declared.join(" ")}`);
  }

  const twinPaths = [...twinFiles.keys()]
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => (rel === "/index.md" ? "/" : rel.slice(0, -3)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  {
    const target = `${OUT}/src/worker/lib/twins.ts`;
    const source = await readFile(target, "utf8");
    const marker = /^export const TWIN_PATHS = .*; \/\/ build:twins$/m;
    if (!marker.test(source)) throw new Error("explorer: build:twins marker missing from lib/twins.js");
    await writeFile(target, source.replace(marker, `export const TWIN_PATHS = ${JSON.stringify(twinPaths)}; // build:twins`));
  }

  const nameOf = (html) => {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (!h1) return "";
    return h1[1]
      .replace(/<span\b[^>]*\bclass="[^"]*\bstatus\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((f) => f.endsWith(".html") && !f.endsWith('.src.html') && !/^(i|images|og|cars|a)\//.test(f))
    .filter((f) => f !== "index.html");

  dressPage = (html, rel) => {
    const route = "/" + rel.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, "");
    const normalized = route === "/" ? "/" : route.replace(/\/+$/, "");
    const twin = twinPaths.includes(normalized)
      ? (normalized === "/" ? "/index.md" : `${normalized}.md`)
      : null;

    const details = [];
    if (rel.endsWith('/index.html') || !rel.includes("/")) {
      const shelf = /<ul\b[^>]*class="[^"]*\bshelf\b[^"]*"[\s\S]*?<\/ul>/.exec(html);
      const items = shelf ? (shelf[0].match(/<li\b/g) || []).length : 0;
      if (items) details.push({ term: "Contains", value: `${items} experiments` });
    }

    const options = {
      path: normalized,
      name: nameOf(html),
      tasks: twin ? [{ href: twin, label: "Read this as Markdown" }] : [],
      details,
    };

    let out = html, addedLink = false;
    if (twin && !/rel="alternate"[^>]*text\/markdown/.test(out)) {
      const tag = `<link rel="alternate" type="text/markdown" title="markdown source" href="${twin}">`;
      const before = out;
      out = /<link rel="canonical"[^>]*>/i.test(out)
        ? out.replace(/(<link rel="canonical"[^>]*>)/i, `$1\n${tag}`)
        : out.replace(/<\/head>/i, `${tag}\n</head>`);
      if (out === before) throw new Error(`explorer: ${rel} has a twin but no <link rel=canonical> and no </head> to anchor the alternate link to`);
      addedLink = true;
    }

    let addedChrome = false;
    if (!out.includes('class="axp-tasks"')) {
      const contentOpen = /<div class="content(?: [^"]*)?"[^>]*>/.exec(out);
      if (contentOpen) {
        out = out.slice(0, contentOpen.index)
          + String(addressBar(options))
          + String(taskPane(options))
          + out.slice(contentOpen.index);
        addedChrome = true;
      }
    } else if (twin && paneOffersTwin(out, twin) === false) {
      const group = /<section class="axp-group"><h2>Object tasks<\/h2><ul>/.exec(out);
      if (!group) throw new Error(`explorer: ${rel} has a pane with no "Object tasks" group to add its Markdown twin to`);
      const at = group.index + group[0].length;
      out = out.slice(0, at) + String(taskRow({ href: twin, label: "Read this as Markdown", glyph: "≡" })) + out.slice(at);
    }
    out = foldLongProse(out);
    return { html: out, addedLink, addedChrome };
  };

  const outcomes = await Promise.all(pages.map(async (rel) => {
    const file = `${OUT}/public/${rel}`;
    const html = await readFile(file, "utf8");
    const hasChrome = html.includes('class="axp-tasks"');
    const windowed = /<div class="content(?: [^"]*)?"[^>]*>/.test(html) && /<div class="window"/.test(html);
    if (!hasChrome && !windowed) return null;
    const result = dressPage(html, rel);
    await writeFile(file, result.html);
    return result;
  }));
  const dressed = outcomes.filter((result) => result?.addedChrome).length;
  const linked = outcomes.filter((result) => result?.addedLink).length;

  if (dressed < 30) throw new Error(`explorer: dressed only ${dressed} staged pages (expected 30+) — did the .window/.content shape change?`);
  if (linked < 30) throw new Error(`explorer: linked only ${linked} pages to a Markdown twin (expected 30+) — is the canonical link still in <head>?`);
  console.log(`explorer chrome: address bar + task pane on ${dressed} staged pages; ${linked} advertise a Markdown twin; ${twinPaths.length} twin paths handed to the Worker`);
}

// Build output on the twins' argument, and it reads the twins 1g just wrote
// rather than re-extracting anything, so each explainer here is byte-for-byte
// what its `.md` URL serves. The Worker used to assemble the writing half per
// request, one ASSETS lookup per post; inlining 39 explainers that way would
// spend most of Workers Free's 50-subrequest ceiling (gotcha 36) on one route.
// Staged at the path the route shadows: /llms-full.txt is run_worker_first, so
// the x402 handler is the only door to it.
{
  const { renderLlmsFull, WRITING_HEADING } = await import("../src/worker/lib/llms-full.ts");
  const { INDEXED_SECTIONS, readManifest, twinPath } = await import("./gen-md-twins.ts");
  const map = await readFile(`${OUT}/public/llms.txt`, "utf8");
  const posts = JSON.parse(await readFile(`${OUT}/public/writing/posts.json`, "utf8"));
  const writing = await Promise.all(posts.map(async (p) => ({
    title: p.title, date: p.date, path: `/writing/${p.slug}.txt`,
    body: await readFile(`${OUT}/public/writing/${p.slug}.txt`, "utf8"),
  })));
  if (!writing.length) throw new Error("llms-full: posts.json staged no writing posts");

  const manifest = readManifest(".");
  const sections = [{ heading: WRITING_HEADING, docs: writing }];
  const counts: string[] = [];
  for (const section of INDEXED_SECTIONS) {
    const own = manifest.surfaces.filter((s) => s.section === section);
    const head = own.find((s) => s.kind === "section") || own[0];
    const docs = [head, ...own.filter((s) => s !== head)].flatMap((s) => {
      const body = twinFiles.get(twinPath(s.path));
      return body ? [{ title: s.title, path: twinPath(s.path), body }] : [];
    });
    if (docs.length < 10) throw new Error(`llms-full: only ${docs.length} ${section} twins to inline (expected 10+) — did step 1g stop writing them?`);
    sections.push({ heading: `${head.title}: full text`, docs });
    counts.push(`${docs.length} ${section}`);
  }

  const body = renderLlmsFull(map, sections);
  await writeFile(`${OUT}/public/llms-full.txt`, body);
  twinHeadStart(body);
  console.log(`llms-full: ${writing.length} writing posts + ${counts.join(" + ")} explainers, ${Buffer.byteLength(body)} bytes`);
}

phase("5 worker css");
{
  const roots = [`${OUT}/src/worker`, `${OUT}/cal/src`, `${OUT}/serendipity`];
  const jsFiles = (await Promise.all(roots.map(async (dir) =>
    (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js") || f.endsWith(".ts")).map((rel) => `${dir}/${rel}`),
  ))).flat();
  let litCount = 0, saved = 0, fileCount = 0;
  const perRoot = new Map<string, number>();
  for (const path of jsFiles) {
    const rel = path.slice(OUT.length + 1);
    const src = await readFile(path, "utf8");
    const { out, literals } = spliceMinLiterals(rel, src, (css) => minifyCss(rel, css));
    if (!literals.length) continue;
    const root = roots.find((r) => path.startsWith(r + "/"))!;
    perRoot.set(root, (perRoot.get(root) ?? 0) + literals.length);
    litCount += literals.length;
    for (const l of literals) saved += l.source.length - l.spliced.length;
    const parsed = minifySync(rel, out, {
      module: false,
      compress: false,
      mangle: false,
      codegen: { removeWhitespace: false, legalComments: "inline" },
    });
    if (parsed.errors.length) {
      throw new Error(`${rel}: minifying CSS broke JS parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    await writeFile(path, out);
    fileCount++;
  }
  const FLOORS = { [`${OUT}/src/worker`]: 19, [`${OUT}/cal/src`]: 3, [`${OUT}/serendipity`]: 1 };
  for (const [root, floor] of Object.entries(FLOORS)) {
    const found = perRoot.get(root) ?? 0;
    if (found < floor) throw new Error(`worker CSS: found only ${found} /*min*/ literals under ${root.slice(OUT.length + 1)} (expected ${floor}+) — did the sentinel change, or did the walk stop reaching that tree?`);
  }
  console.log(`worker CSS: minified ${litCount} /*min*/ literals across ${fileCount} modules, ~${(saved / 1024).toFixed(1)}KB raw saved`);
}

const BAKED = `${OUT}/baked`;
const bake = new Promise<{ code: number | null; log: string }>((resolve) => {
  const child = spawn(process.execPath, ["tools/bake-worker-pages.ts", OUT, BAKED], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  child.once("error", (e) => resolve({ code: -1, log: log + String(e) }));
  child.once("close", (code) => resolve({ code, log }));
});

phase("1h feeds");
{
  const { buildFeeds, FEEDS } = await import("./gen-feeds.ts");
  const feeds = buildFeeds(".");
  if (feeds.size !== FEEDS.length) {
    throw new Error(`feeds: generated ${feeds.size} of ${FEEDS.length} declared feeds`);
  }
  let items = 0;
  for (const [route, body] of feeds) {
    const count = (body.match(/<item>/g) || []).length;
    if (!count) throw new Error(`feeds: ${route} has no items — did the manifest sections or sitemap lastmod dates change shape?`);
    items += count;
    const dest = `${OUT}/public${route}`;
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await writeFile(dest, body);
  }
  console.log(`feeds: ${feeds.size} RSS feeds, ${items} items total`);
}


phase("1i search index");
{
  const { buildSearchIndex } = await import("./generate-search-index.ts");
  const index = await buildSearchIndex(".");
  if (index.records.length < 50) {
    throw new Error(`search index: only ${index.records.length} records (expected 50+) — did a ROOTS directory move, or site-manifest.json change shape?`);
  }
  const manual = index.records.filter((r) => r.kind === "utility").length;
  if (!manual) throw new Error("search index: no manifest-injected records — is site-manifest.json readable and are any surfaces still flagged searchIndex?");
  const searchIndex = JSON.stringify(index);
  await writeFile(`${OUT}/public/search-index.json`, searchIndex);
  twinHeadStart(searchIndex);
  console.log(`search index: ${index.records.length} records staged (${manual} from the surface registry)`);
}


{
  const { articleLd, articleLdScript, injectArticleLd } = await import("./lib/article-ld.ts");
  const { sitemapDates } = await import("./gen-feeds.ts");
  const dates = sitemapDates(await readFile("public/sitemap.xml", "utf8"));
  const { surfaces } = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
  const articles = surfaces.filter((s) => s.kind === "content" && /^\/(garage|lwe)\//.test(s.path));
  let written = 0;
  for (const surface of articles) {
    const file = `${OUT}/public${surface.path}.html`;
    if (!existsSync(file)) continue;
    const html = await readFile(file, "utf8");
    const ld = articleLd({ path: surface.path, section: surface.section, html, date: dates.get(surface.path) });
    const next = injectArticleLd(html, articleLdScript(ld));
    if (next !== html) { await writeFile(file, next); written++; }
  }
  if (written < 30) throw new Error(`article-ld: only ${written} of ${articles.length} Garage/LWE pages got an Article; expected 30 or more`);
  console.log(`article-ld: ${written} of ${articles.length} Garage/LWE pages carry a schema.org Article`);
}


phase("2 homepage");
{
  const authored = await readFile("src/pages/index.html", "utf8");
  const staged = await readFile(`${OUT}/public/index.html`, "utf8");
  const srcPath = "/index.src.html";
  const banner = `<!-- minified at deploy; readable source: ${srcPath} -->\n`;
  const inlineMinified = transformInlineHtmlBlocks(staged, "src/pages/index.html");
  const body = minifyHtml(inlineMinified);
  const min = banner + body;
  for (const [label, marker] of HTML_MARKERS) {
    if (!marker.test(min)) throw new Error("index.html: HTML minifier lost required marker " + label);
  }
  if (!/border:\s*6px solid (?:#ece9d8|var\(--face,#ece9d8\))/.test(min)) throw new Error("index.html: the minified homepage lost the injected client edge");
  await writeFile(`${OUT}/public/${srcPath.slice(1)}`, authored);
  await writeFile(`${OUT}/public/index.html`, min);
  console.log(`index.html: ${staged.length} -> ${min.length} bytes (+ ${srcPath}, byte-identical to source; inline JS/CSS use existing minifiers)`);
}


phase("3 shells");
for (const { file, twin: srcPath, marker, module } of minifiedScripts()) {
  const src = await readFile(`src/client/${file}`, "utf8");
  await writeFile(`${OUT}/public/${srcPath.slice(1)}`, src);

  const code = module
    ? minifyJavaScript(`src/client/${file}`, src, { ...OXC_MINIFY_OPTIONS, module: true, mangle: { toplevel: true } })
    : minifyJavaScript(`src/client/${file}`, src);
  const banner = `/*! minified at deploy - readable source: ${srcPath} */\n`;
  const min = banner + code;

  if (marker && !min.includes(marker)) {
    throw new Error(`${file}: minified output lost the "${marker}" marker`);
  }

  await writeFile(`${OUT}/public/${file}`, min);
  console.log(`${file}: ${src.length} -> ${min.length} bytes (+ ${srcPath})`);
}

phase("4 luna.css");
for (const file of minifiedStyles()) {
  const twin = file.replace(".css", ".src.css");
  const src = await readFile(`src/styles/${file}`, "utf8");
  await writeFile(`${OUT}/public/${twin}`, src);
  const code = minifyCss(`src/styles/${file}`, src);
  const out = `/*! minified at deploy - readable source: /${twin} */\n` + code;
  await writeFile(`${OUT}/public/${file}`, out);
  console.log(`${file}: ${src.length} -> ${out.length} bytes (+ /${twin})`);
}

phase("5b rendered pages");
{
  const baked = await bake;
  if (baked.log) process.stdout.write(baked.log);
  if (baked.code !== 0) throw new Error(`static renders: tools/bake-worker-pages.ts exited ${baked.code}`);
  for (const rel of await readdir(BAKED, { recursive: true })) {
    const from = `${BAKED}/${rel}`;
    if ((await stat(from)).isDirectory()) continue;
    await mkdir(resolve(OUT, "public", rel, ".."), { recursive: true });
    await rename(from, `${OUT}/public/${rel}`);
  }
  await rm(BAKED, { recursive: true, force: true });
  {
    const manifest: { surfaces: { path: string }[] } = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
    const ledger: Record<string, string> = JSON.parse(await readFile("config/per-request-pages.json", "utf8")).pages ?? {};
    const surfaces = new Set<string>(manifest.surfaces.map((s) => s.path));
    if (surfaces.size < 60) throw new Error(`per-request ratchet read only ${surfaces.size} registered surfaces — the scanner has lost the registry`);
    const built = (p: string) => existsSync(`${OUT}/public${p === "/" ? "/index" : p}.html`) || existsSync(`${OUT}/public${p}/index.html`);
    const problems: string[] = [];
    for (const p of surfaces) {
      if (!built(p) && !(p in ledger)) problems.push(`${p} is rendered per request: build it at deploy (lib/island.ts), or add it to config/per-request-pages.json with the reason it cannot be`);
    }
    for (const [p, why] of Object.entries(ledger)) {
      if (!surfaces.has(p)) problems.push(`${p} is in config/per-request-pages.json but is not a registered surface`);
      else if (built(p)) problems.push(`${p} is built now: remove it from config/per-request-pages.json`);
      if (String(why ?? "").trim().length < 20) problems.push(`${p} needs a reason in config/per-request-pages.json, not ${JSON.stringify(why)}`);
    }
    if (problems.length) throw new Error(`per-request ratchet:\n  ${problems.join("\n  ")}`);
    console.log(`per-request ratchet: ${surfaces.size - Object.keys(ledger).length} of ${surfaces.size} registered surfaces are built documents; ${Object.keys(ledger).length} stay per request, each with a reason`);
  }
  {
    const { routeOf, twinLinkProblems } = await import("./lib/twin-links.ts");
    const twinRoutes = [...twinFiles.keys()]
      .filter((rel) => rel.endsWith(".md"))
      .map((rel) => (rel === "/index.md" ? "/" : rel.slice(0, -3)));
    const staged = await readFile(`${OUT}/src/worker/lib/twins.ts`, "utf8");
    const listed = new Set<string>(JSON.parse(/^export const TWIN_PATHS = (.*); \/\/ build:twins$/m.exec(staged)?.[1] ?? "[]"));
    if (listed.size !== twinRoutes.length || twinRoutes.some((route) => !listed.has(route))) {
      throw new Error("twin links: the staged lib/twins.ts TWIN_PATHS disagrees with the twins 1g wrote");
    }
    const pages = await Promise.all((await readdir(`${OUT}/public`, { recursive: true }))
      .filter((f) => f.endsWith(".html") && !f.endsWith(".src.html") && !/^(i|images|og|cars|a)\//.test(f))
      .map(async (rel) => ({ rel, html: await readFile(`${OUT}/public/${rel}`, "utf8") })));
    const problems = twinLinkProblems(pages, twinRoutes);
    if (problems.length) throw new Error(`twin links: ${problems.length} page(s) do not advertise the Markdown twin the build wrote:\n  ${problems.join("\n  ")}`);
    const covered = pages.filter((p) => twinRoutes.includes(routeOf(p.rel))).length;
    if (covered < 30) throw new Error(`twin links: only ${covered} staged pages have a twin (expected 30+); did the walk or the twin set come back empty?`);
    console.log(`twin links: all ${covered} staged pages with a Markdown twin advertise it`);
  }
}

// The staged files step 6 content-hashes into /a/ that step 5c ranks as the
// SHELL. The registry declares each hashed asset shell-scoped or page-scoped;
// the page-scoped ones (the /serendipity island, the LWE ask widget, the
// vendored pretext library, the /dotfiles checklist, the /pixel-peeper trial
// manifest, quiz.css) are hashed like the shell and RANKED like pages. The shell tier orders names by their
// uses inside the shell alone, so a page-scoped file in that set would let an
// edit to ask.js (which reads three --font-* tokens) reorder luna.css's short
// names and re-mint every page (gotcha 35).
const SHELL_RANKED = shellRankedFiles();

phase("5c custom properties");
// The names come in two tiers (planNames has the argument): a name a hashed
// shell file defines is ranked by the shell's own uses, and everything else is
// placed by a hash of its name. So an edit to one page's CSS cannot rename a
// token inside luna.css and re-mint every page (gotcha 35), which one site-wide
// ranking did on 2026-09-24. Comments in page CSS are still unminified here and
// still count as uses, which no longer matters: no tier reads a page's counts.
{
  const { RESERVED, planNames, applyMangle, assertIntegrity, assertNoDynamicPropertyNames, pruneUnread, unresolved } = await import(
    "./lib/mangle-custom-properties.ts"
  );

  const staged = (await readdir(OUT, { recursive: true }))
    .filter((f) => /\.(css|html|js|ts|mjs)$/.test(f))
    .filter((f) => !/\.src\.(css|html|js)$/.test(f))
    .filter((f) => !f.startsWith("src/dict/"));

  const texts = await Promise.all(staged.map(async (rel) => {
    const full = `${OUT}/${rel}`;
    return (await stat(full)).isFile() ? readFile(full, "utf8") : null;
  }));
  const staged0 = new Map<string, string>();
  staged.forEach((rel, i) => { const text = texts[i]; if (text !== null) staged0.set(rel, text); });

  assertNoDynamicPropertyNames(staged0);

  const pruned = pruneUnread(staged0, (rel) => rel.endsWith(".css"));
  const before = pruned.files;
  const danglingAt = (files: Map<string, string>) => [...unresolved(files)].sort().join(" ");
  if (danglingAt(staged0) !== danglingAt(before)) throw new Error("mangle: pruning unread definitions changed the dangling var() set");

  const map = planNames(before, SHELL_RANKED);
  const after = new Map<string, string>();
  for (const [rel, text] of before) after.set(rel, applyMangle(text, map));

  assertIntegrity(before, after, map, 80);

  const changed = [...after].filter(([rel, text]) => text !== staged0.get(rel));
  await Promise.all(changed.map(([rel, text]) => writeFile(`${OUT}/${rel}`, text)));
  const touched = changed.length;
  console.log(`custom properties: ${pruned.dropped.length} unread definitions dropped, ${map.size} renamed across ${touched} staged files (${RESERVED.size} reserved for the DOM calls that name them)`);
}

phase("5d quiz data");
{
  const { extractQuizData, quizReference } = await import("./lib/quiz-data.ts");
  const hash8q = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  await mkdir(`${OUT}/public/a`, { recursive: true });

  const sources = (await readdir("src/pages", { recursive: true }) as string[]).filter((rel) => rel.endsWith(".html"));
  const authored = new Set<string>();
  await Promise.all(sources.map(async (rel) => {
    if (/\bid="luq-data"/.test(await readFile(`src/pages/${rel}`, "utf8"))) authored.add(rel);
  }));

  const staged = (await readdir(`${OUT}/public`, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && !rel.startsWith("a/"))
    .sort();
  let files = 0, bytesOut = 0;
  const extracted = new Set<string>();
  for (const rel of staged) {
    const html = await readFile(`${OUT}/public/${rel}`, "utf8");
    const out = extractQuizData(html, rel, hash8q);
    if (!out) continue;
    await writeFile(`${OUT}/public${out.file.url}`, out.file.bytes);
    await writeFile(`${OUT}/public/${rel}`, out.html);
    const ref = quizReference(out.html);
    if (!ref || ref.inline !== "" || ref.src !== out.file.url) throw new Error(`${rel}: the luq-data element did not come back as an empty reference to ${out.file.url}`);
    extracted.add(rel);
    files++;
    bytesOut += out.file.bytes.length;
  }
  const missing = [...authored].filter((rel) => !extracted.has(rel));
  if (missing.length) throw new Error(`quiz data: ${missing.length} page(s) carry a quiz in src/pages but none was extracted from the staged copy: ${missing.join(", ")}`);
  if (files < 30) throw new Error(`quiz data: only ${files} payloads extracted (expected 30+); did the luq-data shape change?`);
  console.log(`quiz data: ${files} payloads moved to /a/quiz-*.json (${(bytesOut / 1024).toFixed(1)} KiB raw)`);
}

phase("5e build info");
{
  const { buildInfoFromEnv, bakeBuildInfo } = await import("./lib/build-info.ts");
  const info = buildInfoFromEnv(process.env);
  const p = `${OUT}/src/worker/lib/build-info.ts`;
  await writeFile(p, bakeBuildInfo(await readFile(p, "utf8"), info));
  console.log(info ? `build-info: ${info.commit.slice(0, 12)} on ${info.branch ?? "?"}` : "build-info: not a Workers Builds build, BUILD_INFO stays null");
}

let freshFamily: Buffer | null = null;

phase("6 hash shell assets");
{
  const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const { urls: hashedFor, filesTouched } = await hashClientAssets(OUT, { log: console.log });

  // RFC 9842 requires dcz to treat the supplied bytes as a RAW dictionary. A zstd
  // --train artifact is self-describing, so a server library recognizes its tables
  // while Chrome treats those same response bytes as raw content; the decoders
  // disagree and the navigation fails. Build one site-wide corpus from the final,
  // repointed bytes of two complementary pages: the compact LWE shell plus the
  // Garage compression explainer, with 4 KB of vigenere filling the window.
  {
    const BASE_CORPUS = [
      "lwe/drivers.html",
      "garage/compression.html",
      "lwe/vigenere.html",
      "garage/chunks.html",
    ];
    const SIZE = 65_536;
    const parts = [];
    let total = 0;
    for (const rel of BASE_CORPUS) {
      const staged = await readFile(`${OUT}/public/${rel}`, "utf8");
      const bytes = Buffer.from(minifiedPage(staged, rel));
      parts.push(bytes);
      total += bytes.length;
      if (total >= SIZE) break;
    }
    if (total < SIZE) {
      throw new Error(
        `page-family dictionary: the corpus pages total ${total} B, ${SIZE - total} B short of the ${SIZE} B dictionary. ` +
        `Add another staged page to BASE_CORPUS in build.ts (order is load-bearing; append, do not reorder).`,
      );
    }
    const dictionary = Buffer.concat(parts).subarray(0, SIZE);
    if (dictionary.readUInt32LE(0) === 0xec30a437) {
      throw new Error("page-family dictionary starts with the zstd --train magic — dcz needs RAW bytes, not a trained dictionary");
    }
    freshFamily = dictionary;
    console.log(`site-page corpus: fresh candidate ${hash8(dictionary)} (${dictionary.length} raw bytes); step 8 chooses between it and ${FAMILY_DICT_DIR}`);
  }

  {
    const p = `${OUT}/src/worker/lib/shell-assets.ts`;
    const src = await readFile(p, "utf8");
    const line = `export const SHELL_ASSETS = { luna: ${JSON.stringify(hashedFor["luna.css"])}, nav: ${JSON.stringify(hashedFor["nav.js"])} }; // build:shell-assets`;
    const shellPatched = src.replace(/^export const SHELL_ASSETS = .*\/\/ build:shell-assets$/m, line);
    if (shellPatched === src) throw new Error("shell-assets.js: the `// build:shell-assets` marker line was not found — did the export shape change?");
    await writeFile(p, shellPatched);
    console.log(`shell-assets: Early-Hints -> ${hashedFor["luna.css"]} + ${hashedFor["nav.js"]}`);
  }

  {
    const { speculationRulesJson } = await import("./photos/gen-desktop-partial.ts");
    const bytes = Buffer.from(speculationRulesJson());
    const url = `/a/speculation.${hash8(bytes)}.json`;
    await writeFile(`${OUT}/public${url}`, bytes);
    const p = `${OUT}/src/worker/lib/shell-assets.ts`;
    const src = await readFile(p, "utf8");
    const out = src.replace(
      /^export const SPECULATION_RULES: string = .*\/\/ build:speculation-rules$/m,
      `export const SPECULATION_RULES: string = ${JSON.stringify(url)}; // build:speculation-rules`,
    );
    if (out === src) throw new Error("shell-assets.ts: the `// build:speculation-rules` marker line was not found");
    await writeFile(p, out);
    console.log(`speculation rules: ${url} (${bytes.length} bytes), sent as a Speculation-Rules header`);
  }

  {
    const files = (await readdir(`${OUT}/public/a`)).filter((f) => !f.endsWith(".br") && !f.endsWith(".dict"));
    const map: Record<string, string> = {};
    for (const f of files) {
      const m = /^(.+)\.([0-9a-f]{8})\.([a-z0-9]+)$/.exec(f);
      if (!m) continue;
      const key = `${m[1]}.${m[3]}`;
      if (map[key]) throw new Error(`hashed-assets: two hashes of ${key} in /a/ (${map[key]}, /a/${f}); a stale name cannot know which is current`);
      map[key] = `/a/${f}`;
    }
    if (Object.keys(map).length < 40) throw new Error(`hashed-assets: only ${Object.keys(map).length} hashed files in /a/; the walk or the name pattern broke`);
    const p = `${OUT}/src/worker/lib/shell-assets.ts`;
    const src = await readFile(p, "utf8");
    const out = src.replace(
      /^export const HASHED_ASSETS: Record<string, string> = .*\/\/ build:hashed-assets$/m,
      `export const HASHED_ASSETS: Record<string, string> = ${JSON.stringify(map)}; // build:hashed-assets`,
    );
    if (out === src) throw new Error("shell-assets.ts: the `// build:hashed-assets` marker line was not found");
    await writeFile(p, out);
    console.log(`hashed assets: ${Object.keys(map).length} names mapped to their current /a/ URL`);
  }

  {
    const p = `${OUT}/public/_headers`;
    const src = await readFile(p, "utf8");
    const out = src
      .split("</luna.css>").join(`<${hashedFor["luna.css"]}>`)
      .split("</nav.js>").join(`<${hashedFor["nav.js"]}>`)
      .split("</lwe-base.css>").join(`<${hashedFor["lwe-base.css"]}>`);
    if (out === src) throw new Error("_headers: no shell Link target found to hash — did the Early-Hints rule move?");
    await writeFile(p, out);
    console.log(`_headers: Early-Hints Link rewritten to hashed shell URLs`);
  }

  console.log(`hashed assets: ${Object.keys(hashedFor).length} repointed across ${filesTouched} staged files, every declared loader witnessed`);
}

phase("7 shell q11 + deltas");
{
  const dir = `${OUT}/public/a`;
  const files = (await readdir(dir)).filter((f) => /\.(js|css|svg|json|dict)$/.test(f));
  if (!files.length) throw new Error("precompression found no /a/ shell assets — did step 6 stop emitting them?");
  let raw = 0, enc = 0;
  const compressed = await Promise.all(files.map(async (f) => {
    const bytes = await readFile(`${dir}/${f}`);
    return { f, bytes, out: await brotliQ11(bytes) };
  }));
  const writes = await Promise.all(compressed.map(async ({ f, bytes, out }) => {
    if (out.length >= bytes.length) {
      return { f, bytes, out, written: false };
    }
    await writeFile(`${dir}/${f}.br`, out);
    return { f, bytes, out, written: true };
  }));
  for (const { f, bytes, out, written } of writes) {
    if (!written) {
      console.log(`precompress: SKIPPED /a/${f} (br ${out.length} >= raw ${bytes.length})`);
    } else {
      raw += bytes.length; enc += out.length;
      console.log(`precompressed: /a/${f} ${bytes.length} -> ${out.length} bytes (br q11)`);
    }
  }
  console.log(`precompress: ${(raw / 1024).toFixed(1)}KB -> ${(enc / 1024).toFixed(1)}KB brotli q11 across ${files.length} shell assets`);

  // This used to be a workstation script with committed artifacts, on the belief that
  // dictionary compression was unreachable from Node. That was true of BROTLI AT THE TIME and I
  // wrongly generalized it: node:zlib's zstd DOES take a `dictionary` option. (node 26 has since
  // given brotli one too, nodejs/node#61763, which retires the limit rather than the choice —
  // dcz won on decode speed, not on either encoder's availability. See gotcha 14.) It is also better
  // than shelling out — 116 bytes where the zstd CLI produced 120 — and portable, verified
  // by having the foreign `zstd -d -D` CLI decode Node's bytes byte-exact, skippable prefix
  // and all. That interop check is the one that matters, because the real decoder is a
  // browser, not Node.
  {
    const ZSTD_DICTIONARY_NODE_FLOOR = 24;

    const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
    const withDict = zstdCompressSync(probe, { dictionary: probe, params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    const noDict = zstdCompressSync(probe, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    if (withDict.length >= noDict.length * 0.5) {
      throw new Error(
        `zstd dictionary compression is not honored by ${process.version} ` +
        `(probe: ${withDict.length} bytes with a dictionary vs ${noDict.length} without; expected a collapse). ` +
        `Node ${ZSTD_DICTIONARY_NODE_FLOOR}+ is required for the dictionary option; see .node-version. ` +
        `Shell deltas would silently ship as no-ops.`,
      );
    }

    const dictDir = "src/dict/a-dict";
    const dicts = await readdir(dictDir).catch(() => []);
    const shell = files.map(parseShellAsset).filter(Boolean);
    const cands = dicts.map(parseShellAsset).filter(Boolean);
    if (cands.length) await mkdir(`${OUT}/public/ad`, { recursive: true });
    let n = 0, deltaBytes = 0;
    for (const asset of shell) {
      const targetBytes = await readFile(`${dir}/${asset.name}`);
      for (const d of cands) {
        if (d.base !== asset.base || d.ext !== asset.ext) continue;
        const dictBytes = await readFile(`${dictDir}/${d.name}`);
        if (dictBytes.equals(targetBytes)) continue;

        const { out, tag } = dczEncode(targetBytes, dictBytes);

        const plainTwin = (await readFile(`${dir}/${asset.name}.br`).catch(() => null))?.length ?? Infinity;
        if (out.length >= plainTwin) {
          console.log(`delta: SKIPPED ${asset.name} vs ${d.hash8} (dcz ${out.length} >= br ${plainTwin})`);
          continue;
        }
        const deltaName = shellDeltaName(asset, tag);
        await writeFile(`${OUT}/public/ad/${deltaName}`, out);
        n++; deltaBytes += out.length;
        console.log(`delta: /ad/${deltaName} ${out.length} bytes (vs ${plainTwin} plain br)`);
      }
    }
    const changed = shell.some((a) => cands.some((d) => d.base === a.base && d.ext === a.ext && d.hash8 !== a.hash8));
    if (n) console.log(`delta: ${n} dcz delta(s), ${deltaBytes} bytes total`);
    else if (changed) console.log("delta: WARNING the shell changed but every candidate lost to plain brotli — dictionary compression may not be working");
    else console.log("delta: none needed (every dictionary candidate matches the shipping shell)");
  }

}

phase("7b minify pages");
{
  const { PAGE_MARKERS } = await import("./lib/html-markers.ts");
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && rel !== "index.html")
    .sort();

  const { quizReference } = await import("./lib/quiz-data.ts");

  let before = 0, after = 0, checked = 0, generated = 0;
  await Promise.all(pages.map(async (rel) => {
    const staged = await readFile(`${OUT}/public/${rel}`, "utf8");
    const twinRel = rel.replace(/\.html$/, ".src.html");
    const min = minifiedPage(staged, rel);

    for (const [label, marker] of PAGE_MARKERS) {
      if (marker.test(staged) && !marker.test(min)) {
        throw new Error(`${rel}: HTML minifier lost required marker ${label}`);
      }
    }
    const authored = quizReference(staged);
    if (authored) {
      const shipped = quizReference(min);
      if (!shipped) throw new Error(`${rel}: HTML minifier dropped the understanding-check element`);
      if (authored.inline.trim() || shipped.inline.trim()) {
        throw new Error(`${rel}: the understanding-check payload is still inline (step 5d should have moved it to /a/)`);
      }
      if (!authored.src || shipped.src !== authored.src) {
        throw new Error(`${rel}: HTML minifier altered the understanding-check reference (${authored.src} -> ${shipped.src})`);
      }
      checked++;
    }

    let twin = staged;
    try {
      twin = await readFile(`src/pages/${rel}`, "utf8");
      if (staged.includes('class="axp-tasks"') && !twin.includes('class="axp-tasks"')) {
        twin = dressPage(twin, rel).html;
      }
    } catch {
      generated++;
    }
    await writeFile(`${OUT}/public/${twinRel}`, twin);
    await writeFile(`${OUT}/public/${rel}`, min);
    before += staged.length;
    after += min.length;
  }));
  console.log(`pages(min): ${pages.length} documents ${before} -> ${after} bytes (${(((before - after) / before) * 100).toFixed(1)}% off raw), ${pages.length} .src.html twins (${generated} from staged, no authored source), ${checked} understanding-check references verified intact`);
}

phase("7b links");
{
  const { makeResolver, internalRefs } = await import("./lib/link-integrity.ts");

  const served = new Set<string>();
  for (const rel of await readdir(`${OUT}/public`, { recursive: true })) served.add("/" + rel);

  const wranglerSrc = await siteConfigText();
  const { EXACT_PATHS } = await import(pathToFileURL(resolve("src/worker/routes.ts")).href);
  const linkRouteKeys = new Set<string>(EXACT_PATHS);
  if (linkRouteKeys.size < 60) throw new Error(`link-integrity read only ${linkRouteKeys.size} exact routes from routes.ts — the list has lost its routes`);
  const surfaceList = JSON.parse(await readFile("config/site-manifest.json", "utf8")).surfaces;

  const resolves = makeResolver({
    files: served,
    routeKeys: linkRouteKeys,
    allow: runWorkerFirst(wranglerSrc).filter((a) => !a.startsWith("!")),
    surfaces: new Set(surfaceList.map((s) => s.path)),
  });

  const docs = [...served].filter((f) => f.endsWith(".html") && !f.endsWith(".src.html"));
  const dangling = new Map();
  let refs = 0;
  for (const doc of docs) {
    for (const path of await internalRefs(await readFile(`${OUT}/public${doc}`, "utf8"))) {
      refs++;
      if (resolves(path)) continue;
      if (!dangling.has(path)) dangling.set(path, new Set());
      dangling.get(path).add(doc);
    }
  }

  if (dangling.size) {
    const lines = [...dangling].slice(0, 12)
      .map(([p, from]) => `  ${p}  <- ${[...from].slice(0, 4).join(", ")}${from.size > 4 ? ` +${from.size - 4}` : ""}`);
    throw new Error(
      `link-integrity: ${dangling.size} internal reference(s) point at nothing this site serves:\n`
      + lines.join("\n")
      + (dangling.size > 12 ? `\n  … and ${dangling.size - 12} more` : "")
      + "\n  A moved or renamed page leaves its inbound links behind. Fix the href, or"
      + "\n  register the new path in config/site-manifest.json (bun run gen:manifest).",
    );
  }
  console.log(`links: ${refs} internal refs across ${docs.length} documents all resolve`);
}

phase("7b paths");
{
  const NAMES_A_FILE = /\.[A-Za-z0-9]{1,5}$/;
  const BINARY = /\.(br|dcz|dict|png|jpe?g|avif|webp|gif|pdf|woff2?|ico|mp4|zip|wasm)$/i;

  const ELSEWHERE = [/^src\/buttcrack\//];

  const cited = new Map<string, Set<string>>();
  let scanned = 0;
  const listed: string[] = [];
  for (const root of ["public", "src"]) {
    for (const rel of await readdir(`${OUT}/${root}`, { recursive: true })) {
      if (!BINARY.test(rel)) listed.push(`${root}/${rel}`);
    }
  }
  const bodies = await Promise.all(listed.map((file) => readFile(`${OUT}/${file}`, "utf8").catch(() => null)));
  for (const [i, file] of listed.entries()) {
    const body = bodies[i];
    if (body === null) continue;
    scanned++;
    for (const token of new Set(repoPathTokens(body))) {
      const path = token.replace(/[,;:)\]]+$/, "").replace(/\.$/, "");
      if (!NAMES_A_FILE.test(path)) continue;
      if (ELSEWHERE.some((r) => r.test(path))) continue;
      if (existsSync(path)) continue;
      if (!cited.has(path)) cited.set(path, new Set());
      cited.get(path)!.add(file);
    }
  }

  if (scanned < 300) throw new Error(`repo-paths: scanned only ${scanned} staged files, expected 300+ — did a walk stop reaching the staged tree?`);

  if (cited.size) {
    const lines = [...cited].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, from]) => `  ${p}  <- ${[...from].sort().slice(0, 4).join(", ")}${from.size > 4 ? ` +${from.size - 4}` : ""}`);
    throw new Error(
      `repo-paths: ${cited.size} repository path(s) named in served bytes do not exist:\n`
      + lines.join("\n")
      + "\n  A move is finished when the prose still says where things are, not when"
      + "\n  the build matches. Update the citation, or cite the new location.",
    );
  }
  console.log(`repo-paths: every repository path cited across ${scanned} staged files resolves`);
}

phase("7c csp");
{
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"))
    .sort();

  const pathOf = (asset) => {
    const p = "/" + asset.replace(/\.html$/, "");
    return p === "/index" ? "/" : p.endsWith("/index") ? p.slice(0, -6) : p;
  };

  const { scanDocument, requireParser } = await import("./lib/csp-scan.ts");
  requireParser();

  const map = {};
  const handlers: string[] = [];
  let blocks = 0;
  for (const page of pages) {
    const source = await readFile(`${OUT}/public/${page}`, "utf8");
    const found = await scanDocument(source, page);
    handlers.push(...found.handlers);
    map[pathOf(page)] = [...new Set(found.hashes)];
    blocks += found.hashes.length;
  }

  // Inline event handlers are the one thing a hash policy cannot express. Leaving
  // them would mean adding 'unsafe-hashes', which re-permits attribute execution
  // generally and gives back most of what dropping 'unsafe-inline' just bought. So
  // this is a hard stop with the exact sites named, not a warning.
  if (handlers.length) {
    console.error("csp-hash: inline event-handler attributes cannot be hashed. Refactor to addEventListener:");
    for (const h of handlers) console.error(`  ${h}`);
    throw new Error(`csp-hash: ${handlers.length} inline event-handler attribute(s) block the hashed policy`);
  }

  const covered = Object.keys(map).length;
  if (covered < 40) {
    throw new Error(`csp-hash: only ${covered} of ${pages.length} documents got hashes (floor is 40) — did an earlier HTML pass change shape?`);
  }

  const target = `${OUT}/src/worker/lib/csp-hashes.ts`;
  const source = await readFile(target, "utf8");
  const marker = /^export const PAGE_SCRIPT_HASHES = .*; \/\/ build:csp-hashes$/m;
  if (!marker.test(source)) throw new Error("csp-hash: build:csp-hashes marker missing from lib/csp-hashes.js");
  await writeFile(target, source.replace(
    marker,
    `export const PAGE_SCRIPT_HASHES = ${JSON.stringify(map)}; // build:csp-hashes`,
  ));

  const bytes = (Object.values(map) as string[][]).reduce((n, h) => n + h.length * 72, 0);
  console.log(`csp-hash: ${blocks} inline blocks across ${covered} documents, ${Object.values(map).flat().length} hashes (~${Math.round(bytes / covered)} B/page of header)`);
}

phase("8 page q11 + deltas");
{
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"));

  const dictDir = "src/dict/p-dict";
  const dicts = (await readdir(dictDir).catch(() => []));
  const pageDicts = dicts.map(parsePageSnapshot).filter(Boolean);

  let dCount = 0, dBytes = 0, dPlain = 0, pageCount = 0, pageBytes = 0, familyCount = 0, familyBytesOut = 0;
  const compressedPages = await Promise.all(pages.map(async (page) => {
    const bytes = await readFile(`${OUT}/public/${page}`);
    return { page, bytes, br: await brotliQ11(bytes) };
  }));

  if (!freshFamily) throw new Error("page-family: step 6 derived no fresh corpus, so there is nothing to choose from");
  const committedFamily = await readCommittedFamily();
  const family = await chooseFamilyDictionary({
    fresh: freshFamily,
    committed: committedFamily?.bytes ?? null,
    pages: compressedPages.map(({ bytes }) => bytes),
    encode: zstdBatch,
  });
  const dictionary = family.dictionary;
  const committedHash = committedFamily?.hash8 ?? null;
  const familyName = familyDictionaryName(hash8(dictionary));
  await writeFile(`${OUT}/public/a/${familyName}`, dictionary);
  const familyBr = await brotliQ11(dictionary);
  if (familyBr.length < dictionary.length) await writeFile(`${OUT}/public/a/${familyName}.br`, familyBr);
  {
    const p = `${OUT}/src/worker/lib/shell-assets.ts`;
    const src = await readFile(p, "utf8");
    const dictionaryLine = `export const PAGE_DICTIONARY: string = ${JSON.stringify(`/a/${familyName}`)}; // build:page-dictionary`;
    const out = src.replace(/^export const PAGE_DICTIONARY(: string)? = .*\/\/ build:page-dictionary$/m, dictionaryLine);
    if (out === src) throw new Error("shell-assets.js: the `// build:page-dictionary` marker line was not found");
    await writeFile(p, out);
  }
  await writeFile(FAMILY_FRESH, freshFamily);
  await writeFile(FAMILY_REPORT, JSON.stringify({
    shipped: hash8(dictionary),
    source: family.source,
    fresh: hash8(freshFamily),
    committed: committedFamily?.hash8 ?? null,
    freshTotal: family.freshTotal,
    committedTotal: family.committedTotal,
    drift: family.drift,
    threshold: family.threshold,
    pages: compressedPages.length,
  }, null, 2) + "\n");
  const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  if (family.source === "committed") {
    console.log(`page-family: shipping the COMMITTED dictionary ${committedHash} (family tier ${family.committedTotal} B; fresh ${hash8(freshFamily)} would be ${family.freshTotal} B, drift ${pct(family.drift)} within the ${pct(family.threshold).slice(1)} line)`);
  } else if (committedHash) {
    console.log(`page-family: shipping the FRESH dictionary ${hash8(dictionary)}: the committed ${committedHash} has drifted ${pct(family.drift)} past the ${pct(family.threshold).slice(1)} line (${family.committedTotal} B against ${family.freshTotal} B). Run \`bun run dict:roll\` once this deploys, so the next build keeps this URL.`);
  } else {
    console.log(`page-family: shipping the FRESH dictionary ${hash8(dictionary)}; ${FAMILY_DICT_DIR} is empty. Run \`bun run dict:roll\` once this deploys, so the next build keeps this URL.`);
  }
  console.log(`shell-assets: page dictionary -> /a/${familyName}`);
  const familyBytes = dictionary;
  const familyTag = dictionaryTag(familyBytes);
  console.log(`page-delta: site-page dictionary ${familyName} (${familyBytes.length} bytes, tag ${familyTag})`);
  await mkdir(`${OUT}/public/pd`, { recursive: true });
  const brotliPages = compressedPages.filter(({ bytes, br }) => br.length < bytes.length);
  await Promise.all(brotliPages.map(({ page, br }) => writeFile(`${OUT}/public/${page}.br`, br)));
  const brCount = brotliPages.length;
  const brRaw = brotliPages.reduce((total, { bytes }) => total + bytes.length, 0);
  const brEnc = brotliPages.reduce((total, { br }) => total + br.length, 0);

  type DeltaJob = { kind: "page" | "family"; slug: string; tag?: string; bytes: Buffer; dictBytes: Buffer; br: Buffer; frame?: Buffer };
  const deltaJobs = (await Promise.all(compressedPages.map(async ({ page, bytes, br }, index) => {
    const jobs: DeltaJob[] = [];
    const slug = pageSlug(page);
    for (const candidate of pageDicts.filter((d) => d.slug === slug)) {
      const dictBytes = brotliDecompressSync(await readFile(`${dictDir}/${candidate.name}`));
      if (dictBytes.equals(bytes)) continue;
      jobs.push({ kind: "page", slug, tag: candidate.tag, bytes, dictBytes, br });
    }
    jobs.push({ kind: "family", slug, bytes, dictBytes: familyBytes, br, frame: family.frames[index] });
    return jobs;
  }))).flat();
  const toEncode = deltaJobs.filter((job) => !job.frame);
  const frames = await zstdBatch(toEncode.map(({ bytes, dictBytes }) => ({ bytes, dictionary: dictBytes })));
  const encoded = toEncode.map(({ dictBytes }, i) => frameDcz(frames[i], dictBytes));
  const deltas = deltaJobs.map((job) => job.frame ? frameDcz(job.frame, job.dictBytes) : encoded[toEncode.indexOf(job)]);
  const deltaWrites = await Promise.all(deltaJobs.map(async (job, i) => {
    const { out, tag } = deltas[i];
    if (out.length >= job.br.length) {
      const label = job.kind === "page" ? `per-page ${job.tag.slice(0, 8)}` : "site-page";
      return { job, out, skipped: `page-delta: SKIPPED ${job.slug} vs ${label} (dcz ${out.length} >= br ${job.br.length})` };
    }
    await writeFile(`${OUT}/public/pd/${pageDeltaName(job.slug, tag)}`, out);
    return { job, out, skipped: null };
  }));
  for (const { job, out, skipped } of deltaWrites) {
    if (skipped) { console.log(skipped); continue; }
    dCount++; dBytes += out.length; dPlain += job.br.length;
    if (job.kind === "page") {
      pageCount++; pageBytes += out.length;
    } else {
      familyCount++; familyBytesOut += out.length;
    }
  }
  console.log(`pages: ${brCount} brotli q11 twins, ${(brRaw / 1024).toFixed(1)}KB -> ${(brEnc / 1024).toFixed(1)}KB`);
  console.log(dCount
    ? `page-delta: ${dCount} dcz delta(s), ${dBytes} bytes against ${dPlain} plain brotli (${pageCount} per-page/${pageBytes} B, ${familyCount} family/${familyBytesOut} B)`
    : `page-delta: none (no dictionary candidate beat plain brotli)`);
}

phase("compact data");
{
  const all = await readdir(`${OUT}/public`, { recursive: true });
  let files = 0, saved = 0;
  for (const rel of all) {
    if (/\.src\./.test(rel) || rel.startsWith("md/") || rel.startsWith("a/")) continue;
    const path = `${OUT}/public/${rel}`;
    let out: string | null = null;
    if (rel.endsWith(".json")) {
      const src = await readFile(path, "utf8");
      let parsed;
      try { parsed = JSON.parse(src); } catch { continue; }
      const compact = JSON.stringify(parsed);
      if (compact.length < src.length) { out = compact; saved += src.length - compact.length; }
    } else if (rel.endsWith(".xml")) {
      const src = await readFile(path, "utf8");
      const compact = src.replace(/>\s+</g, "><").trim();
      if (compact.length < src.length) { out = compact; saved += src.length - compact.length; }
    }
    if (out !== null) { await writeFile(path, out); files++; }
  }
  if (files < 8) throw new Error(`compact-data: only ${files} JSON/XML files were compacted (expected 8+); did the walk stop reaching the staged tree, or did the sources stop being pretty-printed?`);
  console.log(`compact-data: ${files} JSON/XML files re-serialised without indentation, ${(saved / 1024).toFixed(1)}KB raw saved`);
}

phase("text twins");
{
  const TWINNED = [
    /^(?:garage|lwe|pixel-peeper|access|dotfiles)\/.+\.(?:md|txt|xml|json|js|css)$/,
    /^(?:garage|lwe|pixel-peeper|access|dotfiles)\/.+\.src\.html$/,
    /^writing\/[^/]+\.(?:json|txt|xml)$/,
    /^images\/(?:meta\/)?[^/]+\.json$/,
    /^[^/]+\.md$/,
    /^[^/]+\.src\.(?:html|js|css)$/,
    /^\.well-known\/(?!agent-card\.json$).+\.(?:json|md)$/,
    /^(?:search-index\.json|llms\.txt|llms-full\.txt|sitemap\.xml|resume\.json)$/,
    /^section-icons\/[^/]+\.svg$/,
    /^(?:writing|lens|serendipity)\/.+\.src\.html$/,
  ];
  const RENDERED = new Set(["rn.md"]);
  const all = await readdir(`${OUT}/public`, { recursive: true });
  const have = new Set(all);
  const candidates = all.filter((rel) =>
    TWINNED.some((re) => re.test(rel)) &&
    !RENDERED.has(rel) &&
    !have.has(`${rel}.br`) &&
    !rel.startsWith("md/"),
  );
  const compressed = await Promise.all(candidates.map(async (rel) => {
    const bytes = await readFile(`${OUT}/public/${rel}`);
    return { rel, bytes, br: await brotliQ11(bytes) };
  }));
  const wins = compressed.filter(({ bytes, br }) => br.length < bytes.length);
  await Promise.all(wins.map(({ rel, br }) => writeFile(`${OUT}/public/${rel}.br`, br)));
  for (const { rel, bytes, br } of compressed) {
    if (br.length >= bytes.length) console.log(`text-twins: SKIPPED /${rel} (br ${br.length} >= raw ${bytes.length})`);
  }
  const raw = wins.reduce((t, { bytes }) => t + bytes.length, 0);
  const enc = wins.reduce((t, { br }) => t + br.length, 0);
  if (wins.length < 200) {
    throw new Error(`text-twins: only ${wins.length} static text twins written; the walk expected 200+ (241 on 2026-08-31, from 271 static text files less the 30 the globs above deliberately leave to the asset layer), so the globs have stopped matching the staged tree`);
  }
  console.log(`text-twins: ${wins.length} brotli q11 twins for static text assets, ${(raw / 1024).toFixed(1)}KB -> ${(enc / 1024).toFixed(1)}KB`);
}

phase("sweep old build");
await sweep;
phase("cache prune");
const pruned = await cache.prune();
{
  const rows = finishPhases();
  const { hits, misses } = cache.stats();
  console.log(buildCacheEnabled()
    ? `build cache: ${hits} hits, ${misses} encoded${pruned ? `, ${pruned} stale entries pruned` : ""}`
    : `build cache: off (CI or BUILD_CACHE=0), ${misses} encoded`);
  await writeFile(`${OUT}/phases.json`, JSON.stringify(rows, null, 2) + "\n");
  console.log(phaseSummary(rows));
}
console.log(`staged ${OUT}/ - deploy with: wrangler deploy (self-builds via build.command) or bun run deploy:direct`);
