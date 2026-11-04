/** Saved table views per user, and CSV exports for the list pages. Every export reads the same tenant scoped rows as the page. */
import crypto from "node:crypto";
import { sql } from "./db.js";
import { db, scoped } from "./modules/store.js";
import * as P from "./platform.js";
import * as Risk from "./risk.js";
import * as W from "./workspace.js";
import { HttpError } from "./service.js";

export const TABLE_KEYS = ["payments", "approvals", "suppliers", "ledger", "risk"] as const;
export type View = { id: string; table: string; name: string; state: { filter?: string; hidden?: string[]; sort?: { id: string; desc: boolean }[]; status?: string }; createdAt: string };

const cleanState = (x: any): View["state"] => ({
  filter: typeof x?.filter === "string" ? x.filter.slice(0, 200) : undefined,
  hidden: Array.isArray(x?.hidden) ? x.hidden.map(String).slice(0, 40) : undefined,
  sort: Array.isArray(x?.sort) ? x.sort.slice(0, 4).map((s: any) => ({ id: String(s?.id ?? ""), desc: !!s?.desc })) : undefined,
  status: typeof x?.status === "string" ? x.status.slice(0, 40) : undefined,
});
const toView = (r: any): View => ({ id: r.id, table: r.table_key, name: r.name, state: JSON.parse(r.state), createdAt: r.created_at });

export function listViews(u: P.User, table: string): View[] {
  return (sql.prepare("SELECT * FROM saved_views WHERE user_id = ? AND table_key = ? ORDER BY created_at").all(u.id, table) as any[]).map(toView);
}
export function saveView(u: P.User, x: any): View {
  const table = String(x?.table ?? ""); if (!(TABLE_KEYS as readonly string[]).includes(table)) throw new HttpError(422, "Unknown table");
  const name = String(x?.name ?? "").trim().slice(0, 60); if (!name) throw new HttpError(422, "Give the view a name");
  if ((sql.prepare("SELECT COUNT(*) n FROM saved_views WHERE user_id = ?").get(u.id) as any).n >= 100) throw new HttpError(409, "Too many saved views");
  const id = `vw-${crypto.randomBytes(5).toString("hex")}`;
  sql.prepare("INSERT INTO saved_views (id, user_id, table_key, name, state, created_at) VALUES (?,?,?,?,?,?)").run(id, u.id, table, name, JSON.stringify(cleanState(x?.state)), new Date().toISOString());
  return toView(sql.prepare("SELECT * FROM saved_views WHERE id = ?").get(id));
}
export function deleteView(u: P.User, id: string) {
  const r = sql.prepare("DELETE FROM saved_views WHERE id = ? AND user_id = ?").run(id, u.id);
  if (!r.changes) throw new HttpError(404, "view not found");
  return { ok: true };
}

// CSV

const cell = (v: unknown) => { const s = v == null ? "" : String(v); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const supName = (id: string) => db.suppliers.find((s) => s.id === id)?.name ?? id;

/** Builds one CSV. ids limits the rows to a selection. client is the business client for client only tables. */
export function exportCsv(kind: string, scope: string | null, u: P.User, client: () => string, ids?: Set<string>): string {
  const pick = <T>(rows: T[], id: (r: T) => string) => (ids?.size ? rows.filter((r) => ids.has(id(r))) : rows);
  if (kind === "payments") {
    const st = scoped(scope); Risk.ensureScores(st.intents);
    const rows = pick([...st.intents].reverse(), (i) => i.id);
    return toCsv(["payment_id", "tenant", "kind", "status", "amount_usd", "rail", "env", "supplier", "invoice", "risk_score", "risk_level", "provider_ref", "created_at", "reason"],
      rows.map((i) => { const inv = st.invoices.find((x) => x.id === i.invoiceId); return [i.id, i.tenantId ?? "tnt-acme", i.kind ?? "payment", i.status, i.amount, i.rail ?? i.route?.rail ?? "", i.env ?? "", inv ? supName(inv.supplierId) : "", i.invoiceId, i.risk?.score ?? "", i.risk?.level ?? "", i.providerRef ?? "", i.createdAt ?? "", i.blockedReason ?? ""]; }));
  }
  if (kind === "approvals") {
    const rows = pick(W.approvalsInbox(u, client()) as any[], (p) => p.id);
    return toCsv(["po_id", "status", "supplier", "total", "category", "maker", "rule", "level", "created_at"],
      rows.map((p) => [p.id, p.status, p.supplier, p.total, p.category, p.maker?.name ?? p.agent, p.approval?.ruleName ?? "", p.approval ? `${Math.min(p.approval.current + 1, p.approval.levels.length)} of ${p.approval.levels.length}` : "", p.createdAt ?? ""]));
  }
  if (kind === "suppliers") {
    const rows = pick(W.suppliersView(client()) as any[], (s) => s.id);
    return toCsv(["supplier_id", "name", "status", "country", "preferred_rail", "accepted_rails", "screening", "erp", "currency"],
      rows.map((s) => [s.id, s.name, s.status, db.orgs.find((o) => o.id === s.orgId)?.country ?? "", s.preferredRail, s.acceptedRails.join(" "), s.screeningStatus, s.erp, s.currency ?? "USD"]));
  }
  if (kind === "ledger") {
    const js = pick(scoped(scope).journals, (j) => j.id);
    return toCsv(["journal_id", "entity", "created_at", "memo", "ref", "account", "debit", "credit", "currency", "orig_amount", "orig_currency"],
      js.flatMap((j) => j.entries.map((e) => [j.id, j.entityId ?? "", j.createdAt, j.memo, j.ref, e.account, e.debit, e.credit, e.currency, e.origAmount ?? "", e.origCurrency ?? ""])));
  }
  if (kind === "risk") {
    const rows = pick(Risk.inbox(scope), (r) => r.paymentId);
    return toCsv(["payment_id", "tenant", "supplier", "amount_usd", "status", "rail", "score", "level", "reasons", "review", "review_reason", "decided_by", "decided_at"],
      rows.map((r) => [r.paymentId, r.tenantId, r.supplier, r.amount, r.status, r.rail ?? "", r.score, r.level, r.reasons.map((x) => x.label).join(" | "), r.review, r.reviewReason ?? "", r.decidedBy ?? "", r.decidedAt ?? ""]));
  }
  throw new HttpError(404, "Unknown export");
}
