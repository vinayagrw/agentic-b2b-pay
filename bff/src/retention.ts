import crypto from "node:crypto";
import { sql } from "./db.js";
import { db, save, tenantOf } from "./modules/store.js";
import type { EvidenceRecord } from "./modules/store.js";
import { verifyChain, GENESIS } from "./modules/evidence.js";
import * as P from "./platform.js";
import * as S from "./service.js";

/** Gap 9: retention policies, legal holds, a manual purge, audit export and chain verification. Sandbox data only. */
export const RECORD_TYPES = ["events", "audit", "invoices", "payments"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export type Policy = { recordType: RecordType; days: number | null; updatedBy: string | null; updatedAt: string | null };
export type Hold = { id: string; tenantId: string; caseId: string | null; reason: string; placedBy: string; placedAt: string; releasedBy: string | null; releasedAt: string | null };

const DAY = 86_400_000;
const opOnly = (u: P.User) => { if (!P.isOperator(u)) throw new P.AuthError(403, "Operators only"); return u; };

export function policies(): Policy[] {
  const rows = new Map((sql.prepare("SELECT * FROM retention_policies").all() as any[]).map((r) => [r.record_type, r]));
  return RECORD_TYPES.map((t) => { const r = rows.get(t); return { recordType: t, days: r?.days ?? null, updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null }; });
}
export function setPolicy(u: P.User, recordType: string, days: unknown): Policy {
  opOnly(u);
  if (!RECORD_TYPES.includes(recordType as RecordType)) throw new S.HttpError(422, `Record type must be one of ${RECORD_TYPES.join(", ")}`);
  const d = days === null || days === "" || days === undefined ? null : Number(days);
  if (d !== null && (!Number.isInteger(d) || d < 1 || d > 36500)) throw new S.HttpError(422, "Days must be a whole number from 1 to 36500, or empty to keep forever");
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO retention_policies (record_type, days, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(record_type) DO UPDATE SET days = excluded.days, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(recordType, d, u.id, at);
  P.audit(u.id, "retention", recordType, "retention.policy_set", { recordType, days: d });
  return policies().find((p) => p.recordType === recordType)!;
}

const toHold = (r: any): Hold => ({ id: r.id, tenantId: r.tenant_id, caseId: r.case_id, reason: r.reason, placedBy: r.placed_by, placedAt: r.placed_at, releasedBy: r.released_by, releasedAt: r.released_at });
export const holds = (activeOnly = false): Hold[] => (sql.prepare(`SELECT * FROM legal_holds ${activeOnly ? "WHERE released_at IS NULL" : ""} ORDER BY placed_at DESC`).all() as any[]).map(toHold);
export function placeHold(u: P.User, input: { tenantId?: unknown; caseId?: unknown; reason?: unknown }): Hold {
  opOnly(u);
  const reason = String(input.reason ?? "").trim(); if (reason.length < 3) throw new S.HttpError(422, "Give a reason for the hold");
  const caseId = input.caseId ? String(input.caseId) : null;
  let tenantId = input.tenantId ? String(input.tenantId) : "";
  if (caseId) { const c = S.getCase(caseId); if (!c) throw new S.HttpError(404, "case not found"); if (tenantId && tenantId !== tenantOf(c)) throw new S.HttpError(422, "That case belongs to another client"); tenantId = tenantOf(c); }
  const t = P.getTenant(tenantId); if (!t || t.kind !== "client") throw new S.HttpError(422, "Pick a business client");
  const h: Hold = { id: `hold-${crypto.randomUUID().slice(0, 8)}`, tenantId, caseId, reason, placedBy: u.id, placedAt: new Date().toISOString(), releasedBy: null, releasedAt: null };
  sql.prepare("INSERT INTO legal_holds (id, tenant_id, case_id, reason, placed_by, placed_at) VALUES (?,?,?,?,?,?)").run(h.id, h.tenantId, h.caseId, h.reason, h.placedBy, h.placedAt);
  P.audit(u.id, "legal_hold", h.id, "legal_hold.placed", { tenantId, caseId, reason });
  return h;
}
export function releaseHold(u: P.User, id: string): Hold {
  opOnly(u);
  const r = sql.prepare("SELECT * FROM legal_holds WHERE id = ?").get(id); if (!r) throw new S.HttpError(404, "hold not found");
  const h = toHold(r); if (h.releasedAt) throw new S.HttpError(409, "This hold is already released");
  const at = new Date().toISOString();
  sql.prepare("UPDATE legal_holds SET released_by = ?, released_at = ? WHERE id = ?").run(u.id, at, id);
  P.audit(u.id, "legal_hold", id, "legal_hold.released", { tenantId: h.tenantId, caseId: h.caseId });
  return { ...h, releasedBy: u.id, releasedAt: at };
}

/** The client a link belongs to, or null for platform links. */
export function auditTenant(r: EvidenceRecord): string | null {
  const p = (r.payload ?? {}) as any;
  if (typeof p.tenantId === "string") return p.tenantId;
  const id = r.subjectId;
  const hit = db.invoices.find((x) => x.id === id) ?? db.intents.find((x) => x.id === id) ?? db.pos.find((x) => x.id === id) ?? db.suppliers.find((x) => x.id === id);
  if (hit) return tenantOf(hit);
  if (r.subjectType === "case") { const c = S.getCase(id); if (c) return tenantOf(c); }
  const actor = typeof p.actor === "string" ? P.getUser(p.actor) : null;
  return actor?.tenantId ?? null;
}

/** What active holds protect: whole clients, and the records named by held cases. */
function heldScope() {
  const tenants = new Set<string>(); const ids = new Set<string>();
  for (const h of holds(true)) {
    if (!h.caseId) { tenants.add(h.tenantId); continue; }
    const c = S.getCase(h.caseId); if (!c) continue;
    ids.add(c.id);
    if (c.intentId) { ids.add(c.intentId); const i = db.intents.find((x) => x.id === c.intentId); if (i) ids.add(i.invoiceId); }
  }
  return { tenants, ids };
}

export type PurgeResult = { id: string; ranAt: string; ranBy: string; removed: Record<RecordType, number>; skippedForHold: Record<RecordType, number>; removedIds: Record<RecordType, string[]> };
const zero = () => ({ events: 0, audit: 0, invoices: 0, payments: 0 });
const DONE_PAY = new Set(["settled", "failed", "denied", "returned"]);

/** Removes records older than each policy allows. Held records stay. The run itself is audited. */
export function purge(u: P.User, now = Date.now()): PurgeResult {
  opOnly(u);
  const pol = new Map(policies().map((p) => [p.recordType, p.days]));
  const cutoff = (t: RecordType) => { const d = pol.get(t); return d == null ? null : new Date(now - d * DAY).toISOString(); };
  const { tenants, ids } = heldScope();
  const removed = zero(); const skipped = zero(); const removedIds: PurgeResult["removedIds"] = { events: [], audit: [], invoices: [], payments: [] };
  const held = (tenant: string | null, ...refs: (string | null | undefined)[]) => (tenant !== null && tenants.has(tenant)) || refs.some((r) => r && ids.has(r));

  const ce = cutoff("events");
  if (ce) for (const e of sql.prepare("SELECT id, tenant_id, data FROM events WHERE created_at < ?").all(ce) as any[]) {
    const refs = [...ids].filter((x) => e.data.includes(x));
    if (held(e.tenant_id, ...refs)) { skipped.events++; continue; }
    sql.prepare("DELETE FROM events WHERE id = ?").run(e.id); removed.events++; removedIds.events.push(e.id);
  }
  const cp = cutoff("payments");
  if (cp) db.intents = db.intents.filter((i) => {
    if (!i.createdAt || i.createdAt >= cp || !DONE_PAY.has(i.status)) return true;
    if (held(tenantOf(i), i.id, i.invoiceId)) { skipped.payments++; return true; }
    removed.payments++; removedIds.payments.push(i.id); return false;
  });
  const ci = cutoff("invoices");
  if (ci) db.invoices = db.invoices.filter((inv) => {
    const date = inv.invoiceDate ?? inv.dueDate;
    if (!date || date >= ci || !(inv.paid || inv.supersededBy)) return true;
    if (held(tenantOf(inv), inv.id)) { skipped.invoices++; return true; }
    if (db.intents.some((i) => i.invoiceId === inv.id && !DONE_PAY.has(i.status))) return true;
    removed.invoices++; removedIds.invoices.push(inv.id); return false;
  });
  // The audit chain is trimmed from the oldest end only, so what stays still verifies from the anchor.
  const ca = cutoff("audit");
  if (ca) {
    let n = 0;
    while (n < db.evidence.length - 1) {
      const r = db.evidence[n]; if (r.createdAt >= ca) break;
      if (held(auditTenant(r), r.subjectId)) { skipped.audit++; break; }
      n++;
    }
    if (n) {
      const gone = db.evidence.splice(0, n); const last = gone[gone.length - 1];
      db.auditAnchor = { seq: last.seq, hash: last.hash, at: new Date(now).toISOString() };
      removed.audit = n; removedIds.audit = gone.map((g) => g.id);
    }
  }
  const res: PurgeResult = { id: `purge-${crypto.randomUUID().slice(0, 8)}`, ranAt: new Date(now).toISOString(), ranBy: u.id, removed, skippedForHold: skipped, removedIds };
  sql.prepare("INSERT INTO purge_runs (id, ran_by, ran_at, data) VALUES (?,?,?,?)").run(res.id, u.id, res.ranAt, JSON.stringify(res));
  save();
  P.audit(u.id, "retention", res.id, "retention.purged", { removed, skippedForHold: skipped, removedIds: Object.fromEntries(Object.entries(removedIds).map(([k, v]) => [k, v.slice(0, 200)])) });
  return res;
}
export const purgeRuns = (limit = 20): PurgeResult[] => (sql.prepare("SELECT data FROM purge_runs ORDER BY ran_at DESC LIMIT ?").all(limit) as any[]).map((r) => JSON.parse(r.data));

/** Audit links for one client and date range, one JSON object per line. */
export function exportJsonl(tenantId: string, from?: string, to?: string): string {
  const f = from ? new Date(from).toISOString() : ""; const t = to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to).toISOString() : "￿";
  return db.evidence.filter((r) => r.createdAt >= f && r.createdAt <= t && auditTenant(r) === tenantId).map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Walks the stored chain (SQLite, not memory) from the purge anchor and names the first broken link. */
export function verify() {
  const rows = (sql.prepare("SELECT data FROM audit ORDER BY seq").all() as { data: string }[]).map((r) => JSON.parse(r.data) as EvidenceRecord);
  const anchor = db.auditAnchor ?? null;
  const v = verifyChain(rows, anchor?.hash ?? GENESIS);
  const bad = v.brokenAt == null ? null : rows.find((r) => r.seq === v.brokenAt) ?? null;
  return { valid: v.valid, brokenAt: v.brokenAt, brokenId: bad?.id ?? null, brokenEvent: bad?.event ?? null, checked: rows.length, firstSeq: rows[0]?.seq ?? null, lastSeq: rows[rows.length - 1]?.seq ?? null, anchor, checkedAt: new Date().toISOString() };
}

export function view() {
  return { policies: policies(), holds: holds(), runs: purgeRuns(), anchor: db.auditAnchor ?? null, recordTypes: RECORD_TYPES, mode: "Sandbox. Purge is started by hand in this demo." };
}
