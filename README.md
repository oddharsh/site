# aadhar.sh

A personal site rebuilt as compiled semantic documents plus one bounded
Cloudflare Worker. It keeps a Windows XP Explorer visual language while using
current HTML and CSS, one small native stylesheet, and no client JavaScript
except the route-scoped Pixel Peeper comparison control.

```bash
npm ci
npm run build
npm test
npm run perf-budget
npm run routes:check
```

The source map is intentionally short:

- `content/` — writing, long-form pages, checkpoints, and public records
- `assets/` — content-addressed photographs and study fixtures
- `src/site/` — static compiler primitives, page families, and CSS
- `src/worker/` — live reads, writes, MCP, and scheduled work
- `src/contracts/` — canonical machine-facing contracts
- `public/` — static public artifacts
- `dist/` — generated deploy tree

Read [design/BLANK-SLATE.md](design/BLANK-SLATE.md) for the design and
performance constitution, [MAINTENANCE.md](MAINTENANCE.md) for operations, and
[CLAUDE.md](CLAUDE.md) for repository invariants.
