import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as C from "../src/cards.js";
import * as CP from "../src/copilot.js";
import * as FV from "../src/flowview.js";
import * as O from "../src/ops.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";
import * as AP2 from "../src/modules/ap2.js";
import { sql } from "../src/db.js";
import Stripe from "stripe";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); C.setIssuer(null); });
const pat = () => P.getUser("usr-clerk-pat")!;
const issue = (x: any) => C.issueCard(pat(), "tnt-acme", null, { label: "Test card", currency: "USD", ...x }).then((r) => r.card);
const auth = (id: string, merchant: string, amount: number, extra: Partial<C.AuthRequest> = {}, at?: number) => C.authorize("tnt-acme", id, { merchant, amount, ...extra }, { source: "simulator", actor: "usr-clerk-pat", at });

describe("virtual cards", () => {
  it("uses the simulated issuer in tests and shows last4 only", async () => {
    expect((await C.issuerInfo()).label).toBe("Simulated issuer");
    const c = await issue({ type: "recurring", limit: 500 });
    expect(c.status).toBe("active"); expect(c.last4).toMatch(/^\d{4}$/); expect(c.issuerLabel).toBe("Simulated issuer");
  });

  it("gives each decline reason in plain words", async () => {
    const c = await issue({ type: "recurring", limit: 100, mcc: "5085" });
    expect(auth(c.id, "Grainger", 150, { mcc: "5085" }).decision.code).toBe("over_limit");
    expect(auth(c.id, "Grainger", 10, { mcc: "5999" }).decision.code).toBe("wrong_merchant");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085", currency: "EUR" }).decision.code).toBe("wrong_currency");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }, Date.now() + 6 * 365 * 864e5).decision.code).toBe("expired");
    await C.setState(pat(), "tnt-acme", c.id, "freeze");
    const fz = auth(c.id, "Grainger", 10, { mcc: "5085" }); expect(fz.decision.code).toBe("frozen"); expect(fz.decision.reason).toMatch(/frozen/);
    await C.setState(pat(), "tnt-acme", c.id, "unfreeze");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }).decision.approved).toBe(true);
    await C.setState(pat(), "tnt-acme", c.id, "cancel");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }).decision.code).toBe("canceled");
  });

  it("closes a one-time card after the first charge", async () => {
    const c = await issue({ type: "one_time", limit: 300 });
    expect(auth(c.id, "Any shop", 120).decision.approved).toBe(true);
    expect(C.cardDetail("tnt-acme", c.id).card.status).toBe("closed");
    const again = auth(c.id, "Any shop", 10); expect(again.decision.code).toBe("already_used");
  });

  it("locks a vendor card to one supplier", async () => {
    await expect(issue({ type: "vendor_locked", limit: 1000 })).rejects.toThrow(/exactly one/);
    const c = await issue({ type: "vendor_locked", limit: 1000, supplierId: "sup-northwind" });
    expect(auth(c.id, "Northwind Components LLC", 200).decision.approved).toBe(true);
    expect(auth(c.id, "Contoso Logistics Ltd", 200).decision.code).toBe("wrong_merchant");
  });

  it("scopes an agent card to the mandate limit and allowed suppliers", async () => {
    await expect(issue({ type: "agent", agentId: "agt-buyer-1", limit: 90000 })).rejects.toThrow(/monthly limit/);
    const c = await issue({ type: "agent", agentId: "agt-buyer-1", limit: 5000 });
    expect(c.ownerType).toBe("agent"); expect(c.allowedMerchants).toContain("Contoso Logistics Ltd");
    expect(auth(c.id, "Contoso Logistics Ltd", 3000).decision.approved).toBe(true);
    expect(auth(c.id, "Contoso Logistics Ltd", 3000).decision.code).toBe("over_limit");
    expect(auth(c.id, "Random Store", 10).decision.code).toBe("wrong_merchant");
    db.agents.find((a) => a.id === "agt-buyer-1")!.status = "suspended";
    expect(auth(c.id, "Contoso Logistics Ltd", 10).decision.code).toBe("agent_paused");
  });

  it("needs maker-checker and step-up for a large card", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const sam = await login("usr-controller-sam"); const lee = await login("usr-treasurer-lee");
    const body = { type: "recurring", label: "Big card", limit: 20000, currency: "USD" };
    const no = await app.inject({ method: "POST", url: "/cards", headers: { cookie: sam }, payload: body });
    expect(no.statusCode).toBe(403); expect(no.json().error).toMatch(/step_up_required/);
    await stepUp(app, sam);
    const req = await app.inject({ method: "POST", url: "/cards", headers: { cookie: sam }, payload: body });
    expect(req.statusCode).toBe(200); expect(req.json().needsApproval).toBe(true); const id = req.json().card.id;
    expect(C.decide(C.getCard("tnt-acme", id), { merchant: "x", amount: 1 }).code).toBe("not_issued");
    const self = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: sam }, payload: { approve: true } });
    expect(self.statusCode).toBe(403); expect(self.json().error).toMatch(/cannot approve/);
    const noCode = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: lee }, payload: { approve: true } });
    expect(noCode.statusCode).toBe(403); expect(noCode.json().error).toMatch(/step_up_required/);
    await stepUp(app, lee);
    const ok = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: lee }, payload: { approve: true } });
    expect(ok.statusCode).toBe(200); expect(ok.json().status).toBe("active"); expect(ok.json().approvedBy).toBe("usr-treasurer-lee");
    const ev = db.evidence.filter((e) => e.subjectId === id).map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(["card.requested", "card.approved", "card.issued"]));
  });

  it("keeps cards inside their tenant and never returns a card number", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const patC = await login("usr-clerk-pat"); const gina = await login("usr-globex-gina");
    const made = await app.inject({ method: "POST", url: "/cards", headers: { cookie: patC }, payload: { type: "one_time", label: "Lunch", limit: 50 } });
    expect(made.statusCode).toBe(200); const id = made.json().card.id;
    expect((await app.inject({ url: "/cards", headers: { cookie: gina } })).json().cards).toEqual([]);
    expect((await app.inject({ url: `/cards/${id}`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/cards/${id}/freeze`, headers: { cookie: gina } })).statusCode).toBe(404);
    const sim = await app.inject({ method: "POST", url: `/cards/${id}/simulate`, headers: { cookie: patC }, payload: { merchant: "Cafe", amount: 20 } });
    expect(sim.json().decision.approved).toBe(true);
    const rv = await app.inject({ method: "POST", url: `/cards/${id}/reveal`, headers: { cookie: patC } });
    expect(rv.statusCode).toBe(403);
    const all = [made.body, sim.body, (await app.inject({ url: "/cards", headers: { cookie: patC } })).body, (await app.inject({ url: `/cards/${id}`, headers: { cookie: patC } })).body];
    for (const txt of all) { expect(txt).not.toMatch(/\b\d{13,19}\b/); expect(txt).not.toMatch(/"(number|pan|cvc|cvv)"\s*:\s*"\d/i); }
    await stepUp(app, patC);
    const rv2 = await app.inject({ method: "POST", url: `/cards/${id}/reveal`, headers: { cookie: patC } });
    expect(rv2.json().mocked).toBe(true); expect(rv2.body).not.toMatch(/\d{13,19}/); expect(rv2.json().cvc).toBe("•••");
  });

  it("feeds transactions, reconciliation and the copilot", async () => {
    const c = await issue({ type: "recurring", limit: 400 });
    auth(c.id, "Office Depot", 80); auth(c.id, "Office Depot", 900);
    const tx = FV.transactions("tnt-acme").rows.filter((r) => r.rail === "card_issuing");
    expect(tx.map((r) => r.status).sort()).toEqual(["denied", "settled"]);
    expect(FV.transactions("tnt-globex").rows.some((r) => r.rail === "card_issuing")).toBe(false);
    const rec = O.runRecon("tnt-acme").rows.filter((r) => r.rail === "card_issuing");
    expect(rec).toHaveLength(1); expect(rec[0].status).toBe("matched");
    const t = CP.runTool({ user: P.getUser("usr-cfo-jane")!, scope: "tnt-acme", prefix: "/app" }, "cardSpend");
    expect(t.rows).toHaveLength(1); expect((t.rows[0] as any).spent).toBe(80);
    expect(CP.mockPlan("how much have we spent on cards").map((p) => p.name)).toContain("cardSpend");
  });
});

describe("mandate-bound virtual card", () => {
  /** An approved order with signed AP2 mandates, small enough to skip maker-checker. */
  const order = async () => { const po = S.createPo((await S.draftPo("Need 50 sealed 6204 bearings")).value); S.autoApprove(po); return db.pos.find((p) => p.id === po.id)!; };
  const bound = async () => { const po = await order(); const sup = db.suppliers.find((s) => s.id === po.supplierId)!; const r = await C.issueForOrder(pat(), "tnt-acme", null, po.id); return { po, sup, card: r.card }; };

  const holdOn = (supplierId: string) => sql.prepare("INSERT INTO bank_change_requests (id, tenant_id, supplier_id, kind, status, new_enc, old_masked, new_masked, account_hash, channel, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`bcr-t-${supplierId}`, "tnt-acme", supplierId, "bank", "pending", "x", "{}", "{}", "h", "portal", "usr-clerk-pat", new Date().toISOString());

  it("refuses to issue and declines charges while a bank change hold is on the supplier", async () => {
    const po = await order(); holdOn(po.supplierId);
    await expect(C.issueForOrder(pat(), "tnt-acme", null, po.id)).rejects.toThrow(/Payment held/);
    sql.prepare("DELETE FROM bank_change_requests").run();
    const { po: po2, sup, card } = await bound(); expect(po2).toBeTruthy(); holdOn(sup.id);
    const d = auth(card.id, sup.name, card.cartAmount!); expect(d.decision.approved).toBe(false); expect(d.decision.code).toBe("bank_change_hold"); expect(d.card.status).toBe("active");
  });

  it("matches the merchant by id when known and falls back to the name", async () => {
    const po = await order(); const sup = db.suppliers.find((s) => s.id === po.supplierId)!; sup.cardMerchantId = "mid-777";
    const card = (await C.issueForOrder(pat(), "tnt-acme", null, po.id)).card; expect(card.merchantId).toBe("mid-777");
    expect(auth(card.id, sup.name, card.cartAmount!, { merchantId: "mid-999" }).decision.code).toBe("wrong_merchant");
    expect(auth(card.id, "Some Other Name", card.cartAmount!, { merchantId: "mid-777" }).decision.approved).toBe(true);
    const po2 = await order(); delete sup.cardMerchantId; const c2 = (await C.issueForOrder(pat(), "tnt-acme", null, po2.id)).card; expect(c2.merchantId).toBeNull();
    expect(auth(c2.id, "Some Other Name", c2.cartAmount!, { merchantId: "mid-777" }).decision.code).toBe("wrong_merchant");
    expect(auth(c2.id, sup.name, c2.cartAmount!, { merchantId: "mid-777" }).decision.approved).toBe(true);
  });

  it("the Stripe webhook declines a charge whose merchant id does not match", async () => {
    const po = await order(); const sup = db.suppliers.find((s) => s.id === po.supplierId)!; sup.cardMerchantId = "mid-777";
    const card = (await C.issueForOrder(pat(), "tnt-acme", null, po.id)).card; sql.prepare("UPDATE cards SET provider_ref = ? WHERE id = ?").run("ic_test_1", card.id);
    const keep = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET }; process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    try {
      const send = (id: string, network_id: string) => { const body = JSON.stringify({ id: `evt_${id}`, object: "event", livemode: false, type: "issuing_authorization.request", data: { object: { id, card: "ic_test_1", amount: Math.round(card.cartAmount! * 100), currency: card.currency.toLowerCase(), merchant_data: { name: sup.name, network_id } } } });
        return C.stripeWebhook(body, { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_test" }) }); };
      expect(send("iauth_a", "mid-999").approved).toBe(false);
      expect(send("iauth_b", "mid-777").approved).toBe(true);
    } finally { process.env.STRIPE_SECRET_KEY = keep.k ?? ""; process.env.STRIPE_WEBHOOK_SECRET = keep.w ?? ""; if (!keep.k) delete process.env.STRIPE_SECRET_KEY; if (!keep.w) delete process.env.STRIPE_WEBHOOK_SECRET; }
  });

  it("stores the cart binding hash and exact amount, and approves one exact charge", async () => {
    const { po, sup, card } = await bound(); const cart = AP2.currentPair(po.id).cart!;
    expect(card.status).toBe("active"); expect(card.typeText).toBe("Mandate-bound"); expect(card.issuerLabel).toBe("Simulated issuer");
    expect(card.bindingHash).toBe(AP2.cartBindingHash(cart.body)); expect(card.cartAmount).toBe(cart.body.amount); expect(card.limit).toBe(cart.body.amount); expect(card.cartMandateId).toBe(cart.id);
    const d = C.cardDetail("tnt-acme", card.id); expect(d.order?.poId).toBe(po.id); expect(d.order?.mandate.ok).toBe(true);
    const ok = auth(card.id, sup.name, card.cartAmount!, { supplierId: sup.id }); expect(ok.decision.approved).toBe(true); expect(ok.card.status).toBe("closed");
    const again = auth(card.id, sup.name, card.cartAmount!); expect(again.decision.code).toBe("already_used"); expect(again.decision.reason).toMatch(/already used/);
    expect(db.evidence.some((e) => e.subjectId === card.id && e.event === "card.bound_to_order")).toBe(true);
    await expect(C.issueForOrder(pat(), "tnt-acme", null, po.id)).rejects.toThrow(/already has/);
  });

  it("declines a wrong amount, above or below the cart", async () => {
    const { sup, card } = await bound();
    for (const a of [card.cartAmount! - 1, card.cartAmount! + 0.01, 1]) { const r = auth(card.id, sup.name, a); expect(r.decision.approved).toBe(false); expect(["wrong_amount", "over_limit"]).toContain(r.decision.code); }
    const low = auth(card.id, sup.name, card.cartAmount! - 1); expect(low.decision.code).toBe("wrong_amount"); expect(low.decision.reason).toMatch(/equal the order amount/);
    expect(auth(card.id, sup.name, card.cartAmount! + 5).decision.code).toBe("wrong_amount");
    expect(C.cardDetail("tnt-acme", card.id).card.status).toBe("active");
  });

  it("declines a different supplier", async () => {
    const { sup, card } = await bound(); const other = db.suppliers.find((s) => s.id !== sup.id)!;
    expect(auth(card.id, other.name, card.cartAmount!).decision.code).toBe("wrong_merchant");
    expect(auth(card.id, sup.name, card.cartAmount!, { supplierId: other.id }).decision.code).toBe("wrong_merchant");
  });

  it("declines when the mandate is missing", async () => {
    const { po, sup, card } = await bound();
    sql.prepare("DELETE FROM purchase_mandates WHERE po_id = ?").run(po.id);
    const r = auth(card.id, sup.name, card.cartAmount!); expect(r.decision.code).toBe("mandate_invalid"); expect(r.decision.reason).toMatch(/missing/);
    expect(C.cardDetail("tnt-acme", card.id).order?.mandate.ok).toBe(false);
  });

  it("declines when the cart was signed again with other content", async () => {
    const { po, sup, card } = await bound(); const { intent, cart } = AP2.currentPair(po.id);
    const amount = cart!.body.amount - 5; const lines = [{ sku: "BRG-6204", qty: 1, unitPrice: amount }];
    AP2.signCart({ poId: po.id, tenantId: "tnt-acme", agentId: po.agentId, intentHash: intent!.hash, supplierId: sup.id, currency: cart!.body.currency, amount, lines, railHint: null });
    expect(auth(card.id, sup.name, card.cartAmount!).decision.code).toBe("mandate_invalid");
    const r = auth(card.id, sup.name, amount); expect(r.decision.code).toBe("mandate_invalid"); expect(r.decision.reason).toMatch(/changed/);
  });

  it("declines when the stored cart was tampered with or the intent expired", async () => {
    const { po, sup, card } = await bound(); const cart = AP2.currentPair(po.id).cart!;
    expect(auth(card.id, sup.name, card.cartAmount!, {}, new Date(AP2.currentPair(po.id).intent!.body.expiresAt).getTime() + 1000).decision.approved).toBe(false);
    sql.prepare("UPDATE purchase_mandates SET signature = ? WHERE id = ?").run(Buffer.from("x".repeat(64)).toString("base64"), cart.id);
    const r = auth(card.id, sup.name, card.cartAmount!); expect(r.decision.code).toBe("mandate_invalid"); expect(r.decision.reason).toMatch(/no longer verify/);
  });

  it("does not let a used card be canceled and the order get a second card", async () => {
    const { po, sup, card } = await bound();
    expect(auth(card.id, sup.name, card.cartAmount!).decision.approved).toBe(true);
    await expect(C.setState(pat(), "tnt-acme", card.id, "cancel")).rejects.toThrow(/already used/);
    // Even if an old row was canceled after use, the approved charge still blocks a new card.
    sql.prepare("UPDATE cards SET status = 'canceled' WHERE id = ?").run(card.id);
    const app = await buildApp(); const r0 = await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-clerk-pat" } }); const cookie = `sid=${r0.cookies.find((x: any) => x.name === "sid")!.value}`;
    const again = await app.inject({ method: "POST", url: `/orders/${po.id}/card`, headers: { cookie } }); expect(again.statusCode).toBe(409); expect(again.json().error).toMatch(/already paid by a mandate-bound virtual card/);
    expect(C.listCards("tnt-acme").filter((c) => c.poId === po.id)).toHaveLength(1);
  });

  it("lets an unused card be canceled and replaced", async () => {
    const { po, sup, card } = await bound();
    expect((await C.setState(pat(), "tnt-acme", card.id, "cancel")).status).toBe("canceled");
    const next = (await C.issueForOrder(pat(), "tnt-acme", null, po.id)).card; expect(next.status).toBe("active");
    expect(auth(next.id, sup.name, next.cartAmount!).decision.approved).toBe(true);
  });

  it("declines the card when the order is paid or a payment is in progress on the rail", async () => {
    const { po, sup, card } = await bound();
    S.receiveGoods(po.id); const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {}));
    const fake: any = { id: "pi-probe", invoiceId: inv.id, mandateId: po.mandateId, amount: inv.amount, currency: "USD", status: "pending" }; db.intents.push(fake);
    const busy = auth(card.id, sup.name, card.cartAmount!); expect(busy.decision.code).toBe("order_paid"); expect(busy.decision.reason).toMatch(/in progress/);
    fake.status = "failed"; expect(C.cardDetail("tnt-acme", card.id).order?.mandate.ok).toBe(true);
    fake.status = "settled"; inv.paid = true; po.status = "paid";
    const r = auth(card.id, sup.name, card.cartAmount!); expect(r.decision.approved).toBe(false); expect(r.decision.code).toBe("order_paid"); expect(r.decision.reason).toMatch(/already paid/);
    expect(C.cardDetail("tnt-acme", card.id).card.status).toBe("active");
    const po2 = await order(); S.receiveGoods(po2.id); const inv2 = await S.submitInvoice(po2.id, S.invoiceText(po2.id, {})); inv2.paid = true;
    await expect(C.issueForOrder(pat(), "tnt-acme", null, po2.id)).rejects.toThrow(/already paid/);
  });

  it("marks the order paid by card so the rail refuses a second payment", async () => {
    const { po, sup, card } = await bound();
    S.receiveGoods(po.id); const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {})); S.matchInvoice(inv.id);
    expect(auth(card.id, sup.name, card.cartAmount!).decision.approved).toBe(true);
    expect(db.invoices.find((i) => i.id === inv.id)!.paid).toBe(true); expect(db.pos.find((p) => p.id === po.id)!.status).toBe("paid");
    await expect(S.payInvoice(inv.id, "idem-card-1")).rejects.toThrow(/already paid/);
    expect(C.cardDetail("tnt-acme", card.id).order?.mandate.ok).toBe(true);
    expect(db.evidence.some((e) => e.subjectId === po.id && e.event === "order.paid_by_card")).toBe(true);
    // Card charged before the invoice arrives: the late invoice is born paid and the rail still refuses.
    const b = await bound(); expect(auth(b.card.id, b.sup.name, b.card.cartAmount!).decision.approved).toBe(true);
    S.receiveGoods(b.po.id); const late = await S.submitInvoice(b.po.id, S.invoiceText(b.po.id, {})); expect(late.paid).toBe(true);
    late.paid = false; S.matchInvoice(late.id);
    await expect(S.payInvoice(late.id, "idem-card-2")).rejects.toThrow(/paid by a mandate-bound virtual card/);
  });

  it("only issues from an approved order with mandates, and the limit cannot change", async () => {
    const po = await order(); const app = await buildApp();
    const r0 = await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-clerk-pat" } }); const cookie = `sid=${r0.cookies.find((x: any) => x.name === "sid")!.value}`;
    expect((await app.inject({ method: "POST", url: "/orders/po-nope/card", headers: { cookie } })).statusCode).toBe(404);
    po.status = "pending_approval"; expect((await app.inject({ method: "POST", url: `/orders/${po.id}/card`, headers: { cookie } })).statusCode).toBe(409);
    po.status = "approved";
    const made = await app.inject({ method: "POST", url: `/orders/${po.id}/card`, headers: { cookie } }); expect(made.statusCode).toBe(200);
    const id = made.json().card.id; expect(made.body).not.toMatch(/\b\d{13,19}\b/);
    const lim = await app.inject({ method: "POST", url: `/cards/${id}/limit`, headers: { cookie }, payload: { limit: 5 } }); expect(lim.statusCode).toBe(422);
    const view = (await app.inject({ url: `/cards/${id}`, headers: { cookie } })).json(); expect(view.order.mandate.ok).toBe(true); expect(view.order.poId).toBe(po.id);
    const po2 = await order(); sql.prepare("DELETE FROM purchase_mandates WHERE po_id = ?").run(po2.id);
    const none = await app.inject({ method: "POST", url: `/orders/${po2.id}/card`, headers: { cookie } }); expect(none.statusCode).toBe(409); expect(none.json().error).toMatch(/no signed mandates/);
  });
});
