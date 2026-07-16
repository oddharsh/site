-- event "vibe" — a one-line characterization + a few tags derived from the
-- description + who RSVP'd, via Workers AI (POST /vibe). vibe_synced_at marks the
-- attempt so a characterized event doesn't re-run (mirrors desc_synced_at).
-- vibe_tags is a JSON array string (e.g. ["founder-heavy","crypto","happy hour"]).
ALTER TABLE events ADD COLUMN vibe TEXT;
ALTER TABLE events ADD COLUMN vibe_tags TEXT;
ALTER TABLE events ADD COLUMN vibe_synced_at TEXT;
