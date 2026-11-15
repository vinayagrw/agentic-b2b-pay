import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as C from "../src/cards.js";
import * as AP2 from "../src/modules/ap2.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); C.setIssuer(null); });
const pat = () => P.getUser("usr-clerk-pat")!;
/** An approved order paid once with a mandate-bound virtual card, after one declined try. */
async function paidByCard() {
  const po0 = S.createPo((await S.draftPo("Need 50 sealed 6204 bearings")).value); S.autoApprove(po0);
  const po = db.pos.find((p) => p.id === po0.id)!; const sup = db.suppliers.find((s) => s.id === po.supplierId)!;
  const { card } = await C.issueForOrder(pat(), "tnt-acme", null, po.id);
  const o = { source: "simulator" as const, actor: "usr-clerk-pat" };
  C.authorize("tnt-acme", card.id, { merchant: sup.name, amount: card.cartAmount! + 1 }, o);
  C.authorize("tnt-acme", card.id, { merchant: sup.name, amount: card.cartAmount!, supplierId: sup.id }, o);
  return { po, sup, card };
}
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };

describe("dispute evidence record", () => {
  it("is complete for a mandate-bound card payment", async () => {
    const { po, sup, card } = await paidByCard();
    const e = S.disputeEvidence("tnt-acme", po.id); const pair = AP2.currentPair(po.id);
    expect(e.order).toMatchObject({ id: po.id, supplier: sup.name, total: po.total });
    expect(e.mandates.intent).toMatchObject({ id: pair.intent!.id, kind: "intent", signatureValid: true, signerKind: "user" });
    expect(e.mandates.cart).toMatchObject({ id: pair.cart!.id, kind: "cart", signatureValid: true, signerKind: "agent" });
    expect(e.agent).toMatchObject({ id: po.agentId, kyaStatus: "verified" }); expect(e.agent!.keyFingerprint).toBeTruthy(); expect(e.agent!.authority!.id).toBe(po.mandateId);
    // Who approved and when, taken from the order itself.
    const made = (po.approval?.levels ?? []).flatMap((l) => l.approvals);
    expect(e.approvals.decisions.map((d) => [d.userId, d.at])).toEqual(made.map((a) => [a.userId, a.at]));
    for (const d of e.approvals.decisions) { expect(d.name).toBeTruthy(); expect(d.decision).toBe("approved"); }
    // The card, its live issuer label and both decisions with reasons.
    expect(e.payment.method).toBe("card"); expect(e.payment.cards).toHaveLength(1);
    const c = e.payment.cards[0];
    expect(c).toMatchObject({ id: card.id, kind: "Mandate-bound virtual card", issuerLabel: "Simulated issuer", bindingHash: AP2.cartBindingHash(pair.cart!.body) }); expect(c.last4).toMatch(/^\d{4}$/);
    expect(c.authorizations.map((a) => a.decision)).toEqual(["declined", "approved"]);
    expect(c.authorizations[0].reason).toMatch(/Declined/); expect(c.authorizations[1].reason).toMatch(/Approved/);
    // Audit events in time order, from the signed mandates to the paid order.
    const seqs = e.timeline.map((t) => t.seq); expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const events = e.timeline.map((t) => t.event);
    for (const want of ["policy.evaluated", "ap2.intent_signed", "ap2.cart_signed", "card.bound_to_order", "card.authorization_declined", "card.authorization_approved", "order.paid_by_card"]) expect(events).toContain(want);
    expect(events.indexOf("ap2.intent_signed")).toBeLessThan(events.indexOf("card.bound_to_order")); expect(events.indexOf("card.bound_to_order")).toBeLessThan(events.indexOf("order.paid_by_card"));
    expect(e.timeline.find((t) => t.event === "order.paid_by_card")!.actor).toBe("usr-clerk-pat");
    expect(e.chain.valid).toBe(true);
  });

  it("never carries a card number beyond the last 4, or the wrong card words", async () => {
    const { po } = await paidByCard();
    P.audit("usr-clerk-pat", "po", po.id, "note.added", { pan: "4242 4242 4242 4242", raw: "4000056655665556" });
    const text = JSON.stringify(S.disputeEvidence("tnt-acme", po.id));
expect(text).not.toContain("4242 4242 4242 4242"); expect(text).not.toContain("4000056655665556");
    expect(text).toContain("**** 4242"); expect(text).not.toMatch(/"cvc"|"number"/i); expect(text).not.toMatch(/one-use token|network token/i);
  });

  it("only exists for a paid order", async () => {
    const po = S.createPo((await S.draftPo("Need 50 sealed 6204 bearings")).value); S.autoApprove(po);
    expect(() => S.disputeEvidence("tnt-acme", po.id)).toThrow(/not paid yet/);
    expect(() => S.disputeEvidence("tnt-acme", "po-nope")).toThrow(/not found/);
  });

  it("keeps tenants apart", async () => {
    const { po } = await paidByCard();
    expect(() => S.disputeEvidence("tnt-globex", po.id)).toThrow(/not found/);
    const app = await buildApp();
    const mine = await app.inject({ url: `/orders/${po.id}/evidence`, headers: { cookie: await login(app, "usr-clerk-pat") } });
    expect(mine.statusCode).toBe(200); expect(mine.json().order.id).toBe(po.id); expect(mine.json().tenantId).toBe("tnt-acme");
    const theirs = await app.inject({ url: `/orders/${po.id}/evidence`, headers: { cookie: await login(app, "usr-globex-gina") } });
    expect(theirs.statusCode).toBe(404); expect(theirs.body).not.toContain(po.supplierId);
    const anon = await app.inject({ url: `/orders/${po.id}/evidence` }); expect(anon.statusCode).toBe(401);
    // Events of another tenant's order never leak into this record.
    P.audit("usr-globex-gina", "po", "po-globex-x", "note.added", { secret: "globex only" });
    expect(JSON.stringify(S.disputeEvidence("tnt-acme", po.id))).not.toContain("globex only");
  });
});
