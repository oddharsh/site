// lib/text.ts — the one tokenizer, and the scoring primitives built on it.
//
// Extracted from search.ts when queryPhotos needed the same treatment. The site
// search had tokenized and field-weighted since it was written; the photo query
// never did, and matched `q` as ONE contiguous substring against a haystack of
// five joined fields. So "classic chrome bridge" could not match a Classic
// Chrome photo of a bridge: the words were all there, just not ADJACENT in the
// order the join happened to produce.

// No ICU on a request path. Measured in node on 2026-10-07, a cold
// /ledger/lines.html took 10.8ms against 2.0ms once ICU was warm, and that
// reading overstated production: ICU loads its data once per PROCESS, and a
// workerd process is shared by many isolates, so a fresh isolate there pays
// about 0.03ms for its first collator and 0.07ms for its first number
// formatter, not the 6.5 and 8.5 a cold process does (tools/lib/warm-icu.ts,
// 2026-10-09). These two are kept because they're still cheaper than building
// the ICU objects and print the same thing. They cover what the request paths
// used ICU for, photos.ts derivePhotoPool included.
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
  return String(query || "")
    .toLowerCase()
    .trim()
    .slice(0, 160)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1)
    .slice(0, max);
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
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "with",
  "and",
  "or",
  "to",
  "for",
  "from",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "it",
  "its",
  "that",
  "this",
  "these",
  "those",
  "as",
  "into",
  "over",
  "some",
  "any",
  "all",
  "me",
  "my",
  "you",
  "your",
  "i",
  "we",
  "us",
  // How an agent phrases a question. searchSiteRanked's own comment used "what
  // does he think about agents" as the example of a query stopwords rescue, and
  // not one of its filler words was in this set until 2026-09-23, so it searched
  // all six. Matching is SUBSTRING, so "he" hits nearly every page ("the",
  // "when") and every term is one more scan of the whole corpus: 1.33ms for that
  // query on a laptop against 30us for "zstd", measured by instruction count.
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "does",
  "do",
  "did",
  "has",
  "have",
  "had",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "about",
  // the photo-domain half
  "photo",
  "photos",
  "photograph",
  "photographs",
  "picture",
  "pictures",
  "image",
  "images",
  "shot",
  "shots",
  "pic",
  "pics",
  "show",
  "showing",
  "find",
  "search",
  "look",
  "looking",
  "get",
  "give",
  "want",
]);

// A deliberately shallow stem: strip a trailing plural "s" and nothing else.
// Real stemming (Porter, Snowball) would fold "lighting" into "light" and
// "buildings" into "build", which is right for a large corpus and wrong for a
// few hundred captions where precision beats recall — an over-eager stem here silently
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
// directions. Measured when the archive held 158 records:
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
// It never splits the field into tokens, though, because that was the cost when
// queryPhotos called this once per (term, field, record), up to 8,256 times
// for a two-term query over 258 photos, and splitting on each call was 5-10ms
// of every request. Each rule is a statement about where a token
// starts, so indexOf finds the candidates and a boundary check confirms them.
// Checked against the splitting version on 2026-10-07: 3,380 terms (every
// token in the archive, its prefixes, plurals) against all 2,064 photo fields
// plus accented, astral and titlecase strings, 7,010,120 pairs, no difference.
//
// Since 2026-11-03 the photo query answers these rules from a build-time index
// (lib/photo-search.ts) and this function is its specification: a contract test
// holds every bit of that index to it.
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
export const isWord = (text: string) => !NON_WORD.test(text);
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
