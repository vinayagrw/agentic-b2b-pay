import { z } from "zod";

/** Provider rails. Each one maps to a real adapter in bff/src/rails. */
export const Rail = z.enum(["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"]);
export type Rail = z.infer<typeof Rail>;
export const isUsdc = (r: Rail) => r === "circle_usdc" || r === "onchain_usdc";
export const RAIL_LABEL: Record<Rail, string> = { stripe_card: "Card (Stripe)", stripe_ach: "ACH (Stripe)", circle_usdc: "USDC (Circle)", onchain_usdc: "USDC on Base (direct)" };
export type PaymentStatus = "submitted" | "pending" | "settled" | "failed";
export const Category = z.enum(["mro", "components", "logistics", "it"]);
export type Category = z.infer<typeof Category>;

export const PoLine = z.object({
  sku: z.string().min(1),
  description: z.string().min(1),
  qty: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});
export type PoLine = z.infer<typeof PoLine>;

/** Strict shape the buyer agent (LLM or fallback) must return. */
export const PoDraft = z.object({
  supplierId: z.string().min(1),
  category: Category,
  currency: z.enum(["USD", "EUR", "GBP"]),
  lines: z.array(PoLine).min(1),
  justification: z.string().min(1),
  entityId: z.string().min(1).optional(),
}).strict();
export type PoDraft = z.infer<typeof PoDraft>;

/** Strict shape the invoice reader must return. */
export const InvoiceExtract = z.object({
  invoiceNumber: z.string().min(1),
  poNumber: z.string().min(1),
  supplierName: z.string().min(1),
  currency: z.enum(["USD", "EUR", "GBP"]),
  lines: z.array(z.object({ sku: z.string(), qty: z.number(), unitPrice: z.number() })).min(1),
  total: z.number().nonnegative(),
  dueDate: z.string(),
}).strict();
export type InvoiceExtract = z.infer<typeof InvoiceExtract>;

export const RegisterAgent = z.object({
  name: z.string().min(1),
  orgId: z.string().min(1),
  erpRole: z.string().min(1),
  protocols: z.array(z.string()).default(["mcp", "a2a"]),
});

export type PolicyDecision = {
  outcome: "allow" | "needs_approval" | "deny";
  reasons: string[];
  checks: { rule: string; pass: boolean; detail: string }[];
};

export type MatchResult = {
  status: "matched" | "exception";
  tolerancePct: number;
  lines: { sku: string; poQty: number; grQty: number; invQty: number; poPrice: number; invPrice: number; ok: boolean; note: string }[];
  totals: { po: number; invoice: number; variancePct: number };
};

export type RouteOption = { rail: Rail; eligible: boolean; feeUsd: number; settleMinutes: number; score: number; why: string[] };
export type RouteDecision = { rail: Rail | null; options: RouteOption[]; reason: string };

export type ComplianceResult = {
  outcome: "clear" | "blocked";
  checks: { kind: "kyb" | "sanctions" | "ofac_wallet" | "kyt" | "travel_rule"; result: "pass" | "fail" | "n/a"; detail: string; providerRef: string }[];
  travelRule?: Record<string, unknown>;
  /** Sanctions list hits behind any failed sanctions or wallet check. */
  hits?: { source: string; uid: string; sdnName: string; program: string; matchedOn: string; value: string; score: number; asset?: string }[];
};

/** Payment terms on a supplier or an invoice. Net days, plus an optional discount for paying early (2 percent in 10 days is "2/10 net 30"). */
export const PaymentTerms = z.object({
  netDays: z.number().int().min(0).max(180),
  discountPct: z.number().positive().max(20).optional(),
  discountDays: z.number().int().min(0).max(180).optional(),
}).strict().refine((t) => (t.discountPct === undefined) === (t.discountDays === undefined), "Set both the discount percent and the discount days, or neither")
  .refine((t) => t.discountDays === undefined || t.discountDays <= t.netDays, "Discount days cannot be longer than net days");
export type PaymentTerms = z.infer<typeof PaymentTerms>;
export const hasDiscount = (t?: PaymentTerms | null): t is PaymentTerms & { discountPct: number; discountDays: number } => !!t && typeof t.discountPct === "number" && typeof t.discountDays === "number";
export const termsLabel = (t?: PaymentTerms | null) => !t ? "No terms set" : hasDiscount(t) ? `${t.discountPct} percent off if paid in ${t.discountDays} days, net ${t.netDays}` : `Net ${t.netDays}`;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export type EarlyPay = { pct: number; payBy: string; discount: number; net: number; daysLeft: number; open: boolean };
/** The early-pay option on one invoice, or null when its terms carry no discount. Amounts are in the invoice currency. */
export function earlyPayOf(inv: { amount: number; invoiceDate?: string; terms?: PaymentTerms | null }, today: string): EarlyPay | null {
  if (!hasDiscount(inv.terms) || !inv.invoiceDate || !/^\d{4}-\d{2}-\d{2}/.test(inv.invoiceDate)) return null;
  const payBy = addDays(inv.invoiceDate, inv.terms.discountDays);
  const discount = Math.round(inv.amount * inv.terms.discountPct) / 100;
  const daysLeft = Math.round((Date.parse(`${payBy}T00:00:00Z`) - Date.parse(`${today.slice(0, 10)}T00:00:00Z`)) / 864e5);
  return { pct: inv.terms.discountPct, payBy, discount, net: Math.round((inv.amount - discount) * 100) / 100, daysLeft, open: daysLeft >= 0 };
}
