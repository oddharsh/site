#!/usr/bin/env node
// perf-budget.mjs — deterministic build/deploy invariants + advisory wire-size
// reporting for aadhar.sh.

import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { transform as transformCss } from "lightningcss";
import { HTML_MARKERS } from "./lib/html-markers.ts";
import { dictionaryTag, zstdDictionaryFrame } from "./lib/dcz.ts";
import { DCZ_HEADER_BYTES, pageDeltaName, pageSlug, parseFamilyDictionary } from "../src/worker/lib/dictionary-names.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { siteWranglerArgs } from "./lib/site-config.ts";
import { budgetedAssets, readableTwins, unbudgetedAssets } from "./lib/client-assets.ts";

const ASSET_ENVELOPES = budgetedAssets();
const UNBUDGETED = unbudgetedAssets();

// This is an observability alert, not a platform limit. It is intentionally
// separate from the user-facing LCP budget: Worker code is server-side and can
// grow without changing a browser's transfer path, provided TTFB/CPU stay well.
//
// Baseline history, because a re-baseline that records only its new number is
// indistinguishable from someone silencing the check:
//
//   86 KiB     homepage Worker alone (pre-consolidation)
//   129.23 KiB the one-Worker consolidation (2026-06). The old homepage/Cal/
//              Serendipity aggregate measured 130.94 KiB, so keeping the 86 KiB
//              baseline would have reported a regression on every CI run for a
//              change that made the total smaller.
//   204.24 KiB HERE (2026-08-04), and the growth is /lens plus /serendipity.
//              lens.js is 141 KiB of the bundle and serendipity.js 110 KiB, 35%
//              between them; both landed after the consolidation baseline was
//              set. Nothing was imported to cause this: all of node_modules is
//              39 KiB of the bundle (the three @noble packages), and 94.4% of it
//              is first-party code.
//
//   258.34 KiB OBSERVED on 2026-08-08 at 295ee97, four days after the line
//              above was written, and already over the 255.30 KiB alert. NOT
//              re-baselined, deliberately. Re-baselining is what turns this
//              comment into a changelog of somebody silencing a check, and the
//              growth has not been attributed to anything yet.
//
//   227.67 KiB OBSERVED on 2026-08-16, DOWN from 274.46 on the same code,
//              because `minify: true` reached wrangler.jsonc. The advisory had
//              been firing continuously and now does not. Nothing was fixed:
//              the source is byte-for-byte what it was, esbuild just prints a
//              smaller number for it, and the constant was left alone because
//              there is nothing here to re-baseline.
//
//              This is the failure the paragraphs above guard against, arriving
//              through a door they do not cover. They watch for someone EDITING
//              the constant to turn the check green. A transform that changes
//              what the measurement MEANS turns it green while every constant
//              in this file holds still, so the diff shows two lines of config
//              and no baseline change at all. That is harder to catch by
//              review, not easier.
//
//              What answers it is the source-bytes advisory below, which reads
//              esbuild's per-input source sizes and therefore cannot be moved by
//              a minifier, a compressor, or the next transform nobody has
//              thought of. The gzip number keeps its job of describing the
//              artifact that ships; it is no longer the only thing standing
//              between this repo and unattributed code growth.
//
// The 129.23 baseline had therefore been BREACHED continuously rather than
// occasionally, and because this check warns rather than fails, CI printed
// "hard checks green" over it every run. A permanently-firing advisory carries
// no information, which is the actual reason to re-baseline: the point is to
// catch the NEXT unexplained 50 KiB, and it could not.
//
// Four days from a fresh baseline to a firing advisory is the argument for the
// merge-base diff in one line. The constant is not wrong because somebody chose
// it badly; it is wrong because a constant describes a moment and the bundle
// does not hold still. What the diff gives that no re-baseline can is the
// attribution: 258.34 against 255.30 says nothing about which PR spent the 54
// KiB, and a per-PR module delta says exactly which one did, while the person
// who wrote it is still reading the thread.
//
// Re-baselining is safe here because the startup cost was measured directly on
// 2026-08-04 rather than assumed. The 723 KB bundle compiles in 6.25 ms cold,
// linear at ~8.5 us/KB, against Cloudflare's 400 ms startup-CPU limit; a V8 code
// cache removes 92% of even that. So bundle bytes are a bookkeeping signal for
// review, and the thing that would make them a latency problem is two orders of
// magnitude away. Do NOT read a breach here as a cold-start regression without
// re-measuring; `wrangler check startup` ranks frames but cannot cost them.
//
// Keep this number in DRY-RUN terms. `wrangler check startup` reports a smaller
// total for the same commit (200.44 vs 204.24 KiB gzip on 2026-07-31), and the
// value parsed below comes from `wrangler deploy --dry-run`, so the two are not
// interchangeable.
const WORKER_BASELINE_GZIP_KIB = 204.24;
const WORKER_ALERT_GROWTH = 0.25;

const WORKER_BASELINE_SOURCE_KIB = 1376.65;

const WORKER_STARTUP_ALERT_MS = 50;
const TWINS = readableTwins();
const HTML_TWIN = "index.src.html";
const HTML_ENVELOPE = {
  role: "homepage document",
  gzipKiB: 22,
  brotliKiB: 20,
};

const fails = [];
const warnings = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails.push(m); };
const warn = (m) => { console.log(`  warn  ${m}`); warnings.push(m); };
const kib = (bytes) => bytes / 1024;
const compressedSizes = (bytes) => ({
  gzip: kib(gzipSync(bytes, { level: 9 }).length),
  brotli: kib(brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length),
});
const fmt = (value) => `${value.toFixed(1)} KiB`;

console.log("perf-budget: aadhar.sh pre-deploy gate\n");

try {
  const css = await readFile("src/styles/luna.css", "utf8");
  const { warnings } = transformCss({ filename: "src/styles/luna.css", code: Buffer.from(css), minify: false });
  if (warnings.length) bad(`luna.css: ${warnings.length} CSS parse warning(s): ${warnings.map((w) => w.message).join("; ")}`);
  else ok("luna.css parses clean (0 warnings)");
} catch (e) {
  bad(`luna.css: could not read/parse (${e.message})`);
}

let dryOut = "";
let dryRunFailed = false;
try {
  // One dry-run writes index.js for the route harness's prebuiltWorkerDir and
  // the upload-format worker.bundle for `check startup`. They are different
  // formats; the profiler cannot consume the plain JavaScript entrypoint.
  dryOut = execFileSync(...wranglerCommand(await siteWranglerArgs(["deploy", "--dry-run", "--outdir", ".build/.perfbudget", "--outfile", ".build/.perfbudget/worker.bundle", "--metafile"])), { encoding: "utf8" });
} catch (e) {
  dryOut = (e.stdout || "") + "\n" + (e.stderr || "");
  dryRunFailed = true;
}

if (dryRunFailed) {
  bad(`wrangler dry-run failed, so NO budget below was measured. Its output ended:\n        ${dryOut.trim().split("\n").slice(-6).join("\n        ")}`);
}
const gz = dryOut.match(/gzip:\s*([\d.]+)\s*KiB/);
let overBudget = false;
if (gz) {
  const kib = parseFloat(gz[1]);
  const alertAt = WORKER_BASELINE_GZIP_KIB * (1 + WORKER_ALERT_GROWTH);
  overBudget = kib > alertAt;
  if (overBudget) warn(`worker bundle ${kib.toFixed(2)} KiB gzip > ${alertAt.toFixed(2)} KiB advisory alert (${Math.round(WORKER_ALERT_GROWTH * 100)}% over ${WORKER_BASELINE_GZIP_KIB} KiB baseline)`);
  else ok(`worker bundle ${kib.toFixed(2)} KiB gzip (advisory alert at ${alertAt.toFixed(2)} KiB)`);
} else {
  warn("could not read bundle gzip from wrangler dry-run (offline/unauth?); skipping bundle-size check");
}

try {
  const startOut = execFileSync(...wranglerCommand(await siteWranglerArgs([
    "check", "startup",
    "--workerBundle", ".build/.perfbudget/worker.bundle",
    "--outfile", ".build/.perfbudget/worker-startup.cpuprofile",
  ])), { encoding: "utf8" });
  const active = startOut.match(/Active:\s*([\d.]+)\s*ms/);
  if (active) {
    const ms = parseFloat(active[1]);
    ms > WORKER_STARTUP_ALERT_MS
      ? warn(`worker startup ${ms.toFixed(1)} ms active CPU > ${WORKER_STARTUP_ALERT_MS} ms advisory alert — open .build/.perfbudget/worker-startup.cpuprofile in Chrome DevTools for the flamegraph`)
      : ok(`worker startup ${ms.toFixed(1)} ms active CPU (advisory alert at ${WORKER_STARTUP_ALERT_MS} ms, platform limit 400 ms)`);
  } else {
    warn("could not read active CPU from `wrangler check startup`; skipping the startup check");
  }
} catch (e) {
  warn(`\`wrangler check startup\` did not run (${(e.message || "").split("\n")[0]}); skipping the startup check`);
}

try {
  const meta = JSON.parse(await readFile(".build/.perfbudget/bundle-meta.json", "utf8"));
  const entry = (Object.entries(meta.outputs) as [string, { inputs?: Record<string, { bytesInOutput?: number }> }][])
    .find(([name]) => name.endsWith(".js") && !name.endsWith(".map"));
  const inputs = Object.entries(entry?.[1]?.inputs ?? {})
    .map(([name, v]): [string, number] => [name, v.bytesInOutput ?? 0])
    .sort((a, b) => b[1] - a[1]);
  if (!inputs.length) warn("metafile carried no input attribution; skipping bundle breakdown");
  else if (overBudget) {
    console.log(`        ${inputs.length} modules in the bundle; largest:`);
    for (const [name, bytes] of inputs.slice(0, 5)) console.log(`          ${fmt(kib(bytes)).padStart(9)}  ${name}`);
  } else ok(`bundle attribution available (${inputs.length} modules, largest ${inputs[0][0]} at ${fmt(kib(inputs[0][1]))})`);

  const sourceKib = kib((Object.values(meta.inputs ?? {}) as { bytes?: number }[])
    .reduce((sum, input) => sum + (input.bytes ?? 0), 0));
  const sourceAlertAt = WORKER_BASELINE_SOURCE_KIB * (1 + WORKER_ALERT_GROWTH);
  const modules = Object.keys(meta.inputs ?? {}).length;
  if (modules < 40) {
    warn(`metafile listed only ${modules} source inputs, so the source-bytes total cannot be trusted (expected the whole Worker graph)`);
  } else if (sourceKib > sourceAlertAt) {
    warn(`worker source ${sourceKib.toFixed(2)} KiB > ${sourceAlertAt.toFixed(2)} KiB advisory alert (${Math.round(WORKER_ALERT_GROWTH * 100)}% over ${WORKER_BASELINE_SOURCE_KIB} KiB baseline, ${modules} modules). This one is minify-invariant, so it is real growth.`);
  } else {
    ok(`worker source ${sourceKib.toFixed(2)} KiB across ${modules} modules (advisory alert at ${sourceAlertAt.toFixed(2)} KiB; minify-invariant)`);
  }
} catch (e) {
  warn(`could not read bundle metafile (${e.message}); skipping bundle breakdown`);
}

for (const { file, envelope } of ASSET_ENVELOPES) {
  const path = `.build/public/${file}`;
  let bytes;
  try { bytes = await readFile(path); } catch { bad(`${file}: missing from build output (run build first)`); continue; }
  const text = bytes.toString("utf8");
  const banner = text.startsWith("/*!") && text.includes("minified at deploy");
  if (!banner) { bad(`${file}: missing "minified at deploy" banner (build bypassed / not minified?)`); continue; }
  const sizes = compressedSizes(bytes);
  const overGzip = sizes.gzip > envelope.gzipKiB;
  const overBrotli = sizes.brotli > envelope.brotliKiB;
  const line = `${file}: ${bytes.length} B raw, ${fmt(sizes.gzip)} gzip, ${fmt(sizes.brotli)} Brotli (${envelope.role})`;
  if (overGzip || overBrotli) warn(`${line}; advisory envelope ${envelope.gzipKiB}/${envelope.brotliKiB} KiB gzip/Brotli`);
  else ok(`${line}; envelope ${envelope.gzipKiB}/${envelope.brotliKiB} KiB gzip/Brotli`);
}
for (const file of UNBUDGETED) {
  let bytes;
  try { bytes = await readFile(`.build/public/${file}`); } catch { bad(`${file}: missing from build output (run build first)`); continue; }
  const text = bytes.toString("utf8");
  if (!(text.startsWith("/*!") && text.includes("minified at deploy"))) { bad(`${file}: missing "minified at deploy" banner (build bypassed / not minified?)`); continue; }
  const sizes = compressedSizes(bytes);
  ok(`${file}: ${bytes.length} B raw, ${fmt(sizes.gzip)} gzip, ${fmt(sizes.brotli)} Brotli (unbudgeted: no envelope declared)`);
}

for (const t of TWINS) {
  try { await stat(`.build/public/${t}`); ok(`twin ${t} present`); }
  catch { bad(`twin ${t} missing from build output`); }
}

try {
  const name = (await readdir(".build/public/a"))
    .find((f) => parseFamilyDictionary(f));
  if (!name) bad("page-family.dict: content-hashed build asset missing");
  else {
    const [dict, br] = await Promise.all([
      readFile(`.build/public/a/${name}`),
      readFile(`.build/public/a/${name}.br`),
    ]);
    if (dict.length !== 65_536 || dict.readUInt32LE(0) === 0xec30a437) {
      bad("page-family.dict: expected an exact 64KB raw-content dictionary, not a trained zstd dictionary");
    } else if (br.length >= dict.length) {
      bad("page-family.dict: q11 twin is not smaller than the dictionary");
    } else {
      ok(`page-family.dict: ${dict.length} B raw source -> ${br.length} B q11 immutable asset`);
    }
  }
} catch (e) {
  bad(`page-family.dict: missing or unreadable (${e.message})`);
}

try {
  const pages = (await readdir(".build/public", { recursive: true }))
    .filter((path) => path.endsWith(".html") && !path.endsWith(".src.html"));
  const deltas = await readdir(".build/public/pd");
  const familyName = (await readdir(".build/public/a"))
    .find((name) => parseFamilyDictionary(name));
  if (!familyName) throw new Error("page-family dictionary is missing");
  const family = await readFile(`.build/public/a/${familyName}`);
  const familyTag = dictionaryTag(family);
  const absent = pages
    .filter((path) => !deltas.includes(pageDeltaName(pageSlug(path), familyTag)));

  const missing: string[] = [];
  const notUseful: string[] = [];
  for (const path of absent) {
    const slug = pageSlug(path);
    const bytes = await readFile(`.build/public/${path}`);
    const q11 = await readFile(`.build/public/${path}.br`).then((b) => b.length, () => Infinity);
    const dcz = zstdDictionaryFrame(bytes, family).length + DCZ_HEADER_BYTES;
    if (dcz < q11) missing.push(slug);
    else notUseful.push(`${slug} (${dcz} B dcz >= ${q11} B q11)`);
  }

  if (missing.length) bad(`preferred site-page dictionary: missing useful family DCZ variants for ${missing.join(", ")}`);
  else ok(`preferred site-page dictionary: ${pages.length - absent.length} of ${pages.length} static/deterministic pages have family DCZ variants${notUseful.length ? `; no variant where it loses to q11: ${notUseful.join(", ")}` : ""}`);
} catch (e) {
  bad(`site-page dictionary: generated DCZ set unreadable (${e.message})`);
}

for (const path of [
  "lens.html",
  "writing/index.html",
  "writing/big-screens-and-small-screens.html",
  "writing/education-in-tech.html",
  "writing/in-flux.html",
  "writing/colophon.html",
  "pixel-peeper/index.html",
]) {
  try {
    const [raw, br] = await Promise.all([
      readFile(`.build/public/${path}`),
      readFile(`.build/public/${path}.br`),
    ]);
    if (br.length >= raw.length) bad(`${path}: q11 twin is not smaller than the generated page`);
    else ok(`${path}: deterministic renderer staged ${raw.length} B -> ${br.length} B q11`);
  } catch {
    bad(`${path}: deterministic render or q11 twin missing from build output`);
  }
}

let homepage;
try {
  homepage = await readFile(".build/public/index.html");
} catch {
  bad("index.html: missing from build output");
}
if (homepage) {
  const text = homepage.toString("utf8");
  const banner = text.startsWith("<!-- minified at deploy; readable source: /index.src.html -->");
  if (!banner) bad("index.html: missing deploy-time minification banner");
  for (const [label, marker] of HTML_MARKERS) {
    if (!marker.test(text)) bad("index.html: missing required marker " + label);
  }
  try {
    const source = await readFile("src/pages/index.html");
    const twin = await readFile(`.build/public/${HTML_TWIN}`);
    if (!source.equals(twin)) bad("index.src.html: readable twin differs from src/pages/index.html");
    else ok("index.src.html: readable homepage twin present");
  } catch {
    bad("index.src.html: readable homepage twin missing");
  }
  try {
    const { readdir } = await import("node:fs/promises");
    const served = (await readdir(".build/public", { recursive: true }))
      .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && rel !== "index.html")
      .sort();
    let missing = 0, unbannered = 0, unreadable = 0;
    for (const rel of served) {
      const page = (await readFile(`.build/public/${rel}`)).toString("utf8");
      const twinRel = rel.replace(/\.html$/, ".src.html");
      if (!page.startsWith(`<!-- minified at deploy; readable source: /${twinRel} -->`)) unbannered++;
      let twin;
      try { twin = (await readFile(`.build/public/${twinRel}`)).toString("utf8"); }
      catch { missing++; continue; }
      if (twin.startsWith("<!-- minified at deploy;")) unreadable++;
      else if (twin.length < page.length - 120) unreadable++;
    }
    if (missing) bad(`${missing} of ${served.length} served pages are missing their .src.html twin`);
    else if (unbannered) bad(`${unbannered} of ${served.length} served pages lack the minification banner`);
    else if (unreadable) bad(`${unreadable} of ${served.length} .src.html twins are not more readable than the page they twin`);
    else ok(`${served.length} served pages minified, each with a readable .src.html twin`);
  } catch (error) {
    bad(`page twins: could not verify (${error.message})`);
  }
  const sizes = compressedSizes(homepage);
  const overGzip = sizes.gzip > HTML_ENVELOPE.gzipKiB;
  const overBrotli = sizes.brotli > HTML_ENVELOPE.brotliKiB;
  const line = `index.html: ${homepage.length} B raw, ${fmt(sizes.gzip)} gzip, ${fmt(sizes.brotli)} Brotli (${HTML_ENVELOPE.role})`;
  if (overGzip || overBrotli) warn(`${line}; advisory envelope ${HTML_ENVELOPE.gzipKiB}/${HTML_ENVELOPE.brotliKiB} KiB gzip/Brotli`);
  else ok(`${line}; envelope ${HTML_ENVELOPE.gzipKiB}/${HTML_ENVELOPE.brotliKiB} KiB gzip/Brotli`);
}

console.log("");
if (fails.length) {
  console.error(`perf-budget: ${fails.length} breach(es) — GATE FAILED`);
  process.exit(1);
}
console.log(`perf-budget: hard checks green${warnings.length ? ` (${warnings.length} advisory warning${warnings.length === 1 ? "" : "s"})` : ""}`);
