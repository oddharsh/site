-- Clef's read of the kind of work each attendee's bio describes (one of
-- ROLE_LABELS), its confidence and probabilities, and the hash of the exact
-- request, so a bio is re-asked only when its text, the criteria or the model
-- name changes. serendipity/roles.ts carries the same statement as
-- ATTENDEE_ROLES_DDL and runs it on first use; a contract test holds the two
-- equal.
CREATE TABLE IF NOT EXISTS attendee_roles (attendee_id TEXT PRIMARY KEY REFERENCES attendees(id), role TEXT NOT NULL, confidence REAL NOT NULL, probabilities TEXT, model TEXT NOT NULL, input_hash TEXT NOT NULL, classified_at TEXT NOT NULL DEFAULT (datetime('now')));
