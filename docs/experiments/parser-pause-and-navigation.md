# Parser-pause guard and isolated navigation experiments

Measured on 2026-11-24 against `dca2cdcd`, independently of PR #1836. The
proposed parser guard and four navigation changes are preserved as independent
source patches. The guard is rejected because CI confirmed cold first-paint
regressions. Runtime parser and navigation behavior stay at the measured
baseline; the retained code adds regression coverage and repairs the checks.

## Parser-pause guard prototype (rejected)

In the prototype, the pause requires the canonical `luq-data` quiz marker. Both inline and
extracted quiz data qualify. Garage, Access, Bot, Privacy and Developers no
longer acquire an unused quiz stylesheet. Pages with quizzes retain their
pause, threshold, idempotence and first-fold ordering.

In the prototype, the five served documents and their readable twins are the only changed HTML
files in the baseline/build comparison. The quiz sheet costs 805 B at Brotli
q11. The local Chrome harness delivered it as a 949 B compressed body; all nine
candidate visits to each non-quiz page avoided that request. Compression, the
real quiz-page control, requested it in both versions.

Nine alternating cold-context pairs per page used Chrome at 390x844, 4x CPU,
1.6 Mbit/s download and 150 ms RTT. The Worker runtimes were warmed first.
Taskbar arrival is the insertion of its markup; shell readiness is the first
mutation that gives the sound toggle its label. These are DOM milestones,
not measurements of painted pixels or input latency. CLS includes every shift.

| Page | Paired FCP change | Taskbar arrival change | Shell readiness change | Readiness p |
| --- | ---: | ---: | ---: | ---: |
| Garage | +8 ms | -188 ms | -125 ms | 0.0039 |
| Access | +40 ms | -24 ms | -26 ms | 0.1797 |
| Bot | 0 ms | -178 ms | -134 ms | 0.0039 |
| Privacy | +8 ms | -170 ms | -116 ms | 0.0039 |
| Developers | +64 ms | -373 ms | -29 ms | 0.0391 |
| Compression, quiz control | +16 ms | -1 ms | +16 ms | 0.5078 |

Under this slower local profile, no FCP or CLS change met the existing
two-sided sign-test threshold. Access's
readiness change was inconclusive. P-values are per comparison, without a
multiple-comparison correction. These data establish the removed request and
the taskbar benefit; they do not establish a paint or LCP improvement.

The timing control delayed the baseline's real quiz stylesheet by 900 ms over
nine pairs. Taskbar arrival moved +695 ms and readiness +538 ms, each with all
nine pairs increasing (p=0.0039). An earlier single-pair control was discarded
because cold Worker startup confounded it.

### CI found a first-paint regression

CI independently read all five changed documents over nine cold pairs at
390px, 4x CPU, 50 Mbit/s and 40 ms RTT:

| Page | Paired FCP change | Significant | CLS change |
| --- | ---: | --- | ---: |
| Garage | -28 ms | no | 0 |
| Access | +116 ms | yes | 0 |
| Bot | +28 ms | no | 0 |
| Privacy | +32 ms | no | 0 |
| Developers | +56 ms | yes | 0 |

The two significant changes met the existing p < 0.05 and 16 ms floor. Passing
functional checks and removing a request did not make this a safe performance
improvement. The stylesheet is also a deliberate parser pause: it releases an
earlier first frame before the remainder parses. Quiz absence alone cannot
justify removing it. Keep the baseline policy until a replacement preserves
that early paint; do not add route exceptions or another dummy stylesheet to
hide the regression. [parser-pause-guard.patch](parser-pause-guard.patch)
preserves the complete eligibility-guard prototype and its functional tests.

## Independent navigation variants

Each variant starts from the same fresh-main source and uses the same OXC
minifier (`MINIFY_PICKS=off`). The selected production minifier portfolios
were not changed. Every measured variant's served navigation hash matched its
own staged file. Brotli q11 sizes below are build-output sizes; the local
browser harness can serve a different compression encoding.

| Variant | nav.js q11 | Other bytes | Interpretation |
| --- | ---: | --- | --- |
| Baseline | 6,399 B | sprite 2,530 B; Luna 9,289 B | Common control |
| Speaker sprite | 5,833 B | sprite +269 B; Luna -8 B | nav plus sprite saves 297 B; including Luna saves 305 B |
| Lazy voices | 6,131 B | optional voices module 443 B | saves 268 B muted; adds 175 B when enabled, before request overhead |
| Resize read removed | 6,371 B | sprite and Luna unchanged | saves 28 B and one computed-style query |
| Tray reservation | 6,404 B | Luna -25 B, plus changed button markup | does not establish a startup-layout benefit |

The lazy-voices variant leaves preference ownership and AudioContext creation
and resume in nav. Only voice synthesis is imported. A cold click can authorize
the native context synchronously while the module downloads; muting before it
arrives cancels the pending sound. The module does not carry a second copy of
the preference state.

Nine alternating pairs per variant each contained a cold visit and a second
visit sharing the browser cache. Chrome used a 1280x800 viewport, 4x CPU,
1.6 Mbit/s and 150 ms RTT. Navigation and sprite transfers were zero on the
second visits. Readiness here is the Maximize control's wiring marker, so it
cannot be fooled by the tray variant's server-rendered sound label.

| Variant | Cold FCP change | Cold readiness change | Warm FCP change | Warm readiness change |
| --- | ---: | ---: | ---: | ---: |
| Speaker sprite | 0 ms | +16 ms | -4 ms | -4 ms |
| Lazy voices | 0 ms | -3 ms | +8 ms | +7 ms |
| Resize read removed | -4 ms | -5 ms | +4 ms | +6 ms |
| Tray reservation | +4 ms | +14 ms | -24 ms | -12 ms |

None of these FCP, readiness or CLS changes was significant. All recorded zero
CLS. The resize variant removed one computed-style read and one style
recalculation at the median, with no change in layout count. The baseline read
cost about 1.5 ms; this did not translate into a demonstrated frame-level win.
A forced-layout control planted 50 dirty-width reads and observed 50 layouts
and 50 style recalculations.

The tray premise needs correction: `#axp-sound { display:flex }` already gives
the hidden button a 22 px box before boot, plus its existing 7 px margin,
and it remains 22 px afterward in both Chrome and WebKit.
The proposed reservation does not create missing space. It does hide the
otherwise empty button in no-JavaScript mode. Treat that as a separate
no-JavaScript cleanup, rather than a demonstrated CLS optimization.

## First-sound latency and behavior

A separate nine-pair Chrome run warmed audio hardware and both Worker runtimes
before collecting new cold-browser contexts. It used 4x CPU, 1.6 Mbit/s and
150 ms RTT. Baseline click-to-first-oscillator scheduling had a median of 5 ms;
lazy voices had a median of 185 ms. The median paired increase was 180 ms,
with all nine pairs increasing (p=0.0039). Every context reached `running`,
and the candidate's first oscillator followed the module response. This is
scheduling latency, not measured acoustic onset. The one-off timings from the
behavior smoke tests were discarded as performance evidence because initial
audio-device startup confounded them.

Chrome and WebKit passed all five cases, including the unchanged baseline:
muted visits do not fetch voices; unmuting resumes a native AudioContext and
schedules the voices; mute state and its ARIA state track the preference; Run
opens and closes; Maximize restores to relative positioning. The lazy variant
also passed a 700 ms module-delay/mute-cancellation test, persisted opt-in, and
an unavailable-module check with no unhandled rejection or broken Run control.

WebKit uses the repository browser checker's local-HTTP preparation: remove
only `upgrade-insecure-requests` from local document responses. Production
security headers are unchanged. Each page is foregrounded and native audio
contexts are closed between cases. Every checkout builds and serves in its own
child process, through `tools/paint-serve.ts`, to keep build ownership explicit.

## Decisions

Reject the parser guard and retain the measured baseline parser policy. Speaker sprites are a small byte/ownership cleanup,
with no demonstrated paint or readiness gain in this sample. Keep lazy voices
as an experiment: 268 B saved while muted does not justify the measured cold
unmute delay here. Removing the resize read avoids one style recalculation,
without a demonstrated frame-level improvement. The tray variant addresses a
no-JavaScript empty button, rather than a missing startup-space reservation.

## Replaying a variant

Apply exactly one patch to a checkout of `dca2cdcd`, with the pinned Bun and
frozen dependencies. It also applies independently of the parser guard.

```sh
git apply docs/experiments/navigation-isolated/sprite.patch
bun run gen:shell
MINIFY_PICKS=off bun run build
```

For `sound.patch` or `resize.patch`, `gen:shell` is unnecessary. Sprite and tray
patches change generator inputs; generate their Worker partial, sprite and
static-page shells instead of editing those outputs. Do not apply all four
patches to create a production bundle: these measurements isolate each change.

The byte results are deterministic for this toolchain. Timings are local
emulation results, not field Web Vitals. The navigation experiments use one
representative page, Privacy; further page coverage and minifier selection are
needed before promoting a navigation variant.

## Checks and interpretation

The pinned Bun and frozen dependencies built the guard prototype successfully.
Its local `check:fast` passed 1,913 tests, lint, formatting and the ratcheted
typecheck. These functional passes did not establish a first-paint benefit.
The prototype mutation controls caught loss of its proposed eligibility rule
and a pause before the protected first fold. The final regression test instead
requires long non-quiz pages to retain their measured first-paint pause; its
control plants the rejected eligibility guard. The route oracle passed 386
routes. Page contracts passed; derivations found seven fresh outputs, zero
stale outputs and ten unverifiable entries. Performance-budget hard checks
passed with the same five advisory categories as the baseline.

The guard prototype's seven-page browser sweep covered all five affected pages plus Compression
and LWE/FHE: Chrome at desktop and phone sizes, WebKit at phone sizes, zero
failures, zero stale budgets and every applicable planted control caught.
WebKit cannot read CLS or CSP in this harness; Chrome covered those readings.
All four navigation patches apply cleanly to the baseline and introduce no
additional browser/tools type diagnostics in the raw compiler comparison.
They remain experiments and require full release checks and minifier picking
before promotion.

Garage and LWE/FHE quizzes also rendered and accepted an answer in both
Chrome and WebKit. The control runner reuses PR #1836's baseline isolation and
full failure diagnostics: unplanted checks run sequentially, while planted
cases retain their parallel pool. This avoids the previously demonstrated
loaded-run minifier-parity failure without changing any assertion or timeout.

The CI paint comparison also inherited the blind `/search` control found in
#1836: holding its sheets did not delay paint, so the sweep stopped before
reading the changed pages. This PR reuses the dedicated blocking-CSS fixture
and minimum six-pair validation from that fix. The statistical thresholds and
real-page measurements are unchanged.

Speaker icon crops were pixel-identical in muted and enabled states between
inline SVG and sprite in Chrome and WebKit at the tested desktop viewport.
A changed-state visual control produced a mean absolute channel difference
over 34; each matching pair had zero difference.
