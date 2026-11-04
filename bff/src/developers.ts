import crypto from "node:crypto";
import { sql } from "./db.js";
import { onPublish, hasTable } from "./hooks.js";
import * as P from "./platform.js";
import * as S from "./service.js";

const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const err = (s: number, m: string) => new S.HttpError(s, m);
export const EVENT_TYPES = ["payment.settled", "payment.failed", "payment.refunded", "purchase_order.approved", "supplier.verified", "case.opened"] as const;

// API keys

export function createApiKey(user: P.User, tenantId: string, label: string, role: "ap_clerk" | "auditor") {
  if (!label.trim()) throw err(422, "Give the key a label");
  if (!["ap_clerk", "auditor"].includes(role)) throw err(422, "Role must be ap_clerk or auditor");
  const plain = `bpk_test_${crypto.randomBytes(24).toString("hex")}`; const id = `key-${crypto.randomUUID().slice(0, 8)}`;
  sql.prepare("INSERT INTO api_keys (id, tenant_id, label, role, prefix, hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, tenantId, label.trim().slice(0, 60), role, plain.slice(0, 14), sha(plain), user.id, now());
  P.audit(user.id, "api_key", id, "api_key.created", { tenantId, role, prefix: plain.slice(0, 14) });
  return { id, key: plain, prefix: plain.slice(0, 14) };
}
export const listApiKeys = (tenantId: string) => sql.prepare("SELECT id, label, role, prefix, created_by createdBy, created_at createdAt, last_used_at lastUsedAt, revoked_at revokedAt FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId);
export function revokeApiKey(user: P.User, tenantId: string, id: string) {
  const n = sql.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL").run(now(), id, tenantId).changes;
  if (!n) throw err(404, "Active key not found"); P.audit(user.id, "api_key", id, "api_key.revoked", {}); return { ok: true };
}
/** The user a tenant API key acts as. Only the hash is looked up. */
export function apiKeyUser(plain: string): P.User | null {
  const r = sql.prepare("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL").get(sha(plain)) as any; if (!r) return null;
  sql.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), r.id);
  return { id: `apikey:${r.id}`, tenantId: r.tenant_id, name: `API key ${r.label}`, email: "", role: r.role };
}

// Webhook endpoints

export function validUrl(u: string) {
  let x: URL; try { x = new URL(u); } catch { return "That is not a URL"; }
  if (x.protocol === "https:") return null;
  if (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)) return null;
  return "Use https, or http on localhost for testing";
}
export function createEndpoint(user: P.User, tenantId: string, url: string, events: string[]) {
  const bad = validUrl(url); if (bad) throw err(422, bad);
  const ev = events.filter((e) => (EVENT_TYPES as readonly string[]).includes(e));
  const id = `we-${crypto.randomUUID().slice(0, 8)}`; const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  sql.prepare("INSERT INTO webhook_endpoints (id, tenant_id, url, secret, events, created_by, created_at) VALUES (?,?,?,?,?,?,?)").run(id, tenantId, url, secret, JSON.stringify(ev), user.id, now());
  P.audit(user.id, "webhook_endpoint", id, "webhook_endpoint.created", { url, events: ev });
  return { id, url, events: ev, secret };
}
export const listEndpoints = (tenantId: string) => (sql.prepare("SELECT id, url, events, active, created_at createdAt FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId) as any[]).map((r) => ({ ...r, events: JSON.parse(r.events), active: !!r.active,
  stats: sql.prepare("SELECT status, COUNT(*) n FROM webhook_deliveries WHERE endpoint_id = ? GROUP BY status").all(r.id) }));
export function setEndpointActive(user: P.User, tenantId: string, id: string, active: boolean) {
  const n = sql.prepare("UPDATE webhook_endpoints SET active = ? WHERE id = ? AND tenant_id = ?").run(active ? 1 : 0, id, tenantId).changes;
  if (!n) throw err(404, "endpoint not found"); P.audit(user.id, "webhook_endpoint", id, active ? "webhook_endpoint.enabled" : "webhook_endpoint.disabled", {}); return { ok: true };
}
export function deleteEndpoint(user: P.User, tenantId: string, id: string) {
  const n = sql.prepare("DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?").run(id, tenantId).changes;
  if (!n) throw err(404, "endpoint not found"); sql.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint deleted' WHERE endpoint_id = ? AND status = 'pending'").run(id);
  P.audit(user.id, "webhook_endpoint", id, "webhook_endpoint.deleted", {}); return { ok: true };
}

// Events and deliveries

/** Stores the event and queues a delivery for each subscribed endpoint. */
export function recordEvent(tenantId: string, type: string, data: unknown, onlyEndpoint?: string) {
  if (!hasTable("events")) return null;
  const id = `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`; const at = now();
  sql.prepare("INSERT INTO events (id, tenant_id, type, data, created_at) VALUES (?,?,?,?,?)").run(id, tenantId, type, JSON.stringify(data), at);
  const eps = sql.prepare("SELECT id, events FROM webhook_endpoints WHERE tenant_id = ? AND active = 1").all(tenantId) as any[];
  for (const e of eps) {
    if (onlyEndpoint ? e.id !== onlyEndpoint : JSON.parse(e.events).length && !JSON.parse(e.events).includes(type)) continue;
    sql.prepare("INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(`whd-${crypto.randomUUID().slice(0, 10)}`, e.id, id, "pending", 0, at, at);
  }
  return id;
}
onPublish((t, type, data) => { recordEvent(t, type, data); });

export function sign(secret: string, ts: number, body: string) { return crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"); }
/** Receiver side check, shown on the developer page and used in tests. */
export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const ts = Number(parts.t); if (!ts || Math.abs(nowSec - ts) > toleranceSec) return false;
  const want = sign(secret, ts, body); const got = parts.v1 ?? "";
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
/** Seconds to wait after each failed attempt. After the last one the delivery is failed. */
export const BACKOFF_SEC = [10, 60, 300, 1800, 7200];
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;
export async function deliverDue(fetchImpl: Fetch = fetch as any, at = new Date()) {
  const due = sql.prepare("SELECT d.*, e.url, e.secret, v.type, v.data, v.created_at, v.tenant_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id JOIN events v ON v.id = d.event_id WHERE d.status = 'pending' AND d.next_at <= ? ORDER BY d.next_at LIMIT 25").all(at.toISOString()) as any[];
  for (const d of due) {
    const body = JSON.stringify({ id: d.event_id, type: d.type, created: d.created_at, tenant: d.tenant_id, data: JSON.parse(d.data) });
    const ts = Math.floor(at.getTime() / 1000);
    let status: number | null = null; let error: string | null = null;
    try {
      const r = await fetchImpl(d.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "agentic-b2b-pay-webhooks", "x-b2bpay-event": d.type, "x-b2bpay-delivery": d.id, "x-b2bpay-signature": `t=${ts},v1=${sign(d.secret, ts, body)}` }, body, signal: AbortSignal.timeout(8000) });
      status = r.status; if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}`;
    } catch (e: any) { error = String(e?.message ?? e).slice(0, 200); }
    const attempts = d.attempts + 1;
    if (!error) sql.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(attempts, status, at.toISOString(), d.id);
    else if (attempts > BACKOFF_SEC.length) sql.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(attempts, status, error, at.toISOString(), d.id);
    else sql.prepare("UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?").run(attempts, status, error, new Date(at.getTime() + BACKOFF_SEC[attempts - 1] * 1000).toISOString(), at.toISOString(), d.id);
  }
  return due.length;
}
export function retryDelivery(tenantId: string, id: string) {
  const n = sql.prepare("UPDATE webhook_deliveries SET status = 'pending', next_at = ?, updated_at = ? WHERE id = ? AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE tenant_id = ?)").run(now(), now(), id, tenantId).changes;
  if (!n) throw err(404, "delivery not found"); return { ok: true };
}
export function eventLog(tenantId: string, limit = 100) {
  const evs = sql.prepare("SELECT * FROM events WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(tenantId, limit) as any[];
  return evs.map((e) => ({ id: e.id, type: e.type, createdAt: e.created_at, data: JSON.parse(e.data),
    deliveries: sql.prepare("SELECT id, endpoint_id endpointId, status, attempts, next_at nextAt, last_status lastStatus, last_error lastError, updated_at updatedAt FROM webhook_deliveries WHERE event_id = ?").all(e.id) }));
}
let worker: ReturnType<typeof setInterval> | null = null;
export function startWebhookWorker(ms: number) {
  if (worker || ms <= 0) return; let busy = false;
  worker = setInterval(async () => { if (busy) return; busy = true; try { await deliverDue(); } catch { /* next tick */ } finally { busy = false; } }, ms); worker.unref?.();
}
