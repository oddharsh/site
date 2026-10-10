# Gotchas

Traps this repo has already paid for. Code comments cite them by number
("gotcha 16"), and `contract-gotcha-numbers-resolve` fails if a cited number
has no entry, so numbers are permanent: retire an entry by deleting it, never
by renumbering. The long-form history of each one is in git
(`git log -p -- CLAUDE.md`, before 2026-10-03).

## Gotchas

1. **Thumbnail 404s must be uncacheable.** A miss under `/images/*` would
   inherit the immutable cache rule, so `/images/<thumb>` stays worker-first
   and the Worker clamps the 404. A re-encode mints a new `/i/` URL, so there's
   no version to bump.

3. **Rotate photos by sample permutation, never in the DCT domain.**
   `jpegtran -rotate` is only lossless when the constraint edge is iMCU-aligned
   and degrades silently without `-perfect`. `zenc square|resize --orient N`
   permutes decoded pixels instead, exact at any size. jpegtran stays for the
   progressive reorder of the R2 copies.

6. **EXIF orientations 5-8 swap width and height.** Transpose source
   dimensions before writing `metadata.json`.

7. **`<picture>` falls back on unsupported TYPES, never on decode failures.**
   If broken-image reports appear, demote AVIF; adding `<source>` tiers won't
   help.

8. **No `<a>` inside `<a>`.** Artist links inside a track row are
   `<span class="np-artist-link" role="link" tabindex="0" data-href>` plus a
   delegated click handler.

10. **Gate hover features on `(hover: none)`.** Touch long-press fires
    synthetic mouseover.

11. **`will-change` is earned per interaction.** Toggle it around the hover
    lifecycle; a permanent one holds a compositor layer.

13. **Anything that rebuilds a Response must preserve `encodeBody`.** It's
    write-only and has no getter. `new Response(r.body, r)` keeps it;
    `new Response(r.body, { status, headers })` drops it and the runtime
    double-compresses. Rebuild with the response as init, then mutate headers.
    `contract-encodebody-survives-a-rebuild-in-workerd` checks the shapes in
    real workerd. Also: the Worker sees a rewritten `Accept-Encoding`, and the
    edge down-converts br for clients that don't take it, so don't negotiate
    compression in the Worker.

14. **Deltas are dcz (zstd), plain responses are brotli q11.** dcz wins on
    decode time, which scales with the reconstruction rather than the delta.
    Level 19 is optimal at this size. `src/dict/{a,p,f}-dict` are committed
    because a dictionary must be bytes a browser already holds; the roll
    (`bun run dict:roll`) reads production. Probe an engine's dictionary
    support with a no/right/wrong-dictionary control: an engine that ignores
    the option still decodes, so the failure is silent.

15. **Read a browser feature off two signals, and suspect the instrument
    first.** For Early Hints: `initiatorType === "early-hints"` plus a fetch
    duration too short for the bytes. Two
    unrelated origins failing identically means the harness is lying. Confirm
    paint claims in a visible window.

16. **Only `src/worker/index.ts` may import `cloudflare:workers`.** Everything
    else is also imported by the contract suite outside workerd. Tracing is
    injected (`installTracing`) instead. Nothing cal imports may reach
    `cloudflare:workers`, directly or transitively.

17. **`script-src` is per-document sha256 hashes, computed at build.**
    `lib/csp-hashes.ts` ships empty and build step 7c fills it; a path with no
    entry falls back to `'unsafe-inline'`, and the build fails below 40
    covered documents. Event-handler attributes can't be hashed and fail the
    build. Worker-rendered `lunaPage` output hashes its own. Island fragments
    (`islandResponse`, cal's slot list) send `script-src 'self'` with no
    hashes, since `innerHTML` never runs their scripts. `bun run csp:sweep` is
    the browser check; perturb one script as its control.

18. **`scrollbar-color` inherits and disables `::-webkit-scrollbar` rules.**
    So does a non-auto `scrollbar-width` on the element itself. Reset to
    `auto` and give Firefox the standard property behind
    `@supports (not selector(::-webkit-scrollbar)) or selector(:-moz-focusring)`.
    Don't use `(-moz-appearance:none)`: Lightning CSS strips the prefix from a
    non-first operand (lightningcss#710, fix in #1316), so the arm applies
    everywhere.

19. **No backticks in CSS comments inside `/*min*/` template literals.** They
    end the JS literal.

20. **An edge feature that rewrites HTML after the Worker breaks anything
    derived from the Worker's output**, dictionaries first. Derive from the
    wire or verify the wire equals the build. Prune dictionary snapshots by
    commit time, never mtime (`git checkout` resets mtime).

23. **An AI Gateway id is a hard dependency.** A wrong id fails inference
    rather than falling back, so it comes from config, never a literal.
    Gateway caching stays off where a repeated request should get a fresh
    answer.

24. **`deploy:promote` reads `checkpoints.json` from your working tree.** Ramp
    from a fresh worktree at `origin/main`, or the changelog row is silently
    skipped.

25. **After changing a secret, don't ramp a version built before the change.**
    Secret versions carry no alias, so the ramp skips them; a version built
    later inherits the current secret set. Check with
    `bun run wrangler:site versions view <id>`.

26. **`run_worker_first` caps at 100 RAW rows.** Duplicates count. The list is
    derived from `src/worker/routes.ts`; check for a covering wildcard before
    adding a row. `wrangler deploy --dry-run` catches an over-cap config.

27. **A red `github-advanced-security` check is usually Copilot's agent
    failing, not your diff.** The tell is `CAPIError: 400` in the job log
    (`gh run view <run-id> --log-failed`, where the run id is the middle
    number in `details_url`). It isn't required and gates nothing.

28. **A bun pin change must preserve build bytes.** `/a/` and `/i/` are
    content-addressed, so `bun run bun:pin` gates a candidate on a
    byte-identical build. Keep both `bun run test` and `bun run test:node`:
    they disagree on real runtime facts.

29. **Run wrangler through `wranglerCommand()` (node plus the pinned entry
    file), never `npx` or `bun x`**, which fetch whatever they can't resolve.
    Change a Workers Builds command in the dashboard FIRST, then
    `config/infra.json`.

31. **`_headers` rules combine rather than override.** Two `Cache-Control`
    values ship as one malformed header. To replace one, put the narrow rule
    AFTER the glob and detach with `! Cache-Control` first; a detach above the
    rule it targets does nothing.

32. **`bun run pages:check` lints page text and is required.** It bans em
    dashes, AI filler and "X, not Y" negations, but only in the quiz and
    editorial fields; lint your own diff for the rest.

33. **A speculation rule can't be measured from the page or from an agent's
    backgrounded tab.** Count at the origin (`Sec-Purpose`) with
    `bun run speculation:probe`, and read its control line first.

34. **Read every hunk `oxlint --fix` produces.** `no-useless-spread` broke a
    `TypedArray.map` once; that rule is off.

35. **Editing a hashed `/a/` asset re-mints every page that references it,
    and a comment is free.** Minification strips comments, so the hash holds.
    Grep built pages for the asset's URL to see the bill.

36. **Workers Free: 50 subrequests per invocation (KV counts), and CPU clamps
    under load.** A fan-out that catches per-item errors will silently degrade
    every item when it hits the cap. Count the failures on a span; measure CPU
    off `cpuTime`, never status codes. Pin a version with the FULL UUID in
    `Cloudflare-Workers-Version-Overrides`. A workflow's conclusion doesn't
    say whether a release shipped: ask `bun run deploy:promote --status`.

37. **`Bun.Image` is the OS imaging stack.** It's fine for a throwaway
    thumbnail and wrong for a served tier: fatter output, no 16-bit HEIF
    decode, and `resize` differs by backend unless `Bun.Image.backend = "bun"`.
    It validates no encoder option (oven-sh/bun#40490).

38. **Bun is the toolchain; node stays for wrangler and the route oracle.**
    Wrangler refuses some subcommands under bun, and miniflare's
    `dispatchFetch` needs fetch to honour `{ dispatcher }`, which bun doesn't
    (oven-sh/bun#39247). Bun tests that dispatch through the harness wrap
    their body in `underNode()`. Check support per command, never per tool.

39. **A dev server on your port may belong to another checkout.** Check the
    process's cwd (`lsof -a -p <pid> -d cwd`) before trusting a response, and
    bind an explicit free port.

40. **Resolve paths from a named anchor, and keep `set -euo pipefail`.**
    `$SCRIPT_DIR/..` silently changes meaning when a script moves. `$?` after a
    pipe is the LAST command's; under zsh the first stage is `$pipestatus[1]`,
    under bash `${PIPESTATUS[0]}`. An empty array under bash 3.2 `-u` needs
    `${A+"${A[@]}"}`.

41. **cf-garage, lwe-ask and lens-reader use wrangler's TypeScript config.**
    Commands need `--x-new-config` and must run from the Worker's own
    directory (`-c` is refused). `bun run --bun` in front of the config loader
    is refused; the `.bin` shim runs node and works.

42. **JSDoc type tags are inert in `.ts` files.** Write real annotations; a
    contract test fails on a JSDoc type tag in `.ts`.

43. **`avifenc --jobs` changes output bytes.** 1 differs from 2+. Treat every
    concurrency flag on an encoder feeding `/i/` as a quality flag.

44. **A worktree under `.claude/worktrees/` resolves modules from the
    parent's `node_modules`.** Validate dependency removals from a detached
    worktree outside the checkout with a fresh install. Only
    `rm -rf node_modules && bun install --frozen-lockfile` really removes a
    package.

45. **On macOS, `mkdtemp(tmpdir())` returns `/var/...` and anything that
    canonicalises reads `/private/var/...`.** `realpath` fixture roots, and
    use `import.meta.main` for main-module guards.

46. **Anything derived from a content-addressed file must be regenerated when
    the hash moves.** `bun run derive:check` compares each derived artifact
    against the inputs recorded in `config/derivations.json`;
    `-- --lock` re-records after a deliberate regeneration.

48. **The site config is TypeScript, and most wrangler commands can't read
    it.** `cloudflare.config.ts` + `wrangler.config.ts` are projected by
    `tools/lib/site-config.ts` to a gitignored `.wrangler.site.jsonc`. Use
    `bun run wrangler:site <command>`; tools use `siteWranglerArgs()`. Local
    dev is `config/dev/`, an overlay `cf dev` reads natively (`tools/dev.ts`);
    only `dev:remote` still projects it to `.wrangler.dev.jsonc`.

49. **Read bun test's counts from its summary rows, never from anywhere in the
    output.** An unanchored `/(\d+) fail/` matched "D1 fails" in a passing
    test's name and filed RED issues against a healthy bun for two nights
    (#1122, #1124). Use `suiteCounts()` from `tools/lib/bun-gates.ts`. A
    count with no `(fail)` row beside it is the tell.

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

51. **A Rust compiler bump can fail strict Clippy on unchanged source.**
    Rust 1.99 adds `chunks_exact_to_as_chunks`; fixed-size pixel loops use
    `as_chunks::<N>().0.iter()` and `as_chunks_mut::<N>().0.iter_mut()`.
    Both retain the old iterator's treatment of a trailing partial chunk.
    Run zenc's tests and `clippy --all-targets -- -D warnings`, including its
    example, then compare encoded output and reproduce the committed histograms.

52. **A Bun canary's `--version` does not prove it has `bun check`.** The
    installed binary and the 2026-10-06 npm canary both reported 1.4.3 but
    predated the checker. GitHub's later canary at `bbdc5a519` had it.
    Verify the full `Bun.revision` and `bun check --help`. The owner selected
    the rolling GitHub canary temporarily; the shared installer verifies its
    digest and commit, then records both in `bun.install.json` beside Bun.
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

53. **Wrangler's `--outfile` is a multipart upload, with a random boundary.**
    Two byte-identical Workers can give different upload-file hashes. Compare
    the named `index.js`, `index.js.map`, and `metadata` parts before blaming
    a Bun or bundler change; keep public asset comparisons byte-for-byte.

54. **A background CI step can weaken the gate without failing it.** Since
    2026-10-06 `validate` runs independent checks as Actions `background`
    steps. Two of the contract tests that read `.build/` skip ("needs a
    build") when it is missing, so a suite started beside the build passes
    with less coverage instead of failing. `lint` and `typecheck` both open
    with `gen-runtime-types.ts`, which deletes and rewrites cf-garage's types
    on a fresh checkout. Before backgrounding a step, list what it writes and
    what reads it; `contract-ci-required-gate` holds the edges known today.

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
