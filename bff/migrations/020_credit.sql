-- Simulated credit line. One line per business client, set by the bank operator. Draws need a second person. No real lender.
CREATE TABLE IF NOT EXISTS credit_lines (tenant_id TEXT PRIMARY KEY, bank_id TEXT NOT NULL, limit_amount REAL NOT NULL, apr_pct REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, set_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credit_draws (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, apr_pct REAL NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL, outstanding REAL NOT NULL DEFAULT 0, interest_paid REAL NOT NULL DEFAULT 0, requested_by TEXT NOT NULL, decided_by TEXT, journal_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, funded_at TEXT);
CREATE INDEX IF NOT EXISTS credit_draws_tenant ON credit_draws (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS credit_repayments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, principal REAL NOT NULL, interest REAL NOT NULL, days INTEGER NOT NULL, journal_id TEXT NOT NULL, paid_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS credit_repayments_draw ON credit_repayments (draw_id, created_at);
CREATE TABLE IF NOT EXISTS credit_caps (bank_id TEXT PRIMARY KEY, cap_amount REAL NOT NULL, set_by TEXT NOT NULL, updated_at TEXT NOT NULL);
