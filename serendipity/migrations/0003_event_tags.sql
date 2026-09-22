-- Jev's topic and format for each event, with the hash of the exact request that
-- produced them, so a tag is re-asked only when the event text, the taxonomy or
-- the pinned model changes. serendipity/jev.ts carries the same statement as
-- EVENT_TAGS_DDL and runs it on first use; a contract test holds the two equal.
CREATE TABLE IF NOT EXISTS event_tags (event_id TEXT PRIMARY KEY REFERENCES events(id), topic TEXT NOT NULL, topic_confidence REAL NOT NULL, format TEXT NOT NULL, format_confidence REAL NOT NULL, model TEXT NOT NULL, input_hash TEXT NOT NULL, probabilities TEXT, tagged_at TEXT NOT NULL DEFAULT (datetime('now')));
