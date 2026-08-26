// lib/html.ts — HTML as a TYPE, so escaping is structural rather than
// remembered.
//
// THE PROBLEM. Every Worker-rendered page is a template literal, and every
// interpolation into one is a decision to escape or not that nothing checks.
// `escHtml` and `escAttr` are correct functions applied by discipline: 84 call
// sites, and the failure mode of forgetting one is an injection rather than a
// broken build. Three naive scanners have already been caught by this
// repository's own minified output (CLAUDE.md's minify-html trap, the CSP
// attribute scanner, the link-integrity quote-awareness bug), which is the same
// lesson from the reading side: HTML is not a string, and treating it as one is
// where the bugs live.
//
// THE SHAPE. `html` is a tagged template that escapes what it interpolates and
// returns an `Html`. An `Html` may be interpolated into another `html` without
// being escaped again, so fragments compose. Anything else — a plain string, a
// number, a caller's free text — is escaped on the way in. A function that
// declares `Html` therefore cannot be handed an unescaped string, and the
// checker says so at the call site.
//
// WHY A CLASS AND NOT A BRANDED STRING. A branded `string & {…}` is erased at
// runtime, so `html` could not tell a trusted fragment from a caller's text and
// would double-escape every composed fragment. The marker has to survive to
// runtime. Measured under this repo's tsconfig (`strict: false`,
// `strictNullChecks: true`): passing a `string` or a string literal where `Html`
// is declared is a TS2345, which is the whole point. `any` still slips through,
// so the enforcement is only as good as the annotations at the boundary —
// annotate the parameter, not just the local.
//
// ONE ESCAPE, NOT TWO. `escHtml` escapes `& < >` and `escAttr` also escapes `"`,
// so picking the wrong one is its own bug class. This escapes `& < > " '`
// unconditionally, which is a superset of both and correct in text and
// attribute contexts alike.
//
// That is byte-different from `escHtml` wherever text contains a quote or an
// apostrophe, and the measured blast radius of migrating lib/explorer.ts to it
// was ONE page: `/garage/hidden-flags`, whose title is "Flags the docs don't
// list", now renders that apostrophe as `&#39;` in its address bar and Details
// row. It renders identically in a browser, and these pages are not
// content-addressed, so nothing downstream keys on the bytes. Every other
// staged page came out identical, including the injection cases.
//
// `'` is in the set even though every attribute in this repository is
// double-quoted, so it buys nothing today. It is there so that the rule is
// "escaped text is safe in an attribute" rather than "safe in the kind of
// attribute we currently happen to write".
//
// WHAT IT DOES NOT DO. It is not a sanitiser and not a parser. It does not make
// `<script>${x}</script>` or `href="javascript:${x}"` safe, because escaping is
// the wrong tool for those contexts; nothing here should build either.

/** A string that is already HTML. The only way to make one without escaping is
 *  `unsafeHtml(`, which is deliberately greppable. */
export class Html {
  readonly html: string;
  constructor(value: string) {
    this.html = value;
  }
  toString(): string {
    return this.html;
  }
}

/** What may be interpolated. Arrays flatten, so `)${rows}` works on a list of
 *  fragments without a `.join("")` that would stringify each one first. */
export type Interpolable =
  | Html
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Interpolable[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for either a text node or a quoted attribute value. */
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value: Interpolable): string {
  // null and undefined render as nothing rather than "null"/"undefined". A
  // missing optional field is the common case here and printing the word is
  // never what the caller meant.
  if (value === null || value === undefined) return "";
  if (value instanceof Html) return value.html;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(String(value));
}

/** The tagged template. Interpolations are escaped unless they are `Html`. */
export function html(strings: TemplateStringsArray, ...values: Interpolable[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/** Mark markup as already-safe, WITHOUT escaping it. Two call forms, one name.
 *
 *      unsafeHtml(someString)      a computed string the caller vouches for
 *      unsafeHtml(`<p>${x}</p>`)     a literal that predates `html`
 *
 *  The TAG form exists for the migration and is the honest description of what
 *  the pre-`html` templates are: literals this repository wrote, whose
 *  interpolations are escaped BY HAND with escHtml/escAttr. Retagging one is a
 *  one-token edit that changes no bytes, which is what makes converting 20
 *  callers a reviewable diff instead of a rewrite of every page at once. It
 *  does NOT escape its interpolations — that is the point, and the reason each
 *  one still owes a real migration to `html`.
 *
 *  ONE NAME ON PURPOSE, so the ratchet in
 *  contract-html-escapes-by-construction counts one thing and cannot be routed
 *  around by adding a second door. */
/** Mark markup as already-safe, WITHOUT escaping it.
 *
 *  Every use is a claim that the string is either a literal this repository
 *  wrote or was built by `html`. It is the migration marker for the templates
 *  that predate the tagged template, whose interpolations are escaped BY HAND
 *  with escHtml/escAttr, and each one still owes a real migration to `html`.
 *
 *  IT IS A CALL, NOT A TAG, and that is measured rather than stylistic. A
 *  `tag` + "`" form would have been a one-token edit per call site, which is
 *  tempting for a 20-caller migration. It also more than DOUBLES the literal in
 *  the bundle: a tagged template must preserve `strings.raw`, so as soon as the
 *  content carries a backslash escape the bundler emits the cooked AND raw
 *  arrays. Measured through esbuild, which is what wrangler bundles with, on one
 *  120-line literal containing `\t` and `\n`:
 *
 *      plain literal            3907 B
 *      tagged                   8383 B   (+115%)
 *      wrapped in a call        3910 B   (+3 B)
 *
 *  It cost 1.42 KiB on `whoareyou.ts` alone before it was caught, on a PR whose
 *  whole claim was that it changed no bytes. Wrapping is free and says the same
 *  thing.
 *
 *  The count is the ledger: config/unsafe-html-baseline.json, checked by
 *  contract-html-escapes-by-construction, may only go down. */
export function unsafeHtml(value: string): Html {
  return new Html(value);
}

/** The empty fragment. Exists so an `Html` parameter can default to nothing
 *  without a cast at every declaration site. */
export const EMPTY: Html = new Html("");

/** Join fragments with a separator that is itself HTML (default: nothing). */
export function joinHtml(parts: readonly Html[], separator = ""): Html {
  return new Html(parts.map((part) => part.html).join(separator));
}
