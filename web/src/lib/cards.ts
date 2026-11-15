/** Shared helpers for the Cards page. Plain wording, last4 only. */
export type CardView = { id: string; type: string; typeText: string; status: string; issuer: string; issuerLabel: string; last4: string; expiry: string; limit: number; currency: string; period: "month" | "card";
  spent: number; remaining: number; allowedMerchants: string[]; allowedMccs: string[]; supplierId: string | null; poId: string | null; ownerType: "user" | "agent"; owner: string; label: string; createdByName: string; approvedBy: string | null; createdAt: string; bindingHash?: string | null; cartAmount?: number | null; cartMandateId?: string | null };
/** The order a mandate-bound virtual card is tied to, with a fresh check of its signed mandates. */
export type CardOrder = { poId: string; status: string; supplierId: string; supplier: string; total: number | null; currency: string; cartAmount: number; erpRef: string | null;
  mandate: { ok: boolean; reason: string; intentId: string | null; cartId: string | null; cartHash: string | null; bindingHash: string | null; checks: { rule: string; pass: boolean; detail: string }[] } };
export type CardAuth = { id: string; merchant: string; mcc: string | null; amount: number; currency: string; approved: boolean; reason: string; status: string; source: string; providerRef: string | null; createdAt: string };

export const STATUS_TEXT: Record<string, string> = { active: "Active", frozen: "Frozen", canceled: "Canceled", closed: "Used", pending_approval: "Waiting for approval", rejected: "Rejected" };
export const statusTone = (s: string): "ok" | "warn" | "bad" | "neutral" => s === "active" ? "ok" : s === "frozen" || s === "pending_approval" ? "warn" : s === "rejected" ? "bad" : "neutral";
/** Share of the limit used, 0 to 100. */
export const usedPct = (c: Pick<CardView, "spent" | "limit">) => c.limit > 0 ? Math.min(100, Math.round((c.spent / c.limit) * 100)) : 0;
export const money = (n: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n ?? 0);
export const masked = (last4: string) => last4 ? `•••• ${last4}` : "Not issued yet";
/** Which controls a card offers right now. */
export function actionsFor(status: string) {
  return { freeze: status === "active", unfreeze: status === "frozen", cancel: ["active", "frozen"].includes(status), limit: ["active", "frozen"].includes(status), decide: status === "pending_approval", simulate: true };
}
/** Orders that can get a mandate-bound virtual card: approved and not paid yet. */
export const canIssueForOrder = (poStatus: string) => ["approved", "received", "invoiced"].includes(poStatus);
/** One plain line about the mandate behind a card. */
export const mandateLine = (o: Pick<CardOrder, "mandate" | "cartAmount" | "currency" | "supplier">, used: boolean) => !o.mandate.ok ? `Mandate problem. ${o.mandate.reason}. This card will decline.`
  : used ? `This card was used for its order. It paid ${money(o.cartAmount, o.currency)} to ${o.supplier}.` : `Mandate valid. This card works once, for exactly ${money(o.cartAmount, o.currency)} to ${o.supplier}.`;
export const TYPES = [
  { v: "one_time", label: "One-time", hint: "Closes after the first charge" },
  { v: "vendor_locked", label: "Vendor-locked", hint: "Works with one supplier or one MCC" },
  { v: "recurring", label: "Recurring", hint: "Limit resets each month" },
  { v: "agent", label: "Agent card", hint: "For an AI agent, inside its spend limit and suppliers" },
] as const;
