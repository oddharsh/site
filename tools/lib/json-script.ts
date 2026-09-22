// The JSON arm of build.ts's inline transform: the 92 `<script>` blocks whose
// body is data rather than code (54 speculation rules, 37 understanding-check
// payloads, one JSON-LD graph, measured 2026-09-15) used to pass through
// verbatim, indentation and all. Whitespace outside a JSON string is nothing
// to any consumer, and it is 38 KB raw across the staged tree, 2.3 KB after
// brotli, 40 B a page, which is the same neighbourhood as `keep_closing_tags`.
//
// The serializer is the runtime's own `JSON.stringify(JSON.parse())`, and that
// is a measured choice rather than the lazy one: against a whitespace-only
// stripper and @swc/html's serde pass it is the smallest (canonical shortest
// form) and the fastest (0.47 ms for every block on the site, 3x under the
// stripper and 18x under swc).
//
// What it is NOT is text-preserving, and inside a `<script>` element the text
// is what the HTML tokenizer reads first. A script element is raw text, so the
// only byte sequences that can end or damage it are `</script` and `<!--`.
// JSON.parse unescapes `\/` and `<` back to literal characters and
// JSON.stringify never re-escapes `<`, so a string authored safely as
// `"<\/script>"` would come out of the round trip as a live close tag and
// truncate the element at that point. Zero blocks carry either sequence today
// and one (garage/typed-config) already carries a deliberate `<`, which
// is the shape of the future bug. Two guards, one for each sequence, and the
// output is checked for both on every build so the guard failing is a red
// build rather than a silent truncated quiz.

import { isDeepStrictEqual } from "node:util";

// A NUMBER is the one value this round trip can change silently, and the
// deep-equal guard below is structurally unable to see it: both of its sides
// have been through JSON.parse, so a literal that lost precision compares equal
// to the copy that lost it the same way. `9007199254740993` (2^53 + 1) is the
// shape, since it parses to ...992 and re-serializes as that, and a block
// carrying a snowflake id, a chain amount or a nanosecond timestamp is where
// one would arrive.
//
// So the drift is REMOVED rather than detected. The reviver hands every number
// back as `JSON.rawJSON` of its own source text, which JSON.stringify emits
// verbatim, leaving this pass able to delete whitespace and nothing else.
// Measured 2026-09-22 over the 78 committed blocks: every literal is already
// its own shortest form, so preserving them costs 0 bytes today, and the cost
// of the first non-canonical one is the few bytes it was authored with.
const preserveNumbers = (_key: string, value: unknown, context?: { source?: unknown }): unknown =>
  typeof value === "number" && typeof context?.source === "string" ? JSON.rawJSON(context.source) : value;

// Every number literal in `text`, in document order, exactly as written. A
// runtime with no source-text access cannot preserve anything and would leave
// this pass quietly canonicalizing again, which is the failure the whole
// preservation exists to end, so it fails here by name rather than degrade.
const numberLiterals = (label: string, text: string): string[] => {
  const literals: string[] = [];
  JSON.parse(text, (_key: string, value: unknown, context?: { source?: unknown }) => {
    if (typeof value === "number") {
      if (typeof context?.source !== "string") {
        throw new Error(`${label}: this runtime gives JSON.parse no source-text access, so a number literal cannot be preserved`);
      }
      literals.push(context.source);
    }
    return value;
  });
  return literals;
};

// `importmap` is JSON too and nothing here ships one yet; listing it costs
// nothing and means the first one is minified rather than remembered.
const JSON_SCRIPT_TYPES = new Set(["application/json", "application/ld+json", "speculationrules", "importmap"]);

export const isJsonScriptType = (type: string): boolean => JSON_SCRIPT_TYPES.has(type.toLowerCase());

export const minifyJsonScript = (label: string, body: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label}: JSON script body does not parse: ${(error as Error).message}`);
  }
  const out = JSON.stringify(JSON.parse(body, preserveNumbers))
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "\\u003c!--");
  // Every claim this pass makes, re-proven per block: the guard left nothing
  // that can end the element, the escapes it added changed no value, and every
  // number reached the output as the author wrote it.
  if (/<\/|<!--/.test(out)) throw new Error(`${label}: JSON script body still carries a sequence that ends a script element`);
  if (!isDeepStrictEqual(JSON.parse(out), value)) throw new Error(`${label}: JSON script body did not survive minification`);
  const before = numberLiterals(label, body), after = numberLiterals(label, out);
  if (!isDeepStrictEqual(before, after)) {
    const i = after.findIndex((literal, at) => literal !== before[at]);
    throw new Error(`${label}: JSON script body changed a number literal (${before[i] ?? "?"} -> ${after[i] ?? "?"})`);
  }
  return out;
};
