-- Fix: mobile_only.sql's app_sessions table has no way to detect a rotated-out refresh token being
-- replayed (no previous_token_hash), so a stolen-and-replayed token could not trigger revoking the
-- rest of that session's family. Mirrors admin_sessions.previous_token_hash (see modules/M01).
ALTER TABLE app_sessions ADD COLUMN previous_token_hash text;
CREATE INDEX idx_app_sessions_prev_token ON app_sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;
