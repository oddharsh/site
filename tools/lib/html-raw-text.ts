// One answer to "where does a <script> or <style> end", for every tool here that
// has to find that out without a parser.
//
// HTML lets an end tag carry whitespace and junk before the bracket, so
// `</script >`, `</script\t\n bar>` and `</script/>` all close the element while
// `</scriptfoo>` does not. A `<\/script>` pattern gets one of those four right,
// and the three it misses leave a script body to be read as prose.
//
// CodeQL's js/bad-tag-filter has now flagged a different shape of that miss in
// three separate runs across three separate files, which is both the usual
// argument against parsing HTML with a regular expression and the reason this
// answer lives in one module instead of being re-derived at each call site. The
// security reading of that query does not apply to any caller here, since none
// of them sanitize for render; what makes the shapes worth getting right is that
// each caller feeds something a reader sees -- the /search corpus, the numbers
// /garage/useragent publishes, and the quiz payload the page contract checks.

// The end tag for `tag`, in every shape the tokenizer accepts, as regex SOURCE
// so a caller can compose it into a larger pattern. The lookahead is what keeps
// `</scriptfoo>` from reading as a close: an end tag name has to end at the
// bracket, at whitespace, or at a solidus.
export const closeTagSource = (tag: string) => `</${tag}(?=[\\s/>])[^>]*>`;

// Raw text elements are removed BY SCAN rather than by one regex, because a
// lazy `[\s\S]*?` between an open and a close still has to know every shape of
// close, and composing that into one pattern per element was the third attempt.
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
