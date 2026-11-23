// gen-tool-schemas.ts: the REST schemas the MCP data tools reuse, from the code.
//
// A data tool that runs the same function as a REST operation declares that
// operation's 200 body as its outputSchema and borrows its parameter
// descriptions (TOOL_OPERATIONS in src/worker/lib/tools.ts). Those schemas live
// in src/worker/lib/openapi.ts, which stays out of the Worker bundle, so this
// projects only the ones the tools name into src/worker/lib/tool-schemas.json.
// MCP has no components to resolve a $ref in, so each schema is inlined.
// contract-mcp-tools-share-their-rest-schemas holds the committed file equal to
// toolSchemas(). Edit the schemas in openapi.ts or public-api.ts and run this.
//
//     bun tools/gen-tool-schemas.ts

import { writeFileSync } from "node:fs";
import { SCHEMAS } from "../src/worker/lib/openapi.ts";
import { operation } from "../src/worker/lib/public-api.ts";
import type { Schema } from "../src/worker/lib/public-api.ts";
import { TOOL_OPERATIONS } from "../src/worker/lib/tools.ts";

export const TOOL_SCHEMAS_PATH = "src/worker/lib/tool-schemas.json";

// JSON.stringify visits every node top-down, so a resolved component is walked
// in turn and nested refs resolve too. A component that referred to itself
// would recurse until the stack overflows; none in lib/openapi.ts does.
function inlined(schema: Schema): Schema {
  return JSON.parse(
    JSON.stringify(schema, (_key, value) => {
      const ref = value?.$ref;
      if (ref === undefined) return value;
      const name = String(ref).replace("#/components/schemas/", "");
      if (!(name in SCHEMAS)) throw new Error(`gen-tool-schemas: unresolvable ${ref}`);
      return SCHEMAS[name];
    }),
  );
}

export function toolSchemas() {
  const outputs: Record<string, Schema> = {};
  const parameters: Record<string, Record<string, string>> = {};
  for (const { operationId, output } of TOOL_OPERATIONS) {
    const op = operation(operationId);
    parameters[operationId] = Object.fromEntries((op.parameters ?? []).map((p) => [p.name, p.description]));
    if (!output) continue;
    const body = op.responses[200]?.content?.["application/json"]?.schema;
    if (!body) throw new Error(`gen-tool-schemas: ${operationId} has no JSON 200 body for a tool to declare`);
    outputs[operationId] = inlined(body);
  }
  return { outputs, parameters };
}

if (import.meta.main) {
  writeFileSync(TOOL_SCHEMAS_PATH, `${JSON.stringify(toolSchemas(), null, 2)}\n`);
  console.log(`wrote ${TOOL_SCHEMAS_PATH}`);
}
