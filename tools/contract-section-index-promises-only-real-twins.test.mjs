// A per-section llms.txt is built from the REGISTRY and the twins from the
// TREE, and nothing joined the two: /garage/dyno was promised at
// /garage/dyno.md by /garage/llms.txt and answered 404 there, because the page
// is Worker-rendered off the perf-history branch and no source walk can produce
// its twin. Found from outside, by a sweep that HEADs every URL an llms.txt
// advertises. This pins the join: every `.md` an index links is a file the same
// build holds, every surface in an indexed section is listed exactly once, and
// the parameter that makes it so is proven to be read.
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { INDEXED_SECTIONS, ORIGIN, buildTwins, renderSectionIndex, twinPath } from "./gen-md-twins.ts";

const root = fileURLToPath(ROOT);
const mdLinks = (index) => [...index.matchAll(/\]\((https:\/\/aadhar\.sh)(\/[^)\s]+\.md)\)/g)].map((m) => m[2]);

test("every .md a section index links is a twin the same build holds", () => {
  const { files } = buildTwins(root);
  let linked = 0;
  for (const section of INDEXED_SECTIONS) {
    const index = files.get(`/${section}/llms.txt`);
    assert.ok(index, `no index for /${section}`);
    for (const path of mdLinks(index)) {
      linked += 1;
      assert.ok(files.has(path), `/${section}/llms.txt promises ${path} and this build holds no such twin`);
    }
  }
  // A scanner that matches nothing reports a pass; the garage index alone links a dozen.
  assert.ok(linked >= 20, `matched only ${linked} .md links across the section indexes, so the link pattern no longer fits the index`);
});

test("every surface in an indexed section is listed exactly once, as a twin or as HTML", async () => {
  const manifest = JSON.parse(await readFile(new URL("config/site-manifest.json", ROOT), "utf8"));
  const { files } = buildTwins(root);
  for (const section of INDEXED_SECTIONS) {
    const index = files.get(`/${section}/llms.txt`);
    for (const s of manifest.surfaces.filter((x) => x.section === section)) {
      const asTwin = index.includes(`](${ORIGIN}${twinPath(s.path)})`);
      const asHtml = index.includes(`](${ORIGIN}${s.path})`);
      assert.ok(asTwin !== asHtml, `${s.path} is listed ${asTwin && asHtml ? "twice" : "nowhere"} in /${section}/llms.txt`);
      if (asHtml) assert.ok(!files.has(twinPath(s.path)), `${s.path} has a twin and is still listed as HTML only`);
    }
  }
});

test("control: the twins set is what decides, so an empty set lists every page as HTML only", async () => {
  const manifest = JSON.parse(await readFile(new URL("config/site-manifest.json", ROOT), "utf8"));
  const none = renderSectionIndex("garage", manifest.surfaces, { twins: new Set() });
  assert.equal(mdLinks(none).length, 0, "with no twins held, no .md may be promised");
  assert.ok(none.includes("## HTML only"), "the HTML-only heading must appear when a page has no twin");
  // Legacy shape, documented at the function: no set means link everything.
  const all = renderSectionIndex("garage", manifest.surfaces);
  assert.ok(mdLinks(all).length >= 20 && !all.includes("## HTML only"));
});
