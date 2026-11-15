/**
 * Simulated credit line. There is no real lender and no money moves. It shows how a bank could offer working capital inside the payment flow.
 * The bank operator sets one line per business client: a limit and a yearly rate. The operator also sets an exposure cap for the bank,
 * which is the most that all its clients may owe at one time.
 * A draw is asked for by one person and approved by another (maker-checker). Over the step-up threshold the approver needs a fresh authenticator code.
 * An approved draw books cash in and a credit line liability in the entity ledger. A repayment books the principal back plus simple interest.
 */
import { z } from "zod";
import { sql } from "./db.js";
import { db, save, nextId, tenantOf } from "./modules/store.js";
import { makeJournal } from "./modules/ledger.js";
import * as FX from "./modules/fx.js";
import * as P from "./platform.js";
import * as I from "./iam.js";
import * as SU from "./stepup.js";
import { toUsd } from "./cards.js";

export const LENDER_LABEL = "Simulated lender";
export const LENDER_NOTE = "Simulated lender. No real loan is made and no real money moves. Limits, rates and interest are demo figures.";
export const CASH = "1000 Cash operating";
export const LIABILITY = "2500 Credit line payable";
export const INTEREST = "6200 Interest expense";
export const DEFAULT_CAP = 250_000;

export type LineStatus = "active" | "frozen";
export type DrawStatus = "pending_approval" | "funded" | "repaid" | "rejected";
export type Line = { tenantId: string; bankId: string; limit: number; aprPct: number; currency: string; status: LineStatus; setBy: string; createdAt: string; updatedAt: string };
export type Draw = { id: string; tenantId: string; entityId: string; amount: number; currency: string; aprPct: number; purpose: string; status: DrawStatus; outstanding: number; interestPaid: number; requestedBy: string; decidedBy: string | null; journalId: string | null; createdAt: string; decidedAt: string | null; fundedAt: string | null };
export class CreditError extends P.AuthError {}

const r2 = (x: number) => Math.round(x * 100) / 100;
const now = () => new Date().toISOString();
const userName = (id: string | null) => (id ? P.getUser(id)?.name ?? id : null);
const toLine = (r: any): Line => ({ tenantId: r.tenant_id, bankId: r.bank_id, limit: r.limit_amount, aprPct: r.apr_pct, currency: r.currency, status: r.status, setBy: r.set_by, createdAt: r.created_at, updatedAt: r.updated_at });
const toDraw = (r: any): Draw => ({ id: r.id, tenantId: r.tenant_id, entityId: r.entity_id, amount: r.amount, currency: r.currency, aprPct: r.apr_pct, purpose: r.purpose, status: r.status, outstanding: r.outstanding, interestPaid: r.interest_paid, requestedBy: r.requested_by, decidedBy: r.decided_by, journalId: r.journal_id, createdAt: r.created_at, decidedAt: r.decided_at, fundedAt: r.funded_at });

export const getLine = (tenantId: string): Line | null => { const r = sql.prepare("SELECT * FROM credit_lines WHERE tenant_id = ?").get(tenantId); return r ? toLine(r) : null; };
export const drawsFor = (tenantId: string): Draw[] => (sql.prepare("SELECT * FROM credit_draws WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC").all(tenantId) as any[]).map(toDraw);
/** A draw of this tenant. Another tenant's draw id is not found. */
export function getDraw(tenantId: string, id: string): Draw {
  const r = sql.prepare("SELECT * FROM credit_draws WHERE id = ? AND tenant_id = ?").get(id, tenantId); if (!r) throw new CreditError(404, "draw not found"); return toDraw(r);
}
const putDraw = (d: Draw) => sql.prepare(`INSERT OR REPLACE INTO credit_draws (id, tenant_id, entity_id, amount, currency, apr_pct, purpose, status, outstanding, interest_paid, requested_by, decided_by, journal_id, created_at, decided_at, funded_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, d.tenantId, d.entityId, d.amount, d.currency, d.aprPct, d.purpose, d.status, d.outstanding, d.interestPaid, d.requestedBy, d.decidedBy, d.journalId, d.createdAt, d.decidedAt, d.fundedAt);
export const repaymentsFor = (tenantId: string) => sql.prepare("SELECT id, draw_id drawId, principal, interest, days, journal_id journalId, paid_by paidBy, created_at createdAt FROM credit_repayments WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC").all(tenantId) as { id: string; drawId: string; principal: number; interest: number; days: number; journalId: string; paidBy: string; createdAt: string }[];

/** What the tenant owes, what waits for approval and what is left to draw. */
export function usage(tenantId: string) {
  const ds = drawsFor(tenantId); const line = getLine(tenantId);
  const outstanding = r2(ds.filter((d) => d.status === "funded").reduce((a, d) => a + d.outstanding, 0));
  const pending = r2(ds.filter((d) => d.status === "pending_approval").reduce((a, d) => a + d.amount, 0));
  const limit = line?.limit ?? 0; const available = Math.max(0, r2(limit - outstanding - pending));
  return { limit, outstanding, pending, available, usedPct: limit > 0 ? Math.min(100, Math.round(((outstanding + pending) / limit) * 100)) : 0 };
}
const bankOf = (tenantId: string) => { const t = P.getTenant(tenantId); if (!t || t.kind !== "client" || !t.parentId) throw new CreditError(404, "business client not found"); return t.parentId; };
export const capFor = (bankId: string) => (sql.prepare("SELECT cap_amount FROM credit_caps WHERE bank_id = ?").get(bankId) as any)?.cap_amount ?? DEFAULT_CAP;
/** All that the clients of one bank owe, in USD, against the bank's exposure cap. Pending draws are shown apart. */
export function exposure(bankId: string) {
  const lines = (sql.prepare("SELECT * FROM credit_lines WHERE bank_id = ?").all(bankId) as any[]).map(toLine);
  let outstanding = 0, pending = 0, committed = 0;
  for (const l of lines) { const u = usage(l.tenantId); outstanding += toUsd(u.outstanding, l.currency); pending += toUsd(u.pending, l.currency); committed += toUsd(l.limit, l.currency); }
  const cap = capFor(bankId);
  return { bankId, cap, outstanding: r2(outstanding), pending: r2(pending), committed: r2(committed), headroom: Math.max(0, r2(cap - outstanding)), lines: lines.length };
}

// Bank operator side

export const LineInput = z.object({ limit: z.coerce.number().min(0, "The limit cannot be below zero").max(10_000_000), aprPct: z.coerce.number().min(0, "The rate cannot be below zero").max(60, "The rate cannot be over 60 percent"), status: z.enum(["active", "frozen"]).default("active") });
/** Sets or changes a client's line. Only a bank operator with treasury.sweep can do this. The line is in the currency of the client's main entity. */
export function setLine(u: P.User, tenantId: string, raw: unknown): Line {
  if (!P.isOperator(u)) throw new CreditError(403, "Only the bank operator can set a credit line");
  I.requirePermission(u, "treasury.sweep");
  const bankId = bankOf(tenantId); const x = LineInput.parse(raw);
  const ent = FX.defaultEntity(tenantId); if (!ent) throw new CreditError(409, "This client has no legal entity to book the line in");
  const before = getLine(tenantId); const use = usage(tenantId);
  if (x.limit < use.outstanding) throw new CreditError(422, `The limit cannot be below the ${use.outstanding.toFixed(2)} ${before?.currency ?? ent.currency} already drawn`);
  const at = now();
  sql.prepare("INSERT INTO credit_lines (tenant_id, bank_id, limit_amount, apr_pct, currency, status, set_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET limit_amount = excluded.limit_amount, apr_pct = excluded.apr_pct, status = excluded.status, set_by = excluded.set_by, updated_at = excluded.updated_at")
    .run(tenantId, bankId, r2(x.limit), x.aprPct, before?.currency ?? ent.currency, x.status, u.id, at, at);
  P.audit(u.id, "credit_line", tenantId, "credit.line_set", { before: before ? { limit: before.limit, aprPct: before.aprPct, status: before.status } : null, after: { limit: r2(x.limit), aprPct: x.aprPct, status: x.status }, simulated: true });
  return getLine(tenantId)!;
}
/** Sets the bank's exposure cap in USD. */
export function setCap(u: P.User, bankId: string, raw: unknown) {
  if (!P.isOperator(u)) throw new CreditError(403, "Only the bank operator can set the exposure cap");
  I.requirePermission(u, "treasury.sweep");
  const b = P.getTenant(bankId); if (!b || b.kind !== "bank") throw new CreditError(404, "bank not found");
  const cap = z.coerce.number().min(0, "The cap cannot be below zero").max(1_000_000_000).parse(raw);
  const before = capFor(bankId);
  sql.prepare("INSERT INTO credit_caps (bank_id, cap_amount, set_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(bank_id) DO UPDATE SET cap_amount = excluded.cap_amount, set_by = excluded.set_by, updated_at = excluded.updated_at").run(bankId, r2(cap), u.id, now());
  P.audit(u.id, "credit_line", bankId, "credit.cap_set", { before, after: r2(cap), simulated: true });
  return exposure(bankId);
}
/** Operator view: every bank's exposure and every client line. */
export function opsView() {
  const tenants = P.listTenants();
  return { lender: LENDER_LABEL, note: LENDER_NOTE, stepUpThresholdUsd: SU.thresholdUsd(),
    banks: tenants.filter((t) => t.kind === "bank").map((b) => ({ name: b.name, ...exposure(b.id) })),
    clients: tenants.filter((t) => t.kind === "client").map((t) => { const l = getLine(t.id); return { tenantId: t.id, name: t.name, bankId: t.parentId, line: l, ...usage(t.id) }; }) };
}

// Client side

const viewDraw = (d: Draw) => ({ ...d, requestedByName: userName(d.requestedBy), decidedByName: userName(d.decidedBy), needsStepUp: SU.needsStepUp(toUsd(d.amount, d.currency)) });
/** The client page: line, usage, draws and repayments for one tenant only. */
export function view(tenantId: string) {
  const line = getLine(tenantId);
  return { lender: LENDER_LABEL, note: LENDER_NOTE, line, usage: usage(tenantId), draws: drawsFor(tenantId).map(viewDraw), repayments: repaymentsFor(tenantId), stepUpThresholdUsd: SU.thresholdUsd(), accounts: { cash: CASH, liability: LIABILITY, interest: INTEREST } };
}
/** Checks that an amount fits the client's limit and the bank's exposure cap. `own` is a pending draw that is already counted. */
function room(line: Line, amount: number, own = 0) {
  const u = usage(line.tenantId); const left = r2(line.limit - u.outstanding - u.pending + own);
  if (amount > left) throw new CreditError(422, `This draw is over the credit limit. ${Math.max(0, left).toFixed(2)} ${line.currency} is left on the line of ${line.limit.toFixed(2)} ${line.currency}`);
  const e = exposure(line.bankId);
  if (r2(e.outstanding + toUsd(amount, line.currency)) > e.cap) throw new CreditError(422, `This draw is over the bank exposure cap. The bank can lend ${e.headroom.toFixed(2)} USD more across all its clients`);
}
export const DrawInput = z.object({ amount: z.coerce.number().positive("The amount must be above zero"), purpose: z.string().trim().min(3, "Say what the draw is for").max(200) });
/** Maker-checker needs two people. A key made by the approver would count as a second party, so keys cannot act on a draw at all. */
const personOnly = (u: P.User, what: string) => { if (!P.isPerson(u)) throw new CreditError(403, `Only a signed-in person can ${what}. Agent keys and API keys cannot.`); };
/** Asks for a draw. Nothing is booked until a second person approves it. Agent keys and API keys cannot ask. */
export function requestDraw(u: P.User, tenantId: string, raw: unknown) {
  personOnly(u, "ask for a draw");
  I.requirePermission(u, "flow.operate", { tenantId });
  const line = getLine(tenantId); if (!line) throw new CreditError(409, "Your bank has not set up a credit line yet");
  if (line.status !== "active") throw new CreditError(409, "The credit line is frozen by the bank");
  const x = DrawInput.parse(raw); const amount = r2(x.amount);
  room(line, amount);
  const ent = FX.defaultEntity(tenantId); if (!ent) throw new CreditError(409, "No legal entity to book the draw in");
  const d: Draw = { id: nextId("draw"), tenantId, entityId: ent.id, amount, currency: line.currency, aprPct: line.aprPct, purpose: x.purpose, status: "pending_approval", outstanding: 0, interestPaid: 0, requestedBy: u.id, decidedBy: null, journalId: null, createdAt: now(), decidedAt: null, fundedAt: null };
  putDraw(d);
  P.audit(u.id, "credit_draw", d.id, "credit.draw_requested", { amount, currency: d.currency, aprPct: d.aprPct, purpose: d.purpose, simulated: true });
  return viewDraw(d);
}
const book = (tenantId: string, entityId: string, memo: string, ref: string, lines: Parameters<typeof makeJournal>[3], currency: string) => {
  const j = { ...makeJournal(nextId("jnl"), memo, ref, lines, currency), tenantId, entityId }; db.journals.push(j); return j;
};
/** Approves or rejects a draw. The maker cannot decide their own draw. Over the threshold the approver needs a fresh authenticator code. */
export function decideDraw(u: P.User, tenantId: string, sessionId: string | null, id: string, approve: boolean) {
  personOnly(u, "approve or reject a draw");
  const d = getDraw(tenantId, id);
  if (d.status !== "pending_approval") throw new CreditError(409, `This draw is already ${d.status.replace("_", " ")}`);
  if (d.requestedBy === u.id) throw new CreditError(403, "The person who asked for the draw cannot approve it");
  const usd = toUsd(d.amount, d.currency);
  I.requirePermission(u, "payments.approve", { amount: usd, tenantId });
  d.decidedBy = u.id; d.decidedAt = now();
  if (!approve) { d.status = "rejected"; putDraw(d); P.audit(u.id, "credit_draw", d.id, "credit.draw_rejected", { amount: d.amount, currency: d.currency }); return viewDraw(d); }
  SU.requireFresh(u, sessionId, usd);
  const line = getLine(tenantId); if (!line || line.status !== "active") throw new CreditError(409, "The credit line is frozen by the bank");
  room(line, d.amount, d.amount);
  sql.transaction(() => {
    const j = book(tenantId, d.entityId, `Credit line draw ${d.id} (simulated lender)`, d.id, [{ account: CASH, debit: d.amount }, { account: LIABILITY, credit: d.amount }], d.currency);
    Object.assign(d, { status: "funded" as DrawStatus, outstanding: d.amount, journalId: j.id, fundedAt: d.decidedAt }); putDraw(d);
  })();
  P.audit(u.id, "credit_draw", d.id, "credit.draw_funded", { amount: d.amount, currency: d.currency, aprPct: d.aprPct, journalId: d.journalId, requestedBy: d.requestedBy, steppedUp: SU.needsStepUp(usd), simulated: true });
  return viewDraw(d);
}
/** Simple interest on the principal being repaid, for the days since the draw was funded. At least one day. A demo figure. */
export function interestFor(principal: number, aprPct: number, fundedAt: string, at = Date.now()) {
  const days = Math.max(1, Math.ceil((at - Date.parse(fundedAt)) / 864e5));
  return { days, interest: r2(principal * (aprPct / 100) * (days / 365)) };
}
/** Repays part or all of a funded draw. Books principal and interest out of cash. It lowers what is owed, so one person can do it. Keys cannot. */
export function repay(u: P.User, tenantId: string, id: string, raw: unknown, at = Date.now()) {
  personOnly(u, "repay a draw");
  I.requirePermission(u, "payments.pay", { tenantId });
  const d = getDraw(tenantId, id);
  if (d.status !== "funded") throw new CreditError(409, d.status === "repaid" ? "This draw is already repaid" : "Only a funded draw can be repaid");
  const principal = r2(raw === undefined || raw === null || raw === "" ? d.outstanding : z.coerce.number().positive("The amount must be above zero").parse(raw));
  if (principal > d.outstanding) throw new CreditError(422, `You can repay at most ${d.outstanding.toFixed(2)} ${d.currency} on this draw`);
  const { days, interest } = interestFor(principal, d.aprPct, d.fundedAt ?? d.createdAt, at);
  const repId = nextId("rep"); let journalId = "";
  sql.transaction(() => {
    const lines = [{ account: LIABILITY, debit: principal }, ...(interest > 0 ? [{ account: INTEREST, debit: interest }] : []), { account: CASH, credit: r2(principal + interest) }];
    const j = book(tenantId, d.entityId, `Credit line repayment ${d.id} (simulated lender)`, d.id, lines, d.currency); journalId = j.id;
    d.outstanding = r2(d.outstanding - principal); d.interestPaid = r2(d.interestPaid + interest); if (d.outstanding <= 0) { d.outstanding = 0; d.status = "repaid"; }
    putDraw(d);
    sql.prepare("INSERT INTO credit_repayments (id, tenant_id, draw_id, principal, interest, days, journal_id, paid_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(repId, tenantId, d.id, principal, interest, days, j.id, u.id, new Date(at).toISOString());
  })();
  P.audit(u.id, "credit_draw", d.id, "credit.repaid", { principal, interest, days, outstanding: d.outstanding, journalId, simulated: true });
  return { draw: viewDraw(d), repayment: { id: repId, principal, interest, days, journalId } };
}
/** The balance of the credit line liability account in the tenant's ledger. It must equal what the draws say is owed. */
export function ledgerOwed(tenantId: string) {
  return r2(db.journals.filter((j) => tenantOf(j) === tenantId).flatMap((j) => j.entries).filter((e) => e.account === LIABILITY).reduce((a, e) => a + e.credit - e.debit, 0));
}
/** Demo seed: the first bank gives its first client a line so the page is not empty. Runs only when that client has no line. */
export function seedDemo() {
  const t = P.getTenant("tnt-acme"); if (!t?.parentId || getLine(t.id)) return null;
  const ent = FX.defaultEntity(t.id); if (!ent) return null;
  const at = now();
  sql.prepare("INSERT INTO credit_lines (tenant_id, bank_id, limit_amount, apr_pct, currency, status, set_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(t.id, t.parentId, 50_000, 9.5, ent.currency, "active", "seed", at, at);
  return getLine(t.id);
}
