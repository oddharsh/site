-- aadhar-social / guestbook: automated visitors who signed /guestbook.
--
-- The worker creates this lazily (src/worker/guestbook.ts ensureTable), the
-- same as webmentions and pixel_peeper_*, so this file is the explicit form
-- for anyone who would rather apply the schema up front:
--
--   wrangler d1 execute aadhar-social --remote --file=migrations/0003_guestbook.sql
--
-- PUBLIC BY DESIGN, unlike every other table here: ip and user_agent are
-- published on /guestbook beside what the signer wrote, and /privacy says so.
-- name, purpose, tools and note are visitor-written; the rest is observed.
-- Removing an entry is a hand DELETE by id:
--
--   wrangler d1 execute aadhar-social --remote --command "DELETE FROM guestbook WHERE id = ?"
CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,            -- UTC date, the unit of one stay
  at INTEGER NOT NULL,          -- unix seconds
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,        -- why the visitor came
  tools TEXT NOT NULL,          -- JSON array of strings
  note TEXT,
  ip TEXT NOT NULL,             -- cf-connecting-ip
  user_agent TEXT NOT NULL,
  asn INTEGER, network TEXT, country TEXT,  -- request.cf
  verified_bot INTEGER NOT NULL,            -- cf.botManagement.verifiedBot
  signature_agent TEXT,                     -- the Signature-Agent header, unverified
  UNIQUE (day, ip, name)        -- one entry per stay; also the daily cap's count index
);
