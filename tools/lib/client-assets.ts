// The client asset registry: ONE declaration per file the build minifies and
// content-hashes into /a/. Everything that used to be its own hand-kept list is
// a projection of CLIENT_ASSETS:
//
//   build.ts step 3      minifiedScripts()        which scripts to minify, their twins and markers
//   build.ts step 4      minifiedStyles()         which stylesheets to minify
//   build.ts step 5c     shellRankedFiles()       the shell tier the property mangler ranks by
//   build.ts step 6      hash-client-assets.ts    hash ORDER, rewrite patterns, witnesses
//   perf-budget.ts       budgetedAssets(), unbudgetedAssets(), readableTwins()
//   verify-routes.ts     twinOracleRows()
//
// Until 2026-10-02 those were SHELLS, MODULE_SHELLS, PAGE_SCOPED_HASHED,
// CONTENT_HASHED, ASSETS, STRING_ASSETS and about 20 hand-written witness
// throws in build.ts, plus ASSET_ENVELOPES and TWINS in perf-budget.ts and a
// row pair per script in the route oracle. Adding one island touched about 7
// places, and two of the lists had fallen behind: 14 minified assets carried
// no envelope and 13 twins went unchecked, with nothing saying so.
//
// This module is PURE: no filesystem, no build state. It loads under bun and
// node alike, which is what lets the route oracle and the contract suite read
// the same declarations the build does. The operation that touches a staged
// tree is hash-client-assets.ts.

// How a dependent NAMES the asset, which decides the pattern step 6 rewrites.
// Each shape is exact syntax on purpose: the garage pages mention /nav.js and
// /hoist.js in prose and in <code>, and a bare-path match would rewrite them.
export type Loader =
  // src="/x.js" or href="/x.css" in markup, quoted, backslash-quoted or unquoted
  // (minify-html unquotes). `fragment` keeps a #fragment (the icon sprite).
  | { via: "attr"; attr: "src" | "href"; fragment?: true }
  // import("/x.js"). `query` is a literal suffix the source carries ("?v=1");
  // `also` lists other spellings of the same specifier ("./pretext.lib.js").
  | { via: "import"; query?: string; also?: readonly string[] }
  // "/x.js?v=1" as a bare string literal (script.src = "...").
  | { via: "string"; query: string }
  // fetch("/x.json")
  | { via: "fetch" }
  // <prefix>"/x.css": a quoted path directly after `prefix`, a regex source.
  // Covers a static `from "/x.js"`, a keyed map entry, and `.href = "/x.css"`.
  | { via: "after"; prefix: string };

const FROM: Loader = { via: "after", prefix: "\\bfrom\\s*" };
const IMPORT: Loader = { via: "import" };
const V1 = "?v=1";

export type Envelope = { role: string; gzipKiB: number; brotliKiB: number };

export type ClientAsset = {
  // Served path under the public root, and the path under `source`.
  file: string;
  // script and module are minified by oxc from src/client (a module parses as
  // ESM and mangles its top level); style is minified by Lightning CSS from
  // src/styles; static ships its bytes unchanged (a JSON one in compact form).
  kind: "script" | "module" | "style" | "static";
  // Scripts only: a token the MINIFIED output must still contain. It is the
  // tripwire that turns a minifier deleting a whole island into a failed build.
  marker?: string;
  // The /a/<base>.<hash8>.<ext> stem. Defaults to the file's own stem, which is
  // what perf-snapshot's merge dehashes back to. A subdirectory asset takes a
  // flat one, because the roll and dcz:check read /a/ names as [\w-]+.
  base?: string;
  // shell: ranked by step 5c as part of the shell, so its bytes cannot move on a
  // page edit (gotcha 35). page: loaded by one page or section and ranked like a
  // page, so an edit to it cannot reorder luna.css's short names either.
  scope: "shell" | "page";
  load: readonly Loader[];
  // Staged files (relative to the staged root) that must carry the hashed URL
  // once step 6 is done. An entry naming another registered asset
  // ("public/nav.js") is a DEPENDENCY EDGE: this asset is hashed first, so the
  // dependent's hash covers its final bytes. Asset edges must be exhaustive;
  // the hasher fails on a rewrite that lands in a registered asset not listed
  // here. Pages and Worker modules are witnesses and need not be.
  loadedBy: readonly string[];
  // perf-budget's advisory wire-size envelope. "unbudgeted" is a declared gap,
  // never an oversight: nobody has measured a number worth typing for it yet.
  budget: Envelope | "unbudgeted";
};

// Declared in the order step 6 hashed them before the order was derived. Any
// order works: hashOrder() sorts leaves-first from the loadedBy edges, and
// contract-client-asset-registry proves a shuffled registry hashes to the same
// bytes. Keeping the old order means hashOrder() reproduces it exactly.
export const CLIENT_ASSETS: readonly ClientAsset[] = [
  // Three first-interaction sheets, each extracted byte-for-byte from luna.css
  // and loaded by nav.js beside its matching island.
  { file: "nav-run.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"nav-run"\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  { file: "nav-tray.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"nav-tray"\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  // nav.js's source quotes this key ("infotip":) and the minifier drops the
  // quotes, so the prefix takes both: the build rewrites the minified form, the
  // contract suite checks the source one.
  { file: "infotip.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"?\\binfotip\\b"?\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  // quiz.js's stylesheet. Page-scoped: it loads beside quiz.js on the garage and
  // lwe pages, reads --font-ui and --font-caption, and defines no property.
  { file: "quiz.css", kind: "style", scope: "page", budget: "unbudgeted",
    load: [{ via: "after", prefix: "\\.href\\s*=\\s*" }], loadedBy: ["public/quiz.js"] },
  // The shared hover engine. TWO loader shapes, and missing the second cost a
  // serialized fetch in production (2026-07-27): nav.js and index.html reach it
  // through import(), tooltip.js through a static `from`.
  { file: "hoist.js", kind: "script", marker: "createHoist", scope: "shell",
    budget: { role: "shared hover engine", gzipKiB: 2, brotliKiB: 1.5 },
    load: [IMPORT, FROM],
    loadedBy: ["public/index.html", "public/nav.js", "public/nav-run.js", "public/tooltip.js", "public/infotip.js", "public/lens.js", "public/serendipity.js"] },
  // First-party WebMCP registration, loaded on idle from nav.js on every page
  // and from lens-webmcp.js. Hashed since 2026-09-26; before that it shipped at
  // the edge's q4 with no twin (2,436 B against 2,098 at q11).
  { file: "webmcp.js", kind: "script", marker: "registerSiteTools", scope: "shell", budget: "unbudgeted",
    load: [IMPORT], loadedBy: ["public/nav.js", "public/lens-webmcp.js"] },
  { file: "nav-run.js", kind: "script", marker: "axp-run", scope: "shell",
    budget: { role: "first-open Run island", gzipKiB: 12, brotliKiB: 10 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  { file: "nav-tray.js", kind: "script", marker: "axp-balloon", scope: "shell",
    budget: { role: "first-click tray island", gzipKiB: 5, brotliKiB: 4 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  // The idle screen saver.
  { file: "nav-pipes.js", kind: "script", marker: "axp-pipes", scope: "shell",
    budget: { role: "idle screen-saver island", gzipKiB: 6, brotliKiB: 5 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  // Tip of the Day, once a day. Its stylesheet is nav-tray.css.
  { file: "nav-tips.js", kind: "script", marker: "axp-tips", scope: "shell",
    budget: { role: "once-a-day tips island", gzipKiB: 3, brotliKiB: 2.5 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  // The six /lens feature modules, each loaded by lens.js as script.src. The
  // ?v=1 ritual retires at the rewrite: the hash IS the version.
  //
  // lens-browser's envelope was raised from 4/3.5 on 2026-08-08 for the
  // interaction recipes: the chip row, the before/after screenshot pair, and
  // the six honest-null strings that say WHY a recipe found nothing. Measured
  // +1.4 KiB gzip, 3.0 -> 4.4. Bumped deliberately rather than discovered by CI.
  { file: "lens-browser.js", kind: "script", marker: "LensBrowser", scope: "shell",
    budget: { role: "optional browser island", gzipKiB: 5, brotliKiB: 4.5 },
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  { file: "lens-reader.js", kind: "script", marker: "LensReader", scope: "shell", budget: "unbudgeted",
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  { file: "lens-wire.js", kind: "script", marker: "LensWire", scope: "shell", budget: "unbudgeted",
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  { file: "lens-tools.js", kind: "script", marker: "LensTools", scope: "shell",
    budget: { role: "optional MCP-form island", gzipKiB: 7, brotliKiB: 6 },
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  { file: "lens-nlweb.js", kind: "script", marker: "LensNlweb", scope: "shell", budget: "unbudgeted",
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  { file: "lens-markdown.js", kind: "script", marker: "LensMarkdown", scope: "shell", budget: "unbudgeted",
    load: [{ via: "string", query: V1 }], loadedBy: ["public/lens.js"] },
  // The WebMCP-capable idle shell loads only this registrar.
  { file: "lens-webmcp.js", kind: "script", marker: "LensWebMcp", scope: "shell",
    budget: { role: "idle WebMCP registrar", gzipKiB: 5, brotliKiB: 4 },
    load: [IMPORT], loadedBy: ["public/lens-boot.js"] },
  // The full Lens application. The bootstrap imports it, so the bootstrap's
  // immutable URL covers the complete lazy chain.
  { file: "lens.js", kind: "script", marker: "replaceState", scope: "shell",
    budget: { role: "post-intent Lens application", gzipKiB: 24, brotliKiB: 21 },
    load: [{ via: "import", query: V1 }], loadedBy: ["public/lens-boot.js"] },
  { file: "tooltip.js", kind: "script", marker: "function start", scope: "shell",
    budget: { role: "optional hover island", gzipKiB: 6, brotliKiB: 5 },
    load: [IMPORT], loadedBy: ["public/index.html"] },
  // The shell's own tooltips, imported by nav.js on the first hover with a tip.
  { file: "infotip.js", kind: "script", marker: "axp-infotip", scope: "shell", budget: "unbudgeted",
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  // Page-scoped since 2026-09-30: each was a plain URL every visit revalidated.
  //
  // The vendored @chenglou/pretext 0.0.7. /garage/pretext imports it RELATIVELY,
  // so the pattern takes both spellings; the page's prose names the path in
  // <code> twice, and call syntax is what keeps those mentions out of reach.
  // The marker is an export NAME, which survives minification by construction.
  { file: "garage/pretext.lib.js", kind: "module", marker: "prepareWithSegments", base: "pretext-lib", scope: "page",
    budget: "unbudgeted",
    load: [{ via: "import", also: ["./pretext.lib.js"] }], loadedBy: ["public/garage/pretext.html"] },
  // The /dotfiles checklist, an ES module (tools/gen-dotfiles.ts imports its
  // renderer to write the committed macos.sh).
  { file: "dotfiles.js", kind: "module", marker: "dotfiles-data", scope: "page", budget: "unbudgeted",
    load: [FROM, IMPORT], loadedBy: ["public/dotfiles/index.html"] },
  // The one DATA file, fetched before /pixel-peeper can draw a trial. It stays
  // off the dictionary path (DICTIONARY_TYPES in lib/assets.ts says why).
  { file: "pixel-peeper/manifest.json", kind: "static", base: "pixel-peeper-manifest", scope: "page",
    budget: "unbudgeted",
    load: [{ via: "fetch" }], loadedBy: ["public/pixel-peeper/index.html"] },

  // Loaded by ATTRIBUTE from markup. cal/src/templates.ts is a witness for nav
  // and luna because a /coffee page left on the plain URL keeps working and
  // only loses the immutable cache, which nothing else would notice.
  { file: "nav.js", kind: "script", marker: "axp-histnav", scope: "shell",
    budget: { role: "shared deferred shell", gzipKiB: 20, brotliKiB: 18 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/index.html", "cal/src/templates.ts"] },
  { file: "luna.css", kind: "style", scope: "shell",
    budget: { role: "shared render-blocking CSS", gzipKiB: 12, brotliKiB: 10 },
    load: [{ via: "attr", attr: "href" }], loadedBy: ["public/index.html", "cal/src/templates.ts"] },
  // The server-rendered idle Lens shell emits only this interaction bootstrap.
  { file: "lens-boot.js", kind: "script", marker: "requestSubmit", scope: "shell",
    budget: { role: "idle Lens bootstrap", gzipKiB: 1, brotliKiB: 1 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["src/worker/lens.ts"] },
  // The desktop icon sprite. Every ref carries a #fragment
  // (src="/icons.svg#pin-garage"); src= because the refs are <img> against
  // <view>s (the WebKit note in gen-desktop-partial.ts).
  { file: "icons.svg", kind: "static", scope: "shell", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src", fragment: true }], loadedBy: ["src/worker/lib/desktop.ts"] },
  // The /serendipity event list's island, emitted by the Worker's page shell.
  // Page-scoped since it joined /a/ on 2026-10-02.
  { file: "serendipity.js", kind: "script", marker: "data-event-time", scope: "page", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src" }], loadedBy: ["serendipity/serendipity.ts"] },
  // The understanding-check widget.
  { file: "quiz.js", kind: "script", marker: "luq-data", scope: "shell",
    budget: { role: "understanding-check island", gzipKiB: 6, brotliKiB: 5 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/garage/encoding.html"] },
  { file: "notepad.js", kind: "script", marker: "np-window", scope: "shell",
    budget: { role: "writing-only island", gzipKiB: 4, brotliKiB: 3.5 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["src/worker/writing.ts"] },
  // Shared LWE structure, a separate warm-cache object.
  { file: "lwe-base.css", kind: "style", scope: "shell",
    budget: { role: "LWE render-blocking CSS", gzipKiB: 2, brotliKiB: 2 },
    load: [{ via: "attr", attr: "href" }], loadedBy: ["public/lwe/vigenere.html"] },
  // The LWE pages' ask widget, on 12 pages. Minified since 2026-09-16 (4,305 B
  // at the edge's q4 against 2,833 with a q11 twin); /lwe/ask.js stays served.
  { file: "lwe/ask.js", kind: "script", marker: "lwe-q", base: "ask", scope: "page", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/lwe/vigenere.html"] },
];

const extOf = (file: string): string => file.slice(file.lastIndexOf(".") + 1);
const stemOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1, file.lastIndexOf("."));

export const assetBase = (a: ClientAsset): string => a.base ?? stemOf(a.file);
export const assetExt = (a: ClientAsset): string => extOf(a.file);
// The staged path the mangler and the edges use, relative to the staged root.
export const stagedPath = (a: ClientAsset): string => `public/${a.file}`;
// The readable twin a minified asset ships beside: nav.js -> nav.src.js.
export const twinOf = (a: ClientAsset): string | null =>
  a.kind === "static" ? null : a.file.replace(/\.(js|css)$/, ".src.$1");

const isScript = (a: ClientAsset): boolean => a.kind === "script" || a.kind === "module";

// ── projections ──────────────────────────────────────────────────────────────

export type ScriptRow = { file: string; twin: string; marker: string; module: boolean };

// Step 3's rows: every client script, its twin's served path, its marker.
export const minifiedScripts = (assets: readonly ClientAsset[] = CLIENT_ASSETS): ScriptRow[] =>
  assets.filter(isScript).map((a) => ({ file: a.file, twin: `/${twinOf(a)}`, marker: a.marker ?? "", module: a.kind === "module" }));

// Step 4's rows: every stylesheet the build minifies.
export const minifiedStyles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.filter((a) => a.kind === "style").map((a) => a.file);

// Every staged file step 6 hashes into /a/.
export const contentHashedFiles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Set<string> =>
  new Set(assets.map(stagedPath));

// The part of it step 5c ranks as the shell. The hasher and the mangler read
// one registry, so an asset cannot join /a/ without being placed in a tier.
export const shellRankedFiles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Set<string> =>
  new Set(assets.filter((a) => a.scope === "shell").map(stagedPath));

// perf-budget: the assets with an envelope, the declared gap, and every twin.
export const budgetedAssets = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Array<{ file: string; envelope: Envelope }> =>
  assets.flatMap((a) => (a.budget === "unbudgeted" ? [] : [{ file: a.file, envelope: a.budget }]));
// Minified assets nobody has typed an envelope for. A static asset has no
// minified form to budget, so it is not part of the gap.
export const unbudgetedAssets = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.filter((a) => a.budget === "unbudgeted" && a.kind !== "static").map((a) => a.file);
export const readableTwins = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.flatMap((a) => twinOf(a) ?? []);

// The route oracle: each script's readable twin serves, and still carries the
// marker the build holds the minified copy to.
export const twinOracleRows = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Array<{ path: string; status: number; ct: string[]; marker: string }> =>
  minifiedScripts(assets).map((r) => ({ path: r.twin, status: 200, ct: ["text/javascript", "application/javascript"], marker: r.marker }));

// ── checks ───────────────────────────────────────────────────────────────────

// EVERY client script is registered, or is sw.js (a ~15-line unregister stub,
// shipped readable and verbatim since v136). A file missing from the registry
// ships unminified with no twin and, the sharper half, no MARKER (measured
// 2026-09-15: `propertyWriteSideEffects: false` minified six /lens islands to
// 0 bytes, and "lost the LensBrowser marker" is what stopped it). Takes the
// recursive listing of src/client; returns one problem per line, empty if none.
export function clientScriptProblems(srcClientFiles: readonly string[], assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] {
  const rows = new Map(minifiedScripts(assets).map((r) => [r.file, r.marker]));
  const problems: string[] = [];
  const missing = srcClientFiles.filter((f) => f.endsWith(".js") && f !== "sw.js" && !rows.has(f));
  if (missing.length) problems.push(`${missing.join(", ")} in src/client but not in the client asset registry, so it would ship unminified with no twin and no marker tripwire`);
  const unmarked = [...rows].filter(([, marker]) => !marker).map(([file]) => file);
  if (unmarked.length) problems.push(`${unmarked.join(", ")} carries no marker, so a minifier deleting it would pass the build`);
  return problems;
}

// What must hold of the declarations themselves, before anything is hashed.
export function registryProblems(assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] {
  const problems: string[] = [];
  const files = new Set<string>();
  const names = new Map<string, string>();
  for (const a of assets) {
    if (files.has(a.file)) problems.push(`${a.file} is declared twice`);
    files.add(a.file);
    // roll-shell-dictionary and dcz:check read /a/ names as [\w-]+.
    if (!/^[\w-]+$/.test(assetBase(a))) problems.push(`${a.file}: /a/ base "${assetBase(a)}" must match [\\w-]+ (declare a flat \`base\`)`);
    const name = `${assetBase(a)}.${assetExt(a)}`;
    const clash = names.get(name);
    if (clash) problems.push(`${a.file} and ${clash} would both hash to /a/${assetBase(a)}.<hash8>.${assetExt(a)}`);
    names.set(name, a.file);
    if (!a.load.length) problems.push(`${a.file} declares no loader, so nothing would be repointed to its /a/ URL`);
    if (!a.loadedBy.length) problems.push(`${a.file} declares no loadedBy witness, so a rewrite that matched nothing would pass`);
  }
  return problems;
}

// The order step 6 hashes in: leaves first, derived from the loadedBy edges. An
// asset is hashed only after every asset it LOADS has been hashed and written
// into it, so each /a/ URL names the final bytes of its whole subtree. Among
// assets that are ready together the declared order breaks the tie, which
// cannot change a byte: two assets with no path between them never rewrite
// each other.
export function hashOrder(assets: readonly ClientAsset[] = CLIENT_ASSETS): ClientAsset[] {
  const byStaged = new Map(assets.map((a) => [stagedPath(a), a]));
  // waitsFor: dependent -> the assets it loads, which must be hashed first.
  const waitsFor = new Map<ClientAsset, Set<ClientAsset>>(assets.map((a) => [a, new Set()]));
  for (const dep of assets) {
    for (const path of dep.loadedBy) {
      const dependent = byStaged.get(path);
      if (dependent) waitsFor.get(dependent)!.add(dep);
    }
  }
  const order: ClientAsset[] = [];
  const done = new Set<ClientAsset>();
  while (order.length < assets.length) {
    const next = assets.find((a) => !done.has(a) && [...waitsFor.get(a)!].every((d) => done.has(d)));
    if (!next) {
      const stuck = assets.filter((a) => !done.has(a)).map((a) => a.file);
      throw new Error(`client assets: a dependency cycle among ${stuck.join(", ")}; a content hash cannot name bytes that contain it`);
    }
    order.push(next);
    done.add(next);
  }
  return order;
}

const esc = (s: string): string => s.replace(/[\\/.*+?^${}()|[\]]/g, "\\$&");
const QUOTE = "([\"'`])";

// The rewrites that point one loader shape at `to`, as [pattern, replacement].
export function loaderRewrites(a: ClientAsset, loader: Loader, to: string): Array<[RegExp, string]> {
  const path = `/${a.file}`;
  switch (loader.via) {
    case "attr": {
      // One pattern for quoted "x" AND backslash-escaped \"x\" (a Worker module
      // building markup in an escaped string), a second for minify-html's
      // unquoted form.
      const frag = loader.fragment ? "(#[\\w-]+)" : "";
      return [
        [new RegExp(`\\b${loader.attr}=(\\\\?")${esc(path)}${frag}\\1`, "g"), `${loader.attr}=$1${to}${loader.fragment ? "$2" : ""}$1`],
        [new RegExp(`\\b${loader.attr}=${esc(path)}${frag}(?=[\\s/>])`, "g"), `${loader.attr}=${to}${loader.fragment ? "$1" : ""}`],
      ];
    }
    case "import": {
      const spec = loader.also?.length
        ? `(?:${[path, ...loader.also].map(esc).join("|")})`
        : esc(path);
      return [[new RegExp(`import\\(${QUOTE}${spec}${esc(loader.query ?? "")}\\1\\)`, "g"), `import($1${to}$1)`]];
    }
    case "string":
      return [[new RegExp(`${QUOTE}${esc(path)}${esc(loader.query)}\\1`, "g"), `$1${to}$1`]];
    case "fetch":
      return [[new RegExp(`fetch\\(${QUOTE}${esc(path)}\\1\\)`, "g"), `fetch($1${to}$1)`]];
    case "after":
      return [[new RegExp(`(${loader.prefix})${QUOTE}${esc(path)}\\2`, "g"), `$1$2${to}$2`]];
  }
}
