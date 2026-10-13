// ── the trust pages say what the code does (src/worker/trust.ts) ─────────────
// /about, /contact, /privacy and /developers are what an agent reads to decide
// whether to trust this site, so each must be a real page (500+ characters of
// text, a canonical URL, a Markdown twin) and every figure on it must be the
// code's own. Since 2026-10-13 the figures are IMPORTED, not typed out, and the
// twins are generated from the baked pages, so this file checks the wiring:
// that each figure on the page is the constant, that /developers lists what
// /openapi.json describes, and that the twin pipeline picks the pages up.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, test } from "./contract-shared.ts";
import { buildTwins } from "./gen-md-twins.ts";
import * as trust from "../src/worker/trust.ts";
import { OPERATIONS, exampleUrl } from "../src/worker/lib/public-api.ts";
import { missJson } from "../src/worker/lib/not-found.ts";
import { ASK_BUDGET } from "../src/worker/ask-rank.ts";
import { LENS_BUDGETS } from "../src/worker/lens-pipeline.ts";
import { RDAP_CACHE_TTL_S } from "../src/worker/whoareyou.ts";
import { TTL_BOOKING_DAYS } from "../cal/src/booking.ts";
import { UID_COOKIE, UID_COOKIE_MAX_AGE_S } from "../serendipity/serendipity.ts";

/** @type {Array<[string, () => Response]>} */
const PAGES = [
  ["/about", trust.renderAboutPage],
  ["/contact", trust.renderContactPage],
  ["/privacy", trust.renderPrivacyPage],
  ["/developers", trust.renderDevelopersPage],
];

// The text between the page's <h1> and its <footer>: the document itself,
// without the chrome. That region holds no <script> or <style> (asserted
// below), so dropping tags is enough to read it.
const text = (html) => html
  .replace(/<[^>]+>/g, " ")
  .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&[a-z]+;|&#\d+;/g, " ")
  .replace(/\s+/g, " ");
const main = (html) => text(html.slice(html.indexOf("<h1"), html.indexOf("<footer")));

for (const [route, render] of PAGES) {
  test(`${route} is a fixed, real page`, async () => {
    assert.equal(render.length, 0, "any parameter is a door for runtime state");
    const a = await render().text();
    assert.equal(a, await render().text(), "deterministic");
    const region = a.slice(a.indexOf("<h1"), a.indexOf("<footer"));
    assert.ok(!/<(script|style)\b/i.test(region), "the measured region is markup and text only");
    assert.ok(main(a).length >= 500, `${route} carries ${main(a).length} characters of text, under 500`);
    assert.ok(a.includes(`<link rel="canonical" href="https://aadhar.sh${route}">`));
    assert.ok(!/—/.test(main(a)), "house voice: no em dash");
  });
}

test("/privacy prints the retention and lifetimes the code enforces", async () => {
  const page = main(await trust.renderPrivacyPage().text());
  assert.ok(page.includes(`stored for ${TTL_BOOKING_DAYS} days`), "booking retention is cal's TTL_BOOKING_DAYS");
  assert.ok(page.includes(`one cookie, ${UID_COOKIE}`), "the cookie is named by its constant");
  const years = UID_COOKIE_MAX_AGE_S / (365 * 86400);
  assert.ok(page.includes(`lasts ${["", "one year", "two years", "three years"][years]}`), "the cookie lifetime is serendipity's Max-Age");
  assert.ok(page.includes(`for ${RDAP_CACHE_TTL_S / 3600} hours`), "the RDAP cache is whoareyou's cacheTtl");
});

test("/developers lists every operation /openapi.json describes, with the code's limits and its real 404", async () => {
  const html = await trust.renderDevelopersPage().text();
  const page = main(html);
  for (const op of OPERATIONS) {
    assert.ok(html.includes(`href="${exampleUrl(op).replace(/&/g, "&amp;")}"`), `${op.operationId} is linked`);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(page, new RegExp(`\\(\\s*${op.operationId}\\s*\\):\\s*${esc(op.summary)}\\.`), `${op.operationId} is listed`);
  }
  assert.ok(page.includes(`limited to ${LENS_BUDGETS.inspect.max} a minute`));
  assert.ok(page.includes(`comparisons to ${LENS_BUDGETS.compare.max} a minute`));
  assert.ok(page.includes(`ranks ${ASK_BUDGET.max} questions`));
  const shown = JSON.parse(text(html.slice(html.indexOf("<pre><code>{"), html.indexOf("}</code></pre>") + 1)));
  assert.deepEqual(shown, missJson("https://aadhar.sh", "/no-such-endpoint.json", { section: null, pages: [] }),
    "the error example is the body a real 404 sends");
  assert.match(readFileSync("public/sitemap.xml", "utf8"), new RegExp(`<loc>https://aadhar.sh${trust.MARKDOWN_EXAMPLE}</loc>`),
    "the Markdown example names a real page");
});

test("each twin is generated from its baked page, not written by hand", async () => {
  const root = mkdtempSync(join(tmpdir(), "trust-twins-"));
  try {
    mkdirSync(join(root, "public"), { recursive: true });
    for (const [route, render] of PAGES) writeFileSync(join(root, "public", `${route}.html`), await render().text());
    const { files } = buildTwins(".", { generatedRoot: root });
    const generated = /** @type {string[]} */ (buildTwins(".", { generatedRoot: root }).generated);
    for (const [route] of PAGES) {
      assert.ok(!existsSync(`src/content/md${route}.md`), `${route} has no hand twin to drift`);
      assert.ok(generated.includes(route), `${route} takes the generated tier`);
      const twin = files.get(`${route}.md`);
      assert.ok(twin, `${route}.md is produced`);
      assert.match(twin, new RegExp(`^# ${route.slice(1, 2).toUpperCase()}${route.slice(2)}$`, "m"), "the page's h1 leads the twin");
    }
    assert.ok(files.get("/privacy.md").includes(`stored for ${TTL_BOOKING_DAYS} days`), "a figure survives into the twin");
    assert.ok(files.get("/developers.md").includes(`limited to ${LENS_BUDGETS.inspect.max} a minute`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
