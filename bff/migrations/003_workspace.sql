-- Step 4: approval rules, agent API keys, supplier onboarding tokens.
CREATE TABLE IF NOT EXISTS approval_rules (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_by TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS onboarding_tokens (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, supplier_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
