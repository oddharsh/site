# Tooling and configuration

Start with `package.json` for commands and dependency declarations. Shared
Wrangler versions live in its default Bun `catalog`; the root and workspace
manifests use `catalog:` references. A pin update changes one declaration.

## Where a version belongs

| Setting | Canonical source | How it moves |
| --- | --- | --- |
| Bun runtime | `config/bun-pin.json` | `bun run bun:pin`; channel changes are deliberate |
| Node major used by CI | `.node-version` | Owner decision; `bun run node:pin` checks support |
| Minimum supported Node | `package.json` `engines.node` | Changes when source requires a newer API |
| Shared Wrangler dependency | `package.json` `catalog.wrangler` | `bun run wrangler:pin` evaluates a candidate before proposing it |
| Other npm dependencies | The consuming `package.json` | `bun run deps:pin`, or a deliberate source-pin update |
| Installed npm dependency trees | Root and Reader `bun.lock` files | Regenerate with the pinned Bun; review resolutions |
| Rust dependencies | Each crate's `Cargo.toml` and `Cargo.lock` | Cargo and dependency PRs |
| Rust toolchain | `rust-toolchain.toml` | Explicit toolchain update |
| GitHub Actions revisions | Workflow and composite-action `uses` entries | Dependabot; contracts require commit pins |
| Worker runtime behavior | Each Worker's compatibility date and flags | Evaluate against that Worker's behavior and tests |
| Native photo tools | `config/tools.json` | `bun run tools:check` verifies the recorded tools |

These sources serve different consumers. Node's supported floor and CI major
have different meanings. Worker compatibility dates select runtime behavior
independently of the Wrangler version used to bundle and deploy them.

Bun's runtime pin stays outside `packageManager`: the Workers Builds bootstrap
cannot resolve dated canaries there. CI and Workers Builds both use
`.github/install-bun.sh`, which verifies the downloaded runtime's identity.

The Reader stays outside the Bun workspace and owns `lens-reader/bun.lock`.
Its DOM dependencies belong to its separate Worker. It resolves the root's
Wrangler installation; `bun run check-wrangler` checks every tracked project,
including standalone projects, against the root installation and commit pin.

The pinned Wrangler omits catalog references from the uploaded
`package_dependencies` inventory. Its Wrangler entry therefore disappears from
that deployment metadata after this migration. The local provenance check still
verifies the exact installed commit; the bundled Worker JavaScript is unchanged.

## Tools and tests

Executable tools stay under `tools/`. Their reusable modules live in `tools/lib/`;
photo commands and native encoders live in `tools/photos/`. Contract tests and
`contract-shared.ts` live in `tools/tests/`, with captured inputs in `tools/fixtures/`.

`bun run test` runs the contracts with four workers, shared globals per worker,
a 30-second timeout, and a network tripwire. Bare `bun test` discovers the same
suite through `bunfig.toml`, using Bun's default execution settings. `bun run
test:node` runs the contracts under Node as a second runtime check.

The Wrangler canary discovers harness tests in this same directory and uses
the test script's flags. The Bun pin updater also reads that script, so changing
its arguments changes the validation used to propose runtime pins.

## Checks

| Command | Purpose |
| --- | --- |
| `bun run check:fast` | Local lint, format check, typecheck, and contracts |
| `bun run build` | Produce `.build/`, including minified assets and readable twins |
| `bun run perf-budget` | Check built size budgets |
| `bun run derive:check` | Verify generated artifacts against their declared sources |
| `bun run pages:check` | Check page content contracts and house voice |
| `bun run routes:check` | Exercise the route oracle against a local Worker |
| `bun run --filter cal-aadhar-sh test` | Run coffee's Worker harness tests |
| `bun run check-wrangler` | Check declarations, installed provenance, and shared resolution |

CI's `validate` job is the required gate. Network and account checks, native
photo tools, and production verification have separate runbooks in
[MAINTENANCE.md](MAINTENANCE.md). Detailed runtime measurements from the old
manifest comments are preserved in [TOOLCHAIN-DECISIONS.md](TOOLCHAIN-DECISIONS.md).
