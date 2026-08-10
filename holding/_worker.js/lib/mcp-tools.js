// lib/mcp-tools.js — the shared public metadata for MCP tool descriptors.
//
// Tool annotations help a client choose and explain a tool, but they are hints,
// not authorization. The handlers enforce their own boundaries regardless.
// Keeping the decoration here means /ask, /mcp, /serendipity/mcp, the
// browser-side WebMCP bridge, and the published server cards see one shape.
//
// The DEFAULT is the shape most of this site's tools actually have: read a
// public thing on this origin, return it, change nothing. A tool that is not
// that says so on its own definition, next to the code that makes it untrue —
// see `representation_capture` in mcp.js, which writes a row. Defaults that
// have to be true for every tool are the ones that quietly become lies when
// somebody adds the eighth tool on another branch.

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
  // hosted tools that will fetch a caller-supplied URL
  "image_inspect",
  "image_transform",
  "image_compare",
  "photo_recipe",
  "representation_capture",
  "representation_compare",
]);

const genericObjectOutput = () => ({ type: "object", additionalProperties: true });

function titleFor(name) {
  return String(name || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * @param {any} tool
 * @param {{title?: string, openWorldHint?: boolean}} [overrides]
 */
export function mcpTool(tool, { title, openWorldHint } = {}) {
  return {
    ...tool,
    title: tool.title || title || titleFor(tool.name),
    outputSchema: tool.outputSchema || genericObjectOutput(),
    // The definition's own annotations win. That makes this decorator
    // idempotent, which matters because DATA_TOOLS is decorated once in
    // lib/tools.js and then composed into two servers that decorate again.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorldHint ?? OPEN_WORLD_TOOLS.has(tool.name),
      ...tool.annotations,
    },
  };
}
