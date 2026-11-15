-- Supplier bank-detail change check. Full values are sealed. Only masked values (last 4) are stored in clear.
CREATE TABLE IF NOT EXISTS bank_change_requests (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, supplier_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, old_enc TEXT, new_enc TEXT NOT NULL, old_masked TEXT NOT NULL, new_masked TEXT NOT NULL, account_hash TEXT NOT NULL, signals TEXT NOT NULL DEFAULT '[]', channel TEXT NOT NULL, channel_note TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL, callback TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT, hold_until TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bank_change_tenant ON bank_change_requests (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS bank_change_supplier ON bank_change_requests (supplier_id, status);
CREATE INDEX IF NOT EXISTS bank_change_hash ON bank_change_requests (account_hash);
CREATE TABLE IF NOT EXISTS supplier_payout_details (supplier_id TEXT NOT NULL, kind TEXT NOT NULL, tenant_id TEXT NOT NULL, enc TEXT NOT NULL, masked TEXT NOT NULL, account_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (supplier_id, kind));
CREATE INDEX IF NOT EXISTS payout_hash ON supplier_payout_details (account_hash);
CREATE TABLE IF NOT EXISTS bank_change_settings (tenant_id TEXT PRIMARY KEY, cooling_off_hours REAL NOT NULL DEFAULT 24, updated_by TEXT, updated_at TEXT);
