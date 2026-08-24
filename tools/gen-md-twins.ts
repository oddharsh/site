#!/usr/bin/env node
// gen-md-twins.mjs — the Markdown twin for every page on the site that has prose,
// plus the per-section llms.txt indexes.
//
//   node tools/gen-md-twins.ts [outDir]     # default: .build/public
//
// WHY THIS IS BUILD OUTPUT, NOT COMMITTED SOURCE
// A twin is a pure function of the HTML the build just produced, so generating
// it at deploy time makes drift structurally impossible: there is no committed
// copy that can fall behind the page it mirrors, and no step to forget. That is
// the same argument the dcz deltas won in CLAUDE.md, and unlike sitemap.xml
// there is no hand-tuned signal here worth preserving.
//
// WHAT IS AUTHORED BY HAND
// /bot, /whoareyou and /security render from the Worker, so their prose lives in
// template literals rather than a file this script can read. Their twins are
// authored in src/content/md/, and checkTwinFacts() below pins the load-bearing
// strings so the twin cannot quietly disagree with the page.
//
// Every exported function is PURE so build.mjs can re-run this in-memory; only
// main() touches the filesystem.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDocument } from "./lib/html-to-md.ts";

export const ORIGIN = "https://aadhar.sh";
const MANIFEST = "config/site-manifest.json";
const SITEMAP = "public/sitemap.xml";
const HAND_DIR = "src/content/md";

// the sections that earn their own index. A section index is only worth a fetch
// when the section is big enough that the root llms.txt is the wrong grain.
export const INDEXED_SECTIONS = ["garage", "lwe"];

// ── inputs ──────────────────────────────────────────────────────────────────

export function readManifest(root = ".") {
  return JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
}

/** path -> YYYY-MM-DD, read from the hand-tuned <lastmod> values in sitemap.xml. */
export function readLastmod(root = ".") {
  const xml = readFileSync(join(root, SITEMAP), "utf8");
  const out = {};
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>(.*?)<\/loc>/.exec(block[1])?.[1];
    const mod = /<lastmod>(.*?)<\/lastmod>/.exec(block[1])?.[1];
    if (!loc) continue;
    try { out[new URL(loc).pathname.replace(/(.)\/$/, "$1") || "/"] = mod || null; } catch { /* skip */ }
  }
  return out;
}

/** The source HTML file backing a surface, or null when the Worker renders it. */
export function htmlFileFor(surface, root = ".") {
  const p = surface.path;
  const candidates = p === "/"
    ? ["src/pages/index.html"]
    : [`src/pages${p}.html`, `src/pages${p}/index.html`];
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  return null;
}

/** The URL a twin is published at: /garage/encoding -> /garage/encoding.md */
export const twinPath = (p) => (p === "/" ? "/index.md" : `${p}.md`);

// ── rendering ───────────────────────────────────────────────────────────────

const yamlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * One Markdown twin. Pure.
 *
 * The preamble is the cheapest thing in this file and close to the most useful:
 * an agent that lands on a deep page from a search result gets handed the map
 * instead of having to infer that one exists.
 */
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

/**
 * A per-section llms.txt. Same grammar as the root index, one level down.
 * Links point at the .md twins rather than the HTML, because the twin is the
 * representation an agent asked for.
 */
export function renderSectionIndex(section, surfaces, { descriptions = {} } = {}) {
  const own = surfaces.filter((s) => s.section === section);
  const head = own.find((s) => s.kind === "section") || own[0];
  const pages = own.filter((s) => s !== head);

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

  if (head) lines.push(`- [${head.title}](${ORIGIN}${twinPath(head.path)}): ${head.description}`);
  for (const s of pages) {
    const d = descriptions[s.path] || s.description || "";
    lines.push(`- [${s.title}](${ORIGIN}${twinPath(s.path)})${d ? `: ${d}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

// ── the whole set ───────────────────────────────────────────────────────────

/**
 * Build every twin + section index as { path -> contents }. Pure apart from
 * reading the source tree, which build.mjs also does.
 *
 * opts.generatedRoot names a staged tree to fall back to for surfaces with no
 * prose source in `root`. That tier did not exist when this file was written:
 * /updates and /restore were Worker-rendered, so they had no twin and could not
 * have one, and when build.mjs started baking them into HTML nothing here
 * noticed. They stayed on the skipped list, kept `flags.agents: true`, and kept
 * answering HTML to an agent asking for Markdown. Read only BEFORE the staged
 * pages are rewritten (hashed asset refs, minification); build.mjs owns that
 * ordering and reads the source tree first for everything that has one.
 */
/**
 * The /writing index, from the registry the page itself renders. Sorted newest
 * first, matching the folder view.
 *
 * Each post ships as plain text at `<slug>.txt` and that URL is the twin for the
 * post, so this index links to the text rather than to the Notepad window that
 * wraps it: an agent following one of these gets the prose with no chrome to
 * strip.
 */
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

  for (const surface of manifest.surfaces) {
    const rel = htmlFileFor(surface, root);
    const hand = join(HAND_DIR, `${surface.path === "/" ? "index" : surface.path.slice(1).replace(/\//g, "-")}.md`);
    const handAbs = join(root, hand);

    // A COMMITTED twin always wins. The homepage's /index.md is hand-written
    // prose that predates this script and reads better than any extraction of
    // src/pages/index.html would; it also already ships as a static asset and
    // already answers `Accept: text/markdown`. Generating over it would be a
    // regression dressed up as consistency.
    // Looked in public/ until the prose moved: the homepage twin is authored at
    // src/content/index.md now and STAGES to /index.md, so the check follows the
    // source rather than the served path. Reading the old location silently
    // stopped finding it, and the symptom was the hand-written twin being
    // overwritten by a generated one that is 472 bytes shorter.
    if (existsSync(join(root, "src/content", twinPath(surface.path).replace(/^\//, "")))) {
      descriptions[surface.path] = surface.description || "";
      continue;
    }

    let doc = null, body = "", note = null;

    // A hand-authored twin outranks the generated tier below, and the order is
    // load-bearing rather than incidental: /bot has BOTH a hand twin and staged
    // HTML, and its hand twin is the one checkTwinFacts pins against the Worker
    // in both directions. Preferring generated bytes there would silently swap a
    // fact-checked file for an unchecked extraction.
    const generatedAbs = opts.generatedRoot
      ? join(opts.generatedRoot, "public", `${surface.path === "/" ? "index" : surface.path.slice(1)}.html`)
      : null;

    if (rel) {
      doc = readDocument(readFileSync(join(root, rel), "utf8"), { origin: ORIGIN });
      body = doc.body;
      if (!body) {
        // A page whose content is assembled in the browser has no prose to
        // mirror. Say that, rather than ship a hollow file that reads as if the
        // page were empty.
        note = "This page is an interactive tool: its content is built in the browser at runtime, so there is no static prose to mirror here. Open the source URL to use it.";
      }
    } else if (surface.path === "/writing") {
      // /writing renders from the Worker, so there is no HTML file to mirror,
      // and a HAND twin would be the wrong shape: the page is a LIST, and a
      // hand-written list goes stale the next time a post is added. The registry
      // it renders from is committed, so the twin is derived from the same bytes
      // the page is. Same argument as every other generated twin, reaching one
      // step further back than the HTML.
      body = renderWritingIndex(root);
    } else if (existsSync(handAbs)) {
      body = readFileSync(handAbs, "utf8").trim();
    } else if (generatedAbs && existsSync(generatedAbs)) {
      doc = readDocument(readFileSync(generatedAbs, "utf8"), { origin: ORIGIN });
      body = doc.body;
      if (!body) continue;   // nothing to mirror and no source URL claim to make
      generated.push(surface.path);
    } else {
      skipped.push(surface.path);
      continue;
    }

    descriptions[surface.path] = doc?.description?.trim() || surface.description || "";
    files.set(twinPath(surface.path), renderTwin({ surface, doc, lastmod: lastmod[surface.path], body, note }));
  }

  for (const section of INDEXED_SECTIONS) {
    files.set(`/${section}/llms.txt`, renderSectionIndex(section, manifest.surfaces, { descriptions }));
  }

  return { files, skipped, generated };
}

/**
 * The load-bearing facts a hand-authored twin shares with the Worker that
 * renders its page. A twin is allowed to be shorter than the page; it is not
 * allowed to disagree with it. build.mjs fails the deploy on a mismatch.
 *
 * Each fact is checked in BOTH directions. Asserting only that the twin says
 * "AadharshBot/1.0" would keep passing after a version bump, because the twin
 * would still contain the string it always did. So the expected value is
 * recomposed from the Worker's own constants and then required in the twin: bump
 * BOT_VERSION to 1.1 and this fails until bot.md is updated to match.
 */
export const TWIN_FACTS = [
  {
    twin: "src/content/md/bot.md",
    facts: [
      {
        label: "User-Agent",
        source: "src/worker/lib/botauth.ts",
        // BOT_UA is a template literal over two constants, so no single source
        // line contains the string a reader of /bot actually sees
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
      // The page's whole subject is what a request reveals, so the ONE script on it
      // that this repository does not contain has to be named in both copies or in
      // neither. Pinning the path means turning the edge injection off (or Cloudflare
      // renaming it) fails the deploy rather than leaving the page describing a tag
      // that is no longer there.
      { label: "WebMCP bridge", source: "src/worker/whoareyou.ts", string: "/.webmcp/bridge.js" },
    ],
  },
  {
    // /security is a page ABOUT headers, so pinning it to the page's own copy of
    // those headers would only prove the twin agrees with prose that is itself
    // free to rot. Every fact below is read from lib/security.js, the module that
    // actually sends them, except the JWKS path, which is the page's own claim.
    twin: "src/content/md/security.md",
    facts: [
      { label: "frame-ancestors", source: "src/worker/lib/security.ts", string: "frame-ancestors 'none'" },
      { label: "object-src",      source: "src/worker/lib/security.ts", string: "object-src 'none'" },
      { label: "Referrer-Policy", source: "src/worker/lib/security.ts", string: "strict-origin-when-cross-origin" },
      {
        // This used to read the ENFORCE_PAGE_HASHES rollout flag and pick the
        // sentence the twin had to carry. The flag is gone (2026-08-23), and
        // reading the EMITTED HEADER SET is the better check anyway: a flag
        // says what somebody intended, while this says what the module sends.
        // /security claims 'unsafe-inline' left script-src. That claim goes
        // false the moment a report-only twin comes back, because the twin is
        // how the hashed policy ships without being enforced, so this fails the
        // deploy until either the header set or the page is put right.
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

// ── main ────────────────────────────────────────────────────────────────────

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

// argv[1] is undefined under `node -e`, where this module is only ever imported
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
