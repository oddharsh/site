// ── webmention: who wrote the source, read the way mf2 parsers read it ─────
// The receiver's author reader used to take visible text only. A microformats2
// value can live in an attribute that draws nothing (<data value>, <abbr title>,
// <img alt>, <input value>) or be split across value-class children, and this
// site's own notes carry their author exactly that way. XRay, mf2py and
// microformats-parser read those; the regex read nothing and reported the
// hostname. These fixtures pin what lib/mf2.ts reads and what parseSource makes
// of it, with a plain-text author kept as the control.
import {
  assert,
  deferredContext,
  fakeD1,
  handleWebmention,
  test,
  testGlobals,
  wmEnv,
  wmPost,
} from "./contract-shared.ts";
import { parseSource } from "../src/worker/webmention.ts";
import { parseMf2 } from "../src/worker/lib/mf2.ts";
import { renderInboxMail } from "../src/worker/inbox.ts";
import { renderWritingPost } from "../src/worker/writing.ts";
import { readFileSync } from "node:fs";

const TARGET = "https://aadhar.sh/garage/chunks";

// A standalone note as the site really renders it (renderWritingPost, the
// same path /writing/<slug> serves), so this pins the receiver against the
// markup that ships rather than a copy of it. The author is two empty <data>
// elements, so there is no visible text to read at all. A textarea's contents
// are inert to linksTo, so a paragraph carrying the link goes in before </body>.
const NOTE_SLUG = "in-flux";
const noteEnv = {
  ASSETS: {
    fetch: async (url) => {
      try { return new Response(readFileSync(`src/content${new URL(url).pathname}`, "utf8")); }
      catch { return new Response("", { status: 404 }); }
    },
  },
};
const NOTE_TEXT = readFileSync(`src/content/writing/${NOTE_SLUG}.txt`, "utf8");
const renderedNote = await (await renderWritingPost(NOTE_SLUG, noteEnv)).text();
assert.ok(renderedNote.includes("</body>"), "the note render has a </body> to put the link before");
const NOTE = (target = TARGET) => renderedNote.replace("</body>", `<p>see <a href="${target}">chunks</a></p></body>`);

const page = (body) => `<!DOCTYPE html><html><head><title>Page title</title></head><body>${body}
<p>see <a href="${TARGET}">chunks</a></p></body></html>`;

test("this site's own note parses to its real author, name, url and date", () => {
  const p = parseSource(NOTE(), "https://aadhar.sh/writing/in-flux", TARGET);
  assert.equal(p.author, "Aadharsh Pannirselvam", "the h-card's p-name is a <data value>, which draws nothing and still names him");
  assert.equal(p.authorUrl, "https://aadhar.sh/");
  assert.equal(p.name, "a note on this notepad");
  assert.equal(p.title, "a note on this notepad", "an explicit p-name outranks the <title>");
  assert.equal(p.url, "https://aadhar.sh/writing/in-flux");
  assert.equal(p.published, "2026-06-06");

  const [entry] = parseMf2(NOTE(), "https://aadhar.sh/writing/in-flux").items;
  assert.deepEqual(entry.type, ["h-entry"]);
  const content = /** @type {{ value: string } | undefined} */ (entry.properties.content?.[0]);
  assert.equal(content?.value, NOTE_TEXT.trim(),
    "a textarea's children are one raw text run, so the value is the .txt verbatim, trimmed at the ends as mf2 trims every e-* value");
});

test("the note's author is what gets stored, where the hostname used to be", async () => {
  // Measured before this change on the same fixture: author "notes.example",
  // author_url "https://notes.example". A mirror host stands in for aadhar.sh,
  // which refuses a mention from itself.
  const db = fakeD1();
  const real = globalThis.fetch;
  testGlobals.fetch = async () => new Response(NOTE(), { headers: { "content-type": "text/html" } });
  try {
    const ctx = deferredContext();
    await handleWebmention(wmPost("https://notes.example/writing/in-flux", TARGET), wmEnv(db), ctx);
    await ctx.settle();
  } finally { testGlobals.fetch = real; }
  const row = /** @type {{ author: string, author_url: string, title: string }} */ (db.rows[0]);
  assert.equal(row.author, "Aadharsh Pannirselvam");
  assert.equal(row.author_url, "https://aadhar.sh/");
  assert.equal(row.title, "a note on this notepad");
});

test("p-* reads every value source the spec lists, in its order", () => {
  const cases = [
    ['<data class="p-author" value="Mari Kondo">MK</data>', "Mari Kondo", "data@value"],
    ['<abbr class="p-author" title="Mari Kondo">MK</abbr>', "Mari Kondo", "abbr@title"],
    ['<img class="p-author" src="/m.jpg" alt="Mari Kondo">', "Mari Kondo", "img@alt"],
    ['<map><area class="p-author" href="/" alt="Mari Kondo"></map>', "Mari Kondo", "area@alt"],
    ['<input class="p-author" value="Mari Kondo">', "Mari Kondo", "input@value"],
    ['<span class="p-author">by <span class="value">Mari</span> (aka <em>MK</em>) <span class="value"> Kondo</span></span>', "Mari Kondo", "the value-class pattern"],
    ['<span class="p-author"><span class="value-title" title="Mari Kondo"></span>MK</span>', "Mari Kondo", "value-title"],
    ['<span class="p-author">Mari Kondo</span>', "Mari Kondo", "plain text, the control"],
  ];
  for (const [markup, want, rule] of cases) {
    const p = parseSource(page(`<article class="h-entry">${markup}</article>`), "https://mari.example/post", TARGET);
    assert.equal(p.author, want, rule);
    assert.equal(p.authorUrl, "https://mari.example", `${rule}: a name with no URL keeps the source origin`);
  }
});

test("u-* reads hrefs, srcs, poster, data and the attribute fallbacks, resolved against the page", () => {
  const base = "https://mari.example/posts/1";
  const cases = [
    ['<a class="u-x" href="/a">t</a>', "https://mari.example/a"],
    ['<link class="u-x" href="l">', "https://mari.example/posts/l"],
    ['<img class="u-x" src="/i.jpg" alt="i">', "https://mari.example/i.jpg"],
    ['<audio class="u-x" src="/s.mp3"></audio>', "https://mari.example/s.mp3"],
    ['<video class="u-x" poster="/p.jpg"></video>', "https://mari.example/p.jpg"],
    ['<object class="u-x" data="/o.svg"></object>', "https://mari.example/o.svg"],
    ['<data class="u-x" value="https://e.example/d">t</data>', "https://e.example/d"],
    ['<abbr class="u-x" title="/ab">t</abbr>', "https://mari.example/ab"],
    ['<span class="u-x"><span class="value">/v</span></span>', "https://mari.example/v"],
  ];
  for (const [markup, want] of cases) {
    const [item] = parseMf2(`<div class="h-x">${markup}</div>`, base).items;
    assert.deepEqual(item.properties.x, [want], markup);
  }
  const [based] = parseMf2('<base href="https://cdn.example/root/"><div class="h-x"><a class="u-x" href="a">t</a></div>', base).items;
  assert.deepEqual(based.properties.x, ["https://cdn.example/root/a"], "<base href> is the base a browser would use");
});

test("dt-* reads datetime, title, value and the value-class date and time parts", () => {
  const cases = [
    ['<time class="dt-published" datetime="2026-09-01T14:30:00-04:00">Sept 1</time>', "2026-09-01T14:30:00-04:00"],
    ['<ins class="dt-published" datetime="2026-09-02">x</ins>', "2026-09-02"],
    ['<del class="dt-published" datetime="2026-09-03">x</del>', "2026-09-03"],
    ['<abbr class="dt-published" title="2026-09-04">Sept 4</abbr>', "2026-09-04"],
    ['<data class="dt-published" value="2026-09-05">Sept 5</data>', "2026-09-05"],
    ['<span class="dt-published"><span class="value">2026-09-06</span> at <span class="value">14:30</span><span class="value">-04:00</span></span>', "2026-09-06 14:30-04:00"],
    ['<span class="dt-published"><time class="value" datetime="2026-09-07">Monday</time>, <abbr class="value" title="09:15">quarter past nine</abbr></span>', "2026-09-07 09:15"],
    ['<span class="dt-published">2026-09-08</span>', "2026-09-08"],
  ];
  for (const [markup, want] of cases) {
    const p = parseSource(page(`<article class="h-entry"><span class="p-name">Post</span>${markup}</article>`), "https://mari.example/post", TARGET);
    assert.equal(p.published, want, markup);
  }
});

test("a nested h-card author gives its name, url and photo, implied or explicit", () => {
  // An h-card that is only a linked photo: name from the img alt, url from the
  // a@href, photo from the img@src, all by the implied rules.
  const implied = parseSource(page(`<article class="h-entry"><p class="e-content">hi</p>
    <a class="p-author h-card" href="https://mari.example/"><img src="/me.jpg" alt="Mari Kondo"></a></article>`),
  "https://mari.example/post", TARGET);
  assert.equal(implied.author, "Mari Kondo");
  assert.equal(implied.authorUrl, "https://mari.example/");
  assert.equal(implied.authorPhoto, "https://mari.example/me.jpg");

  const explicit = parseSource(page(`<article class="h-entry"><div class="p-author h-card">
    <img class="u-photo" src="https://cdn.example/m.png" alt="">
    <a class="u-url" href="https://mari.example/about"><abbr class="p-name" title="Mari Kondo">MK</abbr></a></div></article>`),
  "https://mari.example/post", TARGET);
  assert.equal(explicit.author, "Mari Kondo");
  assert.equal(explicit.authorUrl, "https://mari.example/about");
  assert.equal(explicit.authorPhoto, "https://cdn.example/m.png");
});

test("an author given as a URL takes its name from the h-card that URL names", () => {
  const withCard = parseSource(page(`
    <div class="h-card"><a class="u-url p-name" href="/">Mari Kondo</a></div>
    <article class="h-entry"><a class="u-author" href="/"></a><p class="p-name">Post</p></article>`),
  "https://mari.example/post", TARGET);
  assert.equal(withCard.author, "Mari Kondo");
  assert.equal(withCard.authorUrl, "https://mari.example/");

  // No card for it on the page: the author page's host is the honest name, and
  // nothing is fetched to find a better one.
  const bare = parseSource(page(`<article class="h-entry"><a class="u-author" href="https://www.kondo.example/"></a></article>`),
    "https://mari.example/post", TARGET);
  assert.equal(bare.author, "kondo.example");
  assert.equal(bare.authorUrl, "https://www.kondo.example/");
});

test("with no author on the entry, the h-feed, rel=author and the representative card are asked in turn", () => {
  const feed = parseSource(page(`<div class="h-feed"><span class="p-author h-card"><data class="p-name" value="Feed Owner"></data></span>
    <article class="h-entry"><span class="p-name">Post</span></article></div>`), "https://mari.example/post", TARGET);
  assert.equal(feed.author, "Feed Owner", "an entry inherits its feed's author");

  const rel = parseSource(page(`<link rel="author" href="https://mari.example/about">
    <div class="h-card"><a class="u-url" href="/about">Mari Kondo</a></div>
    <article class="h-entry"><span class="p-name">Post</span></article>`), "https://mari.example/post", TARGET);
  assert.equal(rel.author, "Mari Kondo");
  assert.equal(rel.authorUrl, "https://mari.example/about");

  const rep = parseSource(page(`<a rel="me" href="https://social.example/@mari">me</a>
    <div class="h-card"><span class="p-name">Mari Kondo</span><a class="u-url" href="https://social.example/@mari">s</a></div>
    <article class="h-entry"><span class="p-name">Post</span></article>`), "https://mari.example/post", TARGET);
  assert.equal(rep.author, "Mari Kondo", "a top-level card whose url is also rel=me represents the page");
});

test("markup a browser never renders does not name an author", () => {
  for (const hidden of [
    '<!-- <span class="p-author">Evil</span> -->',
    '<script>document.write(\'<span class="p-author">Evil</span>\')</script>',
    '<template><span class="p-author h-card"><data class="p-name" value="Evil"></data></span></template>',
  ]) {
    const p = parseSource(page(`<article class="h-entry"><span class="p-name">Post</span>${hidden}</article>`), "https://mari.example/post", TARGET);
    assert.equal(p.author, "mari.example", hidden);
  }
});

test("an author URL that is not http(s) is dropped, and a hostile name stays text at render", () => {
  const p = parseSource(page(`<article class="h-entry"><span class="p-author h-card">
    <data class="p-name" value="&lt;img src=x onerror=alert(1)&gt;"></data>
    <data class="u-url" value="javascript:alert(1)"></data></span></article>`), "https://mari.example/post", TARGET);
  assert.equal(p.author, "<img src=x onerror=alert(1)>", "an attribute value arrives decoded, the same text a browser holds");
  assert.equal(p.authorUrl, "https://mari.example", "a javascript: URL never becomes the stored author link");
  const out = renderInboxMail([{ kind: "reply", author: p.author, source: "https://mari.example/post", target: TARGET, approved_at: 0 }], "ok", "https://aadhar.sh").html;
  assert.ok(!out.includes("<img src=x"), "the inbox escapes the parsed name");
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("the parse is bounded on a hostile page", () => {
  // 60,000 unclosed divs: past the node cap and far past the depth cap, and deep
  // enough to overflow any walk that recursed once per open tag.
  const hostile = "<div>".repeat(60000) + '<article class="h-entry"><span class="p-author">late</span></article>';
  const t0 = performance.now();
  const p = parseSource(hostile, "https://mari.example/post", TARGET);
  const ms = performance.now() - t0;
  assert.equal(p.author, "mari.example", "the entry past the node cap is not read, and the floor holds");
  assert.ok(ms < 2000, `parsed in ${ms.toFixed(0)}ms`);

  const wide = `<article class="h-entry"><span class="p-author">${"x".repeat(50000)}</span></article>`;
  assert.equal(parseSource(wide, "https://mari.example/post", TARGET).author.length, 120, "a stored name is capped");
});
