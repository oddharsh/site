# Gotchas

Traps this repo has already paid for. Code comments cite them by number
("gotcha 16"), and `contract-gotcha-numbers-resolve` fails if a cited number
has no entry, so numbers are permanent: retire an entry by deleting it, never
by renumbering. The long-form history of each one is in git
(`git log -p -- CLAUDE.md`, before 2026-10-03).

Each entry ends with a `Checked by:` line. It names the files that fail when
the mistake comes back, and each of those files cites the gotcha by number, so
a deleted or renamed check breaks the link loudly. An entry nothing can check
says `nothing (judgment)` when someone has to remember it, `nothing (fails
loudly)` when the mistake already errors on its own, or `nothing (how to
measure)` when it's a method rather than a rule. Some named checks run in
`validate`; others are commands you run by hand, like `served:check`.
`contract-gotcha-numbers-resolve` holds every line to this.

When you add a gotcha, try to make it checkable before you write it down. A
`judgment` entry is the last resort, because nothing fails when an agent
skips it.

## Gotchas

1. **Thumbnail 404s must be uncacheable.** A miss under `/images/*` would
   inherit the immutable cache rule, so `/images/<thumb>` stays worker-first
   and the Worker clamps the 404. A re-encode mints a new `/i/` URL, so there's
   no version to bump.
   Checked by: nothing (judgment).

3. **Rotate photos by sample permutation, never in the DCT domain.**
   `jpegtran -rotate` is only lossless when the constraint edge is iMCU-aligned
   and degrades silently without `-perfect`. `zenc square|resize --orient N`
   permutes decoded pixels instead, exact at any size. jpegtran stays for the
   progressive reorder of the R2 copies.
   Checked by: `tools/tests/contract-photo-pipeline-failures.test.ts`.

6. **EXIF orientations 5-8 swap width and height.** Transpose source
   dimensions before writing `metadata.json`.
   Checked by: nothing (judgment).

7. **`<picture>` falls back on unsupported TYPES, never on decode failures.**
   If broken-image reports appear, demote AVIF; adding `<source>` tiers won't
   help.
   Checked by: nothing (judgment).

8. **No `<a>` inside `<a>`.** Artist links inside a track row are
   `<span class="np-artist-link" role="link" tabindex="0" data-href>` plus a
   delegated click handler.
   Checked by: nothing (judgment).

10. **Gate hover features on `(hover: none)`.** Touch long-press fires
    synthetic mouseover.
    Checked by: nothing (judgment).

11. **`will-change` is earned per interaction.** Toggle it around the hover
    lifecycle; a permanent one holds a compositor layer.
    Checked by: nothing (judgment).

13. **Anything that rebuilds a Response must preserve `encodeBody`.** It's
    write-only and has no getter. `new Response(r.body, r)` keeps it;
    `new Response(r.body, { status, headers })` drops it and the runtime
    double-compresses. Rebuild with the response as init, then mutate headers.
    `contract-encodebody-survives-a-rebuild-in-workerd` checks the shapes in
    real workerd. Also: the Worker sees a rewritten `Accept-Encoding`, and the
    edge down-converts br for clients that don't take it, so don't negotiate
    compression in the Worker.
    Checked by: `tools/tests/contract-encodebody-survives-a-rebuild-in-workerd.test.ts`, `tools/tests/contract-the-speculation-ledger.test.ts`.

14. **Deltas are dcz (zstd), plain responses are brotli q11.** dcz wins on
    decode time, which scales with the reconstruction rather than the delta.
    Level 19 is optimal at this size. `src/dict/{a,p,f}-dict` are committed
    because a dictionary must be bytes a browser already holds; the roll
    (`bun run dict:roll`) reads production. Probe an engine's dictionary
    support with a no/right/wrong-dictionary control: an engine that ignores
    the option still decodes, so the failure is silent.
    Checked by: `tools/check-q11.ts`.

15. **Read a browser feature off two signals, and suspect the instrument
    first.** For Early Hints: `initiatorType === "early-hints"` plus a fetch
    duration too short for the bytes. Two
    unrelated origins failing identically means the harness is lying. Confirm
    paint claims in a visible window.
    Checked by: nothing (how to measure).

16. **Only `src/worker/index.ts` may import `cloudflare:workers`.** Everything
    else is also imported by the contract suite outside workerd. Tracing is
    injected (`installTracing`) instead. Nothing cal imports may reach
    `cloudflare:workers`, directly or transitively.
    Checked by: `tools/tests/contract-census-never-publishes-a-refused-check.test.ts`.

17. **`script-src` is per-document sha256 hashes, computed at build.**
    `lib/csp-hashes.ts` ships empty and build step 7c fills it; a path with no
    entry falls back to `'unsafe-inline'`, and the build fails below 40
    covered documents. Event-handler attributes can't be hashed and fail the
    build. Worker-rendered `lunaPage` output hashes its own. Island fragments
    (`islandResponse`, cal's slot list) send `script-src 'self'` with no
    hashes, since `innerHTML` never runs their scripts. `bun run csp:sweep` is
    the browser check; perturb one script as its control.
    Checked by: `tools/tests/contract-worker-pages-hash-their-inline-scripts.test.ts`.

18. **`scrollbar-color` inherits and disables `::-webkit-scrollbar` rules.**
    So does a non-auto `scrollbar-width` on the element itself. Reset to
    `auto` and give Firefox the standard property behind
    `@supports (not selector(::-webkit-scrollbar)) or selector(:-moz-focusring)`.
    Don't use `(-moz-appearance:none)`: Lightning CSS strips the prefix from a
    non-first operand (lightningcss#710, fix in #1316), so the arm applies
    everywhere.
    Checked by: nothing (judgment).

19. **No backticks in CSS comments inside `/*min*/` template literals.** They
    end the JS literal.
    Checked by: nothing (fails loudly).

20. **An edge feature that rewrites HTML after the Worker breaks anything
    derived from the Worker's output**, dictionaries first. Derive from the
    wire or verify the wire equals the build. Prune dictionary snapshots by
    commit time, never mtime (`git checkout` resets mtime).
    Checked by: `tools/check-served.ts`.

23. **An AI Gateway id is a hard dependency.** A wrong id fails inference
    rather than falling back, so it comes from config, never a literal.
    Gateway caching stays off where a repeated request should get a fresh
    answer.
    Checked by: `tools/tests/contract-serendipity-event-tags.test.ts`.

24. **`deploy:promote` reads `checkpoints.json` from your working tree.** Ramp
    from a fresh worktree at `origin/main`, or the changelog row is silently
    skipped.
    Checked by: `tools/deploy-promote.ts`, `tools/tests/contract-encode-read-the-container-decode-nothing.test.ts`.

25. **After changing a secret, don't ramp a version built before the change.**
    Secret versions carry no alias, so the ramp skips them; a version built
    later inherits the current secret set. Check with
    `bun run wrangler:site versions view <id>`.
    Checked by: nothing (judgment).

26. **`run_worker_first` caps at 100 RAW rows.** Duplicates count. The list is
    derived from `src/worker/routes.ts`; check for a covering wildcard before
    adding a row. `wrangler deploy --dry-run` catches an over-cap config.
    Checked by: `tools/tests/contract-the-route-list-derives-every-route-list.test.ts`.

27. **A red `github-advanced-security` check is usually Copilot's agent
    failing, not your diff.** The tell is `CAPIError: 400` in the job log
    (`gh run view <run-id> --log-failed`, where the run id is the middle
    number in `details_url`). It isn't required and gates nothing.
    Checked by: nothing (judgment).

28. **A bun pin change must preserve build bytes.** `/a/` and `/i/` are
    content-addressed, so `bun run bun:pin` gates a candidate on a
    byte-identical build. Keep both `bun run test` and `bun run test:node`:
    they disagree on real runtime facts.
    Checked by: `tools/bump-bun-pin.ts`.

29. **Run wrangler through `wranglerCommand()` (node plus the pinned entry
    file), never `npx` or `bun x`**, which fetch whatever they can't resolve.
    Change a Workers Builds command in the dashboard FIRST, then
    `config/infra.json`.
    Checked by: `tools/tests/contract-the-typescript-quarantine.test.ts`.

31. **`_headers` rules combine rather than override.** Two `Cache-Control`
    values ship as one malformed header. To replace one, put the narrow rule
    AFTER the glob and detach with `! Cache-Control` first; a detach above the
    rule it targets does nothing.
    Checked by: nothing (judgment).

32. **`bun run pages:check` lints page text and is required.** It bans em
    dashes, AI filler and "X, not Y" negations, but only in the quiz and
    editorial fields; lint your own diff for the rest. #1001 folded CI into
    one job on 2026-09-28 and left it out until 2026-10-14; `contract-ci-required-gate` now fails
    if `validate` stops running it.
    Checked by: `tools/check-page-contracts.ts`, `tools/tests/contract-ci-required-gate.test.ts`.

33. **A speculation rule can't be measured from the page or from an agent's
    backgrounded tab.** Count at the origin (`Sec-Purpose`) from a headful,
    visible window, beside a control that does reach it. The probe that did
    this left the tree on 2026-10-24: `git show 8c013511:tools/speculation-probe.ts`.
    Checked by: nothing (how to measure).

34. **Read every hunk `oxlint --fix` produces.** `no-useless-spread` broke a
    `TypedArray.map` once; that rule is off.
    Checked by: nothing (judgment).

35. **Editing a hashed `/a/` asset re-mints every page that references it,
    and a comment is free.** Minification strips comments, so the hash holds.
    Grep built pages for the asset's URL to see the bill.
    Checked by: nothing (judgment).

36. **Workers Free: 50 subrequests per invocation, and CPU clamps under
    load.** Every fetch counts, and every redirect hop. KV and D1 were believed
    to count and production says they don't: on four days in 2026-09/10 the
    /around crawl hit the cap and its KV put and D1 batch still succeeded in
    the same invocation (lib/budget.ts). Local workerd enforces no cap at all
    (1,200 fetches pass), so `bun run dev` can't reproduce one. A fan-out
    that catches per-item errors will silently degrade every item when it
    hits the cap. Meter hops with `meteredTransport`, the only way a ledger
    sees a redirect chain. Count the failures on a span; measure CPU
    off `cpuTime`, never status codes. Pin a version with the FULL UUID in
    `Cloudflare-Workers-Version-Overrides`. A workflow's conclusion doesn't
    say whether a release shipped: ask `bun run deploy:promote --status`.
    Checked by: `tools/tests/contract-lens-compare-stays-under-the-subrequest-cap.test.ts`, `tools/tests/contract-no-cron-tick-outspends-the-subrequest-cap.test.ts`.

37. **`Bun.Image` is the OS imaging stack.** It's fine for a throwaway
    thumbnail and wrong for a served tier: fatter output, no 16-bit HEIF
    decode, and `resize` differs by backend unless `Bun.Image.backend = "bun"`.
    It validates no encoder option (oven-sh/bun#40490).
    Checked by: nothing (judgment).

38. **Bun is the toolchain; node stays for wrangler and the route oracle.**
    Wrangler refuses some subcommands under bun, and miniflare's
    `dispatchFetch` needs fetch to honour `{ dispatcher }`, which bun doesn't
    (oven-sh/bun#39247). Bun tests that dispatch through the harness wrap
    their body in `underNode()`. Check support per command, never per tool.
    Checked by: nothing (judgment).

39. **A dev server on your port may belong to another checkout.** Check the
    process's cwd (`lsof -a -p <pid> -d cwd`) before trusting a response, and
    bind an explicit free port.
    Checked by: nothing (judgment).

40. **Resolve paths from a named anchor, and keep `set -euo pipefail`.**
    `$SCRIPT_DIR/..` silently changes meaning when a script moves. `$?` after a
    pipe is the LAST command's; under zsh the first stage is `$pipestatus[1]`,
    under bash `${PIPESTATUS[0]}`. An empty array under bash 3.2 `-u` needs
    `${A+"${A[@]}"}`.
    Checked by: `tools/tests/contract-committed-shell-scripts-fail-loudly.test.ts`.

41. **cf-garage, lwe-ask and lens-reader use wrangler's TypeScript config.**
    Commands need `--x-new-config` and must run from the Worker's own
    directory (`-c` is refused). `bun run --bun` in front of the config loader
    is refused; the `.bin` shim runs node and works.
    Checked by: nothing (fails loudly).

42. **JSDoc type tags are inert in `.ts` files.** Write real annotations; a
    contract test fails on a JSDoc type tag in `.ts`.
    Checked by: `tools/tests/contract-the-typescript-quarantine.test.ts`.

43. **`avifenc --jobs` changes output bytes.** 1 differs from 2+. Treat every
    concurrency flag on an encoder feeding `/i/` as a quality flag.
    Checked by: nothing (judgment).

44. **A worktree under `.claude/worktrees/` resolves modules from the
    parent's `node_modules`.** Validate dependency removals from a detached
    worktree outside the checkout with a fresh install. Only
    `rm -rf node_modules && bun install --frozen-lockfile` really removes a
    package.
    Checked by: nothing (judgment).

45. **On macOS, `mkdtemp(tmpdir())` returns `/var/...` and anything that
    canonicalises reads `/private/var/...`.** `realpath` fixture roots, and
    use `import.meta.main` for main-module guards.
    Checked by: `tools/tests/contract-main-module-guards-survive-a-symlinked-path.test.ts`.

46. **Anything derived from a content-addressed file must be regenerated when
    the hash moves.** `bun run derive:check` compares each derived artifact
    against the inputs recorded in `config/derivations.json`;
    `-- --lock` re-records after a deliberate regeneration.
    Checked by: `tools/tests/contract-derived-artifacts-name-what-they-were-made-from.test.ts`.

48. **The site config is TypeScript, and most wrangler commands can't read
    it.** `cloudflare.config.ts` + `wrangler.config.ts` are projected by
    `tools/lib/site-config.ts` to a gitignored `.wrangler.site.jsonc`. Use
    `bun run wrangler:site <command>`; tools use `siteWranglerArgs()`. Local
    dev is `config/dev/`, an overlay `cf dev` reads natively (`tools/dev.ts`);
    only `dev:remote` still projects it to `.wrangler.dev.jsonc`.
    Checked by: nothing (fails loudly).

49. **Read bun test's counts from its summary rows, never from anywhere in the
    output.** An unanchored `/(\d+) fail/` matched "D1 fails" in a passing
    test's name and filed RED issues against a healthy bun for two nights
    (#1122, #1124). Use `suiteCounts()` from `tools/lib/bun-gates.ts`. A
    count with no `(fail)` row beside it is the tell.
    Checked by: `tools/tests/contract-the-bun-pin-is-declared-once.test.ts`.

50. **`cf` can't replace wrangler here yet; it runs wrangler underneath.**
    Audited on cf 1.0.0-beta.12 (2026-10-05). `cf build` and `cf dev` print
    "Delegating to Wrangler" and spawn the project's own wrangler, so the pin
    stays either way. `cf deploy` and `cf workers versions create` hardcode
    `resourcesProvision: true` and `experimentalAutoCreate: true` (in cf's
    `deploy-input` chunk) with no flag to turn them off, which breaks the
    rule that no deploy path creates resources. The tests, `routes:check` and
    `gen-runtime-types` use wrangler as a library (`createTestHarness`,
    `wrangler types`), which cf has no stand-in for. And cf's CLI half pins its
    own miniflare (5.20260930.0-alpha), a second workerd in the tree. Account
    work goes through `cf` via `tools/lib/cf.ts` (deploy:promote, D1 reads,
    KV seeding, Browser Run, Workers Builds), with two exceptions. The photo
    upload stays on `wrangler r2 object put`, because `cf r2 objects put
    --dry-run` shows `/` in a key sent as `%2F`, and R2's API says slashes
    must go literally.
    The Workers AI evals keep `wrangler auth token`, because cf has no command
    that prints its token. Re-audit when cf ships a no-provision switch.
    Checked by: nothing (judgment).

51. **A Rust compiler bump can fail strict Clippy on unchanged source.**
    Rust 1.99 adds `chunks_exact_to_as_chunks`; fixed-size pixel loops use
    `as_chunks::<N>().0.iter()` and `as_chunks_mut::<N>().0.iter_mut()`.
    Both retain the old iterator's treatment of a trailing partial chunk.
    Run zenc's tests and `clippy --all-targets -- -D warnings`, including its
    example, then compare encoded output and reproduce the committed histograms.
    Checked by: nothing (judgment).

52. **A Bun canary's `--version` does not prove it has `bun check`.** The
    installed binary and the 2026-10-06 npm canary both reported 1.4.3 but
    predated the checker. GitHub's later canary at `bbdc5a519` had it.
    Verify the full `Bun.revision` and `bun check --help`. The pin followed
    the rolling GitHub canary from 2026-10-06 until release 1.4.3 carried the
    checker; when selected, the shared installer verifies its digest and
    commit, then records both in `bun.install.json` beside Bun.
    Bun's checker also lacks `--showConfig`. Use
    `--listFilesOnly --noResolve` to discover files selected directly by a
    config, separately from the import graph.
    On 2026-10-06 the rolling archive hashed to `07b1b4b6`, matching the
    GitHub asset digest, while Bun's `SHASUMS256.txt` named `08d2883f`.
    Keep the API digest check; do not trust the manifest as a workaround for
    an API 403. Retries cannot fix that 403 either: Workers Builds reads the
    API with no token from shared Cloudflare IPs, where other tenants drain
    the 60 requests an hour, and build 8358ea90 (2026-10-08) died on four
    403s two seconds apart. Any API failure now reads the same digest and
    commit from github.com's release pages (all 34 digests matched the API's
    that day). `INSTALL_BUN_METADATA=pages` forces that path, and
    canary.yml runs it nightly so a GitHub markup change shows up there
    rather than in a deploy.
    Checked by: `.github/install-bun.sh`, `tools/typecheck.ts`.

53. **Wrangler's `--outfile` is a multipart upload, with a random boundary.**
    Two byte-identical Workers can give different upload-file hashes. Compare
    the named `index.js`, `index.js.map`, and `metadata` parts before blaming
    a Bun or bundler change; keep public asset comparisons byte-for-byte.
    Checked by: nothing (judgment).

54. **A background CI step can weaken the gate without failing it.** Since
    2026-10-06 `validate` runs independent checks as Actions `background`
    steps. Two of the contract tests that read `.build/` skip ("needs a
    build") when it is missing, so a suite started beside the build passes
    with less coverage instead of failing. `lint` and `typecheck` both open
    with `gen-runtime-types.ts`, which deletes and rewrites cf-garage's types
    on a fresh checkout. Before backgrounding a step, list what it writes and
    what reads it; `contract-ci-required-gate` holds the edges known today.
    Checked by: `tools/tests/contract-ci-required-gate.test.ts`.

55. **A tripwire that walks `servedFiles()` never reads `src/client` or
    `src/styles`.** `servedFiles()` walks `AUTHORED_ROOTS` (`public`,
    `src/pages`, `src/content`), the roots that used to be `www/`. Islands and
    stylesheets left them in the 2026-08-18 split, so the taste scan
    (invariant 9) never read luna.css or any island. A web font in `prose.css`
    built clean until #1249. Checks 3 and 10 named both roots but read them
    flat, missing `src/client/garage/` and `src/client/lwe/`. A tripwire takes
    those roots from `shellFiles()` in `tools/build.ts`, and proves its reach
    by planting a violation in a file only the new list covers. A widened scan
    that reports nothing new looks exactly like one that reads nothing.
    Checked by: `tools/build.ts`.

56. **Top-level I/O in a lazily imported module works only while wrangler
    inlines it.** Wrangler ships the Worker as one module. esbuild turns
    `await import("./x.ts")` into an `__esm` initializer that runs inside the
    request, so `crypto.getRandomValues`, timers and `fetch` at the module's
    top level work. The same module runs in global scope when workerd loads
    it as its own module: `no_bundle`, `find_additional_modules`, a split
    build, or a test harness with one module per file. There random values
    and timers throw "Disallowed operation called within global scope" under
    either module registry; `fetch` throws too under the old registry, and
    goes out under `new_module_registry`. Under that flag `process.cwd()` reads
    `/`, where the handler sees `/bundle`. Measured 2026-10-09 on both shapes.
    Nothing in the Worker lazy-loads today; if something does, keep its top
    level to definitions and do the I/O in a function the handler calls.
    Checked by: `tools/tests/contract-the-worker-imports-nothing-lazily.test.ts`.

57. **A CPU factor per runner model can't see one slow runner.** The CPU
    sweep scales each GitHub runner's CPU model to the EPYC 7763 by a fitted
    factor. On 2026-10-09 one EPYC 9V74 read every route 1.27x higher than the
    model's six other runs. The gate failed six routes on #1273, a PR that
    changed no Worker byte. Refitting the factor wouldn't have saved it: a
    factor is a model's usual runner, and this runner was unusual. The control's
    spread (its IQR) missed it too, at 0.30 ms, because a host that's slow all
    over reads tight. Its median caught it, 33% over the reference where
    ordinary runs stay within 16%, so `config/cpu-budget.json` `control` now
    makes such a run inconclusive.
    Checked by: `tools/tests/contract-cpu-sweep-can-tell-slow-from-fast.test.ts`.

58. **Cloudflare's on-demand CPU profile reads wall time on a quiet Worker.**
    `cf workers versions profile` samples a live isolate, and between this
    site's requests that isolate sits idle. The idle time isn't recorded as
    `(idle)`: each gap lands on the first JS frame that runs after it, so
    request entries, KV and Cache API resumptions, and whatever helper happens
    to be on the stack soak up seconds. On 2026-10-09, 10 s of `/cache`
    traffic, which Workers Logs bills at about 1 ms a request, profiled as
    7.85 s of CPU with 2 s on a string helper in `lib/tui.ts`. It also only
    sees warm isolates, while a real visitor here almost always lands on a cold
    one. Rank and cost with billed `cpuTimeMs` from Workers Logs (`cf o11y
    telemetry query`, grouped by `$metadata.trigger`), then profile the cold
    request in node with real KV values, the way `tools/cpu-sweep.ts` does.
    Checked by: nothing (how to measure).

59. **Wrangler refuses to deploy beside `.cloudflare/output`, and a dry run
    can't show it.** Since 4d90f32 (workers-sdk#16128, pinned in #1271),
    `deploy`, `versions upload` and `preview` stop with "builds for the
    Cloudflare CLI" when the working directory or the config's directory
    holds `.cloudflare/output/v0/config.json`. `tools/gen-runtime-types.ts`
    wrote exactly that in `cf-garage/` before every typecheck and lint, so a
    workstation deploy of cf-garage after either was refused. Workers Builds
    clones clean and never saw it. All three call sites skip the guard under
    `--dry-run`, so the obvious check passes either way. Measured 2026-10-11
    with no credential instead: refused with the tree, and past the guard to
    the API-token error without it. The script now deletes the tree on every
    run.
    Checked by: `tools/gen-runtime-types.ts`.

60. **An edge check that asserts an absence passes on any page that isn't
    production.** `infra:check`'s edge tier never asked who answered. On
    2026-10-13 an agent sandbox's egress proxy answered every aadhar.sh
    request with a 67-byte `text/plain` 403, and the run read it as the
    zone: `speed-brain-off`, `rocket-loader-off` and `webmcp-bridge-off`
    held, because an error page lacks every header and script, while HSTS,
    brotli and h3 read as 8 drifts. The 0-RTT probe did the same at the
    TLS layer and reported "rejected" for handshakes that never connected,
    and the agent Markdown sweep counted the six `text/plain` surfaces as
    answering. Edge reads now go through `servedByEdge`: only answers that
    carry `cf-ray`, which Cloudflare stamps on every response it serves (a
    401 included), are measured. The probe counts a resumption only after a
    handshake completed, and the sweep passes only when every probe was
    measured. Each miss is an advisory now. The contract test replays the
    proxy's exact bytes, with and without `cf-ray`.
    Checked by: `tools/tests/contract-infra-check-compares-declared-against-observed.test.ts`.

61. **A dedicated worker enforces the CSP on its own script, never the
    page's.** Measured in Chrome 152 on 2026-10-13 with a page and a module
    worker that each did or didn't allow `'wasm-unsafe-eval'`: the worker's
    WebAssembly compile followed only the worker response's header, and a
    worker served with no CSP compiled freely under a page that forbade it.
    So `/garage/av2`'s decoder takes the token on its worker script alone
    (`public/_headers`, `/a/av2-decode.*`), and the page keeps the hashed
    document policy. Two traps around it: a `_headers` CSP rule combines with
    the `/*` one (gotcha 31), so it needs `! Content-Security-Policy` first;
    and a module that sets `onmessage` on `globalThis` outside a worker keeps
    Bun's event loop open, so a contract test that imports it never exits.
    Checked by: nothing (judgment).

62. **A clean diff after a generator can't tell "unchanged" from "never
    written".** `og-cards.yml` decides whether to open a PR from
    `git status` after the bake. Its first dispatch (run 38481736111,
    2026-10-13) went green and proposed nothing: cards had been zenc JPEGs
    since 2026-09-16, the workflow never built zenc, and
    `gen-og-cards.ts` caught each card's error, printed `0/1 cards
    written` and exited 0. A failed card leaves its old JPEG in place, so
    the tree read clean and the next step printed "Every card already
    matches what production renders". #1317 builds zenc in the workflow
    and exits 1 when any card fails; the next dispatch built it, wrote the
    card and opened #1318. Any generator whose output is committed owes its
    caller an exit code, because the diff can only show what changed.
    Checked by: `tools/photos/gen-og-cards.ts`.

63. **An edge 504 with origin status 0 is usually a cache miss, not an
    error.** Zone analytics for 2026-09-14 to 10-14 held 18,921 of them
    and none reached a visitor. `requestSource` splits them: 14,398
    `edgeWorkerCacheAPI` (a `cache.match()` miss, which Workers sees as
    `undefined`) and 4,523 `earlyHintsCache` (an Early Hints lookup for a
    URL with no cached `Link`). The control is the same source's other
    rows: hits log 200 and `cache.put` logs 204. Filter
    `requestSource: "eyeball"` before reading any 5xx count, as the
    dashboard does.
    Checked by: nothing (how to measure).

64. **A Worker can't reach its own route with a global `fetch()`.** A
    same-zone fetch to a URL that a route claims skips the Worker and goes to
    the zone's origin, and this zone has none, so the request ends in a 522.
    The serendipity cron self-dispatched its tag pass to
    `/serendipity/tag` that way, and all 55 POSTs from 2026-10-02 to
    10-14 failed with nothing visible beyond `tag: {error: "tag 522"}` on a
    log line. Call yourself through `ctx.exports.default.fetch()` (a fresh
    invocation, one subrequest) or `withSelfFetch` (in-process, the same
    budget). The workerd cron test couldn't see it because the harness
    has no AI binding or secrets, so the dispatch skipped before it fetched.
    Checked by: `tools/tests/contract-every-cron-fires-in-workerd.test.ts`, `tools/tests/contract-the-luma-session-jar.test.ts`.

65. **A catch on the promise you await doesn't clear the one you handed
    `ctx.waitUntil`.** index.ts's cron helper passes the same promise to
    both, so `await cron(...).catch(() => {})` keeps the next job running
    and still ends the invocation as `scriptThrewException`. Measured
    2026-10-14 in local workerd: that shape reports `exception`, a bare
    throw reports `exception`, and a catch applied before `waitUntil` sees
    the promise reports `ok`. The daily 41 5 tick's comment said only the
    rethrow was dropped, while its status read exception every day for a
    month. Read that status in the GraphQL Analytics API
    (`workersInvocationsAdaptive`), which needs no observability scope;
    exactly 50 subrequests beside it means the Workers Free cap (gotcha 36).
    Checked by: nothing (judgment).

66. **The right answer was the longest option, so the quiz graded length.**
    On 2026-10-14 the right answer was the longest option on 191 of 202
    understanding-check questions, at a median 1.40x the wrong ones. Authors
    wrote it with its justification attached and the distractors as bare
    claims, so "pick the longest" scored 95% on pages the reader never
    opened. Option shuffling hid position and did nothing for length. The
    justification belongs in the option's `why`; each misconception gets
    the truth's level of detail. `validateUnderstanding` refuses a page
    where the right answer is the longest, or the shortest, on more than
    half its questions, and the contract test holds both guessers near
    chance site-wide with the median length ratio in 0.85 to 1.15.
    Checked by: `tools/tests/contract-quiz-answers-carry-no-length-tell.test.ts`.

67. **A package.json script named `lint` shadows `bun lint`.** Bun runs the
    script for `bun lint`, `bun lint .` and every flag but `--doctor`, so
    `bun lint` in a terminal still ran oxlint after the canary carried the
    built-in. Bun takes the built-in only when the script body itself says
    `bun lint`, a prefix like `bun tools/gen-runtime-types.ts &&` included;
    under 1.4.3, which has no linter, that same body recurses into the
    script. `bun lint --doctor` reads the config either way, so it can say
    "117 rules run natively" while the lint step runs something else.
    Measured 2026-10-15 on 408c9374b. The recursion ends in dozens of
    "exited with code 126" lines that never name the cause, and a canary
    can lack the linter while printing the same `1.4.4` as one that has it
    (+6c1eb067e against the pin's +9bcbf1ecb, 2026-10-17). So the script
    opens with `tools/check-bun-lint.ts`, which probes `bun lint --help` in
    an empty directory and stops the run with one message naming the
    installer; the contract's last two tests hold the guard and its control.
    Checked by: `tools/tests/contract-the-lint-script-reaches-bun-lint.test.ts`.

68. **The byte-identical build gate read the build's stopwatch.** From
    2026-10-13 `tools/build.ts` writes its phase timings to
    `.build/phases.json`, and the gate hashed all of `.build/`, so every
    candidate bun failed on that file alone and the canary tripwire went red
    on 408c9374b with "1 differing: phases.json". The file sits beside
    `.build/public`, so it never ships. `builtBytes` in `lib/bun-gates.ts`
    drops exactly that path, and a changed byte anywhere else, a served
    `public/phases.json` included, still fails. Anything else that records
    how long a build took belongs outside `.build/` or in `BUILD_TIMINGS`.
    Checked by: `tools/tests/contract-the-build-gate-ignores-only-the-stopwatch.test.ts`.

69. **A dated canary's npm sha can name a different commit from its
    binary.** The tarball's `package.json` version carries npm's `gitHead`
    (`+9bcbf1e`), and `bun --revision` carries the commit the binary was
    built from (`+9bcbf1ecb`). They agreed through 20261013.1, at 20261021.1,
    and again from 20261023.1. From 20261014.1 to 20261019.1 they didn't, on
    Linux x64 and macOS arm64 alike: each tarball shipped whatever the
    rolling `canary` release was at publish time under a newer commit's
    label (20261017.1 shipped `5f5799ed1`, the build the canary leg ran that
    afternoon), and the 20261015.1, 20261016.1 and 20261017.1 Linux binaries
    are byte-identical under three labels. No pin satisfies both: pinning the
    binary's sha fails the installer's second witness and pinning npm's
    fails its third. So the bumper's identity gate refused all six (#1373)
    and moved only when 20261021.1 matched. The next day it happened once
    more: 1.4.4-canary.20261022.1 is labeled `+38afee6`, the 1.4.4 release
    commit, and its Linux x64 binary is 20261021.1's `963452075` byte for
    byte. The installer refuses it under either sha. Read that red gate as an
    upstream mislabel and wait for a matching build; never relax the gate
    to pass one. Check a candidate by hand with
    `npm view @oven/bun-linux-x64@<version> gitHead` against
    `bun --revision` on the unpacked binary. Measured 2026-10-15; every
    build from 20261010.1 to 20261023.1 re-read 2026-10-23.
    Checked by: `.github/install-bun.sh`.

70. **Safari reads a fixed box's background-color, never its gradient.**
    Safari 26 dropped theme-color in tabs and tints its status bar and
    toolbars from the frontmost fixed box just inside each edge, using that
    box's computed `background-color` (`LocalFrameView::fixedContainerEdges`).
    The taskbar was drawn with the `background:` shorthand, which leaves the
    color transparent, so Safari had nothing solid to extend under it. The box
    must span 90% of the edge and stand taller than 10px, or WebKit samples
    pixels instead, and `backdrop-filter` disqualifies it (WebKit 319479). The
    wallpaper has no solid color either, so `html::before` is a 12px top
    sampler clipped to text it doesn't have: it paints nothing and still reads
    as opaque. On iPhone the top edge only counts under `viewport-fit=cover`
    (319479 again), so every page asks for it, and cover runs the page under
    the status bar, the notch and the home indicator: whatever the shell draws
    at an edge steps in by luna.css's SAFE AREAS insets (`--sa-*`,
    `--taskbar-h`). Measured 2026-10-16 in Chromium: with no insets the pages
    matched main pixel for pixel, and under `Emulation.setSafeAreaInsetsOverride`
    (59/34px portrait, 59px sides landscape) nothing tappable sat in an inset.
    This is undocumented WebKit behavior. If it moves, the old look comes back.
    (This was 67 in #1366; #1365's merge took the number and dropped the entry.)
    Checked by: `tools/tests/contract-safari-reads-a-solid-colour-at-each-edge.test.ts`.

71. **bun fmt reformats the HTML inside `html` tagged templates.** Prettier's
    default `embeddedLanguageFormatting = "auto"` treats a template tagged
    `html` as markup and reflows it, so `titleBar()` in
    `src/worker/lib/window.ts` emitted different HTML and the build's desktop
    freshness check refused to deploy. Templates the build doesn't compare
    would just ship the new markup. `bun fmt --debug-check` reported no change
    in meaning across 720 files while this happened, because the string is
    data to it. bunfig.toml's `[fmt]` sets it `"off"`. Measured 2026-10-16 on
    1.4.3-canary.20261013.1 by formatting the whole tree and building.
    Checked by: `tools/tests/contract-bun-fmt-keeps-out-of-what-it-would-break.test.ts`.

72. **bun fmt renumbers ordered lists in Markdown.** This file numbers its
    entries 1, 2, 3, then skips the retired ones, and the printer rewrote them
    to run consecutively: every gotcha after the first gap took a new number,
    and the 290 "gotcha N" references in 170 files pointed at the
    wrong entry. Markdown stays out of `[fmt]` entirely, since the docs here
    also hold version pins and tables that other checks read. Measured
    2026-10-16.
    Checked by: `tools/tests/contract-bun-fmt-keeps-out-of-what-it-would-break.test.ts`.

73. **bun fmt unquotes object keys, and lint rules read the result.** With
    Prettier's default `quoteProps = "as-needed"`, `{ "shape": ... }` in
    `src/client/lens.ts` became `{ shape: ... }`. The key means the same thing,
    and anti-slop's `no-shape-in-symbol-names` now saw an identifier and failed
    `bun run lint` in three files nobody had edited. `[fmt]` sets
    `"preserve"`. The formatter also drops parentheses it thinks are
    redundant (`(a || b) ? x : y` loses them), which broke a contract test's
    regex the same way. Measured 2026-10-16.
    Checked by: `tools/tests/contract-bun-fmt-keeps-out-of-what-it-would-break.test.ts`.

74. **Whatever reads a file's exact text breaks when bun fmt rewraps it.**
    Formatting everything on 2026-10-16 broke, in turn: the build's regex for
    THE CLIENT EDGE in `luna.css`; the design tokens `luna.css` must carry
    verbatim; `lwe/encoding.html`, which inlines its spec from
    `pipelines/lwe/specs/`; the generated files (`lib/desktop.*`,
    `lib/site-manifest.*`) and generated blocks (`nav-run.ts`, `lwe/ask.ts`)
    their checks compare byte for byte; two derivation digests; and 8
    contract-test regexes that spell out one-line source. A 9th, from a test
    written after that, turned up when the tree was re-formatted on
    2026-10-23. JSON is out because tools write it with
    `JSON.stringify(v, null, 2)` and the printer packs short arrays onto one
    line, so every `derive --lock` would fail `bun fmt --check`. With all of that in `[fmt].ignorePatterns`, the 504
    files that remain format with no `/a/` or `pd/` change: the served diff is
    the 46 `.src` twins and `sw.js`. The Worker bundle still changes bytes at
    the same size, because esbuild picks minified names by character
    frequency. A new reader of exact source text belongs in the ignore list,
    or matches with `\s*` where the formatter may wrap, as those 9 regexes
    have since the tree was formatted. The same re-format split a one-line
    `try { … } catch { … }` in `src/client/webmcp.ts` and left its
    `oxlint-disable-next-line` above the `try`, away from the line it
    excused. Lint reports the stranded directive as unused, so `bun run lint`
    catches this one; move the directive down onto the line it excuses.
    Checked by: `tools/tests/contract-bun-fmt-keeps-out-of-what-it-would-break.test.ts`.

75. **A playwright-core bump strands the canary's browser image.** The
    browsers leg in `canary.yml` runs in `mcr.microsoft.com/playwright`,
    pinned by tag and digest, and its pull step refuses an image whose
    version differs from the installed playwright-core. Dependabot moves the
    npm pin and never the image. #1364 moved playwright-core to 1.64.1 with
    the image left on 1.63.0, and the leg failed at the pull step, before any
    probe, on every nightly from 2026-10-15 to 2026-10-17. Move the tag and
    its digest in the same PR; `curl -sI -H 'Accept:
    application/vnd.oci.image.index.v1+json'
    https://mcr.microsoft.com/v2/playwright/manifests/v<version>-noble`
    prints the index digest as `docker-content-digest`.
    Checked by: `tools/tests/contract-the-browser-image-matches-playwright-core.test.ts`.

76. **`avifdec -d 8` truncates a 10-bit image before converting it.** libavif
    hands a 10-bit 4:4:4 file to libyuv, which drops the YUV to 8 bits and then
    converts, so the 8-bit PNG lands up to 3 levels under the file's true
    pixels, 0.4 to 0.5 under on average, wrong on about 55% of samples.
    Measured 2026-10-17 against an exact conversion of each file's own YUV
    planes, for the shipped AV1 and the AV2 build alike: `-d 8` cost 0 to 1.8
    ssimulacra2 on the 11 /garage/av2 samples (nothing on the 8-bit gray
    Monochroms). `-d 16`, rounded once by `zenc frame`, has zero samples off,
    and so does /garage/av2's WebAssembly decoder. djxl's 8-bit output rounds,
    so until then every AVIF and AV2 score on the /pixel-peeper format axis
    was handicapped against JPEG XL's by the decode, not the codec.
    Checked by: `tools/tests/contract-avif-scores-decode-exactly.test.ts`.

77. **WebKit blurs a window dragged to a fractional offset.** A dragged Luna
    window keeps its `translate()` after the drag, and WebKit's
    `PointerEvent.clientX` is a double, so a trackpad drag ended at offsets
    like `translate(127.297px, 176.617px)`. Measured 2026-10-17 in Search, a
    WKWebView browser, at 2x: on screen the whole window was resampled, and the
    Laplacian sharpness of its body text fell from 23.3 to 16.3 (title bar 24.7
    to 16.7). Whole and half-pixel offsets lost nothing, and dropping the
    wallpaper's `translateZ(0)` changed nothing. WebKit's own snapshots
    (`takeSnapshot`, Bun.WebView's `screenshot()`) paint the page crisp at the
    same offset, so only a capture of the real window (`screencapture -l`)
    shows it. `initDrag` in nav.js lands the window's corner on a device pixel
    through `onGrid`. The icon and accessory drags commit `left`/`top` on
    release, which WebKit snaps itself.
    Checked by: `tools/tests/contract-a-dragged-window-lands-on-a-device-pixel.test.ts`.

78. **The asset layer's `drop-trailing-slash` redirects with a 307.** The
    direction is right (`/about/` to `/about`) but the status is temporary,
    so a crawler keeps the slashed URL and comes back to it. Measured
    2026-10-17 on production: `/garage/`, `/lwe/` and every slashed page
    answered 307 while `cloudflare.config.ts` said 301, and `/coffee/` and
    `/serendipity/` skipped the redirect entirely, since their modules served
    their own root as a second 200. The route oracle had accepted
    `[301, 307, 308]` for `/garage/`, so it could not tell. A path that must
    redirect permanently needs an exact route to `routeDropSlash` in
    `src/worker/index.ts`, and its row in the route oracle (`bun run
    routes:check`) pins `status: 301` and the `location`.
    Checked by: `tools/verify-routes.ts`.

79. **A walk that names a tree which still exists passes on zero files.**
    Invariant 8c in `tools/build.ts` walked `public/garage` and `public/lwe`
    from the 2026-08-18 split (#457) until 2026-10-17. Both directories exist
    (they hold `av2/`, `enc/` and `lean/` assets), so `readdir` succeeded,
    returned no `.html`, and the check inspected 0 of the 39 pages in
    `src/pages`. Invariant 10 read serendipity as `/\.js$/` from #523
    (2026-08-23), when its last `.js` became `.ts`, so it scanned 0 of 3
    files. A missing directory throws and fails the build; a wrong one passes
    silently while the summary line printed the registry's 74 entries. Give
    every walk-and-assert a floor on what it inspected, print the walked
    count, and register a control that breaks the path (gotcha 89). Gotcha 55 is the
    same split reaching `servedFiles()`.
    Checked by: `tools/build.ts`.

80. **A check that warns when it finds nothing compares nothing.** Build
    step 5 holds the taskbar floor in `luna.css`, the homepage and cal's
    templates to one value, because a copy that disagrees paints a different
    window height before luna lands. Its regex wanted `calc(100dvh - 30px)`.
    #1369 (2026-10-16) spelled two of the copies through a `--taskbar-h`
    token, so the regex matched none of the three, and every build printed
    "no taskbar-floor calc found" three times above "invariants ok". Nobody
    reads a warning on a green build. `tools/lib/taskbar-floor.ts` now
    resolves `var()` through each document's own custom properties and
    compares the flattened sums, a missing floor is a hard failure, and the
    summary line prints how many floors agreed. Gotcha 79 is the same blind
    instrument on a directory walk.
    Checked by: `tools/build.ts`, `tools/tests/contract-the-taskbar-floor-agrees-across-copies.test.ts`.

81. **A CPU step smaller than a route's spread fails later PRs, not its own.**
    #1386 (2026-10-17) gave a browser's 404 a Luna window, and
    `/this-page-does-not-exist` moved from a p50 of 7.36 ms over the 10 CPU
    runs before it to 8.96 ms over the 54 conclusive runs after. Its own run
    read 8.47 against a 10 ms ceiling and passed, because the route spreads
    about 11% between runs and earlier runs had read up to 8.93. The PRs
    after it paid: 16 of those 54 runs read over 10, among them #1397
    (comments only) and #1408 (a build check). The control can't absorb that
    spread. Scaled `/robots.txt` and the 404 correlated at r = 0.16 across
    those runs, and dividing by the control widened the spread (CV 10.7% to
    11.7%), so a control-relative gate would false-fail more. When a route
    fails on a PR that changed no Worker byte, read it across main's runs by
    time: the step sits at a merge. Re-fit the ceiling from 30 or more
    conclusive runs after it and record them in the row's `measured`. A
    ceiling 20% over the highest run still misses any step inside that
    headroom: at 14 ms the 404 passed a spin that added 3 ms and failed one
    that added 5 ms.
    Checked by: `tools/tests/contract-cpu-sweep-can-tell-slow-from-fast.test.ts`.

82. **Lightning CSS folds `animation-timeline` into a shorthand no engine
    parses.** With no `targets`, Lightning 1.33 turns `animation: x linear
    both; animation-timeline: view()` into `animation:linear both x view()`.
    CSS Animations 2 allows that, but Chrome 152 rejects it (`CSS.supports`
    answers false), and Lightning's own compat table gives Safari 26 and
    Firefox 150 the longhand. The browser drops the whole declaration
    silently, so all four scroll-driven demos on `/garage/scroll` and
    `/garage/horizon` shipped frozen on their first keyframe until
    2026-10-23. Write `animation-name`, `-timing-function` and `-fill-mode`
    as longhands beside `animation-timeline`; Lightning only folds a full
    shorthand. Two traps rode along: `scroll(root)` watched an `<html>` the
    window shell never scrolls, and `overflow: hidden` on a wrapper makes it
    the `nearest` scroll container (use `overflow: clip`).
    Checked by: `tools/lib/css-parse.ts`, `tools/tests/contract-animation-timeline-stays-a-longhand.test.ts`.

83. **An HTMLRewriter append to `<head>` writes nothing on a built page.**
    The minifier drops the optional `</head>`, and lol-html can't append to
    an element whose end tag never arrives, so `.on("head", { element(e) {
    e.append(...) } })` passes on a hand-written fixture and does nothing in
    production. The first cut of og:video shipped its tags that way and the
    built `/garage/encoding` carried none (route oracle, 2026-10-23). Anchor
    the insertion on an element that is always there and use `after` or
    `prepend`; `lib/og-video.ts` writes after `og:type`. A fixture for the
    rewriter has to be the minified shape, without `</head>`. Related: the
    asset layer ignores `Range` (a `bytes=0-99` on `/og/home.jpg` came back
    200 with all 105,441 bytes), so anything a player streams goes through
    the Worker.
    Checked by: `tools/tests/contract-og-video-plays-for-the-bots-that-play-it.test.ts`, `tools/verify-routes.ts`.

84. **libavif 1.3.x's avifenc mis-scales gray PNGs whenever depth or range
    changes.** 1.3.0 stopped routing gray PNGs through RGB, and its new gray
    branch in `avifImageRGBToYUV` stores the raw sample with no scaling or
    range mapping, so at `-d 10` an 8-bit 200 lands as 200 of 1023
    (libavif#2827, fixed by 0b65e2e in 1.4.0). Measured on 1.3.0-1ubuntu4:
    `-d 10` reads ~4x dark at 4:0:0 and 4:4:4 alike, a 16-bit gray PNG at
    `-d 8` clips to white (20000 becomes 255, not 78), and `-r limited`
    stores white as 255, not 235. Only 8-bit gray at 8 bits, full range, comes
    out right, which hides it in casual use. zenc
    hands libavif RGB triples and never takes that branch, so on 1.3.x its
    parity test fails with zenc the side that's right. Ubuntu 26.04 ships
    1.3.0-1ubuntu4 with no backport, and `ubuntu-latest` moved to it on
    2026-10-21. The Photos job now builds the libavif `config/tools.json`
    records, statically: a shared build installs a second `libavif.so.16`, and
    on 26.04 arm64 the loader cache lists the distro's first, so `avifenc
    --version` read 1.3.0 while `pkg-config` said 1.4.2. Measured in a 26.04
    container: stock fails the gray case (mdat 71 vs 52 bytes), static 1.4.2
    passes 39 of 39 with the 1.3.0 library still installed.
    Checked by: `tools/tests/contract-photos-ci-builds-the-recorded-libavif.test.ts`.

85. **An agent's four-hex `\u` escape reaches the disk as the raw character.**
    The guestbook's sanitizer was written on 2026-10-23 with four-hex escapes
    for U+202A to U+202E, and the file held the characters themselves: an
    unreadable regex, and five Trojan Source controls (CVE-2021-42574) that
    reorder what a reviewer sees. bun fmt was blamed first and kept every
    escape, on the pin (1.4.3-canary.20261021.1) and on 1.4.4-canary.1, in
    clean and badly formatted files alike. The decode happens before the tool
    runs: Write into a scratch file the format hook never touches, and a Bash
    `<<'EOF'` heredoc, both wrote raw é, NBSP, ZWSP and U+202E. U+2028 and
    U+2029 decode too, and at a line end they then vanish with any space
    before them. Escapes of `Cc` code points (C0, DEL, C1), a braced
    `\u{202E}` and a doubled backslash came through as typed, which is why the
    damage looks selective. Name the class by property
    (`/[\p{Cc}\p{Bidi_Control}]/gu`), or build the string with
    `String.fromCodePoint(0x202e)`; a braced escape also survives. The check
    scans every tracked and untracked text file, so it fires before `git add`.
    Checked by: `tools/tests/contract-no-source-file-carries-a-bidi-control.test.ts`.

86. **A custom property named in a template literal loses its colour in the
    build.** The build shortens every `--name` across the staged tree by
    find-and-replace (`tools/lib/mangle-custom-properties.ts`), so
    `--f-jxl:` becomes `--2u:`. A script that writes `var(--f-${fmt})` still
    asks for `--f-jxl` at runtime, nothing defines it any more, and the stroke
    or background falls back to nothing. The unbuilt page looks right, so a
    preview of `src/` cannot catch it. `/pixel-peeper`'s format ladder drew
    every curve colourless in its built page on 2026-10-23. Write each name
    out whole (a `{jxl:"var(--f-jxl)"}` map), which the rename rewrites like
    any other reference. The guard used to look only for dynamic
    `setProperty` calls. It now also refuses `--name${`, comments included,
    since the staged text can't tell a comment from a script.
    Checked by: `tools/tests/contract-mangle-refuses-template-built-names.test.ts`.


87. **Moving tests leaves stale timing entries behind.** Bun merges
    `--update-timings` into the timing file it read, including paths that no
    longer exist. After the contract suite moved into `tools/tests/`, the old
    rows remained and quietly stopped ordering those tests. Regenerate
    `config/test-timings.json` with `bun run test --update-timings --shard=1/1`
    when moving or deleting tests; one shard covers the entire suite and writes
    only the files it ran. Re-run the suite against the refreshed plan.
    Keep bare Bun discovery, the package scripts, and harness discovery on the
    same directory so each validation path still runs the complete suite.
    Checked by: `tools/tests/contract-test-discovery.test.ts`.

88. **A `local()` @font-face named after an installed font hides its Bold
    and Italic.** `design/tokens/fonts.css` declares "Tahoma", "Verdana" and
    the other house families as one regular face each, claiming weights 400
    to 700. Loaded, those rules replace the installed family, so the browser
    never sees Tahoma Bold or Verdana Italic. Measured 2026-10-29 in Chrome on
    macOS 27.2: bold Tahoma and bold-italic Trebuchet drew at regular weight
    (239.95 px against 276.84 px for the real bold), and Verdana italic was
    regular slanted by the browser. WebKit matched the real faces anyway, so
    a Safari check shows nothing wrong. `design/styles.css` imported it, which
    put regular-weight title bars in every design-skill prototype viewed in
    Chrome. The file stays as a reference; nothing loads it, and the
    typography.css stacks name the families directly.
    Checked by: `tools/tests/contract-design-fonts-stay-unloaded.test.ts`.

89. **A guard proven once goes blind without anyone noticing.** `validate`
    proves on every push that each guard passes on a good tree. Whether it
    still fails on its defect was proven once, by hand, in the PR that added
    it, and 20 commit bodies record such a "Controls:" run that never ran
    again. Gotcha 79's walks read zero files for 55 and 60 days, and the
    taskbar floor compared nothing for a day. Re-run against the trees
    before #1390 and #1408 on 2026-10-29, `bun run controls` reads BLIND on
    all three. Writing 14 more that day found two live ones: gotcha 13's
    source walker had read security.ts's typed inits as Responses since
    #494 (70 days), and no check read the four deploy scripts outside
    infra.json. Register a guard's control in `tools/lib/controls.ts` with
    the words the guard prints, and run it before you call a check done. A
    control that plants a new file marks it intent-to-add, because 21
    contract scans read git and only the bidi scan sees an untracked file.
    Checked by: `tools/tests/contract-controls-still-apply.test.ts`, `tools/controls.ts`.
