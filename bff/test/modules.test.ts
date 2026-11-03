import { describe, it, expect } from "vitest";
import { seed } from "../src/modules/store.js";
import { evaluatePolicy } from "../src/modules/policy.js";
import { threeWayMatch } from "../src/modules/match.js";
import { routePayment } from "../src/modules/router.js";
import { screen } from "../src/modules/compliance.js";
import { makeJournal, trialBalance, reconcile } from "../src/modules/ledger.js";
import { appendEvidence, verifyChain } from "../src/modules/evidence.js";
import { mpcSign } from "../src/modules/custody.js";

const s = seed();
const agent = { ...s.agents[0], kyaStatus: "verified" as const };
const base = { agent, mandate: s.mandates[0], killSwitch: false, supplierId: "sup-northwind", category: "components" as const, amount: 500, spentTotal: 0, spentBySupplier: 0 };

describe("policy", () => {
  it("allows small in-mandate spend", () => expect(evaluatePolicy(base).outcome).toBe("allow"));
  it("routes above threshold to human approval", () => expect(evaluatePolicy({ ...base, amount: 15000 }).outcome).toBe("needs_approval"));
  it("denies above per txn limit", () => expect(evaluatePolicy({ ...base, amount: 45000 }).outcome).toBe("deny"));
  it("denies above per supplier cap", () => expect(evaluatePolicy({ ...base, supplierId: "sup-contoso", category: "logistics", amount: 5000, spentBySupplier: 18000 }).outcome).toBe("deny"));
  it("denies disallowed category", () => expect(evaluatePolicy({ ...base, category: "it" }).outcome).toBe("deny"));
  it("kill switch denies everything", () => expect(evaluatePolicy({ ...base, killSwitch: true }).outcome).toBe("deny"));
  it("suspended agent denied", () => expect(evaluatePolicy({ ...base, agent: { ...agent, status: "suspended" } }).outcome).toBe("deny"));
  it("detects split purchases under threshold", () => {
    const d = evaluatePolicy({ ...base, amount: 4000, recentSameSupplier: [4000, 4000] });
    expect(d.outcome).toBe("needs_approval");
    expect(d.reasons[0]).toMatch(/split/i);
  });
});

describe("3-way match", () => {
  const po = [{ sku: "A", description: "a", qty: 10, unitPrice: 5 }];
  it("matches within tolerance", () => expect(threeWayMatch(po, [{ sku: "A", qty: 10 }], [{ sku: "A", qty: 10, unitPrice: 5.05 }]).status).toBe("matched"));
  it("flags price variance", () => expect(threeWayMatch(po, [{ sku: "A", qty: 10 }], [{ sku: "A", qty: 10, unitPrice: 6 }]).status).toBe("exception"));
  it("flags invoiced above received", () => expect(threeWayMatch(po, [{ sku: "A", qty: 8 }], [{ sku: "A", qty: 10, unitPrice: 5 }]).status).toBe("exception"));
  it("flags extra line", () => expect(threeWayMatch(po, [{ sku: "A", qty: 10 }], [{ sku: "A", qty: 10, unitPrice: 5 }, { sku: "B", qty: 1, unitPrice: 1 }]).status).toBe("exception"));
});

describe("rail router", () => {
  const r = { amount: 9000, urgency: "standard" as const, mandateRails: ["card", "ach", "rtp", "usdc"] as any, supplierRails: ["ach", "rtp", "usdc"] as any, supplierPreferred: "usdc" as const, supplierHasWallet: true, supplierScreening: "clear" as const, supplierCountry: "US" };
  it("picks USDC on supplier preference", () => expect(routePayment(r).rail).toBe("usdc"));
  it("falls back to fiat without wallet", () => expect(routePayment({ ...r, supplierHasWallet: false }).rail).toBe("rtp"));
  it("card excluded above card limit", () => expect(routePayment({ ...r, amount: 20000, supplierRails: ["card", "ach"], supplierPreferred: "card" }).rail).toBe("ach"));
  it("respects mandate rails", () => expect(routePayment({ ...r, mandateRails: ["ach"] }).rail).toBe("ach"));
  it("no eligible rail holds payment", () => expect(routePayment({ ...r, mandateRails: ["card"], supplierRails: ["ach"] }).rail).toBeNull());
});

describe("compliance", () => {
  const ben = { name: "Northwind Components LLC", orgId: "org-northwind", country: "US", wallet: "0x9a1C00000000000000000000000000000000C0DE", kybVerified: true };
  const org = { name: "Acme", orgId: "org-acme", country: "US" };
  it("clears good wallet and builds Travel Rule on every USDC transfer", () => {
    const small = screen({ rail: "usdc", amount: 100, originator: org, beneficiary: ben });
    expect(small.outcome).toBe("clear"); expect(small.travelRule).toBeDefined();
    expect(small.checks.map((c) => c.kind)).toEqual(["kyb", "sanctions", "ofac_wallet", "kyt", "travel_rule"]);
  });
  it("blocks sanctioned wallet", () => {
    const r = screen({ rail: "usdc", amount: 6200, originator: org, beneficiary: { ...ben, wallet: "0xBAD0000000000000000000000000000000000BAD" } });
    expect(r.outcome).toBe("blocked"); expect(r.checks.find((c) => c.kind === "ofac_wallet")!.result).toBe("fail");
  });
  it("blocks sanctioned name on fiat", () => expect(screen({ rail: "ach", amount: 10, originator: org, beneficiary: { ...ben, name: "Rogue Metals Trading" } }).outcome).toBe("blocked"));
});

describe("ledger", () => {
  it("rejects unbalanced journals", () => expect(() => makeJournal("j1", "x", "r", [{ account: "a", debit: 10 }, { account: "b", credit: 9 }])).toThrow(/Unbalanced/));
  it("trial balance stays balanced and reconciles", () => {
    const js = [
      makeJournal("j1", "Invoice accrued", "inv", [{ account: "1300 Inventory", debit: 100 }, { account: "2000 Accounts payable", credit: 100 }]),
      makeJournal("j2", "Payment x", "pi-1", [{ account: "2000 Accounts payable", debit: 100 }, { account: "1000 Cash operating", credit: 100 }]),
    ];
    const tb = trialBalance(js);
    expect(tb.balanced).toBe(true); expect(tb.accounts["2000 Accounts payable"].balance).toBe(0);
    expect(reconcile([{ id: "s", paymentIntentId: "pi-1", amount: 100 }], js)[0].matched).toBe(true);
    expect(reconcile([{ id: "s", paymentIntentId: "pi-2", amount: 100 }], js)[0].matched).toBe(false);
  });
});

describe("evidence chain", () => {
  it("verifies and detects tampering", () => {
    const c: any[] = [];
    appendEvidence(c, "po", "po-1", "a", { x: 1 }); appendEvidence(c, "po", "po-1", "b", { y: 2 }); appendEvidence(c, "pay", "pi-1", "c", { z: 3 });
    expect(verifyChain(c).valid).toBe(true);
    c[1].payload = { y: 999 };
    expect(verifyChain(c)).toEqual({ valid: false, brokenAt: 2 });
  });
});

describe("custody", () => {
  it("needs 2 of 3 quorum", () => {
    expect(mpcSign("d", ["signer-controller"]).approved).toBe(false);
    expect(mpcSign("d", ["signer-controller", "signer-treasury-ops"]).approved).toBe(true);
    expect(mpcSign("d", ["signer-controller", "intruder"]).approved).toBe(false);
  });
});
