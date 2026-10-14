// Pure apart from the one runClef call, and node-safe (gotcha 16).

import { runClef, type ClefEnv, type ClefModel } from "./lib/clef.ts";
import { asNumber, asText } from "./lib/parse.ts";

export const WALL_MODEL: ClefModel = "clef";
export const WALL_THRESHOLD = 0.5;
export const CLEF_DEADLINE_MS = 3500;

export const VIEW_SAMPLE = Symbol("lens.view.sample");

const QUESTION = "Is this HTTP response body a bot-protection challenge, block page or access-denied interstitial, served instead of the website's real content?";
const CRITERIA = Object.freeze({
  true: "A CAPTCHA, a JavaScript or proof-of-work challenge, 'checking your browser', 'access denied', a rate-limit page, or any bot-detection interstitial, from the site or a vendor such as Cloudflare, DataDome, Akamai, HUMAN/PerimeterX, Kasada or Imperva.",
  false: "The website's own page, even when it also loads a bot-detection script, is short, or asks the visitor to sign in.",
});

export function wallDedupeKey(sample: string): string {
  return sample.replace(/[0-9a-f]{12,}/gi, "#").replace(/\d{3,}/g, "#").replace(/\s+/g, " ").trim();
}

type View = { status?: number | null, blocked?: boolean, challenge?: boolean, error?: string, wall?: unknown, [VIEW_SAMPLE]?: string };

export function wallCandidates<V extends View>(views: readonly V[]): V[] {
  return views.filter((v) => {
    if (v.error || v.challenge || v.blocked) return false;
    const status = asNumber(v.status);
    return status !== null && status >= 200 && status < 300 && !!asText(v[VIEW_SAMPLE])?.trim();
  });
}

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

export function readNoul(answer: any): number | null {
  if (!answer || answer.type !== "noul") return null;
  const p = Number(answer.noul);
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

export type WallOutcome = { asked: number, distinct: number, flagged: number, outcome: string };

export async function classifyWalls(views: readonly View[], env: ClefEnv): Promise<WallOutcome> {
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
