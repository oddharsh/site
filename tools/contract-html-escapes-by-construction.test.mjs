// ── HTML is a type, and the type is the escaping ─────────────────────────────
// lib/html.ts exists because `escHtml` is a correct function applied by
// DISCIPLINE across 80+ call sites, where forgetting one is an injection rather
// than a broken build. These assertions pin the properties the rest of the
// Worker is allowed to rely on.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { Html, escape, html, joinHtml, unsafeHtml } from "../src/worker/lib/html.ts";
import { esc } from "../src/worker/lib/http.ts";

test("interpolated text is escaped, and Html composes without double-escaping", () => {
  assert.equal(html`<b>${"<script>x</script>"}</b>`.html, "<b>&lt;script&gt;x&lt;/script&gt;</b>");
  assert.equal(html`<p>${html`<b>${"a<b"}</b>`}</p>`.html, "<p><b>a&lt;b</b></p>");
  assert.equal(html`<ul>${["a<", "b"].map((x) => html`<li>${x}</li>`)}</ul>`.html,
    "<ul><li>a&lt;</li><li>b</li></ul>");
  assert.equal(joinHtml([html`<a>`, html`<b>`], "·").html, "<a>·<b>");
});

test("one escape covers both contexts, which is why there is only one", () => {
  assert.equal(escape(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(html`<a title="${'he said "hi"'}">`.html, `<a title="he said &quot;hi&quot;">`);
});

test("absent values render as nothing, never as the word", () => {
  assert.equal(html`[${null}${undefined}]`.html, "[]");
  assert.equal(html`${0}${false}`.html, "0false");
});

test("the string escaper preserves coercion and escapes even Html values", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(false), "false");
  assert.equal(esc(unsafeHtml("<b>&</b>")), "&lt;b&gt;&amp;&lt;/b&gt;");
  let reads = 0;
  const value = { toString() { reads++; return `&<>"' ☕`; } };
  assert.equal(esc(value), "&amp;&lt;&gt;&quot;&#39; ☕");
  assert.equal(reads, 1, "coercion happens once before escaping");
});

test("the marker survives to runtime, which is why Html is not a branded string", () => {
  assert.ok(html`x` instanceof Html);
  assert.ok(unsafeHtml("<i>raw</i>") instanceof Html);
  assert.equal(String(html`<p>${"&"}</p>`), "<p>&amp;</p>");
});

test("unsafeHtml is the only unescaped door, and it is greppable", async () => {
  const source = await readFile(new URL("src/worker/lib/html.ts", ROOT), "utf8");
  const doors = [...new Set([...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]))];
  assert.deepEqual(doors.sort(), ["escape", "html", "joinHtml", "unsafeHtml"]);
  assert.equal(typeof escape("x"), "string");
  assert.equal(typeof html`x`, "object");
});

test("the unescaped door is counted, and the count may only go down", async () => {
  const declared = JSON.parse(
    await readFile(new URL("config/unsafe-html-baseline.json", ROOT), "utf8"),
  );
  const { readdir } = await import("node:fs/promises");
  const ROOTS = ["src/worker", "cal/src", "serendipity"];
  const files = [];
  for (const dir of ROOTS) {
    for (const rel of await readdir(new URL(dir, ROOT), { recursive: true })) {
      const file = `${dir}/${rel}`;
      if (/\.(ts|js)$/.test(rel) && !rel.split("/").includes("node_modules") && file !== "src/worker/lib/html.ts") files.push(file);
    }
  }
  for (const dir of ROOTS) {
    assert.ok(files.some((f) => f.startsWith(`${dir}/`)), `the unsafeHtml scan found no sources under ${dir}`);
  }

  const actual = {};
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), "utf8");
    const n = source.match(/\bunsafeHtml\b/g)?.length ?? 0;
    if (n) actual[file] = n;
  }

  const problems = [];
  for (const [file, n] of Object.entries(actual)) {
    const was = declared.files[file];
    if (was === undefined) problems.push(`${file}: ${n} use(s), and this file is not in the baseline`);
    else if (n > was) problems.push(`${file}: ${n} use(s), up from ${was} — migrate to \`html\` instead`);
    else if (n < was) problems.push(`${file}: ${n} use(s), DOWN from ${was} — lower it in the baseline`);
  }
  for (const file of Object.keys(declared.files)) {
    if (!(file in actual)) problems.push(`${file}: now clean — drop it from the baseline`);
  }
  assert.deepEqual(problems, [], "config/unsafe-html-baseline.json disagrees with the tree");

  const total = Object.values(actual).reduce((a, b) => a + b, 0);
  assert.equal(declared.total, total, "the declared total disagrees with the entries");
  assert.ok(total > 0, "the unsafeHtml scan matched nothing; the scanner is broken");
});
