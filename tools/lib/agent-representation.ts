// agent-representation.ts: what an `agents: true` surface owes a machine.
//
// site-manifest.json's `flags.agents` puts a surface in the MCP resources/list
// catalog, which is the registry telling agents "read this". So every such
// surface has to answer an agent in something other than the HTML it serves a
// browser. Two shapes satisfy that:
//
//   - the default: a Markdown twin at <path>.md, negotiated at the page URL on
//     `Accept: text/markdown`. build.ts writes it (generated from the page, or
//     from a hand twin in src/content/md/) and fails when an agents surface
//     with no declared representation gets none.
//   - a DECLARED one: `mimeType` on the surface, for a route that renders its
//     own machine form live. /rn declares text/markdown (rendered from the
//     playlist payload at /rn.md), and the terminal tools declare text/plain,
//     since their 80-column frame is the representation they answer anything
//     but a browser with.
//
// One rule, read by three checks that each see a different tree: build.ts
// (does the build hold the twin), the route oracle (does a local Worker
// negotiate it), and check-infra's agent-markdown tier (does production). It
// imports nothing, so the node-run oracle can load it.

export type AgentSurface = { path: string; kind?: string; mimeType?: string; flags?: { agents?: boolean } };

/** The content-type an agent asking `Accept: text/markdown` must get back. */
export function agentRepresentation(surface: AgentSurface): string {
  return surface.mimeType && surface.mimeType !== "text/html" ? surface.mimeType : "text/markdown";
}

/** True where build.ts, rather than a live route, owes the representation. */
export function needsBuiltTwin(surface: AgentSurface): boolean {
  return !surface.mimeType || surface.mimeType === "text/html";
}

export function agentSurfaces<T extends AgentSurface>(surfaces: T[]): T[] {
  return surfaces.filter((s) => s.flags?.agents === true);
}
