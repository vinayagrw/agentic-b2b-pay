-- Approval delegation. One person hands approvals to another approver for a date range. Dates are YYYY-MM-DD, both ends included.
CREATE TABLE IF NOT EXISTS approval_delegations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, from_user TEXT NOT NULL, to_user TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS approval_delegations_to ON approval_delegations (tenant_id, to_user);
CREATE INDEX IF NOT EXISTS approval_delegations_from ON approval_delegations (tenant_id, from_user);
