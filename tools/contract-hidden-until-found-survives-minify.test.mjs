// ── hidden="until-found" survives minification ───────────────────────────────
// minify-html treats `hidden` as boolean and serves `hidden="until-found"` as
// plain `hidden`, which find-in-page can never reveal. /garage/horizon's
// until-found demo shipped broken that way until 2026-10-07: production served
// `<p class=huf hidden id=huf-target>`. tools/lib/hidden-until-found.ts swaps
// the value through a sentinel; these tests hold the swap and say when it can go.
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import minifyHtml from "@minify-html/node";
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { minifyKeepingUntilFound, protectUntilFoundTag, UNTIL_FOUND_SENTINEL } from "./lib/hidden-until-found.ts";
import { stripRawText } from "./lib/html-raw-text.ts";

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

const minify = (html) => minifyHtml.minify(Buffer.from(html), { keep_html_and_head_opening_tags: true }).toString();

// Every start tag in `html` carrying hidden=until-found in any quoting, script
// and style bodies removed first so a string literal is never a tag.
const untilFoundTags = (html) => {
  const markup = stripRawText(stripRawText(html, "script"), "style");
  return markup.match(/<[A-Za-z][^<>]*?\shidden\s*=\s*(["']?)until-found\1(?=[\s/>])[^<>]*>/gi) ?? [];
};

// Protect every start tag the cheap way, for fixtures with no raw text in them.
const protect = (html) => html.replace(/<[A-Za-z][^<>]*>/g, protectUntilFoundTag);

test("TRIPWIRE: minify-html still drops the value (when this fails, delete the swap)", () => {
  // The control. If a minify-html bump keeps the value on its own, the swap in
  // tools/lib/hidden-until-found.ts is dead weight: remove it, its two call
  // sites in tools/build.ts, and this file's first two tests.
  assert.equal(minify('<p hidden="until-found" id=a>x</p>'), "<p hidden id=a>x",
    "minify-html now keeps hidden=until-found by itself; the sentinel swap can go");
});

test("the swap restores every until-found and touches nothing else", () => {
  const source = [
    '<p hidden="until-found" id=a class=b>one</p>',
    "<div HIDDEN='Until-Found'>two</div>",
    "<section hidden=until-found>three</section>",
    "<p hidden>plain hidden stays plain</p>",
    '<p title="hidden=until-found" data-x="hidden-until-found">a mention in a value is not the attribute</p>',
    '<p>prose: <code>hidden="until-found"</code></p>',
  ].join("");
  const out = minifyKeepingUntilFound(source, protect(source), minify, "fixture");
  assert.match(out, /<p class=b hidden=until-found id=a>one/);
  assert.match(out, /<div hidden=until-found>two/);
  assert.match(out, /<section hidden=until-found>three/);
  assert.match(out, /<p hidden>plain hidden stays plain/);
  assert.match(out, /<p title="hidden=until-found" data-x=hidden-until-found>a mention/);
  assert.match(out, /<code>hidden="until-found"<\/code>/);
  assert.ok(!out.includes(UNTIL_FOUND_SENTINEL), "a sentinel leaked into the output");
});

test("the swap refuses a source that already spells its sentinel, and a minifier that loses one", () => {
  const clash = `<p ${UNTIL_FOUND_SENTINEL}>x</p>`;
  assert.throws(() => minifyKeepingUntilFound(clash, protect(clash), minify, "clash"), /reserves/);
  const source = '<p hidden="until-found">x</p>';
  assert.throws(() => minifyKeepingUntilFound(source, protect(source), () => "<p hidden>x", "lossy"), /returned 0/);
});

test("every built page keeps each hidden=until-found its readable source has", { skip: needsBuild }, async () => {
  const twins = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) await walk(url);
      else if (e.name.endsWith(".src.html")) twins.push(url);
    }
  };
  await walk(BUILT);
  let carriers = 0;
  for (const twin of twins) {
    const want = untilFoundTags(await readFile(twin, "utf8")).length;
    if (!want) continue;
    carriers++;
    const served = new URL(twin.href.replace(/\.src\.html$/, ".html"));
    const rel = relative(fileURLToPath(BUILT), fileURLToPath(served));
    const got = untilFoundTags(await readFile(served, "utf8"));
    assert.equal(got.length, want, `${rel}: source has ${want} hidden="until-found", the served page keeps ${got.length}`);
  }
  // Without a carrier this test passes on an empty walk, so name the one that
  // motivated it: the horizon demo's find-in-page target.
  assert.ok(carriers > 0, "no built page's source carries hidden=until-found; the walk found nothing to check");
  const horizon = await readFile(new URL("garage/horizon.html", BUILT), "utf8");
  assert.ok(untilFoundTags(horizon).some((t) => /\sid=["']?huf-target\b/.test(t)),
    "/garage/horizon's #huf-target is served without hidden=until-found");
});
