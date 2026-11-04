/** Copilot skills: bff/skills/<slug>/SKILL.md files with a small YAML frontmatter and a markdown body of steps.
 * A skill narrows the copilot to the read tools it lists. Tenants switch skills off per slug, default on, like tenant_offers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db.js";
import * as P from "./platform.js";

export type SkillTool = { name: string; args: Record<string, string> };
export type Skill = { slug: string; name: string; description: string; tools: SkillTool[]; chart?: string; roles?: string[]; body: string };
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const CHARTS = ["bar", "line", "area", "donut", "stacked", "table"];
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Frontmatter: `key: value`, `key: [a, b]` and `key:` followed by `  - item` lines. Nothing else. */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } | null {
  const m = src.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if (!m) return null;
  const data: Record<string, string | string[]> = {}; let list: string | null = null; const uq = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/); if (item && list) { (data[list] as string[]).push(uq(item[1])); continue; }
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/); if (!kv) return null;
    const [, k, v] = kv; list = null;
    if (!v.trim()) { data[k] = []; list = k; } else if (/^\[.*\]$/.test(v.trim())) data[k] = v.trim().slice(1, -1).split(",").map(uq).filter(Boolean); else data[k] = uq(v);
  }
  return { data, body: m[2].trim() };
}

/** One skill from its file text. Throws with a plain reason when the file is not valid. */
export function parseSkill(slug: string, src: string, toolNames: string[]): Skill {
  if (!SLUG.test(slug)) throw new Error("bad folder name");
  const f = parseFrontmatter(src); if (!f) throw new Error("no frontmatter");
  const s = (k: string) => (typeof f.data[k] === "string" ? (f.data[k] as string) : "");
  const arr = (k: string) => (Array.isArray(f.data[k]) ? (f.data[k] as string[]) : typeof f.data[k] === "string" ? [f.data[k] as string] : []);
  const name = s("name"), description = s("description"); if (!name || !description) throw new Error("name and description are required");
  const tools = arr("tools").map((t) => { const [n, q = ""] = t.split("?"); return { name: n.trim(), args: Object.fromEntries(new URLSearchParams(q)) }; });
  if (!tools.length) throw new Error("tools is required");
  const bad = tools.filter((t) => !toolNames.includes(t.name)); if (bad.length) throw new Error(`unknown tool ${bad.map((t) => t.name).join(", ")}`);
  const chart = s("chart") || undefined; if (chart && !CHARTS.includes(chart)) throw new Error(`bad chart ${chart}`);
  const roles = arr("roles"); if (!f.body) throw new Error("body is empty");
  return { slug, name: name.slice(0, 60), description: description.slice(0, 300), tools, ...(chart ? { chart } : {}), ...(roles.length ? { roles } : {}), body: f.body.slice(0, 4000) };
}

/** Reads every skill folder. Invalid ones are skipped with a log line. */
export function loadSkills(dir: string, toolNames: string[], log: (m: string) => void = (m) => console.warn(m)): Skill[] {
  if (!fs.existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const slug of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, slug, "SKILL.md"); if (!fs.existsSync(file)) continue;
    try { out.push(parseSkill(slug, fs.readFileSync(file, "utf8"), toolNames)); } catch (e: any) { log(`skill ${slug} skipped: ${e.message}`); }
  }
  return out;
}

let cache: Skill[] | null = null;
export function allSkills(toolNames: string[]) { return (cache ??= loadSkills(SKILL_DIR, toolNames)); }
export function setSkills(s: Skill[] | null) { cache = s; }

// Tenant control. Default on. A row only exists once someone switched a skill.
const tenantFor = (u: P.User, scope: string | null) => scope ?? u.tenantId ?? "platform";
export const roleOk = (s: Skill, u: P.User) => !s.roles?.length || s.roles.some((r) => (r === "operator" ? P.isOperator(u) : r === u.role));
export const skillOn = (tenant: string, slug: string) => (sql.prepare("SELECT enabled FROM tenant_skills WHERE tenant_id = ? AND slug = ?").get(tenant, slug) as any)?.enabled !== 0;
/** Skills this caller may run here: on for the tenant and allowed for the role. */
export const enabledFor = (all: Skill[], u: P.User, scope: string | null) => all.filter((s) => roleOk(s, u) && skillOn(tenantFor(u, scope), s.slug));
export const canManage = (u: P.User, tenant: string) => P.isOperator(u) || (u.role === "client_admin" && u.tenantId === tenant);
export function settings(all: Skill[], u: P.User, tenant: string) {
  if (!canManage(u, tenant)) throw new P.AuthError(403, "Only a tenant admin or the operator can change skills");
  return all.map((s) => ({ slug: s.slug, name: s.name, description: s.description, roles: s.roles ?? [], enabled: skillOn(tenant, s.slug) }));
}
export function setSkill(all: Skill[], u: P.User, tenant: string, slug: string, enabled: boolean) {
  if (!canManage(u, tenant)) throw new P.AuthError(403, "Only a tenant admin or the operator can change skills");
  if (!all.some((s) => s.slug === slug)) throw new P.AuthError(404, "skill not found");
  sql.prepare("INSERT INTO tenant_skills (tenant_id, slug, enabled, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, slug) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(tenant, slug, enabled ? 1 : 0, u.id, new Date().toISOString());
  P.audit(u.id, "tenant", tenant, enabled ? "skill.enabled" : "skill.disabled", { slug }); return { tenantId: tenant, slug, enabled };
}
export { tenantFor as skillTenant };
