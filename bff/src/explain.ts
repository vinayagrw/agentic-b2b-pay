import { db, tenantOf } from "./modules/store.js";
import type { EvidenceRecord } from "./modules/store.js";
import { verifyChain } from "./modules/evidence.js";
import * as AP2 from "./modules/ap2.js";
import * as P from "./platform.js";
import { HttpError, entityFor } from "./service.js";

/** Plain words "why" for every decision on a payment. Built only from stored records. Deterministic, no model. */
export type Actor = { kind: "agent" | "system" | "person"; id: string; name: string };
export type WhyItem = {
  key: "mandates" | "policy" | "approval" | "fx" | "compliance" | "route" | "settlement";
  decision: string;
  outcome: "passed" | "failed" | "waiting" | "not reached";
  why: string;
  drivers: string[];
  decidedBy: Actor;
  at: string | null;
  evidence: { id: string; seq: number; event: string; hash: string } | null;
};
export type WhyView = { paymentId: string; poId: string; invoiceId: string; tenantId: string; status: string; amount: number; currency: string; headline: string; items: WhyItem[]; chain: { valid: boolean; brokenAt: number | null; records: number; checkedAt: string } };

const SYSTEM: Actor = { kind: "system", id: "platform", name: "Payment platform rules" };
const person = (id: string): Actor => ({ kind: "person", id, name: P.getUser(id)?.name ?? id });
const agentActor = (id: string): Actor => ({ kind: "agent", id, name: db.agents.find((a) => a.id === id)?.name ?? id });
const ref = (e?: EvidenceRecord) => (e ? { id: e.id, seq: e.seq, event: e.event, hash: e.hash } : null);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CHECK_NAMES: Record<string, string> = { kyb: "Business identity (KYB)", sanctions: "Sanctions list (OFAC SDN)", ofac_wallet: "Wallet on OFAC list", kyt: "Wallet activity (KYT)", travel_rule: "Travel Rule record" };

export function explainPayment(paymentId: string, tenantId: string | null): WhyView {
  const pi = db.intents.find((x) => x.id === paymentId && (!tenantId || tenantOf(x) === tenantId));
  if (!pi) throw new HttpError(404, "payment not found");
  const inv = db.invoices.find((i) => i.id === pi.invoiceId);
  const po = inv && db.pos.find((p) => p.id === inv.poId);
  if (!inv || !po) throw new HttpError(404, "payment not found");
  const subjects = new Set([pi.id, po.id, inv.id]);
  const recs = db.evidence.filter((e) => subjects.has(e.subjectId));
  const last = (subject: string, ...events: string[]) => recs.filter((e) => e.subjectId === subject && events.includes(e.event)).at(-1);
  const items: WhyItem[] = [];

  // 1. Policy on the purchase order
  const pe = last(po.id, "policy.evaluated");
  const failed = po.policy.checks.filter((c) => !c.pass && !c.rule.startsWith("Approval rule"));
  items.push({
    key: "policy", decision: "Spending policy", outcome: po.policy.outcome === "deny" ? "failed" : "passed",
    why: po.policy.outcome === "deny" ? `The purchase was refused by policy: ${po.policy.reasons.join(", ")}.`
      : po.policy.outcome === "needs_approval" ? `The purchase of ${money(po.total)} was within the agent's limits but needs a person to approve it: ${po.policy.reasons.join(", ")}.`
      : `The purchase of ${money(po.total)} was within every limit in the agent's mandate, so no extra approval was needed.`,
    drivers: (failed.length ? failed : po.policy.checks.filter((c) => c.pass)).map((c) => `${c.rule}: ${c.detail}`),
    decidedBy: SYSTEM, at: pe?.createdAt ?? po.createdAt, evidence: ref(pe),
  });

  // 2. Approval routing and maker checker
  const ap = po.approval;
  const apEv = last(po.id, "approval.granted", "approval.rejected", "approval.level_passed");
  const approvers = ap?.levels.flatMap((l) => l.approvals.map((a) => a.userId)) ?? [];
  const makerIsChecker = approvers.includes(po.agentId);
  if (!ap) items.push({ key: "approval", decision: "Approval routing", outcome: po.policy.outcome === "deny" ? "not reached" : "passed", why: po.policy.outcome === "deny" ? "No approval was asked for because policy refused the purchase." : "No approval rule matched this purchase, so it went ahead without a person approving it.", drivers: ["No matching approval rule"], decidedBy: SYSTEM, at: pe?.createdAt ?? null, evidence: ref(pe) });
  else {
    const rejected = ap.rejectedBy;
    const done = ap.current >= ap.levels.length;
    const who = rejected ? person(rejected.userId) : approvers.length ? person(approvers.at(-1)!) : SYSTEM;
    items.push({
      key: "approval", decision: "Approval and maker checker", outcome: rejected || makerIsChecker ? "failed" : done ? "passed" : "waiting",
      why: rejected ? `${who.name} rejected the purchase${rejected.comment ? `, saying "${rejected.comment}"` : ""}.`
        : done ? `Rule "${ap.ruleName}" asked for ${ap.levels.map((l) => `${l.count} ${l.role.replace("_", " ")}`).join(" then ")}. ${approvers.map((a) => person(a).name).join(" and ")} approved. The agent that raised the purchase did not approve it, so maker and checker were different.`
        : `Rule "${ap.ruleName}" is waiting for level ${ap.current + 1} of ${ap.levels.length} (${ap.levels[ap.current].role.replace("_", " ")}).`,
      drivers: [`Rule: ${ap.ruleName}`, `Maker: ${agentActor(po.agentId).name}`, ...ap.levels.flatMap((l, n) => l.approvals.map((a) => `Level ${n + 1} checker: ${person(a.userId).name} at ${a.at}`))],
      decidedBy: who, at: apEv?.createdAt ?? null, evidence: ref(apEv),
    });
  }

  // 3. Signed mandates
  const mv = last(pi.id, "ap2.mandates_verified");
  const signed = last(po.id, "ap2.intent_signed");
  const legacy = AP2.mandatesForPo(po.id).length === 0;
  const mp = (mv?.payload ?? {}) as { ok?: boolean; failed?: string[] };
  items.push({
    key: "mandates", decision: "Signed mandates (AP2)", outcome: !mv ? "not reached" : mp.ok ? "passed" : "failed",
    why: !mv ? (pi.route ? "This payment was sent before the signed mandate check existed, so it was not checked." : "The mandate check did not run because the payment stopped earlier.")
      : mp.ok ? "The user signed an Intent and the buyer agent signed a Cart. Both signatures are valid and the payment matches the signed cart exactly."
      : legacy ? `This purchase order (${po.id}) was created before signed mandates were switched on, so it has no signed Intent or Cart. Payments now need both, so this one was blocked. Raise a new purchase order or reset the demo data, which signs mandates for every open order.`
      : `The payment was blocked because the signed mandates did not match: ${(mp.failed ?? []).join(", ")}.`,
    drivers: mv ? (mp.ok ? ["All mandate checks passed"] : (mp.failed ?? [])) : [], decidedBy: SYSTEM, at: mv?.createdAt ?? null, evidence: ref(mv ?? signed),
  });

  // FX quote and lock
  const fxe = last(pi.id, "fx.realised", "fx.quote_locked");
  const fx = pi.fx;
  const ent = entityFor(pi, tenantOf(pi));
  const nums = (n: number, c: string) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;
  items.push({
    key: "fx", decision: "Currency and FX rate", outcome: fx ? "passed" : (inv.currency ?? "USD") === "USD" && ent.currency === "USD" ? "passed" : "not reached",
    why: !fx ? ((inv.currency ?? "USD") === "USD" && ent.currency === "USD" ? `The invoice is in USD and ${ent.name} keeps its books in USD, so no conversion was needed.` : "No FX quote was locked because the payment stopped earlier.")
      : `${ent.name} keeps its books in ${ent.currency}. The ${fx.invoiceCurrency} invoice of ${nums(fx.invoiceAmount, fx.invoiceCurrency)} settles in USD, so the rate ${fx.rate} was locked as quote ${fx.lockId} until ${fx.expiresAt}, giving ${nums(fx.settlementAmount, "USD")}.${fx.stale ? " The rate source was offline, so this is the last cached rate and is marked stale." : ""}`
        + (fx.realised ? (fx.realised.kind === "none" ? " Settlement matched the accrual, so there is no FX gain or loss." : ` Settlement differed from the accrual, so a realised FX ${fx.realised.kind} of ${nums(Math.abs(fx.realised.gainLoss), ent.currency)} was booked.`) : ""),
    drivers: fx ? [`Rate source: ${fx.source}${fx.rateDate ? `, rate date ${fx.rateDate}` : ""}`, `Rate fetched at ${fx.fetchedAt}${fx.stale ? " (stale rate)" : ""}`, `Locked ${fx.lockedAt}, expires ${fx.expiresAt}`, `Functional rate ${fx.invoiceCurrency} to ${fx.functionalCurrency}: ${fx.functionalRate}`, ...(inv.accrual ? [`Accrual rate ${inv.accrual.rate} at ${inv.accrual.at}`] : [])] : [`Entity ${ent.name} (${ent.currency})`],
    decidedBy: SYSTEM, at: fxe?.createdAt ?? null, evidence: ref(fxe),
  });

  // 4. Compliance
  const ce = last(pi.id, "compliance.screened");
  const tr = last(pi.id, "travel_rule.record");
  const comp = pi.compliance;
  const bad = comp?.checks.filter((c) => c.result === "fail") ?? [];
  items.push({
    key: "compliance", decision: "Compliance screening", outcome: !comp ? "not reached" : comp.outcome === "blocked" ? "failed" : "passed",
    why: !comp ? "Screening did not run because the payment stopped earlier."
      : comp.outcome === "blocked" ? `The payment was stopped by screening: ${bad.map((c) => `${CHECK_NAMES[c.kind] ?? c.kind} failed (${c.detail})`).join(". ")}.`
      : `The supplier and wallet were screened against the OFAC list, wallet activity and Travel Rule. ${comp.checks.filter((c) => c.result === "pass").length} checks passed and none failed.`,
    drivers: comp?.checks.map((c) => `${CHECK_NAMES[c.kind] ?? c.kind}: ${c.result}${c.detail ? `, ${c.detail}` : ""}`) ?? [],
    decidedBy: SYSTEM, at: ce?.createdAt ?? null, evidence: ref(ce ?? tr),
  });

  // 5. Rail route
  const re = last(pi.id, "route.decided");
  items.push({
    key: "route", decision: "Payment rail", outcome: !pi.route ? "not reached" : pi.route.rail ? "passed" : "failed",
    why: !pi.route ? "No rail was chosen because the payment stopped earlier." : pi.route.rail ? `Sent by ${pi.route.rail}. ${pi.route.reason}` : `No rail could be used. ${pi.route.reason}`,
    drivers: pi.route?.options.map((o) => `${o.rail}: ${o.eligible ? "allowed" : "not allowed"}, fee ${money(o.feeUsd)}${o.why.length ? `, ${o.why.join(", ")}` : ""}`) ?? [],
    decidedBy: SYSTEM, at: re?.createdAt ?? null, evidence: ref(re),
  });

  // 6. Settlement
  const se = last(pi.id, "settlement.confirmed", "settlement.failed", "rail.failed", "rail.submitted", "payment.blocked", "payment.denied");
  const st = pi.status;
  items.push({
    key: "settlement", decision: "Settlement", outcome: st === "settled" ? "passed" : st === "pending" || st === "submitted" ? "waiting" : st === "blocked" || st === "denied" ? "not reached" : "failed",
    why: st === "settled" ? `The ${pi.rail} provider confirmed the money arrived (${pi.env ?? "sandbox"}). The ledger and ERP were updated.`
      : st === "pending" || st === "submitted" ? `Sent to ${pi.rail}. Waiting for the provider to confirm.`
      : st === "blocked" || st === "denied" ? `No money moved. ${pi.blockedReason ?? ""}`.trim()
      : `The provider reported a failure. ${pi.blockedReason ?? ""}`.trim(),
    drivers: [pi.providerRef ? `Provider reference ${pi.providerRef}` : "No provider reference"], decidedBy: se?.event.startsWith("settlement") ? { kind: "system", id: "rail", name: `${pi.rail} provider` } : SYSTEM,
    at: se?.createdAt ?? null, evidence: ref(se),
  });

  const order: WhyItem["key"][] = ["policy", "approval", "mandates", "fx", "compliance", "route", "settlement"];
  items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const stop = items.find((i) => i.outcome === "failed");
  const headline = st === "settled" ? `Paid ${money(pi.amount)}. Every check passed.` : stop ? `Stopped at ${stop.decision.toLowerCase()}. ${stop.why}` : `Payment is ${st}.`;
  const v = verifyChain(db.evidence);
  return { paymentId: pi.id, poId: po.id, invoiceId: inv.id, tenantId: tenantOf(pi), status: st, amount: pi.amount, currency: pi.currency, headline, items, chain: { ...v, records: db.evidence.length, checkedAt: new Date().toISOString() } };
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** Auditor export as Markdown. */
export function whyMarkdown(w: WhyView) {
  const out = [`# Decision record for payment ${w.paymentId}`, "", `Tenant ${w.tenantId}. Purchase order ${w.poId}. Invoice ${w.invoiceId}. Amount ${money(w.amount)} ${w.currency}. Status ${w.status}.`, "", `**${w.headline}**`, "",
    `Hash chain check: ${w.chain.valid ? "valid" : `BROKEN at record ${w.chain.brokenAt}`} (${w.chain.records} records checked at ${w.chain.checkedAt}).`, "",
    "| Decision | Outcome | Decided by | Time | Evidence |", "| --- | --- | --- | --- | --- |",
    ...w.items.map((i) => `| ${i.decision} | ${i.outcome} | ${esc(i.decidedBy.name)} (${i.decidedBy.kind}) | ${i.at ?? "n/a"} | ${i.evidence ? `${i.evidence.id} \`${i.evidence.hash}\`` : "none"} |`), ""];
  for (const i of w.items) out.push(`## ${i.decision}`, "", i.why, "", ...i.drivers.map((d) => `- ${d}`), "");
  return out.join("\n");
}
