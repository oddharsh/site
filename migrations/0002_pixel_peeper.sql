-- aadhar-social / pixel_peeper_*: everyone's /pixel-peeper picks, pooled.
--
-- The worker creates these lazily (src/worker/pixel-peeper-crowd.ts
-- ensureTables), the same as webmentions, so this file is the explicit form
-- for anyone who would rather apply the schema up front:
--
--   wrangler d1 execute aadhar-social --remote --file=migrations/0002_pixel_peeper.sql
--
-- pixel_peeper_tally holds ONE row, k = 'all', whose v is a flat JSON object
-- of counters. A run bumps every key it touches in a single UPDATE, so the
-- crowd costs one row written per run and one row read per crowd.json.
CREATE TABLE IF NOT EXISTS pixel_peeper_tally (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT OR IGNORE INTO pixel_peeper_tally (k, v) VALUES ('all', '{}');

-- One row per counted run. No IP, user agent or cookie: nothing about who
-- played. picks is a JSON array of [tile id] or [tile id, [shown tile ids]]
-- when a browser sat a tile out; a tile id is the 12-hex content hash in
-- the tile's file name under /pixel-peeper/tiles/.
CREATE TABLE IF NOT EXISTS pixel_peeper_runs (
  at INTEGER NOT NULL, mode TEXT NOT NULL, overall INTEGER NOT NULL,
  clear_n INTEGER NOT NULL, clear_hit INTEGER NOT NULL,
  split_s2 INTEGER NOT NULL, split_butter INTEGER NOT NULL, split_neither INTEGER NOT NULL,
  picks TEXT NOT NULL);
