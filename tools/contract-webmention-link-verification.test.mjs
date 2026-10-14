// ── webmention link verification ────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  documentContent,
  linksTo,
  test,
} from "./contract-shared.ts";

test("a link that is not really a link does not verify a mention", () => {
  const target = "https://aadhar.sh/writing/in-flux";
  const source = "https://mari.example/post";

  const notLinks = {
    "an HTML comment": `<p>hi</p><!-- <a href="${target}">x</a> -->`,
    "a commented-out draft": `<!--\n<a href="${target}">old draft</a>\n-->`,
    "a script body": `<script>var s = '<a href="${target}">x</a>';</script>`,
    "a textarea value": `<textarea><a href="${target}">x</a></textarea>`,
    "a template": `<template><a href="${target}">x</a></template>`,
    "an unterminated comment": `<!-- <a href="${target}">x</a>`,
  };
  for (const [what, html] of Object.entries(notLinks)) {
    assert.equal(linksTo(html, target, source), false, `${what} must not verify a mention`);
  }

  const realLinks = {
    "protocol-relative": `<a href="//aadhar.sh/writing/in-flux">x</a>`,
    "an uppercase host": `<a href="https://AADHAR.SH/writing/in-flux">x</a>`,
    "a tracking query": `<a href="https://aadhar.sh/writing/in-flux?utm_source=rss">x</a>`,
    "a fragment": `<a href="https://aadhar.sh/writing/in-flux#notes">x</a>`,
    "a trailing slash": `<a href="https://aadhar.sh/writing/in-flux/">x</a>`,
    "single quotes": `<a href='https://aadhar.sh/writing/in-flux'>x</a>`,
    "a link after a comment": `<!-- old --><a href="${target}">x</a>`,
  };
  for (const [what, html] of Object.entries(realLinks)) {
    assert.equal(linksTo(html, target, source), true, `${what} is a real link and must verify`);
  }

  assert.equal(linksTo(`<p>I read https://aadhar.sh/writing/in-flux today</p>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh/writing/other">x</a>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh.evil.example/writing/in-flux">x</a>`, target, source),
    false, "a lookalike host must not verify");
});

test("inert regions are removed without eating the document", () => {
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("before"), true);
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("after"), true);
  assert.equal(documentContent("<script>secret</script>").includes("secret"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("hidden"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("visible"), true);
});
