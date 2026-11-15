import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as AP2 from "../src/modules/ap2.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });

async function matchedInvoice() {
  const p = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });
  if (p.status !== "approved") S.decideApproval(p.id, true); S.receiveGoods(p.id);
  const inv = await S.submitInvoice(p.id, S.invoiceText(p.id, {}), { submittedBy: "usr-clerk-pat" });
  await S.ensureRates({ currency: "USD", tenantId: "tnt-acme" });
  S.matchInvoice(inv.id);
  return db.invoices.find((i) => i.id === inv.id)!;
}
const cartLinesAddUp = (poId: string) => { const c = AP2.currentPair(poId).cart!.body; return Math.abs(c.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) - c.amount) <= 0.01; };

describe("credit note keeps the signed cart consistent", () => {
  it("after a credit note on a matched invoice, the new cart lines still add up to the amount", async () => {
    const inv = await matchedInvoice(); expect(inv.matchStatus).toBe("matched");
    S.creditNote(inv.id, "usr-controller-sam", 1.5, "Two units damaged");
    expect(inv.amount).toBeCloseTo(838.5);
    expect(cartLinesAddUp(inv.poId)).toBe(true);
    const r = await S.payInvoice(inv.id, "k-credit-pay-1");
    expect(r.intent.blockedReason ?? "").not.toMatch(/Cart lines add up|Cart hash matches/);
  });
});

describe("attempt history", () => {
  it("lists a retry that was blocked before it got a rail", async () => {
    const inv = await matchedInvoice();
    const first = await S.payInvoice(inv.id, "k-att-1"); const pi = first.intent;
    pi.status = "failed"; pi.blockedReason = "sandbox decline";
    db.killSwitch = true;
    const r = await S.retryPayment(pi.id, "same", "k-att-retry").catch((e) => e);
    db.killSwitch = false;
    const retry = db.intents.find((i) => i.retryOf === pi.id);
    expect(retry, String(r?.message ?? "")).toBeTruthy();
    expect(S.paymentAttempts(pi.id).map((a) => a.id)).toContain(retry!.id);
  });
});

describe("a replaced invoice is no longer open", () => {
  it("drops out of early-pay rows and the treasury open count", async () => {
    const TM = await import("../src/terms.js"); const OPS = await import("../src/ops.js");
    const p = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });
    if (p.status !== "approved") S.decideApproval(p.id, true); S.receiveGoods(p.id);
    const old = await S.submitInvoice(p.id, S.invoiceText(p.id, { priceBumpPct: 10 }), { submittedBy: "usr-clerk-pat" });
    await S.ensureRates({ currency: "USD", tenantId: "tnt-acme" }); S.matchInvoice(old.id);
    const t0 = await OPS.treasury("tnt-acme");
    const fresh = await S.resubmitInvoice(old.id, S.invoiceText(p.id, {}), "usr-clerk-pat");
    expect(db.invoices.find((i) => i.id === old.id)!.supersededBy).toBe(fresh.id);
    expect(TM.discountRows("tnt-acme").map((r: any) => r.invoiceId)).not.toContain(old.id);
    const t1 = await OPS.treasury("tnt-acme");
    expect(t1.openInvoices).toBe(t0.openInvoices); // old one leaves, new one arrives
  });
});
