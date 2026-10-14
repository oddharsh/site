// platform-extras.d.ts — members the tools' program needs that its lib does not
// declare, for the same reason browser-lab.d.ts exists beside it.

interface CacheStorage {
  /** workerd's named default cache. Not in lib.dom, and not invented here. */
  default?: Cache;
}

interface JsonWebKey {
  /** RFC 7517 §4.5 key id. */
  kid?: string;
}

// `JSON.rawJSON` is ES2025 (the same proposal as the reviver's third argument,
// which this lib DOES declare) and lib/json-script.ts needs it to emit a number
// exactly as it was authored. Every runtime this repo uses has it, measured
// 2026-09-22 on bun 1.4.2 and node 26.9.0; TypeScript's lib carries half the
// proposal, which is the gap rather than a reason to cast.

/** The opaque wrapper `JSON.stringify` emits verbatim. */
interface RawJSON {
  readonly rawJSON: string;
}

interface JSON {
  /** Wrap valid JSON source text so `JSON.stringify` emits it unchanged. */
  rawJSON(text: string): RawJSON;
  /** Whether `value` came from `JSON.rawJSON`. */
  isRawJSON(value: unknown): boolean;
}
