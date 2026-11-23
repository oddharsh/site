# Static delivery and gallery experiments, 2026-11-23

The retained changes fix document headers, serve the AV2 decoder at q11,
extract specialized CSS, and reuse the existing thumbnail tiers in the gallery.
The remaining Gemini suggestions were prototyped separately. The aggressive
critical-CSS rollout breaks early interaction and remains outside this change.

## Retained changes

| Measurement | Baseline | Retained change |
| --- | ---: | ---: |
| Luna, Brotli q11 | 9,230 B | 7,887 B |
| Decoder, q4 versus served q11 | 554,799 B | 429,477 B |
| Desktop 1x gallery image transfer | 269,165 B | 94,082 B |
| Phone 1x gallery image transfer | 171,674 B | 73,096 B |
| Desktop 2x gallery image transfer | 269,165 B | 269,165 B |
| Phone 2x gallery image transfer | 171,674 B | 134,975 B |
| Gallery median FCP, nine alternating pairs | 640 ms | 560 ms |

The gallery FCP reduction was 80 ms at the median paired delta, with all nine
pairs improving (two-sided sign test p=0.00390625). LCP showed no significant
change: four pairs increased and five decreased (p=1). Both sides recorded
zero CLS in those pairs.

The gallery retains explicit URL deferral after twelve tiles, JPEG recovery,
and no-JavaScript AVIF/JPEG negotiation. Automatic image sizes select among the
existing 200/400/600px tiers. The first image stays eager on its existing
400px candidate; the others use native lazy loading within the URL boundary.
No thumbnail was encoded or retired.

These safeguards increase gallery HTML by about 3.7 KiB at q11. The transfer
figures above include images loaded during the initial 1.5-second settle at
1280x844 and 390x844, with device scale factor 1. They exclude the document
and other assets. The image savings exceed the larger document in both cases.

The new track-list and tooltip sheets measure 578 B and 1,126 B at q11.
The homepage loads its track-list sheet without blocking paint. A cold tooltip
waits for its stylesheet and module together, and a failed stylesheet can retry.
The shared cursor-coordinate registrations remain in Luna for shell infotips.

`/access` and `/dotfiles` now advertise the document cache policy, hashed shell
preloads and dictionary registration. Garage also advertises hashed prose CSS.
Local response checks confirmed that `/dotfiles/macos.sh` keeps its own policy.
These checks establish header delivery; production Early Hints latency remains
unmeasured.

The decoder arrived as exactly 429,477 raw wire bytes with `application/wasm`
and immutable caching. Streaming compilation passed. The q11 sweep also checked
every built shell, page and static-asset twin through the local Worker.

## Remaining original proposals

| Proposal | Prototype result | Decision |
| --- | --- | --- |
| Critical-CSS selector expansion, script exclusion, root pruning, interaction/print pruning, and unrestricted rollout | Sampled FCP fell from 592 to 292 ms on Compression, 564 to 280 ms on Access, and 636 to 368 ms on Horizon. Documents gained about 5.5–6 KB q11. With full Luna held, Maximize left a window relative at 920px until the sheet arrived, then changed it to fixed at 1280px. | Keep the conservative extractor and size budget. Investigate positive selector matching separately. |
| Moving cursor registrations into tooltip CSS | A shell infotip still displayed before rich-tooltip CSS loaded in Chrome. | Keep the shared registrations in Luna; their ownership includes both islands. |
| Single-image gallery with native lazy loading and no noscript copies | Saved 2,164 B q11, but loaded 45 images: 186,418 B at desktop 1x and 521,847 B at 2x. With scripting and AVIF disabled, it loaded no photos; the retained version loaded all 165 JPEG fallbacks. | Keep the explicit URL boundary and no-script negotiation. |
| Broader Workers Cache admission | The prototype admitted the static sections and excluded Dyno and its live children. | Leave admission unchanged. Local tests cannot establish production cache-hit latency or correctness across every cache-key variant. |
| Speaker sprite, lazy sound, resize-read removal, and reserved sound-button space | Nav shrank from 6,283 to 5,461 B q11; the sprite grew 269 B, and the optional sound module cost 609 B. Cold tooltip, Clock, shell infotip and unmute/audio checks passed in Chrome. No isolated layout-flush or tray-shift gain was established. | Promising follow-up. Keep the implementation separate from the selected changes. |
| Omit parser pause on non-quiz pages | The eligibility guard removed quiz-CSS insertion from Garage, Access, Bot, Privacy and Developers. | Separate prototype; no isolated latency improvement is claimed. |
| Externalize Pixel Peeper and Access scripts | Cold HTML-plus-script totals grew 232 B and 259 B respectively. Pixel Peeper's median FCP changed from 316 to 284 ms, while LCP changed from 412 to 612 ms. | Separately cacheable scripts are useful, but app-ready latency needs further work. |
| Move Horizon's feature probe before stylesheets | The standalone prototype measured median FCP 604 ms against the earlier baseline's 636 ms, over five unpaired loads. | Exploratory result; insufficient evidence to include it here. |
| Homepage interaction, repeated palette, background and overridden-declaration trims | Cumulative prototype homepage q11 fell from 9,637 to 9,378 B. Its median FCP remained 272 ms. | Keep the existing first-paint backgrounds. No demonstrated timing win. |

The cumulative critical-CSS and navigation prototype recorded CLS 0.02922 on
Pixel Peeper. Adding external scripts retained that shift and delayed LCP.
That separates the layout problem from the extra script dependency. Access and
Horizon recorded smaller shifts of 0.00031 and 0.00551 in both cumulative stages.
These prototypes need more work before release.

## Method and limits

Baseline: `1f53cf68`, with the repository's checksum-verified Bun pin and frozen
dependencies. Timing probes used headless local Chrome, a 390x844 viewport,
4x CPU throttling, 1.6 Mbit/s download and 150 ms latency. The paired gallery
run alternated order across nine fresh-context pairs. A 300 ms stylesheet-delay
control verified that the timing instrument detects a blocking stylesheet.

The other timing results are exploratory five-load medians. Their cumulative
stages can attribute byte changes, but cannot isolate every timing effect.
Early exploratory probes skipped `hadRecentInput` shifts, which is invalid in
this mobile emulation. Those CLS readings were discarded. The paired gallery,
strict prototype reruns and repository browser check count every shift.

Local KV, R2 and D1 use harness data. These results do not establish field
Core Web Vitals, production Early Hints gains, or Workers Cache hit rates.
The five performance-budget advisories also occur on the baseline. Worker gzip
was 300.28 KiB on baseline and 300.67 KiB at the first retained checkpoint.

The smaller Luna made `/lwe` newly eligible for non-blocking CSS and exposed
the readable-twin mismatch documented in gotcha 116. Both representations now
match the served markup against renamed selectors. The existing performance
gate remains unchanged.

## Regression checks

Use `bun run check:fast`, `bun run perf-budget`, `bun run routes:check`,
`bun run pages:check`, `bun run derive:check`, and the calendar test command.
The targeted browser sweep covers Home, Photos, Compression, AV2, Access,
Dotfiles and Pixel Peeper at desktop and phone sizes, including planted controls.
Gallery view switching, failed-AVIF recovery, no-JavaScript rendering, and cold
tooltip stylesheet failure/retry also received direct Chrome checks. A real
128x128, 10-bit AV2 sample decoded to 65,536 RGBA bytes through the module worker.
The gallery menu passed ArrowDown, Home, End, Enter and Escape checks.

The generic interaction runner found zero content-pane controls on Home and
Photos; their View menu sits in the window chrome. Its eight planted controls
passed, and the menu behavior was checked directly. Derivation checks found
zero stale outputs and retained ten entries classified as unverifiable.

The four mutation controls are `static-page-twin-cache-policy`,
`wasm-twin-serving`, `gallery-url-deferral`, and
`readable-twin-critical-classes`. Each must detect its planted defect.
