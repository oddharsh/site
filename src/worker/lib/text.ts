export const compareCodepoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const groupThousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function terms(query, max = 12) {
  return String(query || "").toLowerCase().trim().slice(0, 160)
    .split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1).slice(0, max);
}

export const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "to", "for",
  "from", "by", "is", "are", "was", "were", "be", "it", "its", "that", "this",
  "these", "those", "as", "into", "over", "some", "any", "all", "me", "my",
  "you", "your", "i", "we", "us",
  "what", "which", "who", "how", "why", "when", "where", "does", "do", "did",
  "has", "have", "had", "he", "him", "his", "she", "her", "they", "them",
  "their", "about",
  "photo", "photos", "photograph", "photographs", "picture", "pictures",
  "image", "images", "shot", "shots", "pic", "pics", "show", "showing",
  "find", "search", "look", "looking", "get", "give", "want",
]);

export function normalize(term) {
  const value = String(term || "").toLowerCase();
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

export function queryTerms(query, max = 12) {
  const all = terms(query, max);
  const kept = all.filter((term) => !STOPWORDS.has(term));
  return { terms: kept, dropped: all.filter((term) => STOPWORDS.has(term)) };
}

export function fieldMatches(value, term) {
  const haystack = String(value || "").toLowerCase();
  if (!haystack || !term) return false;
  const stem = normalize(term);
  if (isWord(term) && someTokenStartsWith(haystack, term)) return true;
  if (stem !== term && isWord(stem) && someTokenStartsWith(haystack, stem)) return true;
  if (term.length > 5) {
    const probe = term.slice(0, 5);
    for (let i = haystack.indexOf(probe); i !== -1; i = haystack.indexOf(probe, i + 1)) {
      if (!tokenStartsAt(haystack, i)) continue;
      let end = i;
      while (end < haystack.length && wordAt(haystack, end)) end += (haystack.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
      if (end - i >= 5 && term.startsWith(haystack.slice(i, end))) return true;
    }
  }
  return /\d/.test(term) && haystack.includes(term);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const NON_WORD = /[^\p{L}\p{N}]/u;
const isWord = (text: string) => !NON_WORD.test(text);
const wordAt = (text: string, i: number) => {
  const cp = text.codePointAt(i);
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
};

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

const pairKey = (term, field) => `${term}\u0000${field}`;

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

export function commonPairs(records, weights, queryTermList, { threshold = 0.9, floor = 4 } = {}) {
  const skip = new Set();
  const common = [];
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
    if (suppressed && !informative) common.push(term);
  }
  return { skip, common };
}
