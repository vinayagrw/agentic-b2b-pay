-- Step-up: TOTP factor per user and the time a session last passed a TOTP check.
CREATE TABLE IF NOT EXISTS user_totp (user_id TEXT PRIMARY KEY, secret_enc TEXT NOT NULL, confirmed_at TEXT, last_counter INTEGER NOT NULL DEFAULT -1, created_at TEXT NOT NULL);
ALTER TABLE sessions ADD COLUMN step_up_at TEXT;
