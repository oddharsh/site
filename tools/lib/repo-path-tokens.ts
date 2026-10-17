// repo-path-tokens.ts: every repository path cited in a text, for build step 7b-paths.
//
// It returns exactly what `text.match(REPO_PATH_REGEX)` returns, in order, and
// contract-repo-path-tokens-match-the-regex.test.mjs holds the two together. The
// regex is the readable statement of the rule. This scanner exists because the
// regex starts with a lookbehind and a 17-way alternation, which gives the
// engine no literal to search for, so it runs both at every byte of every staged
// text file: 110 ms of a 3 s build on 2026-10-08. Every match contains a `/`
// straight after a directory name, so the scanner jumps between slashes with
// indexOf and only looks around the ones it lands on.
//
// Why that finds the same matches. A match starts at a directory name whose
// previous character is not in [\w./-]. Directory names are [a-z-], so the
// start can only be where the run of [\w-] characters before the slash begins:
// any later start would have a [\w-] character before it. The run's start is a
// match exactly when the run is a listed name and the character before it is
// not "." or "/". A match then extends over [A-Za-z0-9_./-]+, and since its end
// is a character outside that class, the next run starts after it, which is the
// regex's own rule that matches never overlap.

export const REPO_DIRS = [
  "www", "holding", "scripts", "src", "tools", "cal", "cf-garage", "lens-reader", "lwe-ask",
  "pipelines", "config", "serendipity", "public", "design", "docs", "migrations", "talks",
] as const;

// The rule as a regex: the oracle the scanner is tested against.
export const REPO_PATH_REGEX = new RegExp(`(?<![\\w./-])(${REPO_DIRS.join("|")})\\/[A-Za-z0-9_./-]+`, "g");

const DIRS = new Set<string>(REPO_DIRS);
const SLASH = 0x2f;
const DOT = 0x2e;

// [A-Za-z0-9_-], the characters a directory name's run is made of (\w is ASCII here)
function isRun(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d;
}
// [A-Za-z0-9_./-], what a path continues with
function isPath(c: number): boolean {
  return isRun(c) || c === DOT || c === SLASH;
}

export function repoPathTokens(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const slash = text.indexOf("/", from);
    if (slash < 0) return out;
    let start = slash;
    while (start > 0 && isRun(text.charCodeAt(start - 1))) start--;
    const before = start > 0 ? text.charCodeAt(start - 1) : -1;
    let end = slash + 1;
    if (start < slash && before !== DOT && before !== SLASH && end < text.length && isPath(text.charCodeAt(end))
      && DIRS.has(text.slice(start, slash))) {
      while (end < text.length && isPath(text.charCodeAt(end))) end++;
      out.push(text.slice(start, end));
      from = end;
    } else {
      from = slash + 1;
    }
  }
}
