// Which manifest pages a change can reach, from the paths it touched. A path
// this can't place reaches every page, so a miss costs a full sweep and never
// a skipped page. browser:check reads it under `--changed`.
//
// A page reaches its readings through three kinds of file: its own document in
// src/pages/, and the client scripts and stylesheets it names, directly or
// through another one that imports them. Anything the Worker renders or names
// (src/worker/, the build, the pipelines) can reach any page.

/** Paths whose change can't move a page the local harness serves. */
const INERT = [
  /^docs\//,
  // Repo tooling, except the build and this check, which shape every page.
  /^tools\/(?!build\.ts$|check-browser\.ts$|lib\/)/,
  /^config\/(ts-baseline|derivations|infra|tools)\.json$/,
  /^(rust-toolchain\.toml|\.cargo\/)/,
  /^[^/]+\.md$/,
  /^\.claude\//,
  // Deployed on their own; the harness boots only the site and counter.
  /^(cf-garage|lwe-ask|lens-reader)\//,
  // ci.yml decides how the check runs, so it stays global.
  /^\.github\/workflows\/(?!ci\.yml$)/,
  /\.d\.ts$/,
];

export type Reach = { all: string } | { pages: string[] };

/**
 * Why a change needs every page read even when no served byte moved, or
 * undefined. The served diff (tools/served-pages.ts) compares what the Worker
 * sends; a change to how browser:check reads a page moves the reading and
 * leaves every byte alone. playwright-core's version is compared separately,
 * from each side's node_modules.
 */
export function rereadsEverything(changed: string[]): string | undefined {
  const file = changed.find((f) => INSTRUMENT.some((re) => re.test(f)));
  return file && `${file} changes how pages are read`;
}

const INSTRUMENT = [
  // The readings, their budgets, and which Chrome takes them.
  /^tools\/check-browser\.ts$/,
  /^config\/browser-budget\.json$/,
  /^tools\/lib\/browser-[^/]+\.ts$/,
  // Both checkouts build with the job's one Bun, so a pin bump serves no
  // different byte under the diff even when it would in production.
  /^config\/bun-pin\.json$/,
  // The flags the check runs with.
  /^\.github\/workflows\/ci\.yml$/,
];

/** /lwe/dac for src/pages/lwe/dac.html, /lwe for src/pages/lwe/index.html. */
export function pageOf(file: string): string {
  const path = file.replace(/^src\/pages/, "").replace(/(\/index)?\.html$/, "");
  return path || "/";
}

/** The URL a client script or stylesheet is served at: src/client/lwe/ask.ts is /lwe/ask.js. */
function servedAt(file: string): string {
  return file.replace(/^src\/(client|styles)/, "").replace(/\.ts$/, ".js");
}

/**
 * `changed`: repo paths the change touched. `sources`: every file under src/
 * with its text, which is where a page, script or stylesheet names another.
 */
export function reach(changed: string[], sources: Map<string, string>): Reach {
  const pages = new Set<string>();
  for (const file of changed) {
    if (INERT.some((re) => re.test(file))) continue;
    if (/^src\/pages\/.*\.html$/.test(file)) {
      pages.add(pageOf(file));
      continue;
    }
    if (!/^src\/(client|styles)\//.test(file)) return { all: `${file} can reach any page` };
    // Walk from the changed asset out to the pages that load it.
    const seen = new Set([file]);
    for (const asset of seen) {
      const base = asset.slice(asset.lastIndexOf("/") + 1);
      const names = [servedAt(asset), `/${base}"`, `/${base}'`, `"${base}"`, `'${base}'`];
      let named = false;
      for (const [path, text] of sources) {
        if (path === asset || !names.some((n) => text.includes(n))) continue;
        named = true;
        if (path.startsWith("src/pages/")) pages.add(pageOf(path));
        else if (/^src\/(client|styles)\//.test(path)) seen.add(path);
        else return { all: `${path} names ${asset}` };
      }
      // Nothing names it, so something loads it by a name this can't see.
      if (!named) return { all: `nothing under src/ names ${asset}` };
    }
  }
  return { pages: [...pages].sort() };
}
