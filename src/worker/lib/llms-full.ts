// The build writes the whole file into the staged tree (step 1g3), where every
// input already exists as bytes: the llms.txt map, each writing post's .txt, and
// the Markdown twin of every Garage and LWE page. The Worker only reads it back,
// one ASSETS lookup where it used to make 2 + one per post. That matters on
// Workers Free, whose 50-subrequest ceiling (gotcha 36) a per-page fan-out over
// 39 explainers would have spent most of.
//
// Pure and node-safe: build.ts imports it from source (gotcha 16).

export type LlmsFullDoc = { title: string; path: string; date?: string; body: string };
export type LlmsFullSection = { heading: string; docs: LlmsFullDoc[] };

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
