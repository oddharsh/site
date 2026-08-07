#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const ROOT = "https://aadhar.sh";
const contracts = JSON.parse(await readFile(new URL("../src/contracts/mcp.json", import.meta.url), "utf8"));
const outputRoot = new URL("../public/.well-known/", import.meta.url);

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function card(server) {
  return {
    version: "1.0",
    protocolVersion: contracts.protocolVersion,
    serverInfo: server.serverInfo,
    transport: { type: "streamable-http", url: server.transport },
    capabilities: server.capabilities,
    authentication: { required: false },
    documentationUrl: server.documentationUrl,
    tools: server.tools.map((tool) => ({
      ...tool,
      outputSchema: { type: "object", additionalProperties: true },
      annotations: { ...annotations, openWorldHint: tool.name.startsWith("lens_") },
    })),
  };
}

const site = contracts.servers.site;
const serendipity = contracts.servers.serendipity;
const siteCard = card(site);
const serendipityCard = card(serendipity);

const httpJson = [
  ["Public site search", "/search.json?q=agents"],
  ["Published photo query", "/photos/query.json?q=car"],
  ["Photo manifest", "/images/manifest.json"],
  ["Current playlist", "/rn/tracks"],
  ["Coffee availability", "/coffee/availability.json"],
  ["Neighborhood crawl", "/around/json"],
  ["Neighborhood change record", "/around/changes.json"],
  ["Lens inspection", "/lens/fetch?url=https%3A%2F%2Fexample.com"],
  ["Lens comparison", "/lens/compare.json?left=https%3A%2F%2Fexample.com&right=https%3A%2F%2Faadhar.sh"],
  ["Lens census", "/lens/census.json"],
  ["Serendipity events", "/serendipity/events.json"],
  ["Crawler ledger", "/ledger.json"],
];

const agentCard = {
  name: "Aadharsh Site",
  description: "Discovery for the bounded, public, read-only machine interfaces of aadhar.sh. No A2A task endpoint or private account data is exposed.",
  provider: { organization: "Aadharsh Pannirselvam", url: `${ROOT}/` },
  version: "3.0.0",
  documentationUrl: `${ROOT}/llms.txt`,
  supportedInterfaces: [site, serendipity].map((entry) => ({ url: entry.transport, protocolBinding: `https://modelcontextprotocol.io/specification/${contracts.protocolVersion}`, protocolVersion: contracts.protocolVersion, serverCard: entry === site ? `${ROOT}/.well-known/mcp/server-card.json` : `${ROOT}/.well-known/mcp/serendipity.json` })),
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["application/json", "text/plain"],
  skills: [
    { id: "site-read", name: "Read aadhar.sh", description: "Search public pages and read bounded music, photo, coffee, neighborhood, and Lens data.", tags: ["read-only", "search", "photos", "web"], examples: ["Search the site for writing about agents.", "Find photos made with Classic Chrome.", "Compare two public sites through Lens."], inputModes: ["application/json", "text/plain"], outputModes: ["application/json"] },
    { id: "serendipity-events", name: "Research public events", description: "List events and look up public attendees in the Serendipity pool.", tags: ["events", "people", "read-only"], examples: ["What events are happening soon?", "Who is going to this event?"], inputModes: ["application/json", "text/plain"], outputModes: ["application/json"] },
  ],
  "x-aadhar-sh": {
    cardType: "discovery-only",
    a2a: { taskEndpoint: null, note: "Use the declared MCP or HTTP interfaces; no A2A task endpoint exists." },
    interfaces: {
      mcp: [site, serendipity].map((entry) => ({ name: entry.serverInfo.title, url: entry.transport, transport: "streamable-http", protocolVersion: contracts.protocolVersion, authentication: "anonymous", documentationUrl: entry.documentationUrl, serverCard: entry === site ? `${ROOT}/.well-known/mcp/server-card.json` : `${ROOT}/.well-known/mcp/serendipity.json` })),
      httpJson: httpJson.map(([name, path]) => ({ name, url: `${ROOT}${path}`, authentication: "anonymous" })),
    },
    discovery: { llms: `${ROOT}/llms.txt`, apiCatalog: `${ROOT}/.well-known/api-catalog`, skillsIndex: `${ROOT}/.well-known/agent-skills/index.json` },
    outboundIdentity: { name: "AadharshBot", documentationUrl: `${ROOT}/bot`, jwksUrl: `${ROOT}/.well-known/http-message-signatures-directory`, protocol: "Web Bot Auth over RFC 9421 HTTP Message Signatures" },
  },
};

const apiCatalog = { linkset: [
  ...[
    [site, "/.well-known/mcp/server-card.json"],
    [serendipity, "/.well-known/mcp/serendipity.json"],
  ].map(([entry, cardPath]) => ({ anchor: entry.transport, "service-desc": [{ href: `${ROOT}${cardPath}`, type: "application/json", title: `${entry.serverInfo.title} MCP server card` }], "service-doc": [{ href: entry.documentationUrl, type: entry === site ? "text/plain" : "text/html", title: `${entry.serverInfo.title} documentation` }] })),
  ...httpJson.map(([name, path]) => ({ anchor: `${ROOT}${path.split("?")[0]}`, "service-desc": [{ href: `${ROOT}${path}`, type: "application/json", title: name }] })),
  { anchor: `${ROOT}/`, "service-doc": [{ href: `${ROOT}/llms.txt`, type: "text/plain", title: "Site guide" }], "service-desc": [{ href: `${ROOT}/.well-known/agent-card.json`, type: "application/json", title: "Agent discovery card" }] },
] };

const skillPath = new URL("agent-skills/serendipity-events/SKILL.md", outputRoot);
const skill = await readFile(skillPath);
const skillsIndex = {
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  skills: [{ name: "serendipity-events", type: "skill-md", description: "Query the public, read-only Serendipity event pool over MCP.", url: `${ROOT}/.well-known/agent-skills/serendipity-events/SKILL.md`, digest: `sha256:${createHash("sha256").update(skill).digest("hex")}` }],
};

const outputs = new Map([
  ["mcp/server-card.json", siteCard],
  ["mcp.json", serendipityCard],
  ["mcp/serendipity.json", serendipityCard],
  ["agent-card.json", agentCard],
  ["api-catalog", apiCatalog],
  ["agent-skills/index.json", skillsIndex],
]);

for (const [path, value] of outputs) {
  const target = new URL(path, outputRoot);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote public/.well-known/${path}`);
}
