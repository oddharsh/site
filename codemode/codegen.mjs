// codegen.mjs — Cloudflare "code mode" step 1, applied to the Serendipity MCP.
//
//   node codemode/codegen.mjs
//
// Fetches the live MCP's tools/list and emits a typed TypeScript-flavored client
// (serendipity-api.mjs + .d.ts): one documented function per tool. That is the
// half of code mode that needs no special runtime. The other half (running
// LLM-written code against this API inside an isolated Worker Loader sandbox) is
// closed beta in production; codemode/run.mjs demonstrates the same pattern in a
// plain Node sandbox against the live, read-only, public endpoint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://aadhar.sh/serendipity/mcp";

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const txt = await res.text();
const env = txt.startsWith("data:") ? JSON.parse(txt.replace(/^data:\s*/, "")) : JSON.parse(txt);
const tools = env.result.tools;

const clean = (s) => String(s || "").replace(/\*\//g, "* /");
const jsType = (s) => s.enum ? s.enum.map((v) => JSON.stringify(v)).join(" | ")
  : ({ integer: "number", number: "number", string: "string", boolean: "boolean", array: "any[]", object: "Record<string, any>" }[s.type] || "any");

function paramsType(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  const keys = Object.keys(props);
  if (!keys.length) return null;
  return "{ " + keys.map((k) => `${k}${req.has(k) ? "" : "?"}: ${jsType(props[k])}`).join("; ") + " }";
}

// ── serendipity-api.mjs (runnable ESM client) ─────────────────────────────────
let mjs = `// AUTO-GENERATED from ${ENDPOINT} (tools/list). Regenerate: node codemode/codegen.mjs
// A code-mode client: each MCP tool is a normal async function. Write code against
// these and intermediate results stay local instead of round-tripping an LLM.
const ENDPOINT = ${JSON.stringify(ENDPOINT)};
let _id = 0;
async function call(name, args) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method: "tools/call", params: { name, arguments: args || {} } }),
  });
  const t = await r.text();
  const env = t.startsWith("data:") ? JSON.parse(t.replace(/^data:\\s*/, "")) : JSON.parse(t);
  if (env.error) throw new Error("MCP " + name + ": " + (env.error.message || JSON.stringify(env.error)));
  const parts = (env.result && env.result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\\n");
  try { return JSON.parse(parts); } catch { return parts; }
}

`;
// ── serendipity-api.d.ts (types for the sandbox/LLM to read) ──────────────────
let dts = `// AUTO-GENERATED from ${ENDPOINT} (tools/list). Regenerate: node codemode/codegen.mjs\n\n`;

for (const t of tools) {
  const pt = paramsType(t.inputSchema);
  const doc = clean(t.description).replace(/\s+/g, " ").trim();
  mjs += `/** ${doc} */\nexport function ${t.name}(${pt ? "args" : ""}) { return call(${JSON.stringify(t.name)}${pt ? ", args" : ""}); }\n\n`;
  dts += `/** ${doc} */\nexport function ${t.name}(${pt ? `args?: ${pt}` : ""}): Promise<any>;\n\n`;
}

fs.mkdirSync(HERE, { recursive: true });
fs.writeFileSync(path.join(HERE, "serendipity-api.mjs"), mjs);
fs.writeFileSync(path.join(HERE, "serendipity-api.d.ts"), dts);
console.log(`generated ${tools.length} tool functions -> codemode/serendipity-api.{mjs,d.ts}`);
console.log("  " + tools.map((t) => t.name).join(", "));
