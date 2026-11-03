import { z } from "zod";

export const Rail = z.enum(["card", "ach", "rtp", "usdc"]);
export type Rail = z.infer<typeof Rail>;
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
  currency: z.literal("USD"),
  lines: z.array(PoLine).min(1),
  justification: z.string().min(1),
}).strict();
export type PoDraft = z.infer<typeof PoDraft>;

/** Strict shape the invoice reader must return. */
export const InvoiceExtract = z.object({
  invoiceNumber: z.string().min(1),
  poNumber: z.string().min(1),
  supplierName: z.string().min(1),
  currency: z.literal("USD"),
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
};
