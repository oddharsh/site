// repo-path-tokens.ts: every repository path cited in a text, for build step 7b-paths.

export const REPO_DIRS = [
  "www", "holding", "scripts", "src", "tools", "cal", "cf-garage", "lens-reader", "lwe-ask",
  "pipelines", "config", "serendipity", "public", "design", "docs", "migrations", "talks",
] as const;

export const REPO_PATH_REGEX = new RegExp(`(?<![\\w./-])(${REPO_DIRS.join("|")})\\/[A-Za-z0-9_./-]+`, "g");

const DIRS = new Set<string>(REPO_DIRS);
const SLASH = 0x2f;
const DOT = 0x2e;

function isRun(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d;
}
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
