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

  // ── release-path and runtime guards ────────────────────────────────────────
  // Each of these fails quietly in production: a double-encoded body, a config
  // wrangler refuses to boot, a cron that dies at the 51st subrequest, a write
  // on a preview URL or a replayed 0-RTT GET.
  {
    id: "encodebody-dropped-in-workerd",
    plants: "security.ts's noindex rebuild stops carrying encodeBody, so a precompressed body on the image bail is brotli twice",
    gotcha: 13,
    // The noindex carry, not the main one: the main rebuild sets the flag again
    // for HTML, so only the svg row (which bails before it) can see this carry go.
    mutations: [
      {
        file: "src/worker/lib/security.ts",
        find: '    if (response.headers.has("content-encoding")) init.encodeBody = "manual";\n    response = new Response(response.body, init);',
        replace: "    response = new Response(response.body, init);",
      },
    ],
    run: contract("contract-encodebody-survives-a-rebuild-in-workerd"),
    expect: /the noindex rebuild double-encoded a body that then took the image bail/,
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
    id: "preview-guard-dropped-from-dispatch",
    plants: "the dispatcher stops calling the preview guard, so a POST on a preview URL reaches its handler",
    mutations: [
      {
        file: "src/worker/dispatch.ts",
        find: "      const denied = previewDenial(url.pathname, request.method);\n      if (denied) return denied;\n",
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
        find: "    const tooEarly = earlyDataDenial(request, url.pathname);\n    if (tooEarly) return tooEarly;\n",
        replace: "",
      },
    ],
    run: contract("contract-the-dispatch-pipeline"),
    expect: /a replayable GET-shaped write is refused in early data/,
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
];
