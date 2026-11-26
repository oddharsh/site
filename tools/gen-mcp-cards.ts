#!/usr/bin/env node
// gen-mcp-cards.ts — project the live MCP tool registries into the
// pre-connection server cards agents discover before they can POST MCP.
//
// The protocol remains the source of truth at /mcp and /serendipity/mcp:
// server/discover and tools/list are live. These files are only the static
// discovery layer, so a card can never quietly acquire a tool that the Worker
// does not serve.

import { mkdir, writeFile } from "node:fs/promises";

import { MCP_TOOLS as SITE_TOOLS, SITE_MCP_CAPABILITIES, SITE_MCP_SERVER_INFO } from "../src/worker/mcp.ts";
import { MCP_TOOLS as SERENDIPITY_TOOLS, SERENDIPITY_MCP_CAPABILITIES, SERENDIPITY_MCP_SERVER_INFO } from "../serendipity/serendipity.ts";
import { MCP_MODERN, MCP_SUPPORTED } from "../src/worker/lib/mcp-protocol.ts";

const ROOT = "https://aadhar.sh";

function toolCard({ name, title, description, inputSchema, outputSchema, annotations }) {
  return { name, title, description, inputSchema, outputSchema, annotations };
}

// One document for two readers. The root fields are the MCP server-card
// extension's ServerCard (modelcontextprotocol/ext-server-card schema.ts, read
// 2026-11-23): $schema, a reverse-DNS name, the server's own version, a
// description of at most 100 characters, and remotes[].url, which is how a
// client matches a card to its server. serverInfo, transport, capabilities and
// tools are the earlier draft's fields, kept so a reader of that draft still
// finds them. The $schema URL answered 404 on 2026-11-23.
const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
const SERVER_CARD_DESCRIPTION_MAX = 100;

// Each card's icon is the mark its server's own page already wears, served from
// this origin (the extension asks consumers to prefer same-domain icons). SVG
// only: the site serves no PNG mark, and the extension lists SVG as SHOULD.
function card({ cardName, summary, serverInfo, capabilities, description, transport, documentationUrl, iconPath, tools }) {
  if (summary.length > SERVER_CARD_DESCRIPTION_MAX) {
    throw new Error(`${cardName}: description is ${summary.length} characters, over the extension's ${SERVER_CARD_DESCRIPTION_MAX}`);
  }
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: cardName,
    title: serverInfo.title,
    version: serverInfo.version,
    description: summary,
    icons: [{ src: `${ROOT}${iconPath}`, mimeType: "image/svg+xml", sizes: ["any"] }],
    websiteUrl: documentationUrl,
    remotes: [{ type: "streamable-http", url: transport, supportedProtocolVersions: MCP_SUPPORTED }],
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
  cardName: "sh.aadhar/site",
  summary: "Search, photos, music, coffee availability, Lens and image tools for aadhar.sh. Keyless.",
  serverInfo: SITE_MCP_SERVER_INFO,
  capabilities: SITE_MCP_CAPABILITIES,
  description:
    "Bounded public utilities for aadhar.sh: search, music, photos, coffee availability, Change Radar, Lens, ephemeral image inspection/transforms, exact published-photo recipe matching, an HTTP representation vault, and the site's published page resources.",
  transport: `${ROOT}/mcp`,
  documentationUrl: `${ROOT}/developers#mcp`,
  iconPath: "/bimi.svg",
  tools: SITE_TOOLS,
});

const serendipityCard = card({
  cardName: "sh.aadhar/serendipity",
  summary: "Community-curated events and who is going, from the Serendipity event pool. Read-only.",
  serverInfo: SERENDIPITY_MCP_SERVER_INFO,
  capabilities: SERENDIPITY_MCP_CAPABILITIES,
  description: "Read-only access to the Serendipity event pool on aadhar.sh: community-curated events worth going to, and who's going. Public data only.",
  transport: `${ROOT}/serendipity/mcp`,
  documentationUrl: `${ROOT}/serendipity/mcp-info`,
  iconPath: "/section-icons/serendipity.svg",
  tools: SERENDIPITY_TOOLS,
});

// Each server's official MCP Registry entry, the file `mcp-publisher publish`
// sends. Every field comes from the card, so a version bump moves both; the
// registry keeps the last published entry until someone republishes. remotes[]
// drops supportedProtocolVersions, which the registry's RemoteTransport has no
// field for (2025-12-11 schema, read 2026-11-26).
const REGISTRY_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

function registryEntry({ name, title, description, version, websiteUrl, icons, remotes }) {
  return {
    $schema: REGISTRY_SCHEMA,
    name,
    title,
    description,
    version,
    websiteUrl,
    repository: { url: "https://github.com/oddharsh/site", source: "github" },
    icons,
    remotes: remotes.map(({ type, url }) => ({ type, url })),
  };
}

await mkdir("public/.well-known/mcp", { recursive: true });
await mkdir("config/mcp-registry", { recursive: true });
const outputs = new Map<string, object>([
  ["public/.well-known/mcp/server-card.json", siteCard],
  ["public/.well-known/mcp/serendipity.json", serendipityCard],
  ["config/mcp-registry/site.json", registryEntry(siteCard)],
  ["config/mcp-registry/serendipity.json", registryEntry(serendipityCard)],
]);
for (const [file, value] of outputs) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
