#!/usr/bin/env node
// gen-md-twins.mjs — the Markdown twin for every page on the site that has prose,
// plus the per-section llms.txt indexes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentSurfaces, needsBuiltTwin, type AgentSurface } from "./lib/agent-representation.ts";
import { readDocument } from "./lib/html-to-md.ts";

export const ORIGIN = "https://aadhar.sh";
const MANIFEST = "config/site-manifest.json";
const SITEMAP = "public/sitemap.xml";
const HAND_DIR = "src/content/md";

export const INDEXED_SECTIONS = ["garage", "lwe"];

export function readManifest(root = ".") {
  return JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
}

export function readLastmod(root = ".") {
  const xml = readFileSync(join(root, SITEMAP), "utf8");
  const out = {};
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>(.*?)<\/loc>/.exec(block[1])?.[1];
    const mod = /<lastmod>(.*?)<\/lastmod>/.exec(block[1])?.[1];
    if (!loc) continue;
    try { out[new URL(loc).pathname.replace(/(.)\/$/, "$1") || "/"] = mod || null; } catch { }
  }
  return out;
}

export function htmlFileFor(surface, root = ".") {
  const p = surface.path;
  const candidates = p === "/"
    ? ["src/pages/index.html"]
    : [`src/pages${p}.html`, `src/pages${p}/index.html`];
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  return null;
}

export const twinPath = (p) => (p === "/" ? "/index.md" : `${p}.md`);

const yamlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function renderTwin({ surface, doc, lastmod, body, note }) {
  const title = doc?.title?.trim() || surface.title;
  const description = doc?.description?.trim() || surface.description || "";
  const canonical = doc?.canonical || ORIGIN + surface.path;

  const fm = [
    `title: ${yamlString(title)}`,
    description ? `description: ${yamlString(description)}` : null,
    `path: ${yamlString(surface.path)}`,
    `section: ${yamlString(surface.section)}`,
    `kind: ${yamlString(surface.kind)}`,
    lastmod ? `updated: ${yamlString(lastmod)}` : null,
    `source: ${yamlString(canonical)}`,
  ].filter(Boolean);

  const preamble = [
    `> Site index: ${ORIGIN}/llms.txt`,
    INDEXED_SECTIONS.includes(surface.section) ? `> Section index: ${ORIGIN}/${surface.section}/llms.txt` : null,
    "> This is the Markdown twin of a page on aadhar.sh. The HTML at the source",
    "> URL below is the original, and is hand-written and unminified on purpose.",
  ].filter(Boolean);

  const sections = [
    ["---", ...fm, "---"].join("\n"),
    preamble.join("\n"),
    note,
    body,
    `Source: ${canonical}`,
  ].filter(Boolean);

  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

export function renderSectionIndex(section, surfaces, { descriptions = {}, twins = null }: { descriptions?: Record<string, string>; twins?: Set<string> | null } = {}) {
  const own = surfaces.filter((s) => s.section === section);
  const head = own.find((s) => s.kind === "section") || own[0];
  const hasTwin = (s) => twins === null || twins.has(twinPath(s.path));
  const pages = own.filter((s) => s !== head && hasTwin(s));
  const htmlOnly = own.filter((s) => s !== head && !hasTwin(s));

  const lines = [
    `# ${head?.title || section}`,
    "",
    head?.description ? `> ${head.description}` : null,
    head?.description ? "" : null,
    `Every page below is also served as HTML at the same path without the \`.md\`.`,
    `The whole-site index is ${ORIGIN}/llms.txt.`,
    "",
    "## Pages",
    "",
  ].filter((l) => l !== null);

  if (head) lines.push(`- [${head.title}](${ORIGIN}${hasTwin(head) ? twinPath(head.path) : head.path}): ${head.description}`);
  for (const s of pages) {
    const d = descriptions[s.path] || s.description || "";
    lines.push(`- [${s.title}](${ORIGIN}${twinPath(s.path)})${d ? `: ${d}` : ""}`);
  }
  if (htmlOnly.length) {
    lines.push("", "## HTML only", "", "These pages have no Markdown twin. Each URL answers HTML.", "");
    for (const s of htmlOnly) {
      const d = descriptions[s.path] || s.description || "";
      lines.push(`- [${s.title}](${ORIGIN}${s.path})${d ? `: ${d}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderWritingIndex(root = ".") {
  const posts = JSON.parse(readFileSync(join(root, "src/content/writing/posts.json"), "utf8"));
  const rows = [...posts]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .map((p) => `- **${p.date}** [${p.title}](${ORIGIN}/writing/${p.slug}) ([plain text](${ORIGIN}/writing/${p.slug}.txt))`)
    .join("\n");
  return [
    "# My Writing",
    "",
    `${posts.length} post${posts.length === 1 ? "" : "s"}. Each one is a plain text file; the site renders it as a Notepad window, and the text is the source.`,
    "",
    rows,
  ].join("\n");
}

export function buildTwins(root = ".", opts: { generatedRoot?: string } = {}) {
  const manifest = readManifest(root);
  const lastmod = readLastmod(root);
  const files = new Map();
  const descriptions = {};
  const skipped = [];
  const generated = [];
  const committed: string[] = [];

  for (const surface of manifest.surfaces) {
    const rel = htmlFileFor(surface, root);
    const hand = join(HAND_DIR, `${surface.path === "/" ? "index" : surface.path.slice(1).replace(/\//g, "-")}.md`);
    const handAbs = join(root, hand);

    if (existsSync(join(root, "src/content", twinPath(surface.path).replace(/^\//, "")))) {
      descriptions[surface.path] = surface.description || "";
      committed.push(twinPath(surface.path));
      continue;
    }

    let doc = null, body = "", note = null;

    const generatedAbs = opts.generatedRoot
      ? join(opts.generatedRoot, "public", `${surface.path === "/" ? "index" : surface.path.slice(1)}.html`)
      : null;

    if (rel) {
      doc = readDocument(readFileSync(join(root, rel), "utf8"), { origin: ORIGIN });
      body = doc.body;
      if (!body) {
        note = "This page is an interactive tool: its content is built in the browser at runtime, so there is no static prose to mirror here. Open the source URL to use it.";
      }
    } else if (surface.path === "/writing") {
      body = renderWritingIndex(root);
    } else if (existsSync(handAbs)) {
      body = readFileSync(handAbs, "utf8").trim();
    } else if (generatedAbs && existsSync(generatedAbs)) {
      doc = readDocument(readFileSync(generatedAbs, "utf8"), { origin: ORIGIN });
      body = doc.body;
      if (!body) continue;
      generated.push(surface.path);
    } else {
      skipped.push(surface.path);
      continue;
    }

    descriptions[surface.path] = doc?.description?.trim() || surface.description || "";
    files.set(twinPath(surface.path), renderTwin({ surface, doc, lastmod: lastmod[surface.path], body, note }));
  }

  for (const section of INDEXED_SECTIONS) {
    files.set(`/${section}/llms.txt`, renderSectionIndex(section, manifest.surfaces, { descriptions, twins: new Set([...files.keys(), ...committed]) }));
  }

  return { files, skipped, generated, committed };
}

export function agentSurfacesWithoutTwin(surfaces: AgentSurface[], twins: Iterable<string>): string[] {
  const have = new Set(twins);
  return agentSurfaces(surfaces)
    .filter((s) => needsBuiltTwin(s) && !have.has(twinPath(s.path)))
    .map((s) => s.path);
}

export const TWIN_FACTS = [
  {
    twin: "src/content/md/bot.md",
    facts: [
      {
        label: "User-Agent",
        source: "src/worker/lib/botauth.ts",
        derive: (src) => {
          const name = /BOT_NAME\s*=\s*"([^"]+)"/.exec(src)?.[1];
          const version = /BOT_VERSION\s*=\s*"([^"]+)"/.exec(src)?.[1];
          return name && version ? `${name}/${version} (+https://aadhar.sh/bot)` : null;
        },
      },
      { label: "JWKS path", source: "src/worker/bot.ts", string: "/.well-known/http-message-signatures-directory" },
      { label: "sig1 algorithm", source: "src/worker/bot.ts", string: "Ed25519" },
      { label: "sig2 algorithm", source: "src/worker/bot.ts", string: "ML-DSA-44" },
    ],
  },
  {
    twin: "src/content/md/whoareyou.md",
    facts: [
      { label: "JSON endpoint", source: "src/worker/whoareyou.ts", string: "/whoareyou.json" },
      { label: "no-storage claim", source: "src/worker/whoareyou.ts", string: "none of it is stored" },
      { label: "WebMCP registrar", source: "src/worker/whoareyou.ts", string: "/webmcp.js" },
    ],
  },
  {
    twin: "src/content/md/security.md",
    facts: [
      { label: "frame-ancestors", source: "src/worker/lib/csp-policy.ts", string: "frame-ancestors 'none'" },
      { label: "object-src",      source: "src/worker/lib/csp-policy.ts", string: "object-src 'none'" },
      { label: "Referrer-Policy", source: "src/worker/lib/security.ts", string: "strict-origin-when-cross-origin" },
      {
        label: "hashed-CSP enforcement state",
        source: "src/worker/lib/security.ts",
        derive: (src) => {
          const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
          if (code.includes("content-security-policy-report-only")) return null;
          return "the enforced policy names each inline script by hash";
        },
      },
      { label: "JWKS path", source: "src/worker/security.ts", string: "/.well-known/http-message-signatures-directory" },
    ],
  },
  {
    twin: "src/content/md/garage-dyno.md",
    facts: [
      { label: "JSON endpoint", source: "src/worker/index.ts", string: "/garage/dyno.json" },
      { label: "worker series key", source: "src/worker/dyno.ts", string: "worker_gzip" },
      { label: "assets series key", source: "src/worker/dyno.ts", string: "assets_br" },
      { label: "history branch", source: "src/worker/dyno.ts", string: "perf-history" },
      { label: "island URL", source: "src/worker/routes.ts", string: "/garage/dyno/pulls.html" },
      {
        label: "cache window",
        source: "src/worker/dyno.ts",
        derive: (src) => {
          const hours = /KV_TTL\s*=\s*(\d+)\s*\*\s*3600/.exec(src)?.[1] ?? "";
          const word = ({ 1: "one", 2: "two", 3: "three", 4: "four", 6: "six", 12: "twelve", 24: "twenty-four" } as Record<string, string>)[hours];
          return word ? `${word} hours` : null;
        },
      },
    ],
  },
  {
    twin: "src/content/md/ledger.md",
    facts: [
      { label: "island URL", source: "src/worker/routes.ts", string: "/ledger/lines.html" },
      { label: "JSON endpoint", source: "src/worker/index.ts", string: "/ledger.json" },
      { label: "line-item key", source: "src/worker/ledger.ts", string: "line_items" },
      {
        label: "window",
        source: "src/worker/ledger.ts",
        derive: (src) => {
          const days = /WINDOW_DAYS\s*=\s*(\d+)/.exec(src)?.[1];
          return days ? `${days} days` : null;
        },
      },
      {
        label: "rate",
        source: "src/worker/ledger.ts",
        derive: (src) => {
          const rate = /RATE_USD\s*=\s*([\d.]+)/.exec(src)?.[1];
          return rate ? `$${rate}` : null;
        },
      },
    ],
  },
  {
    twin: "src/content/md/inbox.md",
    facts: [
      { label: "island URL", source: "src/worker/routes.ts", string: "/inbox/mail.html" },
      { label: "endpoint", source: "src/worker/index.ts", string: "/webmention" },
      { label: "encoding", source: "src/worker/webmention.ts", string: "application/x-www-form-urlencoded" },
    ],
  },
  {
    twin: "src/content/md/reading.md",
    facts: [
      { label: "island URL", source: "src/worker/routes.ts", string: "/reading/list.html" },
      {
        label: "Curius profile",
        source: "src/worker/reading.ts",
        derive: (src) => {
          const handle = /CURIUS_HANDLE\s*=\s*"([^"]+)"/.exec(src)?.[1];
          return handle ? `https://curius.app/${handle}` : null;
        },
      },
      {
        label: "cache window",
        source: "src/worker/reading.ts",
        derive: (src) => {
          const secs = Number(/CURIUS_TTL\s*=\s*(\d+)/.exec(src)?.[1] ?? NaN);
          const word = ({ 1: "one", 2: "two", 3: "three", 6: "six", 12: "twelve", 24: "twenty-four" } as Record<number, string>)[secs / 3600];
          return word ? `${word} hours` : null;
        },
      },
    ],
  },
  {
    twin: "src/content/md/lens-census.md",
    facts: [
      { label: "island URL", source: "src/worker/routes.ts", string: "/lens/census/table.html" },
      { label: "JSON endpoint", source: "src/worker/index.ts", string: "/lens/census.json" },
      { label: "newest-sweep key", source: "src/worker/census.ts", string: "lastYmd" },
      { label: "roster size", source: "src/worker/census.ts", string: "16 representative sites" },
    ],
  },
  {
    twin: "src/content/md/serendipity.md",
    facts: [
      {
        label: "island URL",
        source: "serendipity/serendipity.ts",
        derive: (src) => {
          const prefix = /const PREFIX\s*=\s*"([^"]+)"/.exec(src)?.[1];
          return prefix && src.includes("EVENTS_URL = `${PREFIX}/events.html`") ? `${prefix}/events.html` : null;
        },
      },
      {
        label: "MCP endpoint",
        source: "serendipity/serendipity.ts",
        derive: (src) => {
          const prefix = /const PREFIX\s*=\s*"([^"]+)"/.exec(src)?.[1];
          return prefix && src.includes("path === `${PREFIX}/mcp`") ? `https://aadhar.sh${prefix}/mcp` : null;
        },
      },
      {
        label: "tool list",
        source: "public/.well-known/mcp/serendipity.json",
        derive: (src) => {
          let names: string[];
          try { names = JSON.parse(src).tools.map((t) => `\`${t.name}\``); } catch { return null; }
          if (names.length < 2) return null;
          return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
        },
      },
    ],
  },
  {
    twin: "src/content/md/search.md",
    facts: [
      { label: "JSON endpoint", source: "src/worker/index.ts", string: "/search.json" },
      { label: "NLWeb endpoint", source: "src/worker/index.ts", string: "/ask" },
      { label: "MCP tool", source: "src/worker/lib/tools.ts", string: "search_site" },
      { label: "corpus", source: "tools/generate-search-index.ts", string: "search-index.json" },
      {
        label: "default limit",
        source: "src/worker/lib/api-limits.ts",
        derive: (src) => {
          const d = /SEARCH_LIMITS\s*=\s*\{[^}]*limitDefault:\s*(\d+)/.exec(src)?.[1];
          return d ? `defaults to ${d}` : null;
        },
      },
      {
        label: "limit ceiling",
        source: "src/worker/lib/api-limits.ts",
        derive: (src) => {
          const max = /SEARCH_LIMITS\s*=\s*\{[^}]*limitMax:\s*(\d+)/.exec(src)?.[1];
          return max ? `tops out at ${max}` : null;
        },
      },
    ],
  },
];

export function checkTwinFacts(root = ".") {
  const problems = [];
  for (const { twin, facts } of TWIN_FACTS) {
    const t = join(root, twin);
    if (!existsSync(t)) { problems.push(`${twin} is missing`); continue; }
    const tv = readFileSync(t, "utf8");

    for (const f of facts) {
      const s = join(root, f.source);
      if (!existsSync(s)) { problems.push(`${f.source} is missing (pinned by ${twin})`); continue; }
      const sv = readFileSync(s, "utf8");

      const expected = f.derive ? f.derive(sv) : (sv.includes(f.string) ? f.string : null);
      if (expected === null) {
        problems.push(`${f.source} no longer states its ${f.label}; ${twin} may now be stale`);
        continue;
      }
      if (!tv.includes(expected)) {
        problems.push(`${twin} must state ${f.label} as ${JSON.stringify(expected)} to match ${f.source}`);
      }
    }
  }
  return problems;
}

function main() {
  const outDir = process.argv[2] || ".build/public";
  const { files, skipped } = buildTwins(".");
  const factProblems = checkTwinFacts(".");
  if (factProblems.length) {
    console.error("gen-md-twins: twin/source fact drift:\n  - " + factProblems.join("\n  - "));
    process.exitCode = 1;
    return;
  }
  for (const [rel, body] of files) {
    const dest = join(outDir, rel.replace(/^\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  const twins = [...files.keys()].filter((k) => k.endsWith(".md")).length;
  const indexes = [...files.keys()].filter((k) => k.endsWith("llms.txt")).length;
  console.log(`md twins: ${twins} pages + ${indexes} section indexes -> ${outDir}` + (skipped.length ? ` (no prose source: ${skipped.length})` : ""));
}

if (import.meta.main) main();
