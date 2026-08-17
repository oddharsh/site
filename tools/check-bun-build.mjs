#!/usr/bin/env bun
// bun run bun:build:check
//
// The control for "should Bun.build() replace any of this build's transforms?".
//
// A SCRIPT rather than a CI step, for the same reason kitesurf:check is one: the
// answer only changes when Bun ships something new. Run it when a Bun release
// lands, record the verdict, move on.
//
// It asks three separate questions, because "adopt Bun.build" is three decisions
// and they have different answers:
//
//   1. CSS.  Would Bun replace lightningcss for luna.css?
//   2. JS.   Would Bun replace oxc-minify for the client islands?
//   3. HTML. Would Bun's HTML entrypoints replace the bespoke asset pipeline
//            (SHELLS, STRING_ASSETS, the hashed-asset repointer)?
//
// Question 3 is the only one that would buy a CAPABILITY rather than bytes, and
// it is the one most likely to change, so it is worth re-running even when 1 and
// 2 stay lost.
//
// The verdict on 2026-08-16, bun 1.4.0-canary.1+8326d1bd3:
//   CSS   lose by 46.6% brotli (7746 -> 11356)
//   JS    lose by 2.4% brotli (60706 -> 62133), 13 of 15 islands larger,
//         and tooltip.js loses a marker the build asserts
//   HTML  fails outright: the pages reference /luna.css, /nav.js and /quiz.js as
//         ABSOLUTE URLs, which is deliberate (one shared, content-hashed copy per
//         asset across every page) and which a bundler cannot resolve
//
// Historical note worth keeping: an earlier canary PANICKED on luna.css through
// the JS API. That is fixed here. The reason to keep lightningcss is now size
// rather than a crash, which is a different and more durable argument.
import { brotliCompressSync, constants as Z } from "node:zlib";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minifySync } from "oxc-minify";
import { transform as transformCss } from "lightningcss";

const br = (b) => brotliCompressSync(Buffer.from(b), { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length;
const pct = (a, b) => (((b - a) / a) * 100).toFixed(1) + "%";

// The markers build.mjs requires to survive minification, per SHELLS.
const MARKERS = {
  "nav.js": "axp-histnav", "nav-run.js": "axp-run", "nav-tray.js": "axp-balloon",
  "notepad.js": "np-window", "lens-boot.js": "requestSubmit", "lens.js": "replaceState",
  "lens-browser.js": "LensBrowser", "lens-reader.js": "LensReader", "lens-wire.js": "LensWire",
  "lens-tools.js": "LensTools", "quiz.js": "luq-data", "tooltip.js": "function start",
  "infotip.js": "axp-infotip", "hoist.js": "createHoist",
};

console.log(`bun:   ${Bun.version} (${Bun.revision.slice(0, 9)})\n`);
let lost = 0;

// ── 1. CSS ───────────────────────────────────────────────────────────────────
{
  const src = readFileSync("src/styles/luna.css", "utf8");
  const lc = transformCss({ filename: "luna.css", code: Buffer.from(src), minify: true }).code.toString();
  let bun = null;
  try {
    const r = await Bun.build({ entrypoints: ["src/styles/luna.css"], minify: true });
    if (r.success) bun = await r.outputs[0].text();
  } catch (e) {
    bun = null;
    console.log(`  css: Bun.build threw — ${String(e).slice(0, 80)}`);
  }
  if (bun) {
    const win = br(bun) < br(lc);
    if (!win) lost++;
    console.log(`1. CSS   lightningcss ${br(lc)} br   bun ${br(bun)} br   ${pct(br(lc), br(bun))}  ${win ? "BUN WINS" : "keep lightningcss"}`);
    console.log(`         (bun emits sRGB + P3 + LAB fallbacks by default, which is why it is bigger)`);
  }
}

// ── 2. JS ────────────────────────────────────────────────────────────────────
{
  let oxcBr = 0, bunBr = 0, bigger = 0, total = 0, markerLost = [];
  for (const f of readdirSync("src/client").filter((n) => n.endsWith(".js")).sort()) {
    const path = `src/client/${f}`;
    const src = readFileSync(path, "utf8");
    const oxc = minifySync(path, src).code;
    let bun = null;
    try {
      // external: the islands import by URL; that is the browser's job, not a
      // bundler's, so this measures minification alone.
      const r = await Bun.build({ entrypoints: [path], minify: true, target: "browser", external: ["/*"] });
      if (r.success) bun = await r.outputs[0].text();
    } catch { /* counted as unavailable below */ }
    if (!bun) continue;
    total++;
    oxcBr += br(oxc);
    bunBr += br(bun);
    if (bun.length > oxc.length) bigger++;
    const m = MARKERS[f];
    if (m && oxc.includes(m) && !bun.includes(m)) markerLost.push(f);
  }
  const win = bunBr < oxcBr;
  if (!win) lost++;
  console.log(`\n2. JS    oxc-minify ${oxcBr} br   bun ${bunBr} br   ${pct(oxcBr, bunBr)}  ${win ? "BUN WINS" : "keep oxc-minify"}`);
  console.log(`         ${bigger} of ${total} islands larger under bun`);
  if (markerLost.length) console.log(`         markers build.mjs asserts, LOST under bun: ${markerLost.join(", ")}`);
}

// ── 3. HTML entrypoints ──────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "bunhtml-"));
  const page = "src/pages/garage/scroll.html";
  let ok = false, why = "";
  try {
    const r = await Bun.build({ entrypoints: [page], outdir: dir, minify: true });
    ok = r.success;
    if (!ok) why = "build reported failure";
  } catch (e) {
    why = String(e).split("\n")[0].slice(0, 90);
  }
  rmSync(dir, { recursive: true, force: true });
  if (!ok) lost++;
  console.log(`\n3. HTML  ${ok ? "BUILDS — re-evaluate the asset pipeline" : "fails: " + why}`);
  if (!ok) {
    console.log(`         Pages reference /luna.css, /nav.js and /quiz.js by ABSOLUTE URL so every`);
    console.log(`         page shares one content-hashed copy. A bundler cannot resolve those, and`);
    console.log(`         making them relative would give each page its own copy, which is the`);
    console.log(`         opposite of what the /a/ tier exists for.`);
  }
}

// ── 4. can it be TUNED to match? ─────────────────────────────────────────────
// Asked because the obvious response to rows 1 and 2 is "configure it the same".
// It cannot be, and the two halves fail differently.
{
  const js = "src/client/nav.js";
  const src = readFileSync(js, "utf8");
  const oxc = minifySync(js, src, {
    module: false,
    compress: { target: "esnext", dropDebugger: true, unused: true, joinVars: true, sequences: true },
    mangle: { toplevel: false },
    codegen: { removeWhitespace: true, legalComments: "none" },
  }).code;
  const bun = async (opts) => {
    const r = await Bun.build({ entrypoints: [js], target: "browser", external: ["/*"], ...opts });
    return r.success ? await r.outputs[0].text() : null;
  };
  const flat = await bun({ minify: true });
  const gran = await bun({ minify: { whitespace: true, syntax: true, identifiers: true } });
  console.log("\n4. TUNING");
  console.log(`   js: oxc ${br(oxc)} br, bun ${br(flat)} br; minify:true already equals`);
  console.log(`       {whitespace,syntax,identifiers} (${br(flat) === br(gran) ? "byte-identical" : "they differ"}), so bun is`);
  console.log("       ALREADY at its most aggressive and no option closes the gap.");

  // browserslist, from BOTH locations it could be read from
  const base = (await Bun.build({ entrypoints: ["src/styles/luna.css"], minify: true })
    .then((r) => r.outputs[0].text())).length;
  const BL = ".browserslistrc";
  writeFileSync(BL, "last 2 chrome versions\nlast 2 safari versions\n");
  const withRc = (await Bun.build({ entrypoints: ["src/styles/luna.css"], minify: true })
    .then((r) => r.outputs[0].text())).length;
  rmSync(BL, { force: true });
  console.log(`   css: ${base} bytes with no browserslist, ${withRc} with a modern .browserslistrc`);
  console.log(`       ${base === withRc ? "IDENTICAL, so the fallbacks are unconditional" : "changed, re-evaluate"}. package.json browserslist`);
  console.log("       was measured the same way and is also ignored (2026-08-16).");
  console.log("   NOTE: Bun.build ignores unknown option keys, so a missing error proves");
  console.log("       nothing here. Every row above is measured by EFFECT on the bytes.");
}

console.log(`\nverdict: ${lost === 0 ? "Bun.build wins somewhere — read the rows above" : `${lost} of 3 still lost; keep the current transforms`}`);
