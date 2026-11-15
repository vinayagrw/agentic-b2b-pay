/** Wording for payment terms and early-pay discounts. The numbers come from the BFF. */
import { earlyPayOf, termsLabel, type PaymentTerms } from "@b2b/shared";
import { money } from "./cards";

export type DiscountRow = { invoiceId: string; number: string; supplierId: string; supplier: string; amount: number; currency: string; terms: string; dueDate: string; payBy: string; pct: number; discount: number; net: number; daysLeft: number; status: "open" | "approved" | "requested" | "missed"; match: string };
export type CurrencyTotal = { currency: string; invoices: number; payOnDue: number; payEarly: number; saved: number };
export type PayOptions = { invoices: number; byCurrency: CurrencyTotal[]; lastDueDate: string | null; firstPayBy: string | null; note: string };
/** One line per currency. Currencies are never added together. */
export const payEarlyLines = (o: Pick<PayOptions, "byCurrency">) => o.byCurrency.map((t) => `${money(t.payEarly, t.currency)} out, ${money(t.saved, t.currency)} saved`);
export const payOnDueLines = (o: Pick<PayOptions, "byCurrency">) => o.byCurrency.map((t) => `${money(t.payOnDue, t.currency)} out, nothing saved`);
export const savedText = (o: Pick<PayOptions, "byCurrency">) => o.byCurrency.map((t) => money(t.saved, t.currency)).join(" and ");
export type EarlyPayChange = { id: string; kind: string; status: string; requestedBy: string; createdAt: string; payload: { invoiceId?: string } };
/** Early pay requests that still wait for a decision. */
export const pendingEarlyPay = (changes: EarlyPayChange[] | undefined) => (changes ?? []).filter((c) => c.kind === "payment.early_pay" && c.status === "pending");
/** Who may decide a request: a client admin who did not ask for it. Returns the reason in plain words when the answer is no. */
export function earlyPayDecision(c: Pick<EarlyPayChange, "requestedBy">, me: { user: { id: string; role: string } } | null | undefined): { ok: boolean; why: string } {
  if (!me) return { ok: false, why: "Sign in to decide" };
  if (me.user.role !== "client_admin") return { ok: false, why: "Only a client admin can approve" };
  if (c.requestedBy === me.user.id) return { ok: false, why: "You asked for this. A second client admin account must approve." };
  return { ok: true, why: "" };
}
export const DEMO_NOTE = "Savings are demo figures. The payment still runs for the full invoice amount.";
export const STATUS_TEXT: Record<DiscountRow["status"], string> = { open: "Discount open", requested: "Waiting for a second admin", approved: "Early pay approved", missed: "Discount passed" };
export const statusTone = (s: DiscountRow["status"]): "ok" | "warn" | "neutral" => s === "approved" ? "ok" : s === "missed" ? "neutral" : "warn";
/** "Pay by 2026-11-20 to save $12.00" while the discount is open, plain words otherwise. */
export function payByLine(inv: { amount: number; currency?: string; invoiceDate?: string; dueDate?: string; paid?: boolean; terms?: PaymentTerms | null }, today = new Date().toISOString().slice(0, 10)) {
  if (!inv.terms) return "No terms set";
  const e = earlyPayOf(inv, today);
  if (!e) return `Due ${inv.dueDate ?? "date not set"}`;
  if (inv.paid) return "Paid";
  return e.open ? `Pay by ${e.payBy} to save ${money(e.discount, inv.currency ?? "USD")}` : `Discount passed on ${e.payBy}. Due ${inv.dueDate ?? "date not set"}`;
}
export const termsText = (t?: PaymentTerms | null) => termsLabel(t);
export const canAskEarlyPay = (r: Pick<DiscountRow, "status">, allowed: boolean) => allowed && r.status === "open";
