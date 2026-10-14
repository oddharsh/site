// UPSTREAM WATCHES: the fixes this repository is waiting on, each as a probe
// that reads FALSE today and TRUE the day the fix lands.

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

export const TIMBRADO_PACKAGE = dirname(createRequire(import.meta.url).resolve("timbrado/package.json"));
export const TIMBRADO_ENGINE = join(TIMBRADO_PACKAGE, "target", "release", "timbrado");

let built: string | null = null;

export function ensureTimbradoEngine(): string {
  const named = process.env.TIMBRADO_BIN;
  if (named !== undefined) {
    if (!isAbsolute(named) || !existsSync(named)) throw new Error(`TIMBRADO_BIN names ${JSON.stringify(named)}, which is not an absolute path to a built timbrado engine`);
    return named;
  }
  if (built) return built;
  const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(TIMBRADO_PACKAGE, "Cargo.toml")], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (build.error) throw new Error(`timbrado's Rust engine needs cargo, which did not run (${build.error.message}); install Rust or set TIMBRADO_BIN to a built engine`);
  if (build.status !== 0) throw new Error(`cargo build of timbrado's Rust engine exited ${build.status}`);
  if (!existsSync(TIMBRADO_ENGINE)) throw new Error(`cargo exited 0 and ${TIMBRADO_ENGINE} is still missing`);
  return (built = TIMBRADO_ENGINE);
}

export function runWatch(exe: string, watch: Watch, timeoutMs?: number): Reading {
  ensureTimbradoEngine();
  return measureWatch(exe, watch, timeoutMs);
}

const PNG_2X1_8BIT = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYGD4//8/AAYBAv4CsjmuAAAAAElFTkSuQmCC";
const PNG_1X1_16BIT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAIAAADA54+dAAAADElEQVR4nGNoYARBAAYQAYRMvznsAAAAAElFTkSuQmCC";

const out = (expr: string) => `console.log(JSON.stringify(${expr}));`;
const firstLine = `(e) => String(e && e.message || e).split("\\n")[0].slice(0, 90)`;

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
    landed: "Bun.Image throws on `quality: \"84\"` (a string) instead of falling back to the default (robobun's fix is oven-sh/bun#40491)",
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
    landed: "`resize(w, h, { colorspace: \"linear\" })` produces different bytes from the default, so the opt-in exists (robobun's fix is oven-sh/bun#40512)",
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
    landed: "a 16-bit PNG round-trips through Bun.Image at 16 bits (IHDR depth 16), which is the depth the HIF decode would need before it can replace sips in the photo ingest",
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
    landed: "`fetch(url, { dispatcher })` calls the dispatcher's `dispatch()` under bun, which is what miniflare's `dispatchFetch()` relies on and the reason wrangler's harness hangs under bun (robobun's fix is oven-sh/bun#39250; this is the issue that decides whether node can leave `engines`)",
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
    landed: "`Bun.build({ minify: true })` on CSS naming ::details-content, ::picker(), ::checkmark, ::picker-icon, ::scroll-marker, ::scroll-marker-group and ::scroll-button() logs no `Invalid selector` warning (oven-sh/bun#41122 shipped four of the seven in 1.4.2)",
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
    landed: "`:TARGET-CURRENT` is emitted lowercased like `:TARGET-WITHIN`, so two spellings of one selector merge to one rule (robobun adopted the fix as oven-sh/bun#42484, from oven-sh/bun#41139)",
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
    name: "oxc-minifier-reaches-swc-parity",
    issue: "https://github.com/oxc-project/oxc",
    landed: "oxc-minify at the pin, run with the build's exact options over the two frozen fixtures, produces no more brotli q11 bytes than SWC 1.16.2 did on the same bytes (5,786 B)",
    measured: "2026-10-05, oxc-minify 0.151.0: 5,843 B against SWC's 5,786 B, +57 B, the same total 0.150.0 gave on 2026-09-15 (then quiz.js 2,974 vs 2,932; lens-wire.js 2,869 vs 2,854)",
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

export const WRANGLER_WATCHES: Pick<Watch, "name" | "issue" | "landed" | "measured">[] = [
  {
    name: "workerd-honours-zstd-dictionary",
    issue: "https://github.com/cloudflare/workerd/pull/7106",
    landed: "the workerd this wrangler ships compresses SMALLER with the right zstd dictionary than with none (tools/workerd-zstd-probe.ts), which is what a runtime dcz tier for the pages build.ts cannot precompress would need; cloudflare/workerd#7106 is this repository's fix for cloudflare/workerd#6967",
    measured: "2026-09-15, workerd 1.20260911.1 via wrangler 982b806: 73 none / 73 good / 73 wrong, the option is accepted and ignored",
  },
  {
    name: "workerd-exposes-temporal",
    issue: "https://github.com/cloudflare/workerd/issues/6907",
    landed: "the workerd this wrangler ships exposes a Temporal under production's compatibility date and flags, and `Temporal.Now.instant()` agrees with Date.now() within a minute (tools/workerd-temporal-probe.ts); until then Worker code here uses Date and the client islands keep their typeof guard",
    measured: "2026-09-23, workerd 1.20260921.1 via wrangler a1f05a3 at compatibility_date 2026-06-01: Temporal absent; V8's harmony_temporal is compiled in and no compat flag enables it",
  },
];

export function interpretTemporalProbe(stdout: unknown): { landed: boolean | null; detail: string } {
  let raw: unknown = null;
  try { raw = JSON.parse(String(stdout).trim().split("\n").at(-1) ?? ""); } catch {}
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
