-- track description-backfill attempts so events with no description (or deleted
-- events) aren't re-scanned forever by /sync-descriptions.
ALTER TABLE events ADD COLUMN desc_synced_at TEXT;
