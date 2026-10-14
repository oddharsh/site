// wrangler-provenance.ts — which wrangler TARBALL node_modules actually holds.
//
// What does carry the identity is bun's store directory, which is the tarball
// URL with its separators flattened:
//
//   node_modules/.bun/wrangler@https+++pkg.pr.new+cloudflare+workers-sdk+wrangler@3572193+<hash>/

export const COMMIT_PIN = /^https:\/\/pkg\.pr\.new\/cloudflare\/workers-sdk\/wrangler@([0-9a-f]{7,40})$/;

const STORE_SHA = /workers-sdk\+wrangler@([0-9a-f]{7,40})/;

/** What to run when the install and the pin disagree. A plain frozen install
 *  over the stale tree DOES relink wrangler (measured 2026-09-27, @b168333 to
 *  @3572193), so the `rm -rf` is not what fixes this link. It is named anyway
 *  because the same stale tree keeps every old store entry it ever held, and
 *  those still leak into type resolution (gotcha 44, the third door). */
export const STALE_INSTALL_REMEDY = "rm -rf node_modules && bun install --frozen-lockfile";

export function pinnedSha(pin: string): string | undefined {
  return COMMIT_PIN.exec(pin)?.[1];
}

export function installedSha(manifestRealpath: string): string | undefined {
  return STORE_SHA.exec(manifestRealpath)?.[1];
}
