#!/usr/bin/env node

// Deterministic wire-shape gates for the blank-slate site. Browser outcomes are
// measured separately; this file protects the inputs most likely to regress
// them without pretending that byte counts are Core Web Vitals.

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DIST = "dist";
const CSS_BR_MAX = 8 * 1024;
const ORDINARY_HTML_BR_MAX = 24 * 1024;
const AUTHOR_TEXT_EXCEPTIONS = new Set(["access.html", "garage/horizon.html"]);
let failures = 0;

const fail = (message) => { failures += 1; console.error(`FAIL ${message}`); };
const pass = (message) => console.log(`PASS ${message}`);
const br = (value) => brotliCompressSync(value, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}).byteLength;

const files = await readdir(DIST, { recursive: true });
const htmlFiles = files.filter((file) => file.endsWith(".html")).sort();
const cssFiles = files.filter((file) => /^assets\/site\.[a-f0-9]{10}\.css$/.test(file));

if (cssFiles.length !== 1) fail(`expected one content-hashed shared stylesheet, found ${cssFiles.length}`);
else {
  const css = await readFile(path.join(DIST, cssFiles[0]));
  const bytes = br(css);
  if (bytes > CSS_BR_MAX) fail(`${cssFiles[0]} is ${bytes} B Brotli (budget ${CSS_BR_MAX} B)`);
  else pass(`shared CSS ${bytes} B Brotli / ${CSS_BR_MAX} B`);
  const text = css.toString("utf8");
  if (/@font-face\b|@import\b|url\s*\(/i.test(text)) fail("shared CSS introduces an external or embedded asset dependency");
  else pass("shared CSS has no fonts, imports, or URL dependencies");
}

let maxOrdinary = { file: "", bytes: 0 };
for (const file of htmlFiles) {
  const body = await readFile(path.join(DIST, file), "utf8");
  const scripts = body.match(/<script\b/gi) ?? [];
  if (scripts.length) fail(`${file} loads ${scripts.length} client script(s)`);
  const styles = [...body.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  if (styles.length !== 1 || !styles[0][0].includes("/assets/site.")) {
    fail(`${file} must load exactly the one hashed shared stylesheet`);
  }
  const bytes = br(Buffer.from(body));
  if (!AUTHOR_TEXT_EXCEPTIONS.has(file)) {
    if (bytes > ORDINARY_HTML_BR_MAX) fail(`${file} is ${bytes} B Brotli (ordinary document budget ${ORDINARY_HTML_BR_MAX} B)`);
    if (bytes > maxOrdinary.bytes) maxOrdinary = { file, bytes };
  }
}

if (!failures) {
  pass(`${htmlFiles.length} complete HTML documents load zero client JavaScript`);
  pass(`largest budgeted HTML is ${maxOrdinary.file} at ${maxOrdinary.bytes} B Brotli / ${ORDINARY_HTML_BR_MAX} B`);
}

const homepage = await readFile(path.join(DIST, "index.html"), "utf8");
const initialBlocking = 1 + (homepage.match(/<link\b[^>]*rel=["']stylesheet["']/gi) ?? []).length
  + (homepage.match(/<script\b/gi) ?? []).length;
if (initialBlocking > 3) fail(`homepage has ${initialBlocking} document/render-blocking requests before LCP`);
else pass(`homepage needs ${initialBlocking} document/render-blocking requests before LCP`);

if (failures) {
  console.error(`\nperformance budget failed with ${failures} error(s)`);
  process.exit(1);
}
console.log("\nperformance budget passed; field and browser-lab outcomes remain separate release evidence");
