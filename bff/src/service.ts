import crypto from "node:crypto";
import type { PoDraft, Rail } from "@b2b/shared";
import { db, save, nextId, type PurchaseOrder, type Supplier } from "./modules/store.js";
import { issueKey, verifyAgent, signAs, verifySignature } from "./modules/kya.js";
import { evaluatePolicy } from "./modules/policy.js";
import { threeWayMatch, round } from "./modules/match.js";
import { routePayment } from "./modules/router.js";
import { screen } from "./modules/compliance.js";
import { makeJournal, trialBalance, reconcile } from "./modules/ledger.js";
import { appendEvidence, verifyChain } from "./modules/evidence.js";
import { sendOnRail } from "./modules/rails.js";
import { erpCreatePo, erpPostPayment } from "./modules/erp.js";
import { mpcSign, SIGNERS } from "./modules/custody.js";
import { buyerDraft, readInvoice, explainRoute, renderInvoiceText } from "./agents.js";

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const must = <T>(v: T | undefined, what: string): T => { if (!v) throw new HttpError(404, `${what} not found`); return v; };
const ev = (t: string, id: string, e: string, p: unknown) => appendEvidence(db.evidence, t, id, e, p);
const erp = (e: Omit<import("./modules/store.js").ErpEvent, "id">) => db.erp.push({ id: nextId("erp"), ...e });
const supplier = (id: string) => must(db.suppliers.find((s) => s.id === id), "supplier");
const org = (id: string) => must(db.orgs.find((o) => o.id === id), "org");

export function bootstrap() {
  for (const a of db.agents) { issueKey(a); const r = verifyAgent(a, org(a.orgId).kybStatus === "verified"); ev("agent", a.id, "kya.verified", r); }
  const m = db.mandates[0];
  const body = JSON.stringify({ ...m, signature: "" });
  m.signature = signAs(m.agentId, body);
  ev("mandate", m.id, "mandate.signed", { mandate: m.id, principal: m.principalUserId, maxAmount: m.maxAmount, signatureValid: verifySignature(db.agents[0], body, m.signature) });
  save();
}

export function registerAgent(input: { name: string; orgId: string; erpRole: string; protocols: string[] }) {
  const a = { id: nextId("agt"), orgId: input.orgId, name: input.name, publicKey: "", kyaStatus: "unverified" as const, erpRole: input.erpRole, protocols: input.protocols, status: "active" as const };
  org(input.orgId); issueKey(a); db.agents.push(a); ev("agent", a.id, "agent.registered", { name: a.name, orgId: a.orgId }); save(); return a;
}
export function kyaVerify(id: string) { const a = must(db.agents.find((x) => x.id === id), "agent"); const r = verifyAgent(a, org(a.orgId).kybStatus === "verified"); ev("agent", id, "kya.verified", r); save(); return r; }
export function setAgentStatus(id: string, status: "active" | "suspended") { const a = must(db.agents.find((x) => x.id === id), "agent"); a.status = status; ev("agent", id, `agent.${status}`, { by: "console" }); save(); return a; }
export function setKillSwitch(on: boolean) { db.killSwitch = on; ev("platform", "kill-switch", on ? "killswitch.on" : "killswitch.off", {}); save(); return { killSwitch: on }; }

function spend(agentId: string, supplierId?: string) {
  return db.pos.filter((p) => p.agentId === agentId && p.status !== "rejected" && (!supplierId || p.supplierId === supplierId)).reduce((a, p) => a + p.total, 0);
}
export function policyFor(agentId: string, supplierId: string, category: PoDraft["category"], amount: number) {
  const agent = must(db.agents.find((a) => a.id === agentId), "agent");
  const mandate = must(db.mandates.find((m) => m.agentId === agentId), "mandate");
  const dayAgo = Date.now() - 864e5;
  const recent = db.pos.filter((p) => p.agentId === agentId && p.supplierId === supplierId && p.status !== "rejected" && new Date(p.createdAt).getTime() > dayAgo).map((p) => p.total);
  return { mandate, decision: evaluatePolicy({ agent, mandate, killSwitch: db.killSwitch, supplierId, category, amount, spentTotal: spend(agentId), spentBySupplier: spend(agentId, supplierId), recentSameSupplier: recent }) };
}

export async function draftPo(need: string) {
  const r = await buyerDraft(need, db.catalog);
  ev("agent", "agt-buyer-1", "llm.po_draft_proposed", { need, source: r.source, note: r.note, draft: r.value });
  save(); return r;
}

export function createPo(draft: PoDraft, agentId = "agt-buyer-1") {
  const sup = supplier(draft.supplierId);
  const total = round(draft.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const { mandate, decision } = policyFor(agentId, sup.id, draft.category, total);
  const po: PurchaseOrder = { id: nextId("po"), buyerOrgId: "org-acme", supplierId: sup.id, agentId, mandateId: mandate.id, erpRef: null, category: draft.category, lines: draft.lines, total, currency: "USD", justification: draft.justification,
    status: decision.outcome === "allow" ? "approved" : decision.outcome === "needs_approval" ? "pending_approval" : "rejected", policy: decision, createdAt: new Date().toISOString() };
  db.pos.push(po);
  ev("po", po.id, "policy.evaluated", { outcome: decision.outcome, reasons: decision.reasons, total });
  if (decision.outcome === "needs_approval") db.alerts.push({ at: po.createdAt, kind: "approval", detail: `${po.id}: ${decision.reasons.join(", ")}` });
  if (po.status === "approved") pushPoToErp(po, sup);
  save(); return po;
}
function pushPoToErp(po: PurchaseOrder, sup: Supplier) {
  const { ref, event } = erpCreatePo(po, sup, db.seq); po.erpRef = ref; erp(event); ev("po", po.id, "erp.po_created", { system: sup.erp, ref });
}
export function decideApproval(poId: string, approve: boolean, approver = "usr-controller-sam") {
  const po = must(db.pos.find((p) => p.id === poId), "po");
  if (po.status !== "pending_approval") throw new HttpError(409, `PO is ${po.status}`);
  po.status = approve ? "approved" : "rejected";
  ev("po", po.id, approve ? "approval.granted" : "approval.rejected", { approver });
  if (approve) pushPoToErp(po, supplier(po.supplierId));
  save(); return po;
}
export function receiveGoods(poId: string, shortBy = 0) {
  const po = must(db.pos.find((p) => p.id === poId), "po");
  if (po.status !== "approved") throw new HttpError(409, `PO is ${po.status}`);
  const gr = { id: nextId("gr"), poId, lines: po.lines.map((l, i) => ({ sku: l.sku, qty: i === 0 ? Math.max(0, l.qty - shortBy) : l.qty })), receivedAt: new Date().toISOString() };
  db.receipts.push(gr); po.status = "received"; ev("po", poId, "goods.received", gr); save(); return gr;
}
export function invoiceText(poId: string, opts: { priceBumpPct?: number; poison?: boolean }) {
  const po = must(db.pos.find((p) => p.id === poId), "po"); return renderInvoiceText(po, supplier(po.supplierId), opts);
}
export async function submitInvoice(poId: string, text: string) {
  const po = must(db.pos.find((p) => p.id === poId), "po");
  const sup = supplier(po.supplierId);
  const walletBefore = sup.walletAddress;
  const r = await readInvoice(text);
  const inv = { id: nextId("inv"), poId, supplierId: po.supplierId, number: r.value.invoiceNumber, amount: r.value.total, currency: "USD" as const, dueDate: r.value.dueDate, extract: r.value, extractedBy: `${r.source}${r.note ? " (" + r.note + ")" : ""}`, matchStatus: "unmatched" as const, erpApproval: "pending" as const, paid: false, injection: r.injection };
  db.invoices.push(inv); po.status = po.status === "received" ? "invoiced" : po.status;
  ev("invoice", inv.id, "llm.invoice_extracted", { source: r.source, extract: r.value });
  if (r.injection.length) {
    db.alerts.push({ at: new Date().toISOString(), kind: "injection", detail: `${inv.id}: invoice text contained payee or approval instructions, ignored` });
    ev("invoice", inv.id, "security.injection_ignored", { lines: r.injection, walletUnchanged: sup.walletAddress === walletBefore });
  }
  save(); return inv;
}
export function matchInvoice(invId: string) {
  const inv = must(db.invoices.find((i) => i.id === invId), "invoice");
  const po = must(db.pos.find((p) => p.id === inv.poId), "po");
  const grLines = db.receipts.filter((g) => g.poId === po.id).flatMap((g) => g.lines);
  const m = threeWayMatch(po.lines, grLines, inv.extract.lines);
  if (Math.abs(inv.extract.total - m.totals.invoice) > 0.01) { m.status = "exception"; m.lines.push({ sku: "TOTAL", poQty: 0, grQty: 0, invQty: 0, poPrice: m.totals.invoice, invPrice: inv.extract.total, ok: false, note: "Stated total does not equal sum of lines" }); }
  inv.match = m; inv.matchStatus = m.status;
  if (m.status === "matched") {
    inv.erpApproval = "approved";
    db.journals.push(makeJournal(nextId("jnl"), `Invoice ${inv.number} accrued`, inv.id, [{ account: po.category === "logistics" ? "5100 Freight expense" : "1300 Inventory", debit: inv.amount }, { account: "2000 Accounts payable", credit: inv.amount }]));
    erp({ system: supplier(po.supplierId).erp, kind: "invoice.approved", at: new Date().toISOString(), payload: { invoice: inv.number, po: po.erpRef, amount: inv.amount } });
  }
  ev("invoice", inv.id, "match.three_way", { status: m.status, totals: m.totals });
  save(); return m;
}

const BUYER = { name: "Acme Manufacturing Inc", orgId: "org-acme", country: "US" };
export async function payInvoice(invId: string, idempotencyKey: string, opts: { urgency?: "standard" | "urgent"; approvers?: string[] } = {}) {
  const prior = db.intents.find((p) => p.idempotencyKey === idempotencyKey);
  if (prior) return { intent: prior, replay: true };
  const inv = must(db.invoices.find((i) => i.id === invId), "invoice");
  if (inv.matchStatus !== "matched") throw new HttpError(409, "Invoice is not matched");
  if (inv.paid) throw new HttpError(409, "Invoice already paid");
  const po = must(db.pos.find((p) => p.id === inv.poId), "po");
  const sup = supplier(inv.supplierId); const so = org(sup.orgId);
  const mandate = must(db.mandates.find((m) => m.id === po.mandateId), "mandate");
  const agent = must(db.agents.find((a) => a.id === po.agentId), "agent");
  const intent: import("./modules/store.js").PaymentIntent = { id: nextId("pi"), invoiceId: inv.id, mandateId: mandate.id, amount: inv.amount, currency: "USD", status: "created", idempotencyKey };
  db.intents.push(intent);
  ev("payment", intent.id, "intent.created", { invoice: inv.id, amount: inv.amount, idempotencyKey });
  const stop = (status: "denied" | "blocked", why: string) => { intent.status = status; intent.blockedReason = why; ev("payment", intent.id, `payment.${status}`, { reason: why }); save(); return { intent, replay: false }; };
  if (db.killSwitch || agent.status !== "active") return stop("denied", db.killSwitch ? "Kill switch on" : "Agent suspended");

  const route = routePayment({ amount: inv.amount, urgency: opts.urgency ?? "standard", mandateRails: mandate.allowedRails, supplierRails: sup.acceptedRails, supplierPreferred: sup.preferredRail, supplierHasWallet: !!sup.walletAddress, supplierScreening: sup.screeningStatus, supplierCountry: so.country });
  intent.route = route; intent.status = "routed";
  const ex = await explainRoute(route, inv.amount, sup.name);
  intent.explanation = ex.value; intent.explainedBy = ex.source;
  ev("payment", intent.id, "route.decided", { rail: route.rail, reason: route.reason, explainedBy: ex.source });
  if (!route.rail) return stop("blocked", route.reason);
  const rail = route.rail as Rail;

  const comp = screen({ rail, amount: inv.amount, originator: BUYER, beneficiary: { name: so.legalName, orgId: so.id, country: so.country, wallet: sup.walletAddress, kybVerified: so.kybStatus === "verified" } });
  intent.compliance = comp;
  ev("payment", intent.id, "compliance.screened", { outcome: comp.outcome, checks: comp.checks.map((c) => `${c.kind}:${c.result}`) });
  if (comp.travelRule) ev("payment", intent.id, "travel_rule.record", comp.travelRule);
  if (comp.outcome === "blocked") {
    db.alerts.push({ at: new Date().toISOString(), kind: "compliance", detail: `${intent.id}: ${comp.checks.filter((c) => c.result === "fail").map((c) => c.detail).join(", ")}` });
    return stop("blocked", comp.checks.filter((c) => c.result === "fail").map((c) => c.detail).join(". "));
  }

  if (rail === "usdc") {
    const digest = crypto.createHash("sha256").update(`${intent.id}|${sup.walletAddress}|${inv.amount}|${idempotencyKey}`).digest("hex");
    const cust = mpcSign(digest, opts.approvers ?? ["signer-treasury-ops", "signer-policy-engine"]);
    intent.custody = { digest, ...cust };
    ev("payment", intent.id, "custody.mpc_sign", { approved: cust.approved, signers: cust.shares.map((s) => s.signer), aggregateSig: cust.aggregateSig });
    if (!cust.approved) return stop("blocked", `Custody quorum not met: ${cust.shares.length} of ${cust.quorum} signers`);
  }

  const rcpt = await sendOnRail(rail, inv.amount, idempotencyKey);
  const fee = route.options.find((o) => o.rail === rail)!.feeUsd;
  const st = { id: nextId("stl"), paymentIntentId: intent.id, rail, railRef: rcpt.railRef, txHash: rcpt.txHash, chain: rcpt.chain, feeUsd: fee, confirmedAt: rcpt.confirmedAt, status: "confirmed" as const };
  db.settlements.push(st); intent.settlementId = st.id; intent.status = "settled"; inv.paid = true; po.status = "paid";
  const cash = rail === "usdc" ? "1010 USDC treasury (simulated)" : "1000 Cash operating";
  db.journals.push(makeJournal(nextId("jnl"), `Payment ${inv.number} via ${rail}`, intent.id, [{ account: "2000 Accounts payable", debit: inv.amount }, { account: cash, credit: inv.amount }]));
  db.journals.push(makeJournal(nextId("jnl"), `Rail fee ${rail}`, intent.id, [{ account: "6100 Payment fees", debit: fee }, { account: cash, credit: fee }]));
  ev("payment", intent.id, "settlement.confirmed", { rail, railRef: st.railRef, txHash: st.txHash, simulated: true });
  erp(erpPostPayment(sup, po.erpRef ?? po.id, inv.number, inv.amount, st.railRef, st.txHash));
  ev("payment", intent.id, "erp.payment_posted", { system: sup.erp, invoice: inv.number });
  save(); return { intent, replay: false };
}

/** Stablecoin sends cannot be reversed. A refund is a new forward payment from supplier back to buyer. */
export async function refund(intentId: string, amount: number, reason: string) {
  const pi = must(db.intents.find((p) => p.id === intentId), "payment intent");
  const st = db.settlements.find((s) => s.id === pi.settlementId);
  if (!st) throw new HttpError(409, "Payment not settled");
  const already = db.refunds.filter((r) => r.originalIntentId === intentId && r.status === "settled").reduce((a, r) => a + r.amount, 0);
  if (amount <= 0 || already + amount > pi.amount) throw new HttpError(422, `Refund ${amount} exceeds refundable ${round(pi.amount - already)}`);
  const id = nextId("rf");
  const rc = await sendOnRail(st.rail, amount, `refund-${id}`);
  const r = { id, originalIntentId: intentId, amount, reason, rail: st.rail, status: "settled" as const, railRef: rc.railRef, txHash: rc.txHash, createdAt: new Date().toISOString() };
  db.refunds.push(r);
  const cash = st.rail === "usdc" ? "1010 USDC treasury (simulated)" : "1000 Cash operating";
  db.journals.push(makeJournal(nextId("jnl"), `Refund ${id} for ${intentId}`, id, [{ account: cash, debit: amount }, { account: "1400 Supplier refunds receivable cleared", credit: amount }]));
  ev("refund", id, "refund.settled", { originalIntentId: intentId, amount, rail: st.rail, txHash: rc.txHash, note: "New forward payment, original transfer not reversed" });
  save(); return r;
}

/** Payee master data changes only via ERP adapter, four eyes and callback verification. Never from LLM output. */
export function requestPayeeChange(input: { supplierId: string; field: "walletAddress" | "bankDetailsRef"; newValue: string; source: string; requestedBy: string }) {
  if (input.source !== "erp") { ev("supplier", input.supplierId, "payee_change.rejected", { reason: "Source is not ERP master data", source: input.source }); save(); throw new HttpError(403, "Payee details can only change through the ERP adapter"); }
  supplier(input.supplierId);
  const c = { id: nextId("pc"), supplierId: input.supplierId, field: input.field, newValue: input.newValue, source: "erp" as const, requestedBy: input.requestedBy, approvals: [], callbackVerified: false, status: "pending" as const, createdAt: new Date().toISOString() };
  db.payeeChanges.push(c); ev("supplier", c.supplierId, "payee_change.requested", c); save(); return c;
}
export function approvePayeeChange(id: string, approver: string) {
  const c = must(db.payeeChanges.find((x) => x.id === id), "payee change");
  if (c.status !== "pending") throw new HttpError(409, `Change is ${c.status}`);
  if (approver === c.requestedBy) throw new HttpError(403, "Four eyes: requester cannot approve");
  if (!c.approvals.includes(approver)) (c.approvals as string[]).push(approver);
  ev("supplier", c.supplierId, "payee_change.approved", { id, approver }); tryApply(c); save(); return c;
}
export function callbackPayeeChange(id: string, confirmedByPhone: boolean) {
  const c = must(db.payeeChanges.find((x) => x.id === id), "payee change");
  c.callbackVerified = confirmedByPhone;
  if (!confirmedByPhone) c.status = "rejected";
  ev("supplier", c.supplierId, "payee_change.callback", { id, confirmedByPhone }); tryApply(c); save(); return c;
}
function tryApply(c: import("./modules/store.js").PayeeChange) {
  if (c.status === "pending" && c.approvals.length >= 2 && c.callbackVerified) {
    const s = supplier(c.supplierId); (s as any)[c.field] = c.newValue; c.status = "applied";
    ev("supplier", c.supplierId, "payee_change.applied", { field: c.field });
  }
}

export function ledgerView() {
  const settlements = db.settlements.map((s) => ({ id: s.id, paymentIntentId: s.paymentIntentId, amount: db.intents.find((i) => i.id === s.paymentIntentId)!.amount }));
  return { journals: db.journals, trialBalance: trialBalance(db.journals), reconciliation: reconcile(settlements, db.journals) };
}
export function evidenceView(subjectId?: string) {
  return { verification: verifyChain(db.evidence), records: subjectId ? db.evidence.filter((e) => e.subjectId === subjectId) : db.evidence };
}

/** ISO 20022 camt.053 style bank to customer statement from the ledger cash accounts. Tx hash in end to end id. */
export function camt053(date = new Date().toISOString().slice(0, 10)) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cashAccts = ["1000 Cash operating", "1010 USDC treasury (simulated)"];
  const ntries = db.journals.flatMap((j) => j.entries.filter((e) => cashAccts.includes(e.account)).map((e) => {
    const st = db.settlements.find((s) => s.paymentIntentId === j.ref);
    const amt = e.debit || e.credit;
    return `      <Ntry><Amt Ccy="USD">${amt.toFixed(2)}</Amt><CdtDbtInd>${e.credit ? "DBIT" : "CRDT"}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${j.createdAt.slice(0, 10)}</Dt></BookgDt><AcctSvcrRef>${esc(st?.railRef ?? j.id)}</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>${esc(st?.txHash ?? j.ref)}</EndToEndId></Refs><AddtlTxInf>${esc(j.memo)} | ${esc(e.account)}</AddtlTxInf></TxDtls></NtryDtls></Ntry>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>STMT-${date}-${db.seq}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>ACME-${date}</Id><Acct><Id><Othr><Id>ACME-OPERATING-AND-USDC</Id></Othr></Id><Ccy>USD</Ccy></Acct>
      <TxsSummry><TtlNtries><NbOfNtries>${ntries.length}</NbOfNtries></TtlNtries></TxsSummry>
${ntries.join("\n")}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

/** Full flow used by the scenario buttons and the e2e script. */
export async function runFlow(need: string, opts: { scenario?: "happy" | "sanctioned" | "poisoned"; autoApprove?: boolean } = {}) {
  const steps: { step: string; ok: boolean; detail: unknown }[] = [];
  const log = (step: string, ok: boolean, detail: unknown) => steps.push({ step, ok, detail });
  const d = await draftPo(need);
  if (opts.scenario === "sanctioned") { d.value.supplierId = "sup-fabrikam"; d.value.category = "components"; d.value.lines = [{ sku: "FB-STL-304", description: "Stainless steel sheet 304 per ton", qty: 2, unitPrice: 3100 }]; d.value.justification = "Scenario: steel order to Fabrikam Metals whose wallet is on the simulated sanctions list"; }
  log("PO draft", true, { source: d.source, note: d.note, draft: d.value });
  let po = createPo(d.value);
  log("Policy check", po.policy.outcome !== "deny", po.policy);
  if (po.status === "pending_approval" && opts.autoApprove !== false) { po = decideApproval(po.id, true); log("Human approval", true, { approver: "usr-controller-sam" }); }
  if (po.status !== "approved") return { steps, poId: po.id };
  receiveGoods(po.id); log("Goods receipt", true, {});
  const inv = await submitInvoice(po.id, invoiceText(po.id, { poison: opts.scenario === "poisoned" }));
  log("Supplier invoice", true, { extractedBy: inv.extractedBy, number: inv.number, total: inv.amount, injection: (inv as any).injection });
  const m = matchInvoice(inv.id); log("3-way match", m.status === "matched", m);
  if (m.status !== "matched") return { steps, poId: po.id, invoiceId: inv.id };
  const { intent } = await payInvoice(inv.id, `idem-${inv.id}`);
  log("Rail choice", !!intent.route?.rail, { rail: intent.route?.rail, explanation: intent.explanation, explainedBy: intent.explainedBy });
  log("Compliance", intent.compliance?.outcome === "clear", intent.compliance);
  log("Settlement", intent.status === "settled", { status: intent.status, blockedReason: intent.blockedReason, settlement: db.settlements.find((s) => s.id === intent.settlementId) });
  return { steps, poId: po.id, invoiceId: inv.id, intentId: intent.id };
}
export { SIGNERS };
