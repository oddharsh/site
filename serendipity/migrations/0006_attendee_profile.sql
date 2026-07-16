-- Luma profile ingest (mutual events). username is what api2.luma.com's
-- /user/profile/events endpoint is keyed by (api_id doesn't work there), so we
-- capture it from guest/host user objects to know who we can profile-fetch.
-- profile_synced_at marks the attempt (so the sweep drains once). event_together_count
-- is Luma's own "events together" count relative to the syncing contributor.
ALTER TABLE attendees ADD COLUMN username TEXT;
ALTER TABLE attendees ADD COLUMN profile_synced_at TEXT;
ALTER TABLE attendees ADD COLUMN event_together_count INTEGER;
