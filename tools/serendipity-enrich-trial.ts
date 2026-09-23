// Can free web search tell us what people in the Serendipity pool DO?
//
//   TINYFISH_API_KEY=... bun run serendipity:enrich-trial > <outside the repo>/trial.json
//   bun run serendipity:enrich-trial -- --dry        the cohort and its queries, no calls
//
// TinyFish's Search API has cost nothing since 2026-05-04 (30 a minute, 500 an
// hour), so price is not the question. IDENTITY is: a search for a name returns
// whoever ranks for it, and a wrong role on a public roster is worse than none.
// So each person gets ONE query built from their strongest anchor (X handle,
// then LinkedIn, then words from their own bio, then their website), and a
// result counts as them only when it is their own profile URL, or when it
// carries their name AND one of their anchors. Role then comes from the same
// roleTier regex the roster sorts by, read over the accepted snippets, so the
// trial measures the search and not a new classifier.
//
// Cohort, 100 by default, drawn by FNV over the id so a re-run asks about the
// same people. Counts from production on 2026-09-23:
//   handle   50  an X handle and no bio (8,151 people): the population search is FOR
//   bio      25  a Luma bio (5,116): a free accuracy check, since the bio has a tier
//   profile  25  only LinkedIn or a website (2,616)
// Bare names (3,850) are left out: nothing to confirm a match against.
//
// Reads production D1, writes nothing. The per-person records go to STDOUT and
// name real people, so redirect them outside this repository; the summary goes
// to stderr.

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { roleTier } from "../serendipity/serendipity.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = "https://api.search.tinyfish.ai";
const PACE_MS = 2100; // 30 a minute, with room
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PURPOSE = "Find this specific person's public profile to learn their current job title and employer.";

export type Person = {
  id: string, name: string, bio?: string | null,
  twitter_handle?: string | null, linkedin_handle?: string | null, website?: string | null,
};
export type Result = { position?: number, title?: string, snippet?: string, url?: string };

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const clean = (s: string | null | undefined) => (s || "").trim();
// X's own paths. 28 stored handles are one of these (people paste a URL from
// their timeline: "home", "i"), and x.com/home would then pass as a profile URL
// and hand the check a page that belongs to nobody. Measured 2026-09-23; every
// other stored handle already fits X's [A-Za-z0-9_]{1,15}.
const X_RESERVED = new Set(["home", "i", "intent", "search", "explore", "share", "hashtag", "messages", "notifications", "settings", "login", "x", "twitter"]);
export function handleOf(p: Person): string {
  const h = clean(p.twitter_handle).replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(h) && !X_RESERVED.has(h.toLowerCase()) ? h : "";
}
const linkedinOf = (p: Person) => clean(p.linkedin_handle).replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/+$/, "");
export function hostOf(url: string | null | undefined): string {
  const u = clean(url);
  if (!u) return "";
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

// Words in a bio that name WHERE someone works rather than what they are: the
// "EasyA" in "Co-Founder of EasyA". Role words and the person's own name are
// dropped, because a result carrying "Founder" proves nothing about identity.
const NOT_ANCHORS = new Set(("founder cofounder co-founder ceo cto coo cfo cpo cmo chief head lead manager director senior staff principal engineer " +
  "developer designer analyst investor investing partner building builder working prev previously former current currently based about " +
  "the and for with from into this that love community events web3 crypto startup startups").split(" "));
export function bioAnchors(p: Person): string[] {
  const own = new Set(norm(p.name).split(/[^a-z0-9]+/).filter(Boolean));
  const out: string[] = [];
  for (const m of clean(p.bio).matchAll(/@([A-Za-z0-9_.-]{3,})|\b([A-Za-z0-9-]+\.(?:ai|io|xyz|com|co|so|fi|dev|app|org|net|gg|tech|studio))\b|\b([A-Z][A-Za-z0-9]{2,})\b/g)) {
    const tok = (m[1] || m[2] || m[3]).replace(/[.]+$/, "");
    const k = norm(tok);
    if (NOT_ANCHORS.has(k) || own.has(k) || out.some((o) => norm(o) === k)) continue;
    out.push(tok);
  }
  return out.slice(0, 4);
}

export type Plan = { stratum: "handle" | "bio" | "profile" | "bare", query: string, include_domains?: string, anchor: string };

/** One query per person, on the strongest anchor they have. */
export function planQuery(p: Person): Plan {
  const name = `"${clean(p.name)}"`;
  const h = handleOf(p), li = linkedinOf(p), host = hostOf(p.website), anchors = bioAnchors(p);
  const stratum = clean(p.bio) ? "bio" : h ? "handle" : (li || host) ? "profile" : "bare";
  if (h) return { stratum, query: `${name} ${h}`, anchor: "handle" };
  if (li) return { stratum, query: `${name} linkedin`, include_domains: "linkedin.com", anchor: "linkedin" };
  if (anchors.length) return { stratum, query: `${name} ${anchors.slice(0, 2).join(" ")}`, anchor: "bio" };
  if (host) return { stratum, query: `${name} ${host}`, anchor: "website" };
  return { stratum, query: `${name} ${clean(p.bio).split(/\s+/).slice(0, 6).join(" ")}`.trim(), anchor: "name" };
}

function nameIn(p: Person, text: string): boolean {
  const parts = norm(p.name).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!parts.length) return false;
  const t = norm(text);
  // First and last name, as whole words. Middle names and initials are too
  // often dropped by a profile to require.
  return [parts[0], parts[parts.length - 1]].every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}

/** Is this result about THIS person, and on what evidence? A profile URL is
 *  proof alone. Anything else needs the name and an anchor in the same result. */
export function corroborate(p: Person, r: Result): string[] {
  const url = clean(r.url).toLowerCase(), text = `${r.title || ""} ${r.snippet || ""}`;
  const h = handleOf(p).toLowerCase(), li = linkedinOf(p).toLowerCase(), host = hostOf(p.website);
  const ev: string[] = [];
  if (h && new RegExp(`^https?://(www\\.|mobile\\.)?(x|twitter)\\.com/${h.replace(/[.]/g, "\\.")}(/|\\?|$)`).test(url)) ev.push("handle-url");
  if (li && url.includes(`linkedin.com/in/${li}`)) ev.push("linkedin-url");
  if (host && hostOf(url) === host) ev.push("website-url");
  if (ev.length) return ev;
  if (!nameIn(p, text)) return [];
  const t = norm(text + " " + url);
  if (h && h.length >= 4 && new RegExp(`@?\\b${h.replace(/[.]/g, "\\.")}\\b`).test(t)) ev.push("handle");
  if (host && t.includes(host)) ev.push("website");
  for (const a of bioAnchors(p)) if (new RegExp(`\\b${norm(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) { ev.push(`bio:${a}`); break; }
  return ev;
}

/** "Jane Doe - Founder - Acme | LinkedIn", the shape a public profile's search
 *  title takes. The headline alone when there is no company segment. */
export function linkedinTitle(title: string | null | undefined): { headline: string, company: string | null } | null {
  const m = clean(title).match(/^.+?\s+[-–]\s+(.+?)(?:\s+[-–]\s+(.+?))?\s*\|\s*LinkedIn\b/i);
  return m ? { headline: m[1].trim(), company: m[2]?.trim() || null } : null;
}

export function assess(p: Person, results: readonly Result[]) {
  const accepted = results.map((r) => ({ r, ev: corroborate(p, r) })).filter((x) => x.ev.length);
  // The first accepted result that names a tier, in the engine's order. The
  // person's own name is removed first so a surname like "Lead" is not a title.
  const own = new RegExp(`\\b(${norm(p.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 2).join("|") || "\\u0000"})\\b`, "gi");
  let searchTier = "none";
  for (const { r } of accepted) {
    const t = roleTier(`${r.title || ""} ${r.snippet || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(own, " ")).tier;
    if (t !== "unmatched" && t !== "none") { searchTier = t; break; }
  }
  if (searchTier === "none" && accepted.length) searchTier = "unmatched";
  const li = accepted.map(({ r }) => /linkedin\.com\/in\//i.test(clean(r.url)) ? linkedinTitle(r.title) : null).find(Boolean) || null;
  return {
    matched: accepted.length > 0,
    evidence: [...new Set(accepted.flatMap((x) => x.ev.map((e) => e.replace(/:.*/, ""))))],
    bioTier: roleTier(p.bio).tier,
    searchTier,
    linkedin: li,
    accepted: accepted.map(({ r, ev }) => ({ url: r.url, title: r.title, snippet: clean(r.snippet).slice(0, 240), ev })),
  };
}

const TIERED = (t: string) => t !== "unmatched" && t !== "none";

/** The numbers the trial exists for, per stratum. `gain` is the point: a tier
 *  the roster did not have before. `agree` only means anything in the bio
 *  stratum, where the bio already named one. */
export function summarize(rows: readonly { stratum: string, error?: string, matched?: boolean, bioTier?: string, searchTier?: string, linkedin?: any }[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const s = (out[r.stratum] ||= { people: 0, failed: 0, matched: 0, tiered: 0, gain: 0, agree: 0, disagree: 0, company: 0 });
    s.people++;
    if (r.error) { s.failed++; continue; }
    if (!r.matched) continue;
    s.matched++;
    if (r.linkedin?.company) s.company++;
    if (!TIERED(r.searchTier || "none")) continue;
    s.tiered++;
    if (!TIERED(r.bioTier || "none")) s.gain++;
    else if (r.bioTier === r.searchTier) s.agree++;
    else s.disagree++;
  }
  return out;
}

function fnv(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
  return x;
}

export function pickCohort(people: readonly Person[], n: number): Person[] {
  const quota: Record<string, number> = { handle: Math.round(n / 2), bio: Math.round(n / 4) };
  quota.profile = n - quota.handle - quota.bio;
  const out: Person[] = [];
  for (const p of [...people].sort((a, b) => fnv(a.id) - fnv(b.id))) {
    const s = planQuery(p).stratum;
    if ((quota[s] || 0) > 0) { quota[s]--; out.push(p); }
  }
  return out;
}

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>;

export async function search(plan: Plan, key: string, fetchImpl: Fetch = fetch): Promise<{ results: Result[] } | { error: string }> {
  const q = new URLSearchParams({ query: plan.query, purpose: PURPOSE, location: "US", language: "en" });
  if (plan.include_domains) q.set("include_domains", plan.include_domains);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${SEARCH}?${q}`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      return { error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network" };
    }
    if (res.status === 429 && attempt === 0) { await sleep(60_000); continue; }
    if (!res.ok) return { error: `http ${res.status}` };
    const body = await res.json().catch(() => null);
    return Array.isArray(body?.results) ? { results: body.results } : { error: "unparseable" };
  }
  return { error: "http 429" };
}

async function readPeople(): Promise<Person[]> {
  const sql = "SELECT id, name, bio_short AS bio, twitter_handle, linkedin_handle, website FROM attendees " +
    "WHERE trim(coalesce(bio_short,'')) <> '' OR trim(coalesce(twitter_handle,'')) <> '' OR trim(coalesce(linkedin_handle,'')) <> '' OR trim(coalesce(website,'')) <> ''";
  const { stdout } = await promisify(execFile)(...wranglerCommand([
    "d1", "execute", "serendipity", "-c", "wrangler.jsonc", "--remote", "--json", "--command", sql,
  ]), { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(stdout)[0].results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const n = Math.max(4, parseInt(args[args.indexOf("--n") + 1], 10) || 100);
  const dry = args.includes("--dry");
  const key = process.env.TINYFISH_API_KEY?.trim();
  if (!dry && !key) { console.error("serendipity:enrich-trial: set TINYFISH_API_KEY (agent.tinyfish.ai/api-keys), or pass --dry"); process.exit(2); }
  const people = await readPeople();
  if (!people.length) { console.error("serendipity:enrich-trial: read zero people, which is a failed read"); process.exit(2); }
  const cohort = pickCohort(people, n);
  const rows: any[] = [];
  for (const [i, p] of cohort.entries()) {
    const plan = planQuery(p);
    if (dry) { rows.push({ stratum: plan.stratum, anchor: plan.anchor, query: plan.query, include_domains: plan.include_domains }); continue; }
    if (i) await sleep(PACE_MS);
    const r = await search(plan, key!);
    const row = "error" in r ? { error: r.error } : assess(p, r.results);
    rows.push({ id: p.id, name: p.name, bio: p.bio || null, handle: handleOf(p) || null, stratum: plan.stratum, anchor: plan.anchor, query: plan.query, ...row });
    process.stderr.write(`\r${i + 1}/${cohort.length}`);
  }
  process.stderr.write("\n");
  console.log(JSON.stringify(rows, null, 1));
  if (!dry) {
    const s = summarize(rows);
    console.error("stratum  people failed matched tiered  gain agree disagree company");
    for (const [k, v] of Object.entries(s)) {
      console.error(`${k.padEnd(8)} ${[v.people, v.failed, v.matched, v.tiered, v.gain, v.agree, v.disagree, v.company].map((x) => String(x).padStart(6)).join(" ")}`);
    }
  }
}
