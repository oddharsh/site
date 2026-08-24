## this is my personal site, running on cloudflare workers w/ static assets

it uses no frameworks, is static and tries to mash my favorite bits of the windows I grew up on, google chrome flags, and really fast sites like mcmaster

for instance: 
* the photos are encoded as avifs and jpegs with lots of care and the html, js, and css are all served as minified but with nonminified mirrors
* brotli q11 where possible and also trying to use shared dictionaries with deltas on zstandard
* encrypted client hello and quic are used

## where things are

* `public/` is the bytes a browser fetches unchanged: photos, the hashed assets, headers
* `src/` is everything authored: `pages/` the html, `content/` the prose, `worker/` the site worker, `client/` and `styles/` the islands and the css
* `tools/` is every dev tool, including the build and the test suite. none of it ships
* `config/` is wrangler's neighbours: declared infra, the surface registry, tsconfig
* `docs/` is the long runbooks. `CLAUDE.md` is the architecture doc and the thing agents read
* `cal/` and `serendipity/` are apps the site worker bundles; `cf-garage/`, `lwe-ask/` and `lens-reader/` deploy on their own (`cf-garage/` on wrangler's experimental TypeScript config, so its commands want `--x-new-config`)
* `pipelines/` generates the garage and lwe pages, `design/` is the luna design system

both wrangler configs stay at the root because workers builds runs from there.

```bash
bun install && bun run dev
```
