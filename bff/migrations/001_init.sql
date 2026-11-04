-- Core schema. Domain rows keep the full object in data (JSON) plus indexed columns.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('bank','client')), parent_id TEXT,
  name TEXT NOT NULL, branding TEXT NOT NULL DEFAULT '{}', rail_settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('operator_admin','client_admin','approver','ap_clerk','auditor'))
);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pos (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY, tenant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('submitted','pending','settled','failed')), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rail_events (id TEXT PRIMARY KEY, tenant_id TEXT, intent_id TEXT, kind TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journals (id TEXT PRIMARY KEY, tenant_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL, subject_type TEXT, subject_id TEXT, event TEXT, hash TEXT NOT NULL, prev_hash TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_changes (
  id TEXT PRIMARY KEY, tenant_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, required_role TEXT NOT NULL,
  requested_by TEXT NOT NULL, approved_by TEXT, status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL, decided_at TEXT
);
-- Everything else in the legacy store (orgs, catalog, receipts, erp, refunds, flags).
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
