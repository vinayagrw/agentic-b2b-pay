-- Legal entities per client tenant, FX rate cache and FX quote locks.
CREATE TABLE IF NOT EXISTS legal_entities (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL, country TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS legal_entities_tenant ON legal_entities (tenant_id);
CREATE TABLE IF NOT EXISTS fx_rates (base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL NOT NULL, rate_date TEXT, source TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (base, quote));
CREATE TABLE IF NOT EXISTS fx_locks (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL, intent_id TEXT, data TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
