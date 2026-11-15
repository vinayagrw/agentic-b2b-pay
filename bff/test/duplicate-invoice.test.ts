import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const po = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });

describe("duplicate invoice check", () => {
  it("rejects the same supplier, number and amount with 409 and the first invoice id", async () => {
    const p = po(); const text = S.invoiceText(p.id, {});
    const first = await S.submitInvoice(p.id, text);
    const n = db.invoices.length;
    await expect(S.submitInvoice(p.id, text)).rejects.toMatchObject({ status: 409, extra: { duplicateOf: first.id } });
    expect(db.invoices.length).toBe(n);
  });
  it("normalizes case and spaces in the invoice number", async () => {
    const p = po(); const text = S.invoiceText(p.id, {});
    const first = await S.submitInvoice(p.id, text);
    const n = first.number; const other = (n.slice(0, 2).toLowerCase() + "  " + n.slice(2));
    await expect(S.submitInvoice(p.id, text.split(n).join(other))).rejects.toMatchObject({ status: 409 });
  });
  it("REST returns 409 with duplicateOf", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const p = po(); const text = S.invoiceText(p.id, {});
    const a = await app.inject({ method: "POST", url: "/invoices", headers: { cookie: pat }, payload: { poId: p.id, text } });
    expect(a.statusCode).toBe(200);
    const b = await app.inject({ method: "POST", url: "/invoices", headers: { cookie: pat }, payload: { poId: p.id, text } });
    expect(b.statusCode).toBe(409); expect(b.json().duplicateOf).toBe(a.json().id); expect(b.json().error).toMatch(/already/);
  });
  it("flags a near duplicate with a different number as a risk signal, not a block", async () => {
    const p = po(); const text = S.invoiceText(p.id, {});
    const first = await S.submitInvoice(p.id, text);
    const second = await S.submitInvoice(p.id, text.split(first.number).join(first.number + "B"));
    expect(second.riskSignals?.[0]).toMatchObject({ code: "near_duplicate", invoiceId: first.id });
    expect(first.riskSignals ?? []).toHaveLength(0);
  });
  it("does not flag the same amount more than 7 days apart", async () => {
    const p = po(); const text = S.invoiceText(p.id, {});
    const first = await S.submitInvoice(p.id, text);
    first.invoiceDate = "2000-01-01";
    const second = await S.submitInvoice(p.id, text.split(first.number).join(first.number + "B"));
    expect(second.riskSignals ?? []).toHaveLength(0);
  });
});
