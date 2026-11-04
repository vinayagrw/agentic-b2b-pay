-- Step 5: reconciliation exceptions and treasury sweeps.
CREATE TABLE IF NOT EXISTS recon_exceptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('unmatched','amount_mismatch','late')), status TEXT NOT NULL CHECK (status IN ('open','resolved')), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sweeps (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rail TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
