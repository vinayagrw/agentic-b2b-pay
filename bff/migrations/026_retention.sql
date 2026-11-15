-- Gap 9: data retention. Operator sets days to keep per record type, legal holds block purge.
CREATE TABLE IF NOT EXISTS retention_policies (record_type TEXT PRIMARY KEY CHECK (record_type IN ('events','audit','invoices','payments')), days INTEGER, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT, reason TEXT NOT NULL, placed_by TEXT NOT NULL, placed_at TEXT NOT NULL, released_by TEXT, released_at TEXT
);
CREATE INDEX IF NOT EXISTS legal_holds_tenant ON legal_holds (tenant_id, released_at);
CREATE TABLE IF NOT EXISTS purge_runs (id TEXT PRIMARY KEY, ran_by TEXT NOT NULL, ran_at TEXT NOT NULL, data TEXT NOT NULL);
