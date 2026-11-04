import { db, tenantOf } from "./modules/store.js";
import * as P from "./platform.js";
import * as S from "./service.js";
import { listExceptions } from "./ops.js";

const r2 = (x: number) => Math.round(x * 100) / 100;
/** Bank revenue: the bank fee charged to the client minus the rail cost, from settled payments only. */
export function revenue() {
  const tenants = P.listTenants();
  const rows = new Map<string, { tenantId: string; tenant: string; bank: string; rail: string; month: string; count: number; volume: number; railFees: number; bankFees: number; net: number; refunds: number }>();
  for (const st of db.settlements) {
    const pi = db.intents.find((i) => i.id === st.paymentIntentId); if (!pi || pi.kind === "refund") continue;
    const t = tenants.find((x) => x.id === tenantOf(pi)); const bank = tenants.find((x) => x.id === t?.parentId);
    const month = st.confirmedAt.slice(0, 7); const k = `${tenantOf(pi)}|${st.rail}|${month}`;
    const bankFee = st.bankFeeUsd ?? S.bankFeeFor(tenantOf(pi), st.rail, pi.amount);
    const row = rows.get(k) ?? { tenantId: tenantOf(pi), tenant: t?.name ?? tenantOf(pi), bank: bank?.name ?? "", rail: st.rail, month, count: 0, volume: 0, railFees: 0, bankFees: 0, net: 0, refunds: 0 };
    row.count++; row.volume = r2(row.volume + pi.amount); row.railFees = r2(row.railFees + st.feeUsd); row.bankFees = r2(row.bankFees + bankFee); row.net = r2(row.bankFees - row.railFees);
    rows.set(k, row);
  }
  for (const rf of db.intents.filter((i) => i.kind === "refund" && i.status === "settled")) {
    const k = `${tenantOf(rf)}|${rf.rail}|${(rf.createdAt ?? "").slice(0, 7)}`; const row = rows.get(k); if (row) row.refunds = r2(row.refunds + rf.amount);
  }
  const list = [...rows.values()].sort((a, b) => b.month.localeCompare(a.month) || a.tenant.localeCompare(b.tenant) || a.rail.localeCompare(b.rail));
  const sum = (f: (x: typeof list[number]) => number) => r2(list.reduce((a, x) => a + f(x), 0));
  const pricing = tenants.filter((t) => t.kind === "bank").map((t) => ({ bank: t.name, pricing: t.pricing ?? {} }));
  return { rows: list, totals: { count: sum((x) => x.count), volume: sum((x) => x.volume), railFees: sum((x) => x.railFees), bankFees: sum((x) => x.bankFees), net: sum((x) => x.net), refunds: sum((x) => x.refunds) }, pricing };
}
/** Volume and risk KPIs for the operator home. All from stored payments, cases and exceptions. */
export function kpis(days = 30) {
  const since = Date.now() - days * 864e5;
  const pays = db.intents.filter((i) => i.kind !== "refund" && Date.parse(i.createdAt ?? "1970") >= since);
  const settled = pays.filter((i) => i.status === "settled");
  const blocked = pays.filter((i) => i.status === "blocked" || i.status === "denied");
  const failed = pays.filter((i) => i.status === "failed");
  const mins = settled.map((i) => { const a = i.timeline?.find((t) => t.status === "submitted")?.at; const b = i.timeline?.find((t) => t.status === "settled")?.at; return a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null; }).filter((x): x is number => x !== null);
  // Revenue for the same payments as the volume figures.
  const rev = settled.map((i) => { const st = db.settlements.find((x) => x.id === i.settlementId); const bankFees = st?.bankFeeUsd ?? S.bankFeeFor(tenantOf(i), i.rail!, i.amount); return { bankFees, net: bankFees - (st?.feeUsd ?? 0) }; });
  const byDay = new Map<string, number>(); for (const i of settled) { const d = (i.createdAt ?? "").slice(0, 10); byDay.set(d, r2((byDay.get(d) ?? 0) + i.amount)); }
  const daily = Array.from({ length: days }, (_, n) => { const d = new Date(Date.now() - (days - 1 - n) * 864e5).toISOString().slice(0, 10); return { day: d, volume: byDay.get(d) ?? 0 }; });
  const cases = S.listCases(null);
  return {
    days, payments: pays.length, settledCount: settled.length, settledVolume: r2(settled.reduce((a, i) => a + i.amount, 0)),
    avgTicket: settled.length ? r2(settled.reduce((a, i) => a + i.amount, 0) / settled.length) : 0,
    blockedCount: blocked.length, blockedRate: pays.length ? r2((blocked.length / pays.length) * 100) : 0, failedCount: failed.length,
    inFlight: db.intents.filter((i) => i.status === "pending" || i.status === "submitted").length,
    medianSettleMinutes: mins.length ? r2(mins.sort((a, b) => a - b)[Math.floor(mins.length / 2)]) : null,
    openCases: cases.filter((c) => c.status === "open").length, openSanctions: cases.filter((c) => c.status === "open" && c.kind === "sanctions").length, openDisputes: cases.filter((c) => c.status === "open" && c.kind === "dispute").length,
    openExceptions: listExceptions(null).filter((x) => x.status === "open").length,
    bankFees: r2(rev.reduce((a, r) => a + r.bankFees, 0)), netRevenue: r2(rev.reduce((a, r) => a + r.net, 0)),
    activeAgents: db.agents.filter((a) => a.status === "active").length, killSwitch: db.killSwitch, daily,
    byRail: Object.entries(settled.reduce((m: Record<string, number>, i) => { m[i.rail!] = r2((m[i.rail!] ?? 0) + i.amount); return m; }, {})).map(([rail, volume]) => ({ rail, volume })),
  };
}
/** Everything a dispute response needs, as one JSON document. */
export function evidencePack(caseId: string) {
  const c = S.getCase(caseId); if (!c) throw new S.HttpError(404, "case not found");
  const pi = db.intents.find((i) => i.id === c.intentId) ?? null;
  const inv = pi ? db.invoices.find((i) => i.id === pi.invoiceId) ?? null : null;
  const po = inv ? db.pos.find((p) => p.id === inv.poId) ?? null : null;
  const ids = new Set([c.id, pi?.id, inv?.id, po?.id].filter(Boolean) as string[]);
  const chain = S.evidenceView();
  return {
    generatedAt: new Date().toISOString(), case: c,
    payment: pi && { id: pi.id, amount: pi.amount, rail: pi.rail, providerRef: pi.providerRef, status: pi.status, timeline: pi.timeline, refunds: (pi.refundIds ?? []).map((id) => db.intents.find((x) => x.id === id)) },
    invoice: inv && { id: inv.id, number: inv.number, amount: inv.amount, dueDate: inv.dueDate, match: inv.match },
    purchaseOrder: po && { id: po.id, erpRef: po.erpRef, lines: po.lines, total: po.total, justification: po.justification, approval: po.approval ?? null, policy: po.policy },
    goodsReceipts: po ? db.receipts.filter((g) => g.poId === po.id) : [],
    supplier: inv ? db.suppliers.find((s) => s.id === inv.supplierId) ?? null : null,
    auditTrail: chain.records.filter((e) => ids.has(e.subjectId)), auditChainValid: chain.verification.valid,
    stripeNote: "Paste the summary into the Stripe dispute form, or upload this file as uncategorized evidence. This platform does not submit evidence to Stripe for you.",
  };
}
