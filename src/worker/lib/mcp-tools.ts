// lib/mcp-tools.ts — the shared public metadata for MCP tool descriptors.
//
// Tool annotations help a client choose and explain a tool, but they are hints
// that authorize nothing. The handlers enforce their own boundaries regardless.
// Keeping the decoration here means /ask, /mcp, /serendipity/mcp, the
// browser-side WebMCP bridge, and the published server cards see one shape.
//
// The DEFAULT is the shape most of this site's tools actually have: read a
// public thing on this origin, return it, change nothing. A tool that is not
// that says so on its own definition, next to the code that makes it untrue —
// see `representation_capture` in mcp.ts, which writes a row. Defaults that
// have to be true for every tool are the ones that quietly become lies when
// somebody adds the next tool on another branch.

const OPEN_WORLD_TOOLS = new Set([
  "now_playing",
  "lens_inspect",
  "lens_page",
  "lens_compare",
  "encode",
  "agent_ready",
  "dict",
  "cache",
  "lens",
  "image_inspect",
  "image_transform",
  "image_compare",
  "photo_recipe",
  "representation_capture",
  "representation_compare",
]);

// Tools whose OUTPUT carries text a third party chose: a scanned site's headers,
// URL or body, Spotify track names, Luma event titles and attendee names, the
// crawled VC neighborhood, an image's own metadata. `untrustedContentHint` is a
// WebMCP annotation rather than an MCP one; Chrome 156 and Canary 159 carry it
// through registerTool (measured 2026-11-03) and an MCP client ignores it.
//
// It is not openWorldHint under another name. photo_recipe and image_compare
// fetch, but return only this origin's recipe or byte counts. change_radar,
// representation_read, finger and the Serendipity pool never fetch, but replay
// stored third-party text.
const UNTRUSTED_CONTENT_TOOLS = new Set([
  "now_playing",
  "change_radar",
  "lens_inspect",
  "lens_page",
  "lens_compare",
  "find_events",
  "image_inspect",
  "image_transform",
  "representation_capture",
  "representation_read",
  "representation_compare",
  "finger",
  "encode",
  "agent_ready",
  "dict",
  "cache",
  "lens",
  // /serendipity/mcp: every tool but `stats` returns event or people names.
  "list_events",
  "get_event",
  "search_people",
  "list_contributors",
  "contributor_events",
  "frequent_people",
  "co_attendees",
  "connections",
  "shared_events",
]);

const genericObjectOutput = () => ({ type: "object", additionalProperties: true });

function titleFor(name) {
  return String(name || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
export function mcpTool(tool, { title, openWorldHint }: { title?: string; openWorldHint?: boolean } = {}) {
  return {
    ...tool,
    title: tool.title || title || titleFor(tool.name),
    outputSchema: tool.outputSchema || genericObjectOutput(),
    // The definition's own annotations win. That makes this decorator
    // idempotent, which matters because DATA_TOOLS is decorated once in
    // lib/tools.ts and again when mcp.ts composes it into MCP_TOOLS.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorldHint ?? OPEN_WORLD_TOOLS.has(tool.name),
      untrustedContentHint: UNTRUSTED_CONTENT_TOOLS.has(tool.name),
      ...tool.annotations,
    },
  };
}
