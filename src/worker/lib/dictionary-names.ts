// PURE on purpose: no `node:` and no `cloudflare:` import, so the Worker, the
// build and the contract suite all load the same file (docs/GOTCHAS.md gotcha 16).
// The zstd ENCODER needs node:zlib and lives in tools/lib/dcz.ts.

export const HASH8_HEX = 8;
export const TAG_HEX = 16;

const hexOf = (bytes: Uint8Array, count: number): string => {
  let out = "";
  for (let i = 0; i < count; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
};

export function tagOfDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error(`dictionary tag: expected a 32-byte SHA-256 digest, got ${digest.length} bytes`);
  return hexOf(digest, TAG_HEX / 2);
}

// Available-Dictionary is a Structured Field Byte Sequence: `:<base64 sha256>:`.
// Returns the tag the build put in each .dcz filename for that dictionary, or
// null if the header is absent or malformed.
export function tagFromAvailableDictionary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^:([A-Za-z0-9+/=]+):$/);
  if (!m) return null;
  try {
    const digest = Uint8Array.fromBase64(m[1]);
    if (digest.length !== 32) return null;
    return tagOfDigest(digest);
  } catch { return null; }
}

export type ShellAsset = { base: string; hash8: string; ext: string; name: string };

const SHELL_ASSET = /^(.+)\.([0-9a-f]{8})\.(js|css|svg)$/;

export function parseShellAsset(name: string): ShellAsset | null {
  const m = name.match(SHELL_ASSET);
  return m ? { base: m[1], hash8: m[2], ext: m[3], name } : null;
}

export const shellAssetName = (asset: { base: string; hash8: string; ext: string }): string =>
  `${asset.base}.${asset.hash8}.${asset.ext}`;

const FAMILY_DICTIONARY = /^page-family\.([0-9a-f]{8})\.dict$/;

export const familyDictionaryName = (hash8: string): string => `page-family.${hash8}.dict`;

export function parseFamilyDictionary(name: string): string | null {
  return name.match(FAMILY_DICTIONARY)?.[1] ?? null;
}

const SHELL_DELTA = /^(.+)\.([0-9a-f]{8})\.([0-9a-f]{16})\.dcz$/;

export const shellDeltaName = (asset: { base: string; hash8: string }, tag: string): string =>
  `${asset.base}.${asset.hash8}.${tag}.dcz`;

export function parseShellDelta(name: string): { base: string; hash8: string; tag: string } | null {
  const m = name.match(SHELL_DELTA);
  return m ? { base: m[1], hash8: m[2], tag: m[3] } : null;
}

export function shellDeltaPath(pathname: string, tag: string): string | null {
  if (!pathname.startsWith("/a/")) return null;
  const asset = parseShellAsset(pathname.slice("/a/".length));
  return asset ? `/ad/${shellDeltaName(asset, tag)}` : null;
}

export const pageSlug = (assetPath: string): string =>
  assetPath.replace(/\.html$/, "").replace(/\//g, "__");

const PAGE_DELTA = /^(.+)\.([0-9a-f]{16})\.dcz$/;
const PAGE_SNAPSHOT = /^(.+)\.([0-9a-f]{16})\.html\.br$/;

export const pageDeltaName = (slug: string, tag: string): string => `${slug}.${tag}.dcz`;

export function parsePageDelta(name: string): { slug: string; tag: string } | null {
  const m = name.match(PAGE_DELTA);
  return m ? { slug: m[1], tag: m[2] } : null;
}

export const pageSnapshotName = (slug: string, tag: string): string => `${slug}.${tag}.html.br`;

export function parsePageSnapshot(name: string): { slug: string; tag: string; name: string } | null {
  const m = name.match(PAGE_SNAPSHOT);
  return m ? { slug: m[1], tag: m[2], name } : null;
}

export function pageDeltaPaths(rel: string, tag: string): string[] {
  return [rel, `${rel}/index`].map((stem) => `/pd/${pageDeltaName(pageSlug(stem), tag)}`);
}

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

export function parseDcz<T extends Uint8Array>(bytes: T): { digest: T; frame: T } | null {
  if (bytes.length < DCZ_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== DCZ_MAGIC || view.getUint32(4, true) !== DCZ_DIGEST_BYTES) return null;
  return {
    digest: bytes.subarray(8, DCZ_HEADER_BYTES) as T,
    frame: bytes.subarray(DCZ_HEADER_BYTES) as T,
  };
}
