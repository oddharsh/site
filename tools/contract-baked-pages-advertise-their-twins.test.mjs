// ── Every built page with a Markdown twin advertises it ─────────────────────
// Until 2026-09-30 the pages build step 5b bakes (/whoareyou, /around,
// /security, /garage/dyno, /ledger, /inbox, /reading, /lens/census, /search,
// /lens, /serendipity, /coffee, the /writing folder) carried no
// `<link rel="alternate" type="text/markdown">` and no "Read this as Markdown"
// task, while their twins answered at `.md`. build.ts imported staged Worker
// modules at step 1d, so lib/twins.ts was evaluated empty long before step 1g2
// wrote the real list into it, and the `?build=` query on each later import
// reached the entry module alone. Five pages rendered before 1g2 (/photos,
// /bot, /cota-wec, /updates, /restore) had the link and a pane without the task.
//
// Three things hold it now: 5b runs in its own process
// (tools/bake-worker-pages.ts), 1g2 adds the task to a pane it did not draw,
// and build.ts checks every staged page against the twins it actually wrote
// (tools/lib/twin-links.ts). This file pins the premise, the check and the
// wiring.
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, readFile, ROOT, test } from "./contract-shared.ts";
import { lunaPage } from "../src/worker/lib/chrome.ts";
import { unsafeHtml } from "../src/worker/lib/html.ts";
import { TWIN_PATHS } from "../src/worker/lib/twins.ts";
import { hasAlternateLink, paneOffersTwin, routeOf, twinHref, twinLinkProblems } from "./lib/twin-links.ts";

const src = (rel) => readFile(new URL(rel, ROOT), "utf8");

test("the premise: a query re-evaluates an entry module and none of its imports, and a new process sees the rewrite", async () => {
  // canonical root (gotcha 45), though nothing here compares a path
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "twin-graph-")));
  try {
    const dep = path.join(dir, "dep.mjs");
    const entry = path.join(dir, "entry.mjs");
    await writeFile(dep, "export const LIST = [];\n");
    await writeFile(entry, 'import { LIST } from "./dep.mjs";\nexport const count = LIST.length;\n');
    const url = pathToFileURL(entry).href;

    assert.equal((await import(url + "?build=1")).count, 0);
    await writeFile(dep, 'export const LIST = ["/whoareyou"];\n');
    // The trap: a fresh entry URL, a stale import underneath it.
    assert.equal((await import(url + "?build=2")).count, 0, "the runtime now re-reads imports under a new query; the fresh-process bake is still right, but revisit why it exists");

    const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(url)}).then((m) => console.log(m.count))`], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the check reads twins from what the build wrote, so an empty TWIN_PATHS fails it", async () => {
  // The committed lib/twins.ts is the empty list the stale bake saw.
  assert.deepEqual(TWIN_PATHS, []);
  const stale = await lunaPage({ title: "t", route: "/whoareyou", body: unsafeHtml('<div class="content"><p>x</p></div>') }).text();
  const problems = twinLinkProblems([{ rel: "whoareyou.html", html: stale }], ["/whoareyou"]);
  assert.deepEqual(problems, [
    'whoareyou.html: no <link rel="alternate" type="text/markdown" href="/whoareyou.md">',
    "whoareyou.html: its explorer pane does not offer /whoareyou.md",
  ]);
  // The control: the same page is clean when no twin was written for it.
  assert.deepEqual(twinLinkProblems([{ rel: "whoareyou.html", html: stale }], []), []);
});

test("the check accepts both the rendered and the minified shapes, and only in <head>", () => {
  const quoted = '<html><head><link rel="alternate" type="text/markdown" title="markdown source" href="/bot.md"></head><body>'
    + '<div class="axp-tasks"><aside class="axp-pane"><section class="axp-group"><h2>Object tasks</h2><ul><li><a href="/bot.md">Read this as Markdown</a></li></ul></section></aside></div></body>';
  const minified = '<head><link title="markdown source" href=/bot.md rel=alternate type=text/markdown><body>'
    + '<div class=axp-tasks><aside class=axp-pane><section class=axp-group><h2>Object tasks</h2><ul><li><a href=/bot.md>Read this as Markdown</a></ul></section></aside></div>';
  for (const html of [quoted, minified]) {
    assert.equal(hasAlternateLink(html, "/bot.md"), true);
    assert.equal(paneOffersTwin(html, "/bot.md"), true);
    assert.deepEqual(twinLinkProblems([{ rel: "bot.html", html }], ["/bot"]), []);
  }
  // Controls: the link in <body> is no advertisement, a pane without the task is
  // a problem, a page with no pane owes only the link, and the wrong href is not
  // the twin.
  assert.equal(hasAlternateLink('<head></head><body><link rel="alternate" type="text/markdown" href="/bot.md">', "/bot.md"), false);
  assert.equal(hasAlternateLink(quoted, "/photos.md"), false);
  assert.equal(paneOffersTwin(quoted.replace('<li><a href="/bot.md">Read this as Markdown</a></li>', ""), "/bot.md"), false);
  assert.equal(paneOffersTwin('<head></head><body><p>no pane</p>', "/bot.md"), null);

  assert.equal(routeOf("index.html"), "/");
  assert.equal(routeOf("writing/index.html"), "/writing");
  assert.equal(routeOf("lens/census.html"), "/lens/census");
  assert.equal(twinHref("/"), "/index.md");
  assert.equal(twinHref("/lens/census"), "/lens/census.md");
});

test("build.ts bakes 5b in a fresh process, completes the panes 1g2 did not draw, and checks every page", async () => {
  const build = await src("tools/build.ts");
  // a child process either way: spawnSync until 2026-10-08, then spawn, started
  // early beside steps 1h to 4 (contract-the-early-bake-writes-only-where-it-is-told)
  assert.match(build, /spawn(?:Sync)?\(process\.execPath, \["tools\/bake-worker-pages\.ts", OUT/);
  // An in-process import of the bake would put it back in the stale graph.
  assert.doesNotMatch(build, /import\([^)]*bake-worker-pages/);
  assert.doesNotMatch(build, /import[^;]*from "\.\/bake-worker-pages/);
  // No 5b renderer is imported by build.ts itself any more.
  for (const mod of ["whoareyou", "dyno", "security", "search", "lens", "run", "writing", "ledger", "around", "inbox", "census", "reading"]) {
    assert.doesNotMatch(build, new RegExp(`src/worker/${mod}\\.ts\`?\\)\\)\\.href`), `build.ts imports the ${mod} renderer in-process again`);
  }
  assert.match(build, /twinLinkProblems\(pages, twinRoutes\)/);
  assert.match(build, /taskRow\(\{ href: twin, label: "Read this as Markdown"/);

  const bake = await src("tools/bake-worker-pages.ts");
  assert.ok(!/\+ nonce|\?build=\$\{/.test(bake), "a fresh process needs no cache-busting query; one here means somebody is importing it in-process again");
  assert.match(bake, /twinFor\("\/coffee"\)/);
});

test("the three renderers with their own <head> ask lib/twins.ts too", async () => {
  assert.match(await src("serendipity/serendipity.ts"), /const twin = twinFor\(currentPath\)/);
  assert.match(await src("src/worker/writing.ts"), /const twin = twinFor\(o\.path\)/);
  assert.match(await src("src/worker/lib/chrome.ts"), /const twin = route \? twinFor\(route\) : null/);
});
