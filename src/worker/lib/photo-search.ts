// lib/photo-search.ts: the photo query's ranking, as an index over the archive.
//
// queryPhotos used to answer `q` by calling fieldMatches (lib/text.ts) once per
// (term, field, photo): once to count how often each (term, field) pair matched,
// once more to score every photo. Both passes walk every field string, so a cold
// query grew with the archive: 3.0 ms at 165 photos and 12.0 ms with the archive
// duplicated 8x, against a 10 ms Workers Free budget.
//
// This keeps fieldMatches' four rules and moves the string work out of the
// request. Each field gets a sorted dictionary of its tokens and, per token, a
// bitset of the photos whose field holds it. Each rule becomes a lookup:
//   - a token starts with the term or its stem: one contiguous run of the sorted dictionary
//   - a token of 5+ characters is a prefix of the term: exact lookups of term[0..5], term[0..6], ...
//   - a term carrying a digit sits inside a larger run: a substring scan of the field's DISTINCT values
// and a pair's document frequency is a popcount.
//
// Measured 2026-11-03, cold first query, median of 7 fresh bun processes, with
// metadata.json's parse left out of all three because every path pays it:
//   archive          strings     index built in the isolate   index baked at build
//   165 photos       3.02 ms     3.00 ms                      0.77 ms
//   duplicated 8x    12.04 ms    12.05 ms                     1.22 ms
// Building the index inside the isolate costs what it saves, so build.ts bakes
// it into /images/photo-search.bin and the Worker only decodes it. Where no
// baked file exists (local dev, the contract fixtures) queryPhotos builds the
// same index from the JSON it already read, so both paths run one ranker.
//
// fieldMatches stays the specification. A contract test holds every bit of the
// real archive's index to it, field by field.

import { asScalarText } from "./parse.ts";
import { compareCodepoints, isWord, normalize } from "./text.ts";

// Which field a term hit says a lot about what the caller meant, so the fields
// are weighted rather than joined. `film` outranks `alt` deliberately: "classic
// chrome" is overwhelmingly a film-simulation query, and the same two words
// appearing in a caption about a chrome bumper is the weaker reading.
//
// `expansion` is the offline semantic tier (images/semantics.json). It sits
// below the caption a model actually looked at the photo to write, and above
// the recipe card, because it is a recall aid rather than an observation.
export const PHOTO_FIELD_WEIGHTS = [
  ["film", 6],
  ["alt", 5],
  ["camera", 4],
  ["lens", 4],
  ["expansion", 3],
  ["year", 3],
  ["recipe", 2],
  ["stem", 1],
] as const;

type FieldName = (typeof PHOTO_FIELD_WEIGHTS)[number][0];

type Scalar = string | number | null;
type SearchableRecord = { film?: Scalar; camera?: Scalar; lens?: Scalar; date?: Scalar; recipe?: Record<string, unknown> | null };

export function photoFields(stem: string, record: SearchableRecord, alt, expansion): Record<FieldName, string> {
  const date = String(record.date || "")
    .slice(0, 10)
    .replaceAll(":", "-");
  return {
    film: String(record.film || ""),
    alt: String(alt || ""),
    camera: String(record.camera || ""),
    lens: String(record.lens || ""),
    expansion: String(expansion || ""),
    year: date.slice(0, 4),
    recipe: Object.entries(record.recipe || {})
      .map(([k, v]) => `${k}: ${asScalarText(v)}`)
      .join(" "),
    stem: String(stem),
  };
}

// One field across the archive. A row set is `words` u32s, bit `row` set when
// that photo belongs; tokenRows holds tokens.length of them back to back.
type FieldIndex = {
  tokens: string[];
  tokenRows: Uint32Array;
  values: string[];
  valueRows: Uint32Array;
};

// `fields` is in PHOTO_FIELD_WEIGHTS order; row i is stems[i].
export type PhotoSearchIndex = { stems: string[]; words: number; fields: FieldIndex[] };

// terms() in lib/text.ts splits a query on the same class.
const NON_WORD_RUN = /[^\p{L}\p{N}]+/u;

const wordsFor = (rows: number) => (rows + 31) >>> 5;

function packRows(entries: [string, Uint32Array][], words: number): [string[], Uint32Array] {
  const rows = new Uint32Array(entries.length * words);
  entries.forEach(([, set], k) => rows.set(set, k * words));
  return [entries.map(([key]) => key), rows];
}

export function buildPhotoSearchIndex(metadata: Record<string, SearchableRecord>, altMap, semantics): PhotoSearchIndex {
  const stems = Object.keys(metadata);
  const words = wordsFor(stems.length);
  const texts = stems.map((stem) => photoFields(stem, metadata[stem], altMap?.[stem], semantics?.[stem]?.terms));
  const fields = PHOTO_FIELD_WEIGHTS.map(([name]) => {
    const tokenSets = new Map<string, Uint32Array>();
    const valueSets = new Map<string, Uint32Array>();
    const mark = (sets: Map<string, Uint32Array>, key: string, row: number) => {
      let set = sets.get(key);
      if (!set) sets.set(key, (set = new Uint32Array(words)));
      set[row >>> 5] |= 1 << (row & 31);
    };
    texts.forEach((text, row) => {
      const value = text[name].toLowerCase();
      if (!value) return;
      mark(valueSets, value, row);
      for (const token of value.split(NON_WORD_RUN)) if (token) mark(tokenSets, token, row);
    });
    const [tokens, tokenRows] = packRows(
      [...tokenSets].sort(([a], [b]) => compareCodepoints(a, b)),
      words,
    );
    const [values, valueRows] = packRows([...valueSets], words);
    return { tokens, tokenRows, values, valueRows };
  });
  return { stems, words, fields };
}

// The baked file, every number a native-endian u32 (little-endian on every
// machine that builds or serves this):
//   photo count, then per field its token count and value count
//   the UTF-16 length of every string: stems, then per field its tokens and values
//   every row set: per field its tokenRows, then its valueRows
//   every string as UTF-8, concatenated in the order of the lengths
// The strings come last so the u32 part starts aligned, and lengths rather than
// a separator because a field value can hold any character.
export function encodePhotoSearchIndex(index: PhotoSearchIndex): Uint8Array<ArrayBuffer> {
  const strings = [...index.stems, ...index.fields.flatMap((field) => [...field.tokens, ...field.values])];
  const head = [index.stems.length, ...index.fields.flatMap((field) => [field.tokens.length, field.values.length]), ...strings.map((s) => s.length)];
  const rowWords = index.fields.reduce((n, field) => n + field.tokenRows.length + field.valueRows.length, 0);
  const text = new TextEncoder().encode(strings.join(""));
  const out = new Uint8Array((head.length + rowWords) * 4 + text.length);
  const u32 = new Uint32Array(out.buffer, 0, head.length + rowWords);
  u32.set(head);
  let at = head.length;
  for (const field of index.fields) {
    u32.set(field.tokenRows, at);
    at += field.tokenRows.length;
    u32.set(field.valueRows, at);
    at += field.valueRows.length;
  }
  out.set(text, at * 4);
  return out;
}

export function decodePhotoSearchIndex(buffer: ArrayBuffer): PhotoSearchIndex {
  const u32 = new Uint32Array(buffer, 0, buffer.byteLength >>> 2);
  let at = 0;
  const photos = u32[at++];
  const words = wordsFor(photos);
  const counts = PHOTO_FIELD_WEIGHTS.map(() => [u32[at++], u32[at++]]);
  const lengths = u32.subarray(at, (at += counts.reduce((n, [tokens, values]) => n + tokens + values, photos)));
  const rows = counts.map(([tokens, values]) => [u32.subarray(at, (at += tokens * words)), u32.subarray(at, (at += values * words))]);
  const text = new TextDecoder().decode(new Uint8Array(buffer, at * 4));
  let cursor = 0;
  let next = 0;
  const take = (n: number) => Array.from({ length: n }, () => text.slice(cursor, (cursor += lengths[next++])));
  const stems = take(photos);
  const fields = counts.map(([tokens, values], f) => ({ tokens: take(tokens), tokenRows: rows[f][0], values: take(values), valueRows: rows[f][1] }));
  return { stems, words, fields };
}

// The first index whose token sorts at or after `key`.
function lowerBound(tokens: string[], key: string) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Every row whose field fieldMatches(value, term) accepts, in fieldMatches'
// rule order. `term` arrives lowercased, as queryTerms leaves it.
export function matchingRows(field: FieldIndex, term: string, words: number): Uint32Array {
  const out = new Uint32Array(words);
  if (!term) return out;
  const { tokens } = field;
  const orRows = (rows: Uint32Array, k: number) => {
    for (let w = 0; w < words; w++) out[w] |= rows[k * words + w];
  };
  const tokensStartingWith = (prefix: string) => {
    for (let k = lowerBound(tokens, prefix); k < tokens.length && tokens[k].startsWith(prefix); k++) orRows(field.tokenRows, k);
  };
  const stem = normalize(term);
  if (isWord(term)) tokensStartingWith(term);
  if (stem !== term && isWord(stem)) tokensStartingWith(stem);
  if (term.length > 5) {
    for (let end = 5; end <= term.length; end++) {
      const prefix = term.slice(0, end);
      const k = lowerBound(tokens, prefix);
      if (tokens[k] === prefix) orRows(field.tokenRows, k);
    }
  }
  if (/\d/.test(term))
    field.values.forEach((value, k) => {
      if (value.includes(term)) orRows(field.valueRows, k);
    });
  return out;
}

function popcount(rows: Uint32Array) {
  let n = 0;
  for (let x of rows) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    n += Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }
  return n;
}

const has = (rows: Uint32Array, row: number) => ((rows[row >>> 5] >>> (row & 31)) & 1) === 1;

// Which (term, field) pairs carry no information, because that field matches
// the term in most of the candidates.
//
// The case that forced this, when the archive held 158 photos: every Fuji
// recipe card contains "Exposure Compensation", so a query for "long exposure"
// matched "exposure" in 151 of 158 recipe cards. Nothing was a long exposure
// then (the longest shutter was well under a second), yet the query returned the whole archive,
// ranked by a term that told you nothing.
//
// Deliberately per FIELD rather than per term. Dropping "chrome" outright
// because it appears in all 158 recipe cards would also blind the query to the
// 42 photos whose FILM is Classic Chrome, where the same word is the most
// discriminating thing about them. The word is noise in one field and signal in
// another, and only the pair can tell those apart.
//
// The threshold is 90%, not a half. A term matching half the corpus is at its
// MOST discriminating (it splits the set cleanly), so suppressing there would
// throw away the best signal there is. Only a term matching almost everything
// has stopped saying anything, and the case that forced this was 151 of 158.
//
// A hard threshold rather than a weighted idf: the score is meant to be read by
// a caller deciding whether to trust a result, and "this field matched 96% of
// the archive, so it was ignored" survives being explained. A logarithm does not.
//
// Below the floor there is no distribution to measure, and pruning on a
// handful of records would just be noise amplified into a rule.
const COMMON_SHARE = 0.9;
const COMMON_FLOOR = 4;

// Score every candidate row against the query. `candidates` is the rows that
// survived queryPhotos' filters, and a pair's frequency is measured inside it.
//
// Each term scores ONCE, at the weight of the best field it hit, rather than
// accumulating across every field it appears in. A camera name that also
// appears in the recipe card and the stem would otherwise triple-count, so the
// photos that rank highest would be the ones with the most redundant metadata
// rather than the ones that best answer the query.
//
// `common` names the terms suppressed everywhere they appeared and informative
// nowhere: in the corpus, and telling you nothing about which part. A term that
// appears NOWHERE is absent instead, and is deliberately not reported there.
export function rankPhotoRows(index: PhotoSearchIndex, queryTermList: string[], candidates: Uint32Array) {
  const { words } = index;
  const candidateCount = popcount(candidates);
  const common: string[] = [];
  // termRows[t][f]: the candidates term t scores in field f, or null for a pair
  // that matched nothing or was suppressed.
  const termRows = queryTermList.map((term) => {
    let suppressed = false;
    let informative = false;
    const perField = index.fields.map((field) => {
      const rows = matchingRows(field, term, words);
      for (let w = 0; w < words; w++) rows[w] &= candidates[w];
      const df = popcount(rows);
      if (!df) return null;
      if (candidateCount >= COMMON_FLOOR && df / candidateCount >= COMMON_SHARE) {
        suppressed = true;
        return null;
      }
      informative = true;
      return rows;
    });
    if (suppressed && !informative) common.push(term);
    return perField;
  });
  const scored: { stem: string; score: number; hits: number; matched: FieldName[] }[] = [];
  index.stems.forEach((stem, row) => {
    if (!has(candidates, row)) return;
    let score = 0;
    let hits = 0;
    const matched: FieldName[] = [];
    for (const perField of termRows) {
      let best = 0;
      let bestField: FieldName | null = null;
      for (let f = 0; f < perField.length; f++) {
        const [name, weight] = PHOTO_FIELD_WEIGHTS[f];
        const rows = perField[f];
        if (rows && weight > best && has(rows, row)) {
          best = weight;
          bestField = name;
        }
      }
      if (!bestField) continue;
      score += best;
      hits += 1;
      if (!matched.includes(bestField)) matched.push(bestField);
    }
    if (hits) scored.push({ stem, score, hits, matched });
  });
  return { scored, common };
}

// The candidate row set for a list of stems, e.g. the ones queryPhotos' filters kept.
export function rowsOf(index: PhotoSearchIndex, stems: Iterable<string>): Uint32Array {
  const wanted = new Set(stems);
  const rows = new Uint32Array(index.words);
  index.stems.forEach((stem, row) => {
    if (wanted.has(stem)) rows[row >>> 5] |= 1 << (row & 31);
  });
  return rows;
}
