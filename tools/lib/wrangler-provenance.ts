// wrangler-provenance.ts — which wrangler TARBALL node_modules actually holds.
//
// A commit pin (`https://pkg.pr.new/cloudflare/workers-sdk/wrangler@<sha>`)
// names a tarball, and two tarballs from workers-sdk main routinely carry the
// SAME `version` field, so reading package.json's version cannot tell a stale
// install from a fresh one. Measured 2026-09-27: a tree holding wrangler@b168333
// under a package.json and bun.lock pinning @3572193 passed check-wrangler,
// which compared the installed version against itself and then read the
// COMMITTED lockfile, which says nothing about node_modules.
//
// What does carry the identity is bun's store directory, which is the tarball
// URL with its separators flattened:
//
//   node_modules/.bun/wrangler@https+++pkg.pr.new+cloudflare+workers-sdk+wrangler@3572193+<hash>/
//
// So the sha is read off the REALPATH of node_modules/wrangler/package.json.
// This module is pure string work with no imports, because check-wrangler's
// contract test copies it into a scratch repository beside that script.

/** The one pin shape that names a workers-sdk commit. Group 1 is the sha. */
export const COMMIT_PIN = /^https:\/\/pkg\.pr\.new\/cloudflare\/workers-sdk\/wrangler@([0-9a-f]{7,40})$/;

/** The sha inside bun's store path for a pkg.pr.new wrangler. */
const STORE_SHA = /workers-sdk\+wrangler@([0-9a-f]{7,40})/;

/** What to run when the install and the pin disagree. A plain frozen install
 *  over the stale tree DOES relink wrangler (measured 2026-09-27, @b168333 to
 *  @3572193), so the `rm -rf` is not what fixes this link. It is named anyway
 *  because the same stale tree keeps every old store entry it ever held, and
 *  those still leak into type resolution (gotcha 44, the third door). */
export const STALE_INSTALL_REMEDY = "rm -rf node_modules && bun install --frozen-lockfile";

/** The sha a commit pin names, or undefined for any other pin shape. */
export function pinnedSha(pin: string): string | undefined {
  return COMMIT_PIN.exec(pin)?.[1];
}

/** The sha bun's store path records for the installed wrangler, or undefined
 *  when the path carries none (a release install, or a non-bun layout). Pass
 *  the REALPATH of node_modules/wrangler/package.json, never the symlink. */
export function installedSha(manifestRealpath: string): string | undefined {
  return STORE_SHA.exec(manifestRealpath)?.[1];
}
