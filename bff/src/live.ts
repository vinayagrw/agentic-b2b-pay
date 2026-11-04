import { db, scoped, tenantOf } from "./modules/store.js";
import type { PaymentIntent } from "./modules/store.js";
import { sql } from "./db.js";
import * as S from "./service.js";
import * as Risk from "./risk.js";

/**
 * Confidence, pulse and activity views. Every number here is derived from stored records, never invented.
 * Confidence is a 0 to 100 reading of how much headroom a decision had, with the inputs spelled out in `basis`.
 */
export type Confidence = { key: "match" | "route" | "risk"; label: string; value: number | null; basis: string };
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Match: share of the price tolerance left unused. An exception is zero. */
export function matchConfidence(m: { status: string; tolerancePct: number; totals: { variancePct: number } } | undefined): Confidence {
  if (!m) return { key: "match", label: "Invoice match", value: null, basis: "No 3 way match has run yet." };
  const v = Math.abs(m.totals.variancePct); const t = m.tolerancePct;
  if (m.status !== "matched") return { key: "match", label: "Invoice match", value: 0, basis: `Match raised an exception. Total variance ${v.toFixed(2)} percent against a tolerance of ${t} percent.` };
  const value = t > 0 ? clamp(100 * (1 - v / t)) : v === 0 ? 100 : 0;
  return { key: "match", label: "Invoice match", value, basis: `Total variance ${v.toFixed(2)} percent against a tolerance of ${t} percent, so ${value} percent of the tolerance is unused.` };
}

/** Route: how far the chosen rail's router score is ahead of the next eligible rail. */
export function routeConfidence(r: { rail: string | null; options: { rail: string; eligible: boolean; score: number }[] } | undefined): Confidence {
  if (!r) return { key: "route", label: "Rail choice", value: null, basis: "The router has not run for this payment yet." };
  if (!r.rail) return { key: "route", label: "Rail choice", value: 0, basis: "No rail was eligible, the payment is held for treasury review." };
  const ranked = r.options.filter((o) => o.eligible).sort((a, b) => b.score - a.score);
  const best = ranked.find((o) => o.rail === r.rail) ?? ranked[0]; const next = ranked.find((o) => o !== best);
  if (!best) return { key: "route", label: "Rail choice", value: null, basis: "Router options were not stored." };
  if (!next) return { key: "route", label: "Rail choice", value: 100, basis: `${best.rail} was the only eligible rail, router score ${best.score}.` };
  const value = best.score > 0 ? clamp((100 * (best.score - next.score)) / best.score) : 0;
  return { key: "route", label: "Rail choice", value, basis: `${best.rail} scored ${best.score}, next best ${next.rail} scored ${next.score}. Confidence is the lead as a share of the winning score.` };
}

/** Risk: 100 minus the stored rule based risk score. */
export function riskConfidence(k: { score: number; level: string } | undefined): Confidence {
  if (!k) return { key: "risk", label: "Risk", value: null, basis: "No risk score is stored for this payment yet." };
  return { key: "risk", label: "Risk", value: clamp(100 - k.score), basis: `Risk score ${k.score} of 100 (${k.level}). Confidence is 100 minus the score, review starts at score ${Risk.REVIEW_AT}.` };
}

export function confidenceForPayment(pi: PaymentIntent): Confidence[] {
  const inv = db.invoices.find((i) => i.id === pi.invoiceId);
  return [matchConfidence(inv?.match), routeConfidence(pi.route), riskConfidence(pi.risk)];
}
/** For a purchase order, use the latest payment made against it when one exists. */
export function confidenceForPo(poId: string): Confidence[] {
  const inv = db.invoices.filter((i) => i.poId === poId).at(-1);
  const pi = inv && db.intents.filter((x) => x.invoiceId === inv.id && x.kind !== "refund").at(-1);
  if (pi) return confidenceForPayment(pi);
  return [matchConfidence(inv?.match), routeConfidence(undefined), riskConfidence(undefined)];
}

// Pulse

let floatCache: { at: number; tenant: string; value: { total: number; rails: number; errors: number } } | null = null;
async function floatFor(tenant: string) {
  if (floatCache && floatCache.tenant === tenant && Date.now() - floatCache.at < 30_000) return floatCache.value;
  const bs = await S.railBalances(tenant);
  const value = { total: Math.round(bs.reduce((a, b: any) => a + (typeof b.amount === "number" ? b.amount : 0), 0) * 100) / 100, rails: bs.filter((b: any) => typeof b.amount === "number").length, errors: bs.filter((b: any) => b.error).length };
  floatCache = { at: Date.now(), tenant, value }; return value;
}
export const resetFloatCache = () => { floatCache = null; };

export type RailHealth = { rail: string; label: string; state: "ok" | "degraded" | "down" | "off"; attempts: number; failed: number };
/** Rail health over the last 24 hours: off when not configured, down when every attempt failed, degraded above 20 percent failures. */
export function railHealth(tenant: string, intents: PaymentIntent[], now = Date.now()): RailHealth[] {
  const since = now - 864e5;
  return S.railsView(tenant).map((r) => {
    const recent = intents.filter((i) => (i.rail ?? i.route?.rail) === r.rail && i.kind !== "refund" && Date.parse(i.createdAt ?? "1970") >= since && ["settled", "failed", "submitted", "pending"].includes(i.status));
    const failed = recent.filter((i) => i.status === "failed").length;
    const state: RailHealth["state"] = !r.configured ? "off" : recent.length && failed === recent.length ? "down" : recent.length && failed / recent.length > 0.2 ? "degraded" : "ok";
    return { rail: r.rail, label: r.label, state, attempts: recent.length, failed };
  });
}

export async function pulse(tenant: string, scope: string | null, now = Date.now()) {
  const d = scoped(scope); const since = now - 864e5;
  const day = d.intents.filter((i) => i.kind !== "refund" && Date.parse(i.createdAt ?? "1970") >= since);
  const failed = day.filter((i) => i.status === "failed").length;
  const decided = day.filter((i) => ["settled", "failed"].includes(i.status)).length;
  Risk.ensureScores(d.intents);
  return {
    at: new Date(now).toISOString(),
    rails: railHealth(tenant, d.intents, now),
    queue: { approvals: d.pos.filter((p) => p.status === "pending_approval").length, risk: Risk.inbox(scope, { status: "open" }).length },
    failures: { failed, attempts: decided, ratePct: decided ? Math.round((failed / decided) * 1000) / 10 : 0 },
    float: await floatFor(tenant),
  };
}

// Activity

export type ActivityKind = "payment" | "approval" | "agent" | "risk" | "mandate";
export type Activity = { id: string; seq: number; at: string; kind: ActivityKind; event: string; title: string; subjectId: string; paymentId: string | null };
export function kindOf(subjectType: string, event: string): ActivityKind | null {
  if (/^risk\./.test(event)) return "risk";
  if (/approv/.test(event)) return "approval";
  if (subjectType === "mandate" || /mandate|^ap2\./.test(event)) return "mandate";
  if (subjectType === "agent" || /^llm\.|^agent\.|^kya\./.test(event)) return "agent";
  if (subjectType === "payment" || subjectType === "webhook") return "payment";
  return null;
}
const titleOf = (event: string) => { const t = event.replace(/[._]/g, " "); return t[0].toUpperCase() + t.slice(1); };

export function activity(scope: string | null, opts: { limit?: number; afterSeq?: number } = {}): Activity[] {
  const d = scoped(scope); const limit = Math.min(200, opts.limit ?? 30);
  const mandates = new Set(d.mandates.map((m: any) => m.id)); const intents = new Set(d.intents.map((i) => i.id));
  const pool = scope ? db.evidence.filter((e) => d.evidence.includes(e) || mandates.has(e.subjectId) || (e.subjectType === "webhook" && intents.has((e.payload as any)?.intentId))) : db.evidence;
  const out: Activity[] = [];
  for (let n = pool.length - 1; n >= 0 && out.length < limit; n--) {
    const e = pool[n]; if (opts.afterSeq !== undefined && e.seq <= opts.afterSeq) break;
    const kind = kindOf(e.subjectType, e.event); if (!kind) continue;
    const pid = e.subjectType === "payment" ? e.subjectId : e.subjectType === "webhook" ? ((e.payload as any)?.intentId ?? null) : null;
    out.push({ id: e.id, seq: e.seq, at: e.createdAt, kind, event: e.event, title: titleOf(e.event), subjectId: e.subjectId, paymentId: pid });
  }
  return out;
}

/** Provider webhook records and stored payloads for one payment, for the payload viewer. */
export function payloadsFor(pi: PaymentIntent) {
  const rows = sql.prepare("SELECT provider, event_id, type, received_at FROM provider_events WHERE intent_id = ? ORDER BY received_at").all(pi.id) as any[];
  const hooks = db.evidence.filter((e) => e.subjectType === "webhook" && (e.payload as any)?.intentId === pi.id);
  return {
    webhooks: rows.map((r) => ({ provider: r.provider, eventId: r.event_id, type: r.type, receivedAt: r.received_at, record: hooks.find((h) => h.subjectId === r.event_id)?.payload ?? null })),
    records: db.evidence.filter((e) => e.subjectId === pi.id).map((e) => ({ id: e.id, event: e.event, at: e.createdAt, payload: e.payload })),
    route: pi.route ?? null, tenantId: tenantOf(pi),
  };
}
