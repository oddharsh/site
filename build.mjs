// build.mjs: the site's one build step, and it runs only at deploy.
//
// Authoring stays buildless: everything in holding/ is committed readable and is
// the source of truth. This script stages a copy under .build/ and minifies
// exactly three shell scripts (the assets pages load); index.html, the
// garage/ and lwe/ HTML, images, _headers, and the worker modules ship
// byte-identical to git. Each minified shell opens with a pointer to its
// readable twin (/<name>.src.js, deployed alongside), because View Source is
// part of the product and minification must not cost it.
//
//   node build.mjs                                   # stage .build/
//   npm run deploy                                   # build + wrangler deploy -c .build/wrangler.jsonc
//
// wrangler resolves `main` and `assets.directory` relative to the config file, so the
// root wrangler.jsonc is copied verbatim into .build/ and just works against the copy.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { transform } from "esbuild";

const OUT = ".build";

// ── deploy-time invariant tripwires (explore-unknowns, phase A) ──────────────
// Silent-failure classes this codebase has hit or is one careless edit from
// hitting. They live here because build.mjs runs on every `npm run deploy`, the
// one reliable path (Workers Builds CI has silently skipped pushes). The three
// deterministic checks HARD-BLOCK the deploy; the two that compare derived or
// duplicated text only WARN (exit 0), because a false positive on the one
// deploy path would get the whole guard commented out.
async function checkInvariants() {
  const read = (p) => readFile(p, "utf8");
  const hard = [], warn = [];

  // 1 (hard) — every EXACT index.js ROUTES key is covered by the wrangler
  // run_worker_first allowlist, or that route silently serves static. Globs
  // and regex PREFIX are matched, never required literally (a symmetric diff
  // would false-fire on the 13 glob entries — the exact disable-magnet).
  const idx = await read("holding/_worker.js/index.js");
  const wrangler = await read("wrangler.jsonc");
  const routesBlock = (idx.match(/const ROUTES = new Map\(\[([\s\S]*?)\]\);/) || [,""])[1];
  const routeKeys = [...routesBlock.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
  const allowBlock = (wrangler.match(/"run_worker_first"\s*:\s*\[([\s\S]*?)\]/) || [,""])[1];
  const allow = [...allowBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const globRe = (g) => new RegExp("^" + g.replace(/[.]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const covered = (p) => allow.includes(p) || allow.some((a) => a.includes("*") && globRe(a).test(p));
  for (const k of routeKeys) if (!covered(k)) hard.push(`ROUTES key ${k} is not in wrangler run_worker_first (route would silently serve static)`);

  // 2 (hard) — wherever a worker emits a CSP with a style-src, it includes
  // 'self'. cal emits no CSP and passes vacuously (this is the exact thing that
  // blanked serendipity's taskbar).
  for (const f of ["holding/_headers", "holding/_worker.js/lib/security.js", "serendipity/serendipity.js", "cal/src/templates.js", "cal/src/index.js"]) {
    let s; try { s = await read(f); } catch { continue; }
    for (const m of s.matchAll(/style-src([^;'"]*(?:'[^']*')?[^;'"]*)*/g)) {
      const dir = m[0];
      if (!dir.includes("'self'")) hard.push(`${f}: a CSP style-src omits 'self' (would block /luna.css): ${dir.slice(0, 60)}`);
    }
  }

  // 3 (hard) — luna.css keeps all three white-blink rules (phase C's tripwire).
  // Dropping any one reintroduces the additive-blend flash on every nav.
  const luna = await read("holding/luna.css");
  for (const rule of [
    "::view-transition-image-pair(axp-window){isolation:auto}",
    "::view-transition-old(axp-window),::view-transition-new(axp-window){mix-blend-mode:normal}",
    "animation:none !important;mix-blend-mode:normal}",
  ]) if (!luna.includes(rule)) hard.push(`luna.css lost a white-blink rule: ${rule}`);

  // 3b (hard) — luna.css parses as valid CSS. A botched find-replace in v143
  // wrapped several .window/.xp-button declarations in :where(...) and left
  // unbalanced parens; esbuild only WARNS (never throws) and the served bytes
  // are byte-identical to git, so the corruption shipped silently for three
  // releases (the .window box-shadow + the whole .xp-button base rule dropped
  // from the CSSOM). Transform as CSS and block on any warning.
  try {
    const res = await transform(luna, { loader: "css", minify: false });
    for (const w of res.warnings) hard.push(`luna.css CSS parse warning: ${w.text}${w.location ? ` (line ${w.location.line})` : ""}`);
  } catch (e) {
    hard.push(`luna.css failed to parse as CSS: ${e.message.split("\n")[0]}`);
  }

  // 4 (warn) — the static desktop partial is current with nav.js's data. A
  // byte-compare would false-fire on whitespace, so this is a count proxy: one
  // taskbar pin per SUBPAGE, one desktop icon per DESKTOP entry (Notepad +
  // profiles). Catches the real drift (added/removed a destination without
  // re-running gen-desktop-partial.mjs).
  try {
    const nav = await read("holding/nav.js");
    const desktopMod = await read("holding/_worker.js/lib/desktop.js");
    const chrome = JSON.parse((desktopMod.match(/DESKTOP_CHROME = ("(?:[^"\\]|\\.)*");/) || [,'""'])[1]);
    const countLabels = (block) => (((nav.match(new RegExp("var " + block + " = \\[([\\s\\S]*?)\\];")) || [,""])[1].match(/label:/g)) || []).length;
    const subpages = countLabels("SUBPAGES");
    const profiles = countLabels("PROFILES");
    const pins = (chrome.match(/class="axp-pin"/g) || []).length;
    const icons = (chrome.match(/data-key=/g) || []).length;
    if (pins !== subpages) warn.push(`lib/desktop.js has ${pins} taskbar pins but nav.js SUBPAGES has ${subpages} — re-run gen-desktop-partial.mjs`);
    if (icons !== profiles + 1) warn.push(`lib/desktop.js has ${icons} desktop icons but nav.js has ${profiles + 1} (Notepad + profiles) — re-run gen-desktop-partial.mjs`);
  } catch (e) { warn.push(`generator freshness check could not run: ${e.message}`); }

  // 5 (warn) — the OS-window critical-CSS copies are divergent per-context
  // subsets (cal carries almost none), so a full byte-guard would false-fire.
  // The one value that drifts and hurts is the taskbar-floor height: every
  // file that carries the calc must agree with luna.css, or first paint lands
  // a different window height than the final.
  const floors = new Map();
  for (const f of ["holding/luna.css", "holding/_worker.js/lib/chrome.js", "holding/_worker.js/writing.js", "serendipity/serendipity.js"]) {
    let s; try { s = await read(f); } catch { continue; }
    // the BODY floor only (`height:calc(...)`), not a window `max-height:calc(...)`
    for (const m of s.matchAll(/(?<!max-)height:calc\(100dvh - (\d+)px\)/g)) floors.set(f, m[1]);
  }
  const floorVals = new Set(floors.values());
  if (floorVals.size > 1) warn.push(`taskbar-floor height disagrees across the critical-geometry copies (${[...floors].map(([f, v]) => `${f.split("/").pop()}:${v}px`).join(", ")}) — luna.css and the inline copies must match`);

  // 6 (warn) — the local-dev twin (wrangler.dev.jsonc) must declare the same
  // bindings as the deploy config (wrangler.jsonc), or local `wrangler dev`
  // diverges from prod. Compare the set of binding identifiers by name; a
  // mismatch means a binding was added to one config but not the other.
  try {
    const dev = await read("wrangler.dev.jsonc");
    const names = (s) => new Set([...s.matchAll(/"(?:binding|name|database_name|bucket_name|dataset)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
    const a = names(wrangler), b = names(dev);
    const diff = [...new Set([...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x))))];
    if (diff.length) warn.push(`wrangler.jsonc and wrangler.dev.jsonc binding sets differ (${diff.join(", ")}) — keep the dev twin in sync`);
  } catch (e) { warn.push(`dev-config drift check could not run: ${e.message}`); }

  // 7 (hard) — every agent-skills digest matches the file it points at. The
  // discovery schema invites clients to verify these, so a stale digest doesn't
  // read as "the author forgot": it reads as tampering, and the skill gets
  // rejected. Editing SKILL.md without regenerating index.json already shipped
  // that state once, so the check belongs on the one unbypassable deploy path.
  let skillsChecked = 0;
  try {
    const idx = JSON.parse(await read("holding/.well-known/agent-skills/index.json"));
    for (const s of idx.skills || []) {
      const path = "holding" + new URL(s.url).pathname;
      const actual = "sha256:" + createHash("sha256").update(await readFile(path)).digest("hex");
      if (s.digest !== actual) hard.push(`agent-skills: ${s.name} digest is stale — index.json says ${s.digest.slice(0, 20)}…, ${path} hashes to ${actual.slice(0, 20)}… (regenerate index.json)`);
      skillsChecked++;
    }
  } catch (e) { warn.push(`agent-skills digest check could not run: ${e.message}`); }

  if (warn.length) console.warn("build: invariant WARNINGS (deploy continues):\n  - " + warn.join("\n  - "));
  if (hard.length) throw new Error("build: invariant tripwires FAILED, deploy blocked:\n  - " + hard.join("\n  - "));
  console.log(`invariants ok: ${routeKeys.length} routes mirrored, CSP style-src, blink-fix, generator, geometry, ${skillsChecked} skill digest${skillsChecked === 1 ? "" : "s"}${warn.length ? " (with warnings above)" : ""}`);
}

// the shells to minify: [file, banner pointer, tripwire the minified output MUST contain]
// sw.js left this list in v136: it's a ~15-line unregister stub now, shipped
// readable and verbatim (no version string, no twin, nothing to tripwire).
const SHELLS = [
  ["nav.js",     "/nav.src.js",     "axp-histnav"],
  ["notepad.js", "/notepad.src.js", "np-window"],
  ["lens.js",    "/lens.src.js",    "replaceState"],   // verify-routes.mjs marker
];

// fail fast on a broken invariant before doing any staging work
await checkInvariants();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1) stage: holding/ verbatim (.assetsignore rides along). No wrangler config is
// copied into .build anymore — the deploy config (wrangler.jsonc) points main +
// assets at .build/holding and runs THIS script via its build.command, so the
// build output never needs its own config. (Local dev uses wrangler.dev.jsonc.)
await cp("holding", `${OUT}/holding`, { recursive: true });

// 2) shells: deploy the readable original as <name>.src.js, minify the served file
for (const [file, srcPath, marker] of SHELLS) {
  const src = await readFile(`holding/${file}`, "utf8");
  await writeFile(`${OUT}/holding/${srcPath.slice(1)}`, src);

  const { code } = await transform(src, { minify: true, target: "es2020" });
  const banner = `/*! minified at deploy - readable source: ${srcPath} */\n`;
  const min = banner + code;

  // tripwires: a transform that breaks these invariants must fail the deploy
  if (marker && !min.includes(marker)) {
    throw new Error(`${file}: minified output lost the "${marker}" marker`);
  }

  await writeFile(`${OUT}/holding/${file}`, min);
  console.log(`${file}: ${src.length} -> ${min.length} bytes (+ ${srcPath})`);
}

// 3) luna.css: the one shared external stylesheet, minified with a readable
// /luna.src.css twin (same readable-twin philosophy as the shells). Repaired, it
// goes 63KB->35KB raw / 16.0KB->7.35KB brotli — an ~8.7KB saving on a
// render-blocking sheet every worker-rendered + garage/lwe page loads, almost
// all of it the heavy View-Source comments (which live on in luna.src.css).
// Owner-approved 2026-07 as the ONE non-shell file the build is allowed to
// minify; do not extend CSS minification past luna.css without the owner's say-so.
{
  const src = await readFile("holding/luna.css", "utf8");
  await writeFile(`${OUT}/holding/luna.src.css`, src);
  const { code, warnings } = await transform(src, { loader: "css", minify: true });
  if (warnings.length) throw new Error(`luna.css minify emitted warnings: ${warnings.map(w => w.text).join("; ")}`);
  const out = `/*! minified at deploy - readable source: /luna.src.css */\n` + code;
  await writeFile(`${OUT}/holding/luna.css`, out);
  console.log(`luna.css: ${src.length} -> ${out.length} bytes (+ /luna.src.css)`);
}

console.log(`staged ${OUT}/ - deploy with: wrangler deploy (self-builds via build.command) or npm run deploy`);
