// One answer to "where does a <script> or <style> end", for every tool here that
// has to find that out without a parser.
//
// HTML lets an end tag carry whitespace and junk before the bracket, so
// `</script >`, `</script\t\n bar>` and `</script/>` all close the element while
// `</scriptfoo>` does not. A `<\/script>` pattern gets one of those four right,
// and the three it misses leave a script body to be read as prose.

// The end tag for `tag`, in every shape the tokenizer accepts, as regex SOURCE
// so a caller can compose it into a larger pattern. The lookahead is what keeps
// `</scriptfoo>` from reading as a close: an end tag name has to end at the
// bracket, at whitespace, or at a solidus.
export const closeTagSource = (tag: string) => `</${tag}(?=[\\s/>])[^>]*>`;

export const stripRawText = (s: string, tag: string): string => {
  const open = new RegExp("<" + tag + "(?=[\\s/>])", "i");
  const close = new RegExp("</" + tag + "(?=[\\s/>])", "i");
  const kept: string[] = [];
  let rest = s;
  for (;;) {
    const i = rest.search(open);
    if (i < 0) { kept.push(rest); break; }
    kept.push(rest.slice(0, i));
    const after = rest.slice(i);
    const c = after.search(close);
    // An unterminated raw-text element runs to end of document by the parser's
    // own rule, so dropping the remainder is the correct reading rather than a
    // giving-up branch.
    if (c < 0) break;
    const gt = after.indexOf(">", c);
    if (gt < 0) break;
    rest = after.slice(gt + 1);
  }
  return kept.join(" ");
};
