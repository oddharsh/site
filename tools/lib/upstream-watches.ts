// UPSTREAM WATCHES: the fixes this repository is waiting on, each as a probe
// that reads FALSE today and TRUE the day the fix lands.
//
// The canary legs were built to diff a moving target against a fixed pin and
// report a regression. A watch inverts that: it is a control that is expected
// to fail on the pinned toolchain, and the interesting event is the first
// green. Every entry below is an issue this repository filed or commented on,
// with the one-line reproduction from that issue turned into a script that
// prints `{ landed, detail }`. canary-bun.ts runs each one under the PINNED
// bun and under the candidate and reports the rows that disagree; the day a
// canary answers `landed: true` where the pin answers false, the nightly issue
// says which fix arrived and in which build, and the reader has a bun to pin.
//
// A watch that reads landed in BOTH is one to retire: the pin already carries
// the fix, the upstream issue can be closed if it is still open, and the row
// is noise from then on. The reporter says so in the table.
//
// ONE ENTRY WATCHES A PACKAGE RATHER THAN BUN. `oxc-minifier-reaches-swc-parity`
// reads the pinned oxc-minify, which dependabot bumps, so it answers the same
// under pin and canary and can only ever arrive as "landed in both" the first
// night after a bump. For that row, "landed in both" is the finding rather than
// the cue to retire, and its comment says which threads it waits on.
//
// THREE RULES for an entry, because a watch that cannot fail is decoration:
//
//   1. It was measured false on the pinned bun the day it was written, and
//      the measurement is recorded beside it. A probe that reads true on the
//      first run is not watching anything.
//   2. It probes the BEHAVIOUR the issue is about rather than a version
//      string, because bun ships fixes in canaries whose `--version` is the
//      next release and robobun's fix PRs land in any order.
//   3. It prints one JSON line and nothing else, so a probe that crashes reads
//      as `landed: null` (did not run) rather than as either answer. `null`
//      never flips a verdict; a watch is advisory by construction.
//
// Scripts are plain JavaScript for `bun -e`, run in a scratch directory the
// runner creates and removes, so a watch may write files there and nowhere
// else. The two image fixtures are inline: a 2x1 8-bit PNG (black, white)
// and a 1x1 16-bit PNG whose low sample byte an 8-bit decode has to lose.
//
// THE RUNNER IS TIMBRADO'S, since 2026-09-15. This file is the LIST, which is
// this repository's; the probe runner, the row semantics (`null` never moves
// a verdict) and the signature live in github.com/oddharsh/timbrado, the
// tool extracted from these legs, and are re-exported here so the legs keep
// one import path. A change to how a watch is read is a change there.
//
// THE RUNNER IS A RUST BINARY since timbrado 0.2.0 (2026-09-20 here), built
// on demand from the installed package the way zenc is. Two facts decide the
// shape of `ensureTimbradoEngine` below. bun lays the git dependency out
// under `node_modules/.bun/timbrado@github+oddharsh+timbrado+<sha>/`, so a pin
// bump is a FRESH directory with no `target/` in it and "build when missing"
// is sound; cargo's own fingerprint check makes the every-run form cost ~0.2s
// when nothing moved, so it runs every time like zenc's guard does. And
// timbrado's `runWatch` answers a MISSING engine as `landed: null` ("did not
// run"), which by rule 3 above never moves a verdict: a leg reading eight
// unmeasured rows would print GREEN over them. So the `runWatch` this module
// exports is a wrapper that builds first and THROWS when it cannot, and
// canary-bun.ts turns that throw into exit 2 before it downloads anything.
// `TIMBRADO_BIN` (an absolute path to a built engine) skips the build, which
// is timbrado's own override and the one a runner without cargo would use.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Reading, runWatch as measureWatch, type Watch } from "timbrado/watch";

import { asNumber, asRecord, asText } from "../../src/worker/lib/parse.ts";
import { OXC_MINIFY_OPTIONS } from "./oxc-minify-options.ts";

export type { Watch, WatchResult } from "timbrado/watch";
export { checkWatch, watchMoved, watchRow, watchSignature } from "timbrado/watch";

/** The installed timbrado package, wherever bun laid it out (a symlink into node_modules/.bun). */
export const TIMBRADO_PACKAGE = dirname(createRequire(import.meta.url).resolve("timbrado/package.json"));
/** Where `cargo build --release` in that package puts the engine, and where timbrado's own loader looks. */
export const TIMBRADO_ENGINE = join(TIMBRADO_PACKAGE, "target", "release", "timbrado");

let built: string | null = null;

/**
 * Makes sure timbrado's Rust engine exists and returns its path. Honours
 * `TIMBRADO_BIN`; otherwise builds it in place from the installed package.
 * Throws rather than degrading, because the degraded reading is `null`.
 */
export function ensureTimbradoEngine(): string {
  const named = process.env.TIMBRADO_BIN;
  if (named !== undefined) {
    if (!isAbsolute(named) || !existsSync(named))
      throw new Error(`TIMBRADO_BIN names ${JSON.stringify(named)}, which is not an absolute path to a built timbrado engine`);
    return named;
  }
  if (built) return built;
  const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(TIMBRADO_PACKAGE, "Cargo.toml")], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (build.error)
    throw new Error(`timbrado's Rust engine needs cargo, which did not run (${build.error.message}); install Rust or set TIMBRADO_BIN to a built engine`);
  if (build.status !== 0) throw new Error(`cargo build of timbrado's Rust engine exited ${build.status}`);
  if (!existsSync(TIMBRADO_ENGINE)) throw new Error(`cargo exited 0 and ${TIMBRADO_ENGINE} is still missing`);
  return (built = TIMBRADO_ENGINE);
}

/** timbrado's `runWatch`, behind the engine guard: a missing engine throws here instead of reading `null`. */
export function runWatch(exe: string, watch: Watch, timeoutMs?: number): Reading {
  ensureTimbradoEngine();
  return measureWatch(exe, watch, timeoutMs);
}

const PNG_2X1_8BIT = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYGD4//8/AAYBAv4CsjmuAAAAAElFTkSuQmCC";
const PNG_1X1_16BIT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAIAAADA54+dAAAADElEQVR4nGNoYARBAAYQAYRMvznsAAAAAElFTkSuQmCC";

const out = (expr: string) => `console.log(JSON.stringify(${expr}));`;
const firstLine = `(e) => String(e && e.message || e).split("\\n")[0].slice(0, 90)`;

// The runner spawns `bun -e` in a scratch directory, where a bare specifier
// resolves nothing, so the one watch that needs this repository's pinned
// oxc-minify and its frozen fixtures is handed both by ABSOLUTE path, computed
// here where the list module knows where it lives.
const REPO = fileURLToPath(new URL("../../", import.meta.url));

export const BUN_WATCHES: Watch[] = [
  {
    name: "bun-image-rejects-out-of-range-quality",
    issue: "https://github.com/oven-sh/bun/issues/40490",
    landed: "Bun.Image throws on `quality: 999` instead of encoding with it (robobun's fix is oven-sh/bun#40520)",
    measured: "2026-09-15, bun 1.4.2: accepted, wrote 652 B",
    runtime: "bun",
    script: `
      const png = Buffer.from("${PNG_2X1_8BIT}", "base64");
      const first = ${firstLine};
      let landed = false, detail;
      try { const n = (await new Bun.Image(png).jpeg({ quality: 999 }).bytes()).length; detail = "quality: 999 accepted, " + n + " B written"; }
      catch (e) { landed = true; detail = "quality: 999 throws: " + first(e); }
      ${out("{ landed, detail }")}
    `,
  },
  {
    name: "bun-image-rejects-wrong-option-types",
    issue: "https://github.com/oven-sh/bun/issues/40490",
    landed: 'Bun.Image throws on `quality: "84"` (a string) instead of falling back to the default (robobun\'s fix is oven-sh/bun#40491)',
    measured: "2026-09-15, bun 1.4.2: accepted, wrote 647 B at the q80 default",
    runtime: "bun",
    script: `
      const png = Buffer.from("${PNG_2X1_8BIT}", "base64");
      const first = ${firstLine};
      let landed = false, detail;
      try { const n = (await new Bun.Image(png).jpeg({ quality: "84" }).bytes()).length; detail = "quality: \\"84\\" accepted, " + n + " B written"; }
      catch (e) { landed = true; detail = "quality: \\"84\\" throws: " + first(e); }
      ${out("{ landed, detail }")}
    `,
  },
  {
    name: "bun-image-linear-light-resize",
    issue: "https://github.com/oven-sh/bun/issues/40510",
    landed: '`resize(w, h, { colorspace: "linear" })` produces different bytes from the default, so the opt-in exists (robobun\'s fix is oven-sh/bun#40512)',
    measured: "2026-09-15, bun 1.4.2: byte-identical to the default, the option is ignored",
    runtime: "bun",
    script: `
      const png = Buffer.from("${PNG_2X1_8BIT}", "base64");
      const a = Buffer.from(await new Bun.Image(png).resize(1, 1).png().bytes());
      const b = Buffer.from(await new Bun.Image(png).resize(1, 1, { colorspace: "linear" }).png().bytes());
      const landed = Buffer.compare(a, b) !== 0;
      ${out('{ landed, detail: landed ? "linear resize differs from default (" + a.length + " vs " + b.length + " B)" : "colorspace: \\"linear\\" is ignored, " + a.length + " B either way" }')}
    `,
  },
  {
    name: "bun-image-keeps-16-bit-samples",
    issue: "https://github.com/oven-sh/bun/issues/30462",
    landed:
      "a 16-bit PNG round-trips through Bun.Image at 16 bits (IHDR depth 16), which is the depth the HIF decode would need before it can replace sips in the photo ingest",
    measured: "2026-09-15, bun 1.4.2: IHDR depth 8 on output, the 16-bit source is collapsed on decode",
    runtime: "bun",
    script: `
      const png = Buffer.from("${PNG_1X1_16BIT}", "base64");
      const o = await new Bun.Image(png).png().bytes();
      const depth = o[24];
      ${out('{ landed: depth === 16, detail: "16-bit PNG in, IHDR depth " + depth + " out" }')}
    `,
  },
  {
    name: "fetch-honours-dispatcher",
    issue: "https://github.com/oven-sh/bun/issues/39247",
    landed:
      "`fetch(url, { dispatcher })` calls the dispatcher's `dispatch()` under bun, which is what miniflare's `dispatchFetch()` relies on and the reason wrangler's harness hangs under bun (robobun's fix is oven-sh/bun#39250; this is the issue that decides whether node can leave `engines`)",
    measured: "2026-09-15, bun 1.4.2: dispatch() never called, the fetch went to the network and failed to connect",
    runtime: "bun",
    script: `
      let called = 0;
      const dispatcher = { dispatch(opts, h) { called++; if (h && typeof h.onError === "function") h.onError(new Error("watch")); return true; } };
      let err = "";
      try { await fetch("http://127.0.0.1:1/", { dispatcher }); } catch (e) { err = String(e && e.message || e).split("\\n")[0].slice(0, 60); }
      ${out('{ landed: called > 0, detail: called > 0 ? "dispatch() called " + called + "x" : "dispatch() never called; fetch went to the network: " + err }')}
    `,
  },
  {
    name: "css-minifier-knows-the-seven-pseudo-elements",
    issue: "https://github.com/oven-sh/bun/issues/41120",
    landed:
      "`Bun.build({ minify: true })` on CSS naming ::details-content, ::picker(), ::checkmark, ::picker-icon, ::scroll-marker, ::scroll-marker-group and ::scroll-button() logs no `Invalid selector` warning (oven-sh/bun#41122 shipped four of the seven in 1.4.2)",
    measured: "2026-09-15, bun 1.4.2: three warnings, the first on ::scroll-marker",
    runtime: "bun",
    script: `
      await Bun.write("w.css", "a::details-content{c:d}b::picker(select){c:d}c::checkmark{c:d}d::picker-icon{c:d}e::scroll-marker{c:d}f::scroll-marker-group{c:d}g::scroll-button(*){c:d}");
      const r = await Bun.build({ entrypoints: ["w.css"], minify: true, outdir: "out" });
      const warned = r.logs.map((l) => String(l)).filter((l) => /Invalid selector/i.test(l));
      ${out('{ landed: warned.length === 0, detail: warned.length ? warned.length + " warning(s): " + warned[0].replace(/^BuildMessage: /, "").slice(0, 90) : "no Invalid selector warning on the seven" }')}
    `,
  },
  {
    name: "css-minifier-lowercases-target-current",
    issue: "https://github.com/oven-sh/bun/issues/42480",
    landed:
      "`:TARGET-CURRENT` is emitted lowercased like `:TARGET-WITHIN`, so two spellings of one selector merge to one rule (robobun adopted the fix as oven-sh/bun#42484, from oven-sh/bun#41139)",
    measured: "2026-09-15, bun 1.4.2: `:TARGET-CURRENT` emitted verbatim beside a lowercased `:target-within`",
    runtime: "bun",
    script: `
      await Bun.write("w.css", "x:TARGET-CURRENT{c:d}y:TARGET-WITHIN{c:d}");
      await Bun.build({ entrypoints: ["w.css"], minify: true, outdir: "out" });
      const css = await Bun.file("out/w.css").text();
      const landed = css.includes(":target-current") && !css.includes(":TARGET-CURRENT");
      ${out('{ landed, detail: "emitted " + JSON.stringify(css.trim().slice(0, 60)) }')}
    `,
  },
  {
    // THIS ONE IS NOT A BUN FIX, and it moves through a different door. The
    // probe reads oxc-minify, which is pinned in package.json and bumped by
    // dependabot's minifiers group, so under the bun leg it answers the SAME
    // under pin and canary every night and never reads `moved`. What it does
    // is turn "did that oxc-minify bump reach SWC" into a row the first
    // nightly after the merge answers: the day it reads `landed` in both
    // columns is the day oxc's compressor caught up, and the note beside it
    // says so. The comparison this waits on was measured 2026-09-15: oxc
    // trails SWC 1.16.2 by 0.84% brotli across the 19 client assets, and the
    // whole of it is three passes (guard-clause inversion into nested ifs,
    // hoisting every `var` of a scope into one declaration, and inlining or
    // reordering inner function declarations). The nearest open threads are
    // oxc-project/oxc#14310 and #14311; no single issue asks for parity, so
    // the thread named here is the repository.
    //
    // The fixtures are FROZEN copies of two client files (quiz.js and
    // lens-wire.js as of #823), because a live file drifts and takes the
    // constant with it. SWC's number is what `@swc/core` 1.16.2 produces on
    // those exact bytes with `compress: { ecma: 2022, toplevel: false },
    // mangle: { toplevel: false }`, brotli q11, and bun's and node's brotli
    // agree on it to the byte. Re-derive it with the scratch bench recorded
    // in the wire-byte sweep note before changing either fixture.
    name: "oxc-minifier-reaches-swc-parity",
    issue: "https://github.com/oxc-project/oxc",
    landed:
      "oxc-minify at the pin, run with the build's exact options over the two frozen fixtures, produces no more brotli q11 bytes than SWC 1.16.2 did on the same bytes (5,786 B)",
    measured:
      "2026-10-05, oxc-minify 0.151.0: 5,843 B against SWC's 5,786 B, +57 B, the same total 0.150.0 gave on 2026-09-15 (then quiz.js 2,974 vs 2,932; lens-wire.js 2,869 vs 2,854)",
    runtime: "bun",
    script: `
      const { minifySync } = require(${JSON.stringify(REPO + "node_modules/oxc-minify/index.js")});
      const { brotliCompressSync, constants } = require("node:zlib");
      const { readFileSync } = require("node:fs");
      const OPTS = ${JSON.stringify(OXC_MINIFY_OPTIONS)};
      const SWC = 5786;
      const br = (s) => brotliCompressSync(Buffer.from(s), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
      let oxc = 0;
      for (const f of ["quiz.js", "lens-wire.js"]) {
        const path = ${JSON.stringify(REPO + "tools/fixtures/minify-parity/")} + f;
        const r = minifySync(f, readFileSync(path, "utf8"), OPTS);
        if (r.errors.length) throw new Error(f + ": " + r.errors[0].message);
        oxc += br(r.code);
      }
      const gap = oxc - SWC;
      ${out('{ landed: gap <= 0, detail: "oxc " + oxc + " B vs SWC " + SWC + " B brotli q11 on the frozen fixtures (" + (gap > 0 ? "+" : "") + gap + " B)" }')}
    `,
  },
];

// VERDICT WATCHES, since 2026-10-29: the same probe pointed at this
// repository's own "measured, not worth it" decisions. A decline is true on
// the day it is written and nothing reopens it when bun moves, so each entry
// below probes the PREMISE a decline rests on and reads false while that
// premise holds. The three rules apply unchanged. Each one names the memory
// file that records the decline (the owner's Claude memory for this
// repository, ~/.claude/projects/-Users-aadharsh-noodling-site/memory/), and
// the export appends it to `landed`, so a moved row in the nightly issue says
// which verdict to re-measure. A verdict watch reading landed in both columns
// is the same cue as a moved one: the premise broke, so re-measure before
// retiring the row.
//
// All four premises move with BUN, which is why they ride the bun leg: the
// canary answers first, so a flip arrives as `changed` a pin bump early
// rather than as a silent "landed in both" after one. Declines whose premise
// is a browser's paint, a CI timing, or a judgement call stay out; the PR that
// added this list names each one and why.
//
// `issue` is the upstream thread when one asks for what reopens the decline,
// and otherwise the repository, as with the oxc row above.
const dependency = (name: string) => createRequire(import.meta.url).resolve(name);
const brotliQ11 = `(s) => require("node:zlib").brotliCompressSync(Buffer.from(s), { params: { [require("node:zlib").constants.BROTLI_PARAM_QUALITY]: 11 } }).length`;

export type VerdictWatch = Watch & { memory: string };

export const VERDICT_WATCHES: VerdictWatch[] = (
  [
    {
      // Both sides minify the frozen parity fixtures in the same run, so
      // neither number is a constant that can go stale; only bun moves
      // between the pin and the canary, because oxc-minify is a package pin.
      name: "verdict-bun-js-minify-trails-oxc",
      memory: "bun-minifier-not-a-swap.md",
      issue: "https://github.com/oven-sh/bun",
      landed:
        "`Bun.build({ minify: true })` produces no more brotli q11 bytes than the pinned oxc-minify, with the build's options, on the two frozen parity fixtures",
      measured:
        "2026-10-29, bun 1.4.4-canary.20261028.1+11c3671 and oxc-minify 0.156.0: bun 5927 B against oxc 5843 B, +84 B (+1.4%); the memory's nav.js reading on bun 1.4.2 was +0.86%",
      runtime: "bun",
      script: `
        const { minifySync } = require(${JSON.stringify(dependency("oxc-minify"))});
        const { readFileSync, writeFileSync } = require("node:fs");
        const br = ${brotliQ11};
        const OPTS = ${JSON.stringify(OXC_MINIFY_OPTIONS)};
        let oxc = 0, bun = 0;
        for (const f of ["quiz.js", "lens-wire.js"]) {
          const src = readFileSync(${JSON.stringify(REPO + "tools/fixtures/minify-parity/")} + f, "utf8");
          const o = minifySync(f, src, OPTS);
          if (o.errors.length) throw new Error(f + ": " + o.errors[0].message);
          oxc += br(o.code);
          writeFileSync(f, src);
          const r = await Bun.build({ entrypoints: ["./" + f], minify: true, external: ["*"], outdir: "out" });
          if (!r.success) throw new Error(f + ": " + String(r.logs[0]));
          bun += br(await r.outputs[0].text());
        }
        const gap = bun - oxc;
        ${out('{ landed: gap <= 0, detail: "bun " + bun + " B vs oxc " + oxc + " B brotli q11 on the frozen fixtures (" + (gap > 0 ? "+" : "") + gap + " B)" }')}
      `,
    },
    {
      // The live luna.css, read by both sides in one run, so the file can
      // drift without moving a constant. The browserslist gives bun its best
      // chance: the memory found it changes nothing, and the day it does,
      // bun stops emitting the fallbacks and the gap closes. oven-sh/bun#40369
      // (newer default targets) would close it here unaided; #40368 asks for
      // a `cssTarget` option, and if that ships, pass it in this probe too.
      name: "verdict-bun-css-ignores-browser-targets",
      memory: "bun-minifier-not-a-swap.md",
      issue: "https://github.com/oven-sh/bun/issues/40368",
      landed:
        "`Bun.build({ minify: true })` on luna.css, with a `last 1 chrome version` browserslist beside it, produces no more brotli q11 bytes than lightningcss with no targets, the way build.ts calls it",
      measured:
        "2026-10-29, bun 1.4.4-canary.20261028.1+11c3671 and lightningcss 1.33.0: bun 12540 B against 9843 B, +2697 B (+27%); bun's output carries 137 color(display-p3) and 137 lab() fallbacks and lightningcss's carries none",
      runtime: "bun",
      script: `
        const { transform } = require(${JSON.stringify(dependency("lightningcss"))});
        const { readFileSync, writeFileSync } = require("node:fs");
        const br = ${brotliQ11};
        const src = readFileSync(${JSON.stringify(REPO + "src/styles/luna.css")});
        const lightning = br(transform({ filename: "luna.css", code: src, minify: true }).code);
        writeFileSync("luna.css", src);
        writeFileSync("package.json", JSON.stringify({ browserslist: ["last 1 chrome version"] }));
        const r = await Bun.build({ entrypoints: ["./luna.css"], minify: true, outdir: "out" });
        if (!r.success) throw new Error(String(r.logs[0]));
        const bun = br(await r.outputs[0].text());
        const gap = bun - lightning;
        ${out('{ landed: gap <= 0, detail: "luna.css: bun " + bun + " B vs lightningcss " + lightning + " B brotli q11 (" + (gap > 0 ? "+" : "") + gap + " B)" }')}
      `,
    },
    {
      name: "verdict-bun-html-minify-is-a-no-op",
      memory: "bun-minifier-not-a-swap.md",
      issue: "https://github.com/oven-sh/bun",
      landed: "`Bun.build({ minify: true })` on an HTML entry drops its comments and comes out smaller than it went in",
      measured:
        "2026-10-29, bun 1.4.4-canary.20261028.1+11c3671: 192 B in, 261 B out, both comments kept, plus an injected <script> for an empty chunk, as on 1.4.2",
      runtime: "bun",
      script: `
        const page = "<!doctype html>\\n<html lang=\\"en\\">\\n  <head>\\n    <!-- one -->\\n    <title>watch</title>\\n  </head>\\n  <body>\\n    <main>\\n      <p>   one   two   </p>\\n      <!-- two -->\\n    </main>\\n  </body>\\n</html>\\n";
        await Bun.write("w.html", page);
        const r = await Bun.build({ entrypoints: ["./w.html"], minify: true, outdir: "out" });
        if (!r.success) throw new Error(String(r.logs[0]));
        const html = await Bun.file("out/w.html").text();
        const kept = (html.match(/<!--/g) || []).length;
        ${out('{ landed: kept === 0 && html.length < page.length, detail: page.length + " B in, " + html.length + " B out, " + kept + " of 2 comments kept" }')}
      `,
    },
    {
      // The checker ships inside bun since 1.4.3, so a canary that moves its
      // TypeScript lib moves this row. Two controls ride in the probe: a line
      // the lib has typed since ES2024 must check clean, so "landed" is
      // reachable, and a planted unknown method must error, so a checker that
      // ran nothing reads as "did not run" rather than as either answer. Node
      // lacking Math.sumPrecise is the decline's other half, and this leg
      // cannot see it.
      name: "verdict-checker-lacks-es2026-types",
      memory: "es2026-adoption-audit.md",
      issue: "https://github.com/microsoft/typescript-go",
      landed: '`bun check` with `lib: ["esnext"]` types Math.sumPrecise, Iterator.concat and JSON.rawJSON',
      measured: "2026-10-29, bun 1.4.4-canary.20261028.1+11c3671: all three draw TS2339; Array.fromAsync checks clean and the planted Math.notAMethod() errors",
      runtime: "bun",
      script: `
        const { spawnSync } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        writeFileSync("tsconfig.json", JSON.stringify({ compilerOptions: { lib: ["esnext"], target: "esnext", module: "esnext", strict: true, noEmit: true, types: [] }, files: ["w.ts"] }));
        const lines = ["Math.sumPrecise([1, 2])", "Iterator.concat([1].values())", 'JSON.rawJSON("1")', "Array.fromAsync([1])", "Math.notAMethod()"];
        writeFileSync("w.ts", lines.map((l, i) => "export const v" + i + " = " + l + ";").join("\\n") + "\\n");
        const r = spawnSync(process.execPath, ["check", "-p", "tsconfig.json", "--no-pretty"], { encoding: "utf8" });
        const said = (r.stdout || "") + (r.stderr || "");
        const errs = (n) => said.split("\\n").some((l) => l.startsWith("w.ts(" + n + ","));
        if (!errs(5)) throw new Error("the planted Math.notAMethod() drew no error, so the checker did not run: " + said.trim().split("\\n")[0]);
        if (errs(4)) throw new Error("Array.fromAsync drew an error, so the lib is not esnext: " + said.trim().split("\\n")[0]);
        const missing = ["Math.sumPrecise", "Iterator.concat", "JSON.rawJSON"].filter((_, i) => errs(i + 1));
        ${out('{ landed: missing.length === 0, detail: missing.length ? "bun check lacks " + missing.join(", ") : "bun check types all three" }')}
      `,
    },
  ] satisfies VerdictWatch[]
).map((w) => ({ ...w, landed: `${w.landed}; that breaks the premise of the declined verdict in memory ${w.memory}, so re-measure it` }));

/**
 * The wrangler leg's watches. These need a tree and a wrangler entry file
 * rather than a bun executable, so canary-wrangler.ts holds the runners and
 * this is the record: the name that goes in the signature, the thread each
 * one waits on, and the reading on the day it was written.
 */
export const WRANGLER_WATCHES: Pick<Watch, "name" | "issue" | "landed" | "measured">[] = [
  {
    name: "workerd-honours-zstd-dictionary",
    issue: "https://github.com/cloudflare/workerd/pull/7106",
    landed:
      "the workerd this wrangler ships compresses SMALLER with the right zstd dictionary than with none (tools/workerd-zstd-probe.ts), which is what a runtime dcz tier for the pages build.ts cannot precompress would need; cloudflare/workerd#7106 is this repository's fix for cloudflare/workerd#6967",
    measured: "2026-09-15, workerd 1.20260911.1 via wrangler 982b806: 73 none / 73 good / 73 wrong, the option is accepted and ignored",
  },
  // RETIRED 2026-09-26: `wrangler-types-accepts-x-new-config`. It watched the
  // COMMAND, and what it waited for was the NEED, an Env for cf-garage that
  // follows cloudflare.config.ts. workers-sdk#15778 met the need through another
  // door: `wrangler build --x-new-config --x-cf-build-output` writes
  // cf-garage/.cloudflare/types/index.d.ts, and tools/gen-runtime-types.ts runs
  // it before every typecheck. `types --x-new-config` still exits 1 on the pin
  // (3572193, "Unknown arguments"), so the watch would have gone on reading
  // false while the thing it stood for already shipped. The build door is a
  // GATE now (typecheck fails without its file), which is the stronger form.
  // RETIRED 2026-10-11: `vitest-plugin-accepts-vitest-5`. It held the revisit
  // for Vitest in the Worker suite: #703 took the pool out, and on 2026-09-22
  // the owner kept the harness test in its place until the plugin could ride the
  // SAME workers-sdk commit as the wrangler pin. workers-sdk#16132 widened the
  // peer range, and the pin has carried it since bd7aa67 (#1244). Re-read on
  // the pin c09832d: `^4.1.0 || ^5.0.0`. The control, e3d1867 from before
  // #16132, still reads `^4.1.0`. What landed is a decision rather than a fix:
  // whether the Worker suite goes back to Vitest is the owner's call.
  {
    // Not a fix this repository filed. It watches a vendor switch that already
    // flipped once without notice: cloudflare/workerd#6907 exposed Temporal in
    // production with `Temporal.Now` stuck at epoch 0, and every `typeof
    // Temporal` guard in a Worker changed paths that week. The CLOCK is part of
    // "landed", so a rerun of that build reads not-yet rather than landed.
    name: "workerd-exposes-temporal",
    issue: "https://github.com/cloudflare/workerd/issues/6907",
    landed:
      "the workerd this wrangler ships exposes a Temporal under production's compatibility date and flags, and `Temporal.Now.instant()` agrees with Date.now() within a minute (tools/workerd-temporal-probe.ts); until then Worker code here uses Date and the client islands keep their typeof guard",
    measured:
      "2026-09-23, workerd 1.20260921.1 via wrangler a1f05a3 at compatibility_date 2026-06-01: Temporal absent; V8's harmony_temporal is compiled in and no compat flag enables it",
  },
  // RETIRED 2026-10-05: `new-config-dev-boots-auxiliary-workers`. Like the
  // types watch above, it watched one DOOR (`wrangler dev --x-new-config -c
  // counter/wrangler.jsonc`, refused since 4.146.0) for a NEED, TS-native dev
  // with COUNTER bound. workers-sdk#16002 was declined on 2026-10-02 in favour
  // of `cf`, whose dev delegate refuses -c too, so the door was never going to
  // open. The need was met through the dev registry instead: Counter in its own
  // `wrangler dev` process and the site under `cf dev` from config/dev/, on one
  // registry directory, read COUNTER [connected] and /hit?peek=1 digits.
  // tools/dev.ts is that door, so `bun run dev` reads config/dev/ natively and
  // the projection no longer runs on every dev start.
];

/**
 * Reads tools/workerd-temporal-probe.ts's one JSON line. Landed means present
 * AND sane: a Temporal whose clock is more than a minute off Date.now() is the
 * #6907 failure, and reading it as landed would announce the one build this
 * watch exists to warn about. A line that does not parse is `null`, which by
 * rule 3 moves nothing.
 */
export function interpretTemporalProbe(stdout: unknown): { landed: boolean | null; detail: string } {
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "");
  } catch {
    /* left null on purpose */
  }
  const parsed = asRecord(raw);
  if (!parsed || (parsed.present !== true && parsed.present !== false)) return { landed: null, detail: "probe did not run" };
  const date = asText(parsed.date);
  const at = date ? ` at ${date}` : "";
  if (parsed.present === false) return { landed: false, detail: `Temporal absent${at}` };
  const skew = asNumber(parsed.skewMs);
  if (skew === null) return { landed: false, detail: `Temporal present${at} but Temporal.Now threw` };
  const sane = Math.abs(skew) <= 60_000;
  return { landed: sane, detail: `Temporal present${at}, clock ${sane ? "agrees" : "is off"} by ${skew} ms` };
}
