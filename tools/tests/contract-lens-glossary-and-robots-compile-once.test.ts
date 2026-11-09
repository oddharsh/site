// ── Lens: the glossary pass and the robots matcher compile once ─────────────
// glossify runs one cached alternation per set of unmarked terms, and the
// robots matcher compiles each rule once per parsed file (lens.ts and
// lib/robots.ts say why, with the measurements). Both caches are keyed on
// something that changes the answer, so these cases ask the same inputs in the
// orders that would expose a cache keyed on too little.
import { assert, test } from "./contract-shared.ts";
import { glossify, lensParseRobots, lensRobotsVerdict } from "../../src/worker/lens.ts";

const marks = (html: string) => html.replace(/ title="[^"]*"/g, "");

test("glossify marks each term once, longest spelling first, and honours `only`", () => {
  // the second "agent" stays plain: a pass cached without the marked set would wrap it
  assert.equal(
    marks(glossify("The agent-card names the agent, and agent again.")),
    'The <abbr class="lx-term" data-t="agent-card">agent-card</abbr> names the <abbr class="lx-term" data-t="agent">agent</abbr>, and agent again.',
  );
  assert.equal(
    marks(glossify("No llms.txt; robots.txt allows it. sitemap.xml.gz is not sitemap.xml.")),
    'No <abbr class="lx-term" data-t="llms-txt">llms.txt</abbr>; <abbr class="lx-term" data-t="robots-txt">robots.txt</abbr> allows it. sitemap.xml.gz is not <abbr class="lx-term" data-t="sitemap">sitemap.xml</abbr>.',
  );
  // `only` after the unrestricted calls above: a pass cached without `only` would mark agent-card
  assert.equal(marks(glossify("The agent-card names the agent.", ["agent"])), 'The <abbr class="lx-term" data-t="agent">agent</abbr>-card names the agent.');
  assert.equal(glossify("Nothing to define here."), "Nothing to define here.");
});

test("one parsed robots.txt answers every path and bot by its own rules", () => {
  const parsed = lensParseRobots(
    "User-agent: *\nDisallow: /private/\nAllow: /private/open$\nDisallow: /*.pdf$\nDisallow: /a%2fb\n\nUser-agent: GPTBot\nDisallow: /",
  );
  const ask = (ua: string, path: string) => {
    const v = lensRobotsVerdict(parsed, ua, path);
    return `${v.verdict} ${v.rule}`;
  };
  assert.deepEqual(
    [
      ask("SomeBot", "/private/x"),
      ask("SomeBot", "/private/open"),
      ask("SomeBot", "/private/open/more"),
      ask("SomeBot", "/doc.pdf"),
      ask("SomeBot", "/doc.pdf?x"),
      ask("SomeBot", "/a%2Fb"),
      ask("SomeBot", "/public"),
      ask("GPTBot/1.1", "/public"),
    ],
    [
      "block Disallow: /private/",
      "allow Allow: /private/open$",
      "block Disallow: /private/",
      "block Disallow: /*.pdf$",
      "allow null",
      "block Disallow: /a%2fb",
      "allow null",
      "block Disallow: /",
    ],
  );
});
