// bake-worker-pages.ts, build step 5b: render the deterministic Worker pages
// into the staged static tree. They keep their canonical renderers as the sole
// HTML source; the build invokes those renderers after every staged rewrite,
// then the ordinary hashing and page precompression passes treat the results
// exactly like garage/LWE documents.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { siteConfig } from "./lib/site-config.ts";

const OUT = process.argv[2] ?? ".build";
const PAGES = process.argv[3] ?? `${OUT}/public`;
await mkdir(`${PAGES}/garage`, { recursive: true });

const root = resolve(OUT, "public");
const assets = {
  async fetch(input) {
    const url = new URL(new Request(input).url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!rel || rel.includes("..")) return new Response("not found", { status: 404 });
    try {
      const bytes = await readFile(resolve(root, rel));
      const type = rel.endsWith(".json") ? "application/json" : rel.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream";
      return new Response(bytes, { headers: { "content-type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};
const lens = await import(pathToFileURL(resolve(OUT, "src/worker/lens.ts")).href);
const run = await import(pathToFileURL(resolve(OUT, "src/worker/run.ts")).href);
const search = await import(pathToFileURL(resolve(OUT, "src/worker/search.ts")).href);
const writing = await import(pathToFileURL(resolve(OUT, "src/worker/writing.ts")).href);

const lensResponse = lens.renderLensShell();
if (lensResponse.status !== 200) throw new Error(`static /lens renderer returned ${lensResponse.status}`);
await writeFile(`${PAGES}/lens.html`, await lensResponse.text());

const runResponse = run.renderRun();
if (runResponse.status !== 200) throw new Error(`static /run renderer returned ${runResponse.status}`);
const runHtml = await runResponse.text();
if (!runHtml.includes('form action="/run"')) throw new Error("static /run renderer lost its no-JS form");
await writeFile(`${PAGES}/run.html`, runHtml);

const searchResponse = search.renderSearchPage();
if (searchResponse.status !== 200) throw new Error(`static /search renderer returned ${searchResponse.status}`);
const searchHtml = await searchResponse.text();
if (!searchHtml.includes('form method="get" action="/search"')) throw new Error("static /search renderer lost its blank search form");
await writeFile(`${PAGES}/search.html`, searchHtml);
const security = await import(pathToFileURL(resolve(OUT, "src/worker/security.ts")).href);
const securityResponse = security.renderSecurityCenter();
if (securityResponse.status !== 200) throw new Error(`static /security renderer returned ${securityResponse.status}`);
const securityHtml = await securityResponse.text();
for (const key of ["colo", "httpProtocol", "tlsVersion"]) {
  if (!securityHtml.includes(`data-sc="${key}"`)) throw new Error(`static /security renderer lost its ${key} placeholder`);
}
if (!securityHtml.includes('fetch("/security.json"')) throw new Error("static /security renderer lost the script that fills its connection values");
await writeFile(`${PAGES}/security.html`, securityHtml);
const whoareyou = await import(pathToFileURL(resolve(OUT, "src/worker/whoareyou.ts")).href);
const whoareyouResponse = whoareyou.renderWhoareyouPage();
if (whoareyouResponse.status !== 200) throw new Error(`static /whoareyou renderer returned ${whoareyouResponse.status}`);
const whoareyouHtml = await whoareyouResponse.text();
const valuesUrl = whoareyou.VALUES_URL;
if (!whoareyouHtml.includes(`data-island="${valuesUrl}"`)) throw new Error("static /whoareyou renderer lost its values island");
if (!whoareyouHtml.includes(`rel="preload" as="fetch" href="${valuesUrl}" crossorigin`)) throw new Error("static /whoareyou renderer lost the preload for its values island");
if (!whoareyouHtml.includes('querySelectorAll("[data-island]")')) throw new Error("static /whoareyou renderer lost the island loader");
if (/TLSv1\.[23]|\d{4}-\d\d-\d\dT\d\d:/.test(whoareyouHtml)) throw new Error("static /whoareyou bake carries a per-request value");
await writeFile(`${PAGES}/whoareyou.html`, whoareyouHtml);
const dyno = await import(pathToFileURL(resolve(OUT, "src/worker/dyno.ts")).href);
const dynoResponse = dyno.renderDynoPage();
if (dynoResponse.status !== 200) throw new Error(`static /garage/dyno renderer returned ${dynoResponse.status}`);
const dynoHtml = await dynoResponse.text();
const pullsUrl = dyno.PULLS_URL;
if (!dynoHtml.includes(`data-island="${pullsUrl}"`)) throw new Error("static /garage/dyno renderer lost its pulls island");
if (!dynoHtml.includes(`rel="preload" as="fetch" href="${pullsUrl}" crossorigin`)) throw new Error("static /garage/dyno renderer lost the preload for its pulls island");
if (!dynoHtml.includes('querySelectorAll("[data-island]")')) throw new Error("static /garage/dyno renderer lost the island loader");
if (/<polyline|<td class="mono sha">[0-9a-f]{7}/.test(dynoHtml)) throw new Error("static /garage/dyno bake carries a series point");
await writeFile(`${PAGES}/garage/dyno.html`, dynoHtml);
for (const page of [
  { module: "ledger", render: "renderLedgerPage", url: "LINES_URL", out: "ledger.html",
    live: /<td class="mono">[A-Za-z]|Total due<\/span> <b>\$\d/ },
  { module: "around", render: "renderAroundPage", url: "SNAPSHOT_URL", out: "around.html",
    live: /class="firm">[A-Za-z]|class="latency">\d|\d{4}-\d\d-\d\dT\d\d:/ },
  { module: "inbox", render: "renderInboxPage", url: "MAIL_URL", out: "inbox.html",
    live: /id="m-\d|rel="noopener ugc external"/ },
  { module: "census", render: "renderCensusPage", url: "TABLE_URL", out: "lens/census.html",
    live: /class="cx-site"><a |<span>\/100<\/span>/ },
  { module: "reading", render: "renderReadingPage", url: "LIST_URL", out: "reading.html",
    live: /<a class="rd-title" href=|\d+ links? &middot;|\d+ links? ·|last synced \d/ },
]) {
  const mod = await import(pathToFileURL(resolve(OUT, `src/worker/${page.module}.ts`)).href);
  const res = mod[page.render]();
  if (res.status !== 200) throw new Error(`static /${page.module} renderer returned ${res.status}`);
  const body = await res.text();
  const url = mod[page.url];
  if (!body.includes(`data-island="${url}"`)) throw new Error(`static /${page.module} renderer lost its island`);
  if (!body.includes(`rel="preload" as="fetch" href="${url}" crossorigin`)) throw new Error(`static /${page.module} renderer lost the preload for its island`);
  if (!body.includes('querySelectorAll("[data-island]")')) throw new Error(`static /${page.module} renderer lost the island loader`);
  if (page.live.test(body)) throw new Error(`static /${page.module} bake carries a live value`);
  await mkdir(resolve(PAGES, page.out, ".."), { recursive: true });
  await writeFile(`${PAGES}/${page.out}`, body);
}
const serendipity = await import(pathToFileURL(resolve(OUT, "serendipity/serendipity.ts")).href);
const serendipityResponse = serendipity.renderSerendipityPage();
if (serendipityResponse.status !== 200) throw new Error(`static /serendipity renderer returned ${serendipityResponse.status}`);
const serendipityHtml = await serendipityResponse.text();
const eventsUrl = serendipity.EVENTS_URL;
if (!serendipityHtml.includes(`data-island="${eventsUrl}"`)) throw new Error("static /serendipity renderer lost its events island");
if (!serendipityHtml.includes(`rel="preload" as="fetch" href="${eventsUrl}" crossorigin`)) throw new Error("static /serendipity renderer lost the preload for its events island");
if (!serendipityHtml.includes('querySelectorAll("[data-island]")')) throw new Error("static /serendipity renderer lost the island loader");
if (/<a class="ev|\d+ events? in the pool|data-cover=/.test(serendipityHtml)) throw new Error("static /serendipity bake carries a pool value");
await writeFile(`${PAGES}/serendipity.html`, serendipityHtml);
const mcpInfoHtml = await serendipity.renderMcpInfoPage().text();
if (mcpInfoHtml !== await serendipity.renderMcpInfoPage().text()) throw new Error("static /serendipity/mcp-info renderer is not deterministic");
if (!mcpInfoHtml.includes("list_events")) throw new Error("static /serendipity/mcp-info renderer lost its tool list");
await mkdir(`${PAGES}/serendipity`, { recursive: true });
await writeFile(`${PAGES}/serendipity/mcp-info.html`, mcpInfoHtml);
{
  const cal = await import(pathToFileURL(resolve(OUT, "cal/src/templates.ts")).href);
  const vars = (await siteConfig()).vars as Record<string, string> | undefined;
  if (!vars?.HOST_TIMEZONE || !vars.HOST_NAME) throw new Error("static /coffee: the site config carries no HOST_* vars");
  const calEnv = { ...vars, BASE_PATH: "/coffee" };
  const coffeeHtml = cal.bookingPage(calEnv);
  if (coffeeHtml !== cal.bookingPage(calEnv)) throw new Error("static /coffee renderer is not deterministic");
  const slotsUrl = `/coffee${cal.SLOTS_PATH}`;
  if (!coffeeHtml.includes(`data-island="${slotsUrl}"`)) throw new Error("static /coffee renderer lost its slots island");
  if (!coffeeHtml.includes(`rel="preload" as="fetch" href="${slotsUrl}" crossorigin`)) throw new Error("static /coffee renderer lost the preload for its slots island");
  if (!coffeeHtml.includes('querySelectorAll("[data-island]")')) throw new Error("static /coffee renderer lost the island loader");
  if (!coffeeHtml.includes('id="bookform" method="POST" action="/coffee/book"')) throw new Error("static /coffee renderer lost its booking form");
  if (/name="start" value=|class="xp-day-label">[A-Z][a-z]+day,|no open slots in the next/.test(coffeeHtml)) throw new Error("static /coffee bake carries a live slot");
  // cal cannot import the site tree (gotcha 16), so its template cannot ask
  // lib/twins.ts about /coffee.md. The bake can, through the same staged module
  // lunaPage reads, so the link appears exactly where the build wrote a twin.
  const twins = await import(pathToFileURL(resolve(OUT, "src/worker/lib/twins.ts")).href);
  const coffeeTwin = twins.twinFor("/coffee");
  const coffeeOut = coffeeTwin
    ? coffeeHtml.replace(/<\/head>/i, `<link rel="alternate" type="text/markdown" title="markdown source" href="${coffeeTwin}">\n</head>`)
    : coffeeHtml;
  if (coffeeTwin && coffeeOut === coffeeHtml) throw new Error("static /coffee: no </head> to anchor its Markdown link to");
  await writeFile(`${PAGES}/coffee.html`, coffeeOut);
  console.log(`static render: /coffee shell (${coffeeHtml.length} bytes) with its slots at ${slotsUrl}`);
}

const env = { ASSETS: assets };
const indexResponse = await writing.renderWritingIndex(env);
if (indexResponse.status !== 200) throw new Error(`static /writing renderer returned ${indexResponse.status}`);
await mkdir(`${PAGES}/writing`, { recursive: true });
await writeFile(`${PAGES}/writing/index.html`, await indexResponse.text());

const posts = JSON.parse(await readFile(`${OUT}/public/writing/posts.json`, "utf8"));
for (const post of posts) {
  const response = await writing.renderWritingPost(post.slug, env);
  if (response.status !== 200) throw new Error(`static /writing/${post.slug} renderer returned ${response.status}`);
  await writeFile(`${PAGES}/writing/${post.slug}.html`, await response.text());
}
console.log(`static renders: /lens + blank /run + blank /search + /security + /whoareyou + /garage/dyno + /serendipity + /serendipity/mcp-info + /ledger + /around + /inbox + /lens/census + /reading + /coffee + /writing index + ${posts.length} notes staged from canonical Worker renderers, in a fresh process`);
