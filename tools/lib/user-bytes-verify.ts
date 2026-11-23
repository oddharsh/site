// user-bytes-verify.ts: `bun run user-bytes A B --verify`. Does pageLoads
// (lib/user-bytes.ts) list the /a/ files Chrome actually fetches for a page,
// with the render-blocking status Chrome reports?
//
// The tree is served as plain files, without the Worker: the question is
// which files a document pulls in, which the Worker doesn't change. So the
// islands a Worker fragment would add are absent here, and the family
// dictionary (offered by a Link header the Worker adds) is left out of both
// lists.
//
// THE PLANT RUNS FIRST: a page with one blocking stylesheet and one deferred
// script. If Chrome's reading of it is not exactly [sheet blocking, script
// not], the instrument is blind and this returns 2 before the sweep.

import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromeChannel } from "./browser-channel.ts";
import { pageFile, pageLoads } from "./user-bytes.ts";
import type { Tree } from "./user-bytes.ts";

const PLANT_HTML = `<!doctype html><link rel=stylesheet href=/a/plant.00000000.css><script defer src=/a/plant.00000000.js></script><p>plant`;

type Seen = { url: string; blocking: boolean }[];

async function read(browser: Browser, origin: string, path: string): Promise<Seen> {
  const page = await browser.newPage();
  try {
    await page.goto(origin + path, { waitUntil: "networkidle" });
    // Idle loads (requestIdleCallback islands) land after networkidle.
    await page.waitForTimeout(1500);
    const entries: Seen = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((e) => e as PerformanceResourceTiming & { renderBlockingStatus?: string })
        .filter((e) => new URL(e.name).pathname.startsWith("/a/"))
        .map((e) => ({ url: new URL(e.name).pathname, blocking: e.renderBlockingStatus === "blocking" })),
    );
    const byUrl = new Map<string, boolean>();
    for (const e of entries) byUrl.set(e.url, (byUrl.get(e.url) ?? false) || e.blocking);
    return [...byUrl].filter(([url]) => !url.endsWith(".dict")).map(([url, blocking]) => ({ url, blocking }));
  } finally {
    await page.close();
  }
}

function serve(root: string) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/__plant") return new Response(PLANT_HTML, { headers: { "content-type": "text/html" } });
      if (path === "/a/plant.00000000.css") return new Response("p{color:red}", { headers: { "content-type": "text/css" } });
      if (path === "/a/plant.00000000.js") return new Response("void 0", { headers: { "content-type": "text/javascript" } });
      const rel = path === "/" ? "index" : path.slice(1);
      for (const file of [rel, `${rel}.html`, `${rel}/index.html`]) {
        const full = join(root, file);
        if (existsSync(full) && statSync(full).isFile()) return new Response(Bun.file(full));
      }
      return new Response("not in the tree", { status: 404 });
    },
  });
}

export async function verifyLoads(tree: Tree, paths: string[]): Promise<number> {
  const server = serve(tree.root);
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    const plant = await read(browser, origin, "/__plant");
    const want = JSON.stringify([
      { url: "/a/plant.00000000.css", blocking: true },
      { url: "/a/plant.00000000.js", blocking: false },
    ]);
    if (JSON.stringify(plant.sort((x, y) => x.url.localeCompare(y.url))) !== want) {
      console.error(`verify: BLIND. The plant read ${JSON.stringify(plant)}, want ${want}`);
      return 2;
    }
    let blockingDisagree = 0;
    let missed = 0;
    let extra = 0;
    for (const path of paths) {
      const seen = await read(browser, origin, path);
      const found = pageFile(tree.root, path);
      if (!found) continue;
      const html = readFileSync(join(tree.root, found.file), "utf8");
      const model = pageLoads(html);
      const modelBy = new Map(model.map((l) => [l.url, l.blocking]));
      const seenBy = new Map(seen.map((l) => [l.url, l.blocking]));
      const notes: string[] = [];
      for (const [url, blocking] of seenBy) {
        if (!modelBy.has(url)) {
          missed++;
          notes.push(`chrome fetched ${url}${blocking ? " (blocking)" : ""}, the model didn't list it`);
        } else if (modelBy.get(url) !== blocking) {
          blockingDisagree++;
          notes.push(`${url}: chrome says ${blocking ? "blocking" : "not blocking"}, the model says the other`);
        }
      }
      for (const url of modelBy.keys()) {
        if (!seenBy.has(url)) {
          extra++;
          notes.push(`model lists ${url}, chrome didn't fetch it on load`);
        }
      }
      console.log(
        `verify ${path}: chrome ${seen.length} files (${seen.filter((s) => s.blocking).length} blocking), model ${model.length}${notes.length ? "\n  " + notes.join("\n  ") : ""}`,
      );
    }
    console.log(
      `verify: ${paths.length} pages; ${blockingDisagree} blocking disagreements, ${missed} files the model missed, ${extra} it listed that Chrome didn't fetch\n`,
    );
    // A file the model lists that loads only on interaction overstates bytes
    // but not first paint; a blocking disagreement misprices first paint.
    return blockingDisagree > 0 ? 1 : 0;
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
