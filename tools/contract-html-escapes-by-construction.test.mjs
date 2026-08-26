// ── HTML is a type, and the type is the escaping ─────────────────────────────
// lib/html.ts exists because `escHtml` is a correct function applied by
// DISCIPLINE across 80+ call sites, where forgetting one is an injection rather
// than a broken build. These assertions pin the properties the rest of the
// Worker is allowed to rely on.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { Html, escape, html, joinHtml, unsafeHtml } from "../src/worker/lib/html.ts";

test("interpolated text is escaped, and Html composes without double-escaping", () => {
  assert.equal(html`<b>${"<script>x</script>"}</b>`.html, "<b>&lt;script&gt;x&lt;/script&gt;</b>");
  // The composition property. Escaping a fragment again would render markup as
  // text, so a builder that returns Html has to survive being nested.
  assert.equal(html`<p>${html`<b>${"a<b"}</b>`}</p>`.html, "<p><b>a&lt;b</b></p>");
  // Arrays flatten, so a list of fragments needs no join() — which would
  // stringify each one and lose the marker.
  assert.equal(html`<ul>${["a<", "b"].map((x) => html`<li>${x}</li>`)}</ul>`.html,
    "<ul><li>a&lt;</li><li>b</li></ul>");
  assert.equal(joinHtml([html`<a>`, html`<b>`], "·").html, "<a>·<b>");
});

test("one escape covers both contexts, which is why there is only one", () => {
  // escHtml escaped `& < >` and escAttr also escaped `"`, so choosing the wrong
  // one was its own bug class. This is a superset of both.
  assert.equal(escape(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(html`<a title="${'he said "hi"'}">`.html, `<a title="he said &quot;hi&quot;">`);
});

test("absent values render as nothing, never as the word", () => {
  // A missing optional field is the common case in these templates; printing
  // "undefined" into a page is never what the caller meant.
  assert.equal(html`[${null}${undefined}]`.html, "[]");
  assert.equal(html`${0}${false}`.html, "0false");
});

test("the marker survives to runtime, which is why Html is not a branded string", () => {
  // A branded `string & {…}` is erased, so `html` could not tell a trusted
  // fragment from a caller's text and would escape both. instanceof is the
  // whole mechanism.
  assert.ok(html`x` instanceof Html);
  assert.ok(unsafeHtml("<i>raw</i>") instanceof Html);
  assert.equal(String(html`<p>${"&"}</p>`), "<p>&amp;</p>");
});

test("unsafeHtml is the only unescaped door, and it is greppable", async () => {
  // The escape hatch has to exist (literals this repo wrote are already safe),
  // so what keeps it honest is that every use is countable. If this name ever
  // gains an alias, the ratchet stops meaning anything.
  const source = await readFile(new URL("src/worker/lib/html.ts", ROOT), "utf8");
  const doors = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(doors.sort(), ["escape", "html", "joinHtml", "unsafeHtml"]);
  // `escape` is exported for the migration's benefit and must not be a way to
  // mint Html; only `html` and `unsafeHtml` may return it. The checker makes
  // this point more strongly than the assertion does — writing
  // `escape("x") instanceof Html` is a TS2358, because a `string` can never be
  // an instance of anything — so the runtime check is just the readable half.
  assert.equal(typeof escape("x"), "string");
  assert.equal(typeof html`x`, "object");
});
