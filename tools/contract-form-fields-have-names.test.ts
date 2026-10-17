// ── every form field has an accessible name a placeholder doesn't supply ────
// A placeholder is a hint, and it disappears once someone types. Browsers fall
// back to it for the accessible name, but WCAG 1.3.1/3.3.2 want a label that
// stays, so the second specification.website audit (2026-10-17) flagged
// /serendipity's search box and the three /serendipity/contribute fields, each
// named by its placeholder alone. A site-wide sweep for the same thing found
// three more on static pages: two demo inputs on /garage/horizon and
// /lwe/vigenere's second keyword, which only ever shows beside a checkbox.
//
// A field passes with aria-label, aria-labelledby, a title, a <label for>, or
// an enclosing <label>. Fields that never render (type=hidden, the hidden
// attribute) and buttons, which name themselves, are skipped.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { stripUnrendered } from "./lib/html-raw-text.ts";
import { renderContribute, renderSerendipityPage } from "../serendipity/serendipity.ts";
import { staticShellPages } from "./photos/gen-desktop-partial.ts";

const strip = (html) => stripUnrendered(html);

function unnamed(source) {
  const html = strip(source);
  const fors = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const out: any[] = [];
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/\btype="(hidden|submit|button|reset|image)"/.test(attrs) || /\shidden(?:[\s=>]|$)/.test(attrs)) continue;
    if (/\saria-label(?:ledby)?="[^"]+"/.test(attrs) || /\stitle="[^"]+"/.test(attrs)) continue;
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (id && fors.has(id)) continue;
    const before = html.slice(0, m.index);
    if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
    out.push(m[0].slice(0, 90));
  }
  return out;
}

test("the check flags a placeholder-only field and passes each kind of label (control)", () => {
  assert.equal(unnamed('<input id="q" placeholder="Search">').length, 1);
  assert.equal(unnamed('<textarea name="t" placeholder="x"></textarea>').length, 1);
  assert.deepEqual(unnamed([
    '<input aria-label="Search">',
    '<label for="q">Search</label><input id="q">',
    '<label>Search <input></label>',
    '<input type="hidden" name="x">',
    '<input type="file" hidden>',
    '<input type="submit" value="Go">',
  ].join("")), []);
});

test("no static page ships a field without a name", () => {
  const pages = staticShellPages();
  assert.ok(pages.length >= 40, `only ${pages.length} static pages found`);
  const found = pages.flatMap((file) => unnamed(readFileSync(file, "utf8")).map((f) => `${file}: ${f}`));
  assert.deepEqual(found, []);
});

test("/serendipity's search and the contribute forms name every field", async () => {
  const dashboard = await renderSerendipityPage().text();
  assert.match(dashboard, /id="ev-search"/, "the search box moved; point this test at it");
  assert.deepEqual(unnamed(dashboard), []);
  // One summary row, as D1 returns it for a browser that hasn't contributed.
  const d = { prepare: () => ({ get: async () => ({ active_count: 0 }) }) };
  const contribute = await (await renderContribute(d, "/serendipity/contribute", "uid", "")).text();
  assert.equal((contribute.match(/<(?:input|textarea)\b/g) ?? []).length, 3, "the contribute page's fields changed; recount");
  assert.deepEqual(unnamed(contribute), []);
});
