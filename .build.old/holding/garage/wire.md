---
title: "aadhar.sh/garage/bytes on the wire"
description: "The site's first build step, and the brotli rabbit hole that led there: where Cloudflare actually compresses (edge quality vs q11), the four paths to q11 that all lost, deploy-time Oxc and Lightning CSS minification with readable-source twins, the knobs that stay conservative, and the Cache API layer that finally made s-maxage true. Real numbers, live probes."
path: "/garage/wire"
section: "garage"
kind: "content"
updated: "2026-07-23"
source: "https://aadhar.sh/garage/wire"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Bytes on the wire

This site was no-build on principle: every page inline, every byte committed the way it ships. This is the story of the first build step that earned its place anyway, the brotli rabbit hole that led there, the Oxc and Lightning CSS knobs that survived contact with the real site, and the cache layer that finally made a header the site had been sending for months actually do something. Every number below was measured on this site, most of them twice.

## Where compression actually happens

The naive model says "Cloudflare serves brotli, so the bytes are as small as brotli gets." The real model has tiers. Brotli has quality levels 0 to 11: level 11 is the slow, offline, squeeze-everything setting, and no CDN runs it on the fly, because compressing at q11 costs more time than it saves. Cloudflare's edge compresses dynamic and pass-through responses at roughly **gzip quality**. Measured on the homepage: the edge served `31,360` bytes as brotli and `31,188` as gzip, nearly identical. A local brotli q11 of the same document: `25,099`. That gap, roughly 12 to 16% on every text asset, is the room between what the edge does in microseconds and what q11 does offline.

The lesson that reframed the whole exercise: **on this stack you do not choose your compressor, you choose your bytes.** The edge compresses everything at its own fixed quality. The only lever the origin really owns is how many bytes go INTO the compressor.

## Four roads to q11, all closed

- **Native brotli in the Worker.** There is none. Workers' `CompressionStream` speaks gzip and deflate only. Dead end by platform design.
- **wasm brotli at q11, per request.** The homepage re-renders per visit (random photo grid + live counter), so it would compress on the hot path: multi-ms of CPU per request plus a wasm blob in the bundle to save ~6KB. Rejected on arithmetic.
- **Worker-side gzip level 9.** Measured a local gzip-9 of the homepage at `31,204` bytes vs the edge's `31,207`. Three bytes. The edge's gzip is already at the ceiling; only brotli has headroom, and see above. Rejected as a no-op.
- **Precompressed .br twins.** The interesting one. Pages ignored uploaded `.br` files (tested, it served the plain twin). Workers CAN do it: fetch the twin from assets and return it with `content-encoding: br` and `encodeBody: "manual"`, which tells the runtime the body is already compressed. But that means the asset goes back through the worker (undoing the zero-invocation edge-direct routing), plus Accept-Encoding negotiation and Vary correctness, to beat the edge's own brotli by ~3KB on a file that was about to get much smaller anyway. Rejected, narrowly, with the next section as the reason.

## The build step that earned its place

The shell scripts are the one external asset class: `nav.js` (the whole XP desktop: taskbar, draggable windows, Run palette) rides on every page. It is written the way this site writes everything: essay-grade comments, because the comments are the documentation and half the voice. That costs nothing in git and a meaningful part of the 82.8KB source file. Compression does not forgive all of that prose.

So the split, and the compromise that finally justified a build: **the authoring stays buildless, the serving gets minified.** One script (`build.mjs`) stages a copy of the site, runs Oxc Minify `0.140.0` over six independent client scripts, runs Lightning CSS `1.32.0` over the shared stylesheet and marked Worker CSS literals, and deploys from the copy. The repo never changes; local dev still serves the readable versions directly.

nav.js source82,800

source, local brotli22,772

Oxc output, raw46,152

Oxc output, local brotli12,950

These are local build measurements, not a claim about Cloudflare's edge quality: the origin wins before the edge gets involved. Six scripts together go from 230.4KB raw to 128.2KB, with readable source twins beside the deployed files.

The other five shells are `notepad.js`, `lens.js`, `lens-browser.js`, `quiz.js`, and `tooltip.js`. `sw.js` is now a tiny unregister stub and stays readable. Garage pages remain deliberately untouched: View Source on this site is supposed to read like source. The homepage now gets the same authoring/serving split, but only in the staged copy, with its readable original kept as `/index.src.html`.

## Keeping View Source honest

Minified JS is hostile to the one person a personal site should welcome: the curious reader. So the build deploys every readable original alongside as `/<name>.src.js`, and the minified file opens with a pointer:

```
/*! minified at deploy - readable source: /nav.src.js */
```

Two details I did not expect to enjoy this much. The build has **tripwires**: it fails the deploy if CSS emits a warning, loses a required route marker, or breaks the stylesheet's known-good rules, so "the transform broke something silently" is structurally impossible. And Cloudflare's asset storage is content-addressed, so on the first minified deploy the six `.src.js` twins uploaded as "already uploaded": their bytes were identical to the shells the previous deploy had shipped. The readable originals were already in storage, just under a different name.

## The inline-block wrinkle

External `nav.js` and `luna.css` have an obvious place to put smaller bytes. The homepage also carries a large inline `<style>` block and several inline `<script>` blocks. Those are not pointers to the external files: the code is literally inside the HTML document, so minifying the shells and stylesheet never touched it.

The new profile closes that hole conservatively. Rust-backed `@minify-html/node` handles document structure with its own JavaScript and CSS transforms disabled. Before that pass, homepage inline CSS goes through the existing Lightning CSS settings and executable inline JavaScript goes through the existing Oxc settings. JSON-LD and speculation rules are data, not JavaScript, so they remain untouched.

**Structure gets smaller; meaning stays put.** The served copy may lose comments and formatting whitespace and normalize attribute spelling, but it keeps the content, links, scripts, and semantic markers that crawlers and browsers use. The readable authoring file is still one request away at `/index.src.html`. The current homepage build is `75.9KB → 46.3KB` raw, or `11.5KiB` gzip / `9.9KiB` Brotli.

## What about the CSS?

Minifying CSS is the same idea as minifying JS, and worth seeing side by side, because the two languages do not shrink the same way. Both snippets below are real code from this site (the scroll-remember helper from `nav.js`, and this very page's Luna close-button gel), run through their native minifiers. Byte counts are for the full block; the excerpts are trimmed to fit.

JS before · 1,105 bytes

```
function rememberScroll(sc) {
  var key = "axp-scroll:" + location.pathname;
  var save = function () {
    try { sessionStorage.setItem(key,
      String(sc.scrollTop)); } catch (e) {}
  };
  var nav = (performance.getEntriesByType &&
    performance.getEntriesByType("navigation")[0]) || {};
  if (nav.type === "reload") { /* ... */ }
```

JS after · 622 bytes (44% smaller)

```
function rememberScroll(e){var t="axp-scroll:"
+location.pathname,r=function(){try{
sessionStorage.setItem(t,String(e.scrollTop))}
catch{}},s=performance.getEntriesByType&&
performance.getEntriesByType("navigation")[0]
||{};if(s.type==="reload"){/* ... */}
```

CSS before · 2,544 bytes

```
.title-bar .controls .close {
  position: relative; box-sizing: border-box;
  width: 21px; height: 21px; padding: 0;
  border: 1px solid #6696eb; border-radius: 3px;
  background-image: linear-gradient(180deg,
    #e8795f 0%, #e45f40 30%, #e45d3d 52%,
    #e2552a 80%, #ae3110 100%);
  transition: filter 60ms ease-out;
}
```

CSS after · 2,167 bytes (15% smaller)

```
.title-bar .controls .close{position:relative;
box-sizing:border-box;width:21px;height:21px;
padding:0;border:1px solid #6696eb;
border-radius:3px;background-image:
linear-gradient(180deg,#e8795f,#e45f40 30%,
#e45d3d 52%,#e2552a 80%,#ae3110);
transition:filter 60ms ease-out}
```

The gap is the whole story. JS shrinks 44% because a minifier can *rename* things: every local variable collapses to one letter, information genuinely leaves the file. CSS shrinks 15% because nothing in it is renamable: selectors and properties are the page's public API, so all a CSS minifier can remove is whitespace, comments, and micro-slack (note it dropped the redundant `0%` and `100%` gradient stops). And whitespace is exactly the thing brotli already compresses to almost nothing.

So the real question is never "does the file get smaller" but "does the WIRE get smaller after brotli." This site's CSS lives in four habitats, and I measured all four:

| habitat | raw | on the wire (brotli) | verdict |
| --- | --- | --- | --- |
| homepage inline `<style>` | source block | minified in the staged HTML | Lightning CSS; readable `/index.src.html` twin |
| worker-rendered chrome (xpChromeCss) | 9.4KB → 6.4KB | 84 bytes saved in page context | brotli already did the job |
| shared external `luna.css` | 64.2KB → 36.0KB | 16.3KB → 7.4KB | shipped: render-blocking + comment-heavy |
| the CSS strings inside nav.js | −703 bytes | GREW by 44 bytes | rejected by the measurement itself |

**The moral: minification and compression are fighting over the same bytes.** Minify-then-compress only wins where minification removes *information*, comments and long identifiers, which is why the JS build pays for itself. Where it only removes *redundancy*, whitespace and repeated patterns, brotli was going to erase that anyway. The exceptions are the external `luna.css` and the homepage staged copy: the sheet is shared, render-blocking, and carries a large readable comment layer, so stripping that at deploy saves about 9KB of local brotli without touching the source exhibit. Homepage inline CSS now goes through the same Lightning CSS pass; garage HTML and CSS-in-JS that became larger after brotli are still protected.

## The knobs are part of the contract

“Minify it” is not one switch. The useful part of today's work was deciding which transformations are safe for this site, which are intentionally absent, and where a warning becomes a failed deploy. The two panels below are the actual policy behind `build.mjs`, not a menu of hypothetical optimizations.

### JavaScript · Oxc Minify

- **`module: false`**
  These are classic script islands, so top-level behavior stays compatible with the existing page shell; there is no accidental module wrapper.
- **`compress.target: "esnext"`**
  Compress for the modern browsers the site already targets. No downlevel transpilation or compatibility runtime is smuggled into the payload.
- **`dropDebugger · unused · joinVars · sequences`**
  Remove dead local work and syntax slack, while keeping the transformation set small enough to reason about on independently loaded files.
- **`mangle.toplevel: false`**
  Local names may collapse; top-level names do not. That protects the globals and discovery markers other site code still knows by name.
- **`removeWhitespace: true · legalComments: "none"`**
  Strip the serving prose, then add back one hand-written banner pointing to the readable twin. The source remains one click away.
- **`scope: six shells + inline scripts`**
  The six external client files and executable homepage inline scripts use Oxc. JSON-LD, speculation rules, and garage-page scripts remain data or authored source.

guarded Oxc parse errors and missing per-file markers stop the build; the client scripts remain separate and unbundled.

### CSS · Lightning CSS

- **`minify: true`**
  Let a CSS parser remove comments, whitespace, redundant gradient stops, and other syntax slack while preserving selectors and properties as the public API.
- **`targets: unset`**
  No browser-target rewrite is requested. That means no surprise prefixing or syntax lowering: the stylesheet keeps the modern CSS the site deliberately authors.
- **`filename: ...`**
  Every transform gets a real source name, so a warning points back to the stylesheet or Worker module that caused it instead of becoming anonymous build noise.
- **`scope: luna.css + inline + /*min*/ literals`**
  The shared external sheet, homepage inline style, and five static Worker CSS literals are eligible. Dynamic CSS, interpolated templates, and garage HTML are not.
- **`source maps · CSS Modules · bundling`**
  Not enabled. There is no stylesheet graph to assemble and no transformed source that needs a separate map; the readable twin is the debugging surface.

fail closed Lightning CSS warnings and parse failures block deploy; marked Worker literals are then parsed again as JavaScript.

| layer | source | built output | policy |
| --- | --- | --- | --- |
| six JS shells | 230.4KB raw | 128.2KB raw   64.2KB → 39.5KB local brotli | Oxc Minify; six readable `.src.js` twins |
| shared `luna.css` | 64.2KB raw   16.3KB local brotli | 36.0KB raw   7.4KB local brotli | Lightning CSS; `/luna.src.css` twin |
| Worker CSS | static template literals | ~3.8KB raw saved | only literals marked `/*min*/` |
| homepage HTML + inline CSS/JS | 75.9KB raw | 46.3KB raw   11.5KiB gzip → 9.9KiB Brotli | `minify-html` structure; existing Oxc/Lightning CSS; `/index.src.html` twin |
| garage HTML | readable source | unchanged | View Source is the exhibit |

## Sidebar: Oxc without the bundler cosplay

The earlier four-shell head-to-head still explains why the switch was attractive: Oxc was about six times faster than esbuild, while the brotli output differed by only 40 bytes. But the thing now shipped is narrower than “the Rust toolchain”: this repo uses Oxc Minify directly. It does not add Rolldown, and it does not bundle the six client islands together.

|  | raw out | brotli out | time |
| --- | --- | --- | --- |
| esbuild | 89,512 | 24,421 | 21.9ms |
| oxc-minify | 90,131 | 24,381 | 3.8ms |

Verdict: Oxc is now the right small knife, and Lightning CSS is the matching CSS parser. Wrangler may still bring a nested esbuild for Worker bundling, but that is a separate platform build step. The authored site remains a set of readable, independently inspectable islands.

## Making s-maxage true

The second shipment in this batch fixed a quieter embarrassment. Worker-rendered pages here sent `s-maxage=300`, and the edge ignored it: Cloudflare does not automatically cache worker output, so `cf-cache-status` read `none` and the header was decorative. Every visit to [/lens](https://aadhar.sh/lens) re-assembled a byte-identical shell; every visit to [/writing](https://aadhar.sh/writing) re-fetched every post's text just to print character counts.

The fix is the Workers Cache API, `caches.default`: on miss, render and store; on hit, serve from the colo. Three rules carried over from this site's scar tissue: **only status 200 is ever stored** (this site once served homepage HTML at thumbnail URLs with a year-long cache header, and does not repeat mistakes it has written down), TTLs stay short and honest because deploys do NOT flush this cache, and every response says which path it took in an `x-edge-cache` header. The reading page also dropped its `no-store` (it was conservatism, not necessity), and the manual refresh hook evicts the edge copy too, so a bust still busts.

## Watch it happen

This fetches `/lens` and `/reading` twice each and prints the `x-edge-cache` header from your nearest Cloudflare colo. A fresh colo shows `miss` then `hit`; a warm one may say `hit` twice. Your browser hitting production, nothing mocked.

## The honest scorecard

|  | before | after | mechanism |
| --- | --- | --- | --- |
| six JS shells | 230.4KB raw | 128.2KB raw | Oxc at deploy; 6 independent files |
| luna.css | 64.2KB raw | 36.0KB raw | Lightning CSS at deploy; readable twin |
| Worker CSS literals | 5 static blocks | ~3.8KB raw saved | only `/*min*/` is eligible |
| repeat /lens, /writing, /reading | full re-render | colo cache hit | caches.default, 200-only, short TTLs |
| readable source | served as written | source twins | `/<name>.src.js` \+ `/luna.src.css` \+ `/index.src.html` |
| authoring workflow | no build | no build | the transform lives in deploy, not in writing |
| homepage bytes | 75.9KB raw source | 46.3KB raw   11.5KiB gzip / 9.9KiB Brotli | structure + inline CSS/JS transform; per-visit re-render remains by design |

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/) · kin: [off Pages, onto Workers](https://aadhar.sh/garage/workers) · [the thumbnail encoding study](https://aadhar.sh/garage/encoding)

build measurements refreshed 2026-07-19 on this site; the prober reads live production headers.

Source: https://aadhar.sh/garage/wire
