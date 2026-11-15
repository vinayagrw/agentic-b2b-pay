/** Wording for payment terms and early-pay discounts. The numbers come from the BFF. */
import { earlyPayOf, termsLabel, type PaymentTerms } from "@b2b/shared";
import { money } from "./cards";

export type DiscountRow = { invoiceId: string; number: string; supplierId: string; supplier: string; amount: number; currency: string; terms: string; dueDate: string; payBy: string; pct: number; discount: number; net: number; daysLeft: number; status: "open" | "approved" | "requested" | "missed"; match: string };
export type PayOptions = { invoices: number; payOnDue: { outflow: number; saved: number; lastDate: string | null }; payEarly: { outflow: number; saved: number; firstPayBy: string | null }; note: string };
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
