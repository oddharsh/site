// ── text in another script carries its language ─────────────────────────────
// Every page is <html lang="en">, so a screen reader reads 中 with an English
// voice: it spells the code point, mispronounces it or skips it. WCAG 3.1.2
// asks for lang on each passage in another language. The second
// specification.website audit (2026-10-17) found the CJK on /lwe/utf8 and in
// /lwe's buddy line unmarked, and /garage/pretext's international demo drawing
// Chinese and Arabic into an English line with no lang and no direction
// isolate for the Arabic.
//
// The static check walks text the parser would render (not script, style or
// attribute values) and asks the nearest lang for each Han or Arabic run. The
// pretext demo builds its lines in script, so its marking function is run on
// the demo's own string.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { stripUnrendered } from "./lib/html-raw-text.ts";
import { staticShellPages } from "./photos/gen-desktop-partial.ts";

const HAN = /[\p{Script=Han}]/u;
const ARABIC = /\p{Script=Arabic}/u;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// Each rendered text run in another script, with the lang in force around it.
function unmarked(html) {
  const out = [];
  const stack = [];
  const src = stripUnrendered(html);
  const token = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  /** @type {string | null} */
  let raw = null;
  for (const m of src.matchAll(token)) {
    const [, close, tagName, attrs, text] = m;
    const tag = tagName?.toLowerCase();
    if (raw) { if (close && tag === raw) { raw = null; stack.pop(); } continue; }
    if (text !== undefined) {
      const lang = stack.findLast((e) => e.lang)?.lang ?? "";
      for (const run of text.match(/[\p{Script=Han}\p{Script=Arabic}　-〿＀-￯]+/gu) ?? []) {
        if (HAN.test(run) && !/^(zh|ja|ko)\b/.test(lang)) out.push(`${run} (lang "${lang}")`);
        else if (ARABIC.test(run) && !/^ar\b/.test(lang)) out.push(`${run} (lang "${lang}")`);
      }
      continue;
    }
    if (close) {
      const at = stack.findLastIndex((e) => e.tag === tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    stack.push({ tag, lang: /\slang="([^"]*)"/.exec(attrs)?.[1] });
    if (tag === "script" || tag === "style" || tag === "template" || tag === "textarea") raw = tag;
  }
  return out;
}

test("the walk flags unmarked CJK and Arabic and passes marked runs (control)", () => {
  assert.equal(unmarked('<html lang="en"><body><p>A is <code>中</code></p></body></html>').length, 1);
  assert.equal(unmarked('<html lang="en"><body><p>بدأت</p></body></html>').length, 1);
  assert.deepEqual(unmarked('<html lang="en"><body><p>A is <code lang="zh">中</code>, <bdi lang="ar">بدأت</bdi><br>ok</p></body></html>'), []);
  assert.deepEqual(unmarked('<html lang="en"><body><input value="中"><script>"中"</script><style>:root{--g:"字"}</style></body></html>'), [],
    "attribute values, script and style are not rendered text");
});

test("no static page renders CJK or Arabic text without a matching lang", () => {
  const pages = staticShellPages();
  assert.ok(pages.length >= 40, `only ${pages.length} static pages found`);
  const found = pages.flatMap((file) => unmarked(readFileSync(file, "utf8")).map((r) => `${file}: ${r}`));
  assert.deepEqual(found, []);
});

test("/garage/pretext's international demo marks each script run it draws", () => {
  const page = readFileSync("src/pages/garage/pretext.html", "utf8");
  const sample = /const I18N = ("[^"]+");/.exec(page)?.[1];
  const fn = /const RUNS = [\s\S]*?\n  function marked\(t\) \{[\s\S]*?\n  \}\n/.exec(page)?.[0];
  assert.ok(sample && fn, "the demo's I18N string or its marked() helper moved; point this test at them");
  const esc = (s) => s.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
  const marked = new Function("esc", `${fn}; return marked;`)(esc);
  const text = JSON.parse(sample);
  // Every way the demo can break the line still marks each fragment.
  for (const line of [text, ...text.split(/(?<=\s)|(?<=，)/u)]) {
    const html = `<html lang="en"><body><div class="ln">${marked(line)}</div></body></html>`;
    assert.deepEqual(unmarked(html), [], `line ${JSON.stringify(line)}`);
  }
  assert.match(marked(text), /<bdi lang="ar">[^<]+<\/bdi>/, "the Arabic needs a direction isolate, not just a lang");
});
