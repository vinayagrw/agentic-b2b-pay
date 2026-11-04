CREATE TABLE IF NOT EXISTS tenant_skills (tenant_id TEXT NOT NULL, slug TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, slug));
