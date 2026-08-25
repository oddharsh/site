#!/usr/bin/env node
// webmcp-frame-probe.ts — does a SUBFRAME's WebMCP registration reach the top
// frame's catalogue?
//
// It decides whether /lens can read a foreign site's browser-local tools. Lens
// already embeds framable sites in a live cross-origin iframe loaded by the
// visitor's own browser, so if frame tools surfaced upward, that would read a
// stranger's catalogue for free, in an engine new enough to see it, with none of
// Browser Run's cost. Browser Run itself cannot: it renders in Chrome 128 and
// WebMCP's origin trial is 149 to 156 (lib/agent-webmcp.ts).
//
// ANSWER, measured 2026-08-25 on Chrome 151: same-origin frames aggregate,
// cross-origin frames do not. So the iframe route is closed, and closed for a
// good reason, since otherwise any page could enumerate and invoke the tools of
// any site it framed. `origin` and `window` on a registered tool tell you which
// frame OF YOUR OWN ORIGIN registered it; they are not a window into a stranger.
//
// RUN IT VISIBLE OR NOT AT ALL, which is the whole reason this is a committed
// script rather than something typed into an agent's browser. A tab driven by an
// agent is BACKGROUNDED, Chrome freezes setTimeout in a hidden page, and every
// getTools() then reads as a permanent hang. That is exactly what happened on
// the first attempt: three separate readings looked like a browser bug worth
// filing, and the page was merely frozen (gotcha 33, and the same lesson gotcha
// 15 teaches about Early Hints). The CONTROL below is what separates the two,
// so read it before reading anything else.
//
//   node tools/webmcp-frame-probe.ts
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const CHILD = (name, label) => `<!doctype html><meta charset=utf-8><title>${label}</title>
<body><pre id=o>...</pre><script>(async()=>{const mc=document.modelContext;
if(!mc){document.getElementById("o").textContent="no modelContext";return;}
await mc.registerTool({name:"${name}",description:"registered by a ${label} frame",
inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true},
execute:async()=>({content:[{type:"text",text:"ran"}]})});
document.getElementById("o").textContent="registered "+location.origin;})();</script>`;

const PARENT = (childUrl) => `<!doctype html><meta charset=utf-8><title>top</title>
<body><h3>top frame</h3><iframe src="${childUrl}" width=380 height=90></iframe>
<script>document.modelContext.registerTool({name:"top_tool",description:"the top frame's own",
inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true},
execute:async()=>({content:[]})});</script>`;

// Two servers so the two pages differ by HOST as well as port: 127.0.0.1 and
// localhost are separate origins to the browser and both are secure contexts.
function serve(port: number, routes: Record<string, string>): Promise<import("node:http").Server> {
  const server = createServer((req, res) => {
    const body = routes[(req.url || "/").split("?")[0]];
    if (body === undefined) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const A = await serve(8811, { "/same.html": PARENT("http://localhost:8811/child.html"), "/child.html": CHILD("same_origin_frame_tool", "same-origin") });
const B = await serve(8812, { "/child.html": CHILD("cross_origin_frame_tool", "cross-origin") });
const C = await serve(8813, { "/cross.html": PARENT("http://127.0.0.1:8812/child.html") });

// WebMCP is behind a flag on Chrome 151. It is ON by default in the 152 this was
// cross-checked against, so a probe that skipped the flag would report the API
// as absent on one machine and present on the next.
const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--enable-features=WebMCP"] });
const page = await browser.newPage();

const read = () => page.evaluate(async () => {
  const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("NEVER RESOLVED"), ms))]);
  const tools = await race((document as any).modelContext.getTools(), 6000);
  return tools === "NEVER RESOLVED" ? "NEVER RESOLVED"
    : tools.map((t) => ({ name: t.name, origin: t.origin, sameWindow: t.window === window }));
});

await page.goto("http://localhost:8811/same.html", { waitUntil: "load" });
await page.waitForTimeout(1500);

// THE CONTROL. A hidden page freezes timers, and then every reading below is
// "NEVER RESOLVED" whether or not anything is wrong. If this line is not
// visible + a timer that actually fired, the run measured the instrument.
const control = await page.evaluate<{ visibility: string; timerMs: number }>(() => new Promise((r) => {
  const started = Date.now();
  setTimeout(() => r({ visibility: document.visibilityState, timerMs: Date.now() - started }), 200);
}));
console.log("CONTROL      ", JSON.stringify(control));
if (control.visibility !== "visible" || control.timerMs > 2000) {
  console.log("\nREFUSING TO REPORT: the page is not visible or its timers are throttled.");
  await browser.close(); [A, B, C].forEach((s) => s.close());
  process.exit(1);
}

const sameOrigin = await read();
await page.goto("http://localhost:8813/cross.html", { waitUntil: "load" });
await page.waitForTimeout(1500);
const crossOrigin = await read();

const has = (list: unknown, name: string) => Array.isArray(list) && list.some((t) => t.name === name);
console.log("same-origin  ", JSON.stringify(sameOrigin));
console.log("cross-origin ", JSON.stringify(crossOrigin));
console.log("");
console.log("same-origin frame tool reaches the top:  ", has(sameOrigin, "same_origin_frame_tool"));
console.log("cross-origin frame tool reaches the top: ", has(crossOrigin, "cross_origin_frame_tool"));

await browser.close();
[A, B, C].forEach((s) => s.close());
