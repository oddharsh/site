// ── schema.org Article on Garage and LWE pages ──────────────────────
// build.ts step 1g4 splices one Article into every staged Garage and LWE page
// from tools/lib/article-ld.ts. These tests run that module over the AUTHORED
// pages, which carry the same head the staged copies do, so the guarantees hold
// without a build: every content page yields a headline and a sitemap date,
// the block parses, and nothing in it can close its own script element.
import {
  assert,
  existsSync,
  readFileSync,
  test,
} from "./contract-shared.ts";

const content = () => JSON.parse(readFileSync("config/site-manifest.json", "utf8")).surfaces
  .filter((s) => s.kind === "content" && /^\/(garage|lwe)\//.test(s.path))
  .filter((s) => existsSync(`src/pages${s.path}.html`));

test("every Garage and LWE content page yields an Article with a headline, a date and the site's Person", async () => {
  const { articleLd, articleLdScript, injectArticleLd, PERSON } = await import("./lib/article-ld.ts");
  const { sitemapDates } = await import("./gen-feeds.ts");
  const dates = sitemapDates(readFileSync("public/sitemap.xml", "utf8"));
  const pages = content();
  // The floor mirrors build.ts's: a collector that stops matching must not pass over nothing.
  assert.ok(pages.length >= 30, `only ${pages.length} content pages found`);
  for (const s of pages) {
    const html = readFileSync(`src/pages${s.path}.html`, "utf8");
    const ld = articleLd({ path: s.path, section: s.section, html, date: dates.get(s.path) });
    assert.ok(ld.headline && !String(ld.headline).startsWith("aadhar.sh/"), `${s.path}: headline ${JSON.stringify(ld.headline)} is a path, not a topic`);
    assert.match(ld.datePublished, /^\d{4}-\d{2}-\d{2}$/, s.path);
    assert.deepEqual(ld.author, PERSON, s.path);
    assert.equal(ld.url, `https://aadhar.sh${s.path}`);
    const out = injectArticleLd(html, articleLdScript(ld));
    const block = /<script type="application\/ld\+json">([^<]*)<\/script>\n<\/head>/.exec(out);
    assert.ok(block, `${s.path}: the block is not the last thing in <head>`);
    assert.deepEqual(JSON.parse(block[1]), ld, s.path);
  }
});

test("the homepage still declares the Person and WebSite the Articles point at", () => {
  const home = readFileSync("src/pages/index.html", "utf8");
  assert.match(home, /"@id": "https:\/\/aadhar\.sh\/#person"/);
  assert.match(home, /"@id": "https:\/\/aadhar\.sh\/#website"/);
});

test("the headline comes from the og:title topic, then the h1, and refuses a page with neither", async () => {
  const { articleLd, topicOf, h1Of, decodeEntities } = await import("./lib/article-ld.ts");
  assert.equal(topicOf("aadhar.sh/lwe/fhe · Fully Homomorphic Encryption"), "Fully Homomorphic Encryption");
  assert.equal(topicOf("aadhar.sh/garage/av2: AV2, before anyone can see it"), "AV2, before anyone can see it");
  assert.equal(topicOf("aadhar.sh/garage/bytes on the wire"), null);
  assert.equal(h1Of('<h1>Horizon <span class="badge shipped">shipped</span></h1>'), "Horizon");
  assert.equal(decodeEntities("Vigen&#232;re &amp; Kryptos"), "Vigenère & Kryptos");
  assert.throws(() => articleLd({ path: "/garage/x", section: "garage", html: "<head></head>", date: "2026-01-01" }), /neither an og:title topic nor an h1/);
  assert.throws(() => articleLd({ path: "/garage/x", section: "garage", html: "<h1>X</h1>", date: undefined }), /no sitemap date/);
});

test("a string in the block cannot close its script, and a hand-written Article is left alone", async () => {
  const { articleLdScript, injectArticleLd } = await import("./lib/article-ld.ts");
  const script = articleLdScript({ headline: "</script><script>alert(1)</script>" });
  assert.ok(!script.slice(0, -"</script>".length).includes("</script"), script);
  const authored = '<head><script type="application/ld+json">{"@type":"TechArticle"}</script></head>';
  assert.equal(injectArticleLd(authored, script), authored);
});
