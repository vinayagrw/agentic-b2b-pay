/** Pure helpers for the live home widgets. No React, so they are easy to test. */

export type Confidence = { key: "match" | "route" | "risk"; label: string; value: number | null; basis: string };
export type ConfidenceTone = "ok" | "warn" | "bad" | "neutral";
/** High confidence is 75 and above, low is below 40. */
export const confidenceTone = (v: number | null): ConfidenceTone => (v === null ? "neutral" : v >= 75 ? "ok" : v >= 40 ? "warn" : "bad");
export const confidenceWord = (v: number | null) => (v === null ? "No data" : v >= 75 ? "High" : v >= 40 ? "Medium" : "Low");

type Intent = { id: string; kind?: string; status: string; amount: number; rail?: string | null; route?: { rail?: string | null } | null; invoiceId?: string };

/** Payment count and amount by rail. Unrouted payments sit under "none". */
export function railMix(intents: Intent[]) {
  const m = new Map<string, { rail: string; count: number; amount: number }>();
  for (const i of intents) {
    if (i.kind === "refund") continue;
    const rail = i.rail ?? i.route?.rail ?? "none"; const row = m.get(rail) ?? { rail, count: 0, amount: 0 };
    row.count++; row.amount = Math.round((row.amount + i.amount) * 100) / 100; m.set(rail, row);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

export const STATUS_GROUPS = ["settled", "in_flight", "blocked", "failed"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];
export const groupOf = (s: string): StatusGroup => (s === "settled" ? "settled" : s === "failed" ? "failed" : /blocked|denied|rejected/.test(s) ? "blocked" : "in_flight");

/** Spend per supplier split by status group, top suppliers by total first. */
export function spendByStatus(intents: Intent[], invoices: { id: string; supplierId: string }[], suppliers: { id: string; name: string }[], top = 6) {
  const inv = new Map(invoices.map((i) => [i.id, i.supplierId])); const name = new Map(suppliers.map((s) => [s.id, s.name]));
  const rows = new Map<string, Record<StatusGroup, number> & { supplier: string; total: number }>();
  for (const i of intents) {
    if (i.kind === "refund") continue;
    const sid = inv.get(i.invoiceId ?? "") ?? "unknown"; const supplier = name.get(sid) ?? sid;
    const r = rows.get(supplier) ?? { supplier, total: 0, settled: 0, in_flight: 0, blocked: 0, failed: 0 };
    const g = groupOf(i.status); r[g] = Math.round((r[g] + i.amount) * 100) / 100; r.total = Math.round((r.total + i.amount) * 100) / 100; rows.set(supplier, r);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total).slice(0, top);
}

/** SVG arc path for a donut slice between two fractions of a turn. */
export function arcPath(from: number, to: number, r: number, inner: number, c = r) {
  const span = Math.min(to - from, 0.9999);
  const pt = (f: number, rad: number) => { const a = 2 * Math.PI * f - Math.PI / 2; return `${(c + rad * Math.cos(a)).toFixed(2)} ${(c + rad * Math.sin(a)).toFixed(2)}`; };
  const end = from + span; const large = span > 0.5 ? 1 : 0;
  return `M ${pt(from, r)} A ${r} ${r} 0 ${large} 1 ${pt(end, r)} L ${pt(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${pt(from, inner)} Z`;
}
/** Start and end fractions for each value. */
export function slices(values: number[]) {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0); let at = 0;
  return values.map((v) => { const f = total ? Math.max(0, v) / total : 0; const s = { from: at, to: at + f, share: f }; at += f; return s; });
}

export type ActivityItem = { id: string; seq: number; at: string; kind: "payment" | "approval" | "agent" | "risk" | "mandate"; event: string; title: string; subjectId: string; paymentId: string | null };
/** Newest first, no duplicates, bounded. */
export function mergeActivity(cur: ActivityItem[], fresh: ActivityItem[], max = 40) {
  const seen = new Set<string>(); const out: ActivityItem[] = [];
  for (const a of [...fresh, ...cur].sort((x, y) => y.seq - x.seq)) { if (seen.has(a.id)) continue; seen.add(a.id); out.push(a); if (out.length >= max) break; }
  return out;
}

/** Short preview of a JSON value for a collapsed tree node. */
export function preview(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") { const k = Object.keys(v as object); return `{${k.length} key${k.length === 1 ? "" : "s"}}`; }
  if (typeof v === "string") return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
  return String(v);
}
