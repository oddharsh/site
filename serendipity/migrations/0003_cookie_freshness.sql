-- track each contributor's last sync outcome so a stale/rotated Luma session is
-- visible (the Contribute page prompts a re-paste) instead of silently failing.
-- last_sync_ok: 1 = last sync succeeded, 0 = failed (last_error carries why, e.g.
-- LUMA_AUTH_EXPIRED). last_sync_at is the attempt time.
ALTER TABLE user_cookies ADD COLUMN last_sync_at TEXT;
ALTER TABLE user_cookies ADD COLUMN last_sync_ok INTEGER;
ALTER TABLE user_cookies ADD COLUMN last_error TEXT;
