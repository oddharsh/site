// lib/llms-full.ts: the one assembler for /llms-full.txt.
//
// The build writes the whole file into the staged tree (step 1g3), where every
// input already exists as bytes: the llms.txt map, each writing post's .txt, and
// the Markdown twin of every Garage and LWE page. The Worker only reads it back,
// one ASSETS lookup where it used to make 2 + one per post. That matters on
// Workers Free, whose 50-subrequest ceiling (gotcha 36) a per-page fan-out over
// 39 explainers would have spent most of.
//
// Under `bun run dev` the farm derives nothing, so there is no built file and
// x402.ts assembles the writing half live through this same function. Two
// callers, one format, so the dev copy cannot drift from the shipped one.
//
// Each document is wrapped in a <doc> element because the bodies carry their own
// `#` and `##` headings, and plain concatenation leaves no reliable boundary
// between one page and the next. A twin keeps its YAML front matter inside the
// element, so title, path, section and updated date survive the inlining.
//
// Pure and node-safe: build.ts imports it from source (gotcha 16).

export type LlmsFullDoc = { title: string; path: string; date?: string; body: string };
export type LlmsFullSection = { heading: string; docs: LlmsFullDoc[] };

// Shared by both callers so the dev fallback names the section the way the build does.
export const WRITING_HEADING = "Writing: full text";

const attr =(s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function renderLlmsFull(map: string, sections: LlmsFullSection[]): string {
  const parts = [map.trim()];
  for (const { heading, docs } of sections) {
    if (!docs.length) continue;
    parts.push(`# ${heading}`);
    for (const d of docs) {
      const date = d.date ? ` date="${attr(d.date)}"` : "";
      parts.push(`<doc title="${attr(d.title)}" path="${attr(d.path)}"${date}>\n${d.body.trim()}\n</doc>`);
    }
  }
  return parts.join("\n\n") + "\n";
}
