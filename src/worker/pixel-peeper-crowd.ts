// pixel-peeper-crowd.ts: everyone's picks on /pixel-peeper, pooled.
//
//   POST /pixel-peeper/runs        a finished run, as the tiles picked and shown
//   GET  /pixel-peeper/crowd.json  the pooled counts the result screen draws
//
// THE SERVER SCORES, THE CLIENT ONLY REPORTS. A run arrives as the tile src
// picked on each call plus the srcs that call showed, and nothing else. Every
// src is looked up in the manifest this Worker serves, so the score, the
// metric each pick sided with, and which tiles count as "correct" are all
// worked out here from the same flags the page reads. A forged POST can claim
// picks; it can't claim a score its picks didn't earn, or a tile that doesn't
// exist.
//
// SIZED FOR WORKERS FREE, where D1 allows 100K rows written and 5M rows read a
// day across the whole account (aadhar-social shares that with webmentions,
// and every other database here shares it too). So:
//
//   - The pooled counts live in ONE row, a flat JSON object, and a run lands
//     as one UPDATE that bumps every key it touches with json_set. That is one
//     row written per run whatever the run holds, and one row read per
//     crowd.json, however many runs there are. A row per pick would cost 13.
//   - The raw run goes to pixel_peeper_runs, one row, for the reads nobody has
//     written yet (the crowd threshold an export preset needs). Tile ids are
//     the 12-hex content hash, so a run is ~350 bytes and D1's 500 MB per
//     database holds over a million of them.
//   - DAILY_RUN_CAP bounds the worst day at 2 x 5,000 = 10,000 rows written,
//     a tenth of the account's budget, so a script hammering this endpoint
//     can't spend the writes /webmention, /serendipity and the crons need.
//     The cap is enforced inside the same UPDATE (its WHERE refuses once
//     today's count reaches it), so a refused run writes nothing at all.
//   - PIXEL_PEEPER_BUDGET stops one address filling the cap alone. A real run
//     takes minutes, so 6 a minute is far above any person.
//
// A run past the cap still gets the crowd back with `counted: false`, so the
// page keeps working on the day the cap trips.
//
// Nothing about the caller is stored: no IP, no user agent, no cookie.
// /privacy says so (trust.ts).
import { jsonResponse } from "./lib/http.ts";
import { asList, asNumber, asRecord, asText } from "./lib/parse.ts";
import { overBudget, rateLimitedHeaders } from "./lib/ratelimit.ts";

/** Mirrored in cloudflare.config.ts; contract-lens-per-ip-crawl-budgets pins the pair. */
export const PIXEL_PEEPER_BUDGET = { binding: "PIXEL_PEEPER_RL", max: 6 };
/** Runs counted per UTC day, each costing 2 D1 rows written. */
export const DAILY_RUN_CAP = 5000;
/** A normal run is 12 calls and a showdown 6; this leaves room, never a ceiling a run meets. */
const MAX_PICKS = 16;
const MIN_PICKS = 4;
const MAX_BODY_BYTES = 8192;
const MANIFEST_PATH = "/pixel-peeper/manifest.json";
const TALLY = "pixel_peeper_tally";
const RUNS = "pixel_peeper_runs";

type Option = { label: string; src: string; s2: number | null; butter: number | null; s2best?: boolean; butterbest?: boolean };
type Trial = { axis: string; disagree: boolean; options: Option[] };
type Manifest = { trials: Trial[] };
type TileIndex = Map<string, { trial: Trial; option: Option }>;

/** A tile's id: its file name without the extension, the 12-hex content hash
 *  gen-pixel-peeper.ts names every tile by. The page derives the same id. */
export function tileId(src: string): string {
  const base = src.slice(src.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot < 0 ? base : base.slice(0, dot);
}

export function indexManifest(manifest: Manifest): TileIndex {
  const index: TileIndex = new Map();
  for (const trial of manifest.trials) for (const option of trial.options) index.set(option.src, { trial, option });
  return index;
}

// The axes graded by a known answer instead of the metrics. Mirrors AXES in
// the page, where resample carries `answer: o => o.label === "zenc"`.
const ANSWERS: Record<string, (o: Option) => boolean> = { resample: (o) => o.label === "zenc" };

export type ScoredRun = {
  mode: "exam" | "showdown";
  overall: number;
  clear: number;
  hit: number;
  split: { s2: number; butter: number; neither: number };
  // tile ids picked on calls that showed every tile, which are the only ones
  // the per-tile crowd share counts, so its shares always split one full set
  pooled: string[];
  // what the runs row stores: [picked] or [picked, shown] when tiles sat out
  picks: (string | string[])[][];
};

type Rated = { option: Option; s2best: boolean; butterbest: boolean };

// The winners over the tiles a call actually showed. A full call keeps the
// manifest's flags; a call a browser cut (no JPEG XL, or AV2's decoder failed)
// is ranked again the way the page's dropFmt does it: best ssimulacra2 is the
// highest, best butteraugli the lowest.
function rate(trial: Trial, shown: Option[]): { rated: Rated[]; disagree: boolean } {
  if (shown.length === trial.options.length) {
    return { rated: shown.map((o) => ({ option: o, s2best: !!o.s2best, butterbest: !!o.butterbest })), disagree: trial.disagree };
  }
  const s2 = Math.max(...shown.map((o) => o.s2 ?? -Infinity));
  const bu = Math.min(...shown.map((o) => o.butter ?? Infinity));
  const rated = shown.map((o) => ({ option: o, s2best: o.s2 === s2, butterbest: o.butter === bu }));
  return { rated, disagree: rated.find((r) => r.s2best) !== rated.find((r) => r.butterbest) };
}

export function scoreRun(index: TileIndex, body: unknown): { ok: true; run: ScoredRun } | { ok: false; error: string } {
  const b = asRecord(body);
  if (!b) return { ok: false, error: "expected a JSON object" };
  const mode = b.mode === "exam" || b.mode === "showdown" ? b.mode : null;
  if (!mode) return { ok: false, error: "mode must be exam or showdown" };
  const calls = asList(b.picks);
  if (calls.length < MIN_PICKS || calls.length > MAX_PICKS) {
    return { ok: false, error: `picks must hold ${MIN_PICKS} to ${MAX_PICKS} calls` };
  }
  const seen = new Set<Trial>();
  const run: ScoredRun = { mode, overall: 0, clear: 0, hit: 0, split: { s2: 0, butter: 0, neither: 0 }, pooled: [], picks: [] };
  for (const p of calls) {
    const c = asRecord(p);
    const pick = asText(c?.pick);
    const shown = asList(c?.shown).map((s) => asText(s, ""));
    if (!pick || shown.length < 2) return { ok: false, error: "each call needs a pick and the tiles shown" };
    if (new Set(shown).size !== shown.length) return { ok: false, error: "a call showed the same tile twice" };
    const hits = shown.map((s) => index.get(s));
    if (hits.some((h) => !h)) return { ok: false, error: "a tile is not in the manifest" };
    const trial = hits[0]!.trial;
    if (hits.some((h) => h!.trial !== trial)) return { ok: false, error: "a call's tiles come from different calls" };
    if (seen.has(trial)) return { ok: false, error: "a call appears twice" };
    seen.add(trial);
    if (!shown.includes(pick)) return { ok: false, error: "a pick was not among the tiles shown" };
    if (mode === "showdown" && trial.axis !== "format") return { ok: false, error: "a showdown is format calls only" };
    const full = shown.length === trial.options.length;
    // only the format axis ever loses a tile, to a browser that can't draw it
    if (!full && trial.axis !== "format") return { ok: false, error: "only a format call can show fewer tiles" };

    const { rated, disagree } = rate(trial, hits.map((h) => h!.option));
    const chosen = rated.find((r) => r.option.src === pick)!;
    const answer = ANSWERS[trial.axis];
    if (answer) {
      run.clear++; if (answer(chosen.option)) run.hit++;
    } else if (disagree) {
      if (chosen.s2best) run.split.s2++;
      else if (chosen.butterbest) run.split.butter++;
      else run.split.neither++;
    } else {
      run.clear++; if (chosen.s2best && chosen.butterbest) run.hit++;
    }
    const id = tileId(pick);
    if (full) run.pooled.push(id);
    run.picks.push(full ? [id] : [id, shown.map(tileId)]);
  }
  run.overall = run.clear ? Math.round((100 * run.hit) / run.clear) : 0;
  return { ok: true, run };
}

// ── the tally row ────────────────────────────────────────────────────────────
// Flat keys, so json_set creates a missing one rather than needing its parent:
//   n:<mode>        runs counted          h:<mode>:<overall>  the histogram
//   l:s2 l:bu l:no  split-call picks       p:<tile id>         per-tile picks
//   g:<0-10>        each exam run's lean, butteraugli's share of its decisive
//                   split calls in tenths, which is the axis the page draws
//   d, dn           today (UTC) and its count, for the cap
const key = (k: string) => `$."${k}"`;

export function tallyStatement(run: ScoredRun, day: string, cap: number): { sql: string; params: (string | number)[] } {
  const bumps: [string, number][] = [[`n:${run.mode}`, 1], [`h:${run.mode}:${run.overall}`, 1]];
  if (run.split.s2) bumps.push(["l:s2", run.split.s2]);
  if (run.split.butter) bumps.push(["l:bu", run.split.butter]);
  if (run.split.neither) bumps.push(["l:no", run.split.neither]);
  const decisive = run.split.s2 + run.split.butter;
  if (run.mode === "exam" && decisive) bumps.push([`g:${Math.round((10 * run.split.butter) / decisive)}`, 1]);
  for (const id of run.pooled) bumps.push([`p:${id}`, 1]);
  const params: (string | number)[] = [day, cap];
  const sets = bumps.map(([k, by]) => {
    params.push(key(k), by);
    const p = params.length - 1;
    return `?${p}, coalesce(json_extract(v, ?${p}), 0) + ?${p + 1}`;
  });
  const sql = `UPDATE ${TALLY} SET v = json_set(v,
    '$.d', ?1,
    '$.dn', CASE WHEN json_extract(v, '$.d') = ?1 THEN json_extract(v, '$.dn') + 1 ELSE 1 END,
    ${sets.join(",\n    ")})
  WHERE k = 'all' AND NOT (coalesce(json_extract(v, '$.d'), '') = ?1 AND coalesce(json_extract(v, '$.dn'), 0) >= ?2)
  RETURNING v`;
  return { sql, params };
}

export type Crowd = {
  runs: Record<string, number>;
  hist: Record<string, Record<string, number>>;
  lean: { s2: number; butter: number; neither: number };
  leanRuns: Record<string, number>;
  picks: Record<string, number>;
};

export function crowdFromTally(v: string | null | undefined): Crowd {
  const crowd: Crowd = { runs: {}, hist: {}, lean: { s2: 0, butter: 0, neither: 0 }, leanRuns: {}, picks: {} };
  let flat: Record<string, unknown> = {};
  try { flat = asRecord(JSON.parse(v || "{}")) || {}; } catch { /* an unreadable row reads as an empty crowd */ }
  for (const [k, raw] of Object.entries(flat)) {
    const n = asNumber(raw);
    if (n === null) continue;
    const [kind, a, b] = k.split(":");
    if (kind === "n" && a) crowd.runs[a] = n;
    else if (kind === "h" && a && b !== undefined) (crowd.hist[a] ||= {})[b] = n;
    else if (k === "l:s2") crowd.lean.s2 = n;
    else if (k === "l:bu") crowd.lean.butter = n;
    else if (k === "l:no") crowd.lean.neither = n;
    else if (kind === "g" && a) crowd.leanRuns[a] = n;
    else if (kind === "p" && a) crowd.picks[a] = n;
  }
  return crowd;
}

// ── storage ──────────────────────────────────────────────────────────────────
// Created lazily, the way webmention.ts does it, so the binding self-provisions.
// migrations/0002_pixel_peeper.sql carries the same DDL. The INSERT OR IGNORE
// writes nothing once the row exists.
let ensured = false;
async function ensureTables(db) {
  if (ensured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ${TALLY} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    db.prepare(`INSERT OR IGNORE INTO ${TALLY} (k, v) VALUES ('all', '{}')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${RUNS} (
      at INTEGER NOT NULL, mode TEXT NOT NULL, overall INTEGER NOT NULL,
      clear_n INTEGER NOT NULL, clear_hit INTEGER NOT NULL,
      split_s2 INTEGER NOT NULL, split_butter INTEGER NOT NULL, split_neither INTEGER NOT NULL,
      picks TEXT NOT NULL)`),
  ]);
  ensured = true;
}

// Never creates anything: crowd.json is a GET, and a preview URL runs this
// against the production database (lib/preview.ts). Before the first counted
// run there is no table, which reads as an empty crowd.
async function readTally(db): Promise<string | null> {
  try {
    return asText(asRecord(await db.prepare(`SELECT v FROM ${TALLY} WHERE k = 'all'`).first())?.v);
  } catch {
    return null;
  }
}

// One manifest per isolate: it changes only with a deploy, which starts new ones.
let manifestIndex: Promise<TileIndex> | null = null;
function loadIndex(env): Promise<TileIndex> {
  if (manifestIndex) return manifestIndex;
  const loading: Promise<TileIndex> = env.ASSETS.fetch(new Request(`https://assets.local${MANIFEST_PATH}`))
    .then((r: Response) => { if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`); return r.json(); })
    .then((m: Manifest) => indexManifest(m));
  // a failed load is forgotten, so the next run tries again
  loading.catch(() => { manifestIndex = null; });
  manifestIndex = loading;
  return loading;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => jsonResponse(body, status, headers, { pretty: false });

export async function handlePixelPeeperCrowd(request: Request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET only" }, 405, { allow: "GET, HEAD" });
  const db = env.SOCIAL_DB;
  if (!db) return json({ error: "the crowd is not bound on this deployment" }, 503);
  return json(crowdFromTally(await readTally(db)), 200, { "cache-control": "public, max-age=60" });
}

export async function handlePixelPeeperRun(request: Request, env, ctx?: ExecutionContext) {
  if (request.method !== "POST") return json({ error: "POST a finished run" }, 405, { allow: "POST" });
  // application/json forces a CORS preflight, which this route never answers,
  // so another site's page can't post runs from its visitors' browsers
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json({ error: "send application/json" }, 415);
  if (request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "cross-site" }, 403);
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
  if (await overBudget(PIXEL_PEEPER_BUDGET, request, env)) {
    return json({ error: "too many runs from this address; try again in a minute" }, 429, rateLimitedHeaders("pixel-peeper", PIXEL_PEEPER_BUDGET.max));
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }

  let index: TileIndex;
  try { index = await loadIndex(env); } catch { return json({ error: "the manifest did not load" }, 503); }
  const scored = scoreRun(index, body);
  if (!scored.ok) return json({ error: scored.error }, 400);
  const run = scored.run;

  const db = env.SOCIAL_DB;
  if (!db) return json({ error: "the crowd is not bound on this deployment" }, 503);
  await ensureTables(db);
  const now = new Date();
  const { sql, params } = tallyStatement(run, now.toISOString().slice(0, 10), DAILY_RUN_CAP);
  // RETURNING hands back the new tally, or no row when the cap refused the run
  const updated = asText(asRecord(await db.prepare(sql).bind(...params).first())?.v);
  const counted = updated !== null;
  if (counted) {
    const insert = db.prepare(`INSERT INTO ${RUNS} (at, mode, overall, clear_n, clear_hit, split_s2, split_butter, split_neither, picks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(Math.floor(now.getTime() / 1000), run.mode, run.overall, run.clear, run.hit,
        run.split.s2, run.split.butter, run.split.neither, JSON.stringify(run.picks))
      .run()
      .catch((e) => console.error("pixel-peeper: run row not written", e?.message || e));
    if (ctx?.waitUntil) ctx.waitUntil(insert); else await insert;
  }
  const crowd = crowdFromTally(updated ?? await readTally(db));
  const you = { overall: run.overall, clear: run.clear, hit: run.hit, split: run.split };
  return json({ counted, you, crowd });
}
