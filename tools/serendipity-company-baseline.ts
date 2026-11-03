// Whether Clairic (serendipity/companies.ts) reads the company out of a Luma
// bio well enough to fill the roster's empty `company` column, scored against a
// regex control on hand labels.
//
//   bun run serendipity:companies -- --labels f.json              regex control only
//   bun run serendipity:companies -- --labels f.json --clairic    Clairic beside it
//   add --misses to print each wrong answer as "label | predicted"
//
// The sample is serendipity:roles' fixed sample (`--sample 120`), so the two
// classifiers are measured on the same people. The label file maps attendee
// id to the organization the person leads with, as written; an array where two
// spellings are both fair ("Kelp Dao" or "Kelp Dao and Kernel Dao"); null when
// the bio names none, or names only past ones. It must live OUTSIDE this
// repository, for the reason the role tool gives: it judges named people.
//
// Measured 2026-10-30 on serendipity:roles' 120-bio sample, positions 0-59 to
// tune both the regex and the instructions, 60-119 HELD OUT and run once:
//
//                          tune 0-59           held-out 60-119
//   regex control          94% P, 76% R        78% P, 61% R
//   clairic p_null <= 0.1  93% P, 90% R        90% P, 85% R
//   clairic p_null <= 0.3  90% P, 90% R        86% P, 90% R
//
// 41 of the held-out 60 name an organization, so each point of recall is one
// bio and the gap is wider than the noise. Clairic's held-out wrong answers
// were mostly a description read as a name ("Global Event Management
// company", "Crypto Hedge fund"), which a stricter threshold trims; the
// regex's were names it never reached (a bare "Droyd", "Deepmind Research
// Scientist"). About 290 input tokens a bio, nearly all of them the field
// schema, so the 5,116 bios cost about 1.5M tokens ($0.15) once, at a median
// 313 ms a call.
//
// Bios leave this machine for Workers AI under --clairic, the same place the
// Worker would send them. Reads production D1 and writes nothing. The token
// is CLOUDFLARE_API_TOKEN when set, else wrangler's own OAuth login.

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANY_MODEL, buildCompanyRequest, companyAt, parseCompanyAnswer, type CompanyPrediction } from "../serendipity/companies.ts";
import { asRecord, asText } from "../src/worker/lib/parse.ts";
import { readBios, workersAiAuth, type Bio } from "./serendipity-role-baseline.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every fair spelling of the organization, or null when the bio names none. */
export type CompanyLabel = readonly string[] | null;

/** A label file entry as typed by hand: one name, several, or null. */
export function parseCompanyLabel(raw: unknown): CompanyLabel {
  if (raw === null) return null;
  const names = (Array.isArray(raw) ? raw : [raw]).map((n) => asText(n));
  if (!names.length || names.some((n) => n === null)) throw new Error(`a company label is a name, a list of names, or null; got ${JSON.stringify(raw)}`);
  return names as string[];
}

/** Case, a leading @ or $, and trailing punctuation are not a different
 *  company; anything else is. */
export const normCompany = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s@$]+/, "")
    .replace(/[\s.,;:|·!-]+$/, "");

export function companyMatches(label: CompanyLabel, predicted: string | null): boolean {
  if (label === null || predicted === null) return false;
  const p = normCompany(predicted);
  return label.some((l) => normCompany(l) === p);
}

// The control: the organization after a bio that opens "Building", else after
// "@", else "at", else "of" or "for", in that order because "Head of X at Y"
// names a title after "of" and the company after "at". Capitalised words after
// it join the name on the same line, so "Maven 11" and "Mother Tongue Media"
// stay whole. Tuned on sample positions 0-59 like Clairic was, so the two meet
// on the held-out half as equals. A model that cannot beat this has not earned
// a binding call.
const NAME = String.raw`([A-Za-z0-9$][\w.$&'-]*(?:[ \t]+[A-Z0-9][\w.&'-]*)*)`;
const MARKERS = [
  new RegExp(String.raw`^\s*[Bb]uilding[ \t]+@?[ \t]*` + NAME),
  new RegExp(String.raw`@[ \t]*` + NAME),
  new RegExp(String.raw`\bat[ \t]+` + NAME),
  new RegExp(String.raw`\b(?:of|for)[ \t]+` + NAME),
];
export function companyByRegex(bio: string): string | null {
  for (const re of MARKERS) {
    const m = re.exec(bio);
    if (m) return m[1].replace(/[.,;:]+$/, "");
  }
  return null;
}

/** Precision over the answers given, recall over the bios that name one. */
export function scoreCompanies(ids: readonly string[], labels: Record<string, CompanyLabel>, predict: (id: string) => string | null) {
  let claimed = 0,
    right = 0,
    named = 0,
    found = 0;
  for (const id of ids) {
    if (!(id in labels)) continue;
    const label = labels[id];
    const p = predict(id);
    const ok = companyMatches(label, p);
    if (p !== null) {
      claimed++;
      if (ok) right++;
    }
    if (label !== null) {
      named++;
      if (ok) found++;
    }
  }
  return { claimed, right, named, found };
}

/** Every bio through Clairic, `width` at a time, failures tallied by cause. */
async function extractAll(bios: readonly Bio[], width = 8) {
  const { token, account } = await workersAiAuth();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${COMPANY_MODEL}`;
  const out: Record<string, CompanyPrediction | null> = {};
  const failures: Record<string, number> = {};
  const ms: number[] = [];
  let tokens = 0;
  let next = 0;
  const worker = async () => {
    while (next < bios.length) {
      const b = bios[next++];
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(buildCompanyRequest(b.bio)),
          signal: AbortSignal.timeout(15_000),
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok || !body?.success) {
          const k = `http ${res.status}${body?.errors?.[0]?.code ? ` ${body.errors[0].code}` : ""}`;
          failures[k] = (failures[k] || 0) + 1;
          out[b.id] = null;
          continue;
        }
        ms.push(performance.now() - t0);
        tokens += Number(body.result?.usage?.input_tokens) || 0;
        out[b.id] = parseCompanyAnswer(body.result);
        if (!out[b.id]) failures.unparseable = (failures.unparseable || 0) + 1;
      } catch (err) {
        const k = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
        failures[k] = (failures[k] || 0) + 1;
        out[b.id] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, bios.length) }, worker));
  ms.sort((a, b) => a - b);
  return { predictions: out, failures, tokens, medianMs: ms.length ? Math.round(ms[Math.floor(ms.length / 2)]) : null };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const row = (name: string, s: ReturnType<typeof scoreCompanies>) =>
  `${name.padEnd(16)} ${`${s.right}/${s.claimed} ${pct(s.right, s.claimed)}`.padEnd(14)} ${s.found}/${s.named} ${pct(s.found, s.named)}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--labels");
  const labelPath = i >= 0 ? args[i + 1] : undefined;
  if (!labelPath) {
    console.error("serendipity:companies: pass --labels <file>; there is nothing to score without one");
    process.exit(2);
  }
  if (!relative(ROOT, resolve(labelPath)).startsWith("..")) {
    console.error(`serendipity:companies: ${labelPath} is inside the repository. Keep labels outside it; they judge named people.`);
    process.exit(2);
  }
  const raw = asRecord(JSON.parse(await readFile(labelPath, "utf8")));
  if (!raw) throw new Error(`${labelPath} is not an object of attendee id to label`);
  const labels = Object.fromEntries(Object.entries(raw).map(([id, l]) => [id, parseCompanyLabel(l)]));
  const bios = (await readBios()).filter((b) => b.id in labels);
  const absent = Object.keys(labels).length - bios.length;
  if (!bios.length) {
    console.error("serendipity:companies: none of the labelled ids are in the pool, which is a failed read rather than an empty sample");
    process.exit(2);
  }
  if (absent) console.log(`${absent} labelled id(s) are no longer in the pool and are skipped`);
  const ids = bios.map((b) => b.id);
  const bioOf = Object.fromEntries(bios.map((b) => [b.id, b.bio]));
  const misses = (predict: (id: string) => string | null) => {
    if (!args.includes("--misses")) return;
    for (const id of ids) {
      const p = predict(id);
      if (p === null && labels[id] === null) continue;
      if (!companyMatches(labels[id], p)) console.log(`  ${JSON.stringify(labels[id])} | ${JSON.stringify(p)}`);
    }
  };

  console.log(`labelled: ${ids.length}, naming an organization: ${ids.filter((id) => labels[id] !== null).length}`);
  console.log("                 precision      recall");
  console.log(
    row(
      "regex",
      scoreCompanies(ids, labels, (id) => companyByRegex(bioOf[id])),
    ),
  );
  misses((id) => companyByRegex(bioOf[id]));

  if (args.includes("--clairic")) {
    const { predictions, failures, tokens, medianMs } = await extractAll(bios);
    console.log(`\nclairic: ${tokens} input tokens (${(tokens / ids.length).toFixed(0)} a bio), median ${medianMs} ms, failures ${JSON.stringify(failures)}`);
    for (const th of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const s = scoreCompanies(ids, labels, (id) => (predictions[id] ? companyAt(predictions[id], th) : null));
      console.log(row(`p_null <= ${th}`, s));
    }
    misses((id) => (predictions[id] ? companyAt(predictions[id], 0.5) : null));
  }
}
