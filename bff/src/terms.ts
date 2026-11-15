/** Payment terms and early-pay discounts. Terms sit on the supplier and are copied to each invoice.
 * Everything here is read-only except the "payment.early_pay" change, which a second client admin must approve.
 * Savings are demo figures: an approved plan is recorded on the invoice, and the payment still runs through the normal pay flow for the full invoice amount. */
import { PaymentTerms, earlyPayOf, hasDiscount, termsLabel } from "@b2b/shared";
import { db, save, scoped, tenantOf, isOpenInvoice, type Invoice } from "./modules/store.js";
import { appendEvidence } from "./modules/evidence.js";
import * as P from "./platform.js";

export const SAVINGS_NOTE = "Savings are demo figures. They come from the terms on the invoice, and the payment still runs for the full invoice amount.";
const r2 = (x: number) => Math.round(x * 100) / 100;
const day = () => new Date().toISOString().slice(0, 10);
const supName = (id: string) => db.suppliers.find((s) => s.id === id)?.name ?? id;
const inFlight = (id: string) => db.intents.some((p) => p.invoiceId === id && p.kind !== "refund" && ["created", "routed", "submitted", "pending", "settled"].includes(p.status));

export type DiscountRow = { invoiceId: string; number: string; supplierId: string; supplier: string; amount: number; currency: string; terms: string; dueDate: string; payBy: string; pct: number; discount: number; net: number; daysLeft: number; status: "open" | "approved" | "requested" | "missed"; match: string };
const requested = (tenantId: string | null) => new Set(P.listChanges("pending", tenantId).filter((c) => c.kind === "payment.early_pay").map((c) => String(c.payload?.invoiceId)));
/** Unpaid invoices whose terms carry an early-pay discount, soonest pay-by date first. */
export function discountRows(scope: string | null, today = day()): DiscountRow[] {
  const asked = requested(scope);
  return scoped(scope).invoices.filter((i) => isOpenInvoice(i) && !inFlight(i.id)).flatMap((i) => {
    const e = earlyPayOf(i, today); if (!e) return [];
    const status: DiscountRow["status"] = !e.open ? "missed" : i.earlyPay?.status === "approved" ? "approved" : asked.has(i.id) ? "requested" : "open";
    return [{ invoiceId: i.id, number: i.number, supplierId: i.supplierId, supplier: supName(i.supplierId), amount: i.amount, currency: i.currency ?? "USD", terms: termsLabel(i.terms), dueDate: i.dueDate, payBy: e.payBy, pct: e.pct, discount: e.discount, net: e.net, daysLeft: e.daysLeft, status, match: i.matchStatus }];
  }).sort((a, b) => a.payBy.localeCompare(b.payBy));
}
export type CurrencyTotal = { currency: string; invoices: number; payOnDue: number; payEarly: number; saved: number };
/** Pay-early against pay-on-due for the open discounts, one total per currency. Currencies are never added together and nothing is converted. */
export function payOptions(scope: string | null, today = day()) {
  const rows = discountRows(scope, today).filter((r) => r.status !== "missed");
  const by = new Map<string, CurrencyTotal>();
  for (const r of rows) { const t = by.get(r.currency) ?? { currency: r.currency, invoices: 0, payOnDue: 0, payEarly: 0, saved: 0 }; t.invoices += 1; t.payOnDue = r2(t.payOnDue + r.amount); t.saved = r2(t.saved + r.discount); t.payEarly = r2(t.payOnDue - t.saved); by.set(r.currency, t); }
  const byCurrency = [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  return { invoices: rows.length, byCurrency, lastDueDate: rows.map((r) => r.dueDate).sort().at(-1) ?? null, firstPayBy: rows[0]?.payBy ?? null, note: SAVINGS_NOTE };
}
/** "411.60 USD out, 8.40 USD saved and 1674.50 EUR out, 25.50 EUR saved". */
export const totalsText = (ts: CurrencyTotal[], pick: "payEarly" | "payOnDue" | "saved") => ts.map((t) => pick === "saved" ? `${t.saved.toFixed(2)} ${t.currency}` : pick === "payEarly" ? `${t.payEarly.toFixed(2)} ${t.currency} out, ${t.saved.toFixed(2)} ${t.currency} saved` : `${t.payOnDue.toFixed(2)} ${t.currency} out`).join(" and ");
/** What one invoice costs the forecast under each option: the full amount on the due date, or the net amount on the pay-by date while the discount is open. */
export function forecastLegs(i: Invoice, today = day()) {
  const e = earlyPayOf(i, today);
  return { onDue: { date: i.dueDate, amount: i.amount }, early: e?.open ? { date: e.payBy, amount: e.net, saved: e.discount } : { date: i.dueDate, amount: i.amount, saved: 0 } };
}
/** Sets terms on a supplier. New invoices from the supplier take them. Invoices already read keep theirs. */
export function setSupplierTerms(user: P.User, tenantId: string, supplierId: string, input: unknown) {
  const s = db.suppliers.find((x) => x.id === supplierId && tenantOf(x) === tenantId); if (!s) throw new P.AuthError(404, "supplier not found");
  const t = PaymentTerms.safeParse(input); if (!t.success) throw new P.AuthError(422, t.error.issues[0]?.message ?? "Terms are not valid");
  const before = s.terms ?? null; s.terms = t.data; save();
  P.audit(user.id, "supplier", s.id, "supplier.terms_set", { before, after: t.data }); return { supplierId: s.id, terms: s.terms, label: termsLabel(s.terms) };
}

const openInvoice = (p: any, today = day()) => {
  const i = db.invoices.find((x) => x.id === p?.invoiceId && tenantOf(x) === p?.tenantId); if (!i) throw new P.AuthError(404, "invoice not found");
  if (i.paid || inFlight(i.id)) throw new P.AuthError(409, "This invoice is already paid or in flight");
  if (!hasDiscount(i.terms)) throw new P.AuthError(422, "This invoice has no early-pay discount in its terms");
  const e = earlyPayOf(i, today); if (!e?.open) throw new P.AuthError(409, `The discount window closed on ${e?.payBy ?? "an unknown date"}`);
  return { i, e };
};
/** Maker checker: one client admin asks to pay early, a second one approves. Approval records the plan on the invoice and moves no money. */
P.registerChangeKind("payment.early_pay", {
  role: "client_admin",
  validate: (p) => { const { i } = openInvoice(p); if (i.earlyPay?.status === "approved") throw new P.AuthError(409, "Early payment is already approved for this invoice"); },
  apply: (p) => {
    const { i, e } = openInvoice(p);
    i.earlyPay = { status: "approved", payBy: e.payBy, pct: e.pct, discount: e.discount, requestedBy: String(p.requestedBy ?? ""), approvedAt: new Date().toISOString() };
    appendEvidence(db.evidence, "invoice", i.id, "invoice.early_pay_approved", { payBy: e.payBy, pct: e.pct, discount: e.discount, demoFigure: true }); save();
    return { invoiceId: i.id, earlyPay: i.earlyPay };
  },
});
/** Asks for an early payment plan. The same person cannot approve it. */
export function requestEarlyPay(user: P.User, tenantId: string, invoiceId: string) {
  if (requested(tenantId).has(invoiceId)) throw new P.AuthError(409, "An early payment request for this invoice is already waiting for approval");
  return P.requestChange(user, "payment.early_pay", { tenantId, invoiceId, requestedBy: user.id }, tenantId);
}
