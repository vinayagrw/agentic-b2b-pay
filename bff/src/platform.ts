import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Rail } from "@b2b/shared";
import { sql } from "./db.js";
import { adapter, RAIL_IDS, railReadiness } from "./rails/index.js";
import { db, save, emit } from "./modules/store.js";
import { appendEvidence } from "./modules/evidence.js";

export const ROLES = ["operator_admin", "client_admin", "approver", "ap_clerk", "auditor"] as const;
export type Role = (typeof ROLES)[number];
export type User = { id: string; tenantId: string | null; name: string; email: string; role: Role };
export type Branding = { name: string; logo: string | null; primary: string; accent: string };
export type RailSetting = { env: "sandbox" | "live" };
export type Pricing = Partial<Record<Rail, { pct: number; fixed: number }>>;
export type Tenant = { id: string; kind: "bank" | "client"; parentId: string | null; name: string; branding: Branding; railSettings: Partial<Record<Rail, RailSetting>>; createdAt: string; pricing?: Pricing };
export type PendingChange = { id: string; tenantId: string | null; kind: string; payload: any; requiredRole: Role; requestedBy: string; approvedBy: string | null; status: "pending" | "approved" | "rejected"; createdAt: string; decidedAt: string | null };

export class AuthError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const rails = (): Tenant["railSettings"] => Object.fromEntries(RAIL_IDS.map((r) => [r, { env: "sandbox" }]));
export const railEnv = (tenantId: string, rail: Rail): RailSetting["env"] => getTenant(tenantId)?.railSettings[rail]?.env ?? "sandbox";
export const SEED_TENANTS: Omit<Tenant, "createdAt">[] = [
  { id: "bank-northstar", kind: "bank", parentId: null, name: "Northstar Bank", branding: { name: "Northstar Bank", logo: "/api/uploads/seed-northstar.svg", primary: "#1d4ed8", accent: "#f59e0b" }, railSettings: rails(),
    pricing: { stripe_card: { pct: 0.4, fixed: 0.1 }, stripe_ach: { pct: 0.1, fixed: 0.25 }, circle_usdc: { pct: 0.15, fixed: 0 }, onchain_usdc: { pct: 0.1, fixed: 0 } } },
  { id: "bank-harbor", kind: "bank", parentId: null, name: "Harbor Trust", branding: { name: "Harbor Trust", logo: "/api/uploads/seed-harbor.svg", primary: "#0f766e", accent: "#e11d48" }, railSettings: rails(),
    pricing: { stripe_card: { pct: 0.5, fixed: 0 }, stripe_ach: { pct: 0.08, fixed: 0.3 }, circle_usdc: { pct: 0.2, fixed: 0 }, onchain_usdc: { pct: 0.12, fixed: 0 } } },
  { id: "tnt-acme", kind: "client", parentId: "bank-northstar", name: "Acme Manufacturing Inc", branding: { name: "Acme Manufacturing", logo: null, primary: "#1d4ed8", accent: "#f59e0b" }, railSettings: rails() },
  { id: "tnt-globex", kind: "client", parentId: "bank-harbor", name: "Globex Retail Group", branding: { name: "Globex Retail", logo: null, primary: "#0f766e", accent: "#e11d48" }, railSettings: rails() },
];
export const SEED_USERS: User[] = [
  { id: "usr-op-olivia", tenantId: null, name: "Olivia Grant", email: "olivia@operator.demo", role: "operator_admin" },
  { id: "usr-op-omar", tenantId: null, name: "Omar Haddad", email: "omar@operator.demo", role: "operator_admin" },
  { id: "usr-audit-ava", tenantId: null, name: "Ava Chen", email: "ava@operator.demo", role: "auditor" },
  { id: "usr-cfo-jane", tenantId: "tnt-acme", name: "Jane Okafor", email: "jane@acme.demo", role: "client_admin" },
  { id: "usr-controller-sam", tenantId: "tnt-acme", name: "Sam Rivera", email: "sam@acme.demo", role: "approver" },
  { id: "usr-treasurer-lee", tenantId: "tnt-acme", name: "Lee Park", email: "lee@acme.demo", role: "approver" },
  { id: "usr-clerk-pat", tenantId: "tnt-acme", name: "Pat Morgan", email: "pat@acme.demo", role: "ap_clerk" },
  { id: "usr-globex-gina", tenantId: "tnt-globex", name: "Gina Lopez", email: "gina@globex.demo", role: "client_admin" },
  { id: "usr-globex-gus", tenantId: "tnt-globex", name: "Gus Novak", email: "gus@globex.demo", role: "approver" },
  { id: "usr-globex-gwen", tenantId: "tnt-globex", name: "Gwen Ito", email: "gwen@globex.demo", role: "ap_clerk" },
];

/** Seeded bank logos, written once into the upload folder. Simple marks in each bank's colours. */
export const SEED_LOGOS: Record<string, string> = {
  "seed-northstar.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d4ed8"/><path d="M32 10l5.5 16.5H54L40.5 36.5 46 54 32 43 18 54l5.5-17.5L10 26.5h16.5z" fill="#f59e0b"/></svg>`,
  "seed-harbor.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M32 12v34M20 24h24M14 38c4 10 32 10 36 0" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="32" cy="12" r="4" fill="#e11d48"/></svg>`,
};
export function writeSeedLogos(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); for (const [n, svg] of Object.entries(SEED_LOGOS)) { const f = path.join(dir, n); if (!fs.existsSync(f)) fs.writeFileSync(f, svg); } } catch { /* read only disk, the initials fallback shows */ }
}
export function seedPlatform() {
  if ((sql.prepare("SELECT COUNT(*) n FROM tenants").get() as { n: number }).n) return topUpSeed();
  const now = new Date().toISOString();
  sql.transaction(() => {
    const t = sql.prepare("INSERT INTO tenants (id, kind, parent_id, name, branding, rail_settings, created_at, pricing) VALUES (?,?,?,?,?,?,?,?)");
    for (const x of SEED_TENANTS) t.run(x.id, x.kind, x.parentId, x.name, JSON.stringify(x.branding), JSON.stringify(x.railSettings), now, JSON.stringify(x.pricing ?? {}));
    const u = sql.prepare("INSERT INTO users (id, tenant_id, name, email, role) VALUES (?,?,?,?,?)");
    for (const x of SEED_USERS) u.run(x.id, x.tenantId, x.name, x.email, x.role);
  })();
}
/** Adds seeded users that a later build step introduced to an existing database. */
export function topUpSeed() {
  const u = sql.prepare("INSERT OR IGNORE INTO users (id, tenant_id, name, email, role) VALUES (?,?,?,?,?)");
  for (const x of SEED_USERS) u.run(x.id, x.tenantId, x.name, x.email, x.role);
}

const toTenant = (r: any): Tenant => ({ id: r.id, kind: r.kind, parentId: r.parent_id, name: r.name, branding: JSON.parse(r.branding), railSettings: JSON.parse(r.rail_settings), createdAt: r.created_at, pricing: r.pricing ? JSON.parse(r.pricing) : {} });
const toUser = (r: any): User => ({ id: r.id, tenantId: r.tenant_id, name: r.name, email: r.email, role: r.role });
export const listTenants = () => (sql.prepare("SELECT * FROM tenants ORDER BY kind, name").all() as any[]).map(toTenant);
export const getTenant = (id: string) => { const r = sql.prepare("SELECT * FROM tenants WHERE id = ?").get(id); return r ? toTenant(r) : null; };
export const listUsers = () => (sql.prepare("SELECT * FROM users ORDER BY tenant_id IS NOT NULL, tenant_id, role").all() as any[]).map(toUser);
export const getUser = (id: string) => { const r = sql.prepare("SELECT * FROM users WHERE id = ?").get(id); return r ? toUser(r) : null; };
export const isOperator = (u: User) => u.tenantId === null;

/** Tenants a user may act in. Operators see all, client users see their own. */
export function tenantsFor(u: User) { const all = listTenants(); return isOperator(u) ? all : all.filter((t) => t.id === u.tenantId); }
/** The bank whose brand applies to a tenant. */
export function themeFor(t: Tenant): Branding { if (t.kind === "bank" || !t.parentId) return t.branding; return getTenant(t.parentId)?.branding ?? t.branding; }

export function requireRole(u: User | null, roles: readonly Role[]): User {
  if (!u) throw new AuthError(401, "Sign in required");
  if (!roles.includes(u.role)) throw new AuthError(403, `Role ${u.role} cannot do this`);
  return u;
}
export function canAccessTenant(u: User, tenantId: string) { return isOperator(u) || u.tenantId === tenantId; }

export function audit(actor: string | null, subjectType: string, subjectId: string, event: string, payload: unknown) {
  appendEvidence(db.evidence, subjectType, subjectId, event, { actor, ...(payload as object) });
  save();
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export function updateBranding(tenantId: string, patch: Partial<Branding>) {
  const t = getTenant(tenantId); if (!t) throw new AuthError(404, "tenant not found");
  for (const k of ["primary", "accent"] as const) if (patch[k] !== undefined && !HEX.test(patch[k]!)) throw new AuthError(422, `${k} must be a hex colour like #1d4ed8`);
  const b: Branding = { ...t.branding, ...Object.fromEntries(Object.entries(patch).filter(([k]) => ["name", "logo", "primary", "accent"].includes(k))) };
  sql.prepare("UPDATE tenants SET branding = ?, name = CASE WHEN kind = 'bank' THEN ? ELSE name END WHERE id = ?").run(JSON.stringify(b), b.name, tenantId);
  emit("tenant.branding"); return getTenant(tenantId)!;
}

// Maker-checker
const toChange = (r: any): PendingChange => ({ id: r.id, tenantId: r.tenant_id, kind: r.kind, payload: JSON.parse(r.payload), requiredRole: r.required_role, requestedBy: r.requested_by, approvedBy: r.approved_by, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at });
type Handler = { role: Role; validate?: (p: any) => void; apply: (p: any) => unknown };
const HANDLERS: Record<string, Handler> = {
  "rail.settings": {
    role: "operator_admin",
    validate: (p) => {
      if (!getTenant(p.tenantId)) throw new AuthError(404, "tenant not found");
      if (!RAIL_IDS.includes(p.rail)) throw new AuthError(422, `unknown rail ${p.rail}`);
      if (!["sandbox", "live"].includes(p.setting?.env)) throw new AuthError(422, "env must be sandbox or live");
      if (p.setting.env === "live") {
        const r = railReadiness(p.rail, "live");
        if (!r.configured) throw new AuthError(409, `Live mode needs live keys for ${p.rail} in .env (${r.reason})`);
      }
    },
    apply: (p) => {
      const t = getTenant(p.tenantId)!; t.railSettings[p.rail as Rail] = { env: p.setting.env };
      sql.prepare("UPDATE tenants SET rail_settings = ? WHERE id = ?").run(JSON.stringify(t.railSettings), t.id); return t;
    },
  },
};
export function registerChangeKind(kind: string, h: Handler) { HANDLERS[kind] = h; }

export function requestChange(user: User, kind: string, payload: any, tenantId: string | null = null): PendingChange {
  const h = HANDLERS[kind]; if (!h) throw new AuthError(422, `unknown change kind ${kind}`);
  h.validate?.(payload);
  const c: PendingChange = { id: `chg-${crypto.randomUUID().slice(0, 8)}`, tenantId, kind, payload, requiredRole: h.role, requestedBy: user.id, approvedBy: null, status: "pending", createdAt: new Date().toISOString(), decidedAt: null };
  sql.prepare("INSERT INTO pending_changes (id, tenant_id, kind, payload, required_role, requested_by, status, created_at) VALUES (?,?,?,?,?,?,?,?)").run(c.id, tenantId, kind, JSON.stringify(payload), h.role, user.id, "pending", c.createdAt);
  audit(user.id, "change", c.id, "change.requested", { kind, payload });
  return c;
}
export function listChanges(status?: string, tenantId?: string | null) {
  const rows = (sql.prepare(`SELECT * FROM pending_changes ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC`).all(...(status ? [status] : [])) as any[]).map(toChange);
  return tenantId ? rows.filter((c) => c.tenantId === tenantId) : rows;
}
export function getChange(id: string) { const r = sql.prepare("SELECT * FROM pending_changes WHERE id = ?").get(id); return r ? toChange(r) : null; }

export function decideChange(user: User, id: string, approve: boolean) {
  const c = getChange(id); if (!c) throw new AuthError(404, "change not found");
  if (c.status !== "pending") throw new AuthError(409, `change is already ${c.status}`);
  if (c.requestedBy === user.id) throw new AuthError(403, "The maker cannot approve their own change");
  if (user.role !== c.requiredRole) throw new AuthError(403, `Needs role ${c.requiredRole}`);
  if (c.tenantId && !canAccessTenant(user, c.tenantId)) throw new AuthError(403, "Wrong tenant");
  const status = approve ? "approved" : "rejected";
  let result: unknown = null;
  sql.transaction(() => {
    if (approve) { HANDLERS[c.kind].validate?.(c.payload); result = HANDLERS[c.kind].apply(c.payload); }
    sql.prepare("UPDATE pending_changes SET status = ?, approved_by = ?, decided_at = ? WHERE id = ?").run(status, user.id, new Date().toISOString(), id);
  })();
  audit(user.id, "change", id, `change.${status}`, { kind: c.kind });
  return { change: getChange(id)!, result };
}
