import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as AP2 from "../src/modules/ap2.js";
import { evaluateMandates } from "../src/modules/policy.js";
import { sql } from "../src/db.js";
import { verifyChain } from "../src/modules/evidence.js";

beforeEach(() => { reset(); S.bootstrap(); });

const lines = [{ sku: "BRG-6204", qty: 10, unitPrice: 5 }];
function pair(o: { amount?: number; maxAmount?: number; expiresAt?: string } = {}) {
  const intent = AP2.signIntent({ poId: "po-t", tenantId: "tnt-acme", principalUserId: "usr-cfo-jane", agentId: "agt-buyer-1", maxAmount: o.maxAmount ?? 60, currency: "USD", supplierId: "sup-1", category: "mro", expiresAt: o.expiresAt ?? new Date(Date.now() + 864e5).toISOString(), constraints: { allowedRails: [], category: "mro" } });
  const amount = o.amount ?? 50;
  const cart = AP2.signCart({ poId: "po-t", tenantId: "tnt-acme", agentId: "agt-buyer-1", intentHash: intent.hash, supplierId: "sup-1", currency: "USD", amount, lines: [{ sku: "BRG-6204", qty: amount / 5, unitPrice: 5 }], railHint: null });
  return { intent, cart, payment: { poId: "po-t", supplierId: "sup-1", currency: "USD", amount, lines: [{ sku: "BRG-6204", qty: amount / 5, unitPrice: 5 }] } };
}

describe("AP2 signed mandates (no model)", () => {
  it("a valid pair passes", () => {
    const p = pair();
    const r = evaluateMandates(p.intent, p.cart, p.payment);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });
  it("a tampered cart fails", () => {
    const p = pair();
    const tampered = { ...p.cart, body: { ...p.cart.body, lines: [{ ...lines[0], qty: 12 }], amount: 60 } };
    const r = evaluateMandates(p.intent, tampered, { ...p.payment, amount: 60, lines: tampered.body.lines });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.rule === "Cart signed by the buyer agent")?.pass).toBe(false);
    expect(r.checks.find((c) => c.rule === "Cart hash intact")?.pass).toBe(false);
  });
  it("a cart over the intent limit fails", () => {
    const p = pair({ amount: 100, maxAmount: 60 });
    const r = evaluateMandates(p.intent, p.cart, p.payment);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cart amount within intent limit/);
  });
  it("an expired intent fails", () => {
    const p = pair({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = evaluateMandates(p.intent, p.cart, p.payment);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Intent not expired/);
  });
  it("a payment that differs from the cart fails", () => {
    const p = pair();
    expect(evaluateMandates(p.intent, p.cart, { ...p.payment, amount: 55 }).reason).toMatch(/Cart hash matches the payment/);
  });
  it("end to end: mandates are stored, chained, and a tampered stored cart blocks the payment", async () => {
    const d = (await S.draftPo("Need 50 sealed 6204 bearings")).value;
    const po = S.createPo(d); S.autoApprove(po); S.receiveGoods(po.id);
    const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {})); S.matchInvoice(inv.id);
    expect(db.evidence.some((e) => e.subjectId === po.id && e.event === "ap2.intent_signed")).toBe(true);
    expect(db.evidence.some((e) => e.subjectId === po.id && e.event === "ap2.cart_signed")).toBe(true);
    const cur = AP2.currentPair(po.id).cart!;
    const body = { ...cur.body, amount: cur.body.amount + 100 };
    sql.prepare("UPDATE purchase_mandates SET body = ? WHERE id = ?").run(JSON.stringify(body), cur.id);
    const { intent } = await S.payInvoice(inv.id, "ap2-k1");
    expect(intent.status).toBe("blocked");
    expect(intent.blockedReason).toMatch(/Mandate check failed/);
    expect(S.mandatesView(intent.id).ok).toBe(false);
    expect(verifyChain(db.evidence).valid).toBe(true);
  });
});
