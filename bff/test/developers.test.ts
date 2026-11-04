import { describe, it, expect, beforeEach } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as D from "../src/developers.js";
import * as A from "../src/analytics.js";
import { buildApp } from "../src/server.js";
import { installFakes } from "./fakeRail.js";

let rails: ReturnType<typeof installFakes>;
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); rails = installFakes(); });
const jane = () => P.getUser("usr-cfo-jane")!;
async function cardPayment() {
  db.suppliers.find((s) => s.id === "sup-northwind")!.acceptedRails = ["stripe_card"]; db.suppliers.find((s) => s.id === "sup-northwind")!.preferredRail = "stripe_card";
  const r = await S.runFlow("Need 20 nitrile gloves boxes"); await S.pollSettlements(); return db.intents.find((i) => i.id === r.intentId)!;
}

describe("refunds and disputes", () => {
  it("a refund is a linked payment and shows in revenue as a refund", async () => {
    const pi = await cardPayment(); expect(pi.status).toBe("settled");
    const rf = await S.refund(pi.id, 40, "Two boxes damaged");
    const linked = db.intents.find((i) => i.id === (rf as any).intentId)!;
    expect(linked).toMatchObject({ kind: "refund", linkedIntentId: pi.id, amount: 40, status: "settled", tenantId: "tnt-acme" });
    expect(pi.refundIds).toEqual([linked.id]);
    await expect(S.refund(linked.id, 1, "x")).rejects.toThrow(/cannot be refunded/);
    const rev = A.revenue(); expect(rev.totals.refunds).toBe(40); expect(rev.totals.count).toBe(1);
  });
  it("exports a dispute evidence pack with the PO, receipt, match and audit trail", async () => {
    const pi = await cardPayment();
    rails.stripe_card.webhookQueue.push({ eventId: "evt_dp_1", type: "charge.dispute.created", providerRef: pi.providerRef!, dispute: { id: "dp_1", amount: pi.amount, reason: "product_not_received", chargeId: "ch_1" } });
    await S.ingestWebhook("stripe", Buffer.from("signed"), {});
    const c = S.listCases().find((x) => x.kind === "dispute")!;
    const pack = A.evidencePack(c.id);
    expect(pack.purchaseOrder?.lines.length).toBeGreaterThan(0); expect(pack.goodsReceipts).toHaveLength(1); expect(pack.invoice?.match?.status).toBe("matched");
    expect(pack.auditTrail.some((e) => e.event === "settlement.confirmed")).toBe(true); expect(pack.auditChainValid).toBe(true);
  });
});

describe("revenue and KPIs", () => {
  it("computes bank fee and net revenue by tenant, rail and month from settled payments", async () => {
    const pi = await cardPayment();
    const row = A.revenue().rows[0];
    expect(row).toMatchObject({ tenantId: "tnt-acme", rail: "stripe_card", count: 1, volume: pi.amount, bank: "Northstar Bank" });
    expect(row.bankFees).toBe(Math.round((pi.amount * 0.004 + 0.1) * 100) / 100);
    expect(row.net).toBe(Math.round((row.bankFees - row.railFees) * 100) / 100);
    const k = A.kpis(); expect(k.settledCount).toBe(1); expect(k.settledVolume).toBe(pi.amount); expect(k.daily).toHaveLength(30); expect(k.daily[29].volume).toBe(pi.amount);
  });
});

describe("developers", () => {
  it("API keys are hashed at rest, authenticate with their role and stop after revoke", async () => {
    const k = D.createApiKey(jane(), "tnt-acme", "ERP sync", "auditor");
    expect(JSON.stringify(sql.prepare("SELECT * FROM api_keys").all())).not.toContain(k.key);
    const app = await buildApp(); const h = { authorization: `Bearer ${k.key}` };
    expect((await app.inject({ url: "/state", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: true } })).statusCode).toBe(403);
    D.revokeApiKey(jane(), "tnt-acme", k.id);
    expect((await app.inject({ url: "/state", headers: h })).statusCode).toBe(401);
  });
  it("delivers signed webhooks for domain events and retries with backoff", async () => {
    const ep = D.createEndpoint(jane(), "tnt-acme", "https://erp.example/hooks", ["payment.settled"]);
    expect(() => D.createEndpoint(jane(), "tnt-acme", "http://erp.example/hooks", [])).toThrow(/https/);
    await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const got: { url: string; headers: Record<string, string>; body: string }[] = []; let fail = true;
    const fetcher = async (url: string, init: any) => { got.push({ url, ...init }); return { status: fail ? 500 : 200 }; };
    const t0 = new Date();
    expect(await D.deliverDue(fetcher, t0)).toBe(1);
    const sig = got[0].headers["x-b2bpay-signature"]; expect(D.verifySignature(ep.secret, sig, got[0].body, 300, Math.floor(t0.getTime() / 1000))).toBe(true);
    expect(D.verifySignature("whsec_wrong", sig, got[0].body, 300, Math.floor(t0.getTime() / 1000))).toBe(false);
    expect(JSON.parse(got[0].body).type).toBe("payment.settled");
    expect(await D.deliverDue(fetcher, new Date(t0.getTime() + 5000))).toBe(0);
    fail = false; expect(await D.deliverDue(fetcher, new Date(t0.getTime() + 11000))).toBe(1);
    const log = D.eventLog("tnt-acme"); const settled = log.find((e) => e.type === "payment.settled")!;
    expect(settled.deliveries[0]).toMatchObject({ status: "delivered", attempts: 2, lastStatus: 200 });
    expect(log.some((e) => e.type === "purchase_order.approved")).toBe(true);
  });
  it("gives up after the last backoff step", async () => {
    D.createEndpoint(jane(), "tnt-acme", "https://down.example/h", []);
    D.recordEvent("tnt-acme", "ping", {});
    let t = Date.now();
    for (let n = 0; n <= D.BACKOFF_SEC.length; n++) { await D.deliverDue(async () => { throw new Error("connect refused"); }, new Date(t)); t += 3 * 3600e3; }
    expect(D.eventLog("tnt-acme")[0].deliveries[0]).toMatchObject({ status: "failed", attempts: D.BACKOFF_SEC.length + 1, lastError: "connect refused" });
  });
});
