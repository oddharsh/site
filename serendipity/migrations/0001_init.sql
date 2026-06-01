-- Serendipity (collective edition) — forward-only schema for Cloudflare D1.
-- Ported from the Next.js app's initSchema()+migrateSchema(), minus the CRM
-- columns (talked_to / follow_up_note) — this is a public "what events are good
-- and who's going" tool, not a personal CRM.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  start_at TEXT,
  end_at TEXT,
  location TEXT,
  cover_url TEXT,
  url TEXT,
  geo_latitude REAL,
  geo_longitude REAL,
  ticket_key TEXT,
  user_status TEXT NOT NULL DEFAULT 'going',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  bio_short TEXT,
  website TEXT,
  twitter_handle TEXT,
  linkedin_handle TEXT,
  instagram_handle TEXT,
  tiktok_handle TEXT,
  youtube_handle TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  times_seen INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  approval_status TEXT,
  is_host INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, attendee_id)
);

CREATE TABLE IF NOT EXISTS enrichments (
  attendee_id TEXT PRIMARY KEY REFERENCES attendees(id),
  linkedin_url TEXT,
  company TEXT,
  role TEXT,
  bio TEXT,
  location TEXT,
  work_history TEXT,
  education TEXT,
  emails TEXT,
  phone_numbers TEXT,
  source TEXT,
  raw_json TEXT,
  enriched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contributors (
  luma_user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_cookies (
  user_key TEXT PRIMARY KEY,
  cookies_json TEXT NOT NULL,
  luma_user_id TEXT,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_contributions (
  event_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  contributed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_key)
);

CREATE INDEX IF NOT EXISTS idx_ea_event ON event_attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_ea_attendee ON event_attendees(attendee_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
