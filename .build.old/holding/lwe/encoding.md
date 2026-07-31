---
title: "aadhar.sh/lwe/encoding"
description: "Why one photo gives three file sizes, explained at the pace of an MSN chat. AVIF against JPEG against the tuned JPEG encoders (mozjpeg, jpegli, zenjpeg), with a bytes-per-pixel demo that fetches the real encoded files live."
path: "/lwe/encoding"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/encoding"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**thumbnail encoding**Online, image encoding

Learning With Errors  
bytes & pixels

**Starter draft.** This grew out of the [garage encoding study](https://aadhar.sh/garage/encoding), where one photo runs through every encoder and the bytes get counted. The conversation is a first pass; the demo fetches the study's real output files and measures their actual sizes.

**aadharsh**23:01

the garage page runs one photo through jpeg, zenjpeg, and avif and prints three different sizes. before I trust those numbers, tell me why one image even gives three sizes.

**thumbnail encoding**23:01

An encoder throws away the detail your eye skips, then packs what survives. The three differ in how hard they push each step.

**JPEG** (1992) cuts the photo into 8x8 blocks, runs a cosine transform, and rounds off the high-frequency parts. **jpegli** (Google, 2024) keeps the exact JPEG format but rounds smarter, so it fits roughly 25% more quality into the same bytes as the old mozjpeg encoder. **AVIF** borrows AV1's video tricks, larger blocks and sharper prediction, so it usually wins on bytes-per-pixel outright.

**aadharsh**23:02

so jpegli writes a normal .jpg that any browser opens, just smaller?

**thumbnail encoding**23:02

Right. jpegli stays inside the JPEG bitstream, so a browser from 1995 still decodes it. AVIF needs a modern decoder (Safari 16+, Chrome 85+). That trade, universal but larger against modern but smaller, is why the photo grid ships both and lets the browser pick.

**aadharsh**23:03

ok, stop describing it. show me the bytes on one photo.

bytes-per-pixel, measured live

The same 400×266 photo (106,400 pixels), run through every encoder. These sizes are **fetched live** from the files the garage study actually produced, so the bytes are real. The last column is size against the lossless PNG.

![sample photo, zenjpeg q84](https://aadhar.sh/garage/enc/c-zc84.jpg?v=3)

| encoder | size | b/px | vs PNG |
| --- | --- | --- | --- |
| measuring real files… |  |  |  |

**aadharsh**23:04

so on this photo jpegli is about half the baseline JPEG, and avif is smaller still. what's the catch with avif then?

**thumbnail encoding**23:04

Decode support and encode time. AVIF leans on the AV1 codec, which is slower to encode and only decodes on recent browsers. A tuned JPEG is fast and universal. That is why the site **ships a tuned JPEG encoder** for the universal fallback and uses AVIF as the primary `<picture>` source: the browser reaches for AVIF, and anything that cannot decode it falls back to the .jpg. That fallback encoder was jpegli for a long stretch, built from source; since 2026-07 it is **zenjpeg**, which the grids below measure against it directly.

**aadharsh**23:05

and the grayscale shots? why are those so much smaller?

**thumbnail encoding**23:05

A color image carries one luma plane (brightness) plus two chroma planes (color). Drop to grayscale and you delete both chroma planes, roughly two-thirds of the color information, so the file falls hard. The garage study has the side-by-side counts.

**aadharsh**23:05

so color is two of the three planes. JPEG and AVIF don't even keep color at full resolution, right? that's the subsampling thing?

**thumbnail encoding**23:05

Right, chroma subsampling. Your eye resolves brightness far better than color, so codecs keep luma at full resolution and shrink the two chroma planes. 4:4:4 keeps everything; 4:2:2 halves chroma horizontally; 4:2:0, the web default, stores one chroma sample per 2x2 block, a quarter of the color resolution. The luma carries the sharpness, so you barely notice.

chroma subsampling · pick a mode

The top band is fine luma detail (black and white lines); the bottom is fine chroma detail (red and green lines) at the same spacing. Switch the mode: luma stays razor sharp at every setting, while the color detail dissolves as you drop chroma resolution.

**aadharsh**23:06

wild, the black-and-white lines stay razor sharp at 4:2:0 but the red-green lines just dissolve. and that's half the samples gone.

**thumbnail encoding**23:06

Exactly, and for photographs it is almost free, because real scenes rarely put fine high-contrast color edges right next to each other. Where it shows is red text on a dark background or saturated line art, which is why screenshots and graphics keep 4:4:4 while photos ship 4:2:0.

**aadharsh**23:07

earlier you said jpegli just "rounds smarter." smarter how, if it writes the same JPEG format?

**thumbnail encoding**23:07

It models your eye instead of trusting the fixed 1992 quantization tables. jpegli works in the XYB color space, which spaces colors the way you perceive them, sets the quantization adaptively per block by what you would actually notice, and rounds with adaptive dead-zones. The output is still a standard JPEG that any decoder reads, but more bits land where your eye looks and fewer on detail you would never see. That is the rough 25% it gains over the old mozjpeg encoder.

The site rode jpegli for exactly that reason, then moved to **zenjpeg** in 2026-07. It reaches the same goal by a different road: hybrid trellis quantization plus a search across 64 candidate progressive scan scripts, which lands a few percent under jpegli at matched quality.

**aadharsh**23:08

ok, I want to SEE these tradeoffs, not just read byte counts. show me one zoomed crop across formats and qualities.

**thumbnail encoding**23:08

Here is a 96-pixel detail crop, the car's body edge against the dark wheel, run through every encoder and blown up so the artifacts show. Start with format against quality.

format × quality · one zoomed crop

One 96-pixel detail crop (the body edge against the dark wheel), run through three formats at three quality tiers and shown pixel-zoomed. Read across a row to compare formats at one quality; read down to watch a format fall apart as quality drops.

highmidlowzenjpeg

![q90](https://aadhar.sh/garage/enc/z-zc90.jpg?v=1)

q90  
…

![q50](https://aadhar.sh/garage/enc/z-zc50.jpg?v=1)

q50  
…

![q22](https://aadhar.sh/garage/enc/z-zc22.jpg?v=1)

q22  
…

WebP

![q90](https://aadhar.sh/garage/enc/z-wp90.webp?v=1)

q90  
…

![q50](https://aadhar.sh/garage/enc/z-wp50.webp?v=1)

q50  
…

![q22](https://aadhar.sh/garage/enc/z-wp22.webp?v=1)

q22  
…

AVIF

![q78](https://aadhar.sh/garage/enc/z-av78.avif?v=1)

q78  
…

![q42](https://aadhar.sh/garage/enc/z-av42.avif?v=1)

q42  
…

![q18](https://aadhar.sh/garage/enc/z-av18.avif?v=1)

q18  
…

At 96 pixels the absolute bytes mostly reflect each format's fixed container overhead (WebP's is lightest, AVIF's heaviest), not the per-pixel efficiency that flips on full images, which is what the live measurement above shows. What the zoom reveals is the artifact style: JPEG breaks into 8x8 blocks, while WebP and AVIF smear and smudge instead.

**aadharsh**23:09

jpeg goes blocky, the others go smeary. now the jpeg encoders you mentioned, mozjpeg vs the google one?

**thumbnail encoding**23:09

Same crop, same quality knob, four encoders in the order the site adopted them. The bytes under each tell the story.

four JPEG encoders · same quality

The same crop, the same quality setting (q72), four JPEG encoders in the order the site adopted them. All four write the same JPEG format any decoder reads; the only difference is how cleverly each spends its bits. Watch the byte counts.

![baseline](https://aadhar.sh/garage/enc/z-enc-baseline.jpg?v=1)

baseline  
…

![mozjpeg](https://aadhar.sh/garage/enc/z-enc-mozjpeg.jpg?v=1)

mozjpeg  
…

![jpegli](https://aadhar.sh/garage/enc/z-enc-jpegli.jpg?v=1)

jpegli  
…

![zenjpeg](https://aadhar.sh/garage/enc/z-enc-zenc.jpg?v=1)

zenjpeg  
…

Same quality knob, real bytes measured live, and each step buys its win a different way. mozjpeg trellis-quantizes inside the 1992 rules. jpegli throws those rules out and models your eye instead (XYB color, adaptive per-block quantization), which is the psychovisual win in one crop. zenjpeg pairs a hybrid trellis with a search across 64 candidate progressive scan scripts. jpegli is the encoder that proved a standard JPEG could be halved; zenjpeg is the one the site ships, because it landed a few percent under jpegli at matched quality.

**aadharsh**23:10

so each one squeezes a little harder than the last, same setting throughout. and chroma, up close on a real edge?

**thumbnail encoding**23:10

The same crop as a JPEG at the three chroma samplings. Luma holds; the color is what softens.

chroma subsampling · a real edge

Chroma subsampling on a real edge instead of stripes: the same crop saved as a JPEG at 4:4:4, 4:2:2, and 4:2:0. The luma edge holds at every setting; the color is what loses resolution.

![4:4:4](https://aadhar.sh/garage/enc/z-ch444.jpg?v=1)

4:4:4  
…

![4:2:2](https://aadhar.sh/garage/enc/z-ch422.jpg?v=1)

4:2:2  
…

![4:2:0](https://aadhar.sh/garage/enc/z-ch420.jpg?v=1)

4:2:0  
…

The size drop is modest here (4:4:4 to 4:2:0) because this crop is mostly grays. On saturated content the savings grow and the color fringing gets obvious, which is the stark version in the stripes demo above.

**aadharsh**23:06

so what does the site actually ship per thumbnail?

**thumbnail encoding**23:06

Each thumbnail is dual-encoded: an **AVIF primary** and a **zenjpeg JPEG fallback** inside one `<picture>`, plus a 400px AVIF tier for phones. The browser loads the smallest format it can decode and never downloads the others.

**aadharsh**23:07

got it. one photo, several encoders, and the grid hands each browser the cheapest thing it can read. thanks.

→ [the full garage encoding study](https://aadhar.sh/garage/encoding) · [back to Learning With Errors](https://aadhar.sh/lwe/)

end of first pass

This is a recorded conversation. The demo above measures real files.

Source: https://aadhar.sh/lwe/encoding
