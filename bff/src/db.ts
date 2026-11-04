import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config, persist } from "./config.js";

export type Sql = Database.Database;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export function openDb(file: string): Sql {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
}
export function migrate(d: Sql) {
  d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(d.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    d.transaction(() => { d.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")); d.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(f, new Date().toISOString()); })();
  }
}

export let sql: Sql = openDb(persist() ? config.DB_FILE : ":memory:");
/** Swap the connection, used by tests. */
export function useDb(file = ":memory:") { sql.close(); sql = openDb(file); return sql; }
