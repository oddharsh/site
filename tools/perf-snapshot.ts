#!/usr/bin/env node
// perf-snapshot.mjs — record the built tree's wire sizes, and diff two recordings.

import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { siteWranglerArgs } from "./lib/site-config.ts";

const BUILD = ".build/public";
const DRYRUN_OUT = ".build/.perfsnap";

const SCHEMA = 1;

const sizes = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});

const dehash = (name) => name.replace(/\.[0-9a-f]{8}\./, ".");

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

async function walk(dir, filter) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath ?? e.path}/${e.name}`.slice(dir.length + 1))
    .filter(filter)
    .sort();
}

async function record(outPath, label) {
  // WRANGLER'S ENTRY DIRECTLY, through whatever node is running this file, so
  // the invocation does not name a package manager at all. It used to spawn
  // "pnpm" as a quoted argument, which is invisible to any sweep looking for
  // `pnpm exec` as a phrase (gotcha 29's blind spot), so it survived the swap
  // and then failed instantly on a tree with no pnpm.
  let dryOut = "";
  try {
    dryOut = execFileSync(...wranglerCommand(await siteWranglerArgs(["deploy", "--dry-run",
      "--outdir", DRYRUN_OUT,
      "--metafile",
    ])), { encoding: "utf8" });
  } catch (e) {
    dryOut = `${e.stdout || ""}\n${e.stderr || ""}`;
  }

  type Sizes = { raw?: number; gzip?: number; brotli?: number; br?: number };
  const snapshot: {
    schema: typeof SCHEMA; label: string; subject: string;
    worker: { gzipBytes: number | null; modules: Record<string, number> };
    assets: Record<string, Sizes>; pages: Record<string, Sizes>; wire: Record<string, Sizes>;
    dcz: { count: number; bytes: number; dictionaryBrotliBytes: number };
    [more: string]: any;
  } = {
    schema: SCHEMA,
    label: label || git("rev-parse", "--short", "HEAD") || "unknown",
    subject: git("log", "-1", "--format=%s"),
    worker: { gzipBytes: null, modules: {} },
    assets: {},
    pages: {},
    wire: {},
    dcz: { count: 0, bytes: 0, dictionaryBrotliBytes: 0 },
  };

  const gz = dryOut.match(/gzip:\s*([\d.]+)\s*KiB/);
  if (gz) snapshot.worker.gzipBytes = Math.round(parseFloat(gz[1]) * 1024);
  else console.error("perf-snapshot: could not read bundle gzip from the dry-run (offline/unauth?)");

  try {
    const meta = JSON.parse(await readFile(`${DRYRUN_OUT}/bundle-meta.json`, "utf8"));
    const entry = (Object.entries(meta.outputs) as [string, { inputs?: Record<string, { bytesInOutput?: number }> }][])
      .find(([n]) => n.endsWith(".js") && !n.endsWith(".map"));
    for (const [name, v] of Object.entries(entry?.[1]?.inputs ?? {})) {
      snapshot.worker.modules[name] = v.bytesInOutput ?? 0;
    }
  } catch (e) {
    console.error(`perf-snapshot: no bundle metafile (${e.message}); skipping module attribution`);
  }

  for (const name of await walk(BUILD, (f) => /^[^/]+\.(js|css)$/.test(f) && !/\.src\.(js|css)$/.test(f))) {
    snapshot.assets[name] = sizes(await readFile(`${BUILD}/${name}`));
  }

  for (const name of await walk(BUILD, (f) => f.endsWith(".html") && !f.endsWith(".src.html"))) {
    snapshot.pages[name] = sizes(await readFile(`${BUILD}/${name}`));
  }

  for (const name of await walk(`${BUILD}/a`, (f) => !f.endsWith(".br") && !f.endsWith(".dict"))) {
    let br = null;
    try { br = (await readFile(`${BUILD}/a/${name}.br`)).length; } catch {}
    const raw = (await readFile(`${BUILD}/a/${name}`)).length;
    if (/^quiz-[\w-]+\.[0-9a-f]{8}\.json$/.test(name)) {
      const prev = snapshot.wire["quiz-data.json"];
      snapshot.wire["quiz-data.json"] = { raw: (prev?.raw ?? 0) + raw, br: (prev?.br ?? 0) + (br ?? raw) };
      continue;
    }
    snapshot.wire[dehash(name)] = { raw, br };
  }

  for (const name of await walk(`${BUILD}/pd`, (f) => f.endsWith(".dcz"))) {
    snapshot.dcz.count += 1;
    snapshot.dcz.bytes += (await readFile(`${BUILD}/pd/${name}`)).length;
  }

  for (const name of await walk(`${BUILD}/a`, (f) => /^page-family\.[0-9a-f]{8}\.dict\.br$/.test(f))) {
    snapshot.dcz.dictionaryBrotliBytes += (await readFile(`${BUILD}/a/${name}`)).length;
  }

  const n = Object.keys(snapshot.assets).length + Object.keys(snapshot.pages).length;
  const mods = Object.keys(snapshot.worker.modules).length;
  if (n === 0 || mods === 0) {
    console.error(`perf-snapshot: FAILED — recorded ${n} files and ${mods} modules, so the dry-run did not build. Its output ended:\n${dryOut.trim().slice(-800)}`);
    process.exit(1);
  }
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`perf-snapshot: recorded ${snapshot.label} — ${n} files, ${mods} modules -> ${outPath}`);
}

const kib = (b) => `${(b / 1024).toFixed(2)} KiB`;
const signed = (b) => `${b > 0 ? "+" : ""}${(b / 1024).toFixed(2)} KiB`;
const pct = (base, head) => (base === 0 ? "n/a" : `${head > base ? "+" : ""}${(((head - base) / base) * 100).toFixed(1)}%`);

const PAGE_NOISE_FLOOR = 128;

function diffRows(base, head, pick) {
  const names = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  const rows = [];
  for (const name of names) {
    const b = name in base ? pick(base[name]) : null;
    const h = name in head ? pick(head[name]) : null;
    if (b === h) continue;
    rows.push({ name, base: b, head: h, delta: (h ?? 0) - (b ?? 0) });
  }
  return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

const total = (set: Record<string, unknown>, pick: (v: any) => number | undefined): number =>
  Object.values(set).reduce<number>((n, v) => n + (pick(v) ?? 0), 0);

function table(rows, { limit = 20 } = {}) {
  const out = ["| file | base | head | Δ |", "|---|--:|--:|--:|"];
  for (const r of rows.slice(0, limit)) {
    const b = r.base === null ? "—" : kib(r.base);
    const h = r.head === null ? "—" : kib(r.head);
    const d = r.base === null ? "**new**" : r.head === null ? "**removed**" : `${signed(r.delta)} (${pct(r.base, r.head)})`;
    out.push(`| \`${r.name}\` | ${b} | ${h} | ${d} |`);
  }
  if (rows.length > limit) out.push(`| … | | | _${rows.length - limit} more_ |`);
  return out.join("\n");
}

function section(title, rows, base, head, pick, { unit = "Brotli", floor = 0 } = {}) {
  const b = total(base, pick);
  const h = total(head, pick);
  const count = Object.keys(head).length;
  if (!rows.length) return `### ${title}\n\nNo change. ${count} files, ${kib(h)} ${unit} total.\n`;

  const keep = (r) => r.base === null || r.head === null || Math.abs(r.delta) >= floor;
  const listed = rows.filter(keep);
  const collapsed = rows.filter((r) => !keep(r));

  const out = [
    `### ${title}`,
    "",
    `**Total ${unit}: ${kib(b)} → ${kib(h)} (${signed(h - b)}, ${pct(b, h)})** across ${count} files, ${rows.length} changed.`,
    "",
  ];
  if (listed.length) out.push(table(listed), "");
  else out.push(`_No single file moved by ${kib(floor)} or more._`, "");
  if (collapsed.length) {
    const net = collapsed.reduce((n, r) => n + r.delta, 0);
    out.push(`<sub>Plus ${collapsed.length} file${collapsed.length === 1 ? "" : "s"} under the ${kib(floor)} floor, net ${signed(net)} — usually content-hash churn in \`/a/\` references, counted in the total above.</sub>`, "");
  }
  return out.join("\n");
}

async function compare(basePath, headPath, outPath) {
  const [base, head] = await Promise.all([
    readFile(basePath, "utf8").then(JSON.parse),
    readFile(headPath, "utf8").then(JSON.parse),
  ]);

  const parts = [
    "<!-- perf-snapshot-diff -->",
    "## Wire-size diff vs merge base",
    "",
    `\`${base.label}\` → \`${head.label}\``,
    "",
    "Brotli q11, the quality the edge serves. Every number here is deterministic:",
    "an unchanged file produces no row. **Advisory — this check fails on nothing.**",
    "",
  ];

  type Recorded = Record<string, { raw?: number; gzip?: number; brotli?: number; br?: number }>;
  const merge = (snap: { assets: Recorded; wire: Recorded }) => {
    const out: Record<string, number | undefined> = {};
    for (const [name, v] of Object.entries(snap.assets)) out[name] = v.brotli;
    for (const [name, v] of Object.entries(snap.wire)) out[name] = v.br ?? v.raw;
    return out;
  };
  const baseAssets = merge(base);
  const headAssets = merge(head);
  const self = (v) => v;

  const brotli = (v) => v.brotli;
  parts.push(section("Client assets", diffRows(baseAssets, headAssets, self), baseAssets, headAssets, self));
  parts.push(section("Pages", diffRows(base.pages, head.pages, brotli), base.pages, head.pages, brotli, { floor: PAGE_NOISE_FLOOR }));

  const bg = base.worker.gzipBytes;
  const hg = head.worker.gzipBytes;
  parts.push("### Worker bundle", "");
  if (bg == null || hg == null) {
    parts.push("Bundle gzip unavailable on one side (offline or unauthenticated dry-run); skipping.", "");
  } else if (bg === hg) {
    parts.push(`No change. ${kib(hg)} gzip.`, "");
  } else {
    parts.push(`**${kib(bg)} → ${kib(hg)} gzip (${signed(hg - bg)}, ${pct(bg, hg)})**`, "");
    const mods = diffRows(base.worker.modules, head.worker.modules, (v) => v);
    if (mods.length) parts.push("Largest module deltas (raw bytes in bundle):", "", table(mods, { limit: 10 }), "");
  }

  // Dictionary transport. A page that loses its delta silently falls back to the
  // family tier, which is a real regression nobody would otherwise see: gotcha 20
  // is the record of that exact failure going unnoticed because it errors on
  // nothing. perf-budget hard-fails on a MISSING delta; this reports the drift.
  // The acquisition sits here too: comparing only pd/ is how a smaller q11
  // dictionary stayed invisible while its dependent deltas were fully counted.
  parts.push("### Dictionary transport", "");
  const baseDictionary = base.dcz.dictionaryBrotliBytes ?? 0;
  const headDictionary = head.dcz.dictionaryBrotliBytes ?? 0;
  if (baseDictionary === headDictionary) {
    parts.push(`Family dictionary acquisition: no change, ${kib(headDictionary)} q11.`, "");
  } else {
    parts.push(
      `Family dictionary acquisition: ${kib(baseDictionary)} → ${kib(headDictionary)} q11 (${signed(headDictionary - baseDictionary)}).`,
      "",
    );
  }
  if (base.dcz.count === head.dcz.count && base.dcz.bytes === head.dcz.bytes) {
    parts.push(`\`pd/\`: no change. ${head.dcz.count} deltas, ${kib(head.dcz.bytes)} total.`, "");
  } else {
    parts.push(
      `\`pd/\`: ${base.dcz.count} → ${head.dcz.count} deltas, ${kib(base.dcz.bytes)} → ${kib(head.dcz.bytes)} (${signed(head.dcz.bytes - base.dcz.bytes)}).`,
      "",
    );
    if (head.dcz.count < base.dcz.count) {
      parts.push(`⚠️ Delta COUNT dropped by ${base.dcz.count - head.dcz.count}. A page that loses its delta falls back to the family dictionary silently — check whether that is intended.`, "");
    }
  }

  const md = parts.join("\n");
  if (outPath) await writeFile(outPath, `${md}\n`);
  else console.log(md);
}

async function row(snapshotPath, date) {
  const snap = JSON.parse(await readFile(snapshotPath, "utf8"));
  const sum = (set, pick) => Object.values(set).reduce((n, v) => n + (pick(v) ?? 0), 0);

  const assets: Record<string, number | undefined> = {};
  type Sized = { raw?: number; brotli?: number; br?: number };
  for (const [name, v] of Object.entries(snap.assets) as [string, Sized][]) assets[name] = v.brotli;
  for (const [name, v] of Object.entries(snap.wire) as [string, Sized][]) assets[name] = v.br ?? v.raw;

  const line = {
    ts: date || new Date().toISOString().slice(0, 10),
    sha: snap.label,
    worker_gzip: snap.worker.gzipBytes,
    worker_modules: Object.keys(snap.worker.modules).length,
    assets_br: Object.values(assets).reduce((n, v) => n + v, 0),
    assets,
    pages_br: sum(snap.pages, (v) => v.brotli),
    pages_n: Object.keys(snap.pages).length,
    dcz_n: snap.dcz.count,
    dcz_b: snap.dcz.bytes,
    dict_br: snap.dcz.dictionaryBrotliBytes ?? null,
    source: "nightly",
  };
  console.log(JSON.stringify(line));
}

const [mode, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

if (mode === "record") {
  if (!positional[0]) { console.error("usage: perf-snapshot.mjs record <out.json> [--label <name>]"); process.exit(2); }
  await record(positional[0], flag("--label"));
} else if (mode === "compare") {
  if (positional.length < 2) { console.error("usage: perf-snapshot.mjs compare <base.json> <head.json> [--out <file.md>]"); process.exit(2); }
  await compare(positional[0], positional[1], flag("--out"));
} else if (mode === "row") {
  if (!positional[0]) { console.error("usage: perf-snapshot.mjs row <snapshot.json> [--date YYYY-MM-DD]"); process.exit(2); }
  await row(positional[0], flag("--date"));
} else {
  console.error("usage: perf-snapshot.mjs record <out.json> | compare <base.json> <head.json> | row <snapshot.json>");
  process.exit(2);
}
