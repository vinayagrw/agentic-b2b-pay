-- AP2 style signed purchase mandates. Intent is signed by the authorising user, Cart by the buyer agent.
CREATE TABLE IF NOT EXISTS signing_keys (signer_id TEXT PRIMARY KEY, signer_kind TEXT NOT NULL, public_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_mandates (id TEXT PRIMARY KEY, tenant_id TEXT, po_id TEXT NOT NULL, kind TEXT NOT NULL, signer_id TEXT NOT NULL, signer_kind TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL, superseded_at TEXT);
CREATE INDEX IF NOT EXISTS purchase_mandates_po ON purchase_mandates (po_id);
