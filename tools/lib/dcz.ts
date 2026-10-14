// dcz.ts: the one dcz ENCODER, for the build and for every tool that re-measures
// what the build would have written.

import { createHash } from "node:crypto";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { DCZ_ZSTD_LEVEL, dczHeader, tagOfDigest } from "../../src/worker/lib/dictionary-names.ts";
import { zstdCompressDictionaryBatch } from "./zstd-batch.ts";

// One page or asset against one RAW dictionary, at the level the build ships.
// Keep it synchronous: zlib's async zstd API changed every `.dcz` byte.
export function zstdDictionaryFrame(bytes: Uint8Array, dictBytes: Uint8Array): Buffer {
  return zstdCompressSync(bytes, {
    dictionary: dictBytes,
    params: { [zlibConstants.ZSTD_c_compressionLevel]: DCZ_ZSTD_LEVEL },
  });
}

// dcz framing (RFC 9842), the one construction both delta passes share: prepend
// the dictionary's SHA-256 in a Zstandard skippable frame. `tag` is what the
// file is named by, and what a browser holding the dictionary sends back.
export function frameDcz(frame: Uint8Array, dictBytes: Uint8Array): { out: Buffer; digest: Buffer; tag: string } {
  const digest = createHash("sha256").update(dictBytes).digest();
  return {
    out: Buffer.concat([dczHeader(digest), frame]),
    digest,
    tag: tagOfDigest(digest),
  };
}

export function dczEncode(bytes: Uint8Array, dictBytes: Uint8Array) {
  return frameDcz(zstdDictionaryFrame(bytes, dictBytes), dictBytes);
}

export async function dczEncodeBatch(jobs: Array<{ bytes: Uint8Array; dictBytes: Uint8Array }>) {
  const frames = await zstdCompressDictionaryBatch(jobs.map(({ bytes, dictBytes }) => ({
    bytes,
    dictionary: dictBytes,
  })));
  return jobs.map(({ dictBytes }, index) => frameDcz(frames[index], dictBytes));
}

export const dictionaryTag = (dictBytes: Uint8Array): string =>
  tagOfDigest(createHash("sha256").update(dictBytes).digest());
