// The Markdown lens: what a named agent client actually gets back.
//
// The tab exists because a conformance grade and a reach number answer different
// questions and disagree in practice. Three of the seven agents on the public
// matrix send an Accept header where Markdown and HTML both arrive at q=1, so an
// origin that ranks strictly by q-value passes every check on the list and still
// hands those three HTML. These tests pin the properties that make the replay
// trustworthy rather than the grades it happens to produce today.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_ACCEPTS, BROWSER_ACCEPT, isMarkdown, markdownAlternate, probePlan, variesOnAccept,
} from "../src/worker/lens-markdown.ts";

const worker = await readFile(new URL("../src/worker/lens-markdown.ts", import.meta.url), "utf8");
const island = await readFile(new URL("../src/client/lens-markdown.js", import.meta.url), "utf8");

test("the markdown lens reaches the network with nothing but the URL", () => {
  // Same shape as the wire lens's guard, for the same reason: this route aims a
  // visitor-supplied URL at the public internet ten times, so the ONE thing a
  // caller may influence is which URL. A second params.get() is how a header,
  // a method, or a body would arrive.
  const reads = worker.match(/params\.get\(/g) || [];
  assert.equal(reads.length, 1, "exactly one caller-supplied parameter is read");
  assert.ok(worker.includes('params.get("url")'), "and it is the target URL");

  assert.ok(worker.includes('from "./lib/crawl.ts"'), "imports the shared SSRF guard");
  assert.ok(worker.includes("validateLensTarget("), "and calls it");
  // Never a local copy. Two allowlists pass review on the day they are written
  // and drift the week after.
  assert.ok(!/function\s+validateLensTarget/.test(worker), "does not redefine validateLensTarget");
  assert.ok(!/function\s+privateHostBlocked/.test(worker), "does not redefine privateHostBlocked");
});

test("Vary is matched as a token, so accept-encoding is not Accept", () => {
  // The substring trap. `Vary: accept-encoding` contains the letters of "accept"
  // and means something else entirely; reading it as a pass grades an origin
  // that varies only on compression as one that negotiates representations.
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
  // OpenCode ranks this variant second, so an origin answering in it is serving
  // Markdown and must not be graded as refusing.
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

  // A Link header carrying several relations must not hand back the wrong one.
  const mixed = markdownAlternate(
    '</style.css>; rel=preload; as=style, </p.md>; rel="alternate"; type="text/markdown"', "");
  assert.equal(mixed?.href, "/p.md");

  // An alternate that is not Markdown is not a Markdown alternate. Both halves
  // have to match or an RSS feed grades as a Markdown twin.
  assert.equal(markdownAlternate('</feed.xml>; rel="alternate"; type="application/rss+xml"', ""), null);
  assert.equal(markdownAlternate("", '<link rel="stylesheet" type="text/markdown" href="/x.md">'), null);
  assert.equal(markdownAlternate("", ""), null);
});

test("the replay plan dedupes by Accept string and admits a browser control", () => {
  const { probes, agentProbe } = probePlan();
  const accepts = probes.map((p) => p.accept);

  assert.equal(new Set(accepts).size, accepts.length, "no Accept string is fetched twice");
  // Three agents share one header, so seven rows must cost six requests. Two
  // identical requests could not honestly return different answers.
  assert.equal(probes.length, 10, "ten distinct requests: five checks plus five distinct agent headers");
  assert.equal(agentProbe.size, AGENT_ACCEPTS.length, "every agent maps to a probe");

  // The control is what separates "this origin chose HTML for you" from "this
  // origin has no Markdown for anybody". Without it in the plan there is no
  // baseline and reach cannot honestly be scored.
  assert.ok(accepts.includes(BROWSER_ACCEPT), "a browser control is fetched");

  // The subrequest budget is the reason this is bounded at all: Workers Free
  // allows 50 per invocation and KV operations count toward it (gotcha 36).
  assert.ok(probes.length + 2 < 50, "the whole run plus its KV read and write stays under the cap");
});

test("the browser control is never scored as an agent", () => {
  // Displayed, never counted. Leaving a browser in the scored set would reward
  // exactly the origin that serves humans and refuses every machine, which is
  // the mistake the bot-views tier already had to correct once.
  for (const a of AGENT_ACCEPTS) {
    assert.notEqual(a.accept, BROWSER_ACCEPT, `${a.key} is not the control`);
    // Every row must actually prefer Markdown, or the table reports a finding
    // about our own list rather than about the origin.
    assert.match(a.accept, /text\/(x-)?markdown/, `${a.key} advertises Markdown`);
    assert.match(a.verified, /^\d{4}-\d{2}-\d{2}$/, `${a.key} carries an observation date`);
    assert.ok(a.label && a.vendor, `${a.key} names a client and a vendor`);
  }
  assert.equal(new Set(AGENT_ACCEPTS.map((a) => a.key)).size, AGENT_ACCEPTS.length, "keys are unique");
});

test("the tie header the tab exists for is in the table", () => {
  // The load-bearing row. If this string ever leaves the table the tab keeps
  // working and quietly stops covering the case that motivated it: Markdown and
  // HTML both at q=1, with nothing in the header to break the tie.
  const tied = AGENT_ACCEPTS.filter((a) => a.accept === "text/markdown, text/html, */*");
  assert.ok(tied.length >= 3, "at least three shipping clients send the tied header");
  assert.ok(tied.some((a) => a.key === "claude-code"), "Claude Code among them");
});

test("the pane builds foreign strings as nodes, never as markup", () => {
  // Every content-type, status and byte count in the replay table came off a
  // stranger's server, and so did the Markdown sample. Same discipline the tools
  // and nlweb panes keep.
  assert.ok(!/\.innerHTML\s*=/.test(island), "the island never assigns innerHTML");
  assert.ok(island.includes("createElement"), "rows are created as elements");
  assert.ok(island.includes("textContent"), "and filled as text");
  // The sample is Markdown, which may carry an HTML block verbatim.
  assert.match(island, /sample\.textContent\s*=/, "the Markdown sample is set as text");
});

test("the pane makes exactly one request, and it is to our own route", () => {
  // The island must not reach a foreign origin from the visitor's browser: the
  // whole point is that the fetch happens from our edge, under an honest
  // identity, inside a budget. A second fetch here is how that gets bypassed.
  const fetches = island.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, "one fetch");
  assert.ok(island.includes('fetch("/lens/markdown?url="'), "to our own route");
});

test("every lazily-loaded lens island has a cache rule in _headers", async () => {
  // Written because the comment that used to guard this failed three times. An
  // island with no rule inherits the platform default (max-age=0,
  // must-revalidate) and costs a silent 304 per load — nothing looks broken, so
  // nobody notices. lens-reader.js shipped that way, then lens-nlweb.js did too,
  // directly underneath a paragraph in that file describing the failure.
  //
  // The list is DERIVED from what lens.js actually loads rather than hand-kept,
  // because a hand-kept list goes stale in exactly the same silence.
  const lens = await readFile(new URL("../src/client/lens.js", import.meta.url), "utf8");
  const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");

  const loaded = [...lens.matchAll(/["'`](\/lens-[a-z-]+\.js)\?v=1["'`]/g)].map((m) => m[1]);
  assert.ok(loaded.length >= 5, `expected the on-demand islands, found ${loaded.length}`);

  // Parsed into blocks rather than matched with a RegExp built from `path`.
  // Building one would need every metacharacter in the data escaped, and the
  // first cut escaped `.` while missing `\\` — CodeQL caught it. Nothing can
  // reach that construction here, since the capture above admits only
  // `[a-z-]`, but an assertion that is only safe because of a regex two lines
  // away is the kind that stops being safe when somebody widens the capture.
  // Parsing is also strictly stronger: it checks that the directive belongs to
  // THAT block rather than merely sitting on the next line.
  const rules = new Map();
  // Empty rather than null so the type is `string` throughout; both are falsy,
  // which is what the indented-line guard below actually tests.
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
