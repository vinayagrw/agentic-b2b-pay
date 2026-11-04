/** Identity and access: permissions, custom roles, sessions, OIDC identity providers, SCIM tokens and claim mapping. */
import crypto from "node:crypto";
import { sql } from "./db.js";
import { config } from "./config.js";
import * as P from "./platform.js";

// Permissions

export const PERMISSIONS = {
  "payments.pay": "Release a matched invoice for payment",
  "payments.approve": "Approve a purchase order, up to the role amount limit",
  "payments.refund": "Request a refund",
  "flow.operate": "Draft orders, receive goods, submit and match invoices",
  "agents.manage": "Register, pause and key buying agents",
  "rules.edit": "Edit approval rules",
  "suppliers.invite": "Invite suppliers and send onboarding links",
  "suppliers.review": "Verify or reject supplier onboarding",
  "suppliers.payee_change": "Request a supplier bank or wallet change",
  "compliance.read": "See compliance cases and screening status",
  "compliance.case.file": "Draft, file and close compliance cases",
  "treasury.read": "See treasury, reconciliation and revenue",
  "treasury.sweep": "Move funds and resolve reconciliation exceptions",
  "rails.balances": "See rail balances",
  "settings.live_toggle": "Request live or test mode for a rail",
  "settings.branding": "Edit bank branding and logos",
  "developers.keys": "Manage API keys, webhooks and SCIM tokens",
  "audit.read": "Read the evidence chain and export evidence packs",
  "users.read": "See the user directory",
  "identity.manage": "Request identity provider changes",
  "roles.manage": "Create and assign custom roles",
  "sessions.manage": "See and revoke other people's sessions",
  "changes.decide": "Decide on maker checker requests",
  "platform.reset": "Reset the demo data",
  "workspace.read": "Read workspace pages",
  "changes.request": "Request a maker checker change",
  "erp.vendor_master": "Push vendor master changes from the ERP",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMS = Object.keys(PERMISSIONS) as Permission[];

const READ: Permission[] = ["workspace.read", "changes.decide"];
export const BUILTIN: Record<P.Role, Permission[]> = {
  operator_admin: ALL_PERMS.filter((p) => !["suppliers.review", "suppliers.payee_change"].includes(p)),
  client_admin: [...READ, "payments.pay", "payments.approve", "payments.refund", "flow.operate", "agents.manage", "rules.edit", "suppliers.invite", "suppliers.review", "suppliers.payee_change", "developers.keys", "settings.branding", "roles.manage", "changes.request", "erp.vendor_master", "sessions.manage", "audit.read", "rails.balances"],
  approver: [...READ, "payments.pay", "payments.approve", "payments.refund", "flow.operate"],
  ap_clerk: [...READ, "payments.pay", "flow.operate", "suppliers.invite", "suppliers.payee_change"],
  auditor: [...READ, "audit.read", "compliance.read", "treasury.read", "users.read", "rails.balances"],
};
/** Permissions a client tenant may put into its own custom roles. */
export const CLIENT_PERMS = [...new Set([...BUILTIN.client_admin, ...BUILTIN.approver, ...BUILTIN.ap_clerk])];

export type CustomRole = { id: string; tenantId: string | null; name: string; baseRole: P.Role; permissions: Permission[]; approveLimit: number | null; entityScope: string[] | null; createdBy: string | null; createdAt: string };
const toRole = (r: any): CustomRole => ({ id: r.id, tenantId: r.tenant_id, name: r.name, baseRole: r.base_role, permissions: JSON.parse(r.permissions), approveLimit: r.approve_limit, entityScope: r.entity_scope ? JSON.parse(r.entity_scope) : null, createdBy: r.created_by, createdAt: r.created_at });
export const getRole = (id: string) => { const r = sql.prepare("SELECT * FROM custom_roles WHERE id = ?").get(id); return r ? toRole(r) : null; };
export const listRoles = (tenantId: string | null) => (sql.prepare("SELECT * FROM custom_roles WHERE tenant_id IS ? ORDER BY name").all(tenantId) as any[]).map(toRole);

export type Grant = { permissions: Set<Permission>; approveLimit: number | null; entityScope: string[] | null; roleName: string; custom: boolean };
export function grantOf(u: P.User): Grant {
  const c = u.customRoleId ? getRole(u.customRoleId) : null;
  if (c) return { permissions: new Set(c.permissions), approveLimit: c.approveLimit, entityScope: c.entityScope, roleName: c.name, custom: true };
  return { permissions: new Set(BUILTIN[u.role] ?? []), approveLimit: null, entityScope: null, roleName: u.role, custom: false };
}

export type CheckCtx = { amount?: number; tenantId?: string };
export type Decision = { allowed: boolean; permission: string; user: string; role: string; reasons: { ok: boolean; text: string }[] };
/** Explains a permission decision step by step. Used by requirePermission and the Permission check panel. */
export function explain(u: P.User | null, perm: string, c: CheckCtx = {}): Decision {
  const reasons: Decision["reasons"] = [];
  const d = (allowed: boolean): Decision => ({ allowed, permission: perm, user: u?.id ?? "anonymous", role: u ? grantOf(u).roleName : "none", reasons });
  if (!u) { reasons.push({ ok: false, text: "Nobody is signed in" }); return d(false); }
  if (u.active === false) { reasons.push({ ok: false, text: "This user is turned off" }); return d(false); }
  if (!(perm in PERMISSIONS)) { reasons.push({ ok: false, text: `${perm} is not a known permission` }); return d(false); }
  const g = grantOf(u);
  const has = g.permissions.has(perm as Permission);
  reasons.push({ ok: has, text: has ? `Role ${g.roleName} includes ${perm}` : `Role ${g.roleName} does not include ${perm}` });
  if (!has) return d(false);
  if (c.tenantId) {
    const own = P.canAccessTenant(u, c.tenantId);
    reasons.push({ ok: own, text: own ? `User may act in ${c.tenantId}` : `User belongs to another tenant than ${c.tenantId}` });
    if (!own) return d(false);
    if (g.entityScope) { const inScope = g.entityScope.includes(c.tenantId); reasons.push({ ok: inScope, text: inScope ? `${c.tenantId} is in the role entity scope` : `${c.tenantId} is outside the role entity scope` }); if (!inScope) return d(false); }
  }
  if (perm === "payments.approve" && c.amount !== undefined) {
    if (g.approveLimit === null) reasons.push({ ok: true, text: "Role has no amount limit" });
    else { const ok = c.amount <= g.approveLimit; reasons.push({ ok, text: ok ? `Amount ${c.amount} is within the limit of ${g.approveLimit}` : `Amount ${c.amount} is above the limit of ${g.approveLimit}` }); if (!ok) return d(false); }
  }
  return d(true);
}
export function requirePermission(u: P.User | null, perm: Permission, c: CheckCtx = {}): P.User {
  if (!u) throw new P.AuthError(401, "Sign in required");
  const r = explain(u, perm, c);
  if (!r.allowed) throw new P.AuthError(403, r.reasons.find((x) => !x.ok)?.text ?? `Needs ${perm}`);
  return u;
}
export const inEntityScope = (u: P.User, tenantId: string) => { const s = grantOf(u).entityScope; return !s || s.includes(tenantId); };

/** Separation of duties on one payment. An approver of the order may not release its payment. */
export function sodPay(u: P.User, po: { approval?: { levels: { approvals: { userId: string }[] }[] } | null; approvedBy?: string | null }) {
  const approved = po.approval?.levels.some((l) => l.approvals.some((a) => a.userId === u.id)) || po.approvedBy === u.id;
  if (approved) throw new P.AuthError(403, "Separation of duties: you approved this order, so another person must release the payment");
}

export const RoleInput = (tenantKind: "operator" | "client") => (x: any) => {
  const name = String(x?.name ?? "").trim(); if (name.length < 2 || name.length > 60) throw new P.AuthError(422, "Role name needs 2 to 60 characters");
  const base = String(x?.baseRole ?? (tenantKind === "client" ? "ap_clerk" : "auditor")) as P.Role;
  const allowedBase: P.Role[] = tenantKind === "client" ? ["client_admin", "approver", "ap_clerk"] : ["operator_admin", "auditor"];
  if (!allowedBase.includes(base)) throw new P.AuthError(422, `Base role must be one of ${allowedBase.join(", ")}`);
  const perms = Array.isArray(x?.permissions) ? x.permissions.map(String) : [];
  const pool: string[] = tenantKind === "client" ? CLIENT_PERMS : ALL_PERMS;
  const bad = perms.filter((p: string) => !pool.includes(p)); if (bad.length) throw new P.AuthError(422, `Not allowed here: ${bad.join(", ")}`);
  const lim = x?.approveLimit === null || x?.approveLimit === undefined || x?.approveLimit === "" ? null : Number(x.approveLimit);
  if (lim !== null && (!Number.isFinite(lim) || lim < 0)) throw new P.AuthError(422, "Amount limit must be a positive number or empty");
  const scope = Array.isArray(x?.entityScope) && x.entityScope.length ? x.entityScope.map(String) : null;
  return { name, baseRole: base, permissions: [...new Set(perms)] as Permission[], approveLimit: lim, entityScope: scope };
};
export function saveRole(actor: P.User, tenantId: string | null, input: any, id?: string): CustomRole {
  const v = RoleInput(tenantId ? "client" : "operator")(input);
  if (v.entityScope) for (const t of v.entityScope) { const x = P.getTenant(t); if (!x || x.kind !== "client" || (tenantId && t !== tenantId)) throw new P.AuthError(422, `Entity ${t} is not a business client you manage`); }
  if (id) {
    const old = getRole(id); if (!old || old.tenantId !== tenantId) throw new P.AuthError(404, "role not found");
    sql.prepare("UPDATE custom_roles SET name=?, base_role=?, permissions=?, approve_limit=?, entity_scope=? WHERE id=?").run(v.name, v.baseRole, JSON.stringify(v.permissions), v.approveLimit, v.entityScope ? JSON.stringify(v.entityScope) : null, id);
    sql.prepare("UPDATE users SET role = ? WHERE custom_role_id = ?").run(v.baseRole, id);
  } else {
    id = `role-${crypto.randomUUID().slice(0, 8)}`;
    sql.prepare("INSERT INTO custom_roles (id, tenant_id, name, base_role, permissions, approve_limit, entity_scope, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, tenantId, v.name, v.baseRole, JSON.stringify(v.permissions), v.approveLimit, v.entityScope ? JSON.stringify(v.entityScope) : null, actor.id, new Date().toISOString());
  }
  P.audit(actor.id, "role", id, "role.saved", v);
  return getRole(id)!;
}
export function deleteRole(actor: P.User, tenantId: string | null, id: string) {
  const r = getRole(id); if (!r || r.tenantId !== tenantId) throw new P.AuthError(404, "role not found");
  const n = (sql.prepare("SELECT COUNT(*) n FROM users WHERE custom_role_id = ?").get(id) as any).n;
  if (n) throw new P.AuthError(409, `${n} user(s) still hold this role. Move them first.`);
  sql.prepare("DELETE FROM custom_roles WHERE id = ?").run(id); P.audit(actor.id, "role", id, "role.deleted", {});
  return { ok: true };
}
/** Assigns a built-in role (by name) or a custom role (by id) to a user in the actor's tenant. */
export function assignRole(actor: P.User, userId: string, roleOrId: string) {
  const target = P.getUser(userId); if (!target) throw new P.AuthError(404, "user not found");
  if (!P.isOperator(actor) && target.tenantId !== actor.tenantId) throw new P.AuthError(403, "Not your tenant");
  if (target.id === actor.id) throw new P.AuthError(403, "You cannot change your own role");
  const custom = roleOrId.startsWith("role-") ? getRole(roleOrId) : null;
  if (custom) {
    if (custom.tenantId !== target.tenantId) throw new P.AuthError(422, "That role belongs to another tenant");
    sql.prepare("UPDATE users SET role = ?, custom_role_id = ? WHERE id = ?").run(custom.baseRole, custom.id, userId);
  } else {
    if (!(P.ROLES as readonly string[]).includes(roleOrId)) throw new P.AuthError(422, "Unknown role");
    const opRole = ["operator_admin", "auditor"].includes(roleOrId);
    if (target.tenantId && roleOrId === "operator_admin") throw new P.AuthError(422, "Client users cannot be operator admins");
    if (!target.tenantId && !opRole) throw new P.AuthError(422, "Operator users need an operator role");
    sql.prepare("UPDATE users SET role = ?, custom_role_id = NULL WHERE id = ?").run(roleOrId, userId);
  }
  P.audit(actor.id, "user", userId, "role.assigned", { role: roleOrId });
  return P.getUser(userId)!;
}

// Sessions

export const idleMs = () => (Number(process.env.SESSION_IDLE_MINUTES) || 30) * 60_000;
export const absoluteMs = () => (Number(process.env.SESSION_ABSOLUTE_HOURS) || 12) * 3_600_000;
export type Session = { id: string; userId: string; method: string; idpId: string | null; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null; revokedReason: string | null };
const toSession = (r: any): Session => ({ id: r.id, userId: r.user_id, method: r.method, idpId: r.idp_id, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason });
export function createSession(u: P.User, method: "demo" | "oidc" | "saml", o: { idpId?: string; idToken?: string; ip?: string; ua?: string } = {}, now = Date.now()) {
  const id = `ses_${crypto.randomBytes(24).toString("base64url")}`;
  const at = new Date(now).toISOString();
  sql.prepare("INSERT INTO sessions (id, user_id, method, idp_id, id_token, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, u.id, method, o.idpId ?? null, o.idToken ?? null, o.ip ?? null, (o.ua ?? "").slice(0, 200) || null, at, at, new Date(now + absoluteMs()).toISOString());
  P.audit(u.id, "user", u.id, "auth.login", { method, idp: o.idpId ?? null, role: u.role, session: id.slice(0, 12) });
  return id;
}
/** Resolves a session id to its user, applying idle and absolute timeouts. */
export function sessionUser(id: string, now = Date.now()): { user: P.User; session: Session } | null {
  const r = sql.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any; if (!r || r.revoked_at) return null;
  const s = toSession(r);
  const reason = now >= Date.parse(s.expiresAt) ? "absolute_timeout" : now - Date.parse(s.lastSeenAt) >= idleMs() ? "idle_timeout" : null;
  if (reason) { endSession(id, reason, null, now); return null; }
  const user = P.getUser(s.userId); if (!user || user.active === false) { endSession(id, "user_disabled", null, now); return null; }
  sql.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
  return { user, session: s };
}
export function endSession(id: string, reason: string, actor: string | null, now = Date.now()) {
  const r = sql.prepare("SELECT user_id, id_token, idp_id FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as any; if (!r) return null;
  sql.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(new Date(now).toISOString(), reason, id);
  P.audit(actor ?? r.user_id, "user", r.user_id, reason === "logout" ? "auth.logout" : reason.endsWith("timeout") ? "session.expired" : "session.revoked", { reason, session: id.slice(0, 12) });
  return { idToken: r.id_token as string | null, idpId: r.idp_id as string | null };
}
export function listSessions(viewer: P.User, all: boolean) {
  const rows = (sql.prepare("SELECT s.*, u.name, u.email, u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.revoked_at IS NULL ORDER BY s.last_seen_at DESC LIMIT 500").all() as any[]);
  const now = Date.now();
  return rows.filter((r) => r.user_id === viewer.id || (all && (P.isOperator(viewer) || r.tenant_id === viewer.tenantId)))
    .filter((r) => now < Date.parse(r.expires_at) && now - Date.parse(r.last_seen_at) < idleMs())
    .map((r) => ({ ...toSession(r), id: r.id.slice(0, 12), name: r.name, email: r.email, tenantId: r.tenant_id }));
}
/** Revoke by the 12 character id shown in the list. */
export function revokeSession(viewer: P.User, shortId: string, all: boolean) {
  const r = sql.prepare("SELECT s.id, s.user_id, u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE substr(s.id, 1, 12) = ? AND s.revoked_at IS NULL").get(shortId) as any;
  if (!r) throw new P.AuthError(404, "session not found");
  const mine = r.user_id === viewer.id; const may = mine || (all && (P.isOperator(viewer) || r.tenant_id === viewer.tenantId));
  if (!may) throw new P.AuthError(403, "You can only revoke your own sessions");
  endSession(r.id, "revoked", viewer.id); return { ok: true };
}

// Identity providers

const key = () => crypto.createHash("sha256").update(`${config.SESSION_SECRET}:idp-secrets`).digest();
export function seal(plain: string) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key(), iv); const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]); return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`; }
export function unseal(blob: string) { const [, iv, tag, ct] = blob.split("."); const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"); }

export type IdpConfig = { id: string; scope: string; issuer: string; clientId: string; groupRoleMap: Record<string, string>; enabled: boolean; updatedAt: string; hasSecret: boolean };
const toIdp = (r: any): IdpConfig => ({ id: r.id, scope: r.scope, issuer: r.issuer, clientId: r.client_id, groupRoleMap: JSON.parse(r.group_role_map), enabled: !!r.enabled, updatedAt: r.updated_at, hasSecret: !!r.client_secret_enc });
export const listIdps = () => (sql.prepare("SELECT * FROM idp_configs ORDER BY scope").all() as any[]).map(toIdp);
export const getIdp = (id: string) => { const r = sql.prepare("SELECT * FROM idp_configs WHERE id = ?").get(id) as any; return r ? { ...toIdp(r), secret: () => unseal(r.client_secret_enc) } : null; };
export const DEFAULT_GROUP_MAP: Record<string, string> = { operator_admin: "operator_admin", client_admin: "client_admin", approver: "approver", ap_clerk: "ap_clerk", auditor: "auditor" };

/** Seeds the platform IdP from OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET once. Later edits go through maker checker. */
export function seedIdp() {
  const iss = process.env.OIDC_ISSUER, id = process.env.OIDC_CLIENT_ID, sec = process.env.OIDC_CLIENT_SECRET;
  if (!iss || !id || !sec || getIdp("idp-platform")) return;
  sql.prepare("INSERT INTO idp_configs (id, scope, issuer, client_id, client_secret_enc, group_role_map, enabled, updated_at) VALUES (?,?,?,?,?,?,1,?)")
    .run("idp-platform", "platform", iss.replace(/\/$/, ""), id, seal(sec), JSON.stringify(DEFAULT_GROUP_MAP), new Date().toISOString());
}

P.registerChangeKind("identity.oidc", {
  role: "operator_admin",
  validate: (p) => {
    if (!p || typeof p !== "object") throw new P.AuthError(422, "payload required");
    if (!(p.scope === "platform" || P.getTenant(p.scope)?.kind === "bank")) throw new P.AuthError(422, "Scope must be platform or a bank tenant id");
    try { const u = new URL(String(p.issuer)); if (!["http:", "https:"].includes(u.protocol)) throw 0; } catch { throw new P.AuthError(422, "Issuer must be a URL"); }
    if (!String(p.clientId ?? "").trim()) throw new P.AuthError(422, "Client id required");
    if (p.groupRoleMap && typeof p.groupRoleMap !== "object") throw new P.AuthError(422, "Group to role map must be an object");
    for (const v of Object.values(p.groupRoleMap ?? {})) if (!(P.ROLES as readonly string[]).includes(String(v)) && !getRole(String(v))) throw new P.AuthError(422, `Unknown role ${v} in group map`);
    // Never keep a plain secret in the change queue.
    if (p.clientSecret) { p.clientSecretSealed = seal(String(p.clientSecret)); delete p.clientSecret; }
    if (!p.clientSecretSealed && !(p.id && getIdp(p.id))) throw new P.AuthError(422, "Client secret required for a new provider");
  },
  apply: (p) => {
    const id = p.id ?? `idp-${p.scope}`; const old = sql.prepare("SELECT client_secret_enc FROM idp_configs WHERE id = ?").get(id) as any;
    sql.prepare("INSERT INTO idp_configs (id, scope, issuer, client_id, client_secret_enc, group_role_map, enabled, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, issuer=excluded.issuer, client_id=excluded.client_id, client_secret_enc=excluded.client_secret_enc, group_role_map=excluded.group_role_map, enabled=excluded.enabled, updated_at=excluded.updated_at")
      .run(id, p.scope, String(p.issuer).replace(/\/$/, ""), String(p.clientId).trim(), p.clientSecretSealed ?? old?.client_secret_enc, JSON.stringify(p.groupRoleMap ?? DEFAULT_GROUP_MAP), p.enabled === false ? 0 : 1, new Date().toISOString());
    discoveryCache.delete(id); return toIdp(sql.prepare("SELECT * FROM idp_configs WHERE id = ?").get(id));
  },
});
export const discoveryCache = new Map<string, unknown>();

const ROLE_RANK: P.Role[] = ["operator_admin", "client_admin", "approver", "ap_clerk", "auditor"];
export type Mapped = { sub: string; email: string; name: string; tenantId: string | null; role: P.Role; customRoleId: string | null };
/** Maps ID token claims (sub, email, name, tenant, groups) to a tenant and role using the provider's group map. */
export function mapClaims(claims: Record<string, unknown>, idp: Pick<IdpConfig, "scope" | "groupRoleMap">): Mapped {
  const sub = String(claims.sub ?? ""); const email = String(claims.email ?? "").toLowerCase();
  if (!sub || !email) throw new P.AuthError(403, "The identity provider did not send sub and email");
  const tenantClaim = String(claims.tenant ?? "");
  if (!tenantClaim) throw new P.AuthError(403, "The identity provider did not send a tenant claim");
  let tenantId: string | null = null;
  if (tenantClaim === "operator") { if (idp.scope !== "platform") throw new P.AuthError(403, "Only the platform identity provider can sign in operator staff"); }
  else {
    const t = P.getTenant(tenantClaim);
    if (!t || t.kind !== "client") throw new P.AuthError(403, `Tenant ${tenantClaim} is not a business client`);
    if (idp.scope !== "platform" && t.parentId !== idp.scope) throw new P.AuthError(403, `Tenant ${tenantClaim} is not a client of ${idp.scope}`);
    tenantId = t.id;
  }
  const groups = (Array.isArray(claims.groups) ? claims.groups : []).map((g) => String(g).replace(/^\//, ""));
  const targets = groups.map((g) => idp.groupRoleMap[g]).filter(Boolean);
  const custom = targets.map((x) => (x.startsWith("role-") ? getRole(x) : null)).find((r) => r && r.tenantId === tenantId) ?? null;
  const allowed: P.Role[] = tenantId ? ["client_admin", "approver", "ap_clerk"] : ["operator_admin", "auditor"];
  const builtin = ROLE_RANK.find((r) => targets.includes(r) && allowed.includes(r));
  if (!custom && !builtin) throw new P.AuthError(403, `No group maps to a role allowed for ${tenantClaim}. Groups were: ${groups.join(", ") || "none"}`);
  const name = String(claims.name ?? ([claims.given_name, claims.family_name].filter(Boolean).join(" ") || email));
  return { sub, email, name, tenantId, role: custom ? custom.baseRole : builtin!, customRoleId: custom?.id ?? null };
}
/** Just in time provisioning: find by subject or email, then refresh tenant and role from the IdP. */
export function provision(m: Mapped, idpId: string): P.User {
  const r = (sql.prepare("SELECT id, active FROM users WHERE ext_sub = ?").get(`${idpId}:${m.sub}`) ?? sql.prepare("SELECT id, active FROM users WHERE lower(email) = ?").get(m.email)) as any;
  if (r && !r.active) throw new P.AuthError(403, "This user is turned off");
  if (r) sql.prepare("UPDATE users SET tenant_id = ?, role = ?, custom_role_id = ?, name = ?, ext_sub = ? WHERE id = ?").run(m.tenantId, m.role, m.customRoleId, m.name, `${idpId}:${m.sub}`, r.id);
  const id = r?.id ?? `usr-${crypto.randomUUID().slice(0, 8)}`;
  if (!r) sql.prepare("INSERT INTO users (id, tenant_id, name, email, role, custom_role_id, ext_sub, source) VALUES (?,?,?,?,?,?,?,'oidc')").run(id, m.tenantId, m.name, m.email, m.role, m.customRoleId, `${idpId}:${m.sub}`);
  P.audit(id, "user", id, r ? "user.jit_updated" : "user.jit_created", { idp: idpId, tenantId: m.tenantId, role: m.role, customRoleId: m.customRoleId });
  return P.getUser(id)!;
}

// SCIM tokens

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export function issueScimToken(actor: P.User, tenantId: string) {
  const plain = `scim_${crypto.randomBytes(24).toString("base64url")}`; const id = `scm-${crypto.randomUUID().slice(0, 8)}`;
  sql.prepare("INSERT INTO scim_tokens (id, tenant_id, prefix, hash, created_by, created_at) VALUES (?,?,?,?,?,?)").run(id, tenantId, plain.slice(0, 10), sha(plain), actor.id, new Date().toISOString());
  P.audit(actor.id, "scim_token", id, "scim.token_issued", { tenantId });
  return { id, token: plain, note: "Copy this token now. It is shown only once." };
}
export const listScimTokens = (tenantId: string) => sql.prepare("SELECT id, tenant_id tenantId, prefix, created_by createdBy, created_at createdAt, last_used_at lastUsedAt, revoked_at revokedAt FROM scim_tokens WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId);
export function revokeScimToken(actor: P.User, tenantId: string, id: string) {
  const n = sql.prepare("UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id, tenantId).changes;
  if (!n) throw new P.AuthError(404, "token not found"); P.audit(actor.id, "scim_token", id, "scim.token_revoked", {}); return { ok: true };
}
export function scimTenant(authorization: string | undefined): string | null {
  const t = /^Bearer (scim_\S+)$/.exec(String(authorization ?? ""))?.[1]; if (!t) return null;
  const r = sql.prepare("SELECT id, tenant_id FROM scim_tokens WHERE hash = ? AND revoked_at IS NULL").get(sha(t)) as any; if (!r) return null;
  sql.prepare("UPDATE scim_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
  return r.tenant_id;
}
