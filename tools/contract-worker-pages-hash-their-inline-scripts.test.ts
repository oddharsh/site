// ── Worker-rendered pages name their inline scripts by hash ───────────────────
// Until 2026-09-25 every page the Worker rendered per request shipped
// `script-src 'self' 'unsafe-inline'`, because build step 7c's hash map only
// knows staged documents (gotcha 17's open follow-up). lunaPage now hashes the
// inline scripts in the document it just assembled (lib/inline-csp.ts) with a
// synchronous SHA-256 (lib/sha256.ts). What this pins:
//   - the hash is SHA-256, byte for byte, against node:crypto;
//   - the small scanner agrees with the build's real parser (tools/lib/csp-scan.ts)
//     on rendered pages and on markup built to trip it;
//   - it fails OPEN to the old policy on anything a hash cannot cover;
//   - lunaPage sends the policy, a caller's own policy wins, and
//     withSecurityHeaders keeps it rather than stamping the loose default.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Base64 } from "../src/worker/lib/sha256.ts";
import { inlineScriptHashes, inlineScriptPolicy } from "../src/worker/lib/inline-csp.ts";
import { CSP_LOOSE } from "../src/worker/lib/csp-policy.ts";
import { lunaPage } from "../src/worker/lib/chrome.ts";
import { html, unsafeHtml } from "../src/worker/lib/html.ts";
import { withSecurityHeaders } from "../src/worker/lib/security.ts";
import { renderSecurityCenter } from "../src/worker/security.ts";
import { renderWhoareyouPage } from "../src/worker/whoareyou.ts";

const node = (s) => createHash("sha256").update(s, "utf8").digest("base64");

test("sha256Base64 is SHA-256, byte for byte", () => {
  const cases = ["", "a", "abc", "é漢😀 & <x>", "\n\t\r", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)];
  for (let i = 1; i < 120; i++) cases.push(Array.from({ length: i * 5 }, (_, j) => String.fromCharCode(32 + ((i * j * 31) % 1500))).join(""));
  for (const c of cases) assert.equal(sha256Base64(c), node(c), `differs on a ${c.length}-char input`);
});

const ADVERSARIAL = [
  // data blocks are never executed, so never hashed
  `<script type="application/json">{"a":1}</script><script type="application/ld+json">{}</script><script>x()</script>`,
  // external scripts are 'self's job; a data-src or srcset look-alike is not src
  `<script src="/a.js"></script><script data-src="/b.js">y()</script><script defer src=/c.js></script>`,
  // types by spelling, case and quoting
  `<script type=module>m()</script><script TYPE="Text/JavaScript">t()</script><script type='speculationrules'>{"prefetch":[]}</script>`,
  // a close tag the tokenizer honours, and one it does not
  `<script>a="</scriptx>";b()</SCRIPT ><script>c()</script/>`,
  // an empty script still needs a hash
  `<script></script><script>
</script>`,
  // comparisons and handler-shaped code inside a body are not attributes
  `<script>if (i<n) el.onload = go; var u = "javascript:void 0";</script>`,
  // duplicates collapse to one source
  `<script>same()</script><p>x</p><script>same()</script>`,
];

test("the runtime scanner agrees with the build's parser", { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" }, async () => {
  const { scanDocument } = await import("./lib/csp-scan.ts");
  const docs = [
    ...ADVERSARIAL.map((d, i) => [`adversarial ${i}`, d]),
    ["/security", await renderSecurityCenter().text()],
    ["/whoareyou", await renderWhoareyouPage().text()],
    ["lunaPage with head + body + scripts", await lunaPage({
      title: "t", route: "/t",
      head: html`<script type="speculationrules">{"prerender":[]}</script>`,
      body: html`<p>${"<script>not a script</script>"}</p>`,
      scripts: unsafeHtml(`<script>document.title = "a < b";</script>`),
    }).text()],
  ];
  for (const [label, doc] of docs) {
    const mine = inlineScriptHashes(doc);
    assert.ok(mine, `${label}: fell open with nothing unhashable in it`);
    const theirs = [...new Set((await scanDocument(doc, label)).hashes)];
    assert.deepEqual([...mine].sort(), [...theirs].sort(), `${label}: the two scanners disagree`);
  }
  // Escaped text is text: the interpolated "<script>" above must not count.
  const escaped = await lunaPage({ title: "t", body: html`<p>${"<script>evil()</script>"}</p>` }).text();
  assert.ok(!(inlineScriptHashes(escaped) ?? []).includes(sha256Base64("evil()")));
});

test("it fails OPEN to the loose policy on anything a hash cannot cover", () => {
  for (const doc of [
    `<button onclick="go()">x</button><script>a()</script>`,
    `<body onload=go()><script>a()</script>`,
    `<a href="javascript:go()">x</a>`,
    `<a href='  JavaScript:go()'>x</a>`,
    `<iframe srcdoc="<script>a()</script>"></iframe>`,
  ]) {
    assert.equal(inlineScriptHashes(doc), null, `should keep the loose policy: ${doc}`);
    assert.equal(inlineScriptPolicy(doc), null);
  }
  // ...and stays strict when the only handler-shaped text is script or style body.
  assert.ok(inlineScriptHashes(`<style>a[onclick=x]{}</style><script>if(a<b)el.onclick=f</script>`));
});

test("lunaPage sends the hashed policy, and withSecurityHeaders keeps it", async () => {
  const page = lunaPage({ title: "t", route: "/ledger", scripts: unsafeHtml("<script>tick()</script>") });
  const policy = page.headers.get("content-security-policy");
  assert.ok(policy, "lunaPage must name its scripts");
  assert.doesNotMatch(policy, /'unsafe-inline'[^;]*;\s*style-src/, "script-src must not carry 'unsafe-inline'");
  assert.ok(policy.includes(`'sha256-${node("tick()")}'`));
  // Every inline script in the served bytes is named, exactly.
  const body = await page.clone().text();
  const named = inlineScriptHashes(body);
  assert.ok(named && named.length, "the rendered page carries inline scripts to name");
  for (const h of named) assert.ok(policy.includes(`'sha256-${h}'`));

  const wrapped = withSecurityHeaders(page, "/ledger");
  assert.equal(wrapped.headers.get("content-security-policy"), policy, "the security wrapper stamped over the page's own policy");

  // A caller's policy still wins: lens.ts composes one for its framed view.
  const bespoke = "default-src 'self'; frame-src https:";
  const lens = lunaPage({ title: "t", headers: { "content-security-policy": bespoke } });
  assert.equal(lens.headers.get("content-security-policy"), bespoke);

  // A page that falls open sets nothing, and the wrapper stamps the default.
  const handler = lunaPage({ title: "t", body: unsafeHtml(`<button onclick="x()">x</button>`) });
  assert.equal(handler.headers.get("content-security-policy"), null);
  assert.equal(withSecurityHeaders(handler, "/unmapped").headers.get("content-security-policy"), CSP_LOOSE);
});
