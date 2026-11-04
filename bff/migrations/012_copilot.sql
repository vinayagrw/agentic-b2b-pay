CREATE TABLE IF NOT EXISTS copilot_threads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_scope TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS copilot_threads_user ON copilot_threads (user_id, updated_at);
CREATE TABLE IF NOT EXISTS copilot_answers (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS copilot_answers_thread ON copilot_answers (thread_id, created_at);
CREATE TABLE IF NOT EXISTS copilot_feedback (answer_id TEXT NOT NULL, user_id TEXT NOT NULL, vote TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (answer_id, user_id));
