---
title: "aadhar.sh/garage/thumbnail encoding study"
description: "The same photo run through AVIF, WebP, and JPEG (zenjpeg/zenc, the shipped encoder that replaced jpegli), with real byte counts, quality measurements, encoder knobs, and the tradeoffs the site actually makes."
path: "/garage/encoding"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/encoding"
---

# Thumbnail encoding study

Every grid thumbnail ends a chain of choices: *format, quality, chroma subsampling, resolution*. Here I run one photo through all of them with real byte counts, so you can see the tradeoffs instead of taking them on faith. The actual encoders the site uses (avifenc, zenc/zenjpeg, cwebp, sips) produced the shipped numbers; the corpus study that put zenjpeg in the pipeline is below.

**The verdict shipped:** the live pipeline (`holding/scripts/add-photos.sh`) encodes every thumbnail as AVIF-primary + a JPG fallback. The JPG encoder is now **zenc** (`holding/scripts/zenc/`, a zenjpeg wrapper: hybrid trellis + progressive scan search) at q84, which retired the from-source jpegli build in 2026-07 for a few percent fewer bytes at equal quality. The corpus comparison that drove that switch is below.

## Format showdown

The same detailed color frame at 400×266px. PNG holds the lossless baseline; everything below it throws bits away. Eyeball the quality, then read the bytes. `b/px` = bytes per pixel, the size-density that actually scales.

**PNG** lossless · 178.7 KB · 1.72 b/px

**JPG·sips** q82 · 4:2:0 · 31.7 KB · 0.31 b/px

**JPG·zenc** q62 · 4:2:0 · 9.7 KB · 0.09 b/px

**JPG·zenc** q84 · 4:2:0 · **shipped** · 15.9 KB · 0.15 b/px

**JPG·zenc** q95 · 4:2:0 · 32.0 KB · 0.31 b/px

**WebP** q60 · 4:2:0 · 7.8 KB · 0.07 b/px

**WebP** q80 · 4:2:0 · 11.8 KB · 0.11 b/px

**AVIF** q40 · 4:2:0 · 4.6 KB · 0.04 b/px

**AVIF** q63 · 4:2:0 · 10.4 KB · 0.10 b/px

**AVIF** q85 · 4:2:0 · 20.1 KB · 0.19 b/px

**AVIF** q63 · 4:4:4 · 11.3 KB · 0.11 b/px

## Why the site built jpegli from source (then moved past it)

Look at the two JPEGs above at the shipped quality: **system/sips** q82 lands at 31.7 KB, **zenc** q84 (the same visual quality) at 15.9 KB: *~50% fewer bytes*. Google's jpegli first showed the win (re-implement libjpeg, tune it psychovisually); that is why the pipeline shelled out to a from-source `cjpegli` for years instead of the OS encoder. The site has since moved to **zenc/zenjpeg** (the corpus study below), which takes another few percent at equal quality and, being a Rust crate, is dependabot-tracked and builds on any machine, no cmake/ninja toolchain. AVIF beats both, but JPEG still backs up every `<img>` as the universal fallback, so shrinking it still pays off.

## Zenjpeg won and shipped

“Zenjpg” is a good shorthand, but the crate is published as [`zenjpeg`](https://docs.rs/crate/zenjpeg/latest). It ships no CLI, so the site checks in a small Rust wrapper (`holding/scripts/zenc/`) and the photo Action builds it with cargo; dependabot tracks the pin. That retired the from-source jpegli build in 2026-07. The corpus run below is the evidence that drove the switch.

**Corpus verdict (158 photos):** the single-fixture read below was a lead, so I ran the whole library through it (112 Fuji X-T50 + 46 Leica frames, resized to the 600px thumbnail tier, each normalized so both encoders and the metric see identical pixels). Across all 158, zenjpeg's realistic mode (hybrid trellis) needs about **1.6% fewer bytes** than `cjpegli -q82 -p2` at equal SSIMULACRA2; its aggressive mode (hybrid plus a 64-candidate scan search) about **4%**. zenjpeg's fast path ties cjpegli. A real win, but a small one on a fallback format AVIF already beats by ~40%.

### The knobs that matter

| knob | what it changes | thumbnail read |
| --- | --- | --- |
| `quality` | Quantization strength; zenjpeg's scale is jpegli-like, not a promise of equal bytes. | Calibrate by output size, not by matching `82` on the label. |
| `ChromaSubsampling` | `None` = 4:4:4; `Quarter` = 4:2:0. | 4:2:0 is the likely production candidate, but this first matched run used 4:4:4 because current cjpegli did. |
| `progressive` | Progressive versus baseline JPEG; progressive mode also optimizes Huffman coding. | Use progressive for the jpegli comparison; baseline is a separate decode/compatibility tradeoff. |
| `ProgressiveScanMode` | jpegli script, MozJPEG script, or `ProgressiveSearch` over 64 scan candidates. | On the corpus, scan search took the BD-rate from about 1.6% to 4%, at roughly 4× hybrid's encode time (13× cjpegli). |
| `auto_optimize(true)` | Hybrid trellis: jpegli adaptive quantization plus rate-distortion optimization. | The mode that actually beats cjpegli (+0.5 SSIMULACRA2 at matched bytes), about 3× the base encode time. |
| `OptimizationPreset` | `Jpegli*`, `Mozjpeg*`, and `Hybrid*` bundle quant tables, AQ/trellis, scan strategy, and deringing policy. | Compare named profiles rather than accumulating unexplained flags in the Action. |
| `deringing(true)` | Overshoot deringing around saturated, high-contrast edges; enabled by default for jpegli/hybrid paths. | Useful protection, not a byte-saving knob: it changed nothing on this photo fixture, so it still needs an edge-heavy test image. |
| `parallel` | Optional Rayon-backed multi-threaded encoding, with restart markers supporting larger-image parallel work. | Moot at this scale: a 600px frame stays single-threaded, and the 158-photo batch already parallelizes at the job level. The whole library encodes in seconds either way. |

### Full-corpus read

158 real frames resized to 600px, each normalized to one canonical RGB buffer so both encoders and the metric read identical pixels (the grayscale frames carry a Gray ICC that different decoders expand differently, which will fake a quality collapse if you skip this). Quality is **SSIMULACRA2**, the perceptual metric zenjpeg's own tuning targets, cross-checked with PSNR/SSIM. BD-rate is the average byte difference at equal quality over a 5-point sweep; negative means fewer bytes for the same quality. Single thread, Apple Silicon.

| encoder / mode | BD-rate vs cjpegli 4:2:0 | encode speed | whole library |
| --- | --- | --- | --- |
| **cjpegli 4:2:0** (incumbent) | baseline | 123.5 MP/s | 0.32 s |
| zenjpeg base (no trellis) | +2.8% | 111.9 MP/s | 0.35 s |
| **zenjpeg hybrid** (trellis) | −1.6% | 38.1 MP/s | 1.02 s |
| zenjpeg hybrid + scan search | −4.1% | 9.3 MP/s | 4.23 s |

Read together: zenjpeg's **base** path is basically cjpegli, a hair slower and a hair larger, so the C-to-Rust rewrite is not the story. The **trellis** is: it buys the byte win by spending 3× to 13× the encode time. At matched bytes that lands as **+0.5 SSIMULACRA2** (hybrid) to **+0.8** (scan search), real but below the threshold I would trust without a visual pass. And even the 13× mode encodes the whole library in about 4 seconds, so encode speed does not gate this decision at thumbnail scale.

**Where this landed:** shipped. A 1.6% to 4% win is marginal, and on a JPEG fallback AVIF already beats by ~40% the number alone does not force the move. But the site already maintains a whole toolchain for marginally-superior output (jpegli-from-source, the minified build, dependabot on a one-worker repo), so marginal-superior clears the bar here. zenjpeg is [AGPL-3.0-or-later (or a $1 startup license)](https://docs.rs/crate/zenjpeg/latest), a paper cut for a build-time encoder whose JPEG output is not a derivative work of it; the Rust wrapper (`holding/scripts/zenc/`) is dependabot-tracked and builds anywhere, no cmake/ninja. So it replaced the from-source `cjpegli` in the pipeline.

**The knob I hoped would change the answer, and did not:** "encode every photo to a fixed perceptual score instead of a fixed `q`" would be worth real effort, because a fixed `q` scatters wildly. On these 158 photos, `cjpegli -q84` lands anywhere from SSIMULACRA2 66.8 to 85.5. But zenjpeg 0.8.4's score targets (`Quality::ApproxSsim2`, `ApproxButteraugli`) are open-loop approximations, not a measured loop. Asked for SSIMULACRA2 85, the corpus landed at a mean of 77 with roughly the same spread as fixed `q` (1 photo of 158 inside ±2 of the target). It is a relabeled quality scale, not consistency. The measured closed loop that would actually hold a score is not in the forward encoder in this release. Revisit if that ships.

The single-frame lead that prompted the corpus run

One 400×266 color fixture, `zenjpeg 0.8.4` progressive 4:4:4 vs `cjpegli -q82 -p2`. Directional only; the corpus above supersedes it.

| encoder / mode | bytes | SSIM | PSNR |
| --- | --- | --- | --- |
| **cjpegli q82** | 17,234 | .964791 | 40.7492 dB |
| zenjpeg baseline q82 | 17,252 | .964550 | 40.7186 dB |
| **zenjpeg hybrid q80** | 17,286 | .967684 | 41.2312 dB |
| zenjpeg hybrid q82 | 18,317 | .969240 | 41.5352 dB |

## Grayscale: drop the chroma planes

A black-and-white Leica frame (400×267). In a grayscale image the two chroma planes carry almost nothing, so AVIF **4:0:0** (luma only) both encodes it honestly and rules out any faint color cast. Dropping to 4:0:0 saves barely any bytes over 4:2:0 *because nothing lived in those planes to begin with*. Correctness is the reason here, since the byte savings are negligible. The pipeline detects `sips -g space → Gray` and switches to `--yuv 400`.

**PNG** lossless · 51.0 KB · 0.49 b/px

**JPG·zenc** q84 · 9.3 KB · 0.09 b/px

**AVIF** q63 · 4:2:0 · 10.6 KB · 0.10 b/px

**AVIF** q63 · 4:0:0 · 10.5 KB · 0.10 b/px

## Resolution scales bytes ~quadratically

The color frame at three long edges, AVIF q63 vs zenc q84. Doubling the long edge roughly triples the bytes, and AVIF holds a steady *~34–36%* lead over JPEG at every size, which is why the grid stays AVIF-primary and small and square.

| resolution | AVIF q63 | zenc q84 | AVIF saves |
| --- | --- | --- | --- |
| 400×266 | 10.4 KB | 15.9 KB | 34% |
| 800×533 | 33.3 KB | 52.1 KB | 36% |
| 1200×800 | 73.1 KB | 110.2 KB | 34% |

## Progressive is a rendering choice, not just a byte one

Everything above treats `progressive` as a compression knob: it optimizes Huffman coding, and `ProgressiveSearch` over 64 scan candidates took the BD-rate from ~1.6% to ~4%. That is only half of what the setting does. Scan order also decides *what the viewer sees while the file is still arriving*, and on a big enough image that is the entire loading experience rather than a footnote to it. Kornel Lesi&nacute;ski [made the case at perf.now() 2018](https://www.youtube.com/watch?v=jTXhYj2aCDU): the same bytes, reordered, show a recognisable picture at a quarter of the file, and it costs nothing because it is not an extra request or a placeholder tier.

Every JPG this site ships is already progressive, thumbnails included: 158 of 158 parse as `SOF2`, and the scan search picks a good script. On a representative 31.3 KB thumbnail the seven scans land at these points in the file, so the first three, which is where an image becomes recognisable, are inside the first third:

| scan | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| byte offset | 0% | 15% | 34% | 85% | 87% | 90% | 94% |

**And you will never see it work on a thumbnail.** At a 32 KB median, a typical 10-packet initial congestion window (~14 KB) already carries 45% of the file, so those first three scans arrive in the opening flight and the tile paints once. The scan search still earns its place at this size, purely for the bytes it saves. The rendering half of the feature is dormant.

It wakes up at [the full-size archive](https://aadhar.sh/photos). `/images/full/` is the one image surface here with no AVIF tier and no `<picture>` around it: the worker streams ~10 MB from R2 as bare `image/jpeg`, and that single file is the whole payload. That is also the awkward part of the format story, because **AVIF structurally cannot do this**. Its layered mode caps at four stages, is effectively Chromium-only, and is staged rather than incremental the way a JPEG scan script is; nothing here emits layered AVIF anyway. So the format that wins every byte comparison on this page loses the one property that matters when a single large image *is* the page. Both are true at once, which is why the grid is AVIF and the archive is JPEG.

### What the archive tier actually costs

The archive is a second encode: a HIF is decoded to lossless PNG, then re-encoded at `q100 4:2:2`. Scored against that decode with SSIMULACRA2, one 7728×5152 frame reads ~88, which looks alarming for *q100* until you sweep it. It is simply where JPEG tops out on 40 MP of sensor grain, and the metric is harsh on exactly the high-frequency noise JPEG discards first.

| quality | SSIMULACRA2 | bytes | b/px |
| --- | --- | --- | --- |
| `q100` (shipped) | 88.15 | 26.1 MB | 5.24 |
| `q95` | 85.13 | 16.3 MB | 3.28 |
| `q90` | 80.74 | 11.5 MB | 2.31 |
| `q84` | 74.26 | 7.8 MB | 1.57 |

Two things that ceiling is *not*, both checked rather than assumed. Re-encoding at 4:4:4 instead of 4:2:2 scores 88.28 against 88.15, so the chroma round-trip is not the limit and 4:2:2 keeps its ~13% byte saving for free. Flattening the reference to 8-bit first scores 88.08 against 88.15, so the 10-bit→8-bit step is not the limit either: JPEG is 8-bit, and a HIF's extra depth is spent in the edit, never at the archive.

That generation also costs far less than it looks once an image is resized for anywhere else. Comparing a direct downscale of the HIF against a downscale of the archive JPEG, the same pair that reads 88.15 at full resolution reads **94.62 at 1080px**: averaging ~50 source pixels into one washes most encoding artifacts out. Delivery scale forgives the second encode. A 10 MB download does not, which is the whole reason the archive is progressive.

## What aadhar.sh actually ships

- **AVIF primary** (`q63`, `4:2:0` color / `4:0:0` gray) + **zenc JPG q84** (zenjpeg hybrid+scan) as the universal fallback, via `<picture>`.
- **Pre-cropped 600/400 squares**, metadata-stripped: the file *holds exactly* the displayed pixels, so no off-square or EXIF bytes ride along.
- **4:2:0 over 4:4:4** for color: storing the full chroma at 4:4:4 costs ~8% more bytes (the two AVIF q63 cards above) and buys no visible gain at thumbnail size, so 4:2:0 hands you free quality.
- **Full-res share copies in R2 at JPEG `q100 4:2:2`**, progressive: 4:2:2 matches the HIF's native sensor chroma, and the scan order is the point at 10 MB. The true HEIF originals stay on local disk. A JPG-source original is uploaded byte-for-byte from the camera, rearranged to progressive by `jpegtran` on the way up: a lossless coefficient reorder, never a re-encode.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

shipped byte counts are real output from `avifenc · zenc · cwebp · sips`; the corpus table is a reproducible `zenjpeg 0.8.4` run.

Source: https://aadhar.sh/garage/encoding
