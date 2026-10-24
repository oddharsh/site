# aadhar.sh

My personal site, styled after Windows XP and Outlook Express. It runs on a
Cloudflare Worker with static assets, native fonts, and small client islands.

Pages are authored as HTML. One build minifies the site, gives shell assets
content hashes, and produces readable source twins and compression dictionaries.
The Worker adds feeds, search, photo queries, and integrations.

## Run locally

Use Node from [`.node-version`](.node-version) and install the Bun declared in
[`config/bun-pin.json`](config/bun-pin.json). The shared installer verifies the
binary before installing it:

```sh
bash .github/install-bun.sh /tmp/aadhar-sh-bun
export PATH="/tmp/aadhar-sh-bun:$PATH"
bun install --frozen-lockfile
bun run build
```

For the local site and its Counter service, install the `cf` CLI described in
[MAINTENANCE.md](docs/MAINTENANCE.md), authenticate, and run `bun run dev`.
Cloudflare bindings and account access are needed for integrated development.

```sh
bun run check:fast  # lint, format check, typecheck, contract tests
bun run build      # stage the deployable site in .build/
bun run routes:check
```

The separately deployed Reader has its own dependencies and checks:

```sh
cd lens-reader
bun install --frozen-lockfile
bun run typecheck
bun run test
```

## Find your way around

| Directory | What belongs here |
| --- | --- |
| [`src/pages/`](src/pages/) | HTML documents, arranged by served path |
| [`src/content/`](src/content/) | Writing, Markdown representations, and content indexes |
| [`src/worker/`](src/worker/) | The site Worker; start with `routes.ts` and `index.ts` |
| [`src/client/`](src/client/), [`src/styles/`](src/styles/) | Client islands and styles transformed by the build |
| [`src/dict/`](src/dict/) | Committed compression dictionaries used as build inputs |
| [`public/`](public/) | Files shipped unchanged, including photo tiers and OG cards |
| [`cal/`](cal/), [`serendipity/`](serendipity/) | Feature modules bundled into the site Worker |
| [`counter/`](counter/), [`cf-garage/`](cf-garage/), [`lwe-ask/`](lwe-ask/), [`lens-reader/`](lens-reader/) | Independently deployed supporting Workers |
| [`tools/`](tools/) | Build and maintenance commands; shared code in `lib/`, photo tooling in `photos/` |
| [`tools/tests/`](tools/tests/) | Contract tests and their shared helper |
| [`pipelines/`](pipelines/) | Garage and LWE page generators |
| [`config/`](config/) | Registries, declared infrastructure, runtime pins, and TypeScript programs |
| [`design/`](design/) | Luna design rules and canonical color tokens |
| [`docs/`](docs/) | Maintenance, dependency, photo, and architecture documentation |

The root `cloudflare.config.ts` describes the site Worker; `wrangler.config.ts`
describes its build and upload. Workers Builds runs from this directory.
Generated output goes into the ignored `.build/` directory.

## Change the site

Register routes in [`src/worker/routes.ts`](src/worker/routes.ts) and pages in
[`config/site-manifest.json`](config/site-manifest.json). Edit generated content
through its generator, recorded in [`config/derivations.json`](config/derivations.json).
Keep the native-font Luna interface and use tokens from [`design/`](design/).

Changes go through a PR. The required `validate` check covers the build, budgets,
contracts, routes, generated artifacts, and coffee tests. Merged commits reach
production through the promotion workflow and Cloudflare Workers Builds.

- [Tooling and pin ownership](docs/TOOLING.md)
- [Maintenance commands and release process](docs/MAINTENANCE.md)
- [Dependency policy](docs/DEPENDENCIES.md)
- [Photo pipeline](docs/PHOTO-PIPELINE.md)
- [Design system](design/DESIGN.md)
- [Architecture and agent instructions](CLAUDE.md)
- [Known traps and their checks](docs/GOTCHAS.md)
