/** SCIM 2.0 basic: Users and Groups for one client tenant, authenticated by a per tenant bearer token. */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "./db.js";
import * as P from "./platform.js";
import * as I from "./iam.js";

const U = "urn:ietf:params:scim:schemas:core:2.0:User", G = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse", ERR = "urn:ietf:params:scim:api:messages:2.0:Error", PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export class ScimError extends Error { constructor(public status: number, msg: string, public scimType?: string) { super(msg); } }
const BUILTIN_GROUPS: P.Role[] = ["client_admin", "approver", "ap_clerk"];

const groupsOf = (u: P.User) => { const c = u.customRoleId ? I.getRole(u.customRoleId) : null; return [c ? { value: c.id, display: c.name } : { value: u.role, display: u.role }]; };
const userRes = (u: P.User) => ({ schemas: [U], id: u.id, userName: u.email, displayName: u.name, name: { formatted: u.name }, active: u.active !== false, emails: [{ value: u.email, primary: true }], groups: groupsOf(u), meta: { resourceType: "User", location: `/scim/v2/Users/${u.id}` } });
const tenantUsers = (t: string) => P.listUsers().filter((u) => u.tenantId === t);
const mustUser = (t: string, id: string) => { const u = P.getUser(id); if (!u || u.tenantId !== t) throw new ScimError(404, "User not found"); return u; };

type Group = { id: string; displayName: string; role: P.Role; customRoleId: string | null };
const tenantGroups = (t: string): Group[] => [...BUILTIN_GROUPS.map((r) => ({ id: r, displayName: r, role: r, customRoleId: null })), ...I.listRoles(t).map((r) => ({ id: r.id, displayName: r.name, role: r.baseRole, customRoleId: r.id }))];
const members = (t: string, g: Group) => tenantUsers(t).filter((u) => (g.customRoleId ? u.customRoleId === g.customRoleId : !u.customRoleId && u.role === g.role));
const groupRes = (t: string, g: Group) => ({ schemas: [G], id: g.id, displayName: g.displayName, members: members(t, g).map((u) => ({ value: u.id, display: u.email })), meta: { resourceType: "Group", location: `/scim/v2/Groups/${g.id}` } });
const mustGroup = (t: string, id: string) => { const g = tenantGroups(t).find((x) => x.id === id); if (!g) throw new ScimError(404, "Group not found"); return g; };
const setMembership = (u: P.User, g: Group | null) => sql.prepare("UPDATE users SET role = ?, custom_role_id = ? WHERE id = ?").run(g ? g.role : "ap_clerk", g?.customRoleId ?? null, u.id);

/** Supports `attr eq "value"` filters on userName, displayName and externalId style lookups. */
function filterBy<T extends Record<string, any>>(rows: T[], filter: string | undefined, fields: Record<string, (x: T) => string>) {
  if (!filter) return rows;
  const m = /^\s*(\w+)\s+eq\s+"([^"]*)"\s*$/i.exec(filter); if (!m) throw new ScimError(400, "Only attr eq \"value\" filters are supported", "invalidFilter");
  const f = fields[m[1]]; if (!f) throw new ScimError(400, `Cannot filter on ${m[1]}`, "invalidFilter");
  return rows.filter((r) => f(r).toLowerCase() === m[2].toLowerCase());
}
const page = (all: any[], q: any) => { const start = Math.max(1, Number(q?.startIndex) || 1); const count = Math.min(200, Math.max(0, Number(q?.count ?? 100) || 0)); const res = all.slice(start - 1, start - 1 + count); return { schemas: [LIST], totalResults: all.length, startIndex: start, itemsPerPage: res.length, Resources: res }; };

/** Reads the active flag from a PATCH body. Accepts path form and value object form, as Entra ID and Okta send. */
export function patchActive(body: any): boolean | undefined {
  if (!Array.isArray(body?.Operations)) throw new ScimError(400, "PatchOp needs Operations", "invalidSyntax");
  let active: boolean | undefined;
  for (const op of body.Operations) {
    const kind = String(op.op ?? "").toLowerCase(); if (!["replace", "add"].includes(kind)) throw new ScimError(400, `Unsupported op ${op.op}`, "invalidValue");
    const v = op.path ? (String(op.path) === "active" ? op.value : undefined) : op.value?.active;
    if (op.path && String(op.path) !== "active") throw new ScimError(400, `Only the active attribute can be patched`, "noTarget");
    if (v !== undefined) active = v === true || String(v).toLowerCase() === "true";
  }
  return active;
}

export function registerScim(app: FastifyInstance) {
  app.addContentTypeParser("application/scim+json", { parseAs: "buffer" }, (_req, body: Buffer, done) => { try { done(null, body.length ? JSON.parse(body.toString("utf8")) : {}); } catch (e: any) { e.statusCode = 400; done(e, undefined); } });
  app.register(async (s) => {
    s.addHook("preHandler", async (req: any) => { const t = I.scimTenant(req.headers.authorization); if (!t) throw new ScimError(401, "Valid SCIM bearer token required"); req.scimTenant = t; });
    s.setErrorHandler((err: any, _req, reply) => { const status = err instanceof ScimError || err instanceof P.AuthError ? err.status : err.statusCode ?? 500; reply.status(status).type("application/scim+json").send({ schemas: [ERR], status: String(status), detail: err.message, scimType: err.scimType }); });
    s.addHook("onSend", async (_req, reply, payload) => { if (String(reply.getHeader("content-type") ?? "").startsWith("application/json")) reply.type("application/scim+json"); return payload; });
    const T = (req: any) => req.scimTenant as string;
    s.get("/Users", async (req: any) => page(filterBy(tenantUsers(T(req)), req.query?.filter, { userName: (u) => u.email, displayName: (u) => u.name }).map(userRes), req.query));
    s.get("/Users/:id", async (req: any) => userRes(mustUser(T(req), req.params.id)));
    s.post("/Users", async (req: any, reply) => {
      const x = req.body ?? {}; const email = String(x.userName ?? x.emails?.[0]?.value ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ScimError(400, "userName must be an email address", "invalidValue");
      if (P.getUserByEmail(email)) throw new ScimError(409, "A user with this userName exists", "uniqueness");
      const name = String(x.displayName ?? x.name?.formatted ?? ([x.name?.givenName, x.name?.familyName].filter(Boolean).join(" ") || email));
      const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
      sql.prepare("INSERT INTO users (id, tenant_id, name, email, role, active, source) VALUES (?,?,?,?,?,?,'scim')").run(id, T(req), name, email, "ap_clerk", x.active === false ? 0 : 1);
      P.audit("scim", "user", id, "scim.user_created", { tenantId: T(req), email });
      return reply.status(201).send(userRes(P.getUser(id)!));
    });
    s.patch("/Users/:id", async (req: any) => {
      const u = mustUser(T(req), req.params.id); const active = patchActive(req.body);
      if (active !== undefined) {
        sql.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, u.id);
        if (!active) for (const r of sql.prepare("SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL").all(u.id) as any[]) I.endSession(r.id, "user_disabled", "scim");
        P.audit("scim", "user", u.id, active ? "scim.user_activated" : "scim.user_deactivated", {});
      }
      return userRes(P.getUser(u.id)!);
    });
    s.delete("/Users/:id", async (req: any, reply) => {
      const u = mustUser(T(req), req.params.id);
      for (const r of sql.prepare("SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL").all(u.id) as any[]) I.endSession(r.id, "user_deleted", "scim");
      // Keep the row for the evidence trail, turn it off and free the email.
      sql.prepare("UPDATE users SET active = 0, email = ? WHERE id = ?").run(`deleted+${u.id}@scim.invalid`, u.id);
      P.audit("scim", "user", u.id, "scim.user_deleted", { email: u.email });
      return reply.status(204).send();
    });
    s.get("/Groups", async (req: any) => page(filterBy(tenantGroups(T(req)), req.query?.filter, { displayName: (g) => g.displayName }).map((g) => groupRes(T(req), g)), req.query));
    s.get("/Groups/:id", async (req: any) => groupRes(T(req), mustGroup(T(req), req.params.id)));
    s.post("/Groups", async (req: any, reply) => {
      const name = String(req.body?.displayName ?? "").trim(); if (!name) throw new ScimError(400, "displayName required", "invalidValue");
      if (tenantGroups(T(req)).some((g) => g.displayName.toLowerCase() === name.toLowerCase())) throw new ScimError(409, "Group exists", "uniqueness");
      const r = I.saveRole({ id: "scim", tenantId: T(req), name: "SCIM", email: "", role: "client_admin" }, T(req), { name, baseRole: "ap_clerk", permissions: I.BUILTIN.ap_clerk });
      const g = mustGroup(T(req), r.id);
      for (const m of req.body?.members ?? []) setMembership(mustUser(T(req), String(m.value)), g);
      return reply.status(201).send(groupRes(T(req), g));
    });
    s.patch("/Groups/:id", async (req: any) => {
      const g = mustGroup(T(req), req.params.id);
      if (!Array.isArray(req.body?.Operations)) throw new ScimError(400, "PatchOp needs Operations", "invalidSyntax");
      for (const op of req.body.Operations) {
        const kind = String(op.op).toLowerCase();
        const filt = /^members\[value eq "([^"]+)"\]$/.exec(String(op.path ?? ""));
        const vals: string[] = filt ? [filt[1]] : (Array.isArray(op.value) ? op.value : op.value?.members ?? []).map((m: any) => String(m.value));
        if (kind === "add") for (const v of vals) setMembership(mustUser(T(req), v), g);
        else if (kind === "remove") for (const v of vals) { const u = mustUser(T(req), v); if (members(T(req), g).some((m) => m.id === u.id)) setMembership(u, null); }
        else if (kind === "replace") { for (const u of members(T(req), g)) setMembership(u, null); for (const v of vals) setMembership(mustUser(T(req), v), g); }
        else throw new ScimError(400, `Unsupported op ${op.op}`, "invalidValue");
      }
      P.audit("scim", "group", g.id, "scim.group_patched", {});
      return groupRes(T(req), g);
    });
    s.delete("/Groups/:id", async (req: any, reply) => {
      const g = mustGroup(T(req), req.params.id); if (!g.customRoleId) throw new ScimError(400, "Built in groups cannot be deleted", "mutability");
      for (const u of members(T(req), g)) setMembership(u, null);
      I.deleteRole({ id: "scim", tenantId: T(req), name: "SCIM", email: "", role: "client_admin" }, T(req), g.customRoleId);
      return reply.status(204).send();
    });
  }, { prefix: "/scim/v2" });
}
