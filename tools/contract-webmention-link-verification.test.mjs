// ── webmention link verification ────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  documentContent,
  linksTo,
  test,
} from "./contract-shared.ts";

// ── webmention link verification ────────────────────────────────────
// The verify step is the ONLY thing standing between "someone sent a POST" and
// "someone's page appears on my site", so what counts as a link is the whole
// anti-forgery property. Every row below was measured against the previous
// string-matching implementation on 2026-08-07.
test("a link that is not really a link does not verify a mention", () => {
  const target = "https://aadhar.sh/writing/in-flux";
  const source = "https://mari.example/post";

  // CREDITED before. Markup the author removed, code, an inert template, and a
  // form field's value are not links, and each one let a stranger claim a
  // mention with markup that never renders.
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

  // REFUSED before, and both are ordinary HTML a real page writes.
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

  // Still refused, and must stay refused: naming a URL is not linking to it.
  assert.equal(linksTo(`<p>I read https://aadhar.sh/writing/in-flux today</p>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh/writing/other">x</a>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh.evil.example/writing/in-flux">x</a>`, target, source),
    false, "a lookalike host must not verify");
});

// Stripping too much loses a link and refuses a real mention; stripping too
// little credits a fake one. The unterminated case above pins the safe
// direction, and this pins that ordinary content survives.
test("inert regions are removed without eating the document", () => {
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("before"), true);
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("after"), true);
  assert.equal(documentContent("<script>secret</script>").includes("secret"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("hidden"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("visible"), true);
});
