import { sql } from "./db.js";

/** Domain events that tenants can receive on their webhook endpoints. Filled in by the developers module. */
type Sink = (tenantId: string, type: string, data: unknown) => void;
const sinks: Sink[] = [];
export function onPublish(fn: Sink) { sinks.push(fn); }
export function publish(tenantId: string, type: string, data: unknown) {
  for (const s of sinks) { try { s(tenantId, type, data); } catch { /* a sink must not break the payment path */ } }
}
export const hasTable = (t: string) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
