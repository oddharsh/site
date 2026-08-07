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

test("generated documents use no JavaScript except the image comparison instrument", async () => {
  const manifest = JSON.parse(await text("build-manifest.json"));
  const webmentionTargets = JSON.parse(await text("webmention-targets.json"));
  assert.deepEqual(webmentionTargets, manifest.pages);
  for (const route of manifest.pages) {
    const file = route === "/" ? "index.html" : `${route.slice(1)}.html`;
    const html = await text(file);
    if (route === "/pixel-peeper") {
      assert.match(html, /<script type="module" src="\/assets\/pixel-peeper\.[a-f0-9]{10}\.js"><\/script>/);
    } else {
      assert.doesNotMatch(html, /<script\b/i, `${route} includes script`);
    }
    assert.match(html, /<main class="document" id="content">/, `${route} has no main document`);
    assert.match(html, /<link rel="webmention" href="\/webmention">/, `${route} does not advertise its receiver`);
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
    for (const item of items) {
      assert.match(html, new RegExp(`href="${item.path}"`));
      const page = await text(`${item.path.slice(1)}.html`);
      assert.match(page, /<article class="article/);
      assert.doesNotMatch(page, /<script\b/i);
      assert.equal((page.match(/<h1\b/g) ?? []).length, 1, `${item.path} needs one h1`);
      await readFile(new URL(`${item.path.slice(1)}.md`, output));
    }
  }
});

test("system documents keep live boundaries and alternate representations explicit", async () => {
  for (const slug of ["access", "bot", "pixel-peeper", "security", "terminal", "whoareyou"]) {
    const html = await text(`${slug}.html`);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    if (slug === "pixel-peeper") assert.match(html, /data-peeper/);
    else assert.doesNotMatch(html, /<script\b/i);
    await readFile(new URL(`${slug}.md`, output));
  }
  assert.match(await text("whoareyou.html"), /id="request-details"/);
  assert.match(await text("terminal.html"), /data-terminal-font="Courier New"/);
  await readFile(new URL("pixel-peeper/manifest.json", output));
});

test("search and Run are complete native forms backed by a generated index", async () => {
  const search = await text("search.html");
  const run = await text("run.html");
  const index = JSON.parse(await text("search-index.json"));
  assert.match(search, /Search aadhar\.sh/);
  assert.match(run, /<datalist id="site-commands">/);
  assert.ok(index.length >= 59);
  assert.doesNotMatch(search + run, /<script\b/i);
  assert.match(await text("llms-full.txt"), /Public surfaces/);
});

test("status and live utility shells stay complete without client JavaScript", async () => {
  const updates = await text("updates.html");
  const restore = await text("restore.html");
  const lens = await text("lens.html");
  assert.match(updates, /Recently installed/);
  assert.match(restore, /Restore point/);
  assert.match(lens, /The Other Web/);
  assert.match(lens, /<search class="lens-search">/);
  assert.doesNotMatch(updates + restore + lens, /<script\b/i);
  assert.match(await text("updates.md"), /Recently installed/);
  assert.match(await text("restore.md"), /Restore point/);
  const coffee = await text("coffee.html");
  assert.match(coffee, /class="coffee-form"/);
  assert.match(coffee, /action="\/coffee\/book" method="post"/);
  assert.doesNotMatch(coffee, /<script\b/i);
  const serendipity = await text("serendipity.html");
  const contribute = await text("serendipity/contribute.html");
  assert.match(serendipity, /id="event-pool"/);
  assert.match(contribute, /no longer accepts pasted account cookies/i);
  assert.doesNotMatch(serendipity + contribute, /<script\b/i);

  for (const slug of ["finger", "radar", "dict", "cache", "encode", "agent-ready"]) {
    const tool = await text(`${slug}.html`);
    assert.match(tool, new RegExp(`action="/${slug}" method="get"`));
    assert.match(tool, /id="tool-output"/);
    assert.doesNotMatch(tool, /<script\b/i);
  }
  assert.match(await text("inbox.html"), /id="mention-list"/);
  assert.match(await text("lens/census.html"), /id="census"/);
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

test("agent discovery is generated from the live MCP registry", async () => {
  const contracts = JSON.parse(await readFile(new URL("../src/contracts/mcp.json", import.meta.url), "utf8"));
  const siteCard = JSON.parse(await text(".well-known/mcp/server-card.json"));
  const serendipityCard = JSON.parse(await text(".well-known/mcp/serendipity.json"));
  const agentCard = JSON.parse(await text(".well-known/agent-card.json"));
  assert.deepEqual(siteCard.tools.map(({ name }) => name), contracts.servers.site.tools.map(({ name }) => name));
  assert.deepEqual(serendipityCard.tools.map(({ name }) => name), contracts.servers.serendipity.tools.map(({ name }) => name));
  assert.equal(siteCard.protocolVersion, contracts.protocolVersion);
  assert.equal(serendipityCard.protocolVersion, contracts.protocolVersion);
  assert.doesNotMatch(JSON.stringify(agentCard), /webmcp|oauth|bearer/i);
});
