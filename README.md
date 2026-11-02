## this is my personal site, running on cloudflare workers w/ static assets

it uses no frameworks, is mostly static and tries to mash my favorite bits of the windows I grew up on, google chrome flags, and really fast sites like mcmaster

for instance:

* the photos are encoded as avifs and jpegs with lots of care and the html, js, and css are all served as minified but with nonminified mirrors
* brotli q11 where possible and also trying to use shared dictionaries with deltas on zstandard
* encrypted client hello and quic are used

## where things are

* `public/` is the bytes a browser fetches unchanged: photos, og cards, headers. the build puts hashed assets in `.build/public/a/`
* `src/` is everything authored: `pages/` the html, `content/` the prose, `worker/` the site worker, `client/` and `styles/` the islands and the css
* `tools/` is every dev tool, including the build; the test suite lives in `tools/tests/`. none of it ships
* `config/` is wrangler's neighbours: declared infra, the surface registry, tsconfig
* `docs/` is the long runbooks. `CLAUDE.md` is the architecture doc and the thing agents read
* `cal/` and `serendipity/` are apps the site worker bundles; `counter/`, `cf-garage/`, `lwe-ask/` and `lens-reader/` deploy on their own (the last three use wrangler's experimental TypeScript config, so their config-reading wrangler commands want `--x-new-config`)
* `pipelines/` generates the garage and lwe pages, `design/` is the luna design system

both wrangler configs stay at the root because workers builds runs from there.

use the bun in `config/bun-pin.json` and the node major in `.node-version`. local dev also needs the `cf` cli and cloudflare auth. [the tooling guide](docs/TOOLING.md) and [maintenance runbook](docs/MAINTENANCE.md) have the setup and commands. the shared wrangler pin lives in `package.json`'s `catalog`.

```bash
bun install --frozen-lockfile && bun run dev
```
