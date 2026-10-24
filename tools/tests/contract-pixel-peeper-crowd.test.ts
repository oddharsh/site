// ── /pixel-peeper pools everyone's picks, scored by the server ──────────────
//
// pixel-peeper-crowd.ts takes a run as the tiles picked and shown, and works
// out the score itself from the manifest. These hold the three things that
// make that safe and cheap: a forged run can't earn a score its picks didn't,
// the page and the server agree on what a tile's id is, and a run lands as ONE
// row write against a daily cap that refuses without writing.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

const MANIFEST = JSON.parse(readFileSync(new URL("../../public/pixel-peeper/manifest.json", import.meta.url), "utf8"));
const PAGE = readFileSync(new URL("../../src/pages/pixel-peeper/index.html", import.meta.url), "utf8");

const crowd = () => import("../../src/worker/pixel-peeper-crowd.ts");
const best = (t) => (t.axis === "resample" ? t.options.find((o) => o.label === "zenc") : t.options.find((o) => o.s2best && o.butterbest));
const worst = (t) => (t.axis === "resample" ? t.options.find((o) => o.label !== "zenc") : t.options.find((o) => !o.s2best && !o.butterbest));
const call = (t, o) => ({ pick: o.src, shown: t.options.map((x) => x.src) });
const clearCalls = MANIFEST.trials.filter((t) => !t.disagree && best(t) && worst(t)).slice(0, 8);

test("every tile id is the 12-hex content hash, unique across the manifest", async () => {
  const { tileId } = await crowd();
  const ids = MANIFEST.trials.flatMap((t) => t.options.map((o) => tileId(o.src)));
  for (const id of ids) assert.match(id, /^[0-9a-f]{12}$/, `${id} is not a content hash, so the crowd would key on something that can drift`);
  assert.equal(new Set(ids).size, ids.length, "two tiles share an id, so their picks would pool together");
  // the page derives the same id, so its per-call shares read the server's keys
  assert.match(PAGE, /const tileId=src=>src\.slice\(src\.lastIndexOf\("\/"\)\+1\)\.split\("\."\)\[0\];/);
});

test("the server scores from the picks, and ignores any score the client sends", async () => {
  const { indexManifest, scoreRun } = await crowd();
  const index = indexManifest(MANIFEST);
  const right = scoreRun(index, { mode: "exam", overall: 0, picks: clearCalls.map((t) => call(t, best(t))) });
  assert.ok(right.ok);
  assert.equal(right.run.overall, 100);
  assert.equal(right.run.clear, clearCalls.length);
  const wrong = scoreRun(index, { mode: "exam", overall: 100, picks: clearCalls.map((t) => call(t, worst(t))) });
  assert.ok(wrong.ok);
  assert.equal(wrong.run.overall, 0, "a client-sent overall must never reach the pool");
});

test("split calls count toward the lean and never toward the score", async () => {
  const { indexManifest, scoreRun } = await crowd();
  const split = MANIFEST.trials.filter((t) => t.disagree).slice(0, 4);
  const picks = split.map((t) =>
    call(
      t,
      t.options.find((o) => o.butterbest),
    ),
  );
  const r = scoreRun(indexManifest(MANIFEST), { mode: "exam", picks });
  assert.ok(r.ok);
  assert.equal(r.run.clear, 0);
  assert.deepEqual(r.run.split, { s2: 0, butter: split.length, neither: 0 });
});

test("a forged run is refused", async () => {
  const { indexManifest, scoreRun } = await crowd();
  const index = indexManifest(MANIFEST);
  const ok = clearCalls.slice(0, 4).map((t) => call(t, best(t)));
  const refuse = (body, why) => assert.equal(scoreRun(index, body).ok, false, why);
  refuse({ mode: "exam", picks: ok.slice(0, 3) }, "too few calls");
  refuse({ mode: "exam", picks: [...ok, ...ok] }, "the same call twice");
  refuse({ mode: "exam", picks: [{ ...ok[0], pick: "/pixel-peeper/tiles/000000000000.jpg" }, ...ok.slice(1)] }, "a tile that does not exist");
  refuse({ mode: "exam", picks: [{ ...ok[0], pick: ok[1].pick }, ...ok.slice(1)] }, "a pick that was not shown");
  refuse({ mode: "exam", picks: [{ ...ok[0], shown: [ok[0].shown[0], ok[1].shown[0]] }, ...ok.slice(1)] }, "tiles from two calls");
  refuse({ mode: "exam", picks: [{ ...ok[0], shown: ok[0].shown.slice(0, 1) }, ...ok.slice(1)] }, "a call of one tile");
  refuse({ mode: "showdown", picks: ok }, "a showdown of non-format calls");
  refuse({ mode: "ranked", picks: ok }, "an unknown mode");
  const quality = clearCalls.find((t) => t.axis === "quality" && t.options.length > 2);
  if (quality) {
    refuse(
      {
        mode: "exam",
        picks: [
          { pick: best(quality).src, shown: [best(quality).src, worst(quality).src] },
          ...ok.filter((p) => !quality.options.some((o) => o.src === p.pick)).slice(0, 3),
        ],
      },
      "only a format call may lose a tile",
    );
  }
});

test("a format call a browser cut is ranked again over what it showed, like the page's dropFmt", async () => {
  const { indexManifest, scoreRun } = await crowd();
  const t = MANIFEST.trials.find((x) => x.axis === "format" && x.options.length === 3 && x.options.some((o) => o.label.startsWith("JPEG XL")));
  assert.ok(t, "the manifest should hold a three-way format call with a JPEG XL tile");
  const shown = t.options.filter((o) => !o.label.startsWith("JPEG XL"));
  const s2 = Math.max(...shown.map((o) => o.s2)),
    bu = Math.min(...shown.map((o) => o.butter));
  const winner = shown.find((o) => o.s2 === s2 && o.butter === bu);
  const others = clearCalls
    .filter((x) => x !== t)
    .slice(0, 3)
    .map((x) => call(x, best(x)));
  const r = scoreRun(indexManifest(MANIFEST), { mode: "exam", picks: [{ pick: (winner || shown[0]).src, shown: shown.map((o) => o.src) }, ...others] });
  assert.ok(r.ok);
  if (winner) assert.equal(r.run.hit, 4, "the best of the tiles shown is a hit even when the manifest's winner sat out");
  else assert.equal(r.run.split.s2 + r.run.split.butter + r.run.split.neither, 1, "with JPEG XL gone the metrics split");
  assert.equal(r.run.pooled.length, 3, "a cut call's pick stays out of the per-tile shares");
});

// The UPDATE is the only write a run makes to the tally, so run it for real.
async function sqlite() {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    return { exec: (s) => db.run(s), all: (s, p) => db.query(s).all(...p), get: (s) => db.query(s).get() };
  } catch {
    /* not bun */
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    return { exec: (s) => db.exec(s), all: (s, p) => db.prepare(s).all(...p), get: (s) => db.prepare(s).get() };
  } catch {
    return null;
  }
}

test("a run is one UPDATE, the cap refuses without writing, and the crowd reads it back", async (t) => {
  const db = await sqlite();
  if (!db) {
    t.skip("no SQLite in this runtime");
    return;
  }
  const { indexManifest, scoreRun, tallyStatement, crowdFromTally } = await crowd();
  db.exec("CREATE TABLE pixel_peeper_tally (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.exec("INSERT INTO pixel_peeper_tally (k, v) VALUES ('all', '{}')");
  const split = MANIFEST.trials.find((x) => x.disagree);
  const picks = [
    ...clearCalls.slice(0, 4).map((x) => call(x, best(x))),
    call(
      split,
      split.options.find((o) => o.butterbest),
    ),
  ];
  const scored = scoreRun(indexManifest(MANIFEST), { mode: "exam", picks });
  if (!scored.ok) throw new Error(scored.error);
  const { run } = scored;
  const land = (day, cap) => {
    const { sql, params } = tallyStatement(run, day, cap);
    return db.all(sql, params);
  };
  assert.equal(land("2026-10-15", 2).length, 1);
  assert.equal(land("2026-10-15", 2).length, 1);
  const before = (db.get("SELECT v FROM pixel_peeper_tally") as { v: string }).v;
  assert.equal(land("2026-10-15", 2).length, 0, "past the cap the UPDATE matches no row");
  assert.equal((db.get("SELECT v FROM pixel_peeper_tally") as { v: string }).v, before, "a refused run writes nothing");
  assert.equal(land("2026-10-16", 2).length, 1, "the cap resets with the UTC day");
  const c = crowdFromTally((db.get("SELECT v FROM pixel_peeper_tally") as { v: string }).v);
  assert.equal(c.runs.exam, 3);
  assert.equal(c.hist.exam["100"], 3);
  assert.equal(c.lean.butter, 3);
  assert.equal(c.leanRuns["10"], 3);
  assert.equal(c.picks[run.pooled[0]], 3);
  assert.equal(Object.keys(c.picks).length, run.pooled.length);
});

// A preview URL runs production bindings (lib/preview.ts), and it serves GETs.
// So crowd.json must never write, not even the lazy CREATE TABLE the POST does.
test("crowd.json only reads, and a pool with no table yet is an empty crowd", async () => {
  const { handlePixelPeeperCrowd } = await crowd();
  const seen: any[] = [];
  const stmt = () => ({
    bind: () => stmt(),
    first: async () => {
      throw new Error("no such table: pixel_peeper_tally");
    },
    run: async () => ({}),
  });
  const SOCIAL_DB = {
    prepare: (sql) => {
      seen.push(sql);
      return stmt();
    },
    batch: async (xs) => {
      seen.push("batch");
      return xs;
    },
  };
  const res = await handlePixelPeeperCrowd(new Request("https://aadhar.sh/pixel-peeper/crowd.json"), { SOCIAL_DB });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).runs, {});
  assert.ok(seen.length > 0, "the control: the handler did reach the database");
  for (const sql of seen) assert.match(sql, /^\s*SELECT\b/, `crowd.json issued a write: ${sql}`);
});
