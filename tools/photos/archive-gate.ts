#!/usr/bin/env bun
// archive-gate.ts — where does Chrome first paint each full-size archive?
//
//   bun run archive:gate                          # every archive in the photo index, from production
//   bun run archive:gate -- --stems XT508165,XT508887
//   bun run archive:gate -- --origin http://localhost:8799 --max 5
//   bun run archive:gate -- --json                # one JSON row per archive on stdout, no summary
//   bun run archive:gate -- --bust                # read R2 past both caches, before a purge (see below)
//
// /images/full/<stem>.jpg is a ~20 MB progressive JPEG and the one image surface
// here with no AVIF tier, so its scan order decides how long a visitor stares at
// nothing. Chromium paints only once every channel has begun a scan
// (tools/lib/jpeg-paint-gate.ts has the rule). On 2026-09-27 this sweep found 53
// of 256 colour archives that sent all of luma before any chroma and stayed blank
// until 66-99% of the download; `jpegtran -progressive` rewrote those and every
// other archive zenc or the camera made (208 in all) losslessly, and add-photos.sh
// now runs that pass on every HIF. Committed so the next
// encoder change can be checked the same way rather than by memory.
//
// --bust adds a unique query string. With the Range header that reaches R2 even
// while the CDN and the Worker's caches.default still hold the old bytes, since
// photos.ts sends Range requests straight to R2 and the CDN keys on the query:
// it is how an in-place overwrite is checked before the purge.
//
// It reads a PREFIX of each archive with a Range request and stops parsing at the
// gate, so a full sweep moves ~40 MB rather than ~5 GB. A gate past the prefix
// is reported as a finding, never as a number.
//
// Exit 0 when every archive paints within --max percent (default 10), 1 on a
// finding, 2 when the instrument could not read an archive at all. Read-only and
// advisory: it measures production, so it belongs beside dcz:check, never in CI.
import { readFileSync } from "node:fs";
import { gateClass, paintGate, type PaintGate } from "../lib/jpeg-paint-gate.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const origin = (flag("--origin") ?? "https://aadhar.sh").replace(/\/$/, "");
const maxPct = Number(flag("--max") ?? 10);
const prefix = Number(flag("--prefix-mb") ?? 3) * 1024 * 1024;
const index = JSON.parse(readFileSync(new URL("../../src/worker/photo-index.json", import.meta.url), "utf8")) as Record<string, { full: string; size?: number }>;
const only = flag("--stems")?.split(",");
const stems = only ?? Object.keys(index).sort();
for (const s of stems) if (!index[s]) { console.error(`archive-gate: ${s} is not in the photo index`); process.exit(2); }

type Row = PaintGate & { stem: string; size: number; pct: number | null; kind: string; error?: string };
const rows: Row[] = [];
async function one(stem: string) {
  const bust = args.includes("--bust") ? `?cb=${crypto.randomUUID()}` : "";
  const url = `${origin}/images/full/${encodeURIComponent(index[stem].full)}${bust}`;
  try {
    const r = await fetch(url, { headers: { range: `bytes=0-${prefix - 1}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    // The real length comes from Content-Range, since the index can trail an
    // in-place rewrite by one deploy.
    const total = Number(r.headers.get("content-range")?.split("/")[1] ?? r.headers.get("content-length"));
    const g = paintGate(new Uint8Array(await r.arrayBuffer()));
    rows.push({ stem, size: total, ...g, kind: gateClass(g), pct: g.gate === null ? null : (100 * g.gate) / total });
  } catch (e) {
    rows.push({ stem, size: 0, sof: null, components: 0, gate: null, scans: [], kind: "unread", pct: null, error: String(e) });
  }
}
const queue = [...stems];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await one(queue.shift()!); }));
rows.sort((a, b) => a.stem.localeCompare(b.stem));

if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(rows.some((r) => r.kind === "unread") ? 2 : 0); }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
console.log(`archive-gate: ${rows.length} archives from ${origin}, prefix ${prefix / 1048576} MB`);
for (const kind of [...new Set(rows.map((r) => r.kind))].sort()) {
  const group = rows.filter((r) => r.kind === kind);
  const pcts = group.map((r) => r.pct).filter((p): p is number => p !== null);
  const spread = kind === "baseline" ? "one scan, top rows first" : pcts.length ? `first paint median ${median(pcts).toFixed(3)}%, max ${Math.max(...pcts).toFixed(3)}%` : "no first paint read";
  console.log(`  ${String(group.length).padStart(4)}  ${kind.padEnd(36)} ${spread}`);
}
const unread = rows.filter((r) => r.kind === "unread");
const late = rows.filter((r) => r.kind !== "unread" && r.kind !== "baseline" && (r.pct === null || r.pct > maxPct));
const baseline = rows.filter((r) => r.kind === "baseline");
for (const r of unread) console.log(`  unread   ${r.stem}: ${r.error}`);
for (const r of late) console.log(`  late     ${r.stem}: ${r.pct === null ? `no paint within ${prefix / 1048576} MB` : `${r.pct.toFixed(2)}%`} of ${(r.size / 1e6).toFixed(1)} MB, scans ${r.scans.join(" ")}`);
for (const r of baseline) console.log(`  baseline ${r.stem}: one scan, paints top rows down`);
if (unread.length) process.exit(2);
if (late.length || baseline.length) { console.log(`FAIL: ${late.length} late, ${baseline.length} baseline`); process.exit(1); }
console.log(`PASS: every archive paints within ${maxPct}%`);
