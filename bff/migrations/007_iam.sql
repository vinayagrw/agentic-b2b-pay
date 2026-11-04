-- SSO, fine grained roles, SCIM and sessions.
ALTER TABLE users ADD COLUMN custom_role_id TEXT;
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN ext_sub TEXT;
ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'seed';
CREATE TABLE IF NOT EXISTS custom_roles (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT NOT NULL, base_role TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]', approve_limit REAL, entity_scope TEXT, created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idp_configs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_enc TEXT NOT NULL, group_role_map TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, method TEXT NOT NULL, idp_id TEXT, id_token TEXT, ip TEXT, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS scim_tokens (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
