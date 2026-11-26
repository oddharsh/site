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
import { fileURLToPath } from "node:url";
import { suiteFiles } from "./test-roots.ts";

export type Mutation =
  /** Replace `find` with `replace`. `find` must occur exactly once. */
  | { file: string; find: string; replace: string }
  /** Create `file` (it must not exist yet). The runner marks it
   *  intent-to-add, the way CI sees it committed; `untracked` leaves it out
   *  of the index, the way a local run sees it before `git add` (gotcha 91). */
  | { file: string; create: string; untracked?: boolean };

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
// By name, wherever in the suite the file lives (tools/tests/ or a tests/ beside its module).
const SUITE = suiteFiles(fileURLToPath(new URL("../../", import.meta.url)));
const contract = (name: string) => {
  const file = SUITE.find((rel) => rel.endsWith(`/${name}.test.ts`));
  if (!file) throw new Error(`no contract test named ${name}`);
  return ["bun", "test", "--preload", "./tools/lib/no-network.ts", "--timeout=30000", `./${file}`];
};

// The suite as validate runs it on a pull request: narrowed by the traced input
// map at test-inputs.json (gotcha 111), or whole when there is none.
const NARROWED = ["bun", "tools/test-inputs.ts", "run", "--map", "test-inputs.json"];

export const CONTROLS: Control[] = [
  {
    id: "dictionary-shell-fallback-encoding",
    plants: "the shell identity fallback double-encodes an already compressed response",
    mutations: [{ file: "src/worker/lib/assets.ts", find: 'if (response.headers.has("content-encoding")) init.encodeBody = "manual";', replace: "" }],
    run: contract("contract-encodebody-survives-a-rebuild-in-workerd"),
    expect: /shell identity fallback double-encoded an already compressed response/,
  },
  {
    id: "dictionary-full-digest",
    plants: "two dictionary hashes with the same prefix select the same delta",
    gotcha: 120,
    mutations: [{ file: "src/worker/lib/dictionary-names.ts", find: "export const TAG_HEX = 64;", replace: "export const TAG_HEX = 16;" }],
    run: contract("contract-dictionary-names-agree-between-build-and-worker"),
    expect: /different full digests must not select the same delta/,
  },
  {
    id: "dictionary-fallback-cache",
    plants: "an unknown dictionary fallback can fill the CDN cache with duplicate variants",
    gotcha: 120,
    mutations: [
      { file: "src/worker/lib/assets.ts", find: 'headers.set("cdn-cache-control", "no-store")', replace: 'headers.set("cdn-cache-control", "public")' },
    ],
    run: contract("contract-dictionary-fallbacks-keep-caches-safe"),
    expect: /unknown dictionary must not create a CDN cache variant/,
  },
  {
    id: "dictionary-empty-delta",
    plants: "an empty delta response is labeled dcz",
    gotcha: 120,
    mutations: [
      {
        file: "src/worker/lib/assets.ts",
        find: 'response.ok && response.body !== null && response.headers.get("content-length") !== "0" && !response.headers.has("content-encoding")',
        replace: 'response.ok && !response.headers.has("content-encoding")',
      },
    ],
    run: contract("contract-dictionary-fallbacks-keep-caches-safe"),
    expect: /empty delta must fall back/,
  },
  {
    id: "readable-twin-critical-classes",
    plants: "critical CSS for a readable twin matches authored classes against renamed selectors",
    gotcha: 116,
    mutations: [
      {
        file: "tools/lib/critical-css.ts",
        find: "const subset = await criticalCss(css, matchingHtml, scripts, siblingCss);",
        replace: "const subset = await criticalCss(css, html, scripts, siblingCss);",
      },
    ],
    run: contract("contract-a-non-blocking-page-paints-from-a-subset-of-luna"),
    expect: /the readable twin must carry the served page's critical rules/,
  },
  {
    id: "critical-css-where-is-matching",
    plants: "critical CSS stops expanding :where() and :is() so unused widget rules leak into every subset",
    mutations: [
      {
        file: "tools/lib/critical-css.ts",
        find: 'if (!isElement && (name === "where" || name === "is")) {',
        replace: "if (false) {",
      },
    ],
    run: contract("contract-a-non-blocking-page-paints-from-a-subset-of-luna"),
    expect: /unused :where\(\) rule must be dropped/,
  },
  {
    id: "critical-css-root-pruning",
    plants: "critical CSS stops pruning unreferenced :root custom properties",
    mutations: [
      {
        file: "tools/lib/critical-css.ts",
        find: "return pruneRootVars(keep(luna), `${html}\\n${scriptSrc}\\n${extraRefs}`, scriptWords);",
        replace: "return keep(luna);",
      },
    ],
    run: contract("contract-a-non-blocking-page-paints-from-a-subset-of-luna"),
    expect: /--dead:#222/,
  },
  {
    id: "static-page-twin-cache-policy",
    plants: "the Access page rule stops matching its precompressed document",
    mutations: [{ file: "public/_headers", find: "/access/index.html*", replace: "/access/never-index.html*" }],
    run: contract("contract-the-speculation-ledger"),
    expect: /access\/index\.html\.br: no _headers rule matches the twin/,
  },
  {
    id: "wasm-twin-serving",
    gotcha: 117,
    plants: "the decoder twin is built but the static asset path no longer admits WASM",
    mutations: [{ file: "src/worker/lib/assets.ts", find: '"js", "css", "wasm"', replace: '"js", "css"' }],
    run: contract("contract-static-text-assets-ship-their-q11-twin"),
    expect: /decoder must use its q11 twin/,
  },
  {
    id: "gallery-url-deferral",
    plants: "every gallery tile exposes its URL to the preload scanner",
    mutations: [{ file: "src/worker/photos.ts", find: "const INITIAL_TILES = 12;", replace: "const INITIAL_TILES = Infinity;" }],
    run: contract("contract-gallery-images-select-existing-tiers"),
    expect: /offscreen tiles must expose no URL to the preload scanner/,
  },
  {
    id: "restore-stage-height",
    plants: "System Restore drops its explicit mobile list height so #srList shifts the page on hydration",
    mutations: [
      {
        file: "src/worker/updates.ts",
        find: ".sr-list{height:170px;max-height:170px}",
        replace: ".sr-list{max-height:170px}",
      },
    ],
    run: contract("contract-restore-reserves-stage-height"),
    expect: /phone \.sr-list must reserve explicit height before hydration/,
  },
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
    id: "homepage-reads-an-undefined-token",
    plants: "the homepage's inline :root drops a colour token its first-paint CSS reads, so that colour paints at the browser default until luna.css lands",
    mutations: [{ file: "src/pages/index.html", find: "  --ink:oklch(21.78% 0 0);\n", replace: "" }],
    run: contract("contract-type-comes-from-the-tokens"),
    expect: /reads var\(--ink\) but its inline :root does not define it/,
  },
  {
    id: "parser-pause-before-the-first-fold",
    plants: "the parser pause ignores a page's rel=expect first fold, so /garage's first paint waits for the pause's stylesheet",
    mutations: [{ file: "tools/lib/parser-pause.ts", find: " && (!afterFirstFold || b.afterFold)", replace: "" }],
    run: contract("contract-long-pages-pause-below-the-screen"),
    expect: /garage\/index\.html: the pause sits before the end of the first fold/,
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
    id: "av2-page-keeps-a-stale-tier-median",
    plants: "/garage/av2 states the 600px tier's median from before #1222 removed 93 photos, the drift this check was added for",
    mutations: [{ file: "src/pages/garage/av2.html", find: "the median, 0.53,", replace: "the median, 0.67," }],
    run: contract("contract-av2-tier-figures-match-the-shipped-tier"),
    expect: /the thin end, tier size and median must match the shipped 600px tier/,
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
    id: "footnote-href-drift",
    plants: "a footnote whose marker href no longer matches its note, so the hover bubble shows stale text",
    mutations: [
      {
        file: "src/pages/control-footnote.html",
        create: '<p>Body<a class="note-ref" href="#Old note.">1</a>.</p><ol class="footnotes"><li id="New note.">New note.</li></ol>\n',
      },
    ],
    run: ["bun", "tools/check-page-contracts.ts"],
    expect: /footnote marker 1's href "#Old note\." doesn't match footnote 1's id "New note\."/,
  },
  {
    id: "new-type-error",
    plants: "a fresh type error in a Worker module, past the ratcheted baseline",
    mutations: [{ file: "src/worker/lib/control-probe.ts", create: "export const probe: number = 'not a number';\n" }],
    run: ["bun", "run", "typecheck"],
    expect: /control-probe\.ts: 1 error\(s\), and the baseline has none for it/,
  },

  // ── release-path and runtime guards ────────────────────────────────────────
  // Each of these fails quietly in production: a double-encoded body, a config
  // wrangler refuses to boot, a cron that dies at the 51st subrequest, a write
  // on a preview URL or a replayed 0-RTT GET.
  {
    id: "encodebody-dropped-in-workerd",
    plants: "security.ts's noindex rebuild stops carrying encodeBody, so a precompressed body is brotli twice",
    gotcha: 13,
    // The noindex carry, not the main one. A Worker-built response is stamped in
    // place after it, so nothing sets the flag again and the html noindex row is
    // the first to see this carry go (the svg row sees it on the image bail).
    mutations: [
      {
        file: "src/worker/lib/security.ts",
        find: '    if (response.headers.has("content-encoding")) init.encodeBody = "manual";\n    response = new Response(response.body, init);',
        replace: "    response = new Response(response.body, init);",
      },
    ],
    run: contract("contract-encodebody-survives-a-rebuild-in-workerd"),
    expect: /the noindex rebuild double-encoded a precompressed body/,
  },
  {
    id: "encodebody-dropped-at-a-call-site",
    plants: "the same dropped carry, read by the walker that holds every rebuild site in the source to a safe shape",
    gotcha: 13,
    mutations: [
      {
        file: "src/worker/lib/security.ts",
        find: '    if (response.headers.has("content-encoding")) init.encodeBody = "manual";\n    response = new Response(response.body, init);',
        replace: "    response = new Response(response.body, init);",
      },
    ],
    run: contract("contract-the-speculation-ledger"),
    expect: /a Response rebuilt from another response's body with an object init drops encodeBody/,
  },
  {
    id: "run-worker-first-unfolded",
    plants: "the route list stops honoring folds, so every exact route claims its own row and the allowlist passes wrangler's 100",
    gotcha: 26,
    mutations: [
      {
        file: "src/worker/routes.ts",
        find: "const claimsOf = (r: ExactRoute) => r.claim ?? [r.path];",
        replace: "const claimsOf = (r: ExactRoute) => [r.path];",
      },
    ],
    run: contract("contract-the-route-list-derives-every-route-list"),
    expect: /\d+ rows: wrangler refuses to boot past 100/,
  },
  {
    id: "around-and-webmention-share-a-tick",
    plants: "the /around crawl and webmention-send share one cron tick again, 80 subrequests against a cap of 50",
    gotcha: 36,
    mutations: [{ file: "src/worker/lib/cron.ts", find: 'if (sig === "53 5") return "webmention_send";', replace: 'if (sig === "53 5") return "around";' }],
    run: contract("contract-no-cron-tick-outspends-the-subrequest-cap"),
    expect: /around should run on exactly one configured tick/,
  },
  {
    id: "around-robots-gate-outside-try",
    plants: "the /around robots gate moves back outside its try, so one neighbor's spent budget rejects the whole crawl",
    gotcha: 36,
    mutations: [
      { file: "src/worker/around.ts", find: '        const gate = await span("around.robots_gate", () => botRobotsPolicy(url, env));\n', replace: "" },
      {
        file: "src/worker/around.ts",
        find: "      const t0 = Date.now();\n      try {\n        // honor robots.txt first.",
        replace:
          '      const t0 = Date.now();\n      const gate = await span("around.robots_gate", () => botRobotsPolicy(url, env));\n      try {\n        // honor robots.txt first.',
      },
    ],
    run: contract("contract-no-cron-tick-outspends-the-subrequest-cap"),
    expect: /cronAround rejected \(Too many subrequests for this job.s ledger.*\): one neighbor.s refused subrequest must not reject the whole crawl/,
  },
  {
    id: "webmention-discovery-unmetered",
    plants: "discoverEndpoint's redirect follower loses the metered transport, so its hops escape the ledger",
    gotcha: 36,
    mutations: [
      {
        file: "src/worker/webmention-send.ts",
        find: "      20,\n      transport,\n    ); // Preserve native fetch's redirect allowance.",
        replace: "      20,\n    ); // Preserve native fetch's redirect allowance.",
      },
    ],
    run: contract("contract-no-cron-tick-outspends-the-subrequest-cap"),
    expect: /expected exactly one refused target, got none/,
  },
  {
    id: "lens-compare-without-a-board",
    plants: "compareLensTargets stops passing the discovery board, so both cold sides run live and bill 72 subrequests",
    gotcha: 36,
    mutations: [
      {
        file: "src/worker/lens.ts",
        find: "lensInspect(url, env, { skipBotViews: opts.skipBotViews !== false, board, side })",
        replace: "lensInspect(url, env, { skipBotViews: opts.skipBotViews !== false, side })",
      },
    ],
    run: contract("contract-lens-compare-stays-under-the-subrequest-cap"),
    expect: /cold compare spent 72 subrequests/,
  },
  {
    id: "preview-deny-becomes-a-list",
    plants: "preview.ts's default-deny becomes a list of today's POST routes, so tomorrow's route writes production from a preview",
    // Every route the test names today is on the list, so only default-deny
    // itself is missing: the one path the guard has never heard of gets through.
    mutations: [
      {
        file: "src/worker/lib/preview.ts",
        find: "  if (!safeMethod && !SAFE_UNSAFE_METHODS.has(pathname)) {",
        replace: '  if (!safeMethod && ["/book", "/webmention", "/search", "/serendipity/sync"].includes(pathname)) {',
      },
    ],
    run: contract("contract-workers-preview-urls"),
    expect: /POST \/a-route-invented-tomorrow must be refused on a preview/,
  },
  {
    id: "gloss-pass-cached-without-the-marked-terms",
    plants: "glossify's alternation cache keys on `only` alone, so a pass built before any term was marked keeps matching marked terms",
    mutations: [
      {
        file: "src/worker/lens.ts",
        find: '  const id = (only ? only.join(",") : "*") + "|" + [...seen].sort().join(",");\n',
        replace: '  const id = only ? only.join(",") : "*";\n',
      },
    ],
    run: contract("contract-lens-glossary-and-robots-compile-once"),
    expect: /glossify marks each term once, longest spelling first, and honours `only`/,
  },
  {
    id: "robots-matcher-shared-across-rules",
    plants: "the robots matcher cache keys on nothing, so every rule tests the first rule's pattern",
    mutations: [
      {
        file: "src/worker/lib/robots.ts",
        find: "  let match = RULE_MATCHERS.get(rule);\n  if (!match) RULE_MATCHERS.set(rule, (match = compilePattern(rule.pattern)));\n",
        replace: "  let match = RULE_MATCHERS.get(RULE_MATCHERS);\n  if (!match) RULE_MATCHERS.set(RULE_MATCHERS, (match = compilePattern(rule.pattern)));\n",
      },
    ],
    run: contract("contract-lens-glossary-and-robots-compile-once"),
    expect: /one parsed robots.txt answers every path and bot by its own rules/,
  },
  {
    id: "route-reparses-the-request-url",
    plants: "serveWorkerRequest parses request.url again instead of taking the URL the entry already parsed",
    mutations: [
      {
        file: "src/worker/dispatch.ts",
        find: "    // Read before routing: handlers get this same URL object and may rewrite it\n",
        replace: "    url = new URL(request.url);\n    // Read before routing: handlers get this same URL object and may rewrite it\n",
      },
    ],
    run: contract("contract-the-dispatch-pipeline"),
    expect: /a request handed its URL is not parsed again on the way to its handler/,
  },
  {
    id: "intl-object-built-at-module-scope",
    plants: "guestbook.ts builds its Intl.Segmenter at module scope again, so ICU loads on every isolate's startup",
    gotcha: 92,
    mutations: [
      {
        file: "src/worker/guestbook.ts",
        find: "let graphemes: Intl.Segmenter | undefined;\n",
        replace: "let graphemes: Intl.Segmenter | undefined = new Intl.Segmenter();\n",
      },
    ],
    run: contract("contract-no-intl-object-at-module-scope"),
    expect: /importing every Worker module builds no Intl object/,
  },
  {
    id: "preview-guard-dropped-from-dispatch",
    plants: "the dispatcher stops calling the preview guard, so a POST on a preview URL reaches its handler",
    mutations: [
      {
        file: "src/worker/dispatch.ts",
        find: "      const denied = previewDenial(pathname, request.method);\n      if (denied) return denied;\n",
        replace: "",
      },
    ],
    run: contract("contract-the-dispatch-pipeline"),
    expect: /a POST on a preview is refused/,
  },
  {
    id: "early-data-list-copied",
    plants: "early-data.ts keeps its own copy of the GET-write list, which misses the route added after it (/ledger/prefetch)",
    mutations: [
      {
        file: "src/worker/lib/early-data.ts",
        find: "  if (!PREVIEW_GET_WRITES.has(pathname)) return null;",
        replace: '  if (!new Set(["/hit", "/webmention/approve", "/webmention/decline", "/coffee/approve", "/coffee/decline"]).has(pathname)) return null;',
      },
    ],
    run: contract("contract-early-data-and-the-speculation-readback"),
    expect: /\/ledger\/prefetch in early data must be refused/,
  },
  {
    id: "early-data-guard-dropped-from-dispatch",
    plants: "the dispatcher stops calling the early-data guard, so a replayed 0-RTT /hit ticks the counter twice",
    mutations: [
      {
        file: "src/worker/dispatch.ts",
        find: "    const tooEarly = earlyDataDenial(request, pathname);\n    if (tooEarly) return tooEarly;\n",
        replace: "",
      },
    ],
    run: contract("contract-the-dispatch-pipeline"),
    expect: /a replayable GET-shaped write is refused in early data/,
  },
  {
    id: "serendipity-mcp-batch-cap-dropped",
    plants: "the Serendipity MCP server stops capping a JSON-RPC batch, so one POST starts as many D1 queries as fit in 64 KiB",
    mutations: [
      {
        file: "serendipity/serendipity.ts",
        find: "    const refused = mcpBatchRefusal(payload);\n    if (refused) return respond(refused, 413);\n",
        replace: "",
      },
    ],
    run: contract("contract-both-mcp-servers-speak-one-protocol"),
    expect: /serendipity MCP answers a 16-message batch and refuses a 17-message one/,
  },
  {
    id: "declared-deploy-loses-auto-create-pin",
    plants: "infra.json's production deploy_command drops --x-auto-create=false, so a deploy may create Cloudflare resources",
    mutations: [
      {
        file: "config/infra.json",
        find: '"deploy_command": "bash .github/deploy-wrangler.sh deploy --x-provision=false --x-auto-create=false",',
        replace: '"deploy_command": "bash .github/deploy-wrangler.sh deploy --x-provision=false",',
      },
    ],
    run: contract("contract-infra-check-compares-declared-against-observed"),
    expect: /infra\.json's release\.deploy_command must pin --x-auto-create=false/,
  },
  {
    id: "deploy-direct-loses-provision-pin",
    plants: "package.json's deploy:direct drops --x-provision=false, the owner's break-glass publish",
    mutations: [
      {
        file: "package.json",
        find: '"deploy:direct": "wrangler deploy --x-new-config --x-provision=false --x-auto-create=false --strict",',
        replace: '"deploy:direct": "wrangler deploy --x-new-config --x-auto-create=false --strict",',
      },
    ],
    run: contract("contract-infra-check-compares-declared-against-observed"),
    expect: /package\.json scripts\.deploy:direct publishes without --x-provision=false/,
  },
  {
    id: "origin-trial-stamped-on-the-wrong-type",
    plants: "withSecurityHeaders stamps the origin trial tokens on JSON instead of HTML, so no page turns WebMCP on and a JSON route carries a token",
    // One plant, both directions: the nav.js rows lose the header and the
    // /rn/tracks row gains it. routes:check, because only the real router shows
    // what a page is served; the contract test hands withSecurityHeaders a
    // Response it built itself.
    mutations: [
      {
        file: "src/worker/lib/security.ts",
        find: '  if (ct.startsWith("text/html")) {\n    const served = (headers.get("origin-trial")',
        replace: '  if (ct.startsWith("application/json")) {\n    const served = (headers.get("origin-trial")',
      },
    ],
    run: ["bun", "run", "routes:check"],
    expect:
      /\/rn\/tracks +<- origin-trial is present on a response that should carry none[\s\S]*\/garage\/horizon +<- origin-trial is missing a token from ORIGIN_TRIALS|\/garage\/horizon +<- origin-trial is missing a token from ORIGIN_TRIALS[\s\S]*\/rn\/tracks +<- origin-trial is present/,
  },
  {
    id: "served-shell-unminified",
    plants: "build.ts ships a shell script's readable source under the deploy banner, the bypass #1392's size tripwire exists for",
    // One shell, and the banner and marker survive, so only the size row can
    // fail. nav-tips is the row with the least headroom (0.60 of its source on
    // 2026-10-17). Planted on nav.js, the build failed first: the CSS mangler
    // reads a comment in the unminified source as a runtime-built property name.
    mutations: [{ file: "tools/build.ts", find: "  const min = banner + code;", replace: '  const min = banner + (file === "nav-tips.js" ? src : code);' }],
    run: ["bun", "run", "routes:check"],
    expect: /\/nav-tips\.js +<- size \d+B > \d+B, 0\.8 of src\/client\/nav-tips\.ts/,
  },

  // Gotcha 91: a new file before `git add`. Each leaves its file untracked, so
  // it proves the local run sees what CI will see once the file is committed.
  // On 2026-10-29 one plant per converted scan (22) read BLIND 19 times on the
  // tree before the sweep (the bidi scan already read untracked files, and two
  // baselines could not run there) and CAUGHT 22 times after it. Five stay.
  {
    id: "untracked-script-skips-strict-mode",
    plants: "a new shell script, not yet added, without set -euo pipefail",
    gotcha: 91,
    mutations: [{ file: "tools/control-probe.sh", create: "#!/bin/sh\necho probe\n", untracked: true }],
    run: contract("contract-committed-shell-scripts-fail-loudly"),
    expect: /tools\/control-probe\.sh \(missing e, u, pipefail\)/,
  },
  {
    id: "untracked-workflow-floats-its-install",
    plants: "a new workflow, not yet added, whose bun install drops --frozen-lockfile",
    gotcha: 91,
    mutations: [
      {
        file: ".github/workflows/control-probe.yml",
        create: "name: probe\non: push\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun install\n",
        untracked: true,
      },
    ],
    run: contract("contract-every-install-obeys-the-supply-chain-floor"),
    expect: /control-probe\.yml:\d+: - run: bun install/,
  },
  {
    id: "untracked-file-cites-a-missing-gotcha",
    plants: "a new file, not yet added, citing a gotcha with no entry (the git grep half of the sweep)",
    gotcha: 91,
    // Built, like dangling-gotcha-citation above, so this file cites nothing.
    mutations: [{ file: "tools/control-probe.ts", create: `// gotcha ${999}\nexport {};\n`, untracked: true }],
    run: contract("contract-gotcha-numbers-resolve"),
    expect: /references to gotchas that do not exist: .*999/,
  },
  {
    id: "untracked-module-outside-every-program",
    plants: "a new .ts file, not yet added, that no tsconfig names, so the type-aware lint never reads it",
    gotcha: 91,
    mutations: [{ file: "public/control-probe.ts", create: "export const probe = 1;\n", untracked: true }],
    run: ["bun", "run", "typecheck"],
    expect: /public\/control-probe\.ts: belongs to no bun check program/,
  },
  {
    id: "untracked-git-census-reads-the-index",
    plants: "a new check, not yet added, that collects files with bare git ls-files",
    gotcha: 91,
    // Built: written out, the argv would trip the census guard on this file.
    mutations: [
      {
        file: "tools/control-probe.ts",
        create: `import { execFileSync } from "node:child_process";\nexport const probe = execFileSync("git", [${'"ls-files"'}, "-z"], { encoding: "utf8" });\n`,
        untracked: true,
      },
    ],
    run: contract("contract-git-scans-see-untracked-files"),
    expect: /tools\/control-probe\.ts:2: export const probe = execFileSync/,
  },
  {
    id: "verdict-watch-forgets-its-memory-file",
    plants:
      "a verdict watch whose landed sentence no longer names the memory file, so a moved row's issue says what landed but not which decline to re-measure",
    mutations: [{ file: "tools/lib/upstream-watches.ts", find: ".map((w) => ({ ...w, landed:", replace: ".map((w) => ({ ...w, unused:" }],
    run: [...contract("contract-canary-tripwire-proposes-nothing"), "-t", "a verdict watch that moves"],
    expect: /moved and the issue does not name bun-minifier-not-a-swap\.md/,
  },
  {
    id: "head-tag-diff-blind-to-og",
    plants: "the head-tag extractor stops reading og:* tags, so a PR that drops an og:image posts an empty diff",
    gotcha: 90,
    // The diff is advisory and fails on nothing, so blindness is its quiet
    // failure: "No change" reads the same whether the tags matched or went unread.
    mutations: [{ file: "tools/head-snapshot.ts", find: ' || name.startsWith("og:")', replace: "" }],
    run: contract("contract-head-tag-diff-reports-each-changed-tag"),
    expect: /a dropped og:image must be one row/,
  },
  {
    id: "suite-map-restored-on-main",
    plants: "validate restores the test input map on every event, so a push to main runs a narrowed suite",
    mutations: [
      {
        file: ".github/workflows/ci.yml",
        find: "      - name: Restore the test input map\n        if: github.event_name == 'pull_request'\n",
        replace: "      - name: Restore the test input map\n",
      },
    ],
    run: contract("contract-ci-required-gate"),
    expect: /a push to main must find no map and run the whole suite/,
  },
  {
    id: "codeql-skips-a-push-to-tools",
    plants: "CodeQL's push trigger ignores tools/**, so a change to analyzed code ships unscanned",
    mutations: [
      {
        file: ".github/workflows/codeql.yml",
        find: '      - "public/og/**"\n',
        replace: '      - "public/og/**"\n      - "tools/**"\n',
      },
    ],
    run: contract("contract-codeql-skips-only-what-it-never-reads"),
    expect: /tools\/\*\* would skip a push that changes code CodeQL analyzes/,
  },
  {
    id: "critical-css-drops-script-built-rules",
    plants: "the critical-CSS subset stops keeping rules for elements nav.js builds, so /garage shifts when luna.css lands",
    mutations: [
      {
        file: "tools/lib/critical-css.ts",
        find: " || namedInScripts(branch, scriptWords)",
        replace: "",
      },
    ],
    run: contract("contract-a-non-blocking-page-paints-from-a-subset-of-luna"),
    expect: /a rule only the page's scripts can match was dropped/,
  },
  {
    id: "critical-css-adds-a-rule",
    plants: "the critical-CSS subset carries a rule luna.css doesn't, which would change /garage's settled render",
    mutations: [
      {
        file: "tools/lib/critical-css.ts",
        find: "  return pruneRootVars(keep(luna), `${html}\\n${scriptSrc}\\n${extraRefs}`, scriptWords);",
        replace: '  return pruneRootVars(keep(luna), `${html}\\n${scriptSrc}\\n${extraRefs}`, scriptWords) + ".planted{color:red}";',
      },
    ],
    run: BUILD,
    expect: /critical-css: the \/luna\.css subset is not an ordered subset of it/,
  },
  {
    id: "lint-selector-stops-matching",
    plants: "the no-runtime-typeof selector in bunfig.toml matches `void` instead, so typeof checks lint clean",
    mutations: [{ file: "bunfig.toml", find: `selector = "UnaryExpression[operator='typeof']"`, replace: `selector = "UnaryExpression[operator='void']"` }],
    run: contract("contract-lint-selectors"),
    expect: /an anti-slop selector stopped matching at an ordinary path/,
  },
  {
    id: "lint-typeof-override-drops-a-selector",
    plants: "the typeof exemption's copy of the shape selector drifts from the base list, so exempt files may use the name",
    mutations: [
      {
        // The override's copy is the shape selector that closes its list; the base list's is followed by the typeof one.
        file: "bunfig.toml",
        find: '[name=/shape/i]", message = "Rename this symbol for its domain role; `shape` describes structure rather than ownership." },\n]',
        replace: '[name=/shapeless/i]", message = "Rename this symbol for its domain role; `shape` describes structure rather than ownership." },\n]',
      },
    ],
    run: contract("contract-lint-selectors"),
    expect: /the typeof override no longer restates the other three selectors/,
  },
  {
    id: "lint-any-return-selector-stops-matching",
    plants: "the any-return selector looks for `never` instead, so a return annotation holding `any` lints clean",
    mutations: [
      {
        // The base list's copy is the one followed by the typeof selector two lines down.
        file: "bunfig.toml",
        find: 'TSTypeAnnotation:has(TSAnyKeyword)", message = "This return annotation contains `any`, which erases what the body returns. Name the real type, or delete the annotation and let it be inferred." },\n  { selector = ":matches(Identifier, PrivateIdentifier, JSXIdentifier)[name=/shape/i]", message = "Rename this symbol for its domain role; `shape` describes structure rather than ownership." },\n  { selector = "UnaryExpression',
        replace:
          'TSTypeAnnotation:has(TSNeverKeyword)", message = "This return annotation contains `any`, which erases what the body returns. Name the real type, or delete the annotation and let it be inferred." },\n  { selector = ":matches(Identifier, PrivateIdentifier, JSXIdentifier)[name=/shape/i]", message = "Rename this symbol for its domain role; `shape` describes structure rather than ownership." },\n  { selector = "UnaryExpression',
      },
    ],
    run: contract("contract-lint-selectors"),
    expect: /an anti-slop selector stopped matching at an ordinary path/,
  },
  {
    id: "lint-test-sleep-selector-stops-matching",
    plants: "the sleep selector looks for a Promis constructor, so an awaited setTimeout in a test lints clean",
    mutations: [{ file: "bunfig.toml", find: "> :matches(NewExpression[callee.name='Promise']", replace: "> :matches(NewExpression[callee.name='Promis']" }],
    run: contract("contract-lint-selectors"),
    expect: /a sleep or timeout selector stopped matching in a test file/,
  },
  {
    id: "lint-test-timeout-selector-stops-matching",
    plants: "the timeout selector looks for a misspelled key, so a test's raised timeout lints clean",
    mutations: [{ file: "bunfig.toml", find: "Property[key.name=/^(timeout|retry|repeats)$/]", replace: "Property[key.name=/^(timeoutx|retry|repeats)$/]" }],
    run: contract("contract-lint-selectors"),
    expect: /a sleep or timeout selector stopped matching in a test file/,
  },
  {
    id: "test-placed-away-from-what-it-covers",
    plants: "a new tools/tests/ file that imports only src/worker/lib, which belongs in src/worker/lib/tests/",
    mutations: [
      {
        file: "tools/tests/contract-planted-away-from-its-module.test.ts",
        create:
          'import { test } from "./contract-shared.ts";\nimport { asRecord } from "../../src/worker/lib/parse.ts";\ntest("planted", () => void asRecord({}));\n',
      },
    ],
    run: contract("contract-tests-live-beside-what-they-cover"),
    expect: /contract-planted-away-from-its-module\.test\.ts covers src\/worker\/lib\/ alone, so it belongs in src\/worker\/lib\/tests\//,
  },
  {
    id: "served-tree-takes-in-client-tests",
    plants: "the served tree stops skipping src/ tests/ directories, so client tests would ship from the site root",
    mutations: [{ file: "tools/lib/served-tree.ts", find: '(entry.isDirectory() && entry.name === "tests" && root.startsWith("src/"))', replace: "false" }],
    run: contract("contract-tests-live-beside-what-they-cover"),
    expect: /a colocated test would be served/,
  },
  {
    id: "lint-test-fetch-selector-stops-matching",
    plants: "the hand-assigned fetch selector looks for a misspelled property, so a test that replaces globalThis.fetch lints clean",
    mutations: [{ file: "bunfig.toml", find: "MemberExpression.left[property.name='fetch']", replace: "MemberExpression.left[property.name='fetchx']" }],
    run: contract("contract-lint-selectors"),
    expect: /the hand-assigned fetch selector stopped matching in a test file/,
  },
  {
    id: "route-fetch-miss-goes-unrecorded",
    plants: "routeFetch throws on a miss without recording it, so a probe that swallows the throw passes",
    mutations: [{ file: "tools/lib/fetch-routes.ts", find: "      escaped.push(request.url);\n", replace: "" }],
    run: contract("contract-the-network-tripwire"),
    expect: /the miss was thrown but never recorded/,
  },
  {
    id: "lint-reads-an-eslint-config",
    plants: 'an eslint.config.js beside bunfig.toml, which flavor = "eslint" lets apply on top of [lint]',
    gotcha: 104,
    mutations: [{ file: "eslint.config.js", create: "export default [];\n" }],
    run: ["bun", "tools/check-bun-lint.ts"],
    expect: /bun lint should read bunfig\.toml's \[lint\] alone \(gotcha 104\), and `bun lint --doctor` exited 2: error: Key "rules"/,
  },
  {
    id: "lint-flavor-key-dropped",
    plants: 'bunfig.toml loses flavor = "eslint" while an .oxlintrc.json sits above it, as the main checkout\'s does',
    gotcha: 104,
    mutations: [
      { file: "bunfig.toml", find: '\nflavor = "eslint"\n', replace: "\n" },
      { file: ".oxlintrc.json", create: "{}\n" },
    ],
    run: ["bun", "tools/check-bun-lint.ts"],
    expect: /bun lint should read bunfig\.toml's \[lint\] alone \(gotcha 104\), and `bun lint --doctor` exited 1: error: Cannot use the configuration file/,
  },
  {
    id: "hit-retries-a-lost-do-reply",
    plants: "handleHit retries the Counter fetch when its reply is lost, so a visit the DO already counted counts twice",
    mutations: [
      {
        file: "src/worker/counter.ts",
        find: '      return (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;\n    } catch {\n      return null;\n',
        replace:
          '      return (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;\n    } catch {\n      try {\n        const again = env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"));\n        return (await (await again.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;\n      } catch {\n        return null;\n      }\n',
      },
    ],
    // Seeds 1 to 60 inside a 120 s cap; seed 11 caught it in 1.1 s on
    // 2026-11-21 and shrank to 2 events, a counting visit and the lost reply.
    run: ["bun", "tools/sim.ts", "--seed", "1", "--seeds", "60", "--budget", "120", "--stop-on-fail"],
    expect: /FAIL counter: counter double-counted: GET \/hit\S* moved the count by 2/,
  },
  {
    id: "build-memo-key-forgets-an-input",
    plants: "the client-island eraser's cache key drops the island's text, so a warm build ships last build's tooltip.js after an edit",
    mutations: [
      {
        file: "tools/build.ts",
        find: "  const texts = await cache.memoBatch(ERASE, islands, async (missed) => {",
        replace: "  const texts = await cache.memoBatch(ERASE, islands.map(([file]) => [file]), async (missed) => {",
      },
    ],
    run: ["bun", "tools/build-equivalence.ts", "--seed", "1", "--plan", "island"],
    expect: /build-equivalence: step 1 \(island\): the warm \.build differs from a clean build in \d+ files/,
  },
  {
    id: "minify-diff-walks-an-empty-event-pool",
    plants: "the page differential boots serendipity with no events again, so a planted bug in its week filter ships unseen",
    // serendipity:3 flips the week chip's `===` (`l===\`week\``); before the
    // seed, all 4 of serendipity's mutants were missed because events.html
    // answered 503 and the filter had no cards. About 2 minutes: an oxc build
    // and 4 one-page records.
    mutations: [{ file: "tools/check-minify-diff.ts", find: "    await seedSerendipity(await server.getWorker<SeedEnv>().getEnv());\n", replace: "" }],
    run: ["node", "tools/check-minify-diff.ts", "catch", "serendipity:3", "--only", "/serendipity", "--build"],
    expect: /catch: missed serendipity:3 on \/serendipity/,
  },
  {
    id: "contract-shared-imports-a-worker-module",
    plants: "contract-shared.ts re-exports a Worker module again, so every test's trace reads it and a change there reruns the suite",
    gotcha: 111,
    mutations: [
      {
        file: "tools/tests/contract-shared.ts",
        find: 'import test from "node:test";\n',
        replace: 'import test from "node:test";\nexport { handleTool } from "../../src/worker/terminal.ts";\n',
      },
    ],
    run: contract("contract-the-shared-test-helpers-import-nothing-from-the-repo"),
    expect: /contract-shared\.ts imports \.\.\/\.\.\/src\/worker\/terminal\.ts, which makes every test an input of it \(gotcha 111\)/,
  },
  // The next three plant a defect in one route handler each and run the suite
  // the way validate does on a PR: narrowed by the traced input map. Each
  // handler reaches 1 to 6 test files since gotcha 111, so a selection that
  // dropped the one test pinning it would pass here. In the controls job the
  // map is the nightly one; with no map, `run` falls back to the whole suite,
  // which proves only that the test catches the defect.
  {
    id: "coffee-availability-answers-503-with-slots",
    plants: "the /coffee/availability.json handler answers 503 when slots are open, so the booking widget reads the calendar as down",
    gotcha: 111,
    mutations: [{ file: "src/worker/coffee.ts", find: "const status = payload.available ? 200 : 503;", replace: "const status = 503;" }],
    run: NARROWED,
    expect:
      /contract-site-search-photo-query-and-the-utility-shells\.test\.ts: [\s\S]*\(fail\) coffee availability reuses the booking slot calculation and returns a safe shape/,
  },
  {
    id: "run-error-echoes-the-command-unescaped",
    plants: "the /run handler prints an unknown command into its error without escaping it, so ?cmd=<script> runs",
    gotcha: 111,
    mutations: [{ file: "src/worker/run.ts", find: "<b>Windows cannot find '${esc(cmd)}'.</b>", replace: "<b>Windows cannot find '${cmd}'.</b>" }],
    run: NARROWED,
    expect: /contract-run-opens-any-page\.test\.ts: [\s\S]*\(fail\) a miss keeps the Run error and offers a filled-in search/,
  },
  {
    id: "inbox-mail-prints-the-author-unescaped",
    plants: "the /inbox mail island prints a webmention's author without escaping it, so a sender's name can carry markup",
    gotcha: 111,
    mutations: [
      {
        file: "src/worker/inbox.ts",
        find: '<span class="oe-from">${esc(m.author || "someone")}</span>',
        replace: '<span class="oe-from">${m.author || "someone"}</span>',
      },
    ],
    run: NARROWED,
    expect: /contract-inbox-and-census-are-built-documents\.test\.ts: [\s\S]*\(fail\) the two islands carry the marker and their cache policies/,
  },
];
