// lib/text.js — the one tokenizer, and the scoring primitives built on it.
//
// Extracted from search.js when queryPhotos needed the same treatment. The site
// search had tokenized and field-weighted since it was written; the photo query
// never did, and matched `q` as ONE contiguous substring against a haystack of
// five joined fields. So "classic chrome bridge" could not match a Classic
// Chrome photo of a bridge — not because the words were missing, but because
// they were not ADJACENT in the order the join happened to produce.
//
// photos.js deliberately imports this rather than search.js: search.js pulls in
// lib/chrome.js and lib/cache.js to render its page, and the photo query has no
// business dragging a page renderer into its module graph.

// No ICU on a request path. The first localeCompare in an isolate builds a
// collator and the first toLocaleString builds a number formatter, and each
// costs more CPU than the rest of a query: measured in node on 2026-10-07, a
// cold /ledger/lines.html took 10.8ms, and 2.0ms once ICU was already warm,
// against Workers Free's 10ms. photos.ts derivePhotoPool hit the same thing at
// module scope. These two cover what the request paths used ICU for.
//
// A code-unit order, which is what a bare .sort() does to strings. It agrees
// with collation on every key the callers sort today (URLs, stems, dates,
// facet names; checked pairwise), and where it would differ (case, accents)
// it still gives a total order, which is all a tie-break needs.
export const compareCodepoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// 1234567 -> "1,234,567", what toLocaleString("en-US") prints for an integer.
// The same regex writing.ts and the lens islands already use client-side.
export const groupThousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// The original tokenizer, byte-for-byte. Site search is pinned on its behaviour
// (length > 1 drops "a"/"I", 12 terms caps the fan-out), so it moved houses
// without changing.
export function terms(query, max = 12) {
  return String(query || "").toLowerCase().trim().slice(0, 160)
    .split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1).slice(0, max);
}

// Words that carry intent in a sentence and none in a query. The photo-specific
// half matters more than the English half here: an agent asking a corpus of
// photographs will say "photos", "shot", "picture" constantly, and every one of
// those terms matches nothing and dilutes the ones that do.
//
// "shot" is a real photographic verb and still belongs here — "shot on classic
// chrome" wants to match on the film simulation, and a stray match against the
// word "shot" inside a caption is noise, not signal.
export const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "to", "for",
  "from", "by", "is", "are", "was", "were", "be", "it", "its", "that", "this",
  "these", "those", "as", "into", "over", "some", "any", "all", "me", "my",
  "you", "your", "i", "we", "us",
  // How an agent phrases a question. searchSiteRanked's own comment used "what
  // does he think about agents" as the example of a query stopwords rescue, and
  // not one of its filler words was in this set until 2026-09-23, so it searched
  // all six. Matching is SUBSTRING, so "he" hits nearly every page ("the",
  // "when") and every term is one more scan of the whole corpus: 1.33ms for that
  // query on a laptop against 30us for "zstd", measured by instruction count.
  "what", "which", "who", "how", "why", "when", "where", "does", "do", "did",
  "has", "have", "had", "he", "him", "his", "she", "her", "they", "them",
  "their", "about",
  // the photo-domain half
  "photo", "photos", "photograph", "photographs", "picture", "pictures",
  "image", "images", "shot", "shots", "pic", "pics", "show", "showing",
  "find", "search", "look", "looking", "get", "give", "want",
]);

// A deliberately shallow stem: strip a trailing plural "s" and nothing else.
// Real stemming (Porter, Snowball) would fold "lighting" into "light" and
// "buildings" into "build", which is right for a large corpus and wrong for 158
// captions where precision beats recall — an over-eager stem here silently
// merges distinct subjects and there is no ranking depth to recover from it.
export function normalize(term) {
  const value = String(term || "").toLowerCase();
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

// Split a query into the terms worth scoring and the ones deliberately dropped.
// `dropped` is returned rather than discarded so a caller can be TOLD why its
// query behaved the way it did — "photos of a bridge" scoring on ["bridge"]
// alone is correct, and invisible unless the result says so.
export function queryTerms(query, max = 12) {
  const all = terms(query, max);
  const kept = all.filter((term) => !STOPWORDS.has(term));
  // A query that is nothing but stopwords ("show me some photos") still has to
  // mean something. Falling back to the raw terms would score every photo on
  // noise, so the honest answer is no terms at all, and a mode that says so.
  return { terms: kept, dropped: all.filter((term) => STOPWORDS.has(term)) };
}

// Word boundaries first, substring only where there is genuinely no boundary
// to match on.
//
// A plain substring test looks right and fails on real metadata, in both
// directions. Measured against this archive's 158 records:
//
//   FALSE HITS — "Color Chrome Effect" is in EVERY Fuji recipe card, so a
//   substring query for "chrome" touched all 158. Boundary matching keeps that
//   honest at the recipe weight (2) instead of letting it read as a film match.
//
//   MISSES — the three black-and-white frames are "LEICA M MONOCHROM", with no
//   trailing "e", so a query for "monochrome" found nothing at all. That is why
//   the prefix test runs BOTH ways: a query may be the longer string.
//
// Prefix matching also carries plural and inflected forms: field "bridges"
// answers query "bridge", and query "bridges" answers field "bridge" via stem.
//
// It never splits the field into tokens, though, because that was the cost:
// commonPairs plus scoreFields call this once per (term, field, record), up to
// 8,256 times for a two-term query over 258 photos, and splitting on each call
// was 5-10ms of every request. Each rule is a statement about where a token
// starts, so indexOf finds the candidates and a boundary check confirms them.
// Checked against the splitting version on 2026-10-07: 3,380 terms (every
// token in the archive, its prefixes, plurals) against all 2,064 photo fields
// plus accented, astral and titlecase strings, 7,010,120 pairs, no difference.
export function fieldMatches(value, term) {
  const haystack = String(value || "").toLowerCase();
  if (!haystack || !term) return false;
  const stem = normalize(term);
  // token === term or token.startsWith(term), and the same for the stem. A
  // probe with a non-word character in it can never begin a token.
  if (isWord(term) && someTokenStartsWith(haystack, term)) return true;
  if (stem !== term && isWord(stem) && someTokenStartsWith(haystack, stem)) return true;
  // The query as the longer string ("monochrome" against "monochrom"). Length
  // -gated because short tokens are prefixes of far too much: an ungated rule
  // lets the token "neg" answer a query for "negative", and "Nostalgic Neg"
  // and "Classic Negative" are two different film simulations here. Such a
  // token starts with the term's first five characters, so those are the probe.
  if (term.length > 5) {
    const probe = term.slice(0, 5);
    for (let i = haystack.indexOf(probe); i !== -1; i = haystack.indexOf(probe, i + 1)) {
      if (!tokenStartsAt(haystack, i)) continue;
      let end = i;
      while (end < haystack.length && wordAt(haystack, end)) end += (haystack.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
      if (end - i >= 5 && term.startsWith(haystack.slice(i, end))) return true;
    }
  }
  // The exception, and the reason this is not just a token-set test: model
  // designations live INSIDE a larger alphanumeric run with no separator —
  // "27mm" in "XF27mmF2.8", "t50" in "X-T50". Gated on the term carrying a
  // digit, because that is what distinguishes a part number from a word, and
  // an ungated substring fallback would let "chrome" back into "Monochrome".
  return /\d/.test(term) && haystack.includes(term);
}

// The tokenizer's own definition of a word character (terms() splits on its
// complement), applied one code point at a time so astral letters count.
const WORD_CHAR = /[\p{L}\p{N}]/u;
const NON_WORD = /[^\p{L}\p{N}]/u;
const isWord = (text: string) => !NON_WORD.test(text);
const wordAt = (text: string, i: number) => {
  const cp = text.codePointAt(i);
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
};

// A token starts at i when no word character ends just before it.
function tokenStartsAt(text: string, i: number) {
  if (i === 0) return true;
  let j = i - 1;
  const unit = text.charCodeAt(j);
  if (unit >= 0xdc00 && unit <= 0xdfff && j > 0) {
    const high = text.charCodeAt(j - 1);
    if (high >= 0xd800 && high <= 0xdbff) j -= 1;
  }
  return !wordAt(text, j);
}

function someTokenStartsWith(text: string, prefix: string) {
  for (let i = text.indexOf(prefix); i !== -1; i = text.indexOf(prefix, i + 1)) {
    if (tokenStartsAt(text, i)) return true;
  }
  return false;
}

// The one place that knows how a (term, field) pair is keyed. NUL rather than
// a space because a field name is a fixed identifier but a TERM is user input,
// and a term containing the separator would otherwise collide with a different
// pair. Private on purpose — see commonPairs for what happened when it was not.
const pairKey = (term, field) => `${term}\u0000${field}`;

// Score one record against the query. `fields` is {name: text}; `weights` is an
// array of [name, weight] ordered however the caller likes.
//
// Each term scores ONCE, at the weight of the best field it hit, rather than
// accumulating across every field it appears in. A camera name that also
// appears in the recipe card and the stem would otherwise triple-count, so the
// photos that rank highest would be the ones with the most redundant metadata
// rather than the ones that best answer the query.
export function scoreFields(fields, weights, queryTermList, skip = null) {
  let score = 0;
  let hits = 0;
  const matched = [];
  for (const term of queryTermList) {
    let best = 0;
    let bestField = null;
    for (const [name, weight] of weights) {
      if (skip?.has(pairKey(term, name))) continue;
      if (weight > best && fieldMatches(fields[name], term)) { best = weight; bestField = name; }
    }
    if (best) {
      score += best;
      hits += 1;
      if (!matched.includes(bestField)) matched.push(bestField);
    }
  }
  return { score, hits, matched };
}

// Which (term, field) pairs carry no information, because that field matches
// the term in most of the corpus.
//
// The case that forced this: every Fuji recipe card contains "Exposure
// Compensation", so a query for "long exposure" matched "exposure" in 151 of
// 158 recipe cards. Nothing is a long exposure in this archive — the longest
// shutter is well under a second — yet the query returned the whole archive,
// ranked by a term that told you nothing.
//
// Deliberately per FIELD rather than per term. Dropping "chrome" outright
// because it appears in all 158 recipe cards would also blind the query to the
// 42 photos whose FILM is Classic Chrome, where the same word is the most
// discriminating thing about them. The word is noise in one field and signal in
// another, and only the pair can tell those apart.
//
// The threshold is 90%, not a half. A term matching half the corpus is at its
// MOST discriminating — it splits the set cleanly — so suppressing there would
// throw away the best signal there is. Only a term matching almost everything
// has stopped saying anything, and the case that forced this was 151 of 158.
//
// A hard threshold rather than a weighted idf: the score is meant to be read by
// a caller deciding whether to trust a result, and "this field matched 96% of
// the archive, so it was ignored" survives being explained. A logarithm does not.
// Returns BOTH the suppression set and the per-term verdict, because the caller
// needs the second and must not have to reconstruct it. An earlier version
// returned only the set and left photos.js to work out which terms had been
// suppressed by re-deriving the key format — which it got wrong (a space where
// this file writes a NUL), so the ranking silently reported nothing suppressed
// while suppression was working fine. The encoding is now private to this file.
export function commonPairs(records, weights, queryTermList, { threshold = 0.9, floor = 4 } = {}) {
  const skip = new Set();
  const common = [];
  // Below the floor there is no distribution to measure, and pruning on a
  // handful of records would just be noise amplified into a rule.
  if (records.length < floor) return { skip, common };
  for (const term of queryTermList) {
    let suppressed = false;
    let informative = false;
    for (const [name] of weights) {
      let df = 0;
      for (const fields of records) if (fieldMatches(fields[name], term)) df += 1;
      if (!df) continue;
      if (df / records.length >= threshold) { skip.add(pairKey(term, name)); suppressed = true; }
      else informative = true;
    }
    // Suppressed everywhere it appeared, and informative nowhere: the term is
    // in the corpus and tells you nothing about which part. A term that appears
    // NOWHERE is absent instead, and is deliberately not reported here.
    if (suppressed && !informative) common.push(term);
  }
  return { skip, common };
}
