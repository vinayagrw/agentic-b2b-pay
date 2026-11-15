import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { db, reset, reload } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); expect(r.statusCode).toBe(200); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };

describe("every id-taking route and MCP tool hides another tenant's records", () => {
  it("returns 404 to a Globex user for Acme ids", async () => {
    const app = await buildApp();
    const r: any = await S.runFlow("Need 2000 sealed 6204 bearings for line 3 maintenance", { scenario: "happy", tenantId: "tnt-acme" } as any);
    const po = r.poId, inv = r.invoiceId, pay = r.intentId;
    db.settlements.push({ id: "stl-xt", tenantId: "tnt-acme", paymentIntentId: pay, rail: "ach" as any, railRef: "x", txHash: null, chain: null, feeUsd: 0, confirmedAt: new Date().toISOString(), status: "confirmed" });
    const kase = S.openCase({ tenantId: "tnt-acme", kind: "dispute", intentId: pay, title: "x", detail: {} } as any);
    const sup = db.suppliers.find((s) => (s.tenantId ?? "tnt-acme") === "tnt-acme")!.id;
    const gina = await login(app, "usr-globex-gina");
    const rest: [string, string, any?][] = [
      ["POST", `/invoices/${inv}/pay`], ["POST", `/invoices/${inv}/match`], ["POST", `/invoices/${inv}/hold`, { reason: "x" }],
      ["POST", `/invoices/${inv}/override`, { reason: "x" }], ["POST", `/invoices/${inv}/credit-notes`, { amount: 1, reason: "x" }],
      ["POST", `/invoices/${inv}/resubmit`, { text: "x" }], ["POST", "/refunds", { paymentIntentId: pay, amount: 1 }],
      ["GET", `/payments/${pay}`], ["POST", `/payments/${pay}/retry`, { mode: "same" }], ["POST", `/payments/${pay}/ach-return`],
      ["GET", `/payments/${pay}/mandates`], ["GET", `/payments/${pay}/confidence`], ["GET", `/payments/${pay}/payloads`],
      ["GET", "/settlements/stl-xt"], ["GET", `/cases/${kase.id}/evidence-pack`], ["POST", "/invoices", { poId: po, text: "x" }],
    ];
    for (const [method, url, payload] of rest) {
      const res = await app.inject({ method: method as any, url, headers: { cookie: gina, "idempotency-key": "k" }, payload });
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
    const tools: [string, any][] = [
      ["submit_invoice", { poId: po, text: "x" }], ["match_invoice", { invoiceId: inv }], ["execute_payment", { invoiceId: inv, idempotencyKey: "k" }],
      ["evaluate_policy", { supplierId: sup, category: "components", amount: 1 }],
      ["create_purchase_order", { draft: { supplierId: sup, category: "components", currency: "USD", lines: [{ sku: "a", description: "a", qty: 1, unitPrice: 1 }], justification: "x" } }],
    ];
    for (const [name, args] of tools) {
      const res = await app.inject({ method: "POST", url: "/mcp/call", headers: { cookie: gina }, payload: { name, arguments: args } });
      expect([name, res.statusCode]).toEqual([name, 404]);
    }
    const olivia = await login(app, "usr-op-olivia");
    expect((await app.inject({ method: "GET", url: "/settlements/stl-xt", headers: { cookie: olivia } })).statusCode).toBe(200);
  });
  it("needs a fresh code to pay above the step-up threshold", async () => {
    process.env.STEP_UP_THRESHOLD_USD = "1";
    try {
      const app = await buildApp();
      const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });
      const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {})); await S.matchInvoice(inv.id); const target = inv.id;
      const pat = await login(app, "usr-clerk-pat");
      const rest = await app.inject({ method: "POST", url: `/invoices/${target}/pay`, headers: { cookie: pat, "idempotency-key": "k2" } });
      const mcp = await app.inject({ method: "POST", url: "/mcp/call", headers: { cookie: pat }, payload: { name: "execute_payment", arguments: { invoiceId: target, idempotencyKey: "k3" } } });
      for (const res of [rest, mcp]) { expect(res.statusCode).toBe(403); expect(res.body).toContain("step_up_required"); }
    } finally { delete process.env.STEP_UP_THRESHOLD_USD; }
  });
});
