// The client asset registry: ONE declaration per file the build minifies and
// content-hashes into /a/. Everything that used to be its own hand-kept list is
// a projection of CLIENT_ASSETS:

export type Loader =
  | { via: "attr"; attr: "src" | "href"; fragment?: true }
  | { via: "import"; query?: string; also?: readonly string[] }
  | { via: "string"; query: string }
  | { via: "fetch" }
  | { via: "after"; prefix: string };

const FROM: Loader = { via: "after", prefix: "\\bfrom\\s*" };
const IMPORT: Loader = { via: "import" };
const V1 = "?v=1";

export type Envelope = { role: string; gzipKiB: number; brotliKiB: number };

export type ClientAsset = {
  file: string;
  kind: "script" | "module" | "style" | "static";
  marker?: string;
  base?: string;
  // shell: ranked by step 5c as part of the shell, so its bytes cannot move on a
  // page edit (gotcha 35). page: loaded by one page or section and ranked like a
  // page, so an edit to it cannot reorder luna.css's short names either.
  scope: "shell" | "page";
  load: readonly Loader[];
  loadedBy: readonly string[];
  budget: Envelope | "unbudgeted";
};

export const CLIENT_ASSETS: readonly ClientAsset[] = [
  { file: "nav-run.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"nav-run"\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  { file: "nav-tray.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"nav-tray"\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  // nav.js's source quotes this key ("infotip":) and the minifier drops the
  // quotes, so the prefix takes both: the build rewrites the minified form, the
  // contract suite checks the source one.
  { file: "infotip.css", kind: "style", scope: "shell", budget: "unbudgeted",
    load: [{ via: "after", prefix: '"?\\binfotip\\b"?\\s*:\\s*' }], loadedBy: ["public/nav.js"] },
  { file: "quiz.css", kind: "style", scope: "page", budget: "unbudgeted",
    load: [{ via: "after", prefix: "\\.href\\s*=\\s*" }], loadedBy: ["public/quiz.js"] },
  { file: "hoist.js", kind: "script", marker: "createHoist", scope: "shell",
    budget: { role: "shared hover engine", gzipKiB: 2, brotliKiB: 1.5 },
    load: [IMPORT, FROM],
    loadedBy: ["public/index.html", "public/nav.js", "public/nav-run.js", "public/tooltip.js", "public/infotip.js", "public/lens.js", "public/serendipity.js"] },
  { file: "webmcp.js", kind: "script", marker: "registerSiteTools", scope: "shell", budget: "unbudgeted",
    load: [IMPORT], loadedBy: ["public/nav.js", "public/lens-webmcp.js"] },
  { file: "nav-run.js", kind: "script", marker: "axp-run", scope: "shell",
    budget: { role: "first-open Run island", gzipKiB: 12, brotliKiB: 10 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  { file: "nav-tray.js", kind: "script", marker: "axp-balloon", scope: "shell",
    budget: { role: "first-click tray island", gzipKiB: 5, brotliKiB: 4 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  { file: "nav-pipes.js", kind: "script", marker: "axp-pipes", scope: "shell",
    budget: { role: "idle screen-saver island", gzipKiB: 6, brotliKiB: 5 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  { file: "nav-tips.js", kind: "script", marker: "axp-tips", scope: "shell",
    budget: { role: "once-a-day tips island", gzipKiB: 3, brotliKiB: 2.5 },
    load: [IMPORT], loadedBy: ["public/nav.js"] },
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
  { file: "lens-webmcp.js", kind: "script", marker: "LensWebMcp", scope: "shell",
    budget: { role: "idle WebMCP registrar", gzipKiB: 5, brotliKiB: 4 },
    load: [IMPORT], loadedBy: ["public/lens-boot.js"] },
  { file: "lens.js", kind: "script", marker: "replaceState", scope: "shell",
    budget: { role: "post-intent Lens application", gzipKiB: 24, brotliKiB: 21 },
    load: [{ via: "import", query: V1 }], loadedBy: ["public/lens-boot.js"] },
  { file: "tooltip.js", kind: "script", marker: "function start", scope: "shell",
    budget: { role: "optional hover island", gzipKiB: 6, brotliKiB: 5 },
    load: [IMPORT], loadedBy: ["public/index.html"] },
  { file: "infotip.js", kind: "script", marker: "axp-infotip", scope: "shell", budget: "unbudgeted",
    load: [IMPORT], loadedBy: ["public/nav.js"] },
  { file: "garage/pretext.lib.js", kind: "module", marker: "prepareWithSegments", base: "pretext-lib", scope: "page",
    budget: "unbudgeted",
    load: [{ via: "import", also: ["./pretext.lib.js"] }], loadedBy: ["public/garage/pretext.html"] },
  { file: "garage/md-to-html.js", kind: "module", marker: "mdToHtml", scope: "page", budget: "unbudgeted",
    load: [{ via: "import", also: ["./md-to-html.js"] }], loadedBy: ["public/garage/round-trip.html"] },
  // The AV2 decoder, run as a module Worker by /garage/av2 and, since
  // 2026-10-14, by /pixel-peeper for its AV2 tiles. Each page names it in
  // `new Worker(...)`, so that call is the pattern; the prose's <code> mention
  // of the path has no `new Worker(` before it and stays plain. Its WASM is a
  // content-addressed file in public/garage/av2, outside the registry, because
  // the /a/ route only answers js, css, svg, json and dict.
  { file: "garage/av2-decode.js", kind: "module", marker: "av2_decode", base: "av2-decode", scope: "page",
    budget: "unbudgeted",
    load: [{ via: "after", prefix: "new Worker\\(\\s*" }], loadedBy: ["public/garage/av2.html", "public/pixel-peeper/index.html"] },
  { file: "dotfiles.js", kind: "module", marker: "dotfiles-data", scope: "page", budget: "unbudgeted",
    load: [FROM, IMPORT], loadedBy: ["public/dotfiles/index.html"] },
  { file: "pixel-peeper/manifest.json", kind: "static", base: "pixel-peeper-manifest", scope: "page",
    budget: "unbudgeted",
    load: [{ via: "fetch" }], loadedBy: ["public/pixel-peeper/index.html"] },

  { file: "nav.js", kind: "script", marker: "axp-histnav", scope: "shell",
    budget: { role: "shared deferred shell", gzipKiB: 20, brotliKiB: 18 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/index.html", "cal/src/templates.ts"] },
  { file: "luna.css", kind: "style", scope: "shell",
    budget: { role: "shared render-blocking CSS", gzipKiB: 12, brotliKiB: 10 },
    load: [{ via: "attr", attr: "href" }], loadedBy: ["public/index.html", "cal/src/templates.ts"] },
  { file: "lens-boot.js", kind: "script", marker: "requestSubmit", scope: "shell",
    budget: { role: "idle Lens bootstrap", gzipKiB: 1, brotliKiB: 1 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["src/worker/lens.ts"] },
  // The desktop icon sprite. Every ref carries a #fragment
  // (src="/icons.svg#pin-garage"); src= because the refs are <img> against
  // <view>s (the WebKit note in gen-desktop-partial.ts).
  { file: "icons.svg", kind: "static", scope: "shell", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src", fragment: true }], loadedBy: ["src/worker/lib/desktop.ts"] },
  { file: "serendipity.js", kind: "script", marker: "data-event-time", scope: "page", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src" }], loadedBy: ["serendipity/serendipity.ts"] },
  { file: "quiz.js", kind: "script", marker: "luq-data", scope: "shell",
    budget: { role: "understanding-check island", gzipKiB: 6, brotliKiB: 5 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/garage/encoding.html"] },
  { file: "notepad.js", kind: "script", marker: "np-window", scope: "shell",
    budget: { role: "writing-only island", gzipKiB: 4, brotliKiB: 3.5 },
    load: [{ via: "attr", attr: "src" }], loadedBy: ["src/worker/writing.ts"] },
  { file: "lwe-base.css", kind: "style", scope: "shell",
    budget: { role: "LWE render-blocking CSS", gzipKiB: 2, brotliKiB: 2 },
    load: [{ via: "attr", attr: "href" }], loadedBy: ["public/lwe/vigenere.html"] },
  // The prose kit: article typography for every Garage page, linked before a
  // page's own <style>. Page-scoped, so its custom-property uses cannot
  // re-rank luna.css's short names (gotcha 35).
  { file: "prose.css", kind: "style", scope: "page", budget: "unbudgeted",
    load: [{ via: "attr", attr: "href" }], loadedBy: ["public/garage/wire.html"] },
  { file: "lwe/ask.js", kind: "script", marker: "lwe-q", base: "ask", scope: "page", budget: "unbudgeted",
    load: [{ via: "attr", attr: "src" }], loadedBy: ["public/lwe/vigenere.html"] },
];

const extOf = (file: string): string => file.slice(file.lastIndexOf(".") + 1);
const stemOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1, file.lastIndexOf("."));

export const assetBase = (a: ClientAsset): string => a.base ?? stemOf(a.file);
export const assetExt = (a: ClientAsset): string => extOf(a.file);
export const stagedPath = (a: ClientAsset): string => `public/${a.file}`;
export const twinOf = (a: ClientAsset): string | null =>
  a.kind === "static" ? null : a.file.replace(/\.(js|css)$/, ".src.$1");

const isScript = (a: ClientAsset): boolean => a.kind === "script" || a.kind === "module";

export type ScriptRow = { file: string; twin: string; marker: string; module: boolean };

export const minifiedScripts = (assets: readonly ClientAsset[] = CLIENT_ASSETS): ScriptRow[] =>
  assets.filter(isScript).map((a) => ({ file: a.file, twin: `/${twinOf(a)}`, marker: a.marker ?? "", module: a.kind === "module" }));

export const minifiedStyles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.filter((a) => a.kind === "style").map((a) => a.file);

export const contentHashedFiles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Set<string> =>
  new Set(assets.map(stagedPath));

export const shellRankedFiles = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Set<string> =>
  new Set(assets.filter((a) => a.scope === "shell").map(stagedPath));

export const budgetedAssets = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Array<{ file: string; envelope: Envelope }> =>
  assets.flatMap((a) => (a.budget === "unbudgeted" ? [] : [{ file: a.file, envelope: a.budget }]));
export const unbudgetedAssets = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.filter((a) => a.budget === "unbudgeted" && a.kind !== "static").map((a) => a.file);
export const readableTwins = (assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] =>
  assets.flatMap((a) => twinOf(a) ?? []);

export const twinOracleRows = (assets: readonly ClientAsset[] = CLIENT_ASSETS): Array<{ path: string; status: number; ct: string[]; marker: string }> =>
  minifiedScripts(assets).map((r) => ({ path: r.twin, status: 200, ct: ["text/javascript", "application/javascript"], marker: r.marker }));

export function clientScriptProblems(srcClientFiles: readonly string[], assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] {
  const rows = new Map(minifiedScripts(assets).map((r) => [r.file, r.marker]));
  const problems: string[] = [];
  const missing = srcClientFiles.filter((f) => f.endsWith(".js") && f !== "sw.js" && !rows.has(f));
  if (missing.length) problems.push(`${missing.join(", ")} in src/client but not in the client asset registry, so it would ship unminified with no twin and no marker tripwire`);
  const unmarked = [...rows].filter(([, marker]) => !marker).map(([file]) => file);
  if (unmarked.length) problems.push(`${unmarked.join(", ")} carries no marker, so a minifier deleting it would pass the build`);
  return problems;
}

export function registryProblems(assets: readonly ClientAsset[] = CLIENT_ASSETS): string[] {
  const problems: string[] = [];
  const files = new Set<string>();
  const names = new Map<string, string>();
  for (const a of assets) {
    if (files.has(a.file)) problems.push(`${a.file} is declared twice`);
    files.add(a.file);
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

export function hashOrder(assets: readonly ClientAsset[] = CLIENT_ASSETS): ClientAsset[] {
  const byStaged = new Map(assets.map((a) => [stagedPath(a), a]));
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

export function loaderNeedles(a: ClientAsset, loader: Loader): string[] {
  return loader.via === "import" && loader.also?.length ? [`/${a.file}`, ...loader.also] : [`/${a.file}`];
}

export function loaderRewrites(a: ClientAsset, loader: Loader, to: string): Array<[RegExp, string]> {
  const path = `/${a.file}`;
  switch (loader.via) {
    case "attr": {
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
