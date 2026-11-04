import type { Category } from "@b2b/shared";

/** One ordered approval rule. The first rule that matches a purchase decides who must approve it. */
export type ApprovalRule = {
  id: string; tenantId: string; position: number; name: string; active: boolean;
  minAmount: number; maxAmount: number | null;
  /** Empty means any category. */
  categories: Category[];
  /** Entities the rule covers: supplier ids or the buying org id. Empty means any. */
  entities: string[];
  /** Levels run in order. Each needs count approvals from users with that role. */
  levels: { role: "approver" | "client_admin"; count: number }[];
};
export type RuleSubject = { amount: number; category: Category; supplierId: string; buyerOrgId: string };

export function ruleMatches(r: ApprovalRule, s: RuleSubject) {
  if (!r.active) return false;
  if (s.amount < r.minAmount) return false;
  if (r.maxAmount !== null && s.amount >= r.maxAmount) return false;
  if (r.categories.length && !r.categories.includes(s.category)) return false;
  if (r.entities.length && !r.entities.includes(s.supplierId) && !r.entities.includes(s.buyerOrgId)) return false;
  return true;
}
/** Pure: the first matching rule by position, or null. */
export function pickRule(rules: ApprovalRule[], s: RuleSubject) {
  return [...rules].sort((a, b) => a.position - b.position).find((r) => ruleMatches(r, s)) ?? null;
}
export function validateRule(r: Partial<ApprovalRule>): string | null {
  if (!r.name?.trim()) return "Give the rule a name";
  if (typeof r.minAmount !== "number" || r.minAmount < 0) return "Minimum amount must be zero or more";
  if (r.maxAmount !== null && r.maxAmount !== undefined && r.maxAmount <= r.minAmount) return "Maximum must be above the minimum";
  if (!r.levels?.length) return "Add at least one approval level";
  for (const l of r.levels) { if (!["approver", "client_admin"].includes(l.role)) return `Unknown role ${l.role}`; if (!Number.isInteger(l.count) || l.count < 1 || l.count > 5) return "Each level needs 1 to 5 approvers"; }
  return null;
}
