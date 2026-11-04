import type { PolicyDecision, Category } from "@b2b/shared";
import type { Agent, Mandate } from "./store.js";
/** AP2 mandate checks: both signatures, cart inside intent, cart hash equals the payment. */
export { verifyMandatePair as evaluateMandates } from "./ap2.js";

export type PolicyInput = {
  agent: Agent; mandate: Mandate; killSwitch: boolean;
  supplierId: string; category: Category; amount: number; now?: Date;
  spentTotal: number; spentBySupplier: number;
  /** Amounts of this agent's POs to the same supplier in the last 24h, for split detection. */
  recentSameSupplier?: number[];
  /** Spend by this agent in the current calendar month. */
  spentThisMonth?: number;
};

/** Deterministic policy engine. Runs outside the model. Order matters: hard denies first, then approval routing. */
export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  const now = i.now ?? new Date();
  const checks: PolicyDecision["checks"] = [];
  const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });

  add("Global kill switch off", !i.killSwitch, i.killSwitch ? "Kill switch is on, all agent spend halted" : "Off");
  add("Agent active", i.agent.status === "active", `Agent status ${i.agent.status}`);
  add("Agent KYA verified", i.agent.kyaStatus === "verified", `KYA ${i.agent.kyaStatus}`);
  add("Mandate belongs to agent", i.mandate.agentId === i.agent.id, `Mandate ${i.mandate.id}`);
  const inWindow = now >= new Date(i.mandate.validFrom) && now <= new Date(i.mandate.validTo);
  add("Mandate in validity window", inWindow, `${i.mandate.validFrom.slice(0, 10)} to ${i.mandate.validTo.slice(0, 10)}`);
  add("Supplier allowed", i.mandate.allowedSuppliers.includes(i.supplierId), i.supplierId);
  add("Category allowed", i.mandate.allowedCategories.includes(i.category), i.category);
  add("Per transaction limit", i.amount <= i.mandate.perTxnMax, `${i.amount.toFixed(2)} vs max ${i.mandate.perTxnMax}`);
  add("Mandate total limit", i.spentTotal + i.amount <= i.mandate.maxAmount, `${(i.spentTotal + i.amount).toFixed(2)} vs max ${i.mandate.maxAmount}`);
  if (i.mandate.monthlyLimit !== undefined) add("Monthly limit", (i.spentThisMonth ?? 0) + i.amount <= i.mandate.monthlyLimit, `${((i.spentThisMonth ?? 0) + i.amount).toFixed(2)} vs max ${i.mandate.monthlyLimit} this month`);
  const supLimit = i.mandate.perSupplierLimit[i.supplierId] ?? i.mandate.maxAmount;
  add("Per supplier limit", i.spentBySupplier + i.amount <= supLimit, `${(i.spentBySupplier + i.amount).toFixed(2)} vs max ${supLimit}`);

  const failed = checks.filter((c) => !c.pass);
  if (failed.length) return { outcome: "deny", reasons: failed.map((f) => `${f.rule}: ${f.detail}`), checks };
  const recent = i.recentSameSupplier ?? [];
  const recentSum = recent.reduce((a, b) => a + b, 0);
  if (recent.length && i.amount <= i.mandate.approvalThreshold && recentSum + i.amount > i.mandate.approvalThreshold) {
    checks.push({ rule: "Split purchase detection", pass: false, detail: `${recent.length + 1} orders to ${i.supplierId} in 24h total ${(recentSum + i.amount).toFixed(2)}, above approval threshold ${i.mandate.approvalThreshold}` });
    return { outcome: "needs_approval", reasons: ["Possible split purchase to stay under approval threshold"], checks };
  }
  checks.push({ rule: "Split purchase detection", pass: true, detail: recent.length ? `24h total ${(recentSum + i.amount).toFixed(2)} within threshold` : "No recent orders to this supplier" });
  if (i.amount > i.mandate.approvalThreshold) {
    checks.push({ rule: "Human approval threshold", pass: false, detail: `${i.amount.toFixed(2)} above ${i.mandate.approvalThreshold}, human approval required` });
    return { outcome: "needs_approval", reasons: [`Amount above approval threshold ${i.mandate.approvalThreshold}`], checks };
  }
  checks.push({ rule: "Human approval threshold", pass: true, detail: `Under ${i.mandate.approvalThreshold}, auto approved` });
  return { outcome: "allow", reasons: ["All rules passed"], checks };
}
