CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, format TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE (tenant_id, hash)
);
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, statement_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('unmatched','matched','ignored')),
  settlement_id TEXT, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bsl_tenant ON bank_statement_lines (tenant_id, status);
