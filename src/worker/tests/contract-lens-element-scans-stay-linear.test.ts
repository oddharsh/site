// ── Lens scans other origins' elements in linear time ───────────────────────
// lensText and lensMarkdown read pages up to 2 MB that whoever owns the other
// origin wrote. Until 2026-11-18 they found elements with regexes like
// /<pre[^>]*>([\s\S]*?)<\/pre>/gi, which rescan to the end of the input from
// every opener that has no closer: "<pre>" repeated 64,000 times took 3.6 s in
// Node 26. The budget below is about 50x what the linear scan takes on 256 KB.
import { assert, test } from "../../../tools/tests/contract-shared.ts";

const BUDGET_MS = 250;
const elapsed = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

// The regexes lensElements replaced, each given an inner group so the fuzz can
// compare what a callback sees. Group 1 is the name wherever the closer repeats it.
const ORIGINALS = {
  title: [/<title[^>]*>([\s\S]*?)<\/title>/gi, false],
  pre: [/<pre[^>]*>([\s\S]*?)<\/pre>/gi, false],
  code: [/<code[^>]*>([\s\S]*?)<\/code>/gi, false],
  blockquote: [/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, false],
  li: [/<li[^>]*>([\s\S]*?)<\/li>/gi, false],
  heading: [/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, true],
  link: [/<a\b[^>]*>([\s\S]*?)<\/a>/gi, false],
  strong: [/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, true],
  em: [/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, true],
  comment: [/<!--([\s\S]*?)(?:-->|--!>)/g, false],
  textSkip: [/<(script|style|noscript|template|svg)([\s\S]*?)<\/\1>/gi, true],
  markdownSkip: [/<(script|style|noscript|template|svg|head|nav|footer|aside)\b([\s\S]*?)<\/\1\b[^>]*>/gi, true],
} as const;

const TOKENS = [
  ..."<>/!- x\n=\"'".split(""),
  ...["<pre>", "<PRE a=1>", "</pre>", "</Pre>", "<prefix>", "<code>", "</code>", "<blockquote>", "</blockquote>", "<li>", "</li>", "<link>"],
  ...["<h2>", "<H3 id=x>", "</h2>", "</h3>", "</H2>", "<h7>", "<a href=x>", "<a>", "<abbr>", "</a>", "</A>"],
  ...["<b>", "<B>", "</b>", "<br>", "<strong>", "</strong>", "</STRONG>", "<em>", "</em>", "<i>", "</i>", "<img src=y>"],
  ...["<!--", "-->", "--!>", "<!-->", "<script>", "<SCRIPT x>", "</script>", "</script x>", "</scripts>", "<style>", "</style>"],
  ...["<svg", "</svg>", "<head>", "<header>", "</head>", "</header>", "<nav>", "</nav >", "<body>", "<BODY x>", "</body>", "<title>", "</title>"],
];

// mulberry32, seeded so a failure names an input that reproduces.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function* inputs(count: number) {
  const next = random(0x1e45);
  for (let n = 0; n < count; n++) {
    let html = "";
    for (let k = Math.floor(next() * 40); k > 0; k--) html += TOKENS[Math.floor(next() * TOKENS.length)];
    yield html;
  }
}

test("each element pass finds the matches the regex it replaced found", async () => {
  const { LENS_ELEMENTS, lensReplaceElements } = await import("../lens.ts");
  const mark = (inner: string, name: string, whole: string) => `[${name}|${inner}|${whole}]`;
  for (const html of inputs(4000)) {
    for (const [key, [re, named]] of Object.entries(ORIGINALS)) {
      const want = html.replace(re, (whole, ...groups) => (named ? mark(groups[1], groups[0], whole) : mark(groups[0], "", whole)));
      assert.equal(lensReplaceElements(html, LENS_ELEMENTS[key], mark), want, `${key} on ${JSON.stringify(html)}`);
    }
  }
  assert.equal(lensReplaceElements("<p><B x>bold</b></p>", LENS_ELEMENTS.strong, mark), "<p>[B|bold|<B x>bold</b>]</p>");
});

test("lensBody takes what the greedy <body> match took", async () => {
  const { lensBody } = await import("../lens.ts");
  for (const html of inputs(4000)) {
    assert.equal(lensBody(html), html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html, JSON.stringify(html));
  }
  assert.equal(lensBody("<body a>x</body>y</BODY>"), "x</body>y");
  assert.equal(lensBody("<body>x"), "<body>x");
});

test("lensText and lensMarkdown stay inside the budget on 256 KB of openers with no closer", async () => {
  const { lensMarkdown, lensText } = await import("../lens.ts");
  const openers = ["<pre>", "<code>", "<h2>", "<blockquote>", "<li>", "<a>", "<b>", "<i>", "<!--x>", "<script>", "<nav>", "<body>"];
  // The rest leave a tail with no ">" in it, which no pass may search: an <img
  // runs [^>]* to the end, and so does every "</nav " the <nav> closer tries.
  const tails = [
    ["", "<img x"],
    ["", "<pre"],
    ["<nav>", "</nav x"],
  ];
  for (const [lead, unit] of [...openers.map((unit) => ["", unit]), ...tails]) {
    const html = `<p>kept</p>${lead}${unit.repeat(Math.floor((256 * 1024) / unit.length))}`;
    let md = "";
    let text = "";
    const ms = elapsed(() => {
      md = lensMarkdown(html, "https://x.test/");
      text = lensText(html);
    });
    assert.ok(ms < BUDGET_MS, `${unit} took ${ms.toFixed(0)} ms on 256 KB`);
    assert.equal(md.slice(0, 4), "kept", unit);
    assert.equal(text.slice(0, 4), "kept", unit);
  }
});
