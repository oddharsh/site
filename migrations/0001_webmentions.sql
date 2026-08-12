-- aadhar-social / webmentions — inbound Webmention storage for /inbox.
--
-- The worker also creates this table lazily (CREATE TABLE IF NOT EXISTS in
-- www/_worker.js/webmention.js, same pattern census.js and around.js use),
-- so a fresh binding self-provisions and this file is the explicit form for
-- anyone who would rather apply the schema up front:
--
--   wrangler d1 create aadhar-social
--   wrangler d1 execute aadhar-social --remote --file=migrations/0001_webmentions.sql
--
-- SETUP, in order. The SOCIAL_DB binding is deliberately NOT in wrangler.jsonc
-- yet: a binding whose database_id does not exist fails a real deploy (a
-- --dry-run does not catch it, which is how it reached CI once). So create the
-- database FIRST, then paste this into the "d1_databases" array of BOTH
-- wrangler.jsonc and wrangler.dev.jsonc with the real id:
--
--   { "binding": "SOCIAL_DB", "database_name": "aadhar-social",
--     "database_id": "<the id wrangler d1 create printed>" }
--
-- Until that binding exists, /webmention accepts and verifies but drops the
-- mention with a warning, and /inbox renders its honest "not connected" state.
-- Nothing errors, and no reader sees a broken page.
--
-- Deliberately a SEPARATE database from aadhar-restore: that one is this site's
-- own append-only deploy history, this one is moderated third-party content.

CREATE TABLE IF NOT EXISTS webmentions (
  id TEXT PRIMARY KEY,              -- sha256(source|target), truncated: stable across re-sends
  source TEXT NOT NULL,             -- the page that linked here
  target TEXT NOT NULL,             -- the page on aadhar.sh it linked to
  kind TEXT NOT NULL DEFAULT 'mention',  -- mention | reply | like | repost | bookmark
  author TEXT,
  author_url TEXT,
  title TEXT,
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending until the host approves
  received_at INTEGER NOT NULL,
  approved_at INTEGER,
  UNIQUE (source, target)           -- a re-send updates, never duplicates
);

-- /inbox reads approved mentions newest-first; the index keeps that a scan of
-- the approved rows rather than the whole table.
CREATE INDEX IF NOT EXISTS webmentions_status_approved
  ON webmentions (status, approved_at DESC);

-- The outbound half (webmention-send.js, daily cron): what this site has told
-- the sources it cites. Purely a dedupe ledger — it exists so a daily run does
-- not re-notify the same pair, and so a target advertising no endpoint is not
-- re-probed every day. Nothing in this table is ever displayed.
CREATE TABLE IF NOT EXISTS webmentions_sent (
  source TEXT NOT NULL,             -- my page that did the citing
  target TEXT NOT NULL,             -- the source it cited
  endpoint TEXT,                    -- NULL when the target advertises none (the common case)
  status INTEGER,                   -- their HTTP response, or 0 if the POST failed
  last_sent_at INTEGER NOT NULL,
  PRIMARY KEY (source, target)
);
