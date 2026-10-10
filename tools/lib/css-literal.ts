// The /*min*/ pass's round trip: JS template literal in, minified CSS out, JS
// template literal back in. build.ts step 5 runs it over every Worker module,
// and contract-min-css-literals-survive-the-splice.test.mjs proves it on the
// cases that broke it.
//
// A template literal is JS source, so its text and its runtime value differ
// wherever a backslash sits. The pass got that wrong at BOTH ends until
// 2026-10-09, and each end lost a different thing:
//
//   in   it handed Lightning CSS the raw source text. terminal.ts opens its
//        literal with `\n`, a JS newline, which CSS reads as an escaped "n",
//        so the Worker shipped `n.tool-out{...}`: a selector for an element
//        named <n> that no page has, and an unstyled /terminal tool pane.
//   out  it spliced Lightning's output back unescaped. Lightning writes
//        form[action="/run"] as form[action=\/run] (valid CSS), the template
//        literal cooks `\/` to "/", and the runtime string form[action=/run]
//        is not CSS at all. A backtick or "${" in the output would end the
//        literal or open an interpolation.
//
// So the pass now minifies the literal's VALUE and escapes the result back into
// source, and the build asserts the round trip on every literal it touches.

// The sentinel has to open the literal. The body skips escaped characters, so
// a \` inside the CSS no longer ends the match early.
export const MIN_LITERAL = /`(\/\*min\*\/(?:[^`\\]|\\[\s\S])*)`/g;

// The runtime value of a template literal's raw text: ECMA-262's TV, which is
// the escape table below plus CR and CRLF normalised to LF. Written out rather
// than handed to `new Function` (lint refuses implied eval in .ts), and the
// contract test checks it against the engine's own cooking, so the two cannot
// drift quietly. Escapes a template literal cannot hold (\1 to \9, \0 before a
// digit, a malformed \x or \u) throw, since the module would not parse either.
const TEMPLATE_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(0)(?![0-9])|(\r\n|[\s\S]))|\r\n?/g;
const SINGLE_ESCAPES = new Map([["b", "\b"], ["t", "\t"], ["n", "\n"], ["v", "\v"], ["f", "\f"], ["r", "\r"]]);
export const cookTemplate = (raw: string): string =>
  raw.replace(TEMPLATE_ESCAPE, (whole, hex, braced, unit, zero, char) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (braced) return String.fromCodePoint(parseInt(braced, 16));
    if (unit) return String.fromCharCode(parseInt(unit, 16));
    if (zero) return "\0";
    if (char === undefined) return "\n"; // a bare CR or CRLF in the source
    if (/^(?:\r\n|[\r\n\u2028\u2029])$/.test(char)) return ""; // line continuation
    if (/^[0-9xu]$/.test(char)) throw new Error(`a template literal cannot hold the escape ${whole}`);
    return SINGLE_ESCAPES.get(char) ?? char;
  });

// The inverse: source text that cooks back to `value`, byte for byte.
// Backslash first, or the escapes added after it would be doubled. A bare CR
// is escaped too, because a template literal reads one in source as LF.
export const toTemplateRaw = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\r/g, "\\r");

export type MinLiteral = { index: number; source: string; cooked: string; min: string; spliced: string };

// Replace every /*min*/ literal in `src` with its minified form. `minify` takes
// CSS text and returns CSS text; build.ts passes Lightning CSS. Throws on an
// interpolated literal (its value is not knowable at build time) and on any
// literal whose spliced form would not evaluate to exactly what `minify` said.
export const spliceMinLiterals = (rel: string, src: string, minify: (css: string) => string) => {
  const literals: MinLiteral[] = [];
  let out = "", last = 0;
  for (const m of src.matchAll(MIN_LITERAL)) {
    const raw = m[1];
    if (raw.includes("${")) throw new Error(`${rel}: a /*min*/ CSS literal carries interpolation`);
    const cooked = cookTemplate(raw);
    const min = minify(cooked).replace(/\n+$/, "");
    const spliced = "`" + toTemplateRaw(min) + "`";
    if (cookTemplate(spliced.slice(1, -1)) !== min) {
      throw new Error(`${rel}: a minified /*min*/ literal does not survive the splice back into JS`);
    }
    literals.push({ index: m.index, source: m[0], cooked, min, spliced });
    out += src.slice(last, m.index) + spliced;
    last = m.index + m[0].length;
  }
  return { out: out + src.slice(last), literals };
};
