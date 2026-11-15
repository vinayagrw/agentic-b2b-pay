CREATE TABLE IF NOT EXISTS notice_outbox (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, audience TEXT NOT NULL, supplier_id TEXT, ref_id TEXT,
  subject TEXT NOT NULL, body TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'mock', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notice_outbox_tenant ON notice_outbox (tenant_id, created_at);
