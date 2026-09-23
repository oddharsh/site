// The control a person classifier for Serendipity has to beat: attendeeScore's
// seniority regex (ROLE_TIERS), run over the Luma bios it now reads.
//
//   bun run serendipity:roles                        tier spread over every bio
//   bun run serendipity:roles -- --sample 60 > f     a fixed sample to hand-label
//   bun run serendipity:roles -- --labels f.json     precision and recall on it
//
// Reads production D1 through the pinned wrangler and writes nothing. The label
// file maps attendee id to one of LABELS and must live OUTSIDE this repository:
// it pairs real names' ids with a judgment about them, and this repo is public.
//
// Measured 2026-09-23 on 5,116 bios, two 60-bio samples labelled by hand
// (sample positions 0-59, then 60-119 as a HELD-OUT set):
//
//   regex                      matched     sample 0-59      held-out 60-119
//   inherited Next-app tiers   2,177 (43%)  96% P, 55% R     92% P, 55% R
//   + founder phrasing, investor 2,575 (50%)  94% P, 73% R    90% P, 64% R
//
// The second row's rules were written after reading the first sample's misses,
// so its 73% is fitted and the held-out 64% is the number to beat. A Jev role
// classifier has to clear 64% recall at about 90% precision. Of the 15 held-out
// misses 9 are job functions no tier names (growth, BD, sales, GTM), which is
// the gap a model is for; 3 are founder spellings left unfixed so the held-out
// set stays held out ("building @ x", "Building raycast.com").

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { roleTier } from "../serendipity/serendipity.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

export const LABELS = Object.freeze(["founder", "investor", "operator", "engineer", "researcher", "student", "creator", "other", "not_stated"]);

// Which labels count as a tier being RIGHT. The tiers rank seniority rather than
// name a kind of work, so every title tier is right for an operator or an
// engineer. `unmatched` is never right: it is the tier declining.
const TIER_FITS: Record<string, readonly string[]> = {
  founder: ["founder"], investor: ["investor"],
  "c-level": ["operator", "engineer"], president: ["operator"], vp: ["operator", "engineer"],
  director: ["operator", "engineer"], lead: ["operator", "engineer"], senior: ["operator", "engineer"],
  ic: ["engineer", "operator"], junior: ["student"],
};

type Bio = { id: string, bio: string };

/** Precision over what the tiers matched, recall over bios that state a role. */
export function scoreTiers(bios: readonly Bio[], labels: Record<string, string>) {
  let matched = 0, right = 0, stated = 0, found = 0;
  const missed: Record<string, number> = {};
  for (const { id, bio } of bios) {
    const label = labels[id];
    if (!label) continue;
    if (!LABELS.includes(label)) throw new Error(`label for ${id} is "${label}", not one of ${LABELS.join(", ")}`);
    const { tier } = roleTier(bio);
    const isMatch = tier !== "unmatched" && tier !== "none";
    const fits = isMatch && (TIER_FITS[tier] || []).includes(label);
    if (isMatch) { matched++; if (fits) right++; }
    if (label !== "not_stated") {
      stated++;
      if (fits) found++; else missed[label] = (missed[label] || 0) + 1;
    }
  }
  return { labelled: Object.keys(labels).length, matched, right, stated, found, missed };
}

/** FNV-1a over the id, so a sample is the same people on every run and every
 *  machine without storing which people they were. */
function fnv(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
  return x;
}

async function readBios(): Promise<Bio[]> {
  const sql = "SELECT id, bio_short AS bio FROM attendees WHERE bio_short IS NOT NULL AND trim(bio_short) <> ''";
  const { stdout } = await run(...wranglerCommand([
    "d1", "execute", "serendipity", "-c", "wrangler.jsonc", "--remote", "--json", "--command", sql,
  ]), { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout)[0].results;
}

const pct = (n: number, d: number) => (d ? `${(100 * n / d).toFixed(0)}%` : "n/a");

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const labelPath = flag("--labels");
  if (labelPath) {
    const rel = relative(ROOT, resolve(labelPath));
    if (!rel.startsWith("..")) {
      console.error(`serendipity:roles: ${labelPath} is inside the repository. Keep labels outside it; they judge named people.`);
      process.exit(2);
    }
  }
  const bios = await readBios();
  if (!bios.length) { console.error("serendipity:roles: read zero bios, which is a failed read rather than an empty pool"); process.exit(2); }

  const sample = flag("--sample");
  if (sample) {
    const n = Math.max(1, parseInt(sample, 10) || 60);
    const picked = [...bios].sort((a, b) => fnv(a.id) - fnv(b.id)).slice(0, n);
    console.log(JSON.stringify(picked.map((b) => ({ id: b.id, bio: b.bio, tier: roleTier(b.bio).tier, label: null })), null, 1));
    process.exit(0);
  }

  const spread: Record<string, number> = {};
  for (const b of bios) { const t = roleTier(b.bio).tier; spread[t] = (spread[t] || 0) + 1; }
  const hit = bios.length - (spread.unmatched || 0);
  console.log(`bios: ${bios.length}, matched a tier: ${hit} (${pct(hit, bios.length)})`);
  for (const [t, n] of Object.entries(spread).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(10)} ${n}`);

  if (labelPath) {
    const raw = JSON.parse(await readFile(labelPath, "utf8"));
    // Either {id: label} or the --sample array with its `label` fields filled in.
    const labels: Record<string, string> = Array.isArray(raw)
      ? Object.fromEntries(raw.filter((r) => r.label).map((r) => [r.id, r.label]))
      : raw;
    const s = scoreTiers(bios, labels);
    console.log(`\nlabelled: ${s.labelled}`);
    console.log(`precision: ${s.right} of ${s.matched} matched were right (${pct(s.right, s.matched)})`);
    console.log(`recall:    ${s.found} of ${s.stated} stated roles found (${pct(s.found, s.stated)})`);
    console.log(`missed, by label: ${JSON.stringify(s.missed)}`);
  }
}
