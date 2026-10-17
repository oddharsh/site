// checkpoints.ts: what "released" means for the deploy log, and the one INSERT
// that records a release in D1. Shared by check-checkpoints.ts (the workstation
// check and `checkpoints:record`) and deploy-promote.ts (a manual ramp to 100%).
//
// RELEASED means present in the production branch's copy of
// src/worker/checkpoints.json. Since 2026-09-28 (#1002) promote-production.yml
// fast-forwards `production` to a tested main commit, Workers Builds runs
// `wrangler deploy` on it at 100%, and the workflow's verify job waits until
// /whoareyou.json reports the new version serving alone. So the branch tip is
// what serves, and nothing on that path can write D1: CI's Cloudflare token is
// read-only by rule (config/infra.json), and the Worker's build has no D1 step.

import { execFileSync } from "node:child_process";

export type Checkpoint = { vnum: number, ymd: string, version: string, slug: string, title: string };

export const PROJECTION = "src/worker/checkpoints.json";
export const RELEASED_REF = "origin/production";

/** The projection as the production branch carries it, or null when the ref
 *  is missing locally (a clone that never fetched `production`). */
export function releasedProjection(root: string, ref = RELEASED_REF): { sha: string, rows: Checkpoint[] } | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const text = execFileSync("git", ["show", `${sha}:${PROJECTION}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { sha, rows: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Unix seconds of the commit that first put this vnum into the projection on
 *  `sha`'s history: the closest thing a late record has to "when it shipped".
 *  Promotion follows a merge by one CI run (about 1 minute), so this
 *  undercounts by that much. Falls back to now if git can't say. */
export function shippedAt(root: string, sha: string, vnum: number): number {
  try {
    const out = execFileSync("git", ["log", "--reverse", "--format=%ct", `-S"vnum": ${vnum},`, sha, "--", PROJECTION], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = Number(out.split("\n")[0]);
    if (Number.isFinite(first) && first > 0) return first;
  } catch { /* fall through */ }
  return Math.floor(Date.now() / 1000);
}

/** The one INSERT both writers send. bump-version.sh refuses a single quote in
 *  a title; the doubling here keeps a hand-edited projection from breaking the
 *  literal anyway. */
export function checkpointInsert(row: Checkpoint, ts: number): string {
  const q = (s: string) => `'${String(s).replaceAll("'", "''")}'`;
  return `INSERT INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${Number(row.vnum)}, ${Math.floor(ts)}, ${q(row.ymd)}, ${q(row.version)}, ${q(row.slug)}, ${q(row.title)});`;
}
