import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import { buildApp } from "../src/server.js";
import { installFakes } from "./fakeRail.js";

let rails: ReturnType<typeof installFakes>;
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const failed = async () => { rails.onchain_usdc.failSend = "RPC down"; const r = await S.runFlow("Need 100 nitrile gloves"); return db.intents.find((i) => i.id === r.intentId)!; };

describe("retry and re-route of failed payments", () => {
  beforeEach(() => { rails = installFakes(); reset(); S.bootstrap(); });
  it("retries on the same rail, links attempts, and settles once", async () => {
    const pi = await failed(); expect(pi.status).toBe("failed");
    rails.onchain_usdc.failSend = undefined;
    const r = await S.retryPayment(pi.id, "same", "retry-1");
    expect(r.intent.rail).toBe("onchain_usdc"); expect(r.intent.retryOf).toBe(pi.id); expect(r.intent.attempt).toBe(2); expect(pi.retriedBy).toBe(r.intent.id);
    const again = await S.retryPayment(pi.id, "same", "retry-1"); expect(again.replay).toBe(true); expect(again.intent.id).toBe(r.intent.id);
    await expect(S.retryPayment(pi.id, "same", "retry-2")).rejects.toThrow(/already retried/);
    await S.pollSettlements();
    expect(db.settlements).toHaveLength(1); expect(db.invoices.find((i) => i.id === pi.invoiceId)!.paid).toBe(true);
    expect(S.paymentAttempts(r.intent.id).map((a) => [a.attempt, a.status])).toEqual([[1, "failed"], [2, "settled"]]);
  });
  it("re-routes to another eligible rail and never reuses a failed rail", async () => {
    const pi = await failed();
    const r = await S.retryPayment(pi.id, "reroute", "rr-1");
    expect(r.intent.rail).toBeTruthy(); expect(r.intent.rail).not.toBe("onchain_usdc"); expect(r.intent.status).toBe("pending");
  });
  it("caps attempts and refuses a payment that did not fail", async () => {
    const pi = await failed();
    const a2 = await S.retryPayment(pi.id, "same", "c-2"); expect(a2.intent.status).toBe("failed");
    const a3 = await S.retryPayment(a2.intent.id, "same", "c-3"); expect(a3.intent.status).toBe("failed");
    await expect(S.retryPayment(a3.intent.id, "reroute", "c-4")).rejects.toThrow(/Attempt limit/);
    rails.onchain_usdc.failSend = undefined;
    const ok = await S.runFlow("Need 50 safety glasses");
    await expect(S.retryPayment(ok.intentId!, "same", "c-5")).rejects.toThrow(/Only a failed payment/);
  });
});

describe("simulated ACH return", () => {
  beforeEach(() => { rails = installFakes({ onchain_usdc: false, circle_usdc: false }); reset(); S.bootstrap(); });
  it("reverses the ledger, reopens the invoice and records the code", async () => {
    const r = await S.runFlow("Need 100 nitrile gloves"); await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.rail).toBe("stripe_ach"); expect(pi.status).toBe("settled");
    const cashBefore = S.ledgerView().trialBalance.accounts["1000 Cash operating"]?.balance ?? 0;
    expect(() => S.achReturn(pi.id, "R99", "usr-x")).toThrow(/Unknown return code/);
    S.achReturn(pi.id, "R01", "usr-x");
    expect(pi.status).toBe("returned"); expect(pi.achReturn?.code).toBe("R01"); expect(pi.achReturn?.reason).toBe("Insufficient funds");
    expect(db.invoices.find((i) => i.id === pi.invoiceId)!.paid).toBe(false);
    const tb = S.ledgerView().trialBalance; expect(tb.balanced).toBe(true);
    expect(tb.accounts["1000 Cash operating"]?.balance ?? 0).not.toBe(cashBefore);
    const net = db.journals.filter((j) => j.ref === pi.id).flatMap((j) => j.entries).filter((e) => e.account === "1000 Cash operating").reduce((a, e) => a + e.debit - e.credit, 0);
    expect(Math.abs(net)).toBeLessThan(0.001);
    expect(() => S.achReturn(pi.id, "R01", "usr-x")).toThrow(/already returned/);
    const again = await S.payInvoice(pi.invoiceId, "after-return"); expect(again.intent.status).toBe("pending");
  });
  it("refuses a return on a non ACH rail", async () => {
    rails = installFakes(); reset(); S.bootstrap();
    const r = await S.runFlow("Need 100 nitrile gloves"); await S.pollSettlements();
    expect(() => S.achReturn(r.intentId!, "R01", "usr-x")).toThrow(/Only an ACH/);
  });
});

describe("retry and return routes", () => {
  beforeEach(() => { rails = installFakes(); reset(); S.bootstrap(); });
  it("needs a key, a valid mode, and a signed-in user", async () => {
    const pi = await failed(); const app = await buildApp(); const sam = await login(app, "usr-controller-sam");
    expect((await app.inject({ method: "POST", url: `/payments/${pi.id}/retry`, payload: { mode: "same" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/payments/${pi.id}/retry`, headers: { cookie: sam }, payload: { mode: "same" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/payments/${pi.id}/retry`, headers: { cookie: sam, "idempotency-key": "k1" }, payload: { mode: "x" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/payments/nope/ach-return`, headers: { cookie: sam }, payload: { code: "R01" } })).statusCode).toBe(404);
    const g = await app.inject({ method: "GET", url: `/payments/${pi.id}`, headers: { cookie: sam } });
    expect(g.json().attempts).toHaveLength(1); expect(g.json().maxAttempts).toBe(3);
  });
});
