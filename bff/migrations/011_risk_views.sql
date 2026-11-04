-- Risk review decisions per payment, and saved table views per user.
CREATE TABLE IF NOT EXISTS risk_reviews (payment_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved_views (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, table_key TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS saved_views_user ON saved_views (user_id, table_key);
