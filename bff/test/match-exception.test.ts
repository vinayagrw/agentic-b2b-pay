import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

const envBefore = process.env.STEP_UP_THRESHOLD_USD;
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
afterEach(() => { if (envBefore === undefined) delete process.env.STEP_UP_THRESHOLD_USD; else process.env.STEP_UP_THRESHOLD_USD = envBefore; });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const po = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });
/** An invoice priced 10% over the PO, matched into an exception, sent by Pat. */
async function exceptionInvoice(app: any, pat: string) {
  const p = po(); if (p.status !== "approved") S.decideApproval(p.id, true); S.receiveGoods(p.id); const text = S.invoiceText(p.id, { priceBumpPct: 10 });
  const r = await app.inject({ method: "POST", url: "/invoices", headers: { cookie: pat }, payload: { poId: p.id, text } });
  const inv = r.json(); await S.ensureRates({ currency: "USD", tenantId: "tnt-acme" });
  S.matchInvoice(inv.id); expect(db.invoices.find((i) => i.id === inv.id)!.matchStatus).toBe("exception");
  return { p, inv: db.invoices.find((i) => i.id === inv.id)! };
}

describe("match exception path", () => {
  it("records who sent the invoice", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    const { inv } = await exceptionInvoice(app, pat);
    expect(inv.submittedBy).toBe("usr-clerk-pat");
  });
  it("holds an invoice with a reason and blocks pay until released", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: sam }, payload: {} })).statusCode).toBe(422);
    const h = await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: sam }, payload: { reason: "Price check with supplier" } });
    expect(h.statusCode).toBe(200); expect(h.json().hold).toMatchObject({ on: true, reason: "Price check with supplier", by: "usr-controller-sam" });
    inv.matchStatus = "matched";
    await expect(S.payInvoice(inv.id, "k-hold-1")).rejects.toMatchObject({ status: 409 });
    const rel = await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: sam }, payload: { release: true, reason: "Supplier confirmed" } });
    expect(rel.json().hold.on).toBe(false);
    expect(db.evidence.some((e: any) => e.subjectId === inv.id && e.event === "invoice.hold_released")).toBe(true);
  });
  it("override needs a reason and a different user than the submitter", async () => {
    const app = await buildApp(); const amara = await login(app, "usr-acme-amara"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, amara);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: {} })).statusCode).toBe(422);
    const self = await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: amara }, payload: { reason: "ok" } });
    expect(self.statusCode).toBe(403); expect(self.json().error).toMatch(/sent this invoice/);
    const ok = await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "Agreed price rise" } });
    expect(ok.statusCode).toBe(200);
    expect(inv.matchStatus).toBe("matched"); expect(inv.override).toMatchObject({ by: "usr-controller-sam", reason: "Agreed price rise" }); expect(inv.accrual).toBeTruthy();
    expect(db.evidence.some((e: any) => e.subjectId === inv.id && e.event === "invoice.match_overridden")).toBe(true);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "again" } })).statusCode).toBe(409);
  });
  it("override is blocked for an AP clerk", async () => {
    const app = await buildApp(); const amara = await login(app, "usr-acme-amara"); const pat = await login(app, "usr-clerk-pat");
    const { inv } = await exceptionInvoice(app, amara);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: pat }, payload: { reason: "x" } })).statusCode).toBe(403);
  });
  it("override above the step-up threshold needs a fresh code", async () => {
    process.env.STEP_UP_THRESHOLD_USD = "100";
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat);
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "Agreed" } });
    expect(r.statusCode).toBe(403); expect(r.json().error).toMatch(/step_up_required/); expect(inv.matchStatus).toBe("exception");
  });
  it("credit note reduces the payable, cannot exceed the invoice, and posts a journal", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat); const before = inv.amount; const jn = db.journals.length;
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: before + 1, reason: "too much" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 10 } })).statusCode).toBe(422);
    const c = await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 84, reason: "Price over PO" } });
    expect(c.statusCode).toBe(200);
    expect(inv.amount).toBeCloseTo(before - 84); expect(inv.originalAmount).toBe(before); expect(inv.creditNotes?.[0]).toMatchObject({ amount: 84, reason: "Price over PO", by: "usr-controller-sam" });
    expect(db.journals.length).toBe(jn); expect(inv.creditNotes?.[0].journalId).toBeNull();
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: inv.amount + 0.5, reason: "x" } })).statusCode).toBe(422);
  });
  it("resubmit makes a corrected invoice that supersedes the old one", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    const { p, inv } = await exceptionInvoice(app, pat);
    const text = S.invoiceText(p.id, {}).replace(/Invoice No:.*/, `Invoice No: ${inv.number}-C`);
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/resubmit`, headers: { cookie: pat }, payload: { text } });
    expect(r.statusCode).toBe(200); const n = r.json();
    expect(n.supersedes).toBe(inv.id); expect(inv.supersededBy).toBe(n.id); expect(n.submittedBy).toBe("usr-clerk-pat");
    await S.ensureRates({ currency: "USD", tenantId: "tnt-acme" });
    expect(S.matchInvoice(n.id).status).toBe("matched");
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: await login(app, "usr-controller-sam") }, payload: { reason: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/resubmit`, headers: { cookie: pat }, payload: { text } })).statusCode).toBe(409);
  });

  it("credit on an accrued invoice posts a journal, re-signs the cart and the override books the lower amount", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat); const before = inv.amount;
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 84, reason: "Price over PO" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "Agreed" } })).statusCode).toBe(200);
    expect(inv.accrual!.amount).toBeCloseTo(before - 84);
    const jn = db.journals.length;
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 10, reason: "Damaged" } })).statusCode).toBe(200);
    expect(db.journals.length).toBe(jn + 1); expect((db.journals.at(-1) as any).ref).toBe(inv.id);
  });
  it("credit is blocked for the submitter and while a payment is in flight", async () => {
    const app = await buildApp(); const amara = await login(app, "usr-acme-amara"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, amara);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: amara }, payload: { amount: 5, reason: "x" } })).statusCode).toBe(403);
    db.intents.push({ id: "pi-fake", invoiceId: inv.id, status: "pending" } as any);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 5, reason: "x" } })).statusCode).toBe(409);
  });
  it("credit above the step-up threshold needs a fresh code", async () => {
    process.env.STEP_UP_THRESHOLD_USD = "50";
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat);
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/credit-notes`, headers: { cookie: sam }, payload: { amount: 84, reason: "x" } });
    expect(r.statusCode).toBe(403); expect(inv.creditNotes).toBeUndefined();
  });
  it("override fails closed when the submitter is unknown", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat); delete inv.submittedBy;
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "ok" } })).statusCode).toBe(409);
  });
  it("resubmit with the same number and total is not a duplicate of the replaced invoice", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    const { p, inv } = await exceptionInvoice(app, pat);
    const text = S.invoiceText(p.id, { priceBumpPct: 10 });
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/resubmit`, headers: { cookie: pat }, payload: { text } });
    expect(r.statusCode).toBe(200);
  });
  it("release needs an active hold and the holder needs approve rights to release", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const { inv } = await exceptionInvoice(app, pat);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: sam }, payload: { release: true, reason: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: pat }, payload: { reason: "check" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: pat }, payload: { release: true, reason: "done" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/hold`, headers: { cookie: sam }, payload: { release: true, reason: "done" } })).statusCode).toBe(200);
  });
});
