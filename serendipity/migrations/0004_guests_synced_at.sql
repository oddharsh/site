-- track the last full guest-list pull per event so the batched /sync-guests sweep
-- drains going/hosted events once and doesn't re-scan them forever (mirrors the
-- desc_synced_at discipline for /sync-descriptions).
ALTER TABLE events ADD COLUMN guests_synced_at TEXT;
