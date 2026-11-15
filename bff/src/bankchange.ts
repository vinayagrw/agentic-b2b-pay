/**
 * Supplier bank-detail change check. Any change to where a supplier gets paid becomes a pending request first.
 * The old and new values are sealed. Only the last 4 characters leave this module, in the API, the UI and the evidence log.
 * A second person must approve with a fresh authenticator code, after a recorded call-back to the phone number on the supplier record.
 * While a request waits, and for a cooling-off time after approval, payments to that supplier are held with a clear reason.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { sql } from "./db.js";
import { config } from "./config.js";
import { db, save, tenantOf } from "./modules/store.js";
import type { Supplier } from "./modules/store.js";
import * as P from "./platform.js";
import * as I from "./iam.js";
import * as SU from "./stepup.js";

export class BankChangeError extends P.AuthError {}
export type Kind = "bank" | "wallet";
export type Signal = { code: "different_country" | "different_bank" | "large_payment_soon" | "requester_can_approve" | "duplicate_account" | "new_wallet" | "channel"; label: string; detail: string; tone: "bad" | "warn" | "neutral" };
export type Masked = { kind: Kind; holderName: string | null; bankName: string | null; country: string | null; accountType: "IBAN" | "Account" | "Wallet" | "On file"; last4: string | null };
export type Callback = { by: string; at: string; phone: string; outcome: "confirmed" | "denied" | "no_answer"; spokeTo: string; note: string };
type Full = { kind: Kind; holderName?: string; bankName?: string; country?: string; iban?: string; routingNumber?: string; accountNumber?: string; address?: string; ref?: string };
type Row = { id: string; tenant_id: string; supplier_id: string; kind: Kind; status: "pending" | "approved" | "rejected"; old_enc: string | null; new_enc: string; old_masked: string; new_masked: string; account_hash: string; signals: string; channel: string; channel_note: string; requested_by: string; callback: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null; hold_until: string | null; created_at: string };

const DAY = 864e5;
const now = () => new Date().toISOString();
const CHANNEL_TEXT: Record<string, string> = { email: "Asked by email", portal: "Asked in the supplier portal", phone: "Asked by phone", other: "Asked another way" };
/** Rough USD rates, only to judge if an open invoice is large. Payments use the FX module. */
const USD_RATE: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27 };
const last4 = (s: string) => s.slice(-4);
const nameOf = (id: string | null) => (id ? P.getUser(id)?.name ?? id : null);
/** Long digit runs in free text are hidden, so a pasted account number cannot leak through the note. */
const scrub = (s: string) => s.replace(/[A-Z]{2}\d{2}[A-Z0-9 ]{10,34}|\d[\d -]{5,}\d|0x[0-9a-fA-F]{12,}/g, "[number hidden]");

const hashKey = () => crypto.createHash("sha256").update(`${config.SESSION_SECRET}:bank-change-hash`).digest();
const norm = (f: Full) => (f.kind === "wallet" ? `wallet:${(f.address ?? "").toLowerCase()}` : f.iban ? `iban:${f.iban}` : f.accountNumber ? `acct:${f.routingNumber}:${f.accountNumber}` : `ref:${f.ref ?? ""}`);
/** Keyed hash of the account. Lets us spot the same account on two suppliers without storing the number in clear. */
export const accountHash = (f: Full) => crypto.createHmac("sha256", hashKey()).update(norm(f)).digest("hex");
const mask = (f: Full): Masked => f.kind === "wallet"
  ? { kind: "wallet", holderName: null, bankName: null, country: null, accountType: "Wallet", last4: f.address ? last4(f.address) : null }
  : { kind: "bank", holderName: f.holderName ?? null, bankName: f.bankName ?? null, country: f.country ?? null, accountType: f.iban ? "IBAN" : f.accountNumber ? "Account" : "On file", last4: f.iban ? last4(f.iban) : f.accountNumber ? last4(f.accountNumber) : null };

// Input

const BankInput = z.object({ holderName: z.string().trim().min(2).max(80), bankName: z.string().trim().min(2).max(80), country: z.string().trim().length(2), iban: z.string().optional(), routingNumber: z.string().optional(), accountNumber: z.string().optional() });
export const RequestInput = z.object({ kind: z.enum(["bank", "wallet"]).default("bank"), bank: BankInput.optional(), wallet: z.object({ address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Enter a 0x wallet address") }).optional(),
  channel: z.enum(["email", "portal", "phone", "other"]), channelNote: z.string().trim().max(500).default("") });
function fullOf(x: z.infer<typeof RequestInput>): Full {
  if (x.kind === "wallet") { if (!x.wallet) throw new BankChangeError(422, "Enter the new wallet address"); return { kind: "wallet", address: x.wallet.address }; }
  const b = x.bank; if (!b) throw new BankChangeError(422, "Enter the new bank details");
  const iban = (b.iban ?? "").replace(/\s/g, "").toUpperCase(); const routing = (b.routingNumber ?? "").replace(/\D/g, ""); const account = (b.accountNumber ?? "").replace(/\D/g, "");
  const base = { kind: "bank" as const, holderName: b.holderName, bankName: b.bankName, country: b.country.toUpperCase() };
  if (iban) { if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new BankChangeError(422, "That IBAN does not look right"); return { ...base, iban }; }
  if (!/^\d{6,9}$/.test(routing) || !/^\d{4,17}$/.test(account)) throw new BankChangeError(422, "Enter an IBAN, or a routing number and an account number");
  return { ...base, routingNumber: routing, accountNumber: account };
}

// Rows and views. Nothing sealed and no hash ever leaves through view().

const getRow = (tenantId: string | null, id: string): Row => {
  const r = sql.prepare("SELECT * FROM bank_change_requests WHERE id = ?").get(id) as Row | undefined;
  if (!r || (tenantId && r.tenant_id !== tenantId)) throw new BankChangeError(404, "bank change request not found");
  return r;
};
const supplierIn = (tenantId: string, id: string): Supplier => {
  const s = db.suppliers.find((x) => x.id === id && tenantOf(x) === tenantId); if (!s) throw new BankChangeError(404, "supplier not found"); return s;
};
export function view(r: Row) {
  const sup = db.suppliers.find((s) => s.id === r.supplier_id); const cb = r.callback ? (JSON.parse(r.callback) as Callback) : null;
  const cooling = r.status === "approved" && !!r.hold_until && Date.parse(r.hold_until) > Date.now();
  return { id: r.id, tenantId: r.tenant_id, supplierId: r.supplier_id, supplierName: sup?.name ?? r.supplier_id, kind: r.kind, status: r.status, old: JSON.parse(r.old_masked) as Masked, new: JSON.parse(r.new_masked) as Masked,
    signals: JSON.parse(r.signals) as Signal[], channel: r.channel, channelText: CHANNEL_TEXT[r.channel] ?? r.channel, channelNote: r.channel_note, requestedBy: r.requested_by, requestedByName: nameOf(r.requested_by), createdAt: r.created_at,
    callbackPhone: sup?.contactPhone ?? null, callback: cb ? { ...cb, byName: nameOf(cb.by) } : null, decidedBy: r.decided_by, decidedByName: nameOf(r.decided_by), decidedAt: r.decided_at, decisionNote: r.decision_note,
    holdUntil: r.hold_until, coolingOff: cooling, paymentsHeld: r.status === "pending" || cooling };
}
export type BankChangeView = ReturnType<typeof view>;
export function list(scope: string | null, f: { status?: string; supplierId?: string } = {}) {
  const rows = (sql.prepare(`SELECT * FROM bank_change_requests ${scope ? "WHERE tenant_id = ?" : ""} ORDER BY created_at DESC, rowid DESC`).all(...(scope ? [scope] : [])) as Row[]).map(view);
  return rows.filter((r) => (!f.status || f.status === "all" || r.status === f.status) && (!f.supplierId || r.supplierId === f.supplierId));
}
export const detail = (scope: string | null, id: string) => view(getRow(scope, id));

// Settings

export function settings(tenantId: string) {
  const r = sql.prepare("SELECT cooling_off_hours h FROM bank_change_settings WHERE tenant_id = ?").get(tenantId) as { h: number } | undefined;
  return { coolingOffHours: r?.h ?? 24 };
}
export function saveSettings(u: P.User, tenantId: string, raw: unknown) {
  I.requirePermission(u, "rules.edit", { tenantId });
  const x = z.object({ coolingOffHours: z.coerce.number().min(0).max(168) }).parse(raw);
  sql.prepare("INSERT INTO bank_change_settings (tenant_id, cooling_off_hours, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET cooling_off_hours=excluded.cooling_off_hours, updated_by=excluded.updated_by, updated_at=excluded.updated_at").run(tenantId, x.coolingOffHours, u.id, now());
  P.audit(u.id, "tenant", tenantId, "bank_change.settings_changed", { coolingOffHours: x.coolingOffHours });
  return settings(tenantId);
}

// Current payout details and risk signals

type Payout = { enc: string; masked: Masked; hash: string };
function current(sup: Supplier, kind: Kind): Payout | null {
  const r = sql.prepare("SELECT enc, masked, account_hash FROM supplier_payout_details WHERE supplier_id = ? AND kind = ?").get(sup.id, kind) as any;
  if (r) return { enc: r.enc, masked: JSON.parse(r.masked), hash: r.account_hash };
  if (kind === "wallet") { if (!sup.walletAddress) return null; const f: Full = { kind: "wallet", address: sup.walletAddress }; return { enc: I.seal(JSON.stringify(f)), masked: mask(f), hash: accountHash(f) }; }
  const ob = sup.onboarding?.bank; const country = db.orgs.find((o) => o.id === sup.orgId)?.country ?? null;
  const f: Full = { kind: "bank", ref: sup.bankDetailsRef };
  return { enc: I.seal(JSON.stringify(f)), masked: { kind: "bank", holderName: ob?.holderName ?? sup.name, bankName: ob?.bankName ?? null, country, accountType: "On file", last4: ob?.last4 ?? null }, hash: accountHash(f) };
}
function putPayout(sup: Supplier, f: Full) {
  sql.prepare("INSERT OR REPLACE INTO supplier_payout_details (supplier_id, kind, tenant_id, enc, masked, account_hash, updated_at) VALUES (?,?,?,?,?,?,?)").run(sup.id, f.kind, tenantOf(sup), I.seal(JSON.stringify(f)), JSON.stringify(mask(f)), accountHash(f), now());
}
/** Other suppliers that already use this account, in any tenant. Only the tenant id and supplier id come back, for wording inside this module. */
function sameAccount(hash: string, f: Full, supplierId: string) {
  const hits = new Map<string, string>();
  for (const r of sql.prepare("SELECT supplier_id, tenant_id FROM supplier_payout_details WHERE account_hash = ? AND supplier_id != ?").all(hash, supplierId) as any[]) hits.set(r.supplier_id, r.tenant_id);
  for (const r of sql.prepare("SELECT supplier_id, tenant_id FROM bank_change_requests WHERE account_hash = ? AND supplier_id != ? AND status != 'rejected'").all(hash, supplierId) as any[]) hits.set(r.supplier_id, r.tenant_id);
  if (f.kind === "wallet") for (const s of db.suppliers) if (s.id !== supplierId && s.walletAddress && s.walletAddress.toLowerCase() === f.address!.toLowerCase()) hits.set(s.id, tenantOf(s));
  return [...hits].map(([supplierId, tenantId]) => ({ supplierId, tenantId }));
}
function signalsFor(u: P.User, tenantId: string, sup: Supplier, f: Full, old: Payout | null, channel: string, at = Date.now()): Signal[] {
  const out: Signal[] = []; const m = mask(f);
  if (f.kind === "bank") {
    if (old?.masked.country && m.country && old.masked.country !== m.country) out.push({ code: "different_country", label: "Different country", detail: `The account moves from ${old.masked.country} to ${m.country}`, tone: "bad" });
    if (old?.masked.bankName && m.bankName && old.masked.bankName.trim().toLowerCase() !== m.bankName.trim().toLowerCase()) out.push({ code: "different_bank", label: "Different bank", detail: `The bank changes from ${old.masked.bankName} to ${m.bankName}`, tone: "warn" });
  }
  const big = db.invoices.filter((i) => i.supplierId === sup.id && !i.paid && i.amount * (USD_RATE[i.currency ?? "USD"] ?? 1) >= SU.thresholdUsd() && (!(i as any).dueDate || Date.parse((i as any).dueDate) - at <= 7 * DAY));
  if (big.length) out.push({ code: "large_payment_soon", label: "Large payment soon", detail: `${big.length} large unpaid invoice${big.length === 1 ? " is" : "s are"} due in the next 7 days`, tone: "bad" });
  if (I.explain(u, "payments.approve", { tenantId }).allowed) out.push({ code: "requester_can_approve", label: "Requester can approve payments", detail: `${u.name} asked for this change and can also approve payments. Another person must check it.`, tone: "warn" });
  const dup = sameAccount(accountHash(f), f, sup.id);
  if (dup.length) {
    const here = dup.filter((d) => d.tenantId === tenantId).map((d) => db.suppliers.find((s) => s.id === d.supplierId)?.name ?? d.supplierId);
    out.push({ code: "duplicate_account", label: "Account used by another supplier", detail: here.length ? `The same account is on ${here.join(", ")}` : "The same account is on another supplier on the platform", tone: "bad" });
  }
  if (f.kind === "wallet" && !dup.length) out.push({ code: "new_wallet", label: "Wallet never used before", detail: "No supplier on the platform has been paid to this wallet before", tone: "warn" });
  out.push({ code: "channel", label: CHANNEL_TEXT[channel] ?? channel, detail: channel === "portal" ? "The supplier asked in the portal" : "Requests by email or phone are a common fraud route. Call back on the number on file.", tone: channel === "portal" ? "neutral" : "warn" });
  return out;
}

// Request, call-back and decision

/** The maker asks for a change. Nothing is applied here. */
export function request(u: P.User, tenantId: string, supplierId: string, raw: unknown) {
  I.requirePermission(u, "suppliers.payee_change", { tenantId });
  const sup = supplierIn(tenantId, supplierId); const x = RequestInput.parse(raw); const f = fullOf(x);
  if (sql.prepare("SELECT 1 FROM bank_change_requests WHERE supplier_id = ? AND kind = ? AND status = 'pending'").get(sup.id, f.kind)) throw new BankChangeError(409, "A change for this supplier is already waiting for a check");
  const old = current(sup, f.kind); const hash = accountHash(f);
  if (old && old.hash === hash) throw new BankChangeError(422, "These are the details already on file");
  const signals = signalsFor(u, tenantId, sup, f, old, x.channel); const m = mask(f);
  const id = `bcr-${crypto.randomUUID().slice(0, 10)}`;
  const emptyOld: Masked = { kind: f.kind, holderName: null, bankName: null, country: null, accountType: f.kind === "wallet" ? "Wallet" : "On file", last4: null };
  sql.prepare("INSERT INTO bank_change_requests (id, tenant_id, supplier_id, kind, status, old_enc, new_enc, old_masked, new_masked, account_hash, signals, channel, channel_note, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, tenantId, sup.id, f.kind, "pending", old?.enc ?? null, I.seal(JSON.stringify(f)), JSON.stringify(old?.masked ?? emptyOld), JSON.stringify(m), hash, JSON.stringify(signals), x.channel, scrub(x.channelNote), u.id, now());
  P.audit(u.id, "supplier", sup.id, "bank_change.requested", { request: id, kind: f.kind, newLast4: m.last4, newCountry: m.country, newBank: m.bankName, channel: x.channel, signals: signals.map((s) => s.code) });
  return detail(tenantId, id);
}

const checker = (u: P.User, r: Row, what: string) => {
  if (r.status !== "pending") throw new BankChangeError(409, `This request is already ${r.status}`);
  if (r.requested_by === u.id) throw new BankChangeError(403, `The person who asked for the change cannot ${what}`);
  I.requirePermission(u, "payments.approve", { tenantId: r.tenant_id });
};
/** Records the call-back. The phone number always comes from the supplier record, never from the request. */
export function recordCallback(u: P.User, tenantId: string, id: string, raw: unknown) {
  const r = getRow(tenantId, id); checker(u, r, "record the call-back");
  const x = z.object({ outcome: z.enum(["confirmed", "denied", "no_answer"]), spokeTo: z.string().trim().max(80).default(""), note: z.string().trim().max(500).default("") }).parse(raw);
  const sup = supplierIn(tenantId, r.supplier_id);
  if (!sup.contactPhone) throw new BankChangeError(409, "There is no phone number on the supplier record. Add one before the call-back.");
  if (x.outcome === "confirmed" && x.spokeTo.length < 2) throw new BankChangeError(422, "Enter the name of the person you spoke to");
  const cb: Callback = { by: u.id, at: now(), phone: sup.contactPhone, outcome: x.outcome, spokeTo: x.spokeTo, note: scrub(x.note) };
  sql.prepare("UPDATE bank_change_requests SET callback = ? WHERE id = ?").run(JSON.stringify(cb), r.id);
  P.audit(u.id, "supplier", sup.id, "bank_change.callback", { request: r.id, outcome: cb.outcome, spokeTo: cb.spokeTo, phoneLast4: last4(cb.phone) });
  return detail(tenantId, id);
}
/** The checker decides. Approve needs a second person, a fresh authenticator code and a confirmed call-back. Reject needs neither. */
export function decide(u: P.User, tenantId: string, sessionId: string | null, id: string, raw: unknown) {
  const r = getRow(tenantId, id); checker(u, r, "approve or reject it");
  const x = z.object({ approve: z.boolean(), note: z.string().trim().max(500).default("") }).parse(raw);
  const sup = supplierIn(tenantId, r.supplier_id); const at = now();
  if (!x.approve) {
    sql.prepare("UPDATE bank_change_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(u.id, at, scrub(x.note), r.id);
    P.audit(u.id, "supplier", sup.id, "bank_change.rejected", { request: r.id, note: scrub(x.note) });
    return detail(tenantId, id);
  }
  if (!SU.status(u.id, sessionId).fresh) throw new BankChangeError(403, "step_up_required: approving a bank detail change needs a fresh authenticator code");
  const cb = r.callback ? (JSON.parse(r.callback) as Callback) : null;
  if (cb?.outcome !== "confirmed") throw new BankChangeError(409, "Record a confirmed call-back to the phone number on the supplier record first");
  const f = JSON.parse(I.unseal(r.new_enc)) as Full; const m = mask(f);
  if (f.kind === "wallet") sup.walletAddress = f.address!;
  else {
    sup.bankDetailsRef = `bank-chg-${r.id}`;
    if (sup.onboarding?.bank) sup.onboarding.bank = { tokenId: sup.bankDetailsRef, last4: m.last4 ?? "", bankName: m.bankName, routingNumber: "", holderName: m.holderName ?? sup.name };
  }
  putPayout(sup, f);
  const hours = settings(tenantId).coolingOffHours; const holdUntil = new Date(Date.parse(at) + hours * 3_600_000).toISOString();
  sql.prepare("UPDATE bank_change_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, hold_until = ? WHERE id = ?").run(u.id, at, scrub(x.note), holdUntil, r.id);
  P.audit(u.id, "supplier", sup.id, "bank_change.approved", { request: r.id, requestedBy: r.requested_by, callbackBy: cb.by, coolingOffHours: hours, holdUntil });
  P.audit(u.id, "supplier", sup.id, "payee.changed", { request: r.id, kind: f.kind, last4: m.last4, country: m.country, bank: m.bankName });
  save();
  return detail(tenantId, id);
}

/** The reason payments to this supplier are held right now, or null. Used by the pay flow. */
export function paymentHold(tenantId: string, supplierId: string, at = Date.now()): string | null {
  const name = db.suppliers.find((s) => s.id === supplierId)?.name ?? supplierId;
  const rows = sql.prepare("SELECT status, hold_until FROM bank_change_requests WHERE tenant_id = ? AND supplier_id = ? AND status IN ('pending','approved')").all(tenantId, supplierId) as { status: string; hold_until: string | null }[];
  if (rows.some((r) => r.status === "pending")) return `Payment held. A bank detail change for ${name} is waiting for a second person to check it.`;
  const until = rows.filter((r) => r.hold_until && Date.parse(r.hold_until) > at).map((r) => r.hold_until!).sort().at(-1);
  return until ? `Payment held. ${name} changed its payout details and the cooling-off time runs until ${until.slice(0, 16).replace("T", " ")} UTC.` : null;
}

// Demo data

const SEED_PHONES: Record<string, string> = { "sup-northwind": "+1 312 555 0141", "sup-contoso": "+44 20 7946 0152", "sup-fabrikam": "+52 55 5550 0163", "sup-vandijk": "+31 20 555 0174", "sup-initech": "+1 512 555 0185", "sup-hooli": "+44 161 555 0196" };
/** Seeds one pending demo request on Contoso. It is never approved here. Skipped in tests unless forced. */
export function seedDemo(force = false) {
  let touched = false;
  for (const s of db.suppliers) if (!s.contactPhone && SEED_PHONES[s.id]) { s.contactPhone = SEED_PHONES[s.id]; touched = true; }
  if (touched) save();
  if (process.env.VITEST && !force) return null;
  if ((sql.prepare("SELECT COUNT(*) n FROM bank_change_requests").get() as { n: number }).n) return null;
  const sup = db.suppliers.find((s) => s.id === "sup-contoso"); const jane = P.getUser("usr-cfo-jane");
  if (!sup || !jane) return null;
  // Published example IBANs, not real accounts.
  putPayout(sup, { kind: "bank", holderName: "Contoso Logistics Ltd", bankName: "NatWest", country: "GB", iban: "GB29NWBK60161331926819" });
  return request(jane, tenantOf(sup), sup.id, { kind: "bank", bank: { holderName: "Contoso Logistics Ltd", bankName: "Commerzbank", country: "DE", iban: "DE89370400440532013000" }, channel: "email",
    channelNote: "Email from accounts@contoso-logistics.example saying they moved banks. Asks us to use the new account for the next payment." });
}
