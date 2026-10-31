-- Clairic's read of each attendee's bio: the organization it named (its guess,
-- kept even when it thought "none" likelier), the chance of none, and the hash
-- of the exact request, so a bio is re-asked only when its text, the
-- instructions or the model name changes. serendipity/companies.ts carries the
-- same statement as ATTENDEE_COMPANIES_DDL and runs it on first use; a contract
-- test holds the two equal.
CREATE TABLE IF NOT EXISTS attendee_companies (attendee_id TEXT PRIMARY KEY REFERENCES attendees(id), company TEXT, p_null REAL NOT NULL, confidence REAL NOT NULL, model TEXT NOT NULL, input_hash TEXT NOT NULL, extracted_at TEXT NOT NULL DEFAULT (datetime('now')));
