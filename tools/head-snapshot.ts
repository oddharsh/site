#!/usr/bin/env bun
// head-snapshot.ts — record the head tags crawlers and link-preview bots read
// off every built page, and diff two recordings.
//
//   bun tools/head-snapshot.ts record <out.json> [--root .build/public] [--label <name>]
//   bun tools/head-snapshot.ts compare <base.json> <head.json> [--out <file.md>]
//
// The idea is X's crawler-parity script from their 2026-11 rebuild of x.com:
// fetch one path from two servers as Googlebot and compare status, title,
// description, canonical, robots, OG and card tags, language alternates and
// structured-data types. This site has one server, so the drift worth catching
// runs between VERSIONS: a PR that rewrites a canonical or drops an og:image
// ships green, because nothing a reviewer reads shows the head. perf-diff.yml
// builds the merge base and HEAD and runs this beside perf-snapshot.ts, and the
// diff joins the wire-size comment.
//
// Advisory, for the reason perf-snapshot.ts gives: a check that fails on a
// changed description teaches people to stop changing descriptions, or to widen
// whatever it compares. The contract suite already pins the invariants that
// should fail (contract-og-images-resolve, contract-garage-and-lwe-pages-carry-
// an-article); this reports what moved.
//
// Reads the BUILT tree, because that is what a crawler gets: build.ts injects
// the Article JSON-LD (lib/article-ld.ts) and minifies attributes unquoted, so
// the authored source holds neither the final head nor its final syntax. It
// parses with HTMLRewriter (a bun global, as in build.ts) rather than regexes,
// since the regex in article-ld.ts reads `content="..."` and the minifier
// writes `content=website`.
//
// Status is the one fact the built HTML can't hold. It comes from the route
// oracle's literal rows in tools/verify-routes.ts, read as text from the tree
// being measured: that file runs its sweep on import, and perf-diff.yml stashes
// only tools/lib beside this script, so each revision's own table is the honest
// source. A page with no literal HTML row records null on both sides, which
// diffs as nothing.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { decodeEntities } from "./lib/article-ld.ts";

const SCHEMA = 1;

type Facts = Record<string, string>;
type Snapshot = { schema: typeof SCHEMA; label: string; pages: Record<string, Facts> };

/** `garage/horizon.html` -> `/garage/horizon`, `lwe/index.html` -> `/lwe`. */
export function servedPath(file: string): string {
  const stem = file.replace(/\.html$/, "").replace(/(^|\/)index$/, "");
  return `/${stem}`;
}

/** The status each literal oracle row expects for a plain HTML GET. Rows that
 *  send headers (Accept negotiation, ranges) answer a different question. */
export function oracleStatuses(source: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of source.matchAll(/\{\s*path:\s*"([^"]+)",\s*status:\s*(\d+)\b([^}]*)/g)) {
    const [, path, status, rest] = row;
    if (/\bheaders:/.test(rest) || out.has(path)) continue;
    const ct = /\bct:\s*"([^"]+)"/.exec(rest)?.[1];
    if (ct && ct !== "text/html") continue;
    out.set(path, Number(status));
  }
  return out;
}

/** Every `@type` in one JSON-LD block, nested ones included (an Article's
 *  author is a Person, a homepage's @graph lists three), in document order. */
function ldTypes(json: string): string[] {
  const types: string[] = [];
  JSON.parse(json, (key, value) => {
    if (key === "@type") types.push(...[value].flat().map(String));
    return value;
  });
  return types;
}

/** The head facts of one HTML document. Repeated keys get `#2`, `#3`, so a
 *  second og:image is its own row rather than a silent overwrite. */
export async function headFacts(html: string, status: number | null): Promise<Facts> {
  const facts: Facts = {};
  const put = (key: string, value: string) => {
    let k = key;
    for (let n = 2; k in facts; n++) k = `${key}#${n}`;
    facts[k] = value;
  };
  if (status !== null) put("status", String(status));
  const clean = (v: string | null) => decodeEntities(v ?? "").trim();
  let title = "";
  let titleRead = false;
  let ld = 0;
  let ldText = "";
  await new HTMLRewriter()
    .on("title", {
      text(t) {
        // The first <title> only: an inline SVG's <title> in the body is not the page's.
        if (titleRead) return;
        title += t.text;
        if (!t.lastInTextNode) return;
        put("title", clean(title).replace(/\s+/g, " "));
        titleRead = true;
      },
    })
    .on("meta", {
      element(e) {
        const name = (e.getAttribute("name") ?? e.getAttribute("property") ?? "").toLowerCase();
        if (name === "description" || name === "robots" || name.startsWith("og:") || name.startsWith("twitter:")) put(name, clean(e.getAttribute("content")));
      },
    })
    .on("link", {
      element(e) {
        const rel = (e.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
        if (rel.includes("canonical")) put("canonical", clean(e.getAttribute("href")));
        const lang = e.getAttribute("hreflang");
        if (rel.includes("alternate") && lang) put(`alternate[${lang}]`, clean(e.getAttribute("href")));
      },
    })
    .on('script[type="application/ld+json"]', {
      text(t) {
        ldText += t.text;
        if (!t.lastInTextNode) return;
        ld += 1;
        let types: string;
        try {
          types = ldTypes(ldText).join(", ") || "(no @type)";
        } catch {
          types = "(unparseable JSON)";
        }
        put(`ld+json[${ld}]`, types);
        ldText = "";
      },
    })
    .transform(new Response(html))
    .text();
  return facts;
}

async function record(outPath: string, root: string, label: string) {
  let files: string[];
  try {
    files = (await readdir(root, { recursive: true }))
      .map(String)
      .filter((f) => f.endsWith(".html") && !f.endsWith(".src.html"))
      .sort();
  } catch {
    files = [];
  }
  let oracle = new Map<string, number>();
  try {
    oracle = oracleStatuses(await readFile("tools/verify-routes.ts", "utf8"));
  } catch {
    console.error("head-snapshot: no tools/verify-routes.ts here, so every status records as unknown");
  }

  const snapshot: Snapshot = { schema: SCHEMA, label, pages: {} };
  let fragments = 0;
  for (const file of files) {
    const path = servedPath(file);
    const facts = await headFacts(await readFile(`${root}/${file}`, "utf8"), oracle.get(path) ?? null);
    // An island fragment (/photos/grid.html) has no head; it is not a document a
    // crawler indexes, and listing it would add a row of nothing per fragment.
    if (!("title" in facts)) {
      fragments += 1;
      continue;
    }
    snapshot.pages[path] = facts;
  }

  // A recording of nothing must fail here, because compare cannot tell two empty
  // snapshots from two identical ones and would print "No change" in green
  // (perf-snapshot.ts learned this on 2026-08-20). Canonicals are the second
  // half: a parser that stopped reading attributes still finds every <title>.
  const pages = Object.values(snapshot.pages);
  const canonicals = pages.filter((f) => "canonical" in f).length;
  if (pages.length === 0 || canonicals === 0) {
    console.error(`head-snapshot: FAILED, read ${pages.length} documents and ${canonicals} canonicals under ${root}; was the tree built?`);
    process.exit(1);
  }
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`head-snapshot: recorded ${label}, ${pages.length} documents (${canonicals} with a canonical, ${fragments} fragments skipped) -> ${outPath}`);
}

const cell = (v: string | undefined) => (v === undefined ? "—" : v === "" ? "_(empty)_" : v.replace(/[\\|]/g, "\\$&").replace(/\n/g, " "));

/** The diff as Markdown: one row per fact that differs, nothing for the rest. */
export function compareSnapshots(base: Snapshot, head: Snapshot): string {
  const rows: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const paths = [...new Set([...Object.keys(base.pages), ...Object.keys(head.pages)])].sort();
  for (const path of paths) {
    const b = base.pages[path];
    const h = head.pages[path];
    // A page that appears or disappears is one line, not one row per tag: its
    // whole head is new, and the reviewer's question is whether it should exist.
    if (!b) {
      added.push(path);
      continue;
    }
    if (!h) {
      removed.push(path);
      continue;
    }
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
      if (b[key] === h[key]) continue;
      rows.push(`| \`${path}\` | \`${key}\` | ${cell(b[key])} | ${cell(h[key])} |`);
    }
  }

  const out = ["## Head tags vs merge base", ""];
  const count = Object.keys(head.pages).length;
  if (!rows.length && !added.length && !removed.length) {
    out.push(
      `No change. ${count} documents, every title, description, canonical, robots, \`og:*\`, \`twitter:*\`, alternate, JSON-LD type and oracle status identical.`,
    );
    return `${out.join("\n")}\n`;
  }
  out.push(
    "What search engines and link-preview bots read off each built page: the oracle's status, title, description, canonical, robots, `og:*`, `twitter:*`, hreflang alternates, and each JSON-LD block's `@type` list. **Advisory, fails on nothing.**",
    "",
  );
  if (added.length) out.push(`**New documents:** ${added.map((p) => `\`${p}\``).join(", ")}`, "");
  if (removed.length) out.push(`**Removed documents:** ${removed.map((p) => `\`${p}\``).join(", ")}`, "");
  if (rows.length) out.push("| page | tag | base | head |", "|---|---|---|---|", ...rows, "");
  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
  if (mode === "record" && positional[0]) {
    await record(positional[0], flag("--root") ?? ".build/public", flag("--label") ?? "unknown");
  } else if (mode === "compare" && positional.length >= 2) {
    const [base, head] = await Promise.all(positional.slice(0, 2).map(async (p) => JSON.parse(await readFile(p, "utf8")) as Snapshot));
    const md = compareSnapshots(base, head);
    const out = flag("--out");
    if (out) await writeFile(out, md);
    else process.stdout.write(md);
  } else {
    console.error("usage: head-snapshot.ts record <out.json> [--root <dir>] [--label <name>] | compare <base.json> <head.json> [--out <file.md>]");
    process.exit(2);
  }
}
