// Shared by Node and Bun tools. Keep JSON.parse's validation; remove only the
// JSONC extensions, protecting quoted strings in BOTH passes.
export function parseJsonc(text: string) {
  const json = text.replace(
    /"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?(\*\/|$)|\/\/[^\r\n]*/g,
    (token, blockEnd) => {
      if (blockEnd === "") throw new SyntaxError("Unterminated JSONC block comment");
      return token.startsWith('"') ? token : " ";
    },
  );
  return JSON.parse(json.replace(
    /"(?:\\[\s\S]|[^"\\])*"|,(\s*[}\]])/g,
    (token, closing, offset) => {
      if (!closing) return token;
      let before = offset - 1;
      while (/\s/.test(json[before])) before--;
      return "[{,:".includes(json[before]) ? token : closing;
    },
  ));
}
