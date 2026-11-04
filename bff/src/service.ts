import crypto from "node:crypto";
import { isUsdc, type PoDraft, type Rail } from "@b2b/shared";
import { db, save, nextId, tenantOf, TENANT, type PurchaseOrder, type Supplier, type PaymentIntent, type Settlement, type TimelineEntry } from "./modules/store.js";
import { issueKey, verifyAgent, signAs, verifySignature } from "./modules/kya.js";
import { evaluatePolicy } from "./modules/policy.js";
import { threeWayMatch, round } from "./modules/match.js";
import { routePayment } from "./modules/router.js";
import { screen } from "./modules/compliance.js";
import { makeJournal, trialBalance, reconcile } from "./modules/ledger.js";
import { appendEvidence, verifyChain } from "./modules/evidence.js";
import { adapter, allAdapters, railReadiness } from "./rails/index.js";
import { walletActivity } from "./rails/onchain.js";
import { sql } from "./db.js";
import * as P from "./platform.js";
import { erpCreatePo, erpPostPayment } from "./modules/erp.js";
import { mpcSign, SIGNERS } from "./modules/custody.js";
import { buyerDraft, readInvoice, explainRoute, renderInvoiceText } from "./agents.js";
import { pickRule, type ApprovalRule } from "./modules/rules.js";
import { publish } from "./hooks.js";

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const must = <T>(v: T | undefined, what: string): T => { if (!v) throw new HttpError(404, `${what} not found`); return v; };
const ev = (t: string, id: string, e: string, p: unknown) => appendEvidence(db.evidence, t, id, e, p);
const erp = (e: Omit<import("./modules/store.js").ErpEvent, "id">) => db.erp.push({ id: nextId("erp"), ...e });
const supplier = (id: string) => must(db.suppliers.find((s) => s.id === id), "supplier");
const org = (id: string) => must(db.orgs.find((o) => o.id === id), "org");

export function bootstrap() {
  for (const a of db.agents) { issueKey(a); const r = verifyAgent(a, org(a.orgId).kybStatus === "verified"); ev("agent", a.id, "kya.verified", r); }
  for (const m of db.mandates) signMandate(m);
  seedRules();
  save();
}
export function signMandate(m: import("./modules/store.js").Mandate) {
  const a = db.agents.find((x) => x.id === m.agentId); if (!a) return;
  if (!a.publicKey) issueKey(a);
  const body = JSON.stringify({ ...m, signature: "" });
  try { m.signature = signAs(m.agentId, body); } catch { issueKey(a); m.signature = signAs(m.agentId, body); }
  ev("mandate", m.id, "mandate.signed", { mandate: m.id, principal: m.principalUserId, maxAmount: m.maxAmount, signatureValid: verifySignature(a, body, m.signature) });
}

// Approval rules
const toRule = (r: any): ApprovalRule => JSON.parse(r.data);
export const listRules = (tenantId: string) => (sql.prepare("SELECT data FROM approval_rules WHERE tenant_id = ? ORDER BY position").all(tenantId) as any[]).map(toRule);
export function saveRule(r: ApprovalRule) { sql.prepare("INSERT OR REPLACE INTO approval_rules (id, tenant_id, position, data) VALUES (?,?,?,?)").run(r.id, r.tenantId, r.position, JSON.stringify(r)); return r; }
export const SEED_RULES: Omit<ApprovalRule, "id" | "position">[] = [
  { tenantId: "tnt-acme", name: "Large spend", active: true, minAmount: 25000, maxAmount: null, categories: [], entities: [], levels: [{ role: "approver", count: 1 }, { role: "client_admin", count: 1 }] },
  { tenantId: "tnt-acme", name: "Mid spend", active: true, minAmount: 10000, maxAmount: 25000, categories: [], entities: [], levels: [{ role: "approver", count: 1 }] },
  { tenantId: "tnt-acme", name: "IT hardware", active: true, minAmount: 0, maxAmount: null, categories: ["it"], entities: [], levels: [{ role: "client_admin", count: 1 }] },
  { tenantId: "tnt-globex", name: "Over 12,000", active: true, minAmount: 12000, maxAmount: null, categories: [], entities: [], levels: [{ role: "approver", count: 1 }, { role: "client_admin", count: 1 }] },
  { tenantId: "tnt-globex", name: "Over 5,000", active: true, minAmount: 5000, maxAmount: 12000, categories: [], entities: [], levels: [{ role: "approver", count: 1 }] },
];
function seedRules() {
  if ((sql.prepare("SELECT COUNT(*) n FROM approval_rules").get() as { n: number }).n) return;
  SEED_RULES.forEach((r, n) => saveRule({ ...r, id: `rule-${r.tenantId.slice(4)}-${n + 1}`, position: n + 1 }));
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
  const month = new Date().toISOString().slice(0, 7);
  const spentThisMonth = db.pos.filter((p) => p.agentId === agentId && p.status !== "rejected" && p.createdAt.startsWith(month)).reduce((a, p) => a + p.total, 0);
  return { mandate, decision: evaluatePolicy({ agent, mandate, killSwitch: db.killSwitch, supplierId, category, amount, spentTotal: spend(agentId), spentBySupplier: spend(agentId, supplierId), recentSameSupplier: recent, spentThisMonth }) };
}

/** The tenant's first active buyer agent. */
export function buyerAgent(tenantId = TENANT) { return db.agents.find((a) => tenantOf(a) === tenantId && a.erpRole.startsWith("buyer") && db.mandates.some((m) => m.agentId === a.id)) ?? db.agents.find((a) => tenantOf(a) === tenantId); }
export async function draftPo(need: string, tenantId = TENANT) {
  const r = await buyerDraft(need, db.catalog.filter((c) => tenantOf(c) === tenantId));
  ev("agent", buyerAgent(tenantId)?.id ?? "agent", "llm.po_draft_proposed", { need, source: r.source, note: r.note, draft: r.value });
  save(); return r;
}

export function createPo(draft: PoDraft, agentId?: string) {
  const sup = supplier(draft.supplierId);
  const tenantId = tenantOf(sup);
  agentId ??= buyerAgent(tenantId)?.id ?? "agt-buyer-1";
  const agent = must(db.agents.find((a) => a.id === agentId), "agent");
  if (tenantOf(agent) !== tenantId) throw new HttpError(403, "Agent and supplier belong to different tenants");
  if (sup.onboarding && sup.onboarding.status !== "verified") throw new HttpError(409, `Supplier onboarding is ${sup.onboarding.status}. A client admin must verify it first.`);
  const total = round(draft.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const { mandate, decision } = policyFor(agentId, sup.id, draft.category, total);
  // Approval rules: the first matching rule decides who approves. Hard denies stay denies.
  let approval: PurchaseOrder["approval"];
  if (decision.outcome !== "deny") {
    const rule = pickRule(listRules(tenantId), { amount: total, category: draft.category, supplierId: sup.id, buyerOrgId: agent.orgId });
    if (rule) {
      approval = { ruleId: rule.id, ruleName: rule.name, levels: rule.levels.map((l) => ({ ...l, approvals: [] })), current: 0 };
      decision.checks.push({ rule: `Approval rule ${rule.name}`, pass: false, detail: rule.levels.map((l, n) => `level ${n + 1}: ${l.count} ${l.role.replace("_", " ")}`).join(", ") });
      if (decision.outcome === "allow") { decision.outcome = "needs_approval"; decision.reasons = [`Approval rule ${rule.name} matched`]; }
    } else if (decision.outcome === "needs_approval") approval = { ruleId: null, ruleName: "Mandate threshold", levels: [{ role: "approver", count: 1, approvals: [] }], current: 0 };
  }
  const po: PurchaseOrder = { id: nextId("po"), tenantId, buyerOrgId: agent.orgId, supplierId: sup.id, agentId, mandateId: mandate.id, erpRef: null, category: draft.category, lines: draft.lines, total, currency: "USD", justification: draft.justification,
    status: decision.outcome === "allow" ? "approved" : decision.outcome === "needs_approval" ? "pending_approval" : "rejected", policy: decision, approval, createdAt: new Date().toISOString() };
  db.pos.push(po);
  ev("po", po.id, "policy.evaluated", { outcome: decision.outcome, reasons: decision.reasons, total, rule: approval?.ruleName ?? null });
  if (decision.outcome === "needs_approval") db.alerts.push({ at: po.createdAt, kind: "approval", detail: `${po.id}: ${decision.reasons.join(", ")}`, tenantId });
  if (po.status === "approved") publish(tenantId, "purchase_order.approved", { id: po.id, total });
  if (po.status === "approved") pushPoToErp(po, sup);
  save(); return po;
}
function pushPoToErp(po: PurchaseOrder, sup: Supplier) {
  const { ref, event } = erpCreatePo(po, sup, db.seq); po.erpRef = ref; erp(event); ev("po", po.id, "erp.po_created", { system: sup.erp, ref });
}
/** Can this user act on the PO's current approval level? */
export function canApprove(po: PurchaseOrder, user: { id: string; role: string; tenantId: string | null }) {
  if (po.status !== "pending_approval") return { ok: false, why: `PO is ${po.status}` };
  if (user.tenantId && user.tenantId !== tenantOf(po)) return { ok: false, why: "Wrong tenant" };
  const a = po.approval; if (!a) return { ok: ["approver", "client_admin", "operator_admin"].includes(user.role), why: "Needs an approver" };
  const lvl = a.levels[a.current];
  if (a.levels.some((l) => l.approvals.some((x) => x.userId === user.id))) return { ok: false, why: "You already approved this PO at an earlier level" };
  if (user.role !== lvl.role) return { ok: false, why: `Level ${a.current + 1} needs ${lvl.role.replace("_", " ")}` };
  return { ok: true, why: "" };
}
export function decideApproval(poId: string, approve: boolean, approver = "usr-controller-sam", comment = "") {
  const po = must(db.pos.find((p) => p.id === poId), "po");
  if (po.status !== "pending_approval") throw new HttpError(409, `PO is ${po.status}`);
  const user = P.getUser(approver) ?? { id: approver, role: "approver", tenantId: null };
  const can = canApprove(po, user);
  if (!can.ok) throw new HttpError(403, can.why);
  const at = new Date().toISOString(); const c = comment.trim().slice(0, 500);
  if (!approve) { po.status = "rejected"; if (po.approval) po.approval.rejectedBy = { userId: user.id, at, comment: c }; }
  else if (po.approval) {
    const lvl = po.approval.levels[po.approval.current]; lvl.approvals.push({ userId: user.id, at, comment: c });
    if (lvl.approvals.length >= lvl.count) po.approval.current += 1;
    if (po.approval.current >= po.approval.levels.length) po.status = "approved";
  } else po.status = "approved";
  ev("po", po.id, approve ? (po.status === "approved" ? "approval.granted" : "approval.level_passed") : "approval.rejected", { approver: user.id, comment: c, level: po.approval ? po.approval.current : 0, rule: po.approval?.ruleName ?? null });
  if (po.status === "approved") { pushPoToErp(po, supplier(po.supplierId)); publish(tenantOf(po), "purchase_order.approved", { id: po.id, total: po.total }); }
  save(); return po;
}
/** Approves every level with seeded users of the right role. Used by the scenario runner only. */
export function autoApprove(po: PurchaseOrder) {
  const users = P.listUsers().filter((u) => u.tenantId === tenantOf(po));
  let guard = 0;
  while (po.status === "pending_approval" && guard++ < 10) {
    const u = users.find((x) => canApprove(po, x).ok); if (!u) break;
    decideApproval(po.id, true, u.id, "Approved by the scenario runner");
  }
  return po;
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
  const inv = { id: nextId("inv"), tenantId: tenantOf(po), poId, supplierId: po.supplierId, number: r.value.invoiceNumber, amount: r.value.total, currency: "USD" as const, dueDate: r.value.dueDate, extract: r.value, extractedBy: `${r.source}${r.note ? " (" + r.note + ")" : ""}`, matchStatus: "unmatched" as const, erpApproval: "pending" as const, paid: false, injection: r.injection };
  db.invoices.push(inv); po.status = po.status === "received" ? "invoiced" : po.status;
  ev("invoice", inv.id, "llm.invoice_extracted", { source: r.source, extract: r.value });
  if (r.injection.length) {
    db.alerts.push({ at: new Date().toISOString(), kind: "injection", detail: `${inv.id}: invoice text contained payee or approval instructions, ignored`, tenantId: tenantOf(po) });
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
    db.journals.push(tj(tenantOf(po), makeJournal(nextId("jnl"), `Invoice ${inv.number} accrued`, inv.id, [{ account: po.category === "logistics" ? "5100 Freight expense" : "1300 Inventory", debit: inv.amount }, { account: "2000 Accounts payable", credit: inv.amount }])));
    erp({ system: supplier(po.supplierId).erp, kind: "invoice.approved", at: new Date().toISOString(), payload: { invoice: inv.number, po: po.erpRef, amount: inv.amount } });
  }
  ev("invoice", inv.id, "match.three_way", { status: m.status, totals: m.totals });
  save(); return m;
}

const tj = (tenantId: string, j: import("./modules/store.js").Journal) => ({ ...j, tenantId });
const now = () => new Date().toISOString();
const cashAccount = (rail: Rail) => (isUsdc(rail) ? "1010 USDC treasury" : "1000 Cash operating");
function mark(intent: PaymentIntent, status: PaymentIntent["status"], source: TimelineEntry["source"], detail: string) {
  intent.status = status; (intent.timeline ??= []).push({ at: now(), status, source, detail });
}

/** Rails the router may use for this tenant. Adapters without keys are listed as not configured and skipped. */
export function railCandidates(tenantId = TENANT, amount = 0) {
  return allAdapters().map((a) => {
    const env = P.railEnv(tenantId, a.id); const r = railReadiness(a.id, env);
    return { ...a.quote(amount), configured: r.configured, notConfiguredReason: r.reason, env, address: r.address };
  });
}

export async function payInvoice(invId: string, idempotencyKey: string, opts: { urgency?: "standard" | "urgent"; approvers?: string[] } = {}) {
  const key = sql.prepare("SELECT intent_id FROM idempotency_keys WHERE key = ?").get(idempotencyKey) as { intent_id: string } | undefined;
  const prior = key && db.intents.find((p) => p.id === key.intent_id);
  if (prior) return { intent: prior, replay: true };
  const inv = must(db.invoices.find((i) => i.id === invId), "invoice");
  if (inv.matchStatus !== "matched") throw new HttpError(409, "Invoice is not matched");
  if (inv.paid) throw new HttpError(409, "Invoice already paid");
  const open = db.intents.find((p) => p.invoiceId === inv.id && (p.status === "submitted" || p.status === "pending"));
  if (open) throw new HttpError(409, `Payment ${open.id} for this invoice is already in flight`);
  const po = must(db.pos.find((p) => p.id === inv.poId), "po");
  const sup = supplier(inv.supplierId); const so = org(sup.orgId);
  const TENANT = tenantOf(po); const bo = org(po.buyerOrgId); const BUYER = { name: bo.legalName, orgId: bo.id, country: bo.country };
  if (sup.onboarding && sup.onboarding.status !== "verified") throw new HttpError(409, `Supplier onboarding is ${sup.onboarding.status}`);
  const mandate = must(db.mandates.find((m) => m.id === po.mandateId), "mandate");
  const agent = must(db.agents.find((a) => a.id === po.agentId), "agent");
  const intent: PaymentIntent = { id: nextId("pi"), invoiceId: inv.id, mandateId: mandate.id, amount: inv.amount, currency: "USD", status: "created", idempotencyKey, createdAt: now(), tenantId: TENANT, timeline: [] };
  db.intents.push(intent);
  sql.prepare("INSERT INTO idempotency_keys (key, intent_id, created_at) VALUES (?, ?, ?)").run(idempotencyKey, intent.id, now());
  mark(intent, "created", "platform", "Payment intent created");
  ev("payment", intent.id, "intent.created", { invoice: inv.id, amount: inv.amount, idempotencyKey });
  const stop = (status: "denied" | "blocked", why: string) => { mark(intent, status, "platform", why); intent.blockedReason = why; ev("payment", intent.id, `payment.${status}`, { reason: why }); save(); return { intent, replay: false }; };
  if (db.killSwitch || agent.status !== "active") return stop("denied", db.killSwitch ? "Kill switch on" : "Agent suspended");

  const route = routePayment({ amount: inv.amount, urgency: opts.urgency ?? "standard", mandateRails: mandate.allowedRails, supplierRails: sup.acceptedRails, supplierPreferred: sup.preferredRail, supplierHasWallet: !!sup.walletAddress, supplierScreening: sup.screeningStatus, supplierCountry: so.country, candidates: railCandidates(TENANT, inv.amount) });
  intent.route = route; mark(intent, "routed", "platform", route.reason);
  const ex = await explainRoute(route, inv.amount, sup.name);
  intent.explanation = ex.value; intent.explainedBy = ex.source;
  ev("payment", intent.id, "route.decided", { rail: route.rail, reason: route.reason, explainedBy: ex.source });
  if (!route.rail) return stop("blocked", route.reason);
  const rail = route.rail as Rail;

  const railEnvNow = P.railEnv(TENANT, rail);
  const kyb = sup.onboarding
    ? { status: sup.onboarding.status, source: "onboarding review" as const, reviewedBy: sup.onboarding.reviewedBy ?? null, reviewedAt: sup.onboarding.reviewedAt ?? null }
    : { status: so.kybStatus, source: "org record" as const };
  const activity = isUsdc(rail) && sup.walletAddress ? await walletActivity(sup.walletAddress, railEnvNow) : null;
  const originWallet = isUsdc(rail) ? railReadiness(rail, railEnvNow).address ?? null : null;
  const comp = screen({ intentId: intent.id, rail, amount: inv.amount, mandate: { id: mandate.id, perTxnMax: mandate.perTxnMax }, originator: { ...BUYER, wallet: originWallet }, beneficiary: { name: so.legalName, orgId: so.id, supplierId: sup.id, country: so.country, wallet: sup.walletAddress, kyb }, walletActivity: activity });
  intent.compliance = comp;
  ev("payment", intent.id, "compliance.screened", { outcome: comp.outcome, checks: comp.checks.map((c) => `${c.kind}:${c.result}`) });
  if (comp.travelRule) ev("payment", intent.id, "travel_rule.record", comp.travelRule);
  if (comp.outcome === "blocked") {
    db.alerts.push({ at: now(), tenantId: TENANT, kind: "compliance", detail: `${intent.id}: ${comp.checks.filter((c) => c.result === "fail").map((c) => c.detail).join(", ")}` });
    const out = stop("blocked", comp.checks.filter((c) => c.result === "fail").map((c) => c.detail).join(". "));
    for (const h of blockHooks) h(intent.id);
    save(); return out;
  }
  if (isUsdc(rail)) {
    const digest = crypto.createHash("sha256").update(`${intent.id}|${sup.walletAddress}|${inv.amount}|${idempotencyKey}`).digest("hex");
    const cust = mpcSign(digest, opts.approvers ?? ["signer-treasury-ops", "signer-policy-engine"]);
    intent.custody = { digest, ...cust };
    ev("payment", intent.id, "custody.mpc_sign", { approved: cust.approved, signers: cust.shares.map((s) => s.signer), aggregateSig: cust.aggregateSig });
    if (!cust.approved) return stop("blocked", `Custody quorum not met: ${cust.shares.length} of ${cust.quorum} signers`);
  }

  const env = P.railEnv(TENANT, rail);
  intent.rail = rail; intent.env = env;
  mark(intent, "submitted", "platform", `Sent to ${rail} (${env})`); save();
  try {
    const r = await adapter(rail).send({ intentId: intent.id, amount: inv.amount, currency: "USD", idempotencyKey, env, beneficiary: { name: so.legalName, wallet: sup.walletAddress, bankRef: sup.bankDetailsRef }, memo: `Invoice ${inv.number}` });
    intent.providerRef = r.providerRef; intent.explorerUrl = r.explorerUrl; intent.dashboardUrl = r.dashboardUrl;
    mark(intent, "pending", "adapter", r.detail ?? `Accepted by ${rail}`);
    ev("payment", intent.id, "rail.submitted", { rail, env, providerRef: r.providerRef, providerStatus: r.status });
  } catch (e: any) {
    mark(intent, "failed", "adapter", e.message); intent.blockedReason = e.message;
    ev("payment", intent.id, "rail.failed", { rail, env, error: e.message });
  }
  save(); return { intent, replay: false };
}

/** Called after a payment is blocked by screening. The compliance module opens a case. */
export const blockHooks: ((intentId: string) => void)[] = [];

/** Moves a pending intent to settled or failed. Ledger, invoice and ERP change only on settled. Idempotent. */
export function applyRailUpdate(intentId: string, u: { status: "pending" | "settled" | "failed"; source: TimelineEntry["source"]; detail?: string; explorerUrl?: string }) {
  const intent = must(db.intents.find((i) => i.id === intentId), "payment intent");
  if (u.explorerUrl) intent.explorerUrl = u.explorerUrl;
  if (intent.status !== "pending" && intent.status !== "submitted") return intent;
  if (u.status === "pending") { save(); return intent; }
  if (u.status === "failed") {
    mark(intent, "failed", u.source, u.detail ?? "Provider reported failure"); intent.blockedReason = u.detail;
    ev("payment", intent.id, "settlement.failed", { rail: intent.rail, providerRef: intent.providerRef, source: u.source });
    publish(tenantOf(intent), "payment.failed", { id: intent.id, amount: intent.amount, rail: intent.rail, reason: u.detail ?? null });
    save(); return intent;
  }
  const inv = must(db.invoices.find((i) => i.id === intent.invoiceId), "invoice");
  const po = must(db.pos.find((p) => p.id === inv.poId), "po"); const sup = supplier(inv.supplierId);
  const rail = intent.rail!; const fee = intent.route?.options.find((o) => o.rail === rail)?.feeUsd ?? 0;
  const txHash = intent.explorerUrl?.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;
  const bankFee = bankFeeFor(tenantOf(intent), rail, intent.amount);
  const st: Settlement = { id: nextId("stl"), tenantId: tenantOf(intent), bankFeeUsd: bankFee, paymentIntentId: intent.id, rail, railRef: intent.providerRef!, txHash, chain: isUsdc(rail) ? (intent.env === "live" ? "base" : "base-sepolia") : null, feeUsd: fee, confirmedAt: now(), status: "confirmed", explorerUrl: intent.explorerUrl, dashboardUrl: intent.dashboardUrl };
  db.settlements.push(st); intent.settlementId = st.id; intent.bankFeeUsd = bankFee; inv.paid = true; po.status = "paid";
  mark(intent, "settled", u.source, u.detail ?? "Provider confirmed settlement");
  const cash = cashAccount(rail);
  db.journals.push(tj(tenantOf(intent), makeJournal(nextId("jnl"), `Payment ${inv.number} via ${rail}`, intent.id, [{ account: "2000 Accounts payable", debit: inv.amount }, { account: cash, credit: inv.amount }])));
  if (fee) db.journals.push(tj(tenantOf(intent), makeJournal(nextId("jnl"), `Rail fee ${rail}`, intent.id, [{ account: "6100 Payment fees", debit: fee }, { account: cash, credit: fee }])));
  ev("payment", intent.id, "settlement.confirmed", { rail, railRef: st.railRef, txHash, source: u.source, env: intent.env });
  erp(erpPostPayment(sup, po.erpRef ?? po.id, inv.number, inv.amount, st.railRef, st.txHash));
  ev("payment", intent.id, "erp.payment_posted", { system: sup.erp, invoice: inv.number });
  publish(tenantOf(intent), "payment.settled", { id: intent.id, amount: intent.amount, rail, providerRef: st.railRef, txHash });
  save(); return intent;
}
/** Bank pricing on top of the rail cost. Lives on the bank tenant's settings. */
export function bankFeeFor(tenantId: string, rail: Rail, amount: number) {
  const t = P.getTenant(tenantId); const bank = t?.parentId ? P.getTenant(t.parentId) : t;
  const p = bank?.pricing?.[rail]; if (!p) return 0;
  return Math.round((amount * p.pct / 100 + p.fixed) * 100) / 100;
}

/** The settlement watcher. Asks each adapter for the status of every pending intent. */
export async function pollSettlements() {
  const pending = db.intents.filter((i) => i.status === "pending" && i.rail && i.providerRef && i.kind !== "refund");
  for (const i of pending) {
    try { const r = await adapter(i.rail!).status(i.providerRef!, i.env ?? "sandbox"); if (r.status !== "pending" || r.explorerUrl !== i.explorerUrl) applyRailUpdate(i.id, { status: r.status, source: "watcher", detail: r.detail, explorerUrl: r.explorerUrl }); }
    catch (e: any) { (i.timeline ??= []).push({ at: now(), status: i.status, source: "watcher", detail: `Status check failed: ${e.message}` }); }
  }
  return pending.length;
}
let watcher: ReturnType<typeof setInterval> | null = null;
export function startSettlementWatcher(ms: number) {
  if (watcher || ms <= 0) return; let busy = false;
  watcher = setInterval(async () => { if (busy) return; busy = true; try { await pollSettlements(); } finally { busy = false; } }, ms);
  watcher.unref?.();
}

/** Webhook entry point. The adapter verifies the signature, this dedupes by provider event id and applies updates. */
export async function ingestWebhook(provider: "stripe" | "circle", raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  const events = await adapter(provider === "stripe" ? "stripe_card" : "circle_usdc").handleWebhook(raw, headers);
  const out: { eventId: string; type: string; intentId: string | null; applied: boolean }[] = [];
  for (const e of events) {
    const intent = e.providerRef ? db.intents.find((i) => i.providerRef === e.providerRef && i.kind !== "refund") : undefined;
    const fresh = sql.prepare("INSERT OR IGNORE INTO provider_events (provider, event_id, type, intent_id, received_at) VALUES (?,?,?,?,?)").run(provider, e.eventId, e.type, intent?.id ?? null, now()).changes > 0;
    if (!fresh) { out.push({ eventId: e.eventId, type: e.type, intentId: intent?.id ?? null, applied: false }); continue; }
    if (e.dispute) openCase({ tenantId: intent ? tenantOf(intent) : TENANT, kind: "dispute", intentId: intent?.id ?? null, title: `Card dispute ${e.dispute.reason}`, detail: { ...e.dispute, providerRef: e.providerRef, eventId: e.eventId } });
    if (intent && e.status) { (intent.timeline ??= []).push({ at: now(), status: intent.status, source: "webhook", detail: `${provider} ${e.type}` }); applyRailUpdate(intent.id, { status: e.status, source: "webhook", detail: e.detail, explorerUrl: e.explorerUrl }); }
    ev("webhook", e.eventId, `webhook.${provider}`, { type: e.type, intentId: intent?.id ?? null, providerRef: e.providerRef });
    out.push({ eventId: e.eventId, type: e.type, intentId: intent?.id ?? null, applied: true });
  }
  save(); return { received: out };
}

export type Case = { id: string; tenantId?: string; kind: "dispute" | "sanctions"; status: "open" | "closed"; intentId: string | null; title: string; detail: any; openedAt: string;
  sar?: { status: "draft" | "filed-internally"; text: string; draftedBy: string; updatedBy: string; updatedAt: string; filedBy?: string; filedAt?: string }; closedBy?: string; closedAt?: string; resolution?: string };
export function openCase(c: Omit<Case, "id" | "status" | "openedAt">) {
  const x: Case = { id: `case-${crypto.randomUUID().slice(0, 8)}`, status: "open", openedAt: now(), ...c, tenantId: c.tenantId ?? TENANT };
  sql.prepare("INSERT INTO cases (id, tenant_id, status, data) VALUES (?,?,?,?)").run(x.id, x.tenantId, x.status, JSON.stringify(x));
  db.alerts.push({ at: x.openedAt, kind: x.kind, detail: `${x.id}: ${x.title}`, tenantId: x.tenantId });
  ev("case", x.id, "case.opened", x); publish(x.tenantId!, "case.opened", { id: x.id, kind: x.kind, title: x.title }); return x;
}
export function saveCase(x: Case) { sql.prepare("UPDATE cases SET status = ?, data = ? WHERE id = ?").run(x.status, JSON.stringify(x), x.id); return x; }
export const getCase = (id: string) => { const r = sql.prepare("SELECT data FROM cases WHERE id = ?").get(id) as { data: string } | undefined; return r ? (JSON.parse(r.data) as Case) : null; };
export const listCases = (tenantId?: string | null) => (sql.prepare(`SELECT data FROM cases ${tenantId ? "WHERE tenant_id = ?" : ""} ORDER BY rowid DESC`).all(...(tenantId ? [tenantId] : [])) as { data: string }[]).map((r) => JSON.parse(r.data) as Case);

/** Rails with readiness, environment and fee quote for the Settings and Payments pages. */
export function railsView(tenantId = TENANT) {
  return railCandidates(tenantId, 1000).map(({ rail, label, feeUsd, maxAmount, settleMinutes, configured, notConfiguredReason, env, address }) => ({ rail, label, feeUsd, maxAmount, settleMinutes, configured, notConfiguredReason, env, address }));
}
export async function railBalances(tenantId = TENANT) {
  return Promise.all(allAdapters().map(async (a) => {
    const env = P.railEnv(tenantId, a.id);
    const rd = railReadiness(a.id, env); if (!rd.configured) return { rail: a.id, error: `Not configured: ${rd.reason}` };
    try { return await a.balance(env); } catch (e: any) { return { rail: a.id, error: e.message }; }
  }));
}

/** Refunds use the provider's own refund where it exists (Stripe). Stablecoin sends are final, a refund is a new payment from the supplier. */
export async function refund(intentId: string, amount: number, reason: string) {
  const pi = must(db.intents.find((p) => p.id === intentId), "payment intent");
  if (pi.kind === "refund") throw new HttpError(409, "A refund cannot be refunded");
  const st = db.settlements.find((s) => s.id === pi.settlementId);
  if (!st) throw new HttpError(409, "Payment not settled");
  const already = db.refunds.filter((r) => r.originalIntentId === intentId && r.status !== "failed" && r.status !== "rejected").reduce((a, r) => a + r.amount, 0);
  if (amount <= 0 || already + amount > pi.amount) throw new HttpError(422, `Refund ${amount} exceeds refundable ${round(pi.amount - already)}`);
  const a = adapter(st.rail);
  if (!a.refund) throw new HttpError(501, `${st.rail} transfers are final. Ask the supplier to send a new payment back.`);
  const id = nextId("rf");
  const rc = await a.refund(st.railRef, amount, pi.env ?? "sandbox");
  const r = { id, originalIntentId: intentId, amount, reason, rail: st.rail, status: rc.status === "settled" ? "settled" as const : rc.status === "failed" ? "failed" as const : "pending" as const, railRef: rc.providerRef, txHash: null, createdAt: now() };
  db.refunds.push(r);
  // The refund is also a payment in its own right, linked to the original, so it shows in payments, revenue and recon.
  const linked: PaymentIntent = { id: nextId("pi"), kind: "refund", linkedIntentId: pi.id, invoiceId: pi.invoiceId, mandateId: pi.mandateId, amount, currency: "USD", status: r.status === "settled" ? "settled" : r.status === "failed" ? "failed" : "pending",
    rail: st.rail, env: pi.env, providerRef: rc.providerRef, dashboardUrl: rc.dashboardUrl ?? pi.dashboardUrl, createdAt: now(), tenantId: tenantOf(pi), idempotencyKey: `refund-${id}`, blockedReason: r.status === "failed" ? "Provider refused the refund" : undefined,
    timeline: [{ at: now(), status: "created", source: "platform", detail: `Refund of ${pi.id}: ${reason}` }, { at: now(), status: r.status === "settled" ? "settled" : r.status, source: "adapter", detail: `${st.rail} refund ${rc.providerRef}` }] };
  db.intents.push(linked); (pi.refundIds ??= []).push(linked.id); (r as any).intentId = linked.id;
  if (r.status === "settled") db.journals.push(tj(tenantOf(pi), makeJournal(nextId("jnl"), `Refund ${id} for ${intentId}`, linked.id, [{ account: cashAccount(st.rail), debit: amount }, { account: "1400 Supplier refunds receivable cleared", credit: amount }])));
  ev("refund", id, `refund.${r.status}`, { originalIntentId: intentId, refundIntentId: linked.id, amount, rail: st.rail, providerRef: rc.providerRef });
  ev("payment", pi.id, "payment.refund_linked", { refundIntentId: linked.id, amount });
  if (r.status === "settled") publish(tenantOf(pi), "payment.refunded", { id: linked.id, originalId: pi.id, amount, rail: st.rail });
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
export function camt053(date = new Date().toISOString().slice(0, 10), tenantId: string | null = null) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cashAccts = ["1000 Cash operating", "1010 USDC treasury"];
  const ntries = db.journals.filter((j) => !tenantId || tenantOf(j) === tenantId).flatMap((j) => j.entries.filter((e) => cashAccts.includes(e.account)).map((e) => {
    const st = db.settlements.find((s) => s.paymentIntentId === j.ref);
    const amt = e.debit || e.credit;
    return `      <Ntry><Amt Ccy="USD">${amt.toFixed(2)}</Amt><CdtDbtInd>${e.credit ? "DBIT" : "CRDT"}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${j.createdAt.slice(0, 10)}</Dt></BookgDt><AcctSvcrRef>${esc(st?.railRef ?? j.id)}</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>${esc(st?.txHash ?? j.ref)}</EndToEndId></Refs><AddtlTxInf>${esc(j.memo)} | ${esc(e.account)}</AddtlTxInf></TxDtls></NtryDtls></Ntry>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>STMT-${date}-${db.seq}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${(tenantId ?? "ALL").toUpperCase()}-${date}</Id><Acct><Id><Othr><Id>${(tenantId ?? "ALL").toUpperCase()}-OPERATING-AND-USDC</Id></Othr></Id><Ccy>USD</Ccy></Acct>
      <TxsSummry><TtlNtries><NbOfNtries>${ntries.length}</NbOfNtries></TtlNtries></TxsSummry>
${ntries.join("\n")}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

/** Full flow used by the scenario buttons and the e2e script. */
export async function runFlow(need: string, opts: { scenario?: "happy" | "sanctioned" | "poisoned"; autoApprove?: boolean; tenantId?: string } = {}) {
  const steps: { step: string; ok: boolean; detail: unknown }[] = [];
  const log = (step: string, ok: boolean, detail: unknown) => steps.push({ step, ok, detail });
  const d = await draftPo(need, opts.tenantId ?? TENANT);
  if (opts.scenario === "sanctioned") { d.value.supplierId = "sup-fabrikam"; d.value.category = "components"; d.value.lines = [{ sku: "FB-STL-304", description: "Stainless steel sheet 304 per ton", qty: 2, unitPrice: 3100 }]; d.value.justification = "Scenario: steel order to Fabrikam Metals whose wallet is on the demo watchlist"; }
  log("PO draft", true, { source: d.source, note: d.note, draft: d.value });
  let po = createPo(d.value, buyerAgent(opts.tenantId ?? TENANT)?.id);
  log("Policy check", po.policy.outcome !== "deny", po.policy);
  if (po.status === "pending_approval" && opts.autoApprove !== false) { po = autoApprove(po); log("Human approval", po.status === "approved", { rule: po.approval?.ruleName, approvals: po.approval?.levels.flatMap((l) => l.approvals.map((a) => a.userId)) }); }
  if (po.status !== "approved") return { steps, poId: po.id };
  receiveGoods(po.id); log("Goods receipt", true, {});
  const inv = await submitInvoice(po.id, invoiceText(po.id, { poison: opts.scenario === "poisoned" }));
  log("Supplier invoice", true, { extractedBy: inv.extractedBy, number: inv.number, total: inv.amount, injection: (inv as any).injection });
  const m = matchInvoice(inv.id); log("3-way match", m.status === "matched", m);
  if (m.status !== "matched") return { steps, poId: po.id, invoiceId: inv.id };
  const { intent } = await payInvoice(inv.id, `idem-${inv.id}`);
  log("Rail choice", !!intent.route?.rail, { rail: intent.route?.rail, explanation: intent.explanation, explainedBy: intent.explainedBy });
  log("Compliance", intent.compliance?.outcome === "clear", intent.compliance);
  log("Submitted to rail", intent.status === "pending" || intent.status === "settled", { status: intent.status, rail: intent.rail, providerRef: intent.providerRef, blockedReason: intent.blockedReason });
  return { steps, poId: po.id, invoiceId: inv.id, intentId: intent.id };
}
export { SIGNERS };
