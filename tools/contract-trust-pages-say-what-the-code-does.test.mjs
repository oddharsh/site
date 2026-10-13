// ── the trust pages say what the code does (src/worker/trust.ts) ─────────────
// /about, /contact, /privacy and /developers are what an agent reads to decide
// whether to trust this site, so each must be a real page (500+ characters of
// text, a canonical URL, a Markdown twin) and every figure on it must be the
// code's own. gen-md-twins.ts TWIN_FACTS already holds each TWIN to the code;
// this holds the rendered HTML to the same derived strings, so the two copies
// cannot drift apart either.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { TWIN_FACTS } from "./gen-md-twins.ts";
import * as trust from "../src/worker/trust.ts";

/** @type {Array<[string, () => Response]>} */
const PAGES = [
  ["/about", trust.renderAboutPage],
  ["/contact", trust.renderContactPage],
  ["/privacy", trust.renderPrivacyPage],
  ["/developers", trust.renderDevelopersPage],
];

const text = (html) => html
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&[a-z]+;|&#\d+;/g, " ")
  .replace(/\s+/g, " ");
const main = (html) => text(html.slice(html.indexOf("<h1"), html.indexOf("<footer")));

for (const [route, render] of PAGES) {
  test(`${route} is a fixed, real page`, async () => {
    assert.equal(render.length, 0, "any parameter is a door for runtime state");
    const a = await render().text();
    assert.equal(a, await render().text(), "deterministic");
    assert.ok(main(a).length >= 500, `${route} carries ${main(a).length} characters of text, under 500`);
    assert.ok(a.includes(`<link rel="canonical" href="https://aadhar.sh${route}">`));
    assert.ok(!/\u2014/.test(main(a)), "house voice: no em dash");
  });

  test(`${route} states every fact its twin is held to`, async () => {
    const entry = TWIN_FACTS.find((t) => t.twin === `src/content/md${route}.md`);
    assert.ok(entry, `${route} has TWIN_FACTS`);
    const html = await render().text();
    const page = main(html);
    for (const f of entry.facts) {
      const expected = f.derive ? f.derive(readFileSync(f.source, "utf8")) : f.string;
      assert.ok(expected, `${f.source} still states ${f.label}`);
      // a sentence is read from the text; a URL may live in an href
      assert.ok(page.includes(expected) || html.includes(expected), `${route} must state ${f.label} as ${JSON.stringify(expected)}`);
    }
  });
}

test("each trust page is registered for agents, the sitemap and search", () => {
  const manifest = JSON.parse(readFileSync("config/site-manifest.json", "utf8"));
  const sitemap = readFileSync("public/sitemap.xml", "utf8");
  for (const [route] of PAGES) {
    const s = manifest.surfaces.find((x) => x.path === route);
    assert.ok(s, `${route} is in the manifest`);
    assert.ok(s.flags.agents && s.flags.sitemap && s.flags.searchIndex, `${route} flags`);
    assert.ok(sitemap.includes(`<loc>https://aadhar.sh${route}</loc>`), `${route} is in sitemap.xml`);
  }
});
