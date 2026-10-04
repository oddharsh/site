// dictionary-names.ts: the shared-dictionary wire contract, written once.
//
// The build WRITES dictionary artifacts and the Worker READS them, and until
// 2026-10-02 the two shared no code: the name grammar, the tag rule and the
// frame layout were restated in build.ts, lib/assets.ts and six tools. A
// disagreement between any two has no symptom. A delta the Worker cannot find
// degrades to plain brotli, which is a correct page at a larger size. That is
// how /garage asked for `garage.<tag>.dcz` for months while the build wrote
// `garage__index.<tag>.dcz` (measured 2026-07-28, 16% wasted on that page).
//
// So this module answers one question for both sides: which file holds the
// delta for this URL against this dictionary. Four name families and one frame:
//
//   /a/<base>.<hash8>.<ext>             a content-hashed shell asset
//   /a/page-family.<hash8>.dict         the site-page family dictionary
//   /ad/<base>.<hash8>.<tag16>.dcz      a shell asset's delta against one dictionary
//   /pd/<slug>.<tag16>.dcz              a page's delta against one dictionary
//   <slug>.<tag16>.html.br              a committed page snapshot (src/dict/p-dict)
//
// hash8 is the first 8 hex of a SHA-256 over the asset's own bytes. tag16 is
// the first 16 hex of a SHA-256 over the DICTIONARY's bytes, which is what a
// browser sends back in Available-Dictionary. slug is the page's asset path
// with `.html` dropped and every `/` folded to `__`, so it stays one filename
// segment.
//
// PURE on purpose: no `node:` and no `cloudflare:` import, so the Worker, the
// build and the contract suite all load the same file (docs/GOTCHAS.md gotcha 16).
// The zstd ENCODER needs node:zlib and lives in tools/lib/dcz.ts.

// ── tags ────────────────────────────────────────────────────────────────────

export const HASH8_HEX = 8;
export const TAG_HEX = 16;

const hexOf = (bytes: Uint8Array, count: number): string => {
  let out = "";
  for (let i = 0; i < count; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
};

// The 16-hex tag that names a dictionary in every delta filename, from that
// dictionary's raw SHA-256 digest.
export function tagOfDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error(`dictionary tag: expected a 32-byte SHA-256 digest, got ${digest.length} bytes`);
  return hexOf(digest, TAG_HEX / 2);
}

// Available-Dictionary is a Structured Field Byte Sequence: `:<base64 sha256>:`.
// Returns the tag the build put in each .dcz filename for that dictionary, or
// null if the header is absent or malformed.
//
// Deliberately strict. This value selects a file path, so anything unexpected
// must become null rather than something that could escape the /ad/ or /pd/
// prefix: the base64 is length-checked to a 32-byte digest and the result is
// re-derived as hex, so only [0-9a-f] can ever reach the URL.
export function tagFromAvailableDictionary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^:([A-Za-z0-9+/=]+):$/);
  if (!m) return null;
  try {
    const digest = Uint8Array.fromBase64(m[1]);
    if (digest.length !== 32) return null;       // not a SHA-256 digest
    return tagOfDigest(digest);
  } catch { return null; }
}

// ── /a/<base>.<hash8>.<ext>: shell assets that can carry a delta ────────────

// js, css and the icon sprite. A delta exists only for these (DICTIONARY_TYPES
// in lib/assets.ts gates the same set on the serving side).
export type ShellAsset = { base: string; hash8: string; ext: string; name: string };

const SHELL_ASSET = /^(.+)\.([0-9a-f]{8})\.(js|css|svg)$/;

// `nav.1a2b3c4d.js` -> its parts, or null for anything else in /a/ or a-dict
// (a `.br` twin, the family dictionary, a quiz payload).
export function parseShellAsset(name: string): ShellAsset | null {
  const m = name.match(SHELL_ASSET);
  return m ? { base: m[1], hash8: m[2], ext: m[3], name } : null;
}

export const shellAssetName = (asset: { base: string; hash8: string; ext: string }): string =>
  `${asset.base}.${asset.hash8}.${asset.ext}`;

// ── /a/page-family.<hash8>.dict ─────────────────────────────────────────────

const FAMILY_DICTIONARY = /^page-family\.([0-9a-f]{8})\.dict$/;

export const familyDictionaryName = (hash8: string): string => `page-family.${hash8}.dict`;

// The dictionary's hash8 from its file name, or null when the name is not one.
export function parseFamilyDictionary(name: string): string | null {
  return name.match(FAMILY_DICTIONARY)?.[1] ?? null;
}

// ── /ad/<base>.<hash8>.<tag16>.dcz ──────────────────────────────────────────

const SHELL_DELTA = /^(.+)\.([0-9a-f]{8})\.([0-9a-f]{16})\.dcz$/;

// The file under /ad/ holding `asset` encoded against the dictionary `tag` names.
// The extension is deliberately absent: a base never ships under two types.
export const shellDeltaName = (asset: { base: string; hash8: string }, tag: string): string =>
  `${asset.base}.${asset.hash8}.${tag}.dcz`;

export function parseShellDelta(name: string): { base: string; hash8: string; tag: string } | null {
  const m = name.match(SHELL_DELTA);
  return m ? { base: m[1], hash8: m[2], tag: m[3] } : null;
}

// The reader's half: /a/<base>.<hash8>.<ext> -> /ad/<base>.<hash8>.<tag>.dcz, or
// null when the request names nothing a delta could exist for.
export function shellDeltaPath(pathname: string, tag: string): string | null {
  if (!pathname.startsWith("/a/")) return null;
  const asset = parseShellAsset(pathname.slice("/a/".length));
  return asset ? `/ad/${shellDeltaName(asset, tag)}` : null;
}

// ── /pd/<slug>.<tag16>.dcz and the committed snapshots ──────────────────────

// slug: the asset path with separators folded, so it survives as one filename
// segment. `garage/index.html` -> `garage__index`; an extensionless stem
// (`garage/index`) gives the same answer, which is what lets the Worker call it.
export const pageSlug = (assetPath: string): string =>
  assetPath.replace(/\.html$/, "").replace(/\//g, "__");

const PAGE_DELTA = /^(.+)\.([0-9a-f]{16})\.dcz$/;
const PAGE_SNAPSHOT = /^(.+)\.([0-9a-f]{16})\.html\.br$/;

export const pageDeltaName = (slug: string, tag: string): string => `${slug}.${tag}.dcz`;

export function parsePageDelta(name: string): { slug: string; tag: string } | null {
  const m = name.match(PAGE_DELTA);
  return m ? { slug: m[1], tag: m[2] } : null;
}

// A page snapshot in src/dict/p-dict: the bytes production served, brotli'd,
// named by the tag a browser holding them would send.
export const pageSnapshotName = (slug: string, tag: string): string => `${slug}.${tag}.html.br`;

export function parsePageSnapshot(name: string): { slug: string; tag: string; name: string } | null {
  const m = name.match(PAGE_SNAPSHOT);
  return m ? { slug: m[1], tag: m[2], name } : null;
}

// The reader's half. The build names a delta after the ASSET path; a request
// carries only the ROUTE, and `html_handling: "drop-trailing-slash"` makes those
// differ for exactly one shape: a section index, where /garage is served by
// garage/index.html. So a route has two candidate assets, and the delta is at
// whichever one the build staged.
//
// Direct name first, so a sub-page still costs one lookup and only an index
// pays for the second. `rel` is the request path with its slashes trimmed
// (`garage`, `garage/pretext`), and `index` for the root.
export function pageDeltaPaths(rel: string, tag: string): string[] {
  return [rel, `${rel}/index`].map((stem) => `/pd/${pageDeltaName(pageSlug(stem), tag)}`);
}

// ── the dcz frame (RFC 9842) ────────────────────────────────────────────────

// A dcz body is the dictionary's SHA-256 in a Zstandard SKIPPABLE frame (magic
// 0x184D2A5E little-endian, a 4-byte LE length of 32, then the raw digest),
// followed by the zstd frame itself. Being valid zstd, that prefix is skipped by
// any conforming decoder, which is what lets `zstd -d -D dict` round-trip the
// whole file.
export const DCZ_MAGIC = 0x184d2a5e;
export const DCZ_DIGEST_BYTES = 32;
export const DCZ_HEADER_BYTES = 4 + 4 + DCZ_DIGEST_BYTES;

// zstd above 19 is dead weight at these sizes (gotcha 14 has both tables), so
// every delta the build ships and every tool that re-measures one uses this.
export const DCZ_ZSTD_LEVEL = 19;

export function dczHeader(digest: Uint8Array): Uint8Array {
  if (digest.length !== DCZ_DIGEST_BYTES) throw new Error(`dcz header: expected a ${DCZ_DIGEST_BYTES}-byte SHA-256 digest, got ${digest.length} bytes`);
  const header = new Uint8Array(DCZ_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, DCZ_MAGIC, true);
  view.setUint32(4, DCZ_DIGEST_BYTES, true);
  header.set(digest, 8);
  return header;
}

// The dictionary digest a dcz body names and the zstd frame after it, or null
// when the bytes do not open with a well-formed header.
export function parseDcz<T extends Uint8Array>(bytes: T): { digest: T; frame: T } | null {
  if (bytes.length < DCZ_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== DCZ_MAGIC || view.getUint32(4, true) !== DCZ_DIGEST_BYTES) return null;
  return {
    digest: bytes.subarray(8, DCZ_HEADER_BYTES) as T,
    frame: bytes.subarray(DCZ_HEADER_BYTES) as T,
  };
}
