import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { db, reset, reload } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as W from "../src/workspace.js";
import * as CP from "../src/copilot.js";
import { buildApp, payStepUp } from "../src/server.js";
import { installFakes } from "./fakeRail.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); installFakes(); W.setBankTokenizer(async (b) => ({ tokenId: "btok_x", last4: b.accountNumber.slice(-4), bankName: null })); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); expect(r.statusCode).toBe(200); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const bank = { kind: "bank", bank: { holderName: "Northwind Components LLC", bankName: "Commerzbank", country: "DE", iban: "DE44500105175407324931" }, channel: "email", channelNote: "Email from the supplier asking to use a new account" };

describe("more id-taking routes hide another tenant's records", () => {
  it("returns 404 to a Globex admin for Acme agents, cards, draws, bank changes, suppliers, orders, payments, flows and entities", async () => {
    const app = await buildApp();
    const r: any = await S.runFlow("Need 2000 sealed 6204 bearings for line 3 maintenance", { scenario: "happy", tenantId: "tnt-acme" } as any);
    const pat = await login(app, "usr-clerk-pat");
    const card = await app.inject({ method: "POST", url: "/cards", headers: { cookie: pat }, payload: { type: "one_time", label: "Lunch", limit: 50 } });
    expect(card.statusCode).toBe(200); const cardId = card.json().card.id;
    const draw = await app.inject({ method: "POST", url: "/credit/draws", headers: { cookie: pat }, payload: { amount: 500, purpose: "Small top up" } });
    expect(draw.statusCode).toBe(200); const drawId = draw.json().id;
    const bc = await app.inject({ method: "POST", url: "/suppliers/sup-northwind/bank-changes", headers: { cookie: pat }, payload: bank });
    expect(bc.statusCode).toBe(200); const bcId = bc.json().id;
    const gina = await login(app, "usr-globex-gina");
    const routes: [string, string, any?][] = [
      ["POST", "/agents/agt-buyer-1/verify"], ["POST", "/agents/agt-buyer-1/suspend"], ["POST", "/agents/agt-buyer-1/resume"],
      ["GET", `/cards/${cardId}`], ["POST", `/cards/${cardId}/decide`, { approve: true }], ["POST", `/cards/${cardId}/limit`, { limit: 10 }],
      ["POST", `/cards/${cardId}/simulate`, { merchant: "x", amount: 1 }], ["POST", `/cards/${cardId}/freeze`],
      ["POST", `/credit/draws/${drawId}/decide`, { approve: true }], ["POST", `/credit/draws/${drawId}/repay`, { amount: 1 }],
      ["GET", `/bank-changes/${bcId}`], ["POST", `/bank-changes/${bcId}/callback`, { outcome: "confirmed" }], ["POST", `/bank-changes/${bcId}/decide`, { approve: true }],
      ["POST", "/workspace/suppliers/sup-northwind/link"], ["POST", "/workspace/suppliers/sup-northwind/review", { verify: true }],
      ["POST", "/workspace/suppliers/sup-northwind/hold", { reason: "test hold" }], ["POST", "/workspace/suppliers/sup-northwind/terms", { terms: {} }],
      ["POST", "/workspace/suppliers/sup-northwind/wallet-message", { address: "0xD00D00000000000000000000000000000000D00D" }],
      ["POST", "/workspace/suppliers/sup-northwind/portal-link"],
      ["GET", `/orders/${r.poId}/evidence`], ["POST", `/orders/${r.poId}/card`],
      ["GET", `/payments/${r.intentId}/why`], ["GET", `/flows/${r.intentId}`], ["GET", "/entities/ent-acme-eu/ledger"],
    ];
    for (const [method, url, payload] of routes) {
      const res = await app.inject({ method: method as any, url, headers: { cookie: gina }, payload });
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
    expect(db.agents.find((a) => a.id === "agt-buyer-1")!.status).toBe("active");
  });

  it("copilot id tools read only the caller's tenant", () => {
    const pi = db.intents[0] ?? null;
    const gina = P.getUser("usr-globex-gina")!;
    const c: any = { user: gina, scope: "tnt-globex", prefix: "/app" };
    const acmePay = pi?.id ?? "pi-none";
    for (const [name, args] of [["whyPayment", { paymentId: acmePay }], ["riskScore", { paymentId: acmePay }], ["fxGainLoss", { paymentId: acmePay }], ["supplierProfile", { supplierId: "sup-northwind" }]] as const) {
      const t = CP.TOOLS.find((x) => x.name === name)!;
      expect(() => t.run(c, args as any), name).toThrow(/not found/);
    }
    const audit = CP.TOOLS.find((x) => x.name === "auditSearch")!.run(c, { subjectId: "sup-northwind" });
    expect(audit.rows).toEqual([]);
    expect(CP.TOOLS.every((t) => !/pay_|execute|transfer/i.test(t.name))).toBe(true);
  });

  it("asks for a fresh code when a foreign invoice has no cached rate", () => {
    const pat = P.getUser("usr-clerk-pat")!;
    db.invoices.push({ ...(db.invoices[0] ?? {}), id: "inv-kwd", currency: "KWD", amount: 5000, invoiceDate: "2026-01-01" } as any);
    expect(() => payStepUp(pat, null, "inv-kwd")).toThrow(/step_up_required/);
  });

  it("hides a settlement with no known tenant from clients but not operators", async () => {
    const app = await buildApp();
    db.settlements.push({ id: "stl-orphan", paymentIntentId: "pi-missing", rail: "ach" as any, railRef: "x", txHash: null, chain: null, feeUsd: 0, confirmedAt: new Date().toISOString(), status: "confirmed" } as any);
    const sam = await login(app, "usr-controller-sam"); const olivia = await login(app, "usr-op-olivia");
    expect((await app.inject({ url: "/settlements/stl-orphan", headers: { cookie: sam } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/settlements/stl-orphan", headers: { cookie: olivia } })).statusCode).toBe(200);
  });

  it("lets an operator draft, edit, file and close a SAR on a client case", async () => {
    const app = await buildApp();
    await S.runFlow("Need steel", { scenario: "sanctioned" });
    const c = S.listCases().find((x) => x.kind === "sanctions")!;
    const olivia = await login(app, "usr-op-olivia");
    const d = await app.inject({ method: "POST", url: `/ops/cases/${c.id}/sar/draft`, headers: { cookie: olivia } }); expect(d.statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/ops/cases/${c.id}/sar`, headers: { cookie: olivia }, payload: { text: d.json().sar.text + " ok" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/ops/cases/${c.id}/sar/file`, headers: { cookie: olivia } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/ops/cases/${c.id}/close`, headers: { cookie: olivia }, payload: { resolution: "Supplier offboarded" } })).statusCode).toBe(200);
  });
});
