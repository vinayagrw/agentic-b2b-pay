// Email notice outbox in mock mode. Rows are stored only. Nothing is ever sent.
import crypto from "node:crypto";
import { sql } from "./db.js";

export type NoticeKind = "payment_sent" | "invoice_received" | "dispute_opened";
export type Notice = { id: string; tenantId: string; kind: NoticeKind; audience: "buyer" | "supplier"; supplierId: string | null; refId: string | null; subject: string; body: string; mode: "mock"; createdAt: string };

export function queueNotice(n: Omit<Notice, "id" | "mode" | "createdAt">): Notice {
  const x: Notice = { ...n, id: `ntc-${crypto.randomUUID().slice(0, 8)}`, mode: "mock", createdAt: new Date().toISOString() };
  sql.prepare("INSERT INTO notice_outbox (id, tenant_id, kind, audience, supplier_id, ref_id, subject, body, mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(x.id, x.tenantId, x.kind, x.audience, x.supplierId, x.refId, x.subject, x.body, x.mode, x.createdAt);
  return x;
}
export function listNotices(tenantId: string, limit = 200): Notice[] {
  return (sql.prepare("SELECT * FROM notice_outbox WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(tenantId, limit) as any[])
    .map((r) => ({ id: r.id, tenantId: r.tenant_id, kind: r.kind, audience: r.audience, supplierId: r.supplier_id, refId: r.ref_id, subject: r.subject, body: r.body, mode: r.mode, createdAt: r.created_at }));
}
