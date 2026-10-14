// inject-og-meta.mjs — wire each garage + lwe page, and each registered page
// directory, to its OG card image.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { OG_PAGE_DIRS } from "./og-pages.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PUBLIC = path.join(ROOT, "public");
const PAGES = path.join(ROOT, "src/pages");
const SITE = "https://aadhar.sh";
const CHECK = process.argv.includes("--check");
const EXCLUDE = new Set(["garage-vt-b", "garage-vt-check"]);

function block(id, alt) {
  const img = `${SITE}/og/${id}.jpg`;
  return [
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${alt}">`,
    `<meta name="twitter:image" content="${img}">`,
  ].join("\n");
}

function altFor(html, id) {
  const m = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  const t = m ? m[1] : id.replace("-", "/");
  return (t + ", live demo screenshotted").replace(/"/g, "&quot;");
}

let missing = 0, wrote = 0, skipped = 0;

async function wire(file, id, alt?) {
  let html = await readFile(file, "utf8");

  if (!existsSync(path.join(PUBLIC, "og", `${id}.jpg`))) {
    console.log(`  ! ${id}: no card JPEG yet — run og-cards first`);
    missing++;
    return;
  }
  if (/name="twitter:card"/.test(html)) { skipped++; return; }

  const anchor = html.match(/<meta\s+property="og:url"[^>]*>/i);
  if (!anchor) { console.log(`  ✗ ${id}: no og:url anchor to insert after`); missing++; return; }
  if (CHECK) { console.log(`  · ${id}: would add card meta`); missing++; return; }

  const ins = anchor[0] + "\n" + block(id, alt || altFor(html, id));
  html = html.replace(anchor[0], ins);
  await writeFile(file, html);
  console.log(`  ✓ ${id}`);
  wrote++;
}

for (const section of ["garage", "lwe"]) {
  const dir = path.join(PAGES, section);
  for (const f of (await readdir(dir)).sort()) {
    if (!f.endsWith(".html") || f === "index.html") continue;
    const id = `${section}-${f.slice(0, -5)}`;
    if (EXCLUDE.has(id)) continue;
    await wire(path.join(dir, f), id);
  }
}

for (const p of OG_PAGE_DIRS) {
  await wire(path.join(PAGES, p.dir, "index.html"), p.id, p.alt);
}
console.log(`\n${wrote} pages wired, ${skipped} already had tags, ${missing} pending.`);
if (CHECK && missing) process.exit(1);
