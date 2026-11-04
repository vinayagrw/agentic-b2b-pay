import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import { buildApp } from "../src/server.js";
import { verifyChain } from "../src/modules/evidence.js";
import { installFakes } from "./fakeRail.js";
import * as P from "../src/platform.js";

let rails: ReturnType<typeof installFakes>;
beforeEach(() => { rails = installFakes(); reset(); S.bootstrap(); });

describe("end to end flow (mock LLM)", () => {
  it("happy path goes pending, settles from the watcher, balances ledger, chain valid", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.status).toBe("pending"); expect(pi.route?.rail).toBe("onchain_usdc");
    const inv = db.invoices.find((i) => i.id === pi.invoiceId)!;
    expect(inv.paid).toBe(false); expect(db.journals.some((j) => j.ref === pi.id)).toBe(false);
    await S.pollSettlements();
    expect(pi.status).toBe("settled"); expect(inv.paid).toBe(true);
    expect(pi.timeline!.map((t) => t.status)).toEqual(["created", "routed", "submitted", "pending", "settled"]);
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
    expect(S.ledgerView().trialBalance.accounts["1010 USDC treasury"]).toBeUndefined();
    expect(verifyChain(db.evidence).valid).toBe(true);
  });
  it("idempotent payment execution", async () => {
    const r = await S.runFlow("Need 100 nitrile gloves");
    const inv = r.invoiceId!;
    const again = await S.payInvoice(inv, `idem-${inv}`);
    expect(again.replay).toBe(true);
    await expect(S.payInvoice(inv, "another-key")).rejects.toThrow(/in flight/);
    await S.pollSettlements(); await S.pollSettlements();
    expect(db.settlements).toHaveLength(1);
  });
  it("stablecoin refund is refused as final, amount still capped", async () => {
    const r = await S.runFlow("Need 100 nitrile gloves"); await S.pollSettlements();
    await expect(S.refund(r.intentId!, 5000, "too much")).rejects.toThrow(/exceeds/);
    await expect(S.refund(r.intentId!, 100, "damaged")).rejects.toThrow(/final/);
    expect(S.ledgerView().trialBalance.balanced).toBe(true);
  });
  it("provider failure from the watcher fails the payment and leaves the invoice open", async () => {
    rails.onchain_usdc.outcome = "failed";
    const r = await S.runFlow("Need 100 nitrile gloves"); await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.status).toBe("failed"); expect(db.invoices.find((i) => i.id === pi.invoiceId)!.paid).toBe(false);
    expect(db.settlements).toHaveLength(0);
  });
  it("send error fails at once with no simulated fallback", async () => {
    rails.onchain_usdc.failSend = "RPC down";
    const r = await S.runFlow("Need 100 nitrile gloves");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.status).toBe("failed"); expect(pi.blockedReason).toBe("RPC down"); expect(pi.rail).toBe("onchain_usdc");
  });
  it("router skips rails that are not configured", async () => {
    rails = installFakes({ onchain_usdc: false, circle_usdc: false });
    const r = await S.runFlow("Need 100 nitrile gloves");
    expect(db.intents.find((i) => i.id === r.intentId)!.rail).toBe("stripe_ach");
  });
  it("webhook settles, dedupes replays and turns a dispute into a case", async () => {
    rails = installFakes({ onchain_usdc: false, circle_usdc: false });
    const r = await S.runFlow("Need 100 nitrile gloves");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    await expect(S.ingestWebhook("stripe", Buffer.from("forged"), {})).rejects.toThrow(/signature/);
    const evt = { eventId: "evt_1", type: "payment_intent.succeeded", providerRef: pi.providerRef!, status: "settled" as const };
    rails.stripe_card.webhookQueue.push(evt);
    await S.ingestWebhook("stripe", Buffer.from("signed"), {});
    expect(pi.status).toBe("settled");
    rails.stripe_card.webhookQueue.push(evt);
    expect((await S.ingestWebhook("stripe", Buffer.from("signed"), {})).received[0].applied).toBe(false);
    expect(db.settlements).toHaveLength(1);
    rails.stripe_card.webhookQueue.push({ eventId: "evt_2", type: "charge.dispute.created", providerRef: pi.providerRef!, dispute: { id: "dp_1", amount: 50, reason: "fraudulent", chargeId: "ch_1" } });
    await S.ingestWebhook("stripe", Buffer.from("signed"), {});
    expect(S.listCases()[0]).toMatchObject({ kind: "dispute", intentId: pi.id, status: "open" });
    const rf = await S.refund(pi.id, 10, "credit");
    expect(rf.status).toBe("settled");
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
  it("old routes need auth, then list MCP tools and require an idempotency key", async () => {
    P.seedPlatform();
    const app = await buildApp();
    for (const [method, url] of [["GET", "/state"], ["GET", "/mcp/tools"], ["POST", "/reset"], ["POST", "/kill-switch"], ["POST", "/invoices/inv-x/pay"], ["GET", "/payments"]] as const) expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    const lr = await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-clerk-pat" } });
    const cookie = `sid=${lr.cookies.find((c: any) => c.name === "sid")!.value}`;
    expect((await app.inject({ method: "POST", url: "/reset", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/webhooks/stripe", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
    const t = await app.inject({ method: "GET", url: "/mcp/tools", headers: { cookie } });
    expect(t.json().tools.map((x: any) => x.name)).toContain("execute_payment");
    const p = await app.inject({ method: "POST", url: "/invoices/inv-x/pay", payload: {}, headers: { cookie } });
    expect(p.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/purchase-orders", payload: { draft: { supplierId: "x" } }, headers: { cookie } });
    expect(bad.statusCode).toBe(422);
  });
});
