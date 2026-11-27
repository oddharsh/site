// ── a data table's header row is a <thead> of scope="col" cells ─────────────
// A screen reader announces a cell with its column header only when it can
// tell which cells are headers for which. A <th> in a plain first row usually
// works by heuristic, and not always: the second specification.website audit
// (2026-10-17) flagged /garage/octane, /pqc, /typed-config, /hidden-flags and
// the /ledger invoice, whose header rows sat in the body with no scope. A
// site-wide sweep found /garage/teardown's table the same way.
//
// Three places build tables: static markup (the garage pages come from their
// specs through pipelines/garage/generate.ts), page scripts that draw a table
// with createElement, and the ledger's Worker renderer. Each is checked where
// it builds.
//
// Site-wide the rule is the <thead>: a <th> in one gets column scope from
// HTML's own "auto" state, and 29 static tables on 10 pages already rely on that.
// The audited tables also say scope="col" outright, and keep it.
//
// Two pages stripe their rows with nth-child. A <thead> takes the header row
// out of the count, so their rule moved from even to odd to keep the same
// rows tinted.
import { readFileSync } from "node:fs";
import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { stripUnrendered } from "../../../tools/lib/html-raw-text.ts";
import { renderLedgerLines } from "../ledger.ts";
import { staticShellPages } from "../../../tools/photos/gen-desktop-partial.ts";

const strip = (html) => stripUnrendered(html);

// Each table holding a <th> whose header row is not a <thead> (of scope="col"
// cells, when `scoped`).
function headerless(html, { scoped = false }: Record<string, any> = {}) {
  const out: any[] = [];
  for (const [table] of strip(html).matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    if (!/<th\b/.test(table)) continue;
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/.exec(table)?.[1];
    const label = table.slice(0, 60).replace(/\s+/g, " ");
    if (!head) {
      out.push(`${label}: no <thead>`);
      continue;
    }
    const cells = [...head.matchAll(/<th\b([^>]*)>/g)];
    if (!cells.length) out.push(`${label}: an empty <thead>`);
    else if (scoped && cells.some(([, attrs]) => !/\sscope="col"/.test(attrs))) out.push(`${label}: a header cell without scope="col"`);
  }
  return out;
}

test("the check flags a header row outside <thead> and a <th> without scope (control)", () => {
  assert.equal(headerless('<table class="t">\n  <tr><th>a</th><th>b</th></tr>\n  <tr><td>1</td><td>2</td></tr></table>').length, 1);
  assert.equal(headerless("<table><thead><tr><th>a</th></tr></thead><tr><td>1</td></tr></table>", { scoped: true }).length, 1);
  assert.deepEqual(headerless("<table><thead><tr><th>a</th></tr></thead><tr><td>1</td></tr></table>"), [], "a <thead> alone passes site-wide");
  assert.deepEqual(headerless('<table><thead><tr><th scope="col">a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'), []);
  assert.deepEqual(headerless('<table id="x"></table>'), [], "an empty table a script fills is checked in its script");
});

test("no static page ships a data table without a declared header row", () => {
  const pages = staticShellPages();
  assert.ok(pages.length >= 40, `only ${pages.length} static pages found`);
  const found = pages.flatMap((file) => headerless(readFileSync(file, "utf8")).map((t) => `${file}: ${t}`));
  assert.deepEqual(found, []);
});

test('the audited tables say scope="col" outright', () => {
  const audited = ["octane", "pqc", "typed-config", "hidden-flags", "teardown", "useragent"].map((p) => `src/pages/garage/${p}.html`);
  for (const file of audited) {
    const html = readFileSync(file, "utf8");
    assert.ok(/<thead>/.test(strip(html)), `${file}: no static <thead>; did its tables move?`);
    assert.deepEqual(headerless(html, { scoped: true }), [], file);
  }
});

test("the /ledger invoice declares its header row", () => {
  const html = String(renderLedgerLines({ ok: true, rows: [] }, { ok: false, reason: "unconfigured" }));
  assert.match(html, /<table class="lg">/, "the ledger table moved; point this test at it");
  assert.deepEqual(headerless(html, { scoped: true }), []);
});
