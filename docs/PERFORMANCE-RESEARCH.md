# Performance autoresearch

Performance work here runs as a sequence of falsifiable experiments. The loop rewards user-visible latency wins while preserving the site's behavior and public contracts.

This adapts Sankalp's [auto-research workflow](https://sankalp.bearblog.dev/autoresearch/) to a website. His kernel had one deterministic score. This site has browser noise, distinct routes, and several kinds of latency.

The verifier therefore uses a scenario matrix and regression guardrails. A normalized geomean ranks candidates, but it never averages away a slower route.

## Starting evidence

The production homepage was already fast when this loop landed. An unthrottled Chrome trace on 2026-08-16 measured 241 ms LCP, 25 ms TTFB, and 0.0012 CLS.

DevTools estimated zero LCP savings. Its document insight called the `dcz` response uncompressed, although the same response carried `content-encoding: dcz`. That warning is an instrument mismatch.

The existing Run interaction lab produced these results at 6x CPU throttling and 12 samples per interaction:

| interaction | median | max |
|---|---:|---:|
| Start orb opens Run | 72 ms | 80 ms |
| Command-K opens Run | 72 ms | 88 ms |
| Run filter keystroke | 32 ms | 48 ms |
| Escape closes Run | 48 ms | 48 ms |

These numbers make the homepage a regression sentinel. They do not justify a homepage rewrite or an INP optimization by themselves.

## Objective and verifier

Improve a measured user-visible scenario without slowing another protected scenario. Preserve tooltips, infotips, randomized photos, progressive images, page semantics, public routes, and release behavior.

A candidate receives one of three decisions:

- `promote`: one scenario materially improves and no protected scenario materially regresses. Latency needs at least 10 percent and 16 ms; CLS must cross from above 0.1 to at most 0.1, or improve by at least 0.02 and 10 percent.
- `reject`: LCP, FCP, TTFB, CLS, or interaction latency crosses a regression guardrail.
- `inconclusive`: movement stays below the lab's resolution. Record the result without claiming a win.

Event Timing rounds durations to 8 ms. The 16 ms floor requires two quantization steps before the loop treats movement as evidence.

The normalized geomean ranks candidates inside a beam. Promotion remains Pareto-style: a large win cannot hide a material loss elsewhere.

The navigation tail guard uses p75. Seven samples would make p90 equal the single maximum, so a lone cold outlier triggers a repeat instead of a rejection.

## Instruments

The loop uses three separate instruments because each answers a different question.

1. `pnpm run perf:nav` measures cold LCP, FCP, TTFB, load time, CLS, request count, and transfer size across six page and viewport scenarios.
2. `pnpm run inp` measures trusted Run interactions under CPU throttling. `--out` now writes raw samples and summaries as schema 1 JSON.
3. `pnpm run perf:snapshot` compares deterministic wire bytes and Worker modules. It remains the authority for network cost.

The navigation lab applies CPU throttling and creates a fresh browser context for every sample. It leaves CDP's Network domain detached because that domain suppresses Chrome's Early Hints behavior.

The lab uses an unthrottled local network. Read its LCP as render and main-thread evidence. Read `perf:snapshot` for bytes, then confirm finalists against production.

## Baseline and candidate protocol

Use fresh worktrees from the same `origin/main`. Start the baseline and candidate servers on separate ports, then let one browser process interleave A/B samples. The recorder alternates arm order each pair so temperature and Chrome drift do not consistently favor either side.

Build and serve the production-shaped config. `wrangler.dev.jsonc` serves readable, unminified sources and would measure a different artifact.

Run both recordings with the candidate worktree's copy of the lab. It validates the final origin after navigation, so a redirect to another site cannot masquerade as a slow local page.

```bash
# Baseline worktree, terminal 1
pnpm install --frozen-lockfile
pnpm exec wrangler dev -c wrangler.jsonc --port 8800

# Candidate worktree, terminal 2
pnpm install --frozen-lockfile
pnpm exec wrangler dev -c wrangler.jsonc --port 8799

# Recording from the candidate worktree, terminal 3
pnpm run perf:nav -- --url http://127.0.0.1:8800 \
  --candidate-url http://127.0.0.1:8799 --throttle 6 --runs 9 \
  --label origin-main --candidate-label candidate \
  --baseline-out .perf-research/base-nav.json \
  --candidate-out .perf-research/candidate-nav.json
pnpm run perf:research -- compare \
  .perf-research/base-nav.json \
  .perf-research/candidate-nav.json \
  --out .perf-research/navigation.md \
  --json .perf-research/navigation-decision.json
```

Record interactions one arm at a time; the navigation pairing flags do not apply to the trusted-interaction lab.

```bash
pnpm run inp --url http://127.0.0.1:8800 --throttle 6 --runs 12 \
  --label origin-main --out .perf-research/base-inp.json
pnpm run inp --url http://127.0.0.1:8799 --throttle 6 --runs 12 \
  --label candidate --out .perf-research/candidate-inp.json
pnpm run perf:research -- compare \
  .perf-research/base-inp.json \
  .perf-research/candidate-inp.json \
  --out .perf-research/inp.md \
  --json .perf-research/inp-decision.json
```

The comparator exits `0` for promote, `1` for reject or invalid input, and `2` for inconclusive.

Repeat a surprising result with more pairs or a separate A/B/A run. Pairing reduces drift; it does not erase background load or thermal effects.

## First trial

The first live loop on 2026-08-16 did useful negative work before it found a winner.

| experiment | prediction | result | decision |
|---|---|---|---|
| defer offscreen Garage cards with `content-visibility` | reduce initial rendering cost on the dense Garage page | no repeatable Garage LCP improvement in A/B/A | reject |
| replace long-note `field-sizing: content` with a fixed initial height | reduce mobile Writing layout work | median LCP moved 376 ms to 372 ms; layout cost regressed | reject |
| load Luna shell CSS at parse time on `/lwe/encoding` | prevent the late full-shell restyle | paired 9-run CLS moved 1.011 to 0.010; LCP stayed effectively flat at 424 ms to 416 ms | promote |

The scan also produced one false lead: `/rn` looked like a 4.28 s local LCP until inspection showed that it had redirected to Spotify. Final-origin validation is now part of the recorder.

The promoted result fixes visual stability, not nominal load latency. A 20-pair confirmation reproduced the same CLS movement (1.011 to 0.010) while median LCP stayed within the lab's resolution (420 ms to 416 ms). The cause was concrete: the generated page painted an unstyled desktop shell, then deferred `nav.js` injected `/luna.css` and shifted the whole viewport.

## Build and dependency trials

Browser metrics cannot rank developer-only work. Build and dependency trials
use median wall time as their score, with the staged site's bytes as a hard
correctness gate.

| experiment | prediction | result | decision |
|---|---|---|---|
| align Wrangler with the coffee test pool | remove a duplicate Cloudflare toolchain from installs | five-run median fell 4.62 s to 3.03 s; `node_modules` fell 781 MiB to 562 MiB | promote |
| run independent Brotli q11 jobs in Node's worker pool | reduce the build's dominant synchronous compression cost | ten-pair median fell 3.66 s to 2.43 s; five-pair Wrangler dry run fell 4.91 s to 3.71 s | promote |

Both candidates produced a staged tree identical to `origin/main`. Two build
variants failed the promotion bar. Eight libuv workers saved only 0.14 s and
depended on machine topology. Async Zstandard changed every `.dcz` output.

## Second pass

The next browser profile found 212 ms of layout work on `/lwe/encoding`, but
layout containment did not produce trustworthy evidence. A rebuilt candidate
server had been mixed with the CSS trial, so the loop discarded that result.

The useful cost sat in the page's inline program. Its offscreen chroma demo
allocated three image planes and processed every pixel before first paint.

| experiment | prediction | result | decision |
|---|---|---|---|
| defer the chroma simulation until its canvas nears the viewport | remove offscreen pixel work from first paint | 20-pair mobile LCP fell 396 ms to 356 ms; CLS held at 0.010 | promote, draft PR #425 |
| batch page DCZ jobs across worker threads | parallelize the 477 ms Zstandard profile leaf without changing bytes | ten-pair build median fell 2.505 s to 2.177 s; staged trees matched | promote, draft PR #426 |
| resolve Vite and Wrangler to one esbuild version | remove the final duplicated native tool | install size fell 20.8 MiB, but install time stayed at 3.20 s and the change dropped 0.28.2 correctness fixes | reject |

The browser candidate added 0.13 KiB Brotli to one page and changed no client
asset. The build candidate reduced a full Wrangler dry run by 7.7 percent.
Both passed the repository's local correctness and dry-run gates.

## Experiment loop

Start with a profile or a measured slow scenario. Write one sentence that predicts which cost will move and why.

Maintain a small beam when evidence supports it:

- an exploit family near the best measured candidate;
- a near-miss family with a repeatable isolated win;
- a structural family aimed at a different profiled cost.

The first trial established the navigation baseline, killed two unsupported families, and promoted one shell-stability fix. Start the next beam from a newly profiled material cost, not from one of the rejected patches.

For each experiment:

1. Create one branch or worktree from the current baseline.
2. Record the family, parent, hypothesis, exact changed functions, and predicted metric.
3. Run the narrow correctness check before the browser lab.
4. Measure the candidate under the same browser, throttle, sample count, and scenario list.
5. Compare the result and append one row to `docs/performance-experiments.jsonl`.
6. Run `pnpm run perf:snapshot` for any candidate that clears the browser gate.
7. Run the repository's authoritative checks before promotion.

For build and install trials, require at least five runs and a 10 percent median
wall-time improvement. Build candidates use paired, interleaved runs from the
same commit and dependency tree. Dependency candidates use clean installs with
the same warm pnpm store.

Recursively compare `.build` against the baseline before promotion. Dependency
trials must also record installed size and resolved copies for the packages they
claim to deduplicate. Include a Wrangler dry run for changes that affect the
build or deployment toolchain.

Retain a near miss only when it shows repeatable local evidence or attacks an independently profiled cost. Kill a family after repeated regressions, a correctness contradiction, or evidence that its target is immaterial.

## Correctness and release gates

A browser `promote` decision does not authorize a merge or deployment. A candidate still needs:

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run perf-budget
pnpm run routes:check
pnpm run pages:check
git diff --check
```

Review the wire-size diff and generated artifacts. Run narrower checks while iterating, then use the full relevant set before publication.

Keep deployment outside the loop. Experiments may build, serve locally, and read production. They must not push traffic, mutate Cloudflare state, or weaken a test to improve a score.

## Goal prompt

Use this as the starting prompt for a long-running Codex goal:

> Improve the slowest evidence-backed browser scenario in `docs/PERFORMANCE-RESEARCH.md`. Work from fresh `origin/main` in isolated worktrees. Maintain a small beam of distinct hypotheses. For each experiment, predict the metric, preserve all site contracts, run the narrow correctness check, record browser JSON, compare it with the same baseline, and append the result to `docs/performance-experiments.jsonl`. Promote only a repeatable `promote` result whose wire-size diff and authoritative checks pass. Treat timeouts and sub-resolution movement as inconclusive. Stop when one candidate clears every gate or profiling shows no material cost left in scope. Do not deploy.
