CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('preference','fact','alias')), text TEXT NOT NULL, source_answer_id TEXT, created_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT);
CREATE INDEX IF NOT EXISTS memories_owner ON memories (user_id, tenant_id, valid_to);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text); END;
