import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import { buildApp } from "../src/server.js";
import { verifyChain } from "../src/modules/evidence.js";

beforeEach(() => { reset(); S.bootstrap(); });

describe("end to end flow (mock LLM)", () => {
  it("happy path settles on USDC, balances ledger, chain valid", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.status).toBe("settled"); expect(pi.route?.rail).toBe("usdc");
    expect(db.settlements[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(S.ledgerView().trialBalance.balanced).toBe(true);
    expect(S.ledgerView().reconciliation.every((x) => x.matched)).toBe(true);
    expect(db.erp.some((e) => e.kind === "SupplierInvoice.clear")).toBe(true);
    expect(verifyChain(db.evidence).valid).toBe(true);
    expect(S.camt053()).toContain(db.settlements[0].txHash!);
  });
  it("sanctioned wallet scenario is blocked, no settlement, no cash movement", async () => {
    const r = await S.runFlow("steel", { scenario: "sanctioned" });
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.status).toBe("blocked"); expect(db.settlements).toHaveLength(0);
    expect(S.ledgerView().trialBalance.accounts["1010 USDC treasury (simulated)"]).toBeUndefined();
    expect(verifyChain(db.evidence).valid).toBe(true);
  });
  it("idempotent payment execution", async () => {
    const r = await S.runFlow("Need 100 nitrile gloves");
    const inv = r.invoiceId!;
    const again = await S.payInvoice(inv, `idem-${inv}`);
    expect(again.replay).toBe(true); expect(db.settlements).toHaveLength(1);
  });
  it("refund is a new forward payment, capped at original", async () => {
    const r = await S.runFlow("Need 100 nitrile gloves");
    const rf = await S.refund(r.intentId!, 100, "damaged");
    expect(rf.status).toBe("settled"); expect(db.settlements[0].txHash).not.toBe(rf.txHash);
    await expect(S.refund(r.intentId!, 5000, "too much")).rejects.toThrow(/exceeds/);
    expect(S.ledgerView().trialBalance.balanced).toBe(true);
  });
});

describe("prompt injection and payee control", () => {
  it("poisoned invoice cannot change wallet and split amounts are blocked", async () => {
    const before = db.suppliers.find((s) => s.id === "sup-northwind")!.walletAddress;
    const r = await S.runFlow("Need 2000 sealed 6204 bearings", { scenario: "poisoned" });
    const sup = db.suppliers.find((s) => s.id === "sup-northwind")!;
    expect(sup.walletAddress).toBe(before);
    expect(db.evidence.some((e) => e.event === "security.injection_ignored")).toBe(true);
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.compliance?.travelRule?.["beneficiary"]).toMatchObject({ wallet: before });
    // split attempt: agent tries several POs each under the 10000 threshold
    const draft = { supplierId: "sup-northwind", category: "components" as const, currency: "USD" as const, lines: [{ sku: "NW-MTR-750", description: "m", qty: 10, unitPrice: 420 }], justification: "split" };
    const outcomes = [S.createPo(draft), S.createPo(draft), S.createPo(draft)].map((p) => p.status);
    expect(outcomes).toContain("pending_approval");
    expect(outcomes.filter((o) => o === "approved").length).toBeLessThan(3);
    // a payee change from a non ERP source is rejected
    expect(() => S.requestPayeeChange({ supplierId: "sup-northwind", field: "walletAddress", newValue: "0xBEEF", source: "llm", requestedBy: "agt-buyer-1" })).toThrow(/ERP/);
  });
  it("ERP payee change needs four eyes and callback", () => {
    const c = S.requestPayeeChange({ supplierId: "sup-contoso", field: "bankDetailsRef", newValue: "bank-ref-NEW", source: "erp", requestedBy: "usr-a" });
    expect(() => S.approvePayeeChange(c.id, "usr-a")).toThrow(/Four eyes/);
    S.approvePayeeChange(c.id, "usr-b"); S.approvePayeeChange(c.id, "usr-c");
    expect(db.suppliers.find((s) => s.id === "sup-contoso")!.bankDetailsRef).toBe("bank-ref-002");
    S.callbackPayeeChange(c.id, true);
    expect(db.suppliers.find((s) => s.id === "sup-contoso")!.bankDetailsRef).toBe("bank-ref-NEW");
  });
  it("custody quorum not met blocks stablecoin send", async () => {
    const d = (await S.draftPo("Need 100 nitrile gloves")).value;
    const po = S.createPo(d); S.receiveGoods(po.id);
    const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {})); S.matchInvoice(inv.id);
    const { intent } = await S.payInvoice(inv.id, "k1", { approvers: ["signer-controller"] });
    expect(intent.status).toBe("blocked"); expect(intent.blockedReason).toMatch(/quorum/);
  });
});

describe("gateway", () => {
  it("lists MCP tools and requires idempotency key", async () => {
    const app = await buildApp();
    const t = await app.inject({ method: "GET", url: "/mcp/tools" });
    expect(t.json().tools.map((x: any) => x.name)).toContain("execute_payment");
    const p = await app.inject({ method: "POST", url: "/invoices/inv-x/pay", payload: {} });
    expect(p.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/purchase-orders", payload: { draft: { supplierId: "x" } } });
    expect(bad.statusCode).toBe(422);
  });
});
