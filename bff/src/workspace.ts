import crypto from "node:crypto";
import { z } from "zod";
import { verifyMessage, isAddress, getAddress } from "viem";
import { Category, Rail } from "@b2b/shared";
import { sql } from "./db.js";
import { db, save, nextId, tenantOf, type Agent, type Mandate, type Supplier } from "./modules/store.js";
import { issueKey, verifyAgent } from "./modules/kya.js";
import { appendEvidence } from "./modules/evidence.js";
import { validateRule, type ApprovalRule } from "./modules/rules.js";
import * as P from "./platform.js";
import * as S from "./service.js";
import { config } from "./config.js";
import { stripeClient } from "./rails/stripe.js";
import { publish } from "./hooks.js";

const ev = (t: string, id: string, e: string, p: unknown) => appendEvidence(db.evidence, t, id, e, p);
const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const err = (status: number, msg: string) => new S.HttpError(status, msg);
function inTenant<T extends { tenantId?: string }>(x: T | undefined, tenantId: string, what: string): T {
  if (!x || tenantOf(x) !== tenantId) throw err(404, `${what} not found`);
  return x;
}

// Agents, mandates and scoped keys

/** A scoped agent API key. Only the hash is stored, the plain key is shown once. */
export function issueAgentKey(agent: Agent, actor: string) {
  const plain = `agk_test_${crypto.randomBytes(20).toString("hex")}`;
  const id = `akey-${crypto.randomUUID().slice(0, 8)}`;
  sql.prepare("UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(now(), agent.id);
  sql.prepare("INSERT INTO agent_keys (id, tenant_id, agent_id, prefix, hash, created_by, created_at) VALUES (?,?,?,?,?,?,?)").run(id, tenantOf(agent), agent.id, plain.slice(0, 14), sha(plain), actor, now());
  P.audit(actor, "agent", agent.id, "agent.key_issued", { keyId: id, prefix: plain.slice(0, 14) });
  return { id, key: plain, prefix: plain.slice(0, 14) };
}
export function agentForKey(plain: string) {
  const r = sql.prepare("SELECT * FROM agent_keys WHERE hash = ? AND revoked_at IS NULL").get(sha(plain)) as any;
  if (!r) return null; const a = db.agents.find((x) => x.id === r.agent_id);
  return a && a.status === "active" ? a : null;
}
export const agentKeys = (agentId: string) => sql.prepare("SELECT id, prefix, created_by createdBy, created_at createdAt, revoked_at revokedAt FROM agent_keys WHERE agent_id = ? ORDER BY created_at DESC").all(agentId);

export const MandateInput = z.object({
  perTxnMax: z.number().positive(), monthlyLimit: z.number().positive(), maxAmount: z.number().positive().optional(),
  approvalThreshold: z.number().nonnegative().optional(),
  allowedCategories: z.array(Category).min(1), allowedRails: z.array(Rail).min(1),
  validTo: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "validTo must be a date"),
}).refine((m) => m.perTxnMax <= m.monthlyLimit, { message: "Per transaction limit cannot be above the monthly limit" });

export const NewAgent = z.object({ name: z.string().min(2).max(80), erpRole: z.string().min(2).default("buyer.requisitioner"), protocols: z.array(z.string()).default(["mcp", "a2a"]), mandate: MandateInput });

export function registerAgent(user: P.User, tenantId: string, input: z.infer<typeof NewAgent>) {
  const org = db.orgs.find((o) => tenantOf(o) === tenantId && o.type === "buyer"); if (!org) throw err(409, "Tenant has no buying entity");
  const a: Agent = { id: nextId("agt"), tenantId, orgId: org.id, name: input.name, publicKey: "", kyaStatus: "unverified", erpRole: input.erpRole, protocols: input.protocols, status: "active" };
  issueKey(a); db.agents.push(a);
  const kya = verifyAgent(a, org.kybStatus === "verified");
  const m = input.mandate;
  const suppliers = db.suppliers.filter((s) => tenantOf(s) === tenantId && (!s.onboarding || s.onboarding.status === "verified")).map((s) => s.id);
  const mandate: Mandate = { id: nextId("mdt"), tenantId, agentId: a.id, principalUserId: user.id, type: "intent", maxAmount: m.maxAmount ?? m.monthlyLimit * 12, perTxnMax: m.perTxnMax, monthlyLimit: m.monthlyLimit,
    approvalThreshold: m.approvalThreshold ?? m.perTxnMax, currency: "USD", allowedSuppliers: suppliers, allowedCategories: m.allowedCategories, allowedRails: m.allowedRails, perSupplierLimit: {}, validFrom: now(), validTo: new Date(m.validTo).toISOString(), signature: "" };
  db.mandates.push(mandate); S.signMandate(mandate);
  ev("agent", a.id, "agent.registered", { name: a.name, orgId: org.id, actor: user.id, kya: kya.verified });
  const key = issueAgentKey(a, user.id);
  save(); return { agent: a, mandate, key, kya };
}
export function updateMandate(user: P.User, tenantId: string, agentId: string, input: z.infer<typeof MandateInput>) {
  const a = inTenant(db.agents.find((x) => x.id === agentId), tenantId, "agent");
  const m = db.mandates.find((x) => x.agentId === a.id); if (!m) throw err(404, "mandate not found");
  const before = { perTxnMax: m.perTxnMax, monthlyLimit: m.monthlyLimit, allowedCategories: m.allowedCategories, allowedRails: m.allowedRails, validTo: m.validTo };
  Object.assign(m, { perTxnMax: input.perTxnMax, monthlyLimit: input.monthlyLimit, allowedCategories: input.allowedCategories, allowedRails: input.allowedRails, validTo: new Date(input.validTo).toISOString() });
  if (input.maxAmount) m.maxAmount = input.maxAmount; if (input.approvalThreshold !== undefined) m.approvalThreshold = input.approvalThreshold;
  m.principalUserId = user.id; S.signMandate(m);
  ev("mandate", m.id, "mandate.updated", { actor: user.id, before, after: input });
  save(); return m;
}
export function setAgentState(user: P.User, tenantId: string, agentId: string, action: "suspend" | "resume" | "kill") {
  const a = inTenant(db.agents.find((x) => x.id === agentId), tenantId, "agent");
  if (action === "resume" && (a as any).killed) throw err(409, "A killed agent cannot be resumed. Register a new agent.");
  a.status = action === "resume" ? "active" : "suspended";
  if (action === "kill") { (a as any).killed = true; sql.prepare("UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(now(), a.id); }
  ev("agent", a.id, `agent.${action === "kill" ? "killed" : action === "resume" ? "active" : "suspended"}`, { actor: user.id, keysRevoked: action === "kill" });
  save(); return a;
}
/** Spend and outcomes from the payment_intents table for this agent's mandates. */
export function agentUsage(agentId: string) {
  const ids = db.mandates.filter((m) => m.agentId === agentId).map((m) => m.id);
  if (!ids.length) return { byStatus: [], month: { count: 0, settled: 0 }, total: { count: 0, settled: 0 } };
  const q = `FROM payment_intents WHERE json_extract(data, '$.mandateId') IN (${ids.map(() => "?").join(",")}) AND COALESCE(json_extract(data, '$.kind'), 'payment') = 'payment'`;
  const byStatus = sql.prepare(`SELECT json_extract(data, '$.status') status, COUNT(*) count, ROUND(SUM(json_extract(data, '$.amount')), 2) amount ${q} GROUP BY 1`).all(...ids);
  const month = new Date().toISOString().slice(0, 7);
  const m = sql.prepare(`SELECT COUNT(*) count, ROUND(COALESCE(SUM(CASE WHEN status = 'settled' THEN json_extract(data, '$.amount') END), 0), 2) settled ${q} AND substr(json_extract(data, '$.createdAt'), 1, 7) = ?`).get(...ids, month);
  const t = sql.prepare(`SELECT COUNT(*) count, ROUND(COALESCE(SUM(CASE WHEN status = 'settled' THEN json_extract(data, '$.amount') END), 0), 2) settled ${q}`).get(...ids);
  return { byStatus, month: m, total: t };
}
export function agentsView(tenantId: string) {
  return db.agents.filter((a) => tenantOf(a) === tenantId).map((a) => ({ ...a, publicKey: a.publicKey ? `${a.publicKey.split("\n")[1]?.slice(0, 24)}...` : "", mandate: db.mandates.find((m) => m.agentId === a.id) ?? null, usage: agentUsage(a.id), keys: agentKeys(a.id) }));
}

// Approval rules

export const RuleInput = z.object({
  name: z.string().min(1).max(60), active: z.boolean().default(true), minAmount: z.number().nonnegative(), maxAmount: z.number().positive().nullable(),
  categories: z.array(Category).default([]), entities: z.array(z.string()).default([]),
  levels: z.array(z.object({ role: z.enum(["approver", "client_admin"]), count: z.number().int().min(1).max(5) })).min(1).max(4),
});
export function upsertRule(user: P.User, tenantId: string, input: z.infer<typeof RuleInput>, id?: string) {
  const bad = validateRule(input); if (bad) throw err(422, bad);
  const rules = S.listRules(tenantId);
  const prior = id ? rules.find((r) => r.id === id) : undefined; if (id && !prior) throw err(404, "rule not found");
  const r: ApprovalRule = { ...input, id: prior?.id ?? `rule-${crypto.randomUUID().slice(0, 8)}`, tenantId, position: prior?.position ?? (Math.max(0, ...rules.map((x) => x.position)) + 1) };
  S.saveRule(r); P.audit(user.id, "rule", r.id, prior ? "rule.updated" : "rule.created", { before: prior ?? null, after: r });
  return r;
}
export function deleteRule(user: P.User, tenantId: string, id: string) {
  const r = S.listRules(tenantId).find((x) => x.id === id); if (!r) throw err(404, "rule not found");
  sql.prepare("DELETE FROM approval_rules WHERE id = ?").run(id); P.audit(user.id, "rule", id, "rule.deleted", { rule: r }); return { ok: true };
}
export function reorderRules(user: P.User, tenantId: string, ids: string[]) {
  const rules = S.listRules(tenantId); if (ids.length !== rules.length || !rules.every((r) => ids.includes(r.id))) throw err(422, "Send every rule id once");
  sql.transaction(() => ids.forEach((id, n) => { const r = rules.find((x) => x.id === id)!; S.saveRule({ ...r, position: n + 1 }); }))();
  P.audit(user.id, "rule", tenantId, "rule.reordered", { order: ids }); return S.listRules(tenantId);
}
/** The approvals inbox: pending POs with the current level and whether this user can act. */
export function approvalsInbox(user: P.User, tenantId: string) {
  const users = P.listUsers();
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  return db.pos.filter((p) => tenantOf(p) === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => {
    const sup = db.suppliers.find((s) => s.id === p.supplierId); const agent = db.agents.find((a) => a.id === p.agentId);
    const can = S.canApprove(p, user);
    return { id: p.id, status: p.status, total: p.total, category: p.category, createdAt: p.createdAt, justification: p.justification, supplier: sup?.name ?? p.supplierId, agent: agent?.name ?? p.agentId, lines: p.lines,
      reasons: p.policy.reasons, approval: p.approval ? { ...p.approval, levels: p.approval.levels.map((l) => ({ ...l, approvals: l.approvals.map((a) => ({ ...a, name: name(a.userId) })) })), rejectedBy: p.approval.rejectedBy ? { ...p.approval.rejectedBy, name: name(p.approval.rejectedBy.userId) } : undefined } : null,
      canAct: can.ok, why: can.why };
  }).filter((p) => p.approval || p.status === "pending_approval");
}

// Supplier onboarding

const tokenHash = (t: string) => sha(`onboard:${t}`);
export function inviteSupplier(user: P.User, tenantId: string, input: { name: string; email: string; country?: string }) {
  const name = input.name.trim(); if (name.length < 2) throw err(422, "Supplier name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw err(422, "A valid email is required");
  const orgId = nextId("org"); const id = nextId("sup");
  db.orgs.push({ id: orgId, tenantId, legalName: name, type: "supplier", kybStatus: "pending", country: (input.country ?? "US").toUpperCase().slice(0, 2) });
  const token = crypto.randomBytes(24).toString("base64url");
  const s: Supplier = { id, tenantId, orgId, name, bankDetailsRef: "", walletAddress: null, preferredRail: "stripe_ach", acceptedRails: [], screeningStatus: "clear", erp: "SAP",
    onboarding: { status: "draft", token: token.slice(0, 6), email: input.email, invitedBy: user.id, invitedAt: now(), bank: null, wallet: null } };
  db.suppliers.push(s);
  sql.prepare("INSERT INTO onboarding_tokens (token_hash, tenant_id, supplier_id, created_at, expires_at) VALUES (?,?,?,?,?)").run(tokenHash(token), tenantId, id, now(), new Date(Date.now() + 14 * 864e5).toISOString());
  ev("supplier", id, "supplier.invited", { actor: user.id, email: input.email });
  save(); return { supplier: s, token, link: `/onboard/${token}` };
}
export function newInviteLink(user: P.User, tenantId: string, supplierId: string) {
  const s = inTenant(db.suppliers.find((x) => x.id === supplierId), tenantId, "supplier");
  if (!s.onboarding || s.onboarding.status === "verified") throw err(409, "Supplier is not in onboarding");
  sql.prepare("DELETE FROM onboarding_tokens WHERE supplier_id = ?").run(s.id);
  const token = crypto.randomBytes(24).toString("base64url"); s.onboarding.token = token.slice(0, 6);
  sql.prepare("INSERT INTO onboarding_tokens (token_hash, tenant_id, supplier_id, created_at, expires_at) VALUES (?,?,?,?,?)").run(tokenHash(token), tenantId, s.id, now(), new Date(Date.now() + 14 * 864e5).toISOString());
  ev("supplier", s.id, "supplier.invite_reissued", { actor: user.id }); save(); return { token, link: `/onboard/${token}` };
}
function byToken(token: string) {
  const r = sql.prepare("SELECT * FROM onboarding_tokens WHERE token_hash = ?").get(tokenHash(token)) as any;
  if (!r || r.expires_at < now()) throw err(404, "This onboarding link is not valid or has expired");
  const s = db.suppliers.find((x) => x.id === r.supplier_id); if (!s?.onboarding) throw err(404, "Supplier not found");
  return s as Supplier & { onboarding: NonNullable<Supplier["onboarding"]> };
}
const editable = (s: Supplier) => { if (!["draft", "rejected"].includes(s.onboarding!.status)) throw err(409, `Onboarding is ${s.onboarding!.status}, it can no longer be edited`); };
export const walletMessage = (s: Supplier, address: string) => `Agentic B2B Pay wallet ownership proof\nSupplier: ${s.name}\nSupplier id: ${s.id}\nWallet: ${getAddress(address)}\nNonce: ${sha(`${s.id}:${s.orgId}`).slice(0, 16)}`;

export function onboardingView(token: string) {
  const s = byToken(token); const t = P.getTenant(tenantOf(s))!;
  return { supplierId: s.id, name: s.name, tenant: t.name, theme: P.themeFor(t), status: s.onboarding.status, kyb: s.onboarding.kyb ?? null,
    bank: s.onboarding.bank ? { last4: s.onboarding.bank.last4, bankName: s.onboarding.bank.bankName, holderName: s.onboarding.bank.holderName } : null, bankNote: s.onboarding.bankNote ?? null,
    wallet: s.onboarding.wallet ? { address: s.onboarding.wallet.address, verifiedAt: s.onboarding.wallet.verifiedAt } : null,
    reviewNote: s.onboarding.status === "rejected" ? s.onboarding.reviewNote ?? null : null,
    stripeReady: !!config.STRIPE_SECRET_KEY && /^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY), messageTemplate: walletMessage(s, "0x0000000000000000000000000000000000000000") };
}
export const Kyb = z.object({
  legalName: z.string().min(2).max(120),
  taxIdType: z.enum(["ein", "vat"]), taxId: z.string().min(4).max(20),
  address: z.object({ line1: z.string().min(2), city: z.string().min(1), postalCode: z.string().min(2), country: z.string().length(2) }),
  ubos: z.array(z.object({ name: z.string().min(2), ownershipPct: z.number().min(25).max(100), country: z.string().length(2) })).min(1).max(4),
}).superRefine((k, ctx) => {
  if (k.taxIdType === "ein" && !/^\d{2}-?\d{7}$/.test(k.taxId)) ctx.addIssue({ code: "custom", path: ["taxId"], message: "EIN must look like 12-3456789" });
  if (k.taxIdType === "vat" && !/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(k.taxId.replace(/\s/g, "").toUpperCase())) ctx.addIssue({ code: "custom", path: ["taxId"], message: "VAT number must start with a two letter country code, like GB123456789" });
  if (k.ubos.reduce((a, u) => a + u.ownershipPct, 0) > 100) ctx.addIssue({ code: "custom", path: ["ubos"], message: "Ownership adds up to more than 100 percent" });
});
export function saveKyb(token: string, input: unknown) {
  const s = byToken(token); editable(s); const k = Kyb.parse(input);
  s.onboarding.kyb = { ...k, taxId: k.taxIdType === "vat" ? k.taxId.replace(/\s/g, "").toUpperCase() : k.taxId };
  ev("supplier", s.id, "onboarding.kyb_saved", { legalName: k.legalName, taxIdType: k.taxIdType, ubos: k.ubos.length }); save(); return onboardingView(token);
}

export type BankInput = { holderName: string; routingNumber: string; accountNumber: string };
/** Turns bank details into a Stripe test bank token. Tests swap this out, nothing else calls Stripe here. */
let tokenizer = async (b: BankInput) => {
  const t = await stripeClient("sandbox").tokens.create({ bank_account: { country: "US", currency: "usd", account_holder_name: b.holderName, account_holder_type: "company", routing_number: b.routingNumber, account_number: b.accountNumber } });
  return { tokenId: t.id, last4: t.bank_account?.last4 ?? b.accountNumber.slice(-4), bankName: t.bank_account?.bank_name ?? null };
};
export function setBankTokenizer(fn: typeof tokenizer) { tokenizer = fn; }
export const Bank = z.object({ holderName: z.string().min(2), routingNumber: z.string().regex(/^\d{9}$/, "Routing number has 9 digits"), accountNumber: z.string().regex(/^\d{4,17}$/, "Account number has 4 to 17 digits") });
async function tokenize(b: BankInput) {
  try { const t = await tokenizer(b); return { ...t, routingNumber: b.routingNumber, holderName: b.holderName }; }
  catch (e: any) { throw err(e.status === 503 || /not configured/.test(e.message) ? 503 : 422, `Stripe could not tokenize the bank account: ${e.message}`); }
}
export async function saveBank(token: string, input: unknown) {
  const s = byToken(token); editable(s); const b = Bank.parse(input);
  s.onboarding.bank = await tokenize(b); s.onboarding.bankNote = undefined;
  ev("supplier", s.id, "onboarding.bank_tokenized", { tokenId: s.onboarding.bank.tokenId, last4: s.onboarding.bank.last4 }); save(); return onboardingView(token);
}
export async function proveWallet(s: Supplier, address: string, signature: string) {
  if (!isAddress(address)) throw err(422, "That is not a valid wallet address");
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw err(422, "Signature must be a 0x hex string");
  const message = walletMessage(s, address);
  let ok = false; try { ok = await verifyMessage({ address: getAddress(address), message, signature: signature as `0x${string}` }); } catch { ok = false; }
  if (!ok) throw err(422, "The signature does not match this wallet and message");
  return { address: getAddress(address), message, signature, verifiedAt: now() };
}
export async function saveWallet(token: string, input: { address: string; signature: string }) {
  const s = byToken(token); editable(s);
  s.onboarding.wallet = await proveWallet(s, String(input.address ?? ""), String(input.signature ?? ""));
  ev("supplier", s.id, "onboarding.wallet_proven", { address: s.onboarding.wallet.address }); save(); return onboardingView(token);
}
/** Name screening on submit. The compliance module fills this in. */
let supplierScreen: (name: string, wallet: string | null) => { hits: any[] } = () => ({ hits: [] });
export function setSupplierScreen(fn: typeof supplierScreen) { supplierScreen = fn; }
export function submitOnboarding(token: string) {
  const s = byToken(token); editable(s);
  if (!s.onboarding.kyb) throw err(422, "Fill in the company details first");
  if (!s.onboarding.bank && !s.onboarding.wallet) throw err(422, "Add a bank account or prove a wallet so you can be paid");
  s.onboarding.screening = { at: now(), ...supplierScreen(s.onboarding.kyb.legalName, s.onboarding.wallet?.address ?? null) };
  s.onboarding.status = "submitted"; s.onboarding.submittedAt = now();
  ev("supplier", s.id, "onboarding.submitted", { screeningHits: s.onboarding.screening.hits.length }); save(); return onboardingView(token);
}
export function reviewSupplier(user: P.User, tenantId: string, supplierId: string, verify: boolean, note = "") {
  const s = inTenant(db.suppliers.find((x) => x.id === supplierId), tenantId, "supplier");
  const o = s.onboarding; if (!o || o.status !== "submitted") throw err(409, `Supplier onboarding is ${o?.status ?? "not active"}`);
  if (o.invitedBy === user.id && user.role !== "client_admin") throw err(403, "The inviter cannot review this supplier");
  if (verify && o.screening?.hits?.length) throw err(409, "Sanctions screening has hits. Clear the compliance case before verifying.");
  o.status = verify ? "verified" : "rejected"; o.reviewedBy = user.id; o.reviewNote = note.slice(0, 500); o.reviewedAt = now();
  if (verify) {
    const org = db.orgs.find((x) => x.id === s.orgId)!; org.kybStatus = "verified"; org.legalName = o.kyb.legalName; org.country = o.kyb.address.country.toUpperCase(); s.name = o.kyb.legalName;
    s.bankDetailsRef = o.bank?.tokenId ?? ""; s.walletAddress = o.wallet?.address ?? null;
    s.acceptedRails = [...(o.bank ? ["stripe_ach", "stripe_card"] : []), ...(o.wallet ? ["circle_usdc", "onchain_usdc"] : [])] as Supplier["acceptedRails"];
    s.preferredRail = o.wallet ? "onchain_usdc" : "stripe_ach";
    for (const m of db.mandates.filter((x) => tenantOf(x) === tenantId)) if (!m.allowedSuppliers.includes(s.id)) { m.allowedSuppliers.push(s.id); S.signMandate(m); }
    publish(tenantId, "supplier.verified", { id: s.id, name: s.name });
  }
  ev("supplier", s.id, verify ? "onboarding.verified" : "onboarding.rejected", { actor: user.id, note });
  save(); return s;
}
export function suppliersView(tenantId: string) {
  return db.suppliers.filter((s) => tenantOf(s) === tenantId).map((s) => {
    const o = s.onboarding;
    return { ...s, status: o?.status ?? "verified", onboarding: o ? { ...o, token: undefined, bank: o.bank ? { last4: o.bank.last4, bankName: o.bank.bankName, holderName: o.bank.holderName, tokenId: o.bank.tokenId } : null, wallet: o.wallet ? { address: o.wallet.address, verifiedAt: o.wallet.verifiedAt } : null } : null,
      pendingChanges: P.listChanges("pending", tenantId).filter((c) => c.kind === "supplier.payee" && c.payload.supplierId === s.id) };
  });
}

/** Bank and wallet changes on a verified supplier: the maker requests, an approver checks. */
P.registerChangeKind("supplier.payee", {
  role: "approver",
  validate: (p) => {
    const s = db.suppliers.find((x) => x.id === p.supplierId); if (!s) throw new P.AuthError(404, "supplier not found");
    if (s.onboarding && s.onboarding.status !== "verified") throw new P.AuthError(409, "Supplier is not verified yet");
    if (p.field === "bank" && !p.bank?.tokenId) throw new P.AuthError(422, "Bank change needs a tokenized account");
    if (p.field === "wallet" && !p.wallet?.signature) throw new P.AuthError(422, "Wallet change needs a signed ownership proof");
    if (!["bank", "wallet"].includes(p.field)) throw new P.AuthError(422, "field must be bank or wallet");
  },
  apply: (p) => {
    const s = db.suppliers.find((x) => x.id === p.supplierId)!;
    if (p.field === "bank") { s.bankDetailsRef = p.bank.tokenId; s.acceptedRails = [...new Set([...s.acceptedRails, "stripe_ach", "stripe_card"])] as Supplier["acceptedRails"]; if (s.onboarding) s.onboarding.bank = p.bank; }
    else { s.walletAddress = p.wallet.address; s.acceptedRails = [...new Set([...s.acceptedRails, "circle_usdc", "onchain_usdc"])] as Supplier["acceptedRails"]; if (s.onboarding) s.onboarding.wallet = p.wallet; }
    ev("supplier", s.id, "payee.changed", { field: p.field, value: p.field === "bank" ? `bank ending ${p.bank.last4}` : p.wallet.address }); save(); return s;
  },
});
export async function requestPayeeChange(user: P.User, tenantId: string, supplierId: string, input: any) {
  const s = inTenant(db.suppliers.find((x) => x.id === supplierId), tenantId, "supplier");
  if (input.field === "bank") { const b = Bank.parse(input.bank); return P.requestChange(user, "supplier.payee", { supplierId: s.id, field: "bank", bank: await tokenize(b) }, tenantId); }
  if (input.field === "wallet") return P.requestChange(user, "supplier.payee", { supplierId: s.id, field: "wallet", wallet: await proveWallet(s, String(input.address ?? ""), String(input.signature ?? "")) }, tenantId);
  throw err(422, "field must be bank or wallet");
}
export const walletMessageFor = (tenantId: string, supplierId: string, address: string) => {
  const s = inTenant(db.suppliers.find((x) => x.id === supplierId), tenantId, "supplier");
  if (!isAddress(address)) throw err(422, "That is not a valid wallet address"); return { message: walletMessage(s, address) };
};
export const onboardingMessage = (token: string, address: string) => { const s = byToken(token); if (!isAddress(address)) throw err(422, "That is not a valid wallet address"); return { message: walletMessage(s, address) }; };
