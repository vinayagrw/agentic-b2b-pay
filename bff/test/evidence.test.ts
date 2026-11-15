import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as C from "../src/cards.js";
import * as AP2 from "../src/modules/ap2.js";
import { buildApp } from "../src/server.js";

const envBefore = process.env.STEP_UP_THRESHOLD_USD;
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); C.setIssuer(null); });
afterEach(() => { if (envBefore === undefined) delete process.env.STEP_UP_THRESHOLD_USD; else process.env.STEP_UP_THRESHOLD_USD = envBefore; });
const pat = () => P.getUser("usr-clerk-pat")!;
/** An approved order paid once with a mandate-bound virtual card, after one declined try. */
async function paidByCard(ask = "Need 50 sealed 6204 bearings", approve: (id: string) => void = (id) => { S.autoApprove(db.pos.find((p) => p.id === id)!); }) {
  const po0 = S.createPo((await S.draftPo(ask)).value); approve(po0.id);
  const po = db.pos.find((p) => p.id === po0.id)!; const sup = db.suppliers.find((s) => s.id === po.supplierId)!;
  const { card } = await C.issueForOrder(pat(), "tnt-acme", null, po.id);
  const o = { source: "simulator" as const, actor: "usr-clerk-pat" };
  C.authorize("tnt-acme", card.id, { merchant: sup.name, amount: card.cartAmount! + 1 }, o);
  C.authorize("tnt-acme", card.id, { merchant: sup.name, amount: card.cartAmount!, supplierId: sup.id }, o);
  return { po, sup, card };
}
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };

describe("dispute evidence record", () => {
  it("keeps both mandates valid for seeded order po-duty-seed-2 paid on the simulated issuer", async () => {
    const po = db.pos.find((p) => p.id === "po-duty-seed-2")!; const sup = db.suppliers.find((s) => s.id === "sup-fabrikam")!;
    const { card } = await C.issueForOrder(pat(), "tnt-acme", null, po.id);
    expect(card.cartAmount).toBe(po.total);
    const r = C.authorize("tnt-acme", card.id, { merchant: sup.name, amount: card.cartAmount!, supplierId: sup.id }, { source: "simulator", actor: "usr-clerk-pat" });
    expect(r.decision.approved).toBe(true);
    const e = S.disputeEvidence("tnt-acme", po.id); const pair = AP2.currentPair(po.id);
    expect(e.mandates.intent).toMatchObject({ kind: "intent", signatureValid: true }); expect(e.mandates.cart).toMatchObject({ kind: "cart", signatureValid: true });
    expect(AP2.verifySigned(pair.intent!)).toBe(true); expect(AP2.verifySigned(pair.cart!)).toBe(true);
    const v = AP2.verifyMandatePair(pair.intent, pair.cart, { poId: po.id, supplierId: sup.id, currency: pair.cart!.body.currency, amount: card.cartAmount!, lines: pair.cart!.body.lines });
    expect(v.ok).toBe(true);
  });

  it("is complete for a mandate-bound card payment", async () => {
    const { po, sup, card } = await paidByCard();
    const e = S.disputeEvidence("tnt-acme", po.id); const pair = AP2.currentPair(po.id);
    expect(e.order).toMatchObject({ id: po.id, supplier: sup.name, total: po.total });
    expect(e.mandates.intent).toMatchObject({ id: pair.intent!.id, kind: "intent", signatureValid: true, signerKind: "user" });
    expect(e.mandates.cart).toMatchObject({ id: pair.cart!.id, kind: "cart", signatureValid: true, signerKind: "agent" });
    expect(e.agent).toMatchObject({ id: po.agentId, kyaStatus: "verified" }); expect(e.agent!.keyFingerprint).toBeTruthy(); expect(e.agent!.authority!.id).toBe(po.mandateId);
    // This small order is allowed by policy, so nobody had to approve it.
    expect(e.approvals).toEqual({ rule: null, needed: false, decisions: [] });
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

  it("shows who approved and when for an order that needed approval", async () => {
    // 21,250 USD is over the step-up line. Lift the line so the card is issued without a checker in this test.
    process.env.STEP_UP_THRESHOLD_USD = "1000000";
    const { po } = await paidByCard("Need 5000 sealed 6204 bearings", (id) => { S.decideApproval(id, true, "usr-controller-sam", "Checked the quote, paid on card 4242 4242 4242 4242 before"); });
    expect(po.total).toBeGreaterThanOrEqual(10000);
    const e = S.disputeEvidence("tnt-acme", po.id);
    expect(e.approvals.needed).toBe(true); expect(e.approvals.rule).toBe("Mid spend");
    const ds = e.approvals.decisions; expect(ds.length).toBeGreaterThan(0);
    const made = po.approval!.levels.flatMap((l) => l.approvals); expect(made.length).toBeGreaterThan(0);
    expect(ds.map((d) => [d.userId, d.at])).toEqual(made.map((a) => [a.userId, a.at]));
    expect(ds[0]).toMatchObject({ userId: "usr-controller-sam", name: P.getUser("usr-controller-sam")!.name, decision: "approved", level: 1, role: "approver" });
    expect(Date.parse(ds[0].at)).not.toBeNaN();
    // A card number typed into the approval comment is masked in the decision and in the timeline.
    expect(ds[0].comment).toBe("Checked the quote, paid on card **** 4242 before");
    const granted = e.timeline.find((t) => t.event === "approval.granted")!;
    expect(granted).toBeTruthy(); expect((granted.detail as any).approver).toBe("usr-controller-sam"); expect(JSON.stringify(granted)).not.toContain("4242 4242");
    const events = e.timeline.map((t) => t.event); expect(events.indexOf("approval.granted")).toBeLessThan(events.indexOf("card.bound_to_order"));
  });

  it("sorts approved and rejected decisions by time, with level and role", async () => {
    const { po } = await paidByCard();
    po.approval = { ...(po.approval as any), ruleName: "Two step", current: 1, levels: [{ role: "approver", count: 1, approvals: [{ userId: "usr-controller-sam", at: "2026-01-02T10:00:00.000Z", comment: "ok" }] }, { role: "client_admin", count: 1, approvals: [] }],
      rejectedBy: { userId: "usr-clerk-pat", at: "2026-01-01T09:00:00.000Z", comment: "no" } } as any;
    const ds = S.disputeEvidence("tnt-acme", po.id).approvals.decisions;
    expect(ds.map((d) => [d.decision, d.level, d.role, d.userId])).toEqual([["rejected", 2, "client_admin", "usr-clerk-pat"], ["approved", 1, "approver", "usr-controller-sam"]]);
    for (const d of ds) expect(d.name).toBeTruthy();
  });

  it("masks a card number inside a longer text, and leaves other numbers alone", async () => {
    const { po, card } = await paidByCard();
    po.justification = "Reorder. Old card was 4000-0566-5566-5556, ref 20261114 and 5555555555554444.";
    P.audit("usr-clerk-pat", "po", po.id, "note.added", { note: "Call 2026-11-14 4242 4242 4242 4242 today", id: "order 1234567890123456 x", ts: "2026-11-14T10:00:00.000Z" });
    const e = S.disputeEvidence("tnt-acme", po.id); const text = JSON.stringify(e);
    expect(e.order.justification).toBe("Reorder. Old card was **** 5556, ref 20261114 and **** 4444.");
    for (const pan of ["4242 4242 4242 4242", "4242424242424242", "4000-0566-5566-5556", "5555555555554444"]) expect(text).not.toContain(pan);
    expect(text).toContain("Call 2026-11-14 **** 4242 today");
    // A long number that fails the card check digit is not a card number, and hashes and dates are untouched.
    expect(text).toContain("order 1234567890123456 x"); expect(text).toContain("2026-11-14T10:00:00.000Z");
    expect(e.payment.cards[0].bindingHash).toBe(card.bindingHash); expect(e.chain.valid).toBe(true);
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

describe("dispute evidence leftovers", () => {
  it("keeps superseded mandates as a history list", async () => {
    const { po } = await paidByCard();
    const old = AP2.currentPair(po.id).cart!;
    const { type, id, createdAt, ...body } = old.body as any; AP2.signCart(body);
    const e = S.disputeEvidence("tnt-acme", po.id);
    expect(e.mandates.cart!.id).not.toBe(old.id);
    expect(e.mandates.history.map((m: any) => m.id)).toContain(old.id);
    expect(e.mandates.history.find((m: any) => m.id === old.id)!.supersededAt).toBeTruthy();
  });

  it("lists paid orders only, per tenant", async () => {
    const { po } = await paidByCard();
    const unpaid = S.createPo((await S.draftPo("Need 50 sealed 6204 bearings")).value);
    const ids = S.evidenceOrders("tnt-acme").map((o) => o.id);
    expect(ids).toContain(po.id); expect(ids).not.toContain(unpaid.id);
    expect(S.evidenceOrders("tnt-acme").find((o) => o.id === po.id)!.method).toBe("card");
    expect(S.evidenceOrders("tnt-globex").map((o) => o.id)).not.toContain(po.id);
    const app = await buildApp();
    const r = await app.inject({ url: "/evidence-orders", headers: { cookie: await login(app, "usr-clerk-pat") } });
    expect(r.statusCode).toBe(200); expect(r.json().map((o: any) => o.id)).toContain(po.id);
  });

  it("copilot tool disputeEvidence sums up a paid order and is tenant scoped", async () => {
    const { po } = await paidByCard();
    const CP = await import("../src/copilot.js");
    const r = CP.runTool({ user: pat(), scope: "tnt-acme", prefix: "/app" }, "disputeEvidence", { poId: po.id });
    expect(r.error).toBeFalsy(); expect(r.rows[0]).toMatchObject({ poId: po.id, method: "card", chainValid: true }); expect(r.summary).toContain(po.id);
    const g = CP.runTool({ user: P.getUser("usr-globex-gina")!, scope: "tnt-globex", prefix: "/app" }, "disputeEvidence", { poId: po.id });
    expect(g.error).toMatch(/not found|permission|not allowed/i); expect(g.rows.length).toBe(0);
  });
});
