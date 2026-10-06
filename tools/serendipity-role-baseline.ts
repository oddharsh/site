// The control a person classifier for Serendipity has to beat: attendeeScore's
// seniority regex (ROLE_TIERS), run over the Luma bios it now reads.
//
//   bun run serendipity:roles                        tier spread over every bio
//   bun run serendipity:roles -- --sample 60 > f     a fixed sample to hand-label
//   bun run serendipity:roles -- --labels f.json     precision and recall on it
//   bun run serendipity:roles -- --labels f.json --clef    Clef on the same labels
//   bun run serendipity:roles -- --clef [--clef-sample 60] label spread, no labels needed
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
// so its 73% is fitted and the held-out 64% is the number to beat. A Clef role
// classifier has to clear 64% recall at about 90% precision. Of the 15 held-out
// misses 9 are job functions no tier names (growth, BD, sales, GTM), which is
// the gap a model is for; 3 are founder spellings left unfixed so the held-out
// set stays held out ("building @ x", "Building raycast.com").
//
// --clef asks Clef (serendipity/roles.ts) the same question over the Workers AI
// REST API and scores it beside the regex at several confidence thresholds,
// because a calibrated probability is the thing a regex cannot offer: the
// question is whether SOME threshold clears 64% recall at about 90% precision.
// The criteria were written without reading any labelled bio, so both samples
// are out of sample for Clef until somebody tunes the criteria against one.
// Tune on 0-59 if you must, and keep 60-119 as the number.
//
// Bios leave this machine for Workers AI under --clef, the same place the
// Worker would send them. The token is CLOUDFLARE_API_TOKEN when set, else
// wrangler's own OAuth login. Without labels it prints counts only, never a bio.
// The bios themselves come from D1 through cf (tools/lib/cf.ts).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { roleTier } from "../serendipity/serendipity.ts";
import { ROLE_LABELS, ROLE_MODEL, buildRoleRequest, parseRoleAnswer, type RolePrediction } from "../serendipity/roles.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { siteConfig } from "./lib/site-config.ts";
import { D1, d1Rows } from "./lib/cf.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

// The classifier's options, so a hand label and a Clef answer are one vocabulary.
// A contract test pins the list, since every label file ever written uses it.
export const LABELS = ROLE_LABELS;
// Label files are JSON somebody typed, so membership is asked of a plain string.
const isLabel = (s: string) => (LABELS as readonly string[]).includes(s);

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
    if (!isLabel(label)) throw new Error(`label for ${id} is "${label}", not one of ${LABELS.join(", ")}`);
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

// The labels some tier can be right about (TIER_FITS' values). The regex can
// never be right on `researcher`, `creator` or `other`, so recall over every
// stated role flatters a classifier that can; this is the like-for-like number.
const TIERABLE = Object.freeze([...new Set(Object.values(TIER_FITS).flat())]);

/** Clef scored the way scoreTiers scores the regex. An answer below `threshold`
 *  or of `not_stated` is an abstention, the classifier's `unmatched`: it claims
 *  nothing, so it costs recall and never precision. A missing prediction (the
 *  call failed) is an abstention too, and is counted so it cannot hide. */
export function scoreClef(bios: readonly Bio[], labels: Record<string, string>, predictions: Record<string, RolePrediction | null>, threshold = 0) {
  let matched = 0, right = 0, stated = 0, found = 0, tierable = 0, tierFound = 0, failed = 0;
  const missed: Record<string, number> = {};
  for (const { id } of bios) {
    const label = labels[id];
    if (!label) continue;
    if (!isLabel(label)) throw new Error(`label for ${id} is "${label}", not one of ${LABELS.join(", ")}`);
    const p = predictions[id];
    if (p === null || p === undefined) failed++;
    const claims = !!p && p.role !== "not_stated" && p.confidence >= threshold;
    const fits = claims && p.role === label;
    if (claims) { matched++; if (fits) right++; }
    if (label !== "not_stated") {
      stated++;
      if (fits) found++; else missed[label] = (missed[label] || 0) + 1;
      if (TIERABLE.includes(label)) { tierable++; if (fits) tierFound++; }
    }
  }
  return { threshold, matched, right, stated, found, tierable, tierFound, failed, missed };
}

/** Confidence at the given quantiles, over the predictions that came back.
 *  Clef's confidence is derived from the spread over every option, so with
 *  nine options a fixed 0.8 is a far higher bar than it reads: on the first
 *  smoke run 5 of 60 answers reached it. Sweeping at the observed quantiles
 *  keeps every row of the table about precision rather than about abstention. */
export function confidenceQuantiles(predictions: Record<string, RolePrediction | null>, qs: readonly number[]) {
  const c = Object.values(predictions).filter((p): p is RolePrediction => !!p).map((p) => p.confidence).sort((a, b) => a - b);
  if (!c.length) return qs.map(() => null);
  return qs.map((q) => c[Math.min(c.length - 1, Math.floor(q * c.length))]);
}

/** scoreTiers' recall restricted to TIERABLE labels, for the same comparison. */
export function tierRecallOnTierable(bios: readonly Bio[], labels: Record<string, string>) {
  let tierable = 0, found = 0;
  for (const { id, bio } of bios) {
    const label = labels[id];
    if (!label || !TIERABLE.includes(label)) continue;
    tierable++;
    if ((TIER_FITS[roleTier(bio).tier] || []).includes(label)) found++;
  }
  return { tierable, found };
}

// ── the Workers AI transport ────────────────────────────────────────────────
async function workersAiAuth(): Promise<{ token: string, account: string }> {
  const account = String((await siteConfig()).account_id);
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, account };
  const { stdout } = await run(...wranglerCommand(["auth", "token", "--json"]), { cwd: ROOT });
  const token = JSON.parse(stdout)?.token;
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN and wrangler auth token returned none; run `bun run wrangler login`");
  return { token, account };
}

/** Every bio through Clef, `width` at a time. A failure is recorded as null
 *  and tallied by cause rather than thrown, so one bad call does not cost the
 *  other 119 and the failures still reach the report. */
async function classifyAll(bios: readonly Bio[], width = 8) {
  const { token, account } = await workersAiAuth();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${ROLE_MODEL}`;
  const out: Record<string, RolePrediction | null> = {};
  const failures: Record<string, number> = {};
  let next = 0;
  const worker = async () => {
    while (next < bios.length) {
      const b = bios[next++];
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(buildRoleRequest(b.bio)),
          signal: AbortSignal.timeout(15_000),
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok || !body?.success) {
          const code = body?.errors?.[0]?.code;
          failures[`http ${res.status}${code ? ` ${code}` : ""}`] = (failures[`http ${res.status}${code ? ` ${code}` : ""}`] || 0) + 1;
          out[b.id] = null;
          continue;
        }
        out[b.id] = parseRoleAnswer(body.result);
        if (!out[b.id]) failures.unparseable = (failures.unparseable || 0) + 1;
      } catch (err) {
        const k = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
        failures[k] = (failures[k] || 0) + 1;
        out[b.id] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, bios.length) }, worker));
  return { predictions: out, failures };
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
  return d1Rows(D1.serendipity, sql);
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

    if (args.includes("--clef")) {
      const labelled = bios.filter((b) => labels[b.id]);
      const absent = Object.keys(labels).length - labelled.length;
      if (absent) console.log(`\n${absent} labelled id(s) are no longer in the pool and are skipped by both scorers`);
      const t = tierRecallOnTierable(bios, labels);
      const { predictions, failures } = await classifyAll(labelled);
      console.log(`\nclef (${ROLE_MODEL}) on the same ${labelled.length}, failures: ${JSON.stringify(failures)}`);
      console.log(`regex recall on tierable labels: ${t.found} of ${t.tierable} (${pct(t.found, t.tierable)})`);
      console.log("threshold  precision          recall (all stated)  recall (tierable)");
      const qs = confidenceQuantiles(predictions, [0.25, 0.5, 0.75]).filter((x): x is number => x !== null);
      console.log(`confidence quartiles: ${qs.map((x) => x.toFixed(2)).join(" / ")}`);
      for (const th of [...new Set([0, ...qs.map((x) => Math.round(x * 100) / 100), 0.5, 0.8])].sort((a, b) => a - b)) {
        const c = scoreClef(bios, labels, predictions, th);
        console.log(`${th.toFixed(2).padEnd(10)} ${`${c.right}/${c.matched} ${pct(c.right, c.matched)}`.padEnd(18)} ${`${c.found}/${c.stated} ${pct(c.found, c.stated)}`.padEnd(20)} ${c.tierFound}/${c.tierable} ${pct(c.tierFound, c.tierable)}`);
      }
      console.log(`missed at 0.0, by label: ${JSON.stringify(scoreClef(bios, labels, predictions, 0).missed)}`);
    }
  } else if (args.includes("--clef")) {
    // No labels: run Clef over the same fixed sample --sample would print and
    // report COUNTS ONLY, the label spread and how it lines up with the tiers.
    // Enough to see that the pipe works and where the two disagree, without a
    // single bio reaching the terminal.
    const n = Math.max(1, parseInt(flag("--clef-sample") || "", 10) || 60);
    const picked = [...bios].sort((a, b) => fnv(a.id) - fnv(b.id)).slice(0, n);
    const { predictions, failures } = await classifyAll(picked);
    console.log(`\nclef (${ROLE_MODEL}) over the first ${picked.length} of the fixed sample, failures: ${JSON.stringify(failures)}`);
    const spread: Record<string, number> = {};
    const cross: Record<string, Record<string, number>> = {};
    const confident = { hi: 0, all: 0 };
    for (const b of picked) {
      const p = predictions[b.id];
      if (!p) continue;
      spread[p.role] = (spread[p.role] || 0) + 1;
      const tier = roleTier(b.bio).tier;
      cross[tier] ??= {};
      cross[tier][p.role] = (cross[tier][p.role] || 0) + 1;
      confident.all++;
      if (p.confidence >= 0.8) confident.hi++;
    }
    console.log(`labels: ${JSON.stringify(spread)}`);
    console.log(`confidence >= 0.8 on ${confident.hi} of ${confident.all}; quartiles ${confidenceQuantiles(predictions, [0.25, 0.5, 0.75]).map((x) => x?.toFixed(2)).join(" / ")}`);
    console.log("regex tier -> clef label:");
    for (const [tier, row] of Object.entries(cross).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${tier.padEnd(10)} ${JSON.stringify(row)}`);
  }
}
