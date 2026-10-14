// lib/mcp-tools.ts — the shared public metadata for MCP tool descriptors.

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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorldHint ?? OPEN_WORLD_TOOLS.has(tool.name),
      ...tool.annotations,
    },
  };
}
