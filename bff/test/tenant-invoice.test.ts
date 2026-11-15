import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); expect(r.statusCode).toBe(200); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const acmePo = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });

describe("cross-tenant invoice submit and match", () => {
  it("REST submit and match return 404 for another tenant's PO", async () => {
    const app = await buildApp(); const gina = await login(app, "usr-globex-gina"); const po = acmePo();
    const text = S.invoiceText(po.id, {});
    expect((await app.inject({ method: "POST", url: "/invoices", headers: { cookie: gina }, payload: { poId: po.id, text } })).statusCode).toBe(404);
    const inv = await S.submitInvoice(po.id, text);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/match`, headers: { cookie: gina } })).statusCode).toBe(404);
    const pat = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "POST", url: "/invoices", headers: { cookie: pat }, payload: { poId: po.id, text } })).statusCode).toBe(200);
  });
  it("MCP submit_invoice and match_invoice return 404 for another tenant's PO", async () => {
    const app = await buildApp(); const gina = await login(app, "usr-globex-gina"); const po = acmePo();
    const text = S.invoiceText(po.id, {});
    expect((await app.inject({ method: "POST", url: "/mcp/call", headers: { cookie: gina }, payload: { name: "submit_invoice", arguments: { poId: po.id, text } } })).statusCode).toBe(404);
    const inv = await S.submitInvoice(po.id, text);
    expect((await app.inject({ method: "POST", url: "/mcp/call", headers: { cookie: gina }, payload: { name: "match_invoice", arguments: { invoiceId: inv.id } } })).statusCode).toBe(404);
    const pat = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "POST", url: "/mcp/call", headers: { cookie: pat }, payload: { name: "submit_invoice", arguments: { poId: po.id, text } } })).statusCode).toBe(200);
  });
});
