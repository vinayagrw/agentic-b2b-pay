/** Rule based payment risk. Deterministic, no model: the same stored records always give the same score and reasons.
 * Scores are stored on the payment. Reviews (clear with a reason, or escalate) are stored in risk_reviews. */
import { sql } from "./db.js";
import { db, save, scoped, tenantOf } from "./modules/store.js";
import type { PaymentIntent, RiskReason, RiskScore } from "./modules/store.js";
import { appendEvidence } from "./modules/evidence.js";
import * as P from "./platform.js";
import { HttpError } from "./service.js";

const DAY = 864e5;
/** Countries treated as high risk payment corridors. FATF high risk and other monitored jurisdictions. */
export const HIGH_RISK_COUNTRIES = ["IR", "KP", "MM", "SY", "CU", "RU", "BY", "VE", "AF", "YE"];
export const REVIEW_AT = 30;
export const POINTS = { new_supplier: 20, amount_spike: 25, payee_change: 30, odd_hour: 10, velocity: 15, first_rail: 10, high_risk_corridor: 30 } as const;
const PAYEE_EVENTS = new Set(["payee_change.applied", "payee.changed"]);
const LIVE = new Set(["created", "routed", "submitted", "pending", "settled"]);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const levelOf = (score: number): RiskScore["level"] => (score >= 60 ? "high" : score >= REVIEW_AT ? "medium" : "low");
const supplierOf = (pi: PaymentIntent) => { const inv = db.invoices.find((i) => i.id === pi.invoiceId); return inv ? db.suppliers.find((s) => s.id === inv.supplierId) : undefined; };

/** Scores one payment against the stored history before it. */
export function scorePayment(pi: PaymentIntent): RiskScore {
  const at = new Date(pi.createdAt ?? new Date().toISOString()).getTime();
  const sup = supplierOf(pi);
  const reasons: RiskReason[] = [];
  const add = (code: RiskReason["code"], label: string, detail: string) => reasons.push({ code, label, points: POINTS[code], detail });
  const tenant = tenantOf(pi);
  const prior = db.intents.filter((x) => x.id !== pi.id && x.kind !== "refund" && tenantOf(x) === tenant && new Date(x.createdAt ?? 0).getTime() < at);
  const priorSup = sup ? prior.filter((x) => supplierOf(x)?.id === sup.id && LIVE.has(x.status)) : [];

  // New supplier: first seen under 30 days ago. Seeded suppliers have no first seen date and count as established.
  const since = sup?.onboarding?.invitedAt ?? (sup as any)?.createdAt;
  if (since) { const days = Math.floor((at - new Date(since).getTime()) / DAY); if (days < 30) add("new_supplier", "New supplier", `${sup!.name} was added ${days} day${days === 1 ? "" : "s"} ago, under the 30 day mark`); }

  // Amount spike: more than 3 times the average of at least 2 earlier payments to the same supplier.
  if (priorSup.length >= 2) { const avg = priorSup.reduce((a, x) => a + x.amount, 0) / priorSup.length; if (pi.amount > avg * 3) add("amount_spike", "Amount spike", `${money(pi.amount)} is ${(pi.amount / avg).toFixed(1)} times the ${money(avg)} average of ${priorSup.length} earlier payments`); }

  // Bank or wallet change in the last 30 days.
  if (sup) { const ch = db.evidence.filter((e) => e.subjectId === sup.id && PAYEE_EVENTS.has(e.event) && at - new Date(e.createdAt).getTime() < 30 * DAY && new Date(e.createdAt).getTime() <= at + 60_000).at(-1);
    if (ch) add("payee_change", "Bank or wallet change", `${sup.name} changed bank or wallet details on ${ch.createdAt.slice(0, 10)}`); }

  // Odd hour: created between 22:00 and 06:00 UTC.
  const h = new Date(at).getUTCHours();
  if (h >= 22 || h < 6) add("odd_hour", "Odd hour", `Created at ${String(h).padStart(2, "0")}:00 UTC, outside 06:00 to 22:00`);

  // Velocity: 3 or more other payments in the same tenant in the 15 minutes before.
  const recent = prior.filter((x) => at - new Date(x.createdAt ?? 0).getTime() <= 15 * 60_000);
  if (recent.length >= 3) add("velocity", "Velocity", `${recent.length} other payments in the 15 minutes before this one`);

  // First payment to this supplier on this rail.
  const rail = pi.rail ?? pi.route?.rail ?? null;
  if (rail && sup && !priorSup.some((x) => (x.rail ?? x.route?.rail) === rail)) add("first_rail", "First payment on rail", `First payment to ${sup.name} by ${rail}`);

  // High risk corridor: supplier country is on the monitored list.
  const country = sup ? db.orgs.find((o) => o.id === sup.orgId)?.country : undefined;
  if (country && HIGH_RISK_COUNTRIES.includes(country)) add("high_risk_corridor", "High risk corridor", `Supplier is registered in ${country}, a monitored corridor`);

  const score = Math.min(100, reasons.reduce((a, r) => a + r.points, 0));
  return { score, level: levelOf(score), reasons, scoredAt: new Date().toISOString(), rail };
}

/** Stores a fresh score on the payment and writes it to the evidence chain. */
export function scoreAndStore(pi: PaymentIntent) {
  pi.risk = scorePayment(pi);
  appendEvidence(db.evidence, "payment", pi.id, "risk.scored", { score: pi.risk.score, level: pi.risk.level, reasons: pi.risk.reasons.map((r) => r.code) });
  save(); return pi.risk;
}
/** Scores payments that have no score yet, or whose rail changed since scoring. */
export function ensureScores(intents: PaymentIntent[]) {
  let n = 0;
  for (const pi of intents) if (pi.kind !== "refund" && (!pi.risk || pi.risk.rail !== (pi.rail ?? pi.route?.rail ?? null))) { pi.risk = scorePayment(pi); n++; }
  if (n) save();
}

export type Review = { paymentId: string; tenantId: string; status: "cleared" | "escalated"; reason: string; decidedBy: string; decidedAt: string };
export function reviewOf(paymentId: string): Review | null {
  const r = sql.prepare("SELECT * FROM risk_reviews WHERE payment_id = ?").get(paymentId) as any;
  return r ? { paymentId: r.payment_id, tenantId: r.tenant_id, status: r.status, reason: r.reason, decidedBy: r.decided_by, decidedAt: r.decided_at } : null;
}

export type InboxRow = { paymentId: string; tenantId: string; supplier: string; amount: number; status: string; rail: string | null; createdAt: string | null; score: number; level: RiskScore["level"]; reasons: RiskReason[]; review: "open" | "cleared" | "escalated"; reviewReason: string | null; decidedBy: string | null; decidedAt: string | null };
/** Payments at or above the review mark, inside the tenant scope. */
export function inbox(scope: string | null, filter: { status?: string } = {}): InboxRow[] {
  const intents = scoped(scope).intents.filter((x) => x.kind !== "refund");
  ensureScores(intents);
  const rows = intents.filter((x) => (x.risk?.score ?? 0) >= REVIEW_AT).map((x): InboxRow => {
    const r = reviewOf(x.id); const sup = supplierOf(x);
    return { paymentId: x.id, tenantId: tenantOf(x), supplier: sup?.name ?? "", amount: x.amount, status: x.status, rail: x.rail ?? x.route?.rail ?? null, createdAt: x.createdAt ?? null, score: x.risk!.score, level: x.risk!.level, reasons: x.risk!.reasons,
      review: r?.status ?? "open", reviewReason: r?.reason ?? null, decidedBy: r ? P.getUser(r.decidedBy)?.name ?? r.decidedBy : null, decidedAt: r?.decidedAt ?? null };
  }).sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)));
  return filter.status && filter.status !== "all" ? rows.filter((r) => r.review === filter.status) : rows;
}

/** Clears or escalates a flagged payment. A reason is always required and lands in the evidence chain. */
export function decide(u: P.User, scope: string | null, paymentId: string, action: string, reason: string): Review {
  const pi = scoped(scope).intents.find((x) => x.id === paymentId);
  if (!pi || !P.canAccessTenant(u, tenantOf(pi))) throw new HttpError(404, "payment not found");
  if (action !== "clear" && action !== "escalate") throw new HttpError(422, "action must be clear or escalate");
  const why = reason.trim(); if (why.length < 3) throw new HttpError(422, "Give a reason of at least 3 characters");
  ensureScores([pi]);
  if ((pi.risk?.score ?? 0) < REVIEW_AT) throw new HttpError(409, "This payment is below the review mark");
  const status = action === "clear" ? "cleared" : "escalated"; const at = new Date().toISOString();
  sql.prepare("INSERT INTO risk_reviews (payment_id, tenant_id, status, reason, decided_by, decided_at) VALUES (?,?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, decided_by=excluded.decided_by, decided_at=excluded.decided_at").run(pi.id, tenantOf(pi), status, why, u.id, at);
  appendEvidence(db.evidence, "payment", pi.id, `risk.${status}`, { by: u.id, reason: why, score: pi.risk!.score });
  if (status === "escalated") db.alerts.push({ at, kind: "risk.escalated", detail: `${pi.id} escalated by ${u.name}: ${why}`, tenantId: tenantOf(pi) });
  save();
  return reviewOf(pi.id)!;
}
