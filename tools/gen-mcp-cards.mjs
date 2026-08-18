#!/usr/bin/env node
// gen-mcp-cards.mjs — project the live MCP tool registries into the
// pre-connection server cards agents discover before they can POST MCP.
//
// The protocol remains the source of truth at /mcp and /serendipity/mcp:
// server/discover and tools/list are live. These files are only the static
// discovery layer, so a card can never quietly acquire a tool that the Worker
// does not serve.

import { mkdir, writeFile } from "node:fs/promises";

import {
  MCP_TOOLS as SITE_TOOLS,
  SITE_MCP_CAPABILITIES,
  SITE_MCP_SERVER_INFO,
} from "../src/worker/mcp.js";
import {
  MCP_TOOLS as SERENDIPITY_TOOLS,
  SERENDIPITY_MCP_CAPABILITIES,
  SERENDIPITY_MCP_SERVER_INFO,
} from "../serendipity/serendipity.js";
import { MCP_MODERN } from "../src/worker/lib/mcp-protocol.js";

const ROOT = "https://aadhar.sh";

function toolCard({ name, title, description, inputSchema, outputSchema, annotations }) {
  return { name, title, description, inputSchema, outputSchema, annotations };
}

function card({ serverInfo, capabilities, description, transport, documentationUrl, tools }) {
  return {
    version: "1.0",
    protocolVersion: MCP_MODERN,
    serverInfo: { ...serverInfo, description },
    transport: { type: "streamable-http", url: transport },
    capabilities: {
      tools: Boolean(capabilities.tools),
      resources: Boolean(capabilities.resources),
      prompts: Boolean(capabilities.prompts),
    },
    authentication: { required: false },
    documentationUrl,
    tools: tools.map(toolCard),
  };
}

const siteCard = card({
  serverInfo: SITE_MCP_SERVER_INFO,
  capabilities: SITE_MCP_CAPABILITIES,
  description: "Bounded public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, Lens, ephemeral image inspection/transforms, exact published-photo recipe matching, an HTTP representation vault, and the site's published page resources.",
  transport: `${ROOT}/mcp`,
  documentationUrl: `${ROOT}/llms.txt`,
  tools: SITE_TOOLS,
});

const serendipityCard = card({
  serverInfo: SERENDIPITY_MCP_SERVER_INFO,
  capabilities: SERENDIPITY_MCP_CAPABILITIES,
  description: "Read-only access to the Serendipity event pool on aadhar.sh: community-curated events worth going to, and who's going. Public data only.",
  transport: `${ROOT}/serendipity/mcp`,
  documentationUrl: `${ROOT}/serendipity/mcp-info`,
  tools: SERENDIPITY_TOOLS,
});

await mkdir("www/.well-known/mcp", { recursive: true });
const outputs = new Map([
  ["www/.well-known/mcp/server-card.json", siteCard],
  ["www/.well-known/mcp.json", serendipityCard],
  ["www/.well-known/mcp/serendipity.json", serendipityCard],
]);
for (const [file, value] of outputs) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
