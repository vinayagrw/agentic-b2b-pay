/**
 * Virtual cards. Four types: one-time (closes after the first approved charge), vendor-locked (one merchant or MCC),
 * recurring (monthly limit) and agent cards (scoped to an AI agent's mandate and allowed suppliers).
 * A fifth type is the mandate-bound virtual card. It is issued from one approved order, stores the cart binding hash and the exact cart amount,
 * and approves one charge only when the supplier, the amount and the signed AP2 mandate pair all still match.
 * The issuer is Stripe Issuing in test mode when the account has it switched on, else a simulated issuer with the same interface.
 * We never store or return a full card number or CVC. Only last4 leaves this module. Reveal is mocked and needs step-up.
 * Issuing above the step-up threshold needs a second person (maker-checker) and a fresh authenticator code.
 */
import crypto from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { sql } from "./db.js";
import { secret } from "./config.js";
import { db, nextId, save, tenantOf } from "./modules/store.js";
import { makeJournal } from "./modules/ledger.js";
import * as P from "./platform.js";
import * as I from "./iam.js";
import * as SU from "./stepup.js";
import * as AP2 from "./modules/ap2.js";

export type CardType = "one_time" | "vendor_locked" | "recurring" | "agent" | "mandate";
export type CardStatus = "pending_approval" | "active" | "frozen" | "canceled" | "closed" | "rejected";
export type DeclineCode = "frozen" | "canceled" | "already_used" | "expired" | "wrong_merchant" | "wrong_currency" | "over_limit" | "agent_paused" | "not_issued" | "wrong_amount" | "mandate_invalid";
export type Card = { id: string; tenantId: string; type: CardType; status: CardStatus; issuer: "stripe" | "simulated"; providerRef: string | null; cardholderRef: string | null; last4: string; expMonth: number; expYear: number;
  limit: number; currency: "USD" | "EUR" | "GBP"; allowedMerchants: string[]; allowedMccs: string[]; supplierId: string | null; poId: string | null; ownerType: "user" | "agent"; ownerId: string; label: string; createdBy: string; approvedBy: string | null; createdAt: string; updatedAt: string;
  /** Mandate-bound cards only: hash of the signed cart, the exact cart amount and the cart mandate id at issue time. */
  bindingHash: string | null; cartAmount: number | null; cartMandateId: string | null };
/** supplierId is optional. When the caller knows the supplier, a mandate-bound card also checks it against the order supplier. */
export type AuthRequest = { merchant: string; mcc?: string; amount: number; currency?: string; supplierId?: string };
export type Decision = { approved: boolean; code: DeclineCode | null; reason: string };

export class CardError extends P.AuthError {}
const now = () => new Date().toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Rough USD rates for the limit checks only. Payments use the FX module. */
const USD_RATE: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27 };
export const toUsd = (amount: number, currency: string) => r2(amount * (USD_RATE[currency] ?? 1));
const monthly = (t: CardType) => t === "recurring" || t === "agent";
export const TYPE_TEXT: Record<CardType, string> = { one_time: "One-time", vendor_locked: "Vendor-locked", recurring: "Recurring", agent: "Agent card", mandate: "Mandate-bound" };

const DECLINE_TEXT: Record<DeclineCode, string> = {
  frozen: "Declined. The card is frozen.", canceled: "Declined. The card is canceled.", already_used: "Declined. This one-time card was already used.",
  expired: "Declined. The card has expired.", wrong_merchant: "Declined. This merchant is not allowed on this card.", wrong_currency: "Declined. The currency does not match the card.",
  over_limit: "Declined. This charge goes over the card limit.", agent_paused: "Declined. The agent that owns this card is paused.", not_issued: "Declined. The card is not issued yet.",
  wrong_amount: "Declined. The charge must equal the order amount exactly.", mandate_invalid: "Declined. The signed mandate for this order is missing or has changed.",
};

// Rows

const toCard = (r: any): Card => ({ id: r.id, tenantId: r.tenant_id, type: r.type, status: r.status, issuer: r.issuer, providerRef: r.provider_ref, cardholderRef: r.cardholder_ref, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year,
  limit: r.limit_amount, currency: r.currency, allowedMerchants: JSON.parse(r.allowed_merchants), allowedMccs: JSON.parse(r.allowed_mccs), supplierId: r.supplier_id, poId: r.po_id, ownerType: r.owner_type, ownerId: r.owner_id, label: r.label, createdBy: r.created_by, approvedBy: r.approved_by, createdAt: r.created_at, updatedAt: r.updated_at, bindingHash: r.binding_hash ?? null, cartAmount: r.cart_amount ?? null, cartMandateId: r.cart_mandate_id ?? null });
const toAuth = (r: any) => ({ id: r.id as string, cardId: r.card_id as string, merchant: r.merchant as string, mcc: r.mcc as string | null, amount: r.amount as number, currency: r.currency as string, approved: !!r.approved, reason: r.reason as string, status: r.status as string, capturedAmount: r.captured_amount as number, journalId: r.journal_id as string | null, providerRef: r.provider_ref as string | null, source: r.source as string, createdAt: r.created_at as string });
export type CardAuth = ReturnType<typeof toAuth>;

export function getCard(tenantId: string, id: string): Card {
  const r = sql.prepare("SELECT * FROM cards WHERE id = ? AND tenant_id = ?").get(id, tenantId); if (!r) throw new CardError(404, "card not found"); return toCard(r);
}
const put = (c: Card) => sql.prepare(`INSERT OR REPLACE INTO cards (id, tenant_id, type, status, issuer, provider_ref, cardholder_ref, last4, exp_month, exp_year, limit_amount, currency, allowed_merchants, allowed_mccs, supplier_id, po_id, owner_type, owner_id, label, created_by, approved_by, created_at, updated_at, binding_hash, cart_amount, cart_mandate_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, c.tenantId, c.type, c.status, c.issuer, c.providerRef, c.cardholderRef, c.last4, c.expMonth, c.expYear, c.limit, c.currency, JSON.stringify(c.allowedMerchants), JSON.stringify(c.allowedMccs), c.supplierId, c.poId, c.ownerType, c.ownerId, c.label, c.createdBy, c.approvedBy, c.createdAt, (c.updatedAt = now()), c.bindingHash, c.cartAmount, c.cartMandateId);
export const authsFor = (tenantId: string, cardId: string) => (sql.prepare("SELECT * FROM card_authorizations WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC, rowid DESC").all(tenantId, cardId) as any[]).map(toAuth);
const tenantAuths = (tenantId: string | null) => (sql.prepare(`SELECT * FROM card_authorizations ${tenantId ? "WHERE tenant_id = ?" : ""} ORDER BY created_at DESC, rowid DESC`).all(...(tenantId ? [tenantId] : [])) as any[]).map((r) => ({ ...toAuth(r), tenantId: r.tenant_id as string }));

/** Approved spend on a card. Monthly cards count the current calendar month only. */
export function spent(c: Card, at = Date.now()) {
  const month = new Date(at).toISOString().slice(0, 7);
  return r2(authsFor(c.tenantId, c.id).filter((a) => a.approved && a.status !== "reversed" && (!monthly(c.type) || a.createdAt.slice(0, 7) === month)).reduce((s, a) => s + a.amount, 0));
}

// Issuers. Same interface for Stripe Issuing and the simulated issuer.

type IssueInput = { card: Card; holderName: string };
export type Issuer = {
  kind: "stripe" | "simulated"; label: string; reason: string;
  create(i: IssueInput): Promise<{ providerRef: string; cardholderRef: string | null; last4: string; expMonth: number; expYear: number }>;
  setStatus(c: Card, s: "active" | "inactive" | "canceled"): Promise<void>;
  setLimit(c: Card, limit: number): Promise<void>;
  /** Creates a test authorization at the provider and returns its id, or null when the issuer has no test helpers. */
  testAuthorize(c: Card, req: AuthRequest, approved: boolean): Promise<string | null>;
};

const simulated = (reason: string): Issuer => ({
  kind: "simulated", label: "Simulated issuer", reason,
  async create(i) { const d = new Date(); return { providerRef: `sim_ic_${crypto.randomUUID().slice(0, 12)}`, cardholderRef: null, last4: String(crypto.randomInt(0, 10000)).padStart(4, "0"), expMonth: i.card.expMonth || d.getUTCMonth() + 1, expYear: i.card.expYear || d.getUTCFullYear() + 1 }; },
  async setStatus() {}, async setLimit() {}, async testAuthorize() { return null; },
});

/** Small map from MCC to Stripe Issuing category names, used for spending_controls when every MCC is known. */
const MCC_CATEGORY: Record<string, string> = { "5045": "computers_peripherals_and_software", "5085": "industrial_supplies_not_elsewhere_classified", "4214": "motor_freight_carriers_and_trucking", "5111": "stationary_office_supplies_printing_and_writing_paper", "7372": "computer_programming", "5734": "computer_software_stores", "4816": "computer_network_services" };
const cents = (n: number) => Math.round(n * 100);
const spendingControls = (c: Card, limit = c.limit): Stripe.Issuing.CardCreateParams.SpendingControls => {
  const cats = c.allowedMccs.map((m) => MCC_CATEGORY[m]);
  return { spending_limits: [{ amount: cents(limit), interval: monthly(c.type) ? "monthly" : "all_time" }], ...(cats.length && cats.every(Boolean) ? { allowed_categories: cats as any } : {}) };
};
function stripeIssuer(s: Stripe): Issuer {
  return {
    kind: "stripe", label: "Stripe Issuing (test mode)", reason: "Stripe Issuing is on for this test account",
    async create({ card, holderName }) {
      const ch = await s.issuing.cardholders.create({ type: "company", name: holderName.slice(0, 24) || "B2B Pay", billing: { address: { line1: "510 Townsend St", city: "San Francisco", state: "CA", postal_code: "94103", country: "US" } }, metadata: { tenantId: card.tenantId, owner: `${card.ownerType}:${card.ownerId}` } });
      const ic = await s.issuing.cards.create({ cardholder: ch.id, currency: card.currency.toLowerCase(), type: "virtual", status: "active", spending_controls: spendingControls(card), metadata: { cardId: card.id, tenantId: card.tenantId, type: card.type } }, { idempotencyKey: `card-${card.id}` });
      return { providerRef: ic.id, cardholderRef: ch.id, last4: ic.last4, expMonth: ic.exp_month, expYear: ic.exp_year };
    },
    async setStatus(c, st) { if (c.providerRef) await s.issuing.cards.update(c.providerRef, { status: st }); },
    async setLimit(c, limit) { if (c.providerRef) await s.issuing.cards.update(c.providerRef, { spending_controls: spendingControls(c, limit) as any }); },
    async testAuthorize(c, req, approved) {
      if (!c.providerRef) return null;
      const a = await (s.testHelpers.issuing as any).authorizations.create({ card: c.providerRef, amount: cents(req.amount), currency: (req.currency ?? c.currency).toLowerCase(), merchant_data: { name: req.merchant.slice(0, 40), ...(MCC_CATEGORY[req.mcc ?? ""] ? { category: MCC_CATEGORY[req.mcc!] } : {}) } });
      if (approved && a.status === "pending") await (s.testHelpers.issuing as any).authorizations.capture(a.id).catch(() => undefined);
      return a.id as string;
    },
  };
}

let cached: { at: number; issuer: Issuer } | null = null;
let override: Issuer | null = null;
/** Tests can swap in an issuer. */
export const setIssuer = (i: Issuer | null) => { override = i; cached = null; };
/** Picks Stripe Issuing when the test account supports it, else the simulated issuer. A live key is refused. */
export async function issuer(): Promise<Issuer> {
  if (override) return override;
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.issuer;
  const key = secret("STRIPE_SECRET_KEY") ?? "";
  let i: Issuer;
  if (process.env.CARD_ISSUER === "simulated" || process.env.VITEST) i = simulated("Simulated issuer is forced for this run");
  else if (!key) i = simulated("No Stripe test key is set");
  else if (!/^(sk|rk)_test_/.test(key)) i = simulated("The Stripe key is not a test key, so cards stay simulated");
  else {
    const s = new Stripe(key, { maxNetworkRetries: 1, appInfo: { name: "agentic-b2b-pay" } });
    try { await s.issuing.cardholders.list({ limit: 1 }); i = stripeIssuer(s); } catch (e: any) { i = simulated(/not set up to use Issuing/i.test(String(e?.message)) ? "Stripe Issuing is not turned on for this test account" : "Stripe Issuing could not be reached"); }
  }
  cached = { at: Date.now(), issuer: i }; return i;
}
export async function issuerInfo() { const i = await issuer(); return { kind: i.kind, label: i.label, reason: i.reason }; }

// The authorization decision. One function for the simulator, the Stripe webhook and tests.

/** Fresh check of the order and its signed AP2 mandates for a mandate-bound card. Null for other card types. */
export function mandateStatus(c: Card, at = Date.now()) {
  if (c.type !== "mandate") return null;
  const pair = c.poId ? AP2.currentPair(c.poId) : { intent: undefined, cart: undefined };
  const base = { intentId: pair.intent?.id ?? null, cartId: pair.cart?.id ?? null, cartHash: pair.cart?.hash ?? null, bindingHash: c.bindingHash, checks: [] as AP2.MandateCheck[] };
  const bad = (reason: string, checks: AP2.MandateCheck[] = []) => ({ ...base, ok: false, reason, checks });
  const po = db.pos.find((p) => p.id === c.poId && tenantOf(p) === c.tenantId);
  if (!po || !c.bindingHash || c.cartAmount == null || !c.supplierId) return bad("The order for this card is missing");
  if (po.status === "rejected") return bad("The order was rejected");
  if (!pair.intent || !pair.cart) return bad("The signed mandates for this order are missing");
  if (AP2.cartBindingHash(pair.cart.body) !== c.bindingHash) return bad("The signed cart changed after the card was issued");
  const v = AP2.verifyMandatePair(pair.intent, pair.cart, { poId: po.id, supplierId: c.supplierId, currency: c.currency, amount: c.cartAmount, lines: pair.cart.body.lines }, new Date(at));
  if (!v.ok) return bad("The signed mandates no longer verify", v.checks);
  return { ...base, ok: true, reason: "Both mandates are valid and match this card", checks: v.checks };
}

export function decide(c: Card, req: AuthRequest, at = Date.now()): Decision {
  const no = (code: DeclineCode, reason = DECLINE_TEXT[code]): Decision => ({ approved: false, code, reason });
  if (c.status === "closed" && c.type === "mandate") return no("already_used", "Declined. This card was already used for its order.");
  if (c.status === "pending_approval" || c.status === "rejected") return no("not_issued");
  if (c.status === "closed") return no("already_used");
  if (c.status === "canceled") return no("canceled");
  if (c.status === "frozen") return no("frozen");
  if (at > Date.UTC(c.expYear, c.expMonth, 1)) return no("expired");
  if ((req.currency ?? c.currency).toUpperCase() !== c.currency) return no("wrong_currency");
  const m = req.merchant.trim().toLowerCase();
  const merchantOk = !c.allowedMerchants.length || c.allowedMerchants.some((x) => x.toLowerCase() === m);
  const mccOk = !c.allowedMccs.length || (!!req.mcc && c.allowedMccs.includes(req.mcc));
  if (c.type === "vendor_locked" ? !(c.allowedMerchants.length ? merchantOk : mccOk) : !(merchantOk && mccOk)) return no("wrong_merchant");
  if (c.type === "mandate") {
    if (req.supplierId && req.supplierId !== c.supplierId) return no("wrong_merchant", "Declined. The supplier does not match the order.");
    const ms = mandateStatus(c, at)!;
    if (!ms.ok) return no("mandate_invalid", `${DECLINE_TEXT.mandate_invalid} ${ms.reason}.`);
    if (r2(req.amount) !== c.cartAmount) return no("wrong_amount");
  }
  if (c.ownerType === "agent") {
    const a = db.agents.find((x) => x.id === c.ownerId); if (!a || a.status !== "active" || db.killSwitch) return no("agent_paused");
    const md = db.mandates.find((x) => x.agentId === c.ownerId); if (md && req.amount > md.perTxnMax) return no("over_limit");
  }
  if (!(req.amount > 0) || r2(spent(c, at) + req.amount) > c.limit) return no("over_limit");
  return { approved: true, code: null, reason: "Approved. The charge fits the card rules." };
}

/** Records an authorization. Approved ones are captured at once and post a journal, so they show in transactions and recon. */
export function authorize(tenantId: string, cardId: string, req: AuthRequest, o: { source: "simulator" | "stripe"; actor: string | null; providerRef?: string | null; at?: number } = { source: "simulator", actor: null }) {
  const c = getCard(tenantId, cardId); const at = o.at ?? Date.now();
  const d = decide(c, req, at); const id = `iauth-${crypto.randomUUID().slice(0, 10)}`; const amount = r2(req.amount);
  let journalId: string | null = null;
  if (d.approved) {
    const j = { ...makeJournal(nextId("jnl"), `Card capture ${id}`, id, [{ account: "6100 Card spend", debit: toUsd(amount, c.currency) }, { account: "2100 Card payable", credit: toUsd(amount, c.currency) }]), tenantId };
    db.journals.push(j); journalId = j.id;
  }
  sql.prepare("INSERT INTO card_authorizations (id, tenant_id, card_id, merchant, mcc, amount, currency, approved, reason, status, captured_amount, journal_id, provider_ref, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, tenantId, c.id, req.merchant.slice(0, 80), req.mcc ?? null, amount, c.currency, +d.approved, d.reason, d.approved ? "captured" : "declined", d.approved ? amount : 0, journalId, o.providerRef ?? null, o.source, new Date(at).toISOString());
  if (d.approved && (c.type === "one_time" || c.type === "mandate")) { c.status = "closed"; put(c); }
  P.audit(o.actor, "card", c.id, d.approved ? "card.authorization_approved" : "card.authorization_declined", { authorization: id, merchant: req.merchant.slice(0, 80), mcc: req.mcc ?? null, amount, code: d.code, source: o.source });
  save();
  return { authorization: authsFor(tenantId, c.id).find((a) => a.id === id)!, decision: d, card: view(getCard(tenantId, c.id)) };
}

// Views. Nothing here can carry a full card number, there is none stored.

const ownerName = (c: Pick<Card, "ownerType" | "ownerId">) => c.ownerType === "agent" ? db.agents.find((a) => a.id === c.ownerId)?.name ?? c.ownerId : P.getUser(c.ownerId)?.name ?? c.ownerId;
export function view(c: Card) {
  const sp = spent(c);
  return { id: c.id, type: c.type, typeText: TYPE_TEXT[c.type], status: c.status, issuer: c.issuer, issuerLabel: c.issuer === "stripe" ? "Stripe Issuing (test mode)" : "Simulated issuer", last4: c.last4, expiry: `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}`,
    limit: c.limit, currency: c.currency, period: monthly(c.type) ? "month" : "card", spent: sp, remaining: r2(Math.max(0, c.limit - sp)), allowedMerchants: c.allowedMerchants, allowedMccs: c.allowedMccs, supplierId: c.supplierId, poId: c.poId,
    ownerType: c.ownerType, ownerId: c.ownerId, owner: ownerName(c), label: c.label, createdBy: c.createdBy, createdByName: P.getUser(c.createdBy)?.name ?? c.createdBy, approvedBy: c.approvedBy, createdAt: c.createdAt, updatedAt: c.updatedAt, providerRef: c.providerRef, bindingHash: c.bindingHash, cartAmount: c.cartAmount, cartMandateId: c.cartMandateId };
}
export const listCards = (tenantId: string) => (sql.prepare("SELECT * FROM cards WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC").all(tenantId) as any[]).map((r) => view(toCard(r)));
/** The linked order and a fresh mandate check, for the card page. Null for cards that are not mandate-bound. */
export function orderLink(c: Card) {
  const mandate = mandateStatus(c); if (!mandate) return null;
  const po = db.pos.find((p) => p.id === c.poId && tenantOf(p) === c.tenantId);
  return { poId: c.poId, status: po?.status ?? "missing", supplierId: c.supplierId, supplier: db.suppliers.find((s) => s.id === c.supplierId)?.name ?? c.supplierId, total: po?.total ?? null, currency: c.currency, cartAmount: c.cartAmount, erpRef: po?.erpRef ?? null, mandate };
}
export const cardDetail = (tenantId: string, id: string) => { const c = getCard(tenantId, id); return { card: view(c), authorizations: authsFor(tenantId, id), order: orderLink(c) }; };

// Issue and approve

export const IssueInput = z.object({
  type: z.enum(["one_time", "vendor_locked", "recurring", "agent"]), label: z.string().trim().min(2).max(60),
  limit: z.coerce.number().positive().max(1_000_000), currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
  expiryMonths: z.coerce.number().int().min(1).max(60).default(12),
  supplierId: z.string().optional(), merchant: z.string().trim().max(80).optional(), mcc: z.string().regex(/^\d{4}$/).optional(),
  poId: z.string().optional(), agentId: z.string().optional(), ownerUserId: z.string().optional(),
});
async function activate(c: Card) {
  const iss = await issuer();
  const holder = ownerName(c);
  const out = await iss.create({ card: c, holderName: holder });
  Object.assign(c, { issuer: iss.kind, providerRef: out.providerRef, cardholderRef: out.cardholderRef, last4: out.last4, expMonth: out.expMonth, expYear: out.expYear, status: "active" as CardStatus });
}
export async function issueCard(u: P.User, tenantId: string, sessionId: string | null, raw: unknown) {
  I.requirePermission(u, "flow.operate", { tenantId });
  const x = IssueInput.parse(raw);
  const sup = x.supplierId ? db.suppliers.find((s) => s.id === x.supplierId && tenantOf(s) === tenantId) : null;
  if (x.supplierId && !sup) throw new CardError(404, "supplier not found");
  if (x.poId && !db.pos.some((p) => p.id === x.poId && tenantOf(p) === tenantId)) throw new CardError(404, "purchase order not found");
  let merchants = sup ? [sup.name] : x.merchant ? [x.merchant] : []; const mccs = x.mcc ? [x.mcc] : [];
  let ownerType: Card["ownerType"] = "user"; let ownerId = u.id; let limit = x.limit;
  if (x.ownerUserId) { const o = P.getUser(x.ownerUserId); if (!o || o.tenantId !== tenantId) throw new CardError(404, "user not found"); ownerId = o.id; }
  if (x.type === "vendor_locked" && merchants.length + mccs.length !== 1) throw new CardError(422, "A vendor-locked card needs exactly one supplier, merchant name or MCC");
  if (x.type === "agent") {
    const a = db.agents.find((g) => g.id === x.agentId && tenantOf(g) === tenantId); if (!a) throw new CardError(404, "agent not found");
    if (a.status !== "active") throw new CardError(409, "Resume the agent before giving it a card");
    const md = db.mandates.find((m) => m.agentId === a.id); if (!md) throw new CardError(409, "This agent has no mandate, so it has no spend limit");
    const cap = md.monthlyLimit ?? md.maxAmount; if (toUsd(limit, x.currency) > cap) throw new CardError(422, `The card limit is over the agent's monthly limit of ${cap} USD`);
    const allowed = md.allowedSuppliers.map((id) => db.suppliers.find((s) => s.id === id)?.name).filter(Boolean) as string[];
    if (sup && !md.allowedSuppliers.includes(sup.id)) throw new CardError(422, "This supplier is not in the agent's allowed suppliers");
    merchants = sup ? [sup.name] : allowed; ownerType = "agent"; ownerId = a.id;
  }
  const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + x.expiryMonths);
  const c: Card = { id: nextId("card"), tenantId, type: x.type, status: "pending_approval", issuer: (await issuer()).kind, providerRef: null, cardholderRef: null, last4: "", expMonth: exp.getUTCMonth() + 1, expYear: exp.getUTCFullYear(),
    limit: r2(limit), currency: x.currency, allowedMerchants: merchants, allowedMccs: mccs, supplierId: sup?.id ?? null, poId: x.poId ?? null, ownerType, ownerId, label: x.label, createdBy: u.id, approvedBy: null, createdAt: now(), updatedAt: now(), bindingHash: null, cartAmount: null, cartMandateId: null };
  return finishIssue(u, sessionId, c);
}
/** Shared end of issuing: a large limit waits for a second approver, a small one is issued at once. */
async function finishIssue(u: P.User, sessionId: string | null, c: Card) {
  const usd = toUsd(c.limit, c.currency);
  if (SU.needsStepUp(usd)) {
    SU.requireFresh(u, sessionId, usd);
    put(c); P.audit(u.id, "card", c.id, "card.requested", { type: c.type, limit: c.limit, currency: c.currency, reason: `Limit over ${SU.thresholdUsd()} USD needs a second approver` });
    return { card: view(c), needsApproval: true };
  }
  await activate(c); put(c);
  P.audit(u.id, "card", c.id, "card.issued", { type: c.type, limit: c.limit, currency: c.currency, issuer: c.issuer, last4: c.last4, owner: `${c.ownerType}:${c.ownerId}` });
  return { card: view(c), needsApproval: false };
}
/** Issues a mandate-bound virtual card from an approved order. The limit is the signed cart amount and the card works once. */
export async function issueForOrder(u: P.User, tenantId: string, sessionId: string | null, poId: string) {
  I.requirePermission(u, "flow.operate", { tenantId });
  const po = db.pos.find((p) => p.id === poId && tenantOf(p) === tenantId); if (!po) throw new CardError(404, "purchase order not found");
  if (!["approved", "received", "invoiced"].includes(po.status)) throw new CardError(409, "Only an approved order that is not paid yet can get a card");
  const sup = db.suppliers.find((s) => s.id === po.supplierId); if (!sup) throw new CardError(404, "supplier not found");
  const pair = AP2.currentPair(po.id);
  if (!pair.intent || !pair.cart) throw new CardError(409, "This order has no signed mandates, so a card cannot be bound to it");
  const cart = pair.cart.body;
  const v = AP2.verifyMandatePair(pair.intent, pair.cart, { poId: po.id, supplierId: sup.id, currency: cart.currency, amount: cart.amount, lines: cart.lines });
  if (!v.ok) throw new CardError(409, `The signed mandates for this order do not verify. ${v.reason}`);
  if (!["USD", "EUR", "GBP"].includes(cart.currency)) throw new CardError(422, "Cards work in USD, EUR or GBP only");
  if (sql.prepare("SELECT id FROM cards WHERE tenant_id = ? AND po_id = ? AND type = 'mandate' AND status IN ('pending_approval','active','frozen','closed')").get(tenantId, po.id)) throw new CardError(409, "This order already has a mandate-bound virtual card");
  const exp = new Date(pair.intent.body.expiresAt);
  const c: Card = { id: nextId("card"), tenantId, type: "mandate", status: "pending_approval", issuer: (await issuer()).kind, providerRef: null, cardholderRef: null, last4: "", expMonth: exp.getUTCMonth() + 1, expYear: exp.getUTCFullYear(),
    limit: r2(cart.amount), currency: cart.currency as Card["currency"], allowedMerchants: [sup.name], allowedMccs: [], supplierId: sup.id, poId: po.id, ownerType: "user", ownerId: u.id, label: `Order ${po.id}`.slice(0, 60), createdBy: u.id, approvedBy: null, createdAt: now(), updatedAt: now(),
    bindingHash: AP2.cartBindingHash(cart), cartAmount: r2(cart.amount), cartMandateId: pair.cart.id };
  const out = await finishIssue(u, sessionId, c);
  P.audit(u.id, "card", c.id, "card.bound_to_order", { poId: po.id, supplierId: sup.id, amount: c.cartAmount, currency: c.currency, bindingHash: c.bindingHash, cartMandate: pair.cart.id, intentMandate: pair.intent.id });
  return out;
}
/** The checker decides on a large card. Not the maker, needs payments.approve for the amount and a fresh code to approve. */
export async function decideIssue(u: P.User, tenantId: string, sessionId: string | null, id: string, approve: boolean) {
  const c = getCard(tenantId, id);
  if (c.status !== "pending_approval") throw new CardError(409, `This card is already ${c.status.replace("_", " ")}`);
  if (c.createdBy === u.id) throw new CardError(403, "The person who asked for the card cannot approve it");
  const usd = toUsd(c.limit, c.currency);
  I.requirePermission(u, "payments.approve", { amount: usd, tenantId });
  if (!approve) { c.status = "rejected"; c.approvedBy = u.id; put(c); P.audit(u.id, "card", c.id, "card.rejected", {}); return view(c); }
  SU.requireFresh(u, sessionId, usd);
  c.approvedBy = u.id; await activate(c); put(c);
  P.audit(u.id, "card", c.id, "card.approved", { limit: c.limit, currency: c.currency }); P.audit(u.id, "card", c.id, "card.issued", { type: c.type, issuer: c.issuer, last4: c.last4, owner: `${c.ownerType}:${c.ownerId}` });
  return view(c);
}

// Lifecycle

export async function setState(u: P.User, tenantId: string, id: string, action: "freeze" | "unfreeze" | "cancel") {
  I.requirePermission(u, "flow.operate", { tenantId });
  const c = getCard(tenantId, id); const iss = await issuer();
  const live = c.issuer === "stripe" && iss.kind === "stripe";
  if (action === "freeze") { if (c.status !== "active") throw new CardError(409, "Only an active card can be frozen"); if (live) await iss.setStatus(c, "inactive"); c.status = "frozen"; }
  if (action === "unfreeze") { if (c.status !== "frozen") throw new CardError(409, "Only a frozen card can be unfrozen"); if (live) await iss.setStatus(c, "active"); c.status = "active"; }
  if (action === "cancel") { if (["canceled", "rejected"].includes(c.status)) throw new CardError(409, "This card is already closed"); if (live && c.providerRef) await iss.setStatus(c, "canceled"); c.status = "canceled"; }
  put(c); P.audit(u.id, "card", c.id, `card.${action === "cancel" ? "canceled" : action === "freeze" ? "frozen" : "unfrozen"}`, {});
  return view(c);
}
/** Raising a limit above the step-up threshold needs payments.approve for that amount and a fresh code. */
export async function changeLimit(u: P.User, tenantId: string, sessionId: string | null, id: string, limit: number) {
  I.requirePermission(u, "flow.operate", { tenantId });
  const c = getCard(tenantId, id); if (!(limit > 0) || limit > 1_000_000) throw new CardError(422, "Enter a limit above zero");
  if (["canceled", "closed", "rejected"].includes(c.status)) throw new CardError(409, "This card is closed");
  if (c.type === "mandate") throw new CardError(422, "The limit of a mandate-bound virtual card is the order amount and cannot change");
  const usd = toUsd(limit, c.currency);
  if (limit > c.limit && SU.needsStepUp(usd)) { I.requirePermission(u, "payments.approve", { amount: usd, tenantId }); SU.requireFresh(u, sessionId, usd); }
  if (c.ownerType === "agent") { const md = db.mandates.find((m) => m.agentId === c.ownerId); const cap = md?.monthlyLimit ?? md?.maxAmount ?? 0; if (usd > cap) throw new CardError(422, `The card limit is over the agent's monthly limit of ${cap} USD`); }
  const iss = await issuer(); if (c.issuer === "stripe" && iss.kind === "stripe") await iss.setLimit(c, limit);
  const before = c.limit; c.limit = r2(limit); put(c);
  P.audit(u.id, "card", c.id, "card.limit_changed", { before, after: c.limit, currency: c.currency }); return view(c);
}
/** Mocked reveal. Needs a fresh step-up code. Returns a masked number only, never the real PAN or CVC. */
export function reveal(u: P.User, tenantId: string, sessionId: string | null, id: string) {
  const c = getCard(tenantId, id);
  if (!SU.status(u.id, sessionId).fresh) throw new CardError(403, "step_up_required: showing card details needs a fresh authenticator code");
  P.audit(u.id, "card", c.id, "card.revealed", { mocked: true });
  return { mocked: true, number: `•••• •••• •••• ${c.last4 || "----"}`, cvc: "•••", expiry: view(c).expiry, note: "This is a mocked reveal. Real card details are never sent to this app. With Stripe Issuing they would show in a secure Stripe frame." };
}

/** The UI simulator. With Stripe Issuing on, it also creates a test authorization through the test helpers. */
export async function simulate(u: P.User, tenantId: string, id: string, raw: unknown) {
  I.requirePermission(u, "flow.operate", { tenantId });
  const x = z.object({ merchant: z.string().trim().min(1).max(80), mcc: z.string().regex(/^\d{4}$/).optional().or(z.literal("").transform(() => undefined)), amount: z.coerce.number().positive().max(1_000_000), currency: z.string().length(3).optional() }).parse(raw);
  const c = getCard(tenantId, id); const iss = await issuer();
  let providerRef: string | null = null; let note: string | null = null;
  if (c.issuer === "stripe" && iss.kind === "stripe") {
    try { providerRef = await iss.testAuthorize(c, x, decide(c, x).approved); } catch (e: any) { note = `Stripe test helper failed, decided here only (${String(e?.message ?? "error").slice(0, 80)})`; }
  }
  return { ...authorize(tenantId, id, x, { source: "simulator", actor: u.id, providerRef }), note };
}

// Stripe Issuing webhook: issuing_authorization.request gets our decision in the response body.

export function stripeWebhook(raw: Buffer | string, headers: Record<string, any>) {
  const key = secret("STRIPE_SECRET_KEY") ?? ""; const whsec = secret("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!/^(sk|rk)_test_/.test(key) || !whsec) throw new CardError(503, "Stripe Issuing webhooks need a test key and STRIPE_WEBHOOK_SECRET");
  let ev: Stripe.Event;
  try { ev = Stripe.webhooks.constructEvent(raw, String(headers["stripe-signature"] ?? ""), whsec); } catch { throw new CardError(400, "bad signature"); }
  if (ev.livemode) throw new CardError(409, "Live events are refused");
  if (ev.type !== "issuing_authorization.request") return { received: true };
  const a = ev.data.object as Stripe.Issuing.Authorization; const ref = typeof a.card === "string" ? a.card : a.card.id;
  const row = sql.prepare("SELECT tenant_id, id FROM cards WHERE provider_ref = ?").get(ref) as any;
  if (!row) return { approved: false };
  const dup = sql.prepare("SELECT approved FROM card_authorizations WHERE provider_ref = ?").get(a.id) as any;
  if (dup) return { approved: !!dup.approved };
  const amount = (a.pending_request?.amount ?? a.amount) / 100;
  const r = authorize(row.tenant_id, row.id, { merchant: a.merchant_data?.name ?? "Unknown merchant", mcc: a.merchant_data?.category_code ?? undefined, amount, currency: String(a.currency).toUpperCase() }, { source: "stripe", actor: null, providerRef: a.id });
  return { approved: r.decision.approved };
}

// Feeds for transactions, reconciliation and the copilot.

export function txRows(scope: string | null) {
  const tenants = new Map(P.listTenants().map((t) => [t.id, t.name]));
  return tenantAuths(scope).map((a) => ({ id: a.id, kind: "card", createdAt: a.createdAt, status: a.approved ? "settled" : "denied", amount: a.amount, rail: "card_issuing", env: "sandbox", tenantId: a.tenantId, tenant: tenants.get(a.tenantId) ?? a.tenantId, supplier: a.merchant, invoice: a.cardId, providerRef: a.providerRef ?? "", reason: a.approved ? "" : a.reason }));
}
export function reconRows(tenantId: string) {
  return tenantAuths(tenantId).filter((a) => a.approved).map((a) => {
    const j = db.journals.find((x) => x.id === a.journalId); const amt = r2(j?.entries.reduce((s, e) => s + e.debit, 0) ?? 0);
    const c = getCard(tenantId, a.cardId); const want = toUsd(a.capturedAmount, c.currency);
    return { settlementId: a.id, intentId: a.cardId, rail: "card_issuing", providerRef: a.providerRef ?? a.id, txHash: null, amount: want, journalId: j?.id ?? null, journalAmount: j ? amt : null, status: (!j ? "unmatched" : amt !== want ? "amount_mismatch" : "matched") as "matched" | "unmatched" | "amount_mismatch" };
  });
}
