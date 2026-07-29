// build.mjs: the site's one build step, and it runs only at deploy.
//
// Authoring stays buildless: everything in holding/, cal/, and serendipity/ is
// committed readable and is the source of truth. This script stages the static
// holding tree plus the two embedded application modules under .build/ and
// minifies exactly six client scripts (the assets pages load) plus the homepage
// HTML; images and _headers ship byte-identical to git. Each transformed asset
// gets a readable twin deployed alongside it, because View Source is part of the
// product and minification must not cost it.
//
// The garage/ and lwe/ HTML and the worker modules are NOT minified, but they are
// no longer byte-identical to git either: step 1b injects the client-edge CSS
// mirror into every staged page that carries the window geometry, derived from
// luna.css. It is one commented, readable line in a readable file — View Source
// still reads as hand-written CSS, and the line says where it came from.
//
//   node build.mjs                                   # stage .build/
//   npm run deploy                                   # build + wrangler deploy -c .build/wrangler.jsonc
//
// wrangler resolves `main` and `assets.directory` relative to the config file, so the
// root wrangler.jsonc is copied verbatim into .build/ and just works against the copy.

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, zstdCompressSync } from "node:zlib";
import minifyHtml from "@minify-html/node";
import { transform as transformCss } from "lightningcss";
import { minifySync } from "oxc-minify";
import { readManifest, workerModule, navFenceBody, readFenceBody } from "./scripts/gen-manifest.mjs";
import { HTML_MARKERS } from "./scripts/lib/html-markers.mjs";

const OUT = ".build";

// dcz framing (RFC 9842), the one construction both delta passes share: compress
// against the dictionary, then prepend the dictionary's SHA-256 in a Zstandard
// SKIPPABLE frame — magic 0x184D2A5E little-endian, a 4-byte LE length of 32, then
// the raw digest. Being valid zstd, that prefix is skipped by any conforming
// decoder, which is what lets `zstd -d -D dict` round-trip the whole file.
//
// One function because the shell pass and the page pass each built this by hand and
// the browser is the decoder: a byte wrong in either copy is a delta no client can
// apply, and only on the surface whose copy drifted. Consolidated 2026-07-28.
function dczEncode(bytes, dictBytes) {
  const frame = zstdCompressSync(bytes, {
    dictionary: dictBytes,
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });
  const digest = createHash("sha256").update(dictBytes).digest();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(digest.length, 0);
  return {
    out: Buffer.concat([Buffer.from([0x5e, 0x2a, 0x4d, 0x18]), len, digest, frame]),
    digest,
  };
}

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

  // 1 (hard) — every index.js dispatch key is covered by the wrangler
  // run_worker_first allowlist, or that route silently serves static. BOTH tables
  // are checked: the exact ROUTES map, and the ordered PREFIX table (whose labels
  // become a concrete probe path). Allowlist globs are matched as patterns, never
  // required literally (a symmetric diff would false-fire on the glob entries —
  // the exact disable-magnet).
  const idx = await read("holding/_worker.js/index.js");
  const wrangler = await read("wrangler.jsonc");
  const routesBlock = (idx.match(/const ROUTES = new Map\(\[([\s\S]*?)\]\);/) || [,""])[1];
  const routeKeys = [...routesBlock.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
  const allowBlock = (wrangler.match(/"run_worker_first"\s*:\s*\[([\s\S]*?)\]/) || [,""])[1];
  const allow = [...allowBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const globRe = (g) => new RegExp("^" + g.replace(/[.]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const covered = (p) => allow.includes(p) || allow.some((a) => a.includes("*") && globRe(a).test(p));
  for (const k of routeKeys) if (!covered(k)) hard.push(`ROUTES key ${k} is not in wrangler run_worker_first (route would silently serve static)`);

  // the PREFIX table is the second dispatch surface and was never asserted, so a
  // route like /writing/<slug> could lose its allowlist entry and quietly go static.
  // Turn each label's placeholder into a path the glob matcher can actually test.
  const prefixBlock = (idx.match(/const PREFIX = \[([\s\S]*?)\n\];/) || [, ""])[1];
  const prefixProbes = [...prefixBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) =>
    m[1].replace("<slug>", "x").replace("<stem>", "x").replace("<key>", "x").replace("<thumb>", "x.avif"));
  for (const p of prefixProbes) if (!covered(p)) hard.push(`PREFIX route ${p} is not in wrangler run_worker_first (route would silently serve static)`);

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
    const res = transformCss({ filename: "holding/luna.css", code: Buffer.from(luna), minify: false });
    for (const w of res.warnings) hard.push(`luna.css CSS parse warning: ${w.message}${w.loc ? ` (line ${w.loc.line})` : ""}`);
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

  // 5b (hard) — the client edge (luna.css, search "THE CLIENT EDGE") is authored
  // exactly once and injected into the staged pages by clientEdgeMirror() below.
  // If the declaration can't be found in luna.css there is nothing to inject and
  // every page silently loses its first-paint mirror, so this blocks rather than
  // warns: a missing rule here is a rename or a bad edit, not a taste call.
  if (!clientEdgeDecl(await read("holding/luna.css"))) hard.push("luna.css: the client-edge declaration went missing (search \"THE CLIENT EDGE\") — build.mjs injects it into every windowed page and has nothing to inject");

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

  // 8 (hard) — the site surface registry (site-manifest.json) is the single truth
  // for which pages exist and where they show. Its two GENERATED projections must
  // match a fresh regen, and its three HAND-authored consumers (nav's Run palette,
  // sitemap.xml, the garage gallery) must agree with the registry's flags. This is
  // the check that would have caught the 10-vs-12-vs-15 garage drift these three
  // surfaces had accumulated before the manifest existed.
  let manifestChecked = 0;
  try {
    const { surfaces } = readManifest();
    const nav = await read("holding/nav.js");

    // 8a — generated projections match `npm run gen:manifest` output exactly.
    const modActual = (await read("holding/_worker.js/lib/site-manifest.js")).trim();
    if (modActual !== workerModule(surfaces).trim()) hard.push("lib/site-manifest.js drifted from site-manifest.json — run npm run gen:manifest");
    for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
      if (readFenceBody(nav, marker) !== navFenceBody(surfaces, section)) hard.push(`nav.js generated:${marker} drifted from site-manifest.json — run npm run gen:manifest`);
    }

    // parse the live surfaces out of each hand-authored consumer.
    const navPagesBlock = (nav.match(/var PAGES = \[([\s\S]*?)\n {2}\];/) || [, ""])[1];
    const navRun = new Set([...navPagesBlock.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]));
    const subBlock = (nav.match(/var SUBPAGES = \[([\s\S]*?)\];/) || [, ""])[1];
    const navTaskbar = new Set([...subBlock.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]));
    const sitemap = await read("holding/sitemap.xml");
    const smLocs = new Set([...sitemap.matchAll(/<loc>https:\/\/aadhar\.sh([^<]*)<\/loc>/g)].map((m) => m[1] || "/"));
    // the generated desktop partial is chrome, not gallery content, and it links
    // every taskbar app — so a pin whose path matches the gallery shape (e.g.
    // /pixel-peeper) would otherwise read as a gallery card that isn't there.
    // Strip the partial before scanning so this only ever sees hand-written cards.
    const gallery = (await read("holding/garage/index.html"))
      .replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, "");
    const galLinks = new Set([...gallery.matchAll(/href="(\/(?:garage\/[a-z0-9]+|pixel-peeper))"/g)].map((m) => m[1]));

    // 8b — each flag is the registry's contract with exactly one surface; assert
    // both directions so neither the registry nor the surface can drift alone.
    const want = (f) => surfaces.filter((s) => s.flags[f]).map((s) => s.path);
    const bidi = (label, wantPaths, have, opts = {}) => {
      const w = new Set(wantPaths);
      for (const p of w) if (!have.has(p)) hard.push(`${label}: ${p} is flagged in site-manifest.json but missing from the surface`);
      if (!opts.subsetOnly) for (const p of have) if (!w.has(p)) hard.push(`${label}: ${p} is in the surface but not flagged in site-manifest.json`);
    };
    bidi("run/nav PAGES", want("run"), navRun);
    bidi("taskbar/nav SUBPAGES", want("taskbar"), navTaskbar);
    bidi("gallery/garage index", want("gallery"), galLinks);
    // sitemap carries leaf content the registry doesn't own (writing posts,
    // resume files), so forward is full but reverse is scoped to garage/lwe.
    for (const p of want("sitemap")) if (!smLocs.has(p)) hard.push(`sitemap: ${p} is flagged sitemap in site-manifest.json but has no <loc>`);
    for (const p of smLocs) if (/^\/(garage|lwe)\//.test(p) && !surfaces.some((s) => s.path === p)) hard.push(`sitemap: ${p} has a <loc> but is not registered in site-manifest.json`);

    // 8c — every garage/lwe page on disk is registered (or an explicit exclusion),
    // so adding a page forces a registry entry rather than a silent omission.
    const BARE = new Set(["index.html", "vt-b.html", "vt-check.html"]);
    const known = new Set(surfaces.map((s) => s.path));
    for (const dir of ["garage", "lwe"]) {
      for (const f of await readdir(`holding/${dir}`)) {
        if (!f.endsWith(".html") || BARE.has(f)) continue;
        const p = `/${dir}/${f.slice(0, -5)}`;
        if (!known.has(p)) hard.push(`${p} exists on disk but is not registered in site-manifest.json`);
      }
    }
    manifestChecked = surfaces.length;
  } catch (e) { hard.push(`site-manifest check could not run: ${e.message}`); }

  // 9 — the taste tripwires GREENFIELD.md asked for, calibrated against what the
  // site actually ships. Its list (ban cubic-bezier, any easing beyond linear,
  // any radius over 3px, any blurred shadow) would block this deploy today: the
  // window minimize/restore morph IS a cubic-bezier, luna.css runs 60ms ease-out
  // everywhere, canon defines --radius-window: 8px, and XP menus really did drop
  // a soft shadow. Banning those bans the site. So the split here is between the
  // one rule that is owner LAW (zero font bytes, hard) and the drift signals that
  // want a human look (warn). Demo pages are exempt from the taste warnings and
  // NOT from the font law: /garage and /lwe exist to show the platform off, so
  // frontier CSS in them is the point, while a web font anywhere is still fatal.
  let tasteScanned = 0, tasteOk = [];
  try {
    const walk = async (dir, out = []) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!/^(i|images|og|cars|node_modules|\.well-known)$/.test(e.name)) await walk(p, out); }
        else if (/\.(css|html|js)$/.test(e.name) && !/\.src\.(js|css|html)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const served = [...await walk("holding"), "cal/src/templates.js", "serendipity/serendipity.js"];
    const isDemo = (p) => /^holding\/(garage|lwe)\//.test(p);
    // Blank block comments before pattern-matching (luna.css discusses @font-face
    // in prose twice, and a guard that fires on its own documentation gets
    // muted). BLANK rather than delete: same length, newlines kept, so a match
    // offset still maps to its real line — which is what lets a finding be
    // traced back to the source line and checked for a taste-ok marker.
    const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

    for (const f of served) {
      let raw; try { raw = await read(f); } catch { continue; }
      const src = blank(raw);
      const lines = raw.split("\n");
      const lineAt = (off) => lines[src.slice(0, off).split("\n").length - 1] || "";
      // A deliberate deviation is recorded ON THE LINE, as /* taste-ok: why */.
      // It silences the WARN-level checks only. There is no way to mark yourself
      // exempt from zero font bytes or from an overshoot curve, because those
      // are not taste calls. Reasons are printed in the build summary, so an
      // exemption stays visible instead of quietly becoming the new normal.
      const okOn = (off) => {
        const m = /taste-ok:\s*([^*\/]+)/.exec(lineAt(off));
        if (!m) return false;
        tasteOk.push(`${f}: ${m[1].trim()}`);
        return true;
      };
      tasteScanned++;

      // 9a (hard) — zero font bytes, the one rule with no taste component. Every
      // way a page could acquire a downloadable face, not just @font-face.
      if (/@font-face\s*\{[^}]*url\(/i.test(src)) hard.push(`${f}: @font-face with url() — the site ships 0 font bytes (local() reference rules belong in design/tokens/fonts.css, never in a served file)`);
      if (/@import[^;]*(font|typekit)/i.test(src)) hard.push(`${f}: @import of a font stylesheet — the site ships 0 font bytes`);
      if (/as\s*=\s*"?font"?/i.test(src)) hard.push(`${f}: rel=preload as=font — the site ships 0 font bytes`);
      for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "fonts.bunny.net"]) {
        if (src.includes(host)) hard.push(`${f}: references ${host} — the site ships 0 font bytes`);
      }

      // 9b (hard) — an overshoot easing curve. Unlike "is 300ms too slow", this
      // one is decidable: y outside [0,1] means the value springs past its target
      // and settles back, which is a 2015 motion language no Luna control had.
      for (const m of src.matchAll(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)) {
        const [y1, y2] = [Number(m[2]), Number(m[4])];
        if (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1) hard.push(`${f}: ${m[0]} overshoots — springy easing reads as a different era`);
      }
      if (isDemo(f)) continue;

      // 9c (warn) — a NEW easing curve outside the two the window morph uses.
      // Tuning one of these is a taste call, so this prompts a look, never a block.
      for (const m of src.matchAll(/cubic-bezier\([^)]*\)/g)) {
        const v = m[0].replace(/\s+/g, "");
        if (!["cubic-bezier(.4,0,1,1)", "cubic-bezier(0,0,.2,1)"].includes(v) && !okOn(m.index)) warn.push(`${f}: ${m[0]} is not one of the two window-morph curves — taste review`);
      }
      // 9d (warn) — radius past --radius-window (8px). Elliptical radii are
      // skipped: the Start orb is a real pill and its 9px/14px is correct.
      for (const m of src.matchAll(/border-radius:\s*([^;}"']+)/g)) {
        if (m[1].includes("/")) continue;
        for (const px of m[1].matchAll(/([\d.]+)px/g)) {
          if (Number(px[1]) > 8 && !okOn(m.index)) warn.push(`${f}: border-radius ${m[1].trim()} exceeds --radius-window (8px) — taste review`);
        }
      }
      // 9e (warn) — a soft shadow. XP dropped shadows on menus and dialogs, so
      // this can't be zero; luna.css's widest is 9px. Past 12px it stops reading
      // as a drop shadow and starts reading as a 2015 elevation surface.
      for (const m of src.matchAll(/box-shadow:\s*([^;}"']+)/g)) {
        if (/\binset\b/.test(m[1])) continue;
        // offsets may be a unitless 0 ("0 4px 24px"), so px is optional on them
        for (const px of m[1].matchAll(/-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+)px/g)) {
          if (Number(px[1]) > 12 && !okOn(m.index)) warn.push(`${f}: box-shadow blur ${px[1]}px reads as a modern elevation shadow — taste review`);
        }
      }
      // 9f (warn) — smooth scrolling. XP scrolled instantly; a demo page showing
      // the property off is exempt above.
      const sb = /scroll-behavior:\s*smooth/.exec(src);
      if (sb && !okOn(sb.index)) warn.push(`${f}: scroll-behavior: smooth — XP scrolled instantly`);
    }
  } catch (e) { warn.push(`taste tripwire could not run: ${e.message}`); }

  // 10 (hard) — no git conflict markers in anything the site serves. A rebase on
  // 2026-07-27 left an empty-vs-empty conflict in holding/garage/compression.html;
  // `git add -A` swallowed the three residue lines, and the build, the perf
  // budget, and all 24 contract tests passed. A human caught them by eye, in a
  // screenshot, rendering as visible text above the taskbar. Nothing in the
  // toolchain would have stopped them. A marker in a served file is never
  // intentional, so this blocks rather than warns.
  //
  // Anchored at line start ONLY, and `=======` must be the WHOLE line. The garage
  // pages legitimately discuss diffs, heredocs, and shell redirection in prose and
  // in code samples, so an unanchored match would false-fire on real content —
  // which is exactly how a guard on the one deploy path ends up commented out.
  let conflictScanned = 0;
  try {
    const collect = async (dir, match, skip = /^$/, out = []) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!skip.test(e.name)) await collect(p, match, skip, out); }
        else if (match.test(e.name)) out.push(p);
      }
      return out;
    };
    const flat = async (dir, match) =>
      (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && match.test(e.name)).map((e) => `${dir}/${e.name}`);
    const files = [
      ...await collect("holding", /\.html$/, /^(i|images|og|cars|node_modules)$/),
      ...await flat("holding", /\.(js|css)$/),
      ...await collect("holding/_worker.js", /\.js$/),
      ...await flat("cal/src", /\.js$/),
      ...await flat("serendipity", /\.js$/),
    ];
    const MARKER = /^(<{7} |={7}$|>{7} )/;
    for (const f of files) {
      let src; try { src = await read(f); } catch { continue; }
      conflictScanned++;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (MARKER.test(line)) hard.push(`${f}:${i + 1}: git conflict marker in a served file — ${line.slice(0, 60)}`);
      }
    }
  } catch (e) { hard.push(`conflict-marker check could not run: ${e.message}`); }

  if (warn.length) console.warn("build: invariant WARNINGS (deploy continues):\n  - " + warn.join("\n  - "));
  if (hard.length) throw new Error("build: invariant tripwires FAILED, deploy blocked:\n  - " + hard.join("\n  - "));
  console.log(`invariants ok: ${routeKeys.length + prefixProbes.length} routes mirrored (${prefixProbes.length} prefix), CSP style-src, blink-fix, generator, geometry, ${skillsChecked} skill digest${skillsChecked === 1 ? "" : "s"}, ${manifestChecked} surfaces registered, ${tasteScanned} files taste-scanned${tasteOk.length ? ` (${tasteOk.length} taste-ok: ${tasteOk.join("; ")})` : ""}, ${conflictScanned} files conflict-free${warn.length ? " (with warnings above)" : ""}`);
}

// ── the client edge, authored once and mirrored at deploy ────────────────────
// luna.css owns the rule (search "THE CLIENT EDGE") and every windowed page
// inherits it at runtime, so the SOURCE is already correct with nothing to
// remember on a new page. The mirror below exists purely for first paint: luna
// loads non-render-blocking and the edge's 6px gutter is layout, so without a
// copy in the page's own inline block the document lays out 12px wider and
// re-wraps once when luna lands.
//
// Hand-maintaining that copy in ~30 files was the thing worth deleting: it is
// derived data, it drifts, and forgetting it on a new page is invisible until
// someone watches a reflow. So the build derives it instead, from luna.css, and
// a page author never writes it. Local dev (wrangler.dev.jsonc) serves the
// unbuilt tree, where the edge simply arrives with luna.css.
//
// This is the ONLY generated CSS in the build. It adds no new rule and changes
// no cascade: the injected declaration is byte-identical to luna's, so when luna
// applies, nothing moves.

// pull the declaration body out of luna.css so there is one definition of it
const clientEdgeDecl = (luna) => {
  const m = /\.window>\.content,\.window>\.body\{(border:\d+px solid #ece9d8[^}]*outline-offset:-\d+px)\}/.exec(luna);
  return m ? m[1] : null;
};

// the geometry mirror every windowed page already carries; the edge goes after it
const GEOMETRY_MIRROR = /^([ \t]*)(\.window\s*>\s*\.content(?:\s*,\s*\.window\s*>\s*\.body)?\s*\{[^}]*overflow:\s*auto[^}]*\})[ \t]*$/m;

// insert the edge right after the geometry mirror, matching the file's own
// spacing so garage/lwe View Source still reads as hand-written CSS.
const clientEdgeMirror = (source, decl) => {
  const m = GEOMETRY_MIRROR.exec(source);
  if (!m) return null;
  const [, indent, rule] = m;
  const sel = rule.slice(0, rule.indexOf("{")).trim();
  const spaced = sel.includes(" > ");
  const body = spaced ? decl.replace(/([:,])(?! )/g, "$1 ").replace(/;/g, "; ") : decl;
  const line = spaced
    ? `${indent}/* client edge — generated by build.mjs from luna.css */\n${indent}${sel} { ${body}; }`
    : `${indent}/* client edge — generated by build.mjs from luna.css */\n${indent}${sel}{${body}}`;
  return source.slice(0, m.index + m[0].length) + "\n" + line + source.slice(m.index + m[0].length);
};

// the client scripts to minify: [file, banner pointer, tripwire the minified output MUST contain]
// sw.js left this list in v136: it's a ~15-line unregister stub now, shipped
// readable and verbatim (no version string, no twin, nothing to tripwire).
const SHELLS = [
  ["nav.js",     "/nav.src.js",     "axp-histnav"],
  ["notepad.js", "/notepad.src.js", "np-window"],
  ["lens.js",    "/lens.src.js",    "replaceState"],   // verify-routes.mjs marker
  ["lens-browser.js", "/lens-browser.src.js", "LensBrowser"],
  ["quiz.js",    "/quiz.src.js",    "luq-data"],       // the understanding-check widget
  ["tooltip.js", "/tooltip.src.js", "function start"],
  // the shared hover engine. tooltip.js imports it statically; the serendipity
  // shell and nav.js import it dynamically. Deliberately NOT content-hashed:
  // the /a/ repointer is attribute-scoped (src=/href= only) and would never
  // rewrite an `import` specifier, so it stays a plain /hoist.js like its peers.
  ["hoist.js",   "/hoist.src.js",   "createHoist"],
];

// fail fast on a broken invariant before doing any staging work
await checkInvariants();

// Generated delta dirs must never exist in the SOURCE tree. They were committed under an
// earlier design and are pure build output now, but a leftover holding/ad/ gets copied in
// by the staging step below and ships artifacts current code would never build — which is
// how an icons.*.dcz survived #119's svg exclusion locally, long after the guard forbidding
// it was in place. That guard stops GENERATION, not staging of stale files.
for (const dead of ["holding/ad", "holding/pd"]) {
  await rm(dead, { recursive: true, force: true });
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1) stage: holding/ verbatim (.assetsignore rides along). No wrangler config is
// copied into .build anymore — the deploy config (wrangler.jsonc) points main +
// assets at .build/holding and runs THIS script via its build.command, so the
// build output never needs its own config. (Local dev uses wrangler.dev.jsonc.)
await cp("holding", `${OUT}/holding`, { recursive: true });
await mkdir(`${OUT}/cal`, { recursive: true });
await cp("cal/src", `${OUT}/cal/src`, { recursive: true });
await mkdir(`${OUT}/serendipity`, { recursive: true });
await cp("serendipity/serendipity.js", `${OUT}/serendipity/serendipity.js`);

// 1b) inject the client edge into every staged page that carries the window
// geometry mirror. Runs BEFORE minification so the injected CSS is minified with
// the rest of the page rather than riding along as a readable line in a minified
// file. Pages that load luna.css render-blocking (garage/gpt56.html) carry no
// geometry mirror and correctly get nothing.
{
  const decl = clientEdgeDecl(await readFile("holding/luna.css", "utf8"));
  const targets = (await readdir(`${OUT}/holding`, { recursive: true }))
    .filter((f) => /\.(html|js)$/.test(f) && !/\.src\.|^(i|images|og|cars)\//.test(f))
    .map((f) => `${OUT}/holding/${f}`)
    .concat([`${OUT}/cal/src/templates.js`, `${OUT}/serendipity/serendipity.js`]);

  let mirrored = 0, skipped = 0;
  for (const f of targets) {
    let src; try { src = await readFile(f, "utf8"); } catch { continue; }
    if (!GEOMETRY_MIRROR.test(src)) { skipped++; continue; }
    const out = clientEdgeMirror(src, decl);
    if (!out) throw new Error(`client edge: ${f} matched the geometry mirror but the injection did not fire`);
    await writeFile(f, out);
    mirrored++;
  }
  // a rename in luna.css or in the geometry mirror would silently mirror nothing
  // and cost every page a reflow, so the count is the tripwire.
  if (mirrored < 25) throw new Error(`client edge: mirrored into only ${mirrored} pages (expected 25+) — did the geometry-mirror shape change?`);
  console.log(`client edge: mirrored into ${mirrored} staged pages from luna.css (${skipped} files carry no window geometry)`);
}

// 1c) the Markdown twins + per-section llms.txt indexes. Generated from the
// READABLE source in holding/, never from the staged copy: the staged pages are
// about to be rewritten (client edge, hashed asset refs) and index.html is about
// to be minified, none of which belongs in a twin. Because a twin is a pure
// function of source bytes, generating it here makes drift structurally
// impossible — no committed copy to fall behind, no step to forget. Same
// argument the dcz deltas won.
{
  const { buildTwins, checkTwinFacts } = await import("./scripts/gen-md-twins.mjs");
  const drift = checkTwinFacts(".");
  if (drift.length) {
    throw new Error("md twins: a hand-authored twin disagrees with the Worker that renders its page:\n  - " + drift.join("\n  - "));
  }
  const { files, skipped } = buildTwins(".");
  for (const [rel, body] of files) {
    const dest = `${OUT}/holding${rel}`;
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await writeFile(dest, body);
  }
  const twins = [...files.keys()].filter((k) => k.endsWith(".md")).length;
  const indexes = [...files.keys()].filter((k) => k.endsWith("llms.txt")).length;
  // Losing the twins would otherwise be silent: pages keep serving HTML and only
  // `Accept: text/markdown` degrades, which nothing else in the build watches.
  if (twins < 30) throw new Error(`md twins: generated only ${twins} twins (expected 30+) — did site-manifest.json or the page shape change?`);
  console.log(`md twins: ${twins} pages + ${indexes} section indexes staged (${skipped.length} Worker-rendered surfaces carry no prose source)`);
}

const minifyJavaScript = (filename, sourceText) => {
  const result = minifySync(filename, sourceText, {
    module: false,
    compress: {
      // The site deliberately targets modern browsers. This preserves modern
      // syntax while enabling Oxc's full ESNext compression set.
      target: "esnext",
      dropDebugger: true,
      unused: true,
      joinVars: true,
      sequences: true,
      treeshake: {
        annotations: true,
        propertyReadSideEffects: "always",
        propertyWriteSideEffects: true,
        unknownGlobalSideEffects: true,
        invalidImportSideEffects: true,
      },
    },
    // Keep top-level names stable: several shell files expose globals that
    // other site code discovers by name.
    mangle: { toplevel: false },
    codegen: { removeWhitespace: true, legalComments: "none" },
  });
  if (result.errors.length) {
    throw new Error(`${filename}: Oxc parse/minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.code;
};

const minifyCss = (filename, sourceText) => {
  const result = transformCss({ filename, code: Buffer.from(sourceText), minify: true });
  if (result.warnings.length) {
    throw new Error(`${filename}: Lightning CSS minify emitted warnings: ${result.warnings.map((w) => w.message).join("; ")}`);
  }
  return Buffer.from(result.code).toString();
};

// Homepage HTML uses minify-html for structure only; inline CSS/JS are passed
// through the same Lightning CSS and Oxc settings used everywhere else in the
// build. JSON-LD and speculation rules remain data, not JavaScript.
const HTML_MINIFY_CFG = {
  allow_noncompliant_unquoted_attribute_values: false,
  allow_optimal_entities: false,
  allow_removing_spaces_between_attributes: false,
  keep_closing_tags: true,
  keep_comments: false,
  keep_html_and_head_opening_tags: true,
  keep_input_type_text_attr: true,
  keep_ssi_comments: true,
  minify_css: false,
  minify_doctype: false,
  minify_js: false,
  remove_bangs: false,
  remove_processing_instructions: false,
};
const RAW_HTML_TAGS = new Set(["pre", "script", "style", "textarea"]);

const findHtmlTagEnd = (source, start) => {
  let quote = "";
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  throw new Error("HTML inline transform: unterminated tag at byte " + start);
};

const scriptType = (openTag) => {
  const match = openTag.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
  return (match ? (match[1] || match[2] || match[3] || "") : "").toLowerCase();
};

const isJavaScriptScript = (openTag) => {
  const type = scriptType(openTag);
  return !type || ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"].includes(type);
};

const transformInlineHtmlBlocks = (source) => {
  let out = "";
  let cursor = 0;

  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor);
    if (lt === -1) {
      out += source.slice(cursor);
      break;
    }

    out += source.slice(cursor, lt);
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("HTML inline transform: unterminated comment at byte " + lt);
      out += source.slice(lt, end + 3);
      cursor = end + 3;
      continue;
    }

    const gt = findHtmlTagEnd(source, lt);
    const token = source.slice(lt, gt + 1);
    out += token;
    cursor = gt + 1;

    const match = token.match(/^<\s*(\/?)\s*([A-Za-z][^\s/>]*)/);
    if (!match || match[1] || !RAW_HTML_TAGS.has(match[2].toLowerCase())) continue;

    const tag = match[2].toLowerCase();
    const close = new RegExp("<\\/\\s*" + tag + "\\s*>", "i").exec(source.slice(cursor));
    if (!close) throw new Error("HTML inline transform: unterminated <" + tag + "> element");
    const closeAt = cursor + close.index;
    const body = source.slice(cursor, closeAt);

    if (tag === "style") {
      out += minifyCss("holding/index.html inline <style>", body);
    } else if (tag === "script" && isJavaScriptScript(token)) {
      out += minifyJavaScript("holding/index.html inline <script>", body);
    } else {
      out += body;
    }

    out += source.slice(closeAt, closeAt + close[0].length);
    cursor = closeAt + close[0].length;
  }

  return out;
};

const inlineProbe = transformInlineHtmlBlocks(
  '<style>/* probe */ .x { color: red; }</style>\n' +
  '<script>/* probe */ const x = 1 + 2;</script>\n' +
  '<script type="application/ld+json">\n{ "x": 1 }\n</script>'
);
if (inlineProbe.includes("/* probe */") ||
    !inlineProbe.includes('<script type="application/ld+json">\n{ "x": 1 }\n</script>')) {
  throw new Error("inline CSS/JS transform self-test failed");
}


// 2) homepage HTML: deploy the readable original as /index.src.html and
// minify only the served copy. The worker rewrites this response as a stream,
// so doing this before ASSETS.fetch keeps the rewriter path allocation-free.
{
  // TWO sources on purpose, and the split is the whole point of the twin:
  //   - `authored` is holding/index.html untouched. It is what /index.src.html
  //     ships, and perf-budget.mjs asserts the twin is byte-identical to it.
  //     "Readable source" means the file a human wrote, not a build artifact.
  //   - `staged` is that file plus step 1b's injected client edge, and it is what
  //     gets minified and served. Reading `authored` here instead would drop the
  //     injection on the floor and quietly cost the homepage its first-paint
  //     mirror (it did, for one commit).
  // The twin is not lying by omission: the inline block says in so many words
  // that the client edge is injected by build.mjs from luna.css.
  const authored = await readFile("holding/index.html", "utf8");
  const staged = await readFile(`${OUT}/holding/index.html`, "utf8");
  const srcPath = "/index.src.html";
  const banner = `<!-- minified at deploy; readable source: ${srcPath} -->\n`;
  const inlineMinified = transformInlineHtmlBlocks(staged);
  const body = minifyHtml.minify(Buffer.from(inlineMinified), HTML_MINIFY_CFG).toString();
  const min = banner + body;
  for (const [label, marker] of HTML_MARKERS) {
    if (!marker.test(min)) throw new Error("index.html: HTML minifier lost required marker " + label);
  }
  // the served copy must actually carry the injection; the twin must not
  if (!/border:\s*6px solid #ece9d8/.test(min)) throw new Error("index.html: the minified homepage lost the injected client edge");
  await writeFile(`${OUT}/holding/${srcPath.slice(1)}`, authored);
  await writeFile(`${OUT}/holding/index.html`, min);
  console.log(`index.html: ${staged.length} -> ${min.length} bytes (+ ${srcPath}, byte-identical to source; inline JS/CSS use existing minifiers)`);
}


// 3) shells: deploy the readable original as <name>.src.js, minify the served file
for (const [file, srcPath, marker] of SHELLS) {
  const src = await readFile(`holding/${file}`, "utf8");
  await writeFile(`${OUT}/holding/${srcPath.slice(1)}`, src);

  const code = minifyJavaScript(`holding/${file}`, src);
  const banner = `/*! minified at deploy - readable source: ${srcPath} */\n`;
  const min = banner + code;

  // tripwires: a transform that breaks these invariants must fail the deploy
  if (marker && !min.includes(marker)) {
    throw new Error(`${file}: minified output lost the "${marker}" marker`);
  }

  await writeFile(`${OUT}/holding/${file}`, min);
  console.log(`${file}: ${src.length} -> ${min.length} bytes (+ ${srcPath})`);
}

// 4) luna.css: the one shared external stylesheet, minified with a readable
// /luna.src.css twin (same readable-twin philosophy as the shells). Repaired, it
// goes 63KB->35KB raw / 16.0KB->7.35KB brotli — an ~8.7KB saving on a
// render-blocking sheet every worker-rendered + garage/lwe page loads, almost
// all of it the heavy View-Source comments (which live on in luna.src.css).
// Owner-approved 2026-07 as the ONE non-shell file the build is allowed to
// minify; do not extend CSS minification past luna.css without the owner's say-so.
{
  const src = await readFile("holding/luna.css", "utf8");
  await writeFile(`${OUT}/holding/luna.src.css`, src);
  const code = minifyCss("holding/luna.css", src);
  const out = `/*! minified at deploy - readable source: /luna.src.css */\n` + code;
  await writeFile(`${OUT}/holding/luna.css`, out);
  console.log(`luna.css: ${src.length} -> ${out.length} bytes (+ /luna.src.css)`);
}

// 5) worker-module CSS: minify static CSS template literals marked with a
// leading /*min*/ sentinel. Dynamic page CSS stays unmarked; readable source
// remains in holding/ while only the staged worker bytes shrink on the wire.
{
  const dir = `${OUT}/holding/_worker.js`;
  const jsFiles = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js"));
  const marker = /`(\/\*min\*\/[^`]*)`/g;
  let litCount = 0, saved = 0, fileCount = 0;
  for (const rel of jsFiles) {
    const path = `${dir}/${rel}`;
    const src = await readFile(path, "utf8");
    const matches = [...src.matchAll(marker)];
    if (!matches.length) continue;
    let out = "", last = 0;
    for (const m of matches) {
      const cssLiteral = m[1];
      if (cssLiteral.includes("${")) throw new Error(`${rel}: a /*min*/ CSS literal carries interpolation`);
      const min = minifyCss(`holding/_worker.js/${rel}`, cssLiteral).replace(/\n+$/, "");
      out += src.slice(last, m.index) + "`" + min + "`";
      last = m.index + m[0].length;
      saved += m[0].length - (min.length + 2);
      litCount++;
    }
    out += src.slice(last);
    const parsed = minifySync(`holding/_worker.js/${rel}`, out, {
      module: false,
      compress: false,
      mangle: false,
      codegen: { removeWhitespace: false, legalComments: "inline" },
    });
    if (parsed.errors.length) {
      throw new Error(`${rel}: minifying CSS broke JS parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    await writeFile(path, out);
    fileCount++;
  }
  console.log(`worker CSS: minified ${litCount} /*min*/ literals across ${fileCount} modules, ~${(saved / 1024).toFixed(1)}KB raw saved`);
}

// 6) content-hash the critical-path shell assets (nav.js + luna.css + lens.js) into
// immutable /a/<name>.<hash8>.<ext> URLs, then repoint every <script src>/<link
// href> that loads them. /a/<name>.<hash8> names exact bytes (same content-
// addressed contract as /i/ thumbnails, and edge-direct for the same reason: not
// in run_worker_first), so it earns the year + immutable cache Lighthouse's
// "efficient cache lifetimes" audit wants — which the short-cached /nav.js +
// /luna.css can't. Those unhashed files stay as fallbacks (cal/coffee's absolute
// refs + any stale HTML still resolve). The rewrite is ATTRIBUTE-SCOPED (src=/href=
// only), so the garage pages' documentary /nav.js mentions (path:"/nav.js",
// wrangler "!/nav.js") are untouched, and it skips the shell scripts themselves
// (nav.js carries its own /luna.css fallback string, which must stay plain and must
// not desync the hash we just computed). Owner-approved 2026-07-21 — the one place
// the build is allowed past the six shells + luna.css (hard rule 3).
{
  const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const esc = (s) => s.replace(/[/.]/g, "\\$&");
  await mkdir(`${OUT}/holding/a`, { recursive: true });

  const ASSETS = [
    { attr: "src",  from: "/nav.js",   base: "nav",  ext: "js",  witness: "index.html" },
    { attr: "href", from: "/luna.css", base: "luna", ext: "css", witness: "index.html" },
    // lens.js is emitted by ONE tag (lens.js `scripts:`), which used to carry a
    // hand-bumped ?v=N. The /lens shell is no-store but the script was cached, so
    // a forgotten bump paired a fresh shell with an old script — the comment at
    // the tag said so out loud. A content hash retires the ritual. Not in
    // run_worker_first, so /a/ is edge-direct and inherits the immutable rule.
    { attr: "src",  from: "/lens.js",  base: "lens", ext: "js",  witness: "_worker.js/lens.js" },
    // the desktop icon sprite. Unlike the three above, every ref carries a
    // #fragment (src="/icons.svg#pin-garage"), so `frag` widens the match to
    // keep it. Its witness is the desktop partial, which is where all 12 live.
    // src= rather than href= because the refs are <img> against <view>s, not
    // <svg><use> against <symbol>s — see the WebKit note in gen-desktop-partial.mjs.
    { attr: "src", from: "/icons.svg", base: "icons", ext: "svg", frag: true, witness: "_worker.js/lib/desktop.js" },
    // quiz.js + notepad.js joined 2026-07-27. Both were served unhashed at max-age=300,
    // so hashing them buys a year + immutable outright, and enrolling them in /a/ means
    // they inherit the brotli q11 twin and the dcz delta path for free.
    //
    // These two and no others of the five deferred islands. tooltip.js and hoist.js load
    // via `import("/tooltip.js")`, and lens-browser.js via `script.src = "..."`: all three
    // are JS STRING literals, not attributes. The repointer below is attribute-scoped on
    // purpose, so that it cannot rewrite the garage pages' documentary /nav.js mentions.
    // It would silently miss those three and the witness tripwire would fail the deploy.
    // Moving them needs a different mechanism, not another line here.
    { attr: "src", from: "/quiz.js",    base: "quiz",    ext: "js", witness: "garage/encoding.html" },
    { attr: "src", from: "/notepad.js", base: "notepad", ext: "js", witness: "_worker.js/writing.js" },
  ];
  const hashedFor = {};
  // ── phase 0: the three JS-STRING-loaded islands (tooltip, hoist, lens-browser) ──
  // These load via `import("/hoist.js")` / `script.src = "/lens-browser.js?v=1"`, which
  // the attribute-scoped repointer below cannot touch. They are hashed FIRST, and their
  // loader strings rewritten across the staged tree BEFORE nav.js / lens.js are hashed,
  // so a dependent's hash covers its final bytes (nav.js imports hoist; lens.js loads
  // lens-browser). The patterns are exact call-syntax matches — `import((["'`])/x.js\1)`
  // — so the garage pages' documentary "/hoist.js" prose mentions cannot be caught, which
  // is the precision the attribute rule existed to protect. The ?v=1 ritual on
  // lens-browser retires here: the hash IS the version.
  //
  // hoist has TWO loader shapes, and missing the second one cost a real serialized
  // fetch in production: nav.js + index.html reach it through `import("/hoist.js")`,
  // but tooltip.js reaches it through a STATIC `import {...} from "/hoist.js"`. With
  // only the call-syntax pattern, tooltip.js kept the unhashed specifier, so every
  // homepage load fetched hoist twice — once hashed (the inline warm-up, parallel with
  // tooltip.js) and once unhashed, discovered only after tooltip.js had parsed. Measured
  // on production 2026-07-27: tooltip.js finished at 1112ms and /hoist.js only STARTED at
  // 1114ms, the one serialized fetch left on the page, and the duplicate came back
  // max-age=300 while its immutable twin sat in cache unused.
  //
  // ORDER IS LOAD-BEARING and the list is sorted leaves-first. Each asset's rewrites are
  // applied to the staged tree immediately after it is hashed, so a dependent hashed
  // later reads bytes that already carry its dependency's hashed URL. tooltip depends on
  // hoist, so hoist must be hashed and rewritten first — otherwise tooltip's `/a/` copy
  // ships the unhashed specifier forever, since the rewrite pass deliberately skips `a/`.
  const STRING_ASSETS = [
    { file: "/hoist.js",        base: "hoist",        mk: (to) => [
      [/import\((["'`])\/hoist\.js\1\)/g, `import($1${to}$1)`],
      [/(\bfrom\s*)(["'`])\/hoist\.js\2/g, `$1$2${to}$2`] ] },
    { file: "/lens-browser.js", base: "lens-browser", mk: (to) => [
      [/(["'`])\/lens-browser\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/tooltip.js",      base: "tooltip",      mk: (to) => [
      [/import\((["'`])\/tooltip\.js\1\)/g, `import($1${to}$1)`] ] },
  ];
  {
    // Every staged surface that can carry a loader: HTML pages, the top-level shell
    // scripts themselves (nav.js imports hoist), worker modules, serendipity. NOT the
    // .src twins, and NOT `a/` — the hashed copies are already-final bytes, which is
    // precisely why each asset must be rewritten before the next one is hashed.
    const stringTargets = [`${OUT}/serendipity/serendipity.js`];
    for (const rel of await readdir(`${OUT}/holding`, { recursive: true })) {
      if (rel.includes(".src.")) continue;
      if (rel.endsWith(".html") || (rel.endsWith(".js") && !rel.startsWith("a/"))) {
        stringTargets.push(`${OUT}/holding/${rel}`);
      }
    }
    let hits = 0;
    for (const a of STRING_ASSETS) {
      const bytes = await readFile(`${OUT}/holding${a.file}`);
      const to = `/a/${a.base}.${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.js`;
      await writeFile(`${OUT}/holding${to}`, bytes);
      hashedFor[a.base] = to;
      const reps = a.mk(to);
      for (const path of stringTargets) {
        let t; try { t = await readFile(path, "utf8"); } catch { continue; }
        let out = t;
        for (const [re, sub] of reps) out = out.replace(re, sub);
        if (out !== t) { await writeFile(path, out); hits++; }
      }
      console.log(`hashed asset (string-loaded): ${a.file} -> ${to} (${bytes.length} bytes)`);
    }
    // Witnesses: each island's loader must now carry the hashed URL, or the enrolment
    // silently did nothing and the deploy must not proceed.
    const idx = await readFile(`${OUT}/holding/index.html`, "utf8");
    const nav = await readFile(`${OUT}/holding/nav.js`, "utf8");
    const lens = await readFile(`${OUT}/holding/lens.js`, "utf8");
    const tip = await readFile(`${OUT}/holding${hashedFor.tooltip}`, "utf8");
    if (!idx.includes(hashedFor.tooltip)) throw new Error("index.html was not repointed to hashed tooltip.js");
    if (!idx.includes(hashedFor.hoist) || !nav.includes(hashedFor.hoist)) throw new Error("a hoist.js loader was not repointed (index.html or nav.js)");
    if (!lens.includes(hashedFor["lens-browser"])) throw new Error("lens.js was not repointed to hashed lens-browser.js");
    // the SERVED tooltip bytes, not the staged source: this is the copy the browser gets,
    // and the one the old ordering left pointing at the unhashed duplicate.
    if (!tip.includes(hashedFor.hoist)) throw new Error(`${hashedFor.tooltip} still imports an unhashed /hoist.js — STRING_ASSETS ordering broke (hoist must be hashed before tooltip)`);
    console.log(`string-loaded islands: rewritten across ${hits} staged files`);
  }

  const reps = [];
  for (const a of ASSETS) {
    const bytes = await readFile(`${OUT}/holding${a.from}`);   // exact served bytes (banner incl.)
    const to = `/a/${a.base}.${hash8(bytes)}.${a.ext}`;
    hashedFor[a.base] = to;
    await writeFile(`${OUT}/holding${to}`, bytes);
    // one regex for quoted "x" AND backslash-escaped \"x\" (writing.js builds its
    // <head> as an escaped string); a second for minify-html's unquoted x.
    const frag = a.frag ? "(#[\\w-]+)" : "";
    const keep = a.frag ? "$2" : "";
    reps.push({ re: new RegExp(`\\b${a.attr}=(\\\\?")${esc(a.from)}${frag}\\1`, "g"), sub: `${a.attr}=$1${to}${keep}$1` });
    reps.push({ re: new RegExp(`\\b${a.attr}=${esc(a.from)}${a.frag ? "(#[\\w-]+)" : ""}(?=[\\s/>])`, "g"), sub: `${a.attr}=${to}${a.frag ? "$1" : ""}` });
    console.log(`hashed asset: ${a.from} -> ${to} (${bytes.length} bytes)`);
  }

  // repoint: every served HTML file + the two worker tag-emitters (chrome.js,
  // writing.js) + the serendipity shell. NOT the top-level shell scripts /
  // luna.css, and NOT the readable *.src.html twin (it must stay byte-identical
  // to holding/index.html for the perf-budget twin check — View Source is the
  // authoring source, which keeps the plain /nav.js the fallback still serves).
  // cal/src rides along: /coffee's SSR templates load the shell too, and were the
  // whole reason the unhashed fallbacks existed. Their nav ref is attribute-shaped so
  // the ordinary reps catch it; the luna refs are ABSOLUTE (cal.aadhar.sh serves the
  // same templates, where a relative /luna.css would 404) and get their own pass below.
  const targets = [`${OUT}/serendipity/serendipity.js`];
  for (const rel of await readdir(`${OUT}/cal/src`).catch(() => [])) {
    if (rel.endsWith(".js")) targets.push(`${OUT}/cal/src/${rel}`);
  }
  for (const rel of await readdir(`${OUT}/holding`, { recursive: true })) {
    if ((rel.endsWith(".html") && !rel.endsWith(".src.html")) ||
        (rel.startsWith("_worker.js/") && rel.endsWith(".js"))) {
      targets.push(`${OUT}/holding/${rel}`);
    }
  }
  let refCount = 0, filesTouched = 0;
  for (const path of targets) {
    let s; try { s = await readFile(path, "utf8"); } catch { continue; }
    let out = s, hits = 0;
    for (const { re, sub } of reps) {
      const m = out.match(re);
      if (m) { hits += m.length; out = out.replace(re, sub); }
    }
    if (hits) { await writeFile(path, out); refCount += hits; filesTouched++; }
  }

  // /coffee's absolute shell refs (https://aadhar.sh/luna.css) — the attr reps above
  // only match leading-slash paths, so the absolute form is rewritten here, scoped to
  // the staged cal modules alone.
  {
    const p = `${OUT}/cal/src/templates.js`;
    let t; try { t = await readFile(p, "utf8"); } catch { t = null; }
    if (t !== null) {
      const out = t.split("https://aadhar.sh/luna.css").join(`https://aadhar.sh${hashedFor.luna}`);
      if (out !== t) await writeFile(p, out);
      const now = await readFile(p, "utf8");
      if (!now.includes(hashedFor.luna)) throw new Error("cal/src/templates.js was not repointed to hashed luna.css");
      if (!now.includes(hashedFor.nav)) throw new Error("cal/src/templates.js was not repointed to hashed nav.js");
      console.log(`cal: /coffee templates repointed to ${hashedFor.luna} + ${hashedFor.nav}`);
    }
  }

  // point the worker's Early-Hints `Link: rel=preload` header at the SAME hashed
  // URLs. shell-assets.js ships a readable-dev fallback (unhashed /nav.js +
  // /luna.css); here we overwrite just its marked SHELL_ASSETS line so the served
  // 103 preloads the exact bytes the rewritten HTML requests.
  {
    const p = `${OUT}/holding/_worker.js/lib/shell-assets.js`;
    const src = await readFile(p, "utf8");
    const line = `export const SHELL_ASSETS = { luna: ${JSON.stringify(hashedFor.luna)}, nav: ${JSON.stringify(hashedFor.nav)} }; // build:shell-assets`;
    const out = src.replace(/^export const SHELL_ASSETS = .*\/\/ build:shell-assets$/m, line);
    if (out === src) throw new Error("shell-assets.js: the `// build:shell-assets` marker line was not found — did the export shape change?");
    await writeFile(p, out);
    console.log(`shell-assets: Early-Hints Link -> ${hashedFor.luna} + ${hashedFor.nav}`);
  }

  // same Early-Hints preload for the STATIC garage/lwe pages: rewrite the
  // angle-bracketed Link targets in the staged _headers to the hashed URLs. only
  // the `</luna.css>` / `</nav.js>` Link forms are touched; the bare `/nav.js` +
  // `/luna.css` PATH-pattern rules (their own cache blocks) have no angle
  // brackets, so they're left alone.
  {
    const p = `${OUT}/holding/_headers`;
    const src = await readFile(p, "utf8");
    const out = src
      .split("</luna.css>").join(`<${hashedFor.luna}>`)
      .split("</nav.js>").join(`<${hashedFor.nav}>`);
    if (out === src) throw new Error("_headers: no `</luna.css>`/`</nav.js>` Link target found to hash — did the Early-Hints rule move?");
    await writeFile(p, out);
    console.log(`_headers: Early-Hints Link rewritten to hashed shell URLs`);
  }

  // tripwires: the rewrite must fire, and each asset's own entry point must load
  // the hashed URL (a moved ref or renamed asset would silently drop the immutable
  // win). Each asset names its WITNESS: the served file that must carry the hashed
  // ref. index.html for the two shell assets it loads; the lens shell for lens.js,
  // which the homepage never loads.
  if (!refCount) throw new Error("hashed-asset rewrite matched zero references — did the src=/href= ref shape change?");
  for (const a of ASSETS) {
    const to = hashedFor[a.base];
    const body = await readFile(`${OUT}/holding/${a.witness}`, "utf8");
    if (!body.includes(to)) throw new Error(`${a.witness} was not repointed to hashed ${a.base} (${to})`);
  }
  console.log(`hashed-asset refs: repointed ${refCount} references across ${filesTouched} files`);
}

// 7) precompress the /a/ shell assets at brotli q11, next to the bytes they encode.
//
// The edge compresses on the fly at about q4, and when a browser offers everything
// it picks zstd — which measured LARGER than Cloudflare's own brotli on this site
// (13,264 vs 12,457 bytes on the homepage, 2026-07-26). Encoding offline at q11 is
// a measured ~19% off the wire for the two render-path assets, and it is free at
// decode: brotli decode time is independent of encode QUALITY, because the decoder
// makes one pass over a stream that is now smaller (0.070ms at q4 vs 0.081ms at q11
// on a 47KB document, in-process, 300 iterations). GREENFIELD.md asked for exactly
// this in July 2026 ("static documents precompress offline at brotli q11") and
// measured the same ~19% tax; wrangler.jsonc deferred it as migration scope rather
// than rejecting it.
//
// Only /a/ is precompressed. Those four files are content-addressed, immutable, and
// on the render path, so they are the whole win in one bounded directory. The static
// garage/lwe HTML is the next candidate and needs its own routing decision.
//
// This is safe to add because it degrades to exactly today's behavior: the worker
// serves a .br twin only when the request actually offers `br` AND the twin exists.
// A skipped build step, or a client without brotli, gets the identity bytes.
{
  const dir = `${OUT}/holding/a`;
  const files = (await readdir(dir)).filter((f) => /\.(js|css|svg)$/.test(f));
  if (!files.length) throw new Error("precompression found no /a/ shell assets — did step 6 stop emitting them?");
  let raw = 0, enc = 0;
  for (const f of files) {
    const bytes = await readFile(`${dir}/${f}`);
    const out = brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        // 24 is the largest window a `Content-Encoding: br` response may use (RFC 7932
        // §4). Large-window brotli reaches 2^30 but is not legal on the wire, so a
        // decoder is entitled to reject it — never raise this.
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    });
    // Refuse to ship a "compressed" twin that isn't smaller. Cheap guard against a
    // future asset type where q11 loses (already-compressed bytes, tiny files).
    if (out.length >= bytes.length) {
      console.log(`precompress: SKIPPED /a/${f} (br ${out.length} >= raw ${bytes.length})`);
      continue;
    }
    await writeFile(`${dir}/${f}.br`, out);

    raw += bytes.length; enc += out.length;
    console.log(`precompressed: /a/${f} ${bytes.length} -> ${out.length} bytes (br q11)`);
  }
  console.log(`precompress: ${(raw / 1024).toFixed(1)}KB -> ${(enc / 1024).toFixed(1)}KB brotli q11 across ${files.length} shell assets`);

  // ── dcz deltas, generated HERE rather than committed ─────────────────────────
  // A returning Chromium visitor that accepted our Use-As-Dictionary offer sends back the
  // SHA-256 of the shell it holds; the worker answers with the diff. Measured on a real
  // luna.css change: 116 bytes against 7,615.
  //
  // This used to be a workstation script with committed artifacts, on the belief that
  // dictionary compression was unreachable from Node. That was true of BROTLI and I wrongly
  // generalized it: node:zlib's zstd DOES take a `dictionary` option. It is also better
  // than shelling out — 116 bytes where the zstd CLI produced 120 — and portable, verified
  // by having the foreign `zstd -d -D` CLI decode Node's bytes byte-exact, skippable prefix
  // and all. That interop check is the one that matters, because the real decoder is a
  // browser, not Node.
  //
  // Consequences worth naming: no zstd CLI in the deploy path, no committed .dcz artifacts,
  // no `npm run shell:deltas` step to forget, and no staleness tripwire needed at all,
  // because a delta is now a pure function of bytes this build just produced.
  //
  // Still committed, and unavoidably so: holding/a-dict/, the DICTIONARY set. A dictionary
  // has to be bytes the BROWSER already holds, which no build can derive from source.
  {
    // HARD CHECK: is the `dictionary` option actually honored by this Node?
    //
    // Node 22 ACCEPTS the option and silently ignores it. That produced a dictionary-less
    // "delta" of 8,197 bytes against luna.css in Workers Builds (plain zstd-19 is ~8,161),
    // which lost to the plain brotli twin, so the guard below discarded it and printed
    // "delta: none needed". The feature shipped as a no-op for a full deploy and the log
    // read like everything was fine. Local Node 26 honored the option, so it worked here
    // and nowhere else.
    //
    // Feature-detect rather than version-sniff: compressing a buffer against ITSELF must
    // collapse to almost nothing if the dictionary is real. Throwing is correct because
    // .node-version pins the runtime, so this firing means the pin was lost, and a silent
    // no-op is exactly the failure this whole page-worth of debugging came from.
    const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
    const withDict = zstdCompressSync(probe, { dictionary: probe, params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    const noDict = zstdCompressSync(probe, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    if (withDict.length >= noDict.length * 0.5) {
      throw new Error(
        `zstd dictionary compression is not honored by ${process.version} ` +
        `(probe: ${withDict.length} bytes with a dictionary vs ${noDict.length} without; expected a collapse). ` +
        `Node 24+ is required — see .node-version. Shell deltas would silently ship as no-ops.`,
      );
    }

    const dictDir = "holding/a-dict";
    const dicts = await readdir(dictDir).catch(() => []);
    const parse = (n) => { const m = n.match(/^(.+)\.([0-9a-f]{8})\.(js|css|svg)$/); return m ? { base: m[1], hash8: m[2], ext: m[3], name: n } : null; };
    const shell = files.map(parse).filter(Boolean);
    const cands = dicts.map(parse).filter(Boolean);
    if (cands.length) await mkdir(`${OUT}/holding/ad`, { recursive: true });
    let n = 0, deltaBytes = 0;
    for (const asset of shell) {
      // Images sit out the dictionary path — see DICTIONARY_TYPES in lib/assets.js. The
      // worker will never answer an svg with a dcz, so building one here would ship a
      // delta nothing can ask for.
      if (asset.ext === "svg") continue;
      const targetBytes = await readFile(`${dir}/${asset.name}`);
      for (const d of cands) {
        if (d.base !== asset.base || d.ext !== asset.ext) continue;
        const dictBytes = await readFile(`${dictDir}/${d.name}`);
        // Identical bytes mean the content-hashed URL did not change, so no client will
        // ever request a new URL for them — a delta here could not be asked for.
        if (dictBytes.equals(targetBytes)) continue;

        const { out, digest } = dczEncode(targetBytes, dictBytes);

        // A delta that lost to the plain q11 twin is worse than no delta: the worker would
        // serve more bytes AND cost the client a dictionary lookup.
        const plainTwin = (await readFile(`${dir}/${asset.name}.br`).catch(() => null))?.length ?? Infinity;
        if (out.length >= plainTwin) {
          console.log(`delta: SKIPPED ${asset.name} vs ${d.hash8} (dcz ${out.length} >= br ${plainTwin})`);
          continue;
        }
        const tag = digest.toString("hex").slice(0, 16);
        await writeFile(`${OUT}/holding/ad/${asset.base}.${asset.hash8}.${tag}.dcz`, out);
        n++; deltaBytes += out.length;
        console.log(`delta: /ad/${asset.base}.${asset.hash8}.${tag}.dcz ${out.length} bytes (vs ${plainTwin} plain br)`);
      }
    }
    // Distinguish the two reasons for zero deltas. "Every candidate matches" is normal and
    // expected. "Candidates exist but none produced a delta" means every pair lost to plain
    // brotli, which is the shape the Node 22 bug wore, so say so loudly.
    const changed = shell.some((a) => cands.some((d) => d.base === a.base && d.ext === a.ext && d.hash8 !== a.hash8));
    if (n) console.log(`delta: ${n} dcz delta(s), ${deltaBytes} bytes total`);
    else if (changed) console.log("delta: WARNING the shell changed but every candidate lost to plain brotli — dictionary compression may not be working");
    else console.log("delta: none needed (every dictionary candidate matches the shipping shell)");
  }

}

// 8) the static garage/lwe pages: brotli q11 twins + dcz deltas.
//
// These are the biggest text payloads on the site (10-17KB on the wire each, 30 of them)
// and they fit dictionary transport BETTER than the hashed shell does. The shell is
// content-addressed, so a changed asset is a new URL. A garage page is mutable at a
// STABLE url under `max-age=0, must-revalidate`, which is the canonical case the RFC was
// written for: the browser revalidates, the bytes moved, and the server answers with the
// diff instead of the document.
//
// Naming differs from /a/ for that same reason. A shell delta can key off the hash in the
// request path; a page cannot, because the path never changes. So a page delta is keyed by
// SLUG plus the dictionary tag alone: /pd/<slug>.<dicttag>.dcz. Only one version of a page
// is current at a time, so slug+dictionary already identifies it uniquely.
{
  const pages = [];
  for (const dir of ["garage", "lwe"]) {
    for (const rel of await readdir(`${OUT}/holding/${dir}`, { recursive: true }).catch(() => [])) {
      if (!rel.endsWith(".html") || rel.endsWith(".src.html")) continue;
      pages.push(`${dir}/${rel}`);
    }
  }
  // slug: the request path with separators folded, so it survives as one filename segment.
  const slugOf = (assetPath) => assetPath.replace(/\.html$/, "").replace(/\//g, "__");

  const dictDir = "holding/p-dict";
  const dicts = await readdir(dictDir).catch(() => []);
  // <slug>.<hash16>.html — the previous shipped bytes for that exact page.
  // Snapshots are stored BROTLI'd. They are only ever build input, never served, and
  // brotli round-trips exactly, so compressing them cuts the committed weight ~75%
  // (1.4MB -> 352KB across 30 pages) with no effect on the dictionary bytes themselves.
  const parseDict = (n) => { const m = n.match(/^(.+)\.([0-9a-f]{16})\.html\.br$/); return m ? { slug: m[1], tag: m[2], name: n } : null; };
  const cands = dicts.map(parseDict).filter(Boolean);
  if (cands.length) await mkdir(`${OUT}/holding/pd`, { recursive: true });

  let brCount = 0, brRaw = 0, brEnc = 0, dCount = 0, dBytes = 0, dPlain = 0;
  for (const page of pages) {
    const bytes = await readFile(`${OUT}/holding/${page}`);
    const br = brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    });
    if (br.length < bytes.length) {
      await writeFile(`${OUT}/holding/${page}.br`, br);
      brCount++; brRaw += bytes.length; brEnc += br.length;
    }

    const slug = slugOf(page);
    for (const d of cands) {
      if (d.slug !== slug) continue;
      // Snapshots are stored brotli'd (build input only, never served, and brotli
      // round-trips exactly), which cuts the committed weight from 1.4MB to 412KB.
      const dictBytes = brotliDecompressSync(await readFile(`${dictDir}/${d.name}`));
      if (dictBytes.equals(bytes)) continue;            // unchanged: nothing to diff
      const { out, digest } = dczEncode(bytes, dictBytes);
      // A delta that lost to the plain twin would cost bytes AND a dictionary lookup.
      if (out.length >= br.length) {
        console.log(`page-delta: SKIPPED ${slug} vs ${d.tag.slice(0, 8)} (dcz ${out.length} >= br ${br.length})`);
        continue;
      }
      await writeFile(`${OUT}/holding/pd/${slug}.${digest.toString("hex").slice(0, 16)}.dcz`, out);
      dCount++; dBytes += out.length; dPlain += br.length;
    }
  }
  console.log(`pages: ${brCount} brotli q11 twins, ${(brRaw / 1024).toFixed(1)}KB -> ${(brEnc / 1024).toFixed(1)}KB`);
  console.log(dCount
    ? `page-delta: ${dCount} dcz delta(s), ${dBytes} bytes against ${dPlain} plain brotli`
    : `page-delta: none (no page changed since its dictionary snapshot)`);
}

console.log(`staged ${OUT}/ - deploy with: wrangler deploy (self-builds via build.command) or npm run deploy`);
