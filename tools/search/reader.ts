// Experimental v1 packed-corpus reader. Validation is completed before callers
// receive records; malformed assets cannot masquerade as an empty valid corpus.
import type { SearchRecord } from "../../src/worker/search.ts";

export function unpackCorpus(bytes: Uint8Array): { version: number; generatedAt: string; records: SearchRecord[] } {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("packed corpus exceeds 16 MiB");
  // These are length-framed strings, not independent files. A leading U+FEFF
  // is content and must not be consumed as an encoding signature.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let offset = 0;
  function byte(): number {
    if (offset >= bytes.length) throw new Error("truncated packed corpus");
    return bytes[offset++];
  }
  function integer(): number {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const part = byte();
      value += (part & 127) * 2 ** shift;
      if (value > 0xffffffff) throw new Error("packed integer overflow");
      if (!(part & 128)) {
        if (shift && part === 0) throw new Error("noncanonical packed integer");
        return value;
      }
    }
    throw new Error("packed integer overflow");
  }
  function utf8(length: number): string {
    if (length > bytes.length - offset) throw new Error("truncated packed string");
    const value = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value;
  }
  function string(): string { return utf8(integer()); }
  for (const part of [83, 83, 73, 88, 1]) {
    if (byte() !== part) throw new Error("unsupported packed corpus version");
  }
  const generatedAt = string();
  const vocabularySize = integer();
  if (vocabularySize > bytes.length - offset) throw new Error("invalid packed vocabulary count");
  const vocabulary: string[] = [];
  const tokenBytes: number[] = [];
  for (let i = 0; i < vocabularySize; i++) {
    const length = integer();
    const token = utf8(length);
    if (!token) throw new Error("empty packed token");
    vocabulary.push(token);
    // Preserve the byte budget rather than counting UTF-16 code units.
    tokenBytes.push(length);
  }
  const count = integer();
  if (count > bytes.length - offset) throw new Error("invalid packed document count");
  const records: SearchRecord[] = [];
  const urls = new Set<string>();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    const url = string(), title = string(), description = string();
    if (!url.startsWith("/") || url.startsWith("//") || urls.has(url)) throw new Error("invalid packed route");
    urls.add(url);
    const kind = (["page", "writing", "document", "utility"] as const)[byte()];
    if (!kind) throw new Error("invalid packed document kind");
    const tokenCount = integer();
    if (tokenCount > bytes.length - offset) throw new Error("invalid packed token count");
    const text: string[] = [];
    for (let j = 0; j < tokenCount; j++) {
      const id = integer();
      const token = vocabulary[id];
      if (token === undefined) throw new Error("invalid packed token reference");
      expanded += tokenBytes[id];
      if (expanded > 16 * 1024 * 1024) throw new Error("expanded corpus exceeds 16 MiB");
      text.push(token);
    }
    records.push({ url, title, description, kind, text: text.join("") });
  }
  if (offset !== bytes.length) throw new Error("trailing packed corpus bytes");
  return { version: 1, generatedAt, records };
}
