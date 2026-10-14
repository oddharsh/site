// The Markdown lens: what a named agent client actually gets back.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_ACCEPTS, BROWSER_ACCEPT, handleLensMarkdown, isMarkdown, markdownAlternate, probePlan, sharedStorable, variesOnAccept,
  varyEveryVariant,
} from "../src/worker/lens-markdown.ts";
import { wantsMarkdown } from "../src/worker/lib/http.ts";

const worker = await readFile(new URL("../src/worker/lens-markdown.ts", import.meta.url), "utf8");
const island = await readFile(new URL("../src/client/lens-markdown.js", import.meta.url), "utf8");

test("the markdown lens reaches the network with nothing but the URL", async () => {
  const reads = worker.match(/params\.get\(/g) || [];
  assert.equal(reads.length, 1, "exactly one caller-supplied parameter is read");
  assert.ok(worker.includes('params.get("url")'), "and it is the target URL");

  const pipeline = await readFile(new URL("../src/worker/lens-pipeline.ts", import.meta.url), "utf8");
  assert.ok(worker.includes('from "./lens-pipeline.ts"'), "runs through the lens pipeline");
  assert.ok(pipeline.includes('from "./lib/public-fetch.ts"'), "which imports the shared SSRF guard");
  assert.ok(pipeline.includes("validateLensTarget("), "and calls it");
  assert.ok(!/function\s+validateLensTarget/.test(worker), "does not redefine validateLensTarget");
  assert.ok(!/function\s+privateHostBlocked/.test(worker), "does not redefine privateHostBlocked");
});

test("Vary is matched as a token, so accept-encoding is not Accept", () => {
  assert.equal(variesOnAccept("Accept"), true);
  assert.equal(variesOnAccept("accept"), true);
  assert.equal(variesOnAccept("Accept-Encoding, Accept"), true);
  assert.equal(variesOnAccept("*"), true);

  assert.equal(variesOnAccept("accept-encoding"), false);
  assert.equal(variesOnAccept("accept-encoding, available-dictionary"), false);
  assert.equal(variesOnAccept("Accept-Language"), false);
  assert.equal(variesOnAccept(""), false);
  assert.equal(variesOnAccept(null), false);
});

test("text/x-markdown counts and text/html never does", () => {
  assert.equal(isMarkdown("text/markdown"), true);
  assert.equal(isMarkdown("text/markdown; charset=utf-8"), true);
  assert.equal(isMarkdown("text/x-markdown"), true);
  assert.equal(isMarkdown("TEXT/MARKDOWN"), true);
  assert.equal(isMarkdown("text/html"), false);
  assert.equal(isMarkdown("text/plain"), false);
  assert.equal(isMarkdown(""), false);
});

test("the rel=alternate probe reads the header and the element", () => {
  // RFC 8288 in the header, and the HTML element saying the same thing. This is
  // the path a client that sends no Accept header follows, so an origin can be
  // perfectly reachable by a real client while failing every other check.
  const viaHeader = markdownAlternate('</index.md>; rel="alternate"; type="text/markdown"', "");
  assert.equal(viaHeader?.href, "/index.md");
  assert.equal(viaHeader?.where, "Link header");

  const viaTag = markdownAlternate("", '<link rel="alternate" type="text/markdown" href="/page.md">');
  assert.equal(viaTag?.href, "/page.md");
  assert.equal(viaTag?.where, "<link> element");

  const mixed = markdownAlternate(
    '</style.css>; rel=preload; as=style, </p.md>; rel="alternate"; type="text/markdown"', "");
  assert.equal(mixed?.href, "/p.md");

  assert.equal(markdownAlternate('</feed.xml>; rel="alternate"; type="application/rss+xml"', ""), null);
  assert.equal(markdownAlternate("", '<link rel="stylesheet" type="text/markdown" href="/x.md">'), null);
  assert.equal(markdownAlternate("", ""), null);
});

test("the replay plan dedupes by Accept string and admits a browser control", () => {
  const { probes, agentProbe } = probePlan();
  const accepts = probes.map((p) => p.accept);

  assert.equal(new Set(accepts).size, accepts.length, "no Accept string is fetched twice");
  assert.equal(probes.length, 10, "ten distinct requests: five checks plus five distinct agent headers");
  assert.equal(agentProbe.size, AGENT_ACCEPTS.length, "every agent maps to a probe");

  assert.ok(accepts.includes(BROWSER_ACCEPT), "a browser control is fetched");

  // The subrequest budget is the reason this is bounded at all: Workers Free
  // allows 50 per invocation and KV operations count toward it (gotcha 36).
  assert.ok(probes.length + 2 < 50, "the whole run plus its KV read and write stays under the cap");
});

test("the replay overlaps only two probes and preserves its evidence order", async () => {
  let active = 0;
  let peak = 0;
  const accepts = [];
  const env = {
    SELF_FETCH: async (request) => {
      active++;
      peak = Math.max(peak, active);
      accepts.push(request.headers.get("accept"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response("<h1>control</h1>", { headers: { "content-type": "text/html", vary: "Accept" } });
    },
  };
  const target = encodeURIComponent("https://aadhar.sh/garage/horizon");
  const response = await handleLensMarkdown(new Request(`https://aadhar.sh/lens/markdown?url=${target}`), env);
  const payload = await response.json();
  const planned = probePlan().probes;

  assert.equal(response.status, 200);
  assert.equal(accepts.length, planned.length, "every distinct probe still runs exactly once");
  assert.equal(new Set(accepts).size, planned.length, "no Accept string is duplicated");
  assert.equal(peak, 2, "one origin sees at most two simultaneous requests");
  assert.deepEqual(payload.responses.map((row) => row.id), planned.map((probe) => probe.id),
    "completion timing cannot reorder the evidence");
});

test("the browser control is never scored as an agent", () => {
  for (const a of AGENT_ACCEPTS) {
    assert.notEqual(a.accept, BROWSER_ACCEPT, `${a.key} is not the control`);
    assert.match(a.accept, /text\/(x-)?markdown/, `${a.key} advertises Markdown`);
    assert.match(a.verified, /^\d{4}-\d{2}-\d{2}$/, `${a.key} carries an observation date`);
    assert.ok(a.label && a.vendor, `${a.key} names a client and a vendor`);
  }
  assert.equal(new Set(AGENT_ACCEPTS.map((a) => a.key)).size, AGENT_ACCEPTS.length, "keys are unique");
});

test("the tie header the tab exists for is in the table", () => {
  const tied = AGENT_ACCEPTS.filter((a) => a.accept === "text/markdown, text/html, */*");
  assert.ok(tied.length >= 3, "at least three shipping clients send the tied header");
  assert.ok(tied.some((a) => a.key === "claude-code"), "Claude Code among them");
});

test("this origin serves Markdown to every agent client the lens replays", () => {
  const asks = (accept) => wantsMarkdown(new Request("https://aadhar.sh/garage/horizon", { headers: { accept } }));

  for (const a of AGENT_ACCEPTS) {
    assert.equal(asks(a.accept), true, `${a.label} asks for Markdown and must get it`);
  }
});

test("the tie rule does not widen to anyone who did not ask", () => {
  const asks = (accept) => wantsMarkdown(new Request("https://aadhar.sh/garage/horizon", { headers: { accept } }));

  assert.equal(asks(BROWSER_ACCEPT), false, "a browser navigation still gets HTML");
  assert.equal(asks("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"), false);
  assert.equal(asks("*/*"), false, "a bare wildcard is not a request for Markdown");
  assert.equal(asks(""), false);

  assert.equal(asks("text/html, text/markdown;q=0.5"), false);
  assert.equal(asks("text/html;q=1.0, text/markdown;q=0.5"), false);

  assert.equal(asks("text/html, text/markdown;q=0"), false);
  assert.equal(asks("text/markdown;q=0, text/html"), false);

  assert.equal(asks("text/markdown, text/html"), true, "markdown first wins the tie");
  assert.equal(asks("text/html, text/markdown"), false, "html first wins the tie");
  assert.equal(asks("text/markdown, */*"), true, "the only named type is the markdown one");
  assert.equal(asks("text/markdown, application/xhtml+xml"), true, "markdown was first");
  assert.equal(asks("application/xhtml+xml, text/markdown"), false, "xhtml was first");
});

test("explicit Accept weights outrank matching wildcards, including refusals", () => {
  /** @type {[string, boolean][]} */
  const cases = [
    ["text/markdown;q=0, */*;q=1", false],
    ["text/markdown;q=0, text/*;q=1", false],
    ["*/*;q=1, text/markdown;q=0", false],
    ["text/markdown;q=0.2, text/html;q=0.8, */*;q=1", false],
    ["text/markdown;q=0.2, text/*;q=0.8", false],
    ["text/markdown;q=0.8, text/html;q=0.2, application/xhtml+xml;q=0, */*;q=1", true],
    ["text/markdown;q=0.8, text/*;q=0, */*;q=0.1", true],
  ];
  for (const [accept, expected] of cases) {
    const request = new Request("https://aadhar.sh/garage/horizon", { headers: { accept } });
    assert.equal(wantsMarkdown(request), expected, accept);
  }
});

test("the pane builds foreign strings as nodes, never as markup", () => {
  assert.ok(!/\.innerHTML\s*=/.test(island), "the island never assigns innerHTML");
  assert.ok(island.includes("createElement"), "rows are created as elements");
  assert.ok(island.includes("textContent"), "and filled as text");
  assert.match(island, /sample\.textContent\s*=/, "the Markdown sample is set as text");
});

test("the pane makes exactly one request, and it is to our own route", () => {
  const fetches = island.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, "one fetch");
  assert.ok(island.includes('fetch("/lens/markdown?url="'), "to our own route");
});

test("every lazily-loaded lens island has a cache rule in _headers", async () => {
  const lens = await readFile(new URL("../src/client/lens.js", import.meta.url), "utf8");
  const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");

  const loaded = [...lens.matchAll(/["'`](\/lens-[a-z-]+\.js)\?v=1["'`]/g)].map((m) => m[1]);
  assert.ok(loaded.length >= 5, `expected the on-demand islands, found ${loaded.length}`);

  const rules = new Map();
  let block = "";
  for (const line of headers.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) { if (block) rules.get(block).push(line.trim()); continue; }
    block = line.trim();
    if (!rules.has(block)) rules.set(block, []);
  }

  for (const path of new Set(loaded)) {
    const directives = rules.get(path);
    assert.ok(directives, `${path} has no block in public/_headers`);
    assert.ok(
      directives.some((d) => d.toLowerCase().startsWith("cache-control:")),
      `${path} has a block in public/_headers but no Cache-Control rule`,
    );
  }
});

test("a shared cache may store what no-store and private do not forbid", () => {
  assert.equal(sharedStorable("public, max-age=0, s-maxage=86400"), true);
  assert.equal(sharedStorable(""), true, "no Cache-Control is still heuristically cacheable");
  assert.equal(sharedStorable(null), true);
  assert.equal(sharedStorable("no-store, must-revalidate"), false);
  assert.equal(sharedStorable("Private, max-age=60"), false);
  // no-cache permits storage (it only forces revalidation), so it is exposed.
  assert.equal(sharedStorable("no-cache"), true);
});

/** @returns {[string, any]} */
const raw = (id, result) => [id, result];
/** @returns {[string, any]} */
const row = (id, contentType, vary, cacheControl = "public, s-maxage=86400") =>
  [id, { ok: true, status: 200, contentType, vary, cacheControl }];

test("Vary is read off EVERY variant, not only the Markdown one", () => {
  const ours = [
    row("control", "text/html; charset=utf-8", "accept-encoding, available-dictionary"),
    row("markdown", "text/markdown; charset=utf-8", "accept", "no-store, must-revalidate"),
  ];
  const verdict = varyEveryVariant(ours);
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /text\/html for control/, "names the variant that leaks");
  assert.ok(!verdict.detail.includes("markdown for markdown"), "does not blame the variant that varies");

  assert.equal(varyEveryVariant([
    row("control", "text/html", "Accept-Encoding, Accept"),
    row("markdown", "text/markdown", "accept"),
  ]).status, "pass");

  assert.equal(varyEveryVariant([
    row("control", "text/html", "accept-encoding", "private, max-age=60"),
    row("markdown", "text/markdown", "accept"),
  ]).status, "pass");

  assert.equal(varyEveryVariant([
    row("control", "text/html", ""),
    row("markdown", "text/html; charset=utf-8", ""),
  ]).status, "info");

  assert.equal(varyEveryVariant([
    row("control", "text/html", "accept"),
    row("markdown", "text/markdown", "accept"),
    raw("unservable", { ok: true, status: 406, contentType: "text/plain", vary: "", cacheControl: "" }),
    raw("q-zero", { ok: false, error: "timeout" }),
  ]).status, "pass");
});

test("the handler grades a leaking HTML copy end to end", async () => {
  const env = {
    SELF_FETCH: async (request) => {
      const md = (request.headers.get("accept") || "").startsWith("text/markdown");
      return md
        ? new Response("# md", { headers: { "content-type": "text/markdown", vary: "accept", "cache-control": "no-store" } })
        : new Response("<h1>html</h1>", { headers: { "content-type": "text/html", vary: "accept-encoding", "cache-control": "public, s-maxage=86400" } });
    },
  };
  const target = encodeURIComponent("https://aadhar.sh/garage/horizon");
  const payload = await (await handleLensMarkdown(new Request(`https://aadhar.sh/lens/markdown?url=${target}`), env)).json();
  const byId = Object.fromEntries(payload.checks.map((c) => [c.id, c]));
  assert.equal(byId["varies-by-accept"].status, "pass", "the checklist's one-response read misses it");
  assert.equal(byId["vary-on-every-variant"].status, "fail", "and the every-variant read catches it");
  assert.equal(payload.responses.find((r) => r.id === "control").cacheControl, "public, s-maxage=86400",
    "the evidence carries the header the verdict rests on");
});
