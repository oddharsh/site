// Node-only entry point: Bun does not export node:module's type stripper.
// Input and output are batches of [filename, source] pairs on stdin/stdout.
import { stripTypeScriptTypes } from "node:module";

function erase(file: string, source: string): string {
  if (!file.endsWith(".ts")) return source;
  const original = source.split("\n");
  return (
    stripTypeScriptTypes(source, { mode: "strip" })
      .split("\n")
      // An erased type declaration leaves a whitespace-only line. Remove only
      // those lines' padding; authored blank lines inside template literals keep
      // their bytes. This also keeps generated HTML free of trailing whitespace.
      .map((line, i) => (/^[\t ]+$/.test(line) && original[i]?.trim() ? "" : line))
      .join("\n")
  );
}

// Decode across pipe chunks so a split UTF-8 sequence cannot alter source bytes.
process.stdin.setEncoding("utf8");
let input = "";
for await (const part of process.stdin) input += part;
const sources: [string, string][] = JSON.parse(input);
process.stdout.write(
  JSON.stringify(
    sources.map(([file, source]) => {
      try {
        return [file, erase(file, source)];
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
      }
    }),
  ),
);
