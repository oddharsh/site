// controls.ts: the defect each guard exists to catch, written down so it can be
// planted again.
//
// Every check in this repo makes two claims: it passes on a good tree, and it
// fails on the defect it guards. `validate` re-tests the first claim on every
// PR. The second was tested once, by hand, in the PR that added the check (20
// commit bodies carry a "Controls:" paragraph), and never again. Checks drift
// blind in between: invariant 8c walked 0 of 39 pages for 60 days, the
// conflict-marker scan read 0 of serendipity's 3 files for 55, and the
// taskbar-floor check compared nothing for a day while every build printed a
// warning (gotchas 79 and 80). Each was found by luck (gotcha 90).
//
// A control is that hand-run proof made permanent: a mutation that plants the
// defect, the check that must catch it, and the words it must say when it
// does. `bun run controls` plants each one in a copy-on-write clone of the tree
// (never the tree itself; other sessions work in it) and fails if a check
// passes with its defect in place. contract-controls-still-apply runs in
// `validate` and fails when a mutation's anchor text has moved, so a refactor
// that strands a control has to update it in the same PR.
//
// Adding one: write the edit that reintroduces the bug, run
// `bun run controls -- <id>`, and copy the line the check prints into `expect`.
// An `expect` that matches any failure is a control that can't tell a crash
// from a catch, so quote the check's own words.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Mutation =
  /** Replace `find` with `replace`. `find` must occur exactly once. */
  | { file: string; find: string; replace: string }
  /** Create `file` (it must not exist yet). */
  | { file: string; create: string };

export interface Control {
  /** kebab-case, unique; the CLI filters on substrings of it */
  id: string;
  /** the defect, in one sentence */
  plants: string;
  /** the gotcha this guards, when there is one */
  gotcha?: number;
  mutations: Mutation[];
  /** the check, as argv, run from the clone's root */
  run: string[];
  /** must match the failing check's combined output */
  expect: RegExp;
}

/**
 * Plant `c`'s mutations under `root`, or with `dryRun` only report the ones
 * that no longer apply. Returns the problems; an empty list means every anchor
 * matched exactly once and every file to create was absent.
 */
export function plant(root: string, c: Control, dryRun = false): string[] {
  const problems: string[] = [];
  for (const m of c.mutations) {
    const path = join(root, m.file);
    if ("create" in m) {
      if (existsSync(path)) problems.push(`${m.file} already exists, so creating it plants nothing`);
      else if (!dryRun) writeFileSync(path, m.create);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`${m.file} is gone`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const n = text.split(m.find).length - 1;
    if (n !== 1) problems.push(`${m.file} holds the anchor ${n} times (wants 1): ${JSON.stringify(m.find.slice(0, 60))}`);
    else if (!dryRun)
      writeFileSync(
        path,
        text.replace(m.find, () => m.replace),
      );
  }
  return problems;
}

export const BUILD = ["bun", "tools/build.ts"];
const contract = (name: string) => ["bun", "test", "--preload", "./tools/lib/no-network.ts", "--timeout=30000", `tools/tests/${name}.test.ts`];

export const CONTROLS: Control[] = [
  {
    id: "conflict-marker-in-garage-page",
    plants: "a rebase leaves a conflict marker in a served page (the 2026-07-27 compression.html residue)",
    mutations: [
      {
        file: "src/pages/garage/compression.html",
        find: '<script type="application/json" id="luq-data">',
        replace: '<<<<<<< HEAD\n<script type="application/json" id="luq-data">',
      },
    ],
    run: BUILD,
    expect: /compression\.html:\d+: git conflict marker in a served file/,
  },
  {
    id: "conflict-marker-in-serendipity",
    plants: "a conflict marker in serendipity/, the root the scan read 0 files of while it looked for .js",
    gotcha: 79,
    // Inside a template literal, so the module still parses and only the scan
    // can catch it. Planted as bare code, Bun's parser failed the build first,
    // which read WRONG REASON on the tree before #1390 instead of BLIND.
    mutations: [
      {
        file: "serendipity/serendipity.ts",
        find: '  return `<!doctype html><html lang="en"><head>',
        replace: '  return `<!doctype html><html lang="en"><head>\n<<<<<<< HEAD',
      },
    ],
    run: BUILD,
    expect: /serendipity\/serendipity\.ts:\d+: git conflict marker in a served file/,
  },
  {
    id: "unregistered-garage-page",
    plants: "a new garage page with no site-manifest.json entry",
    gotcha: 79,
    mutations: [{ file: "src/pages/garage/control-probe.html", create: "<!doctype html><title>probe</title><p>probe</p>\n" }],
    run: BUILD,
    expect: /\/garage\/control-probe exists on disk but is not registered in site-manifest\.json/,
  },
  {
    id: "taskbar-floor-disagrees",
    plants: "cal's copy of the taskbar floor drifts from luna.css (30px to 28px)",
    gotcha: 80,
    mutations: [
      {
        file: "cal/src/templates.ts",
        find: "height: calc(100dvh - 30px - env(safe-area-inset-bottom, 0px));",
        replace: "height: calc(100dvh - 28px - env(safe-area-inset-bottom, 0px));",
      },
    ],
    run: BUILD,
    expect: /taskbar-floor disagrees across the critical-geometry copies/,
  },
  {
    id: "serendipity-min-sentinel-renamed",
    plants: "an edit to the /*min*/ sentinel, so the Worker CSS pass skips Serendipity's literal",
    mutations: [{ file: "serendipity/serendipity.ts", find: "  return `/*min*/", replace: "  return `/*MIN*/" }],
    run: BUILD,
    expect: /worker CSS: found only 0 \/\*min\*\/ literals under serendipity/,
  },
  {
    id: "design-imports-fonts-css",
    plants: "design/styles.css imports tokens/fonts.css again, hiding the installed Bold and Italic faces",
    gotcha: 88,
    // Built, like the citation below: written out, the import would trip
    // the fonts check on the unplanted tree.
    mutations: [{ file: "design/styles.css", find: '@import "tokens/bevels.css";', replace: `@import "tokens/bevels.css";\n@import "tokens/${"fonts"}.css";` }],
    run: contract("contract-design-fonts-stay-unloaded"),
    expect: /@import of tokens\/fonts\.css/,
  },
  {
    id: "web-font-in-luna",
    plants: "luna.css downloads a face through @font-face url(), breaking the zero-font-bytes law",
    mutations: [
      {
        file: "src/styles/luna.css",
        find: '@property --taskbar-h{syntax:"<length>";inherits:true;initial-value:30px}',
        replace: '@property --taskbar-h{syntax:"<length>";inherits:true;initial-value:30px}\n@font-face{font-family:Probe;src:url(/probe.woff2)}',
      },
    ],
    run: BUILD,
    expect: /luna\.css: @font-face with url\(\)/,
  },
  {
    id: "worker-module-imports-cloudflare-workers",
    plants: "a Worker module other than the entrypoint imports cloudflare:workers",
    gotcha: 16,
    mutations: [{ file: "src/worker/lib/control-probe.ts", create: 'import { env } from "cloudflare:workers";\nexport const probe = env;\n' }],
    run: contract("contract-census-never-publishes-a-refused-check"),
    expect: /cloudflare:workers may only be imported where workerd is the only loader/,
  },
  {
    id: "dangling-gotcha-citation",
    plants: "a comment cites a gotcha number with no entry",
    mutations: [
      {
        file: "tools/lib/clone-tree.ts",
        find: "// clone-tree.ts: copy a whole directory tree with one clonefile(2) call.",
        // Built, never written out: the literal citation in this file would
        // trip the same check on the unplanted tree. It hid until this file
        // was tracked, since that check greps tracked files only.
        replace: `// clone-tree.ts: copy a whole directory tree with one clonefile(2) call (gotcha ${999}).`,
      },
    ],
    run: contract("contract-gotcha-numbers-resolve"),
    expect: /references to gotchas that do not exist: .*999/,
  },
  {
    id: "em-dash-in-quiz",
    plants: "an em dash in a quiz question, which the house voice bans",
    gotcha: 32,
    mutations: [
      {
        file: "src/pages/garage/compression.html",
        find: 'and gets \\"gzip, br\\". What does that value tell you?"',
        replace: 'and gets \\"gzip, br\\" — what does that value tell you?"',
      },
    ],
    run: ["bun", "tools/check-page-contracts.ts"],
    expect: /contains em dashes/,
  },
  {
    id: "new-type-error",
    plants: "a fresh type error in a Worker module, past the ratcheted baseline",
    mutations: [{ file: "src/worker/lib/control-probe.ts", create: "export const probe: number = 'not a number';\n" }],
    run: ["bun", "run", "typecheck"],
    expect: /control-probe\.ts: 1 error\(s\), and the baseline has none for it/,
  },
];
