-- Step 6: bank pricing, tenant API keys, outbound webhooks and the event log.
ALTER TABLE tenants ADD COLUMN pricing TEXT NOT NULL DEFAULT '{}';
UPDATE tenants SET pricing = '{"stripe_card":{"pct":0.4,"fixed":0.1},"stripe_ach":{"pct":0.1,"fixed":0.25},"circle_usdc":{"pct":0.15,"fixed":0},"onchain_usdc":{"pct":0.1,"fixed":0}}' WHERE id = 'bank-northstar';
UPDATE tenants SET pricing = '{"stripe_card":{"pct":0.5,"fixed":0},"stripe_ach":{"pct":0.08,"fixed":0.3},"circle_usdc":{"pct":0.2,"fixed":0},"onchain_usdc":{"pct":0.12,"fixed":0}}' WHERE id = 'bank-harbor';
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('ap_clerk','auditor')), prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS webhook_endpoints (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_status INTEGER, last_error TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_at);
UPDATE tenants SET branding = json_set(branding, '$.logo', '/api/uploads/seed-northstar.svg') WHERE id = 'bank-northstar' AND json_extract(branding, '$.logo') IS NULL;
UPDATE tenants SET branding = json_set(branding, '$.logo', '/api/uploads/seed-harbor.svg') WHERE id = 'bank-harbor' AND json_extract(branding, '$.logo') IS NULL;
