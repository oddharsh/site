// `hidden="until-found"` survives the HTML minifier, which would otherwise
// serve it as plain `hidden`.
//
// @minify-html/node 0.18.1 keeps a table of boolean attributes and, for any
// attribute in it, drops the value whatever it is (minify-html's
// src/minify/attr.rs: `if is_boolean || value_raw.is_empty()` returns
// NoValue). `hidden` is in that table, but since 2022 it is an enumerated
// attribute with a second state: `until-found` collapses the element while
// leaving it reachable by find-in-page and fragment navigation, and fires
// `beforematch` when it is revealed. Plain `hidden` is unreachable. So the
// /garage/horizon demo shipped a target the browser could never find, from
// the day the demo landed until 2026-10-07. None of the 15 options changes
// this, and no minify-html issue or PR named it (searched 2026-10-07).
//
// The repair is the sentinel swap minify-html#219 describes. Before the
// minifier, each start tag's `hidden="until-found"` becomes a valueless
// attribute whose name the minifier has no rule for; after it, that name
// becomes `hidden=until-found`. The minifier reorders attributes, so the swap
// cannot be done by position; the sentinel carries the element identity
// through instead.
//
// Both halves fail loudly rather than quietly: the source may not already
// contain the sentinel, and the restore must put back exactly as many as the
// protect took out. A minifier that dropped or duplicated one would otherwise
// ship a document whose until-found count no longer matches its source.
//
// The day minify-html keeps the value on its own, contract test
// contract-hidden-until-found-survives-minify says so, and this module and its
// two call sites in tools/build.ts can go.

// Reads as what it stands for, and carries a double hyphen no authored
// attribute here uses, which the guard below enforces. The
// plain `hidden-until-found` is NOT safe: /garage/horizon already uses it as
// a capability key in prose, script and a data-cap value.
export const UNTIL_FOUND_SENTINEL = "hidden--until-found";
const SERVED = "hidden=until-found";

// One attribute at a time, quoted values consumed whole, so a `title` that
// merely mentions hidden=until-found is a value and never a match. Names
// follow the tokenizer: anything up to whitespace, a quote, `/`, `=` or `>`.
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

const isUntilFound = (name: string, value: string | undefined) =>
  name.toLowerCase() === "hidden" &&
  value !== undefined &&
  value.replace(/^(["'])([\s\S]*)\1$/, "$2").toLowerCase() === "until-found";

/** Rewrite one START tag (`<p ...>`), replacing `hidden="until-found"` with the sentinel. Anything else returns unchanged. */
export const protectUntilFoundTag = (tag: string): string => {
  const head = /^<[A-Za-z][^\s/>]*/.exec(tag);
  if (!head) return tag;
  const rest = tag.slice(head[0].length);
  return head[0] + rest.replace(ATTR, (all, name: string, value: string | undefined) =>
    isUntilFound(name, value) ? UNTIL_FOUND_SENTINEL : all);
};

const count = (s: string) => s.split(UNTIL_FOUND_SENTINEL).length - 1;

/**
 * Run `minify` over `protectedHtml` (the output of a pass that applied
 * protectUntilFoundTag to every start tag of `source`) and put the values back.
 */
export const minifyKeepingUntilFound = (
  source: string,
  protectedHtml: string,
  minify: (html: string) => string,
  label: string,
): string => {
  if (count(source) !== 0) {
    throw new Error(`${label}: source already contains "${UNTIL_FOUND_SENTINEL}", which tools/lib/hidden-until-found.ts reserves`);
  }
  const taken = count(protectedHtml);
  const min = minify(protectedHtml);
  const kept = count(min);
  if (kept !== taken) {
    throw new Error(`${label}: protected ${taken} hidden="until-found" but the minifier returned ${kept}`);
  }
  return taken === 0 ? min : min.split(UNTIL_FOUND_SENTINEL).join(SERVED);
};
