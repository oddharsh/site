// model-context.d.ts — the WebMCP browser API, as Chrome 152 actually implements it.
//
// NAMED for the interface rather than for webmcp.js on purpose. As webmcp.d.ts it
// sat beside webmcp.js under the browser program's "/*" path mapping, and TS
// resolves a .d.ts ahead of its .js neighbour, so every `import("/webmcp.js")`
// landed on this file and failed with "is not a module". A global declaration
// file must not share a basename with a real module.
//
// TypeScript's DOM lib carries no `ModelContext`, and the shape is not obvious
// enough to cast at each use: three of its five members behave differently from
// the way the explainer reads, and every one of those differences was measured
// against a real browser on 2026-08-25 rather than taken from a document. The
// notes below are the record of that, so the next person to touch this does not
// re-derive them one exception at a time.
//
// The origin trial runs Chrome 149 through 156, so this interface has a
// finite shelf life. Re-probe before trusting it in 157.

/** A tool as it reads back out of `getTools()`. */
interface RegisteredModelContextTool {
  name: string;
  description: string;
  /**
   * A JSON STRING here, though `registerTool` requires an OBJECT going in.
   * Round-tripping one without `JSON.parse` fails with
   * "Failed to convert value to 'object'".
   */
  inputSchema: string;
  /**
   * Chrome keeps `readOnlyHint` and silently discards `destructiveHint`,
   * `idempotentHint` and `openWorldHint`. It adds `untrustedContentHint`, which
   * is not part of the MCP annotation set. Passing all five returns two.
   */
  annotations: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  /** Separate from `annotations.title`, which does not survive registration. */
  title: string;
  /** The origin that registered it, so cross-frame provenance is readable. */
  origin: string;
  /** The registering frame. Equal to `window` for a same-document tool. */
  window: Window;
}

/** The dictionary `registerTool` accepts. `name`, `description` and `execute` are required. */
interface ModelContextToolInit {
  name: string;
  description: string;
  /** Must be an object. A JSON string is rejected. Optional. */
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  /**
   * Receives ONE argument, the parsed arguments object. Any return value is
   * serialized to a string for the caller. Throwing rejects the caller with a
   * generic "the script function threw an error", so a handler that wants to
   * explain itself returns `{ isError: true }` instead.
   */
  execute: (args: any) => unknown;
}

interface ModelContext extends EventTarget {
  /** Async, though it reads like a getter. */
  getTools(): Promise<RegisteredModelContextTool[]>;
  /**
   * Resolves or REJECTS ASYNCHRONOUSLY, so a synchronous try/catch around it
   * reports success on a registration that never happened. Duplicate names are
   * rejected. There is no `unregisterTool`, and a `signal` member is accepted
   * and ignored, so the catalog is append-only for the document's lifetime.
   */
  registerTool(tool: ModelContextToolInit): Promise<void>;
  /**
   * Takes the TOOL OBJECT from `getTools()` and its arguments as a JSON STRING,
   * and always resolves to a string. A name string is rejected with "not of type
   * 'RegisteredTool'"; an arguments object with "Failed to parse input arguments".
   */
  executeTool(tool: RegisteredModelContextTool, args: string): Promise<string>;
  /** Fires as a plain `Event` with no tool name, despite the `WebMCPEvent` global. */
  ontoolchange: ((this: ModelContext, event: Event) => any) | null;
}

interface Document {
  /**
   * Present in Chrome 152 with no flag and no origin-trial token.
   * `navigator.modelContext` was REMOVED, so this is the only door.
   */
  modelContext?: ModelContext;
}
