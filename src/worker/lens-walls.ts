// Is a bot view's 200 actually the site, or a wall served with a 200?
//
// /lens refetches the scanned URL as ten identities, two of them CONTROLS
// (Chrome, curl) that decide whether the table can be read at all: with no
// control admitted, every crawler row reports the origin refusing US. The view
// was called a challenge only when Cloudflare said so (`cf-mitigated`) or the
// first 2 KB matched Cloudflare's own page. Every other vendor's wall, and
// every wall served with a 2xx, read as an admitted response, so a walled
// control counted as "got in" and the crawler rows below it were scored as
// evidence about user-agent policy when they were evidence about our IP.
//
// So each 2xx view that the regex did not already flag is asked of Clef, a
// decision model that returns a calibrated probability for a yes/no question.
// Measured 2026-10-01 on 31 samples taken with the curl and GPTBot user agents
// from 16 origins, hand-labelled: all 18 walls scored 0.84 or higher (DataDome,
// PerimeterX, Cloudflare, Kasada, a bare "Not Authorized", and Reddit's
// auto-submitting JS form served as a 200), and all 13 real pages scored 0.22
// or lower, including Foot Locker, which loads a bot-detection SDK on its real
// page and so defeats any "vendor script present" rule. clef-flash missed a
// realtor.com wall at 0.15, which is why this is "clef".
//
// What it costs, and the three things that bound it:
// - ONE subrequest. A cold scan already spends 46 of Workers Free's 50
//   (contract-lens-compare-stays-under-the-subrequest-cap), so every view rides
//   one call as its own question, the body inside that question's instructions
//   rather than in a shared state. Batched and one-call-per-sample answers
//   agreed on all 31 samples.
// - Identical bodies are asked once. A static origin serves all ten identities
//   the same bytes, which is one question; nonces and long hex runs are
//   normalised out first so a per-request token does not split them.
// - A deadline. Ten distinct bodies took 1.9 to 2.8 s; past CLEF_DEADLINE_MS
//   every view reads `wall: { p: null }`, unread, and nothing is flipped. A
//   missing answer is never evidence that there was no wall.
//
// A page cannot argue its way out except by looking like a page: Clef's output
// is a probability on one bounded question, so injected text can move a number
// and never a field. The verdict is stored with its probability and the model
// that gave it, so the cutoff can be retuned against what scans actually saw.
//
// Pure apart from the one runClef call, and node-safe (gotcha 16).

import { runClef, type ClefEnv, type ClefModel } from "./lib/clef.ts";
import { asNumber, asText } from "./lib/parse.ts";

export const WALL_MODEL: ClefModel = "clef";
// The natural cut for a calibrated yes probability: more likely a wall than
// not. The measured gap was 0.22 to 0.84, so this sits in the middle of it.
export const WALL_THRESHOLD = 0.5;
export const CLEF_DEADLINE_MS = 3500;

/** Where the sampled body rides on a view without reaching JSON: a symbol key
 *  is skipped by JSON.stringify, so the 2 KB sample never lands in the scan
 *  payload, the KV cache, or the MCP tool output. */
export const VIEW_SAMPLE = Symbol("lens.view.sample");

const QUESTION = "Is this HTTP response body a bot-protection challenge, block page or access-denied interstitial, served instead of the website's real content?";
const CRITERIA = Object.freeze({
  true: "A CAPTCHA, a JavaScript or proof-of-work challenge, 'checking your browser', 'access denied', a rate-limit page, or any bot-detection interstitial, from the site or a vendor such as Cloudflare, DataDome, Akamai, HUMAN/PerimeterX, Kasada or Imperva.",
  false: "The website's own page, even when it also loads a bot-detection script, is short, or asks the visitor to sign in.",
});

/** Collapses what differs between two fetches of one page (request ids,
 *  nonces, timestamps) so identical pages are asked about once. */
export function wallDedupeKey(sample: string): string {
  return sample.replace(/[0-9a-f]{12,}/gi, "#").replace(/\d{3,}/g, "#").replace(/\s+/g, " ").trim();
}

type View = { status?: number | null, blocked?: boolean, challenge?: boolean, error?: string, wall?: unknown, [VIEW_SAMPLE]?: string };

/** The views worth asking about: answered 2xx, not already flagged, with a body. */
export function wallCandidates<V extends View>(views: readonly V[]): V[] {
  return views.filter((v) => {
    if (v.error || v.challenge || v.blocked) return false;
    const status = asNumber(v.status);
    return status !== null && status >= 200 && status < 300 && !!asText(v[VIEW_SAMPLE])?.trim();
  });
}

/** One request, one noul question per distinct body, plus the grouping that
 *  maps each answer back to every view that shared that body. */
export function buildWallRequest(candidates: readonly View[]) {
  const groups: { id: string, views: View[] }[] = [];
  const byKey = new Map<string, { id: string, views: View[] }>();
  const questions: Record<string, unknown> = {};
  for (const v of candidates) {
    const body = v[VIEW_SAMPLE] as string;
    const key = wallDedupeKey(body);
    let g = byKey.get(key);
    if (!g) {
      g = { id: `b${groups.length}`, views: [] };
      byKey.set(key, g);
      groups.push(g);
      questions[g.id] = { type: "noul", instructions: { question: QUESTION, body }, criteria: CRITERIA };
    }
    g.views.push(v);
  }
  const request = { model: WALL_MODEL, state: { task: "Classify each sampled HTTP response named in the questions." }, questions };
  return { request, groups };
}

/** The probability for one question, or null for an answer this parser does
 *  not understand, which then reads as unread rather than as "no wall". */
export function readNoul(answer: any): number | null {
  if (!answer || answer.type !== "noul") return null;
  const p = Number(answer.noul);
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

export type WallOutcome = { asked: number, distinct: number, flagged: number, outcome: string };

/** Asks Clef about every candidate view, in place. A view at or past
 *  WALL_THRESHOLD becomes `challenge` and `blocked`, which every scorer already
 *  treats as refused, controls included; every asked view carries
 *  `wall: { p, model }` so the verdict shows its own evidence. */
export async function classifyWalls(views: readonly View[], env: ClefEnv): Promise<WallOutcome> {
  // No binding (local dev, the credential-free harnesses) means nothing was
  // asked, so no view is stamped: an absent `wall` reads as "not checked".
  if (!env.AI) return { asked: 0, distinct: 0, flagged: 0, outcome: "no AI binding" };
  const candidates = wallCandidates(views);
  if (!candidates.length) return { asked: 0, distinct: 0, flagged: 0, outcome: "none" };
  const { request, groups } = buildWallRequest(candidates);
  const r = await runClef(env, WALL_MODEL, request, CLEF_DEADLINE_MS);
  if ("error" in r) {
    for (const v of candidates) v.wall = { p: null, model: WALL_MODEL, error: r.error };
    return { asked: candidates.length, distinct: groups.length, flagged: 0, outcome: r.error };
  }
  const answers = (r.body as any)?.answers;
  let flagged = 0;
  for (const g of groups) {
    const p = readNoul(answers?.[g.id]);
    for (const v of g.views) {
      if (p === null) { v.wall = { p: null, model: WALL_MODEL, error: "unparseable" }; continue; }
      v.wall = { p: Math.round(p * 1000) / 1000, model: WALL_MODEL };
      if (p >= WALL_THRESHOLD) { v.challenge = true; v.blocked = true; flagged++; }
    }
  }
  return { asked: candidates.length, distinct: groups.length, flagged, outcome: "ok" };
}
