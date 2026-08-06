// lib/mcp-tools.js — the shared public metadata for MCP tool descriptors.
//
// Tool annotations help a client choose and explain a tool, but they are hints,
// not authorization. The handlers remain read-only and enforce their own
// boundaries. Keeping the metadata decoration here means /ask, /mcp, the
// browser-side WebMCP bridge, and the published server cards see one shape.

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
]);

const genericObjectOutput = () => ({ type: "object", additionalProperties: true });

function titleFor(name) {
  return String(name || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function mcpTool(tool, { title, openWorldHint } = {}) {
  return {
    ...tool,
    title: title || titleFor(tool.name),
    outputSchema: tool.outputSchema || genericObjectOutput(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorldHint ?? OPEN_WORLD_TOOLS.has(tool.name),
    },
  };
}
