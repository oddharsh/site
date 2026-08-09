#!/usr/bin/env node
// perf-snapshot.mjs — record the built tree's wire sizes, and diff two recordings.
//
// This is the DIFFERENTIAL half of the performance story. perf-budget.mjs asks
// "is this number over a line somebody drew?"; this asks "did this change move
// it, and by how much?" The two answer different questions and neither replaces
// the other, but the diff is the one that cannot go stale.
//
// The reason it exists is written into perf-budget.mjs's own baseline history:
// WORKER_BASELINE_GZIP_KIB sat at 129.23 while the real number was 204.24, so
// the advisory fired on EVERY run for months and CI printed "hard checks green"
// over it. A hand-maintained constant rots by construction — it records the
// world on the day somebody typed it, and nothing makes them retype it. A diff
// against the merge base has no constant to rot. It also cannot be silenced by
// re-baselining, because there is nothing to re-baseline.
//
// Borrowed wholesale from how astral-sh/ruff runs its memory and ecosystem
// jobs: build the merge base, build HEAD, run both, post the difference as a
// comment, and fail on nothing. A perf number that fails a PR teaches people to
// widen the threshold. A perf number in a comment gets read.
//
//   node scripts/perf-snapshot.mjs record <out.json> [--label <name>]
//   node scripts/perf-snapshot.mjs compare <base.json> <head.json> [--out <file.md>]
//   node scripts/perf-snapshot.mjs row <snapshot.json> [--date YYYY-MM-DD]
//
// `row` is the TREND half, and it exists because a per-PR diff catches the STEP
// while only a series catches the DRIFT. This repo's worker bundle went 86 ->
// 129.23 -> 204.24 -> 258.34 -> 261.74 KiB gzip, and every one of those numbers
// was found by somebody tripping over a stale constant rather than by anyone
// watching the slope. It emits ONE compact JSONL line, which
// .github/workflows/perf-history.yml appends nightly to the machine-owned
// `perf-history` branch and /garage/dyno renders.
//
// It deliberately drops the per-module and per-page detail the diff carries. A
// trend is read at the shape level, the detail is what the PR comment already
// answered on the day it mattered, and commonwarexyz/benchmarks is 89 MB of
// exactly the retention problem worth not having.
//
// `record` runs `wrangler deploy --dry-run`, which self-builds `.build/holding`
// through wrangler.jsonc's build.command, so it needs no prior `npm run build`.
//
// Everything measured here is DETERMINISTIC: identical source bytes produce an
// identical snapshot, so an unchanged asset contributes no row. Sampled numbers
// (`wrangler check startup`, which wandered 9.6/7.6/6.4 ms across three
// identical runs) are deliberately NOT recorded — a diff of two noise draws is
// worse than no diff, because it looks like a finding.

import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const BUILD = ".build/holding";
const DRYRUN_OUT = ".build/.perfsnap";

const SCHEMA = 1;

// Brotli q11 because that is what the edge serves. Matching the shipped quality
// matters more than the ~10s it costs over 50-odd files: a diff computed at a
// different quality would report movement the wire never sees.
const sizes = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});

// `/a/<name>.<hash8>.<ext>` is content-addressed, so its FILENAME changes
// whenever its bytes do. Keying the snapshot on the raw name would make every
// asset read as "removed, and a different one added" on any change at all, which
// is the one thing a diff must not do. Key on the logical name instead.
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
  // One dry-run gives three things at once: the built tree (via build.command),
  // the bundle's gzip total, and per-module attribution from esbuild's metafile.
  // perf-budget.mjs runs the same command; they are separate processes because
  // one gates the deploy and the other reports on it, and coupling them would
  // mean a snapshot failure could redden a PR.
  let dryOut = "";
  try {
    dryOut = execFileSync("npx", [
      "wrangler", "deploy", "--dry-run",
      "--outdir", DRYRUN_OUT,
      "--metafile",
    ], { encoding: "utf8" });
  } catch (e) {
    dryOut = `${e.stdout || ""}\n${e.stderr || ""}`;
  }

  const snapshot = {
    schema: SCHEMA,
    label: label || git("rev-parse", "--short", "HEAD") || "unknown",
    subject: git("log", "-1", "--format=%s"),
    worker: { gzipBytes: null, modules: {} },
    assets: {},
    pages: {},
    wire: {},
    dcz: { count: 0, bytes: 0 },
  };

  const gz = dryOut.match(/gzip:\s*([\d.]+)\s*KiB/);
  if (gz) snapshot.worker.gzipBytes = Math.round(parseFloat(gz[1]) * 1024);
  else console.error("perf-snapshot: could not read bundle gzip from the dry-run (offline/unauth?)");

  // Per-module bytes. This is the deterministic answer to "what grew", which the
  // gzip total alone can only pose as a question.
  try {
    const meta = JSON.parse(await readFile(`${DRYRUN_OUT}/bundle-meta.json`, "utf8"));
    const entry = Object.entries(meta.outputs).find(([n]) => n.endsWith(".js") && !n.endsWith(".map"));
    for (const [name, v] of Object.entries(entry?.[1]?.inputs ?? {})) {
      snapshot.worker.modules[name] = v.bytesInOutput ?? 0;
    }
  } catch (e) {
    console.error(`perf-snapshot: no bundle metafile (${e.message}); skipping module attribution`);
  }

  // Client assets: the top-level shipped .js/.css, minus the readable .src twins
  // (a twin is a View Source affordance, never a byte a visitor's browser pays
  // for on the critical path).
  for (const name of await walk(BUILD, (f) => /^[^/]+\.(js|css)$/.test(f) && !/\.src\.(js|css)$/.test(f))) {
    snapshot.assets[name] = sizes(await readFile(`${BUILD}/${name}`));
  }

  for (const name of await walk(BUILD, (f) => f.endsWith(".html") && !f.endsWith(".src.html"))) {
    snapshot.pages[name] = sizes(await readFile(`${BUILD}/${name}`));
  }

  // The /a/ tier is the one place the build emits the exact wire bytes itself
  // (precompressed q11, served with encodeBody: "manual"). Read the emitted .br
  // rather than recompressing: this is what actually goes over the wire.
  for (const name of await walk(`${BUILD}/a`, (f) => !f.endsWith(".br") && !f.endsWith(".dict"))) {
    let br = null;
    try { br = (await readFile(`${BUILD}/a/${name}.br`)).length; } catch {}
    snapshot.wire[dehash(name)] = { raw: (await readFile(`${BUILD}/a/${name}`)).length, br };
  }

  // Dictionary deltas are a count and a total, not a per-file table. Each name
  // carries the hash of the dictionary it was built against, so individual
  // entries roll over constantly and mean nothing; what a reviewer wants to know
  // is whether COVERAGE dropped.
  for (const name of await walk(`${BUILD}/pd`, (f) => f.endsWith(".dcz"))) {
    snapshot.dcz.count += 1;
    snapshot.dcz.bytes += (await readFile(`${BUILD}/pd/${name}`)).length;
  }

  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const n = Object.keys(snapshot.assets).length + Object.keys(snapshot.pages).length;
  console.log(`perf-snapshot: recorded ${snapshot.label} — ${n} files, ${Object.keys(snapshot.worker.modules).length} modules -> ${outPath}`);
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

const kib = (b) => `${(b / 1024).toFixed(2)} KiB`;
const signed = (b) => `${b > 0 ? "+" : ""}${(b / 1024).toFixed(2)} KiB`;
const pct = (base, head) => (base === 0 ? "n/a" : `${head > base ? "+" : ""}${(((head - base) / base) * 100).toFixed(1)}%`);

// The one real noise source in an otherwise deterministic measurement, and it is
// STRUCTURAL rather than random: every page references `/a/<name>.<hash8>.<ext>`,
// so touching one shared asset flips its hash and moves the compressed size of
// every page that names it by a byte or two. Measured on a one-line nav.js edit:
// 38 of 46 pages "changed", none of them by more than 41 bytes, net -0.03 KiB.
//
// That is 38 rows of nothing in front of the one row that matters, which is how a
// report teaches people to stop reading it. Sub-floor movers are still counted in
// every total and still reported as an aggregate line — collapsed, never dropped.
//
// It applies to PAGES only, and the asymmetry is the point. An asset's bytes are
// its own content, so nothing but editing it can move them and every byte of
// movement is signal; a page's bytes carry references to other files' hashes, so
// they move for reasons that have nothing to do with the page. Applying one floor
// everywhere would have hidden the very edit that produced the noise, since the
// nav.js change measured 50 bytes against churn of 41.
const PAGE_NOISE_FLOOR = 128;

// A row is worth printing only when the bytes moved. Everything measured here is
// deterministic, so "moved by 0" means the file is byte-identical and a reviewer
// learns nothing from seeing it.
function diffRows(base, head, pick) {
  const names = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  const rows = [];
  for (const name of names) {
    // `in`, not truthiness. A zero-byte entry is a legitimate measurement (an
    // asset can compress to nothing interesting, and a module can contribute 0
    // bytes to the bundle), and treating it as absent would report it as new or
    // removed — the two labels a reviewer is most likely to act on.
    const b = name in base ? pick(base[name]) : null;
    const h = name in head ? pick(head[name]) : null;
    if (b === h) continue;
    rows.push({ name, base: b, head: h, delta: (h ?? 0) - (b ?? 0) });
  }
  return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

const total = (set, pick) => Object.values(set).reduce((n, v) => n + (pick(v) ?? 0), 0);

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

  // A new or removed file is always listed, however small: its delta is the
  // whole file, and "a page appeared" is never noise.
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

  // `assets` and `wire` are two views of mostly the same files: the top-level
  // short-cached copy and the content-addressed `/a/` copy the shell actually
  // loads. Reporting both gave two near-identical tables with the same numbers in
  // them. Merge on the logical name, preferring the `/a/` `.br` the build emitted,
  // because that is the byte count that leaves the edge.
  const merge = (snap) => {
    const out = {};
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

  // Worker bundle. Gzip because that is the unit wrangler reports and the unit
  // perf-budget's advisory is denominated in; switching units between the two
  // checks would make them impossible to read together.
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

  // Dictionary coverage. A page that loses its delta silently falls back to the
  // family tier, which is a real regression nobody would otherwise see: gotcha 20
  // is the record of that exact failure going unnoticed because it errors on
  // nothing. perf-budget hard-fails on a MISSING delta; this reports the drift.
  parts.push("### Dictionary deltas (`pd/`)", "");
  if (base.dcz.count === head.dcz.count && base.dcz.bytes === head.dcz.bytes) {
    parts.push(`No change. ${head.dcz.count} deltas, ${kib(head.dcz.bytes)} total.`, "");
  } else {
    parts.push(
      `${base.dcz.count} → ${head.dcz.count} deltas, ${kib(base.dcz.bytes)} → ${kib(head.dcz.bytes)} (${signed(head.dcz.bytes - base.dcz.bytes)}).`,
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

// ---------------------------------------------------------------------------
// row — reduce a snapshot to one JSONL line for the trend series
// ---------------------------------------------------------------------------

// Keys are short because this file is appended to forever and read by a Worker
// that bundles nothing to parse it. One row is ~400 bytes, so a year of dailies
// is ~146 KB — small enough to fetch whole, which is what lets /perf render the
// entire history server-side with no pagination and no client JS.
//
// `source` separates a machine-recorded row from a hand-entered historical one.
// /perf draws them differently and says so, because a number somebody typed into
// a code comment in 2026-06 and a number a runner measured last night are not
// the same kind of fact, and a chart that renders them identically is quietly
// lying about which parts of its own history it can stand behind.
async function row(snapshotPath, date) {
  const snap = JSON.parse(await readFile(snapshotPath, "utf8"));
  const sum = (set, pick) => Object.values(set).reduce((n, v) => n + (pick(v) ?? 0), 0);

  // Same merge the diff uses: prefer the `/a/` precompressed bytes, which are
  // what actually leaves the edge, and fall back to the computed brotli.
  const assets = {};
  for (const [name, v] of Object.entries(snap.assets)) assets[name] = v.brotli;
  for (const [name, v] of Object.entries(snap.wire)) assets[name] = v.br ?? v.raw;

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
    source: "nightly",
  };
  console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------------------

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
