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

test("all generated authored documents remain zero JavaScript", async () => {
  const manifest = JSON.parse(await text("build-manifest.json"));
  for (const route of manifest.pages) {
    const file = route === "/" ? "index.html" : `${route.slice(1)}.html`;
    const html = await text(file);
    assert.doesNotMatch(html, /<script\b/i, `${route} includes script`);
    assert.match(html, /<main class="document" id="content">/, `${route} has no main document`);
  }
});

test("writing publishes one editable HTML view and one canonical text view", async () => {
  const posts = JSON.parse(await text("writing/posts.json"));
  assert.equal(posts.length, 4);
  for (const post of posts) {
    const html = await text(`writing/${post.slug}.html`);
    const plain = await text(`writing/${post.slug}.txt`);
    assert.match(html, /<textarea class="notepad"/);
    assert.ok(plain.trim().length > 0);
    assert.match(html, new RegExp(`href="/writing/${post.slug}\\.txt"`));
  }
});

test("photo archive and machine manifest describe the same responsive assets", async () => {
  const html = await text("photos.html");
  const manifest = JSON.parse(await text("images/manifest.json"));
  assert.equal(manifest.count, 158);
  assert.equal(manifest.photos.length, manifest.count);
  assert.equal((html.match(/<picture>/g) ?? []).length, manifest.count);
  assert.equal((html.match(/<img\b/g) ?? []).length, manifest.count);
  assert.match(html, /<search class="photo-search">/);
  assert.match(html, /<ol class="photo-archive">/);
  for (const photo of manifest.photos) {
    await readFile(new URL(photo.thumb_avif.slice(1), output));
    await readFile(new URL(photo.thumb_jpg.slice(1), output));
    await readFile(new URL(photo.thumb_small.slice(1), output));
  }
});

test("section folders are projected from the public surface registry", async () => {
  const registry = JSON.parse(await readFile(new URL("../site-manifest.json", import.meta.url), "utf8"));
  for (const section of ["garage", "lwe"]) {
    const items = registry.surfaces.filter(({ path, kind }) => kind === "content" && path.startsWith(`/${section}/`));
    const html = await text(`${section}.html`);
    for (const item of items) assert.match(html, new RegExp(`href="${item.path}"`));
  }
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
