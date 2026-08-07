import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";
import test from "node:test";

const output = new URL("../dist/", import.meta.url);

async function text(path) {
  return readFile(new URL(path, output), "utf8");
}

function brotliBytes(value) {
  return brotliCompressSync(value, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;
}

test("homepage is a complete, zero-JavaScript document", async () => {
  const html = await text("index.html");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<main class="document" id="content">/);
  assert.match(html, /<aside class="task-pane" aria-label="Context">/);
  assert.match(html, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.equal((html.match(/<img\b/g) ?? []).length, 6);
  assert.equal((html.match(/width="600" height="600"/g) ?? []).length, 6);
  assert.equal((html.match(/loading="lazy" decoding="async" fetchpriority="low"/g) ?? []).length, 6);
});

test("initial document and shared stylesheet stay inside budgets", async () => {
  const html = await text("index.html");
  const [cssFile] = (await readdir(new URL("assets/", output))).filter((name) => name.endsWith(".css"));
  const css = await text(`assets/${cssFile}`);
  assert.ok(brotliBytes(html) <= 24 * 1024, `HTML is ${brotliBytes(html)} compressed bytes`);
  assert.ok(brotliBytes(css) <= 8 * 1024, `CSS is ${brotliBytes(css)} compressed bytes`);
});

test("hashed stylesheet and public assets resolve from the generated tree", async () => {
  const html = await text("index.html");
  const stylesheet = html.match(/<link rel="stylesheet" href="\/assets\/([^"]+)">/)?.[1];
  assert.ok(stylesheet, "homepage names a stylesheet");
  await readFile(new URL(`assets/${stylesheet}`, output));
  await readFile(new URL("favicon.svg", output));

  for (const path of html.matchAll(/(?:src|srcset)="\/([^"]+)"/g)) {
    await readFile(new URL(path[1], output));
  }
});
