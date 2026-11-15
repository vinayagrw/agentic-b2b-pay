/**
 * Approval delegation. An approver hands their approvals to another user with the approver role for a date range.
 * The delegate still acts as themselves: their own amount limit, step-up and separation of duties apply.
 */
import crypto from "node:crypto";
import { sql } from "./db.js";
import * as P from "./platform.js";
import * as I from "./iam.js";

export type Delegation = { id: string; tenantId: string; fromUser: string; fromName: string; toUser: string; toName: string; startsOn: string; endsOn: string; note: string; createdBy: string; createdAt: string; revokedBy: string | null; revokedAt: string | null; state: "active" | "upcoming" | "ended" | "revoked" };

const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const nameOf = (id: string) => P.getUser(id)?.name ?? id;
const view = (r: any): Delegation => {
  const d = today();
  const state = r.revoked_at ? "revoked" : r.ends_on < d ? "ended" : r.starts_on > d ? "upcoming" : "active";
  return { id: r.id, tenantId: r.tenant_id, fromUser: r.from_user, fromName: nameOf(r.from_user), toUser: r.to_user, toName: nameOf(r.to_user), startsOn: r.starts_on, endsOn: r.ends_on, note: r.note, createdBy: r.created_by, createdAt: r.created_at, revokedBy: r.revoked_by, revokedAt: r.revoked_at, state };
};

/** Delegations in force today that hand approvals to this user. */
export function activeFor(toUser: string, tenantId: string, on = today()): Delegation[] {
  return (sql.prepare("SELECT * FROM approval_delegations WHERE tenant_id = ? AND to_user = ? AND revoked_at IS NULL AND starts_on <= ? AND ends_on >= ? ORDER BY created_at").all(tenantId, toUser, on, on) as any[]).map(view);
}

/** Delegations the user gave or received in this tenant. Admins with roles.manage see all of them. */
export function list(u: P.User, tenantId: string) {
  const all = I.grantOf(u).permissions.has("roles.manage");
  const rows = (all ? sql.prepare("SELECT * FROM approval_delegations WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId)
    : sql.prepare("SELECT * FROM approval_delegations WHERE tenant_id = ? AND (from_user = ? OR to_user = ?) ORDER BY created_at DESC").all(tenantId, u.id, u.id)) as any[];
  const candidates = P.listUsers().filter((x) => x.tenantId === tenantId && x.id !== u.id && x.role === "approver" && x.active !== false).map((x) => ({ id: x.id, name: x.name }));
  return { delegations: rows.map(view), candidates };
}

export function create(u: P.User, tenantId: string, x: any): Delegation {
  I.requirePermission(u, "payments.approve", { tenantId });
  const toUser = String(x?.toUserId ?? "").trim(); const startsOn = String(x?.startsOn ?? ""); const endsOn = String(x?.endsOn ?? "");
  const note = String(x?.note ?? "").trim().slice(0, 300);
  if (!toUser) throw new P.AuthError(422, "Pick who will approve for you");
  if (toUser === u.id) throw new P.AuthError(422, "You cannot hand approvals to yourself");
  const to = P.getUser(toUser);
  if (!to || to.tenantId !== tenantId) throw new P.AuthError(422, "That person is not in this business");
  if (to.active === false) throw new P.AuthError(422, "That person is turned off");
  if (to.role !== "approver" || !I.grantOf(to).permissions.has("payments.approve")) throw new P.AuthError(422, "The person must have the approver role");
  if (!DATE.test(startsOn) || !DATE.test(endsOn) || Number.isNaN(Date.parse(startsOn)) || Number.isNaN(Date.parse(endsOn))) throw new P.AuthError(422, "Dates must be YYYY-MM-DD");
  if (endsOn < startsOn) throw new P.AuthError(422, "The end date must be on or after the start date");
  if (endsOn < today()) throw new P.AuthError(422, "The end date is in the past");
  if ((Date.parse(endsOn) - Date.parse(startsOn)) / 864e5 > 90) throw new P.AuthError(422, "A hand over can last 90 days at most");
  const overlap = sql.prepare("SELECT id FROM approval_delegations WHERE tenant_id = ? AND from_user = ? AND to_user = ? AND revoked_at IS NULL AND starts_on <= ? AND ends_on >= ?").get(tenantId, u.id, toUser, endsOn, startsOn);
  if (overlap) throw new P.AuthError(409, "You already hand approvals to this person for some of these dates");
  const id = `dlg-${crypto.randomUUID().slice(0, 8)}`; const at = new Date().toISOString();
  sql.prepare("INSERT INTO approval_delegations (id, tenant_id, from_user, to_user, starts_on, ends_on, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, tenantId, u.id, toUser, startsOn, endsOn, note, u.id, at);
  P.audit(u.id, "approval_delegation", id, "approval.delegated", { tenantId, from: u.id, to: toUser, startsOn, endsOn, note });
  return view(sql.prepare("SELECT * FROM approval_delegations WHERE id = ?").get(id));
}

export function revoke(u: P.User, tenantId: string, id: string): Delegation {
  const r = sql.prepare("SELECT * FROM approval_delegations WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
  if (!r) throw new P.AuthError(404, "Hand over not found");
  if (r.from_user !== u.id && !I.grantOf(u).permissions.has("roles.manage")) throw new P.AuthError(403, "Only the person who handed over approvals, or an admin, can end it");
  if (r.revoked_at) throw new P.AuthError(409, "This hand over is already ended");
  const at = new Date().toISOString();
  sql.prepare("UPDATE approval_delegations SET revoked_by = ?, revoked_at = ? WHERE id = ?").run(u.id, at, id);
  P.audit(u.id, "approval_delegation", id, "approval.delegation_revoked", { tenantId, from: r.from_user, to: r.to_user });
  return view(sql.prepare("SELECT * FROM approval_delegations WHERE id = ?").get(id));
}
