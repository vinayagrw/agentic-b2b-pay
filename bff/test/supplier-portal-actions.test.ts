import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db, tenantOf } from "../src/modules/store.js";
import { installFakes } from "./fakeRail.js";
import * as S from "../src/service.js";
import * as SP from "../src/sparky.js";
import * as P from "../src/platform.js";
import * as NT from "../src/notices.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); installFakes(); P.seedPlatform(); S.bootstrap(); SP.resetMcpRate(); SP.resetPortalRate(); });
afterEach(() => { delete process.env.SUPPLIER_PORTAL_RATE_MAX; });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const linkFor = async (app: any, cookie: string, supplierId: string) => (await app.inject({ method: "POST", url: `/workspace/suppliers/${supplierId}/portal-link`, headers: { cookie } })).json().token as string;

describe("supplier portal actions", () => {
  it("submits an invoice against its own open order, with the duplicate check, and queues a buyer notice", async () => {
    const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 1, unitPrice: 420 }], justification: "Spare" });
    const other = db.pos.find((p) => p.supplierId !== "sup-northwind");
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const token = await linkFor(app, jane, "sup-northwind");
    const v = (await app.inject({ url: `/supplier-portal/${token}` })).json();
    expect(v.openOrders.map((o: any) => o.poId)).toContain(po.id);
    const text = S.invoiceText(po.id, {});
    const r = await app.inject({ method: "POST", url: `/supplier-portal/${token}/invoices`, payload: { poId: po.id, text } });
    expect(r.statusCode).toBe(200); const inv = db.invoices.find((i) => i.id === r.json().invoiceId)!;
    expect(inv.supplierId).toBe("sup-northwind"); expect((inv as any).submittedBy).toBe("supplier-portal:sup-northwind");
    expect((await app.inject({ method: "POST", url: `/supplier-portal/${token}/invoices`, payload: { poId: po.id, text } })).statusCode).toBe(409);
    if (other) expect((await app.inject({ method: "POST", url: `/supplier-portal/${token}/invoices`, payload: { poId: other.id, text } })).statusCode).toBe(404);
    expect(NT.listNotices(tenantOf(po)).some((n) => n.kind === "invoice_received" && n.refId === inv.id && n.mode === "mock")).toBe(true);
    const out = (await app.inject({ url: "/notices/outbox", headers: { cookie: jane } })).json();
    expect(out.mode).toBe("mock"); expect(out.notices.length).toBeGreaterThan(0);
    const gina = await login(app, "usr-globex-gina");
    expect((await app.inject({ url: "/notices/outbox", headers: { cookie: gina } })).json().notices.some((n: any) => n.refId === inv.id)).toBe(false);
  });

  it("raises a dispute the buyer sees, and gives remittance advice for paid payments only", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const paid = db.intents.find((p) => p.id === r.intentId)!; expect(paid.status).toBe("settled"); expect(paid).toBeTruthy();
    const inv = db.invoices.find((i) => i.id === paid.invoiceId)!; const t = tenantOf(inv);
    expect(NT.listNotices(t).some((n) => n.kind === "payment_sent" && n.refId === paid.id && n.audience === "supplier")).toBe(true);
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const token = await linkFor(app, jane, inv.supplierId);
    const csv = await app.inject({ url: `/supplier-portal/${token}/payments/${paid.id}/remittance.csv` });
    expect(csv.statusCode).toBe(200); expect(csv.headers["content-type"]).toMatch(/text\/csv/); expect(csv.body).toContain(inv.number); expect(csv.body.split("\n")[0]).toContain("paymentId");
    const html = await app.inject({ url: `/supplier-portal/${token}/payments/${paid.id}/remittance.html` });
    expect(html.statusCode).toBe(200); expect(html.body).toContain("Remittance advice"); expect(html.body).toContain(paid.id);
    expect((await app.inject({ method: "POST", url: `/supplier-portal/${token}/payments/${paid.id}/dispute`, payload: { reason: "no" } })).statusCode).toBe(422);
    const d = await app.inject({ method: "POST", url: `/supplier-portal/${token}/payments/${paid.id}/dispute`, payload: { reason: "Short paid by 20 dollars" } });
    expect(d.statusCode).toBe(200);
    const c = S.listCases(t).find((x) => x.id === d.json().caseId)!; expect(c.kind).toBe("dispute"); expect(c.intentId).toBe(paid.id);
    expect((await app.inject({ method: "POST", url: `/supplier-portal/${token}/payments/${paid.id}/dispute`, payload: { reason: "Short paid by 20 dollars" } })).statusCode).toBe(409);
    expect(NT.listNotices(t).some((n) => n.kind === "dispute_opened" && n.refId === c.id)).toBe(true);
    // Another supplier's token cannot touch this payment.
    const otherSup = db.suppliers.find((s) => s.id !== inv.supplierId && (s.tenantId ?? "tnt-acme") === t)!;
    const t2 = await linkFor(app, jane, otherSup.id);
    expect((await app.inject({ url: `/supplier-portal/${t2}/payments/${paid.id}/remittance.csv` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/supplier-portal/${t2}/payments/${paid.id}/dispute`, payload: { reason: "Not mine at all" } })).statusCode).toBe(404);
  });

  it("rate limits the token routes", async () => {
    process.env.SUPPLIER_PORTAL_RATE_MAX = "3";
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const token = await linkFor(app, jane, "sup-northwind");
    const codes = []; for (let i = 0; i < 5; i++) codes.push((await app.inject({ url: `/supplier-portal/${token}` })).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]); expect(codes[4]).toBe(429);
  });

  it("does not keep rate keys for unknown tokens and sweeps empty windows", async () => {
    SP.resetPortalRate(); const app = await buildApp();
    for (let i = 0; i < 20; i++) await app.inject({ url: `/supplier-portal/junk${i}`, remoteAddress: "10.0.0.9" });
    expect(SP.portalRateSize()).toBe(1);
    SP.sweepPortalRate(Date.now() + 61_000); expect(SP.portalRateSize()).toBe(0);
  });

  it("shows the paid amount in the paid currency and the invoice amount in the invoice currency", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const paid = db.intents.find((p) => p.id === r.intentId)!; const inv = db.invoices.find((i) => i.id === paid.invoiceId)!;
    const n = NT.listNotices(tenantOf(inv)).find((x) => x.kind === "payment_sent" && x.refId === paid.id)!;
    expect(n.body).toContain(`${paid.amount.toFixed(2)} USD`); expect(n.body).toContain(`${inv.amount.toFixed(2)} ${inv.currency ?? "USD"}`);
    (inv as any).currency = "EUR";
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const token = await linkFor(app, jane, inv.supplierId);
    const [head, row] = (await app.inject({ url: `/supplier-portal/${token}/payments/${paid.id}/remittance.csv` })).body.split("\n").map((l) => l.split(","));
    const v = (k: string) => row[head.indexOf(k)];
    expect(v("currency")).toBe("USD"); expect(v("invoiceCurrency")).toBe("EUR"); expect(v("invoiceAmount")).toBe(inv.amount.toFixed(2));
  });
});
