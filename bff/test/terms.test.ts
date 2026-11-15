import { describe, it, expect, beforeEach } from "vitest";
import { addDays } from "@b2b/shared";
import { reset, db, reload, save } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as SP from "../src/sparky.js";
import * as P from "../src/platform.js";
import * as O from "../src/ops.js";
import * as TM from "../src/terms.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const today = () => new Date().toISOString().slice(0, 10);
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const ctx = (id: string, scope: string | null, extra: Partial<CP.Ctx> = {}): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator", ...extra });
/** A 420 USD Northwind invoice dated today. Northwind terms are 2 percent in 10 days, net 30. */
const nwInvoice = async () => {
  const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 1, unitPrice: 420 }], justification: "Spare" });
  return S.submitInvoice(po.id, S.invoiceText(po.id, {}));
};
const paidSeed = () => { db.invoices.find((i) => i.id === "inv-eu-seed")!.paid = true; };

describe("terms on suppliers and invoices", () => {
  it("seeds terms on suppliers and the demo invoice, and copies supplier terms to new invoices", async () => {
    expect(db.suppliers.find((s) => s.id === "sup-northwind")!.terms).toEqual({ netDays: 30, discountPct: 2, discountDays: 10 });
    expect(db.suppliers.find((s) => s.id === "sup-contoso")!.terms).toEqual({ netDays: 45 });
    expect(db.invoices.find((i) => i.id === "inv-eu-seed")!.terms).toEqual({ netDays: 30, discountPct: 1.5, discountDays: 14 });
    const inv = await nwInvoice();
    expect(inv.terms).toEqual({ netDays: 30, discountPct: 2, discountDays: 10 });
  });
  it("gives terms to older stored rows on load", async () => {
    const inv = await nwInvoice(); delete (db.invoices.find((i) => i.id === inv.id) as any).terms; delete (db.suppliers.find((s) => s.id === "sup-northwind") as any).terms; save();
    const d = reload();
    expect(d.suppliers.find((s) => s.id === "sup-northwind")!.terms?.discountPct).toBe(2);
    expect(d.invoices.find((i) => i.id === inv.id)!.terms?.netDays).toBe(30);
  });
  it("lets a reviewer set supplier terms and rejects bad ones", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const pat = await login(app, "usr-clerk-pat");
    const post = (cookie: string, terms: unknown) => app.inject({ method: "POST", url: "/workspace/suppliers/sup-contoso/terms", headers: { cookie }, payload: { terms } });
    expect((await post(pat, { netDays: 30 })).statusCode).toBe(403);
    expect((await post(jane, { netDays: 30, discountPct: 2 })).statusCode).toBe(422);
    const ok = await post(jane, { netDays: 30, discountPct: 1, discountDays: 7 });
    expect(ok.statusCode).toBe(200); expect(ok.json().label).toBe("1 percent off if paid in 7 days, net 30");
    expect(db.evidence.some((e) => e.event === "supplier.terms_set" && e.subjectId === "sup-contoso")).toBe(true);
    expect((await app.inject({ method: "POST", url: "/workspace/suppliers/sup-initech/terms", headers: { cookie: jane }, payload: { terms: { netDays: 30 } } })).statusCode).toBe(404);
  });
});

describe("discounts available", () => {
  it("lists open discounts with pay-by date and saving, per tenant", async () => {
    paidSeed(); const inv = await nwInvoice();
    const rows = TM.discountRows("tnt-acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoiceId: inv.id, payBy: addDays(today(), 10), pct: 2, discount: 8.4, net: 411.6, daysLeft: 10, status: "open" });
    expect(TM.discountRows("tnt-globex")).toHaveLength(0);
    expect(TM.discountRows("tnt-acme", addDays(today(), 11))[0].status).toBe("missed");
    const o = TM.payOptions("tnt-acme");
    expect(o.byCurrency).toEqual([{ currency: "USD", invoices: 1, payOnDue: 420, payEarly: 411.6, saved: 8.4 }]); expect(o.note).toMatch(/demo figures/);
  });
  it("keeps one total per currency and never adds EUR to USD", async () => {
    const seed = db.invoices.find((i) => i.id === "inv-eu-seed")!; seed.invoiceDate = today(); seed.dueDate = addDays(today(), 30);
    await nwInvoice();
    const o = TM.payOptions("tnt-acme");
    expect(o.invoices).toBe(2);
    expect(o.byCurrency).toEqual([{ currency: "EUR", invoices: 1, payOnDue: 1700, payEarly: 1674.5, saved: 25.5 }, { currency: "USD", invoices: 1, payOnDue: 420, payEarly: 411.6, saved: 8.4 }]);
    expect(JSON.stringify(o)).not.toMatch(/2120|2086\.1|33\.9/);
    const d = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "discountsAvailable").summary;
    expect(d).toMatch(/Pay early: 1674\.50 EUR out, 25\.50 EUR saved and 411\.60 USD out, 8\.40 USD saved/); expect(d).toMatch(/Pay on due date: 1700\.00 EUR out and 420\.00 USD out/); expect(d).not.toMatch(/[\u2014;]/);
    const f = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "cashForecast").summary;
    expect(f).toMatch(/saves 25\.50 EUR and 8\.40 USD \(demo figure\)/); expect(f).not.toMatch(/\$33\.90/);
    const t = await O.treasury("tnt-acme"); expect(t.earlyPay.byCurrency.map((x: any) => x.currency)).toEqual(["EUR", "USD"]);
  });
  it("answers through the copilot tool and the discounts route", async () => {
    paidSeed(); const inv = await nwInvoice();
    expect(CP.mockPlan("what early pay discounts are available?").map((p) => p.name)).toContain("discountsAvailable");
    const r = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "discountsAvailable");
    expect(r.error).toBeUndefined(); expect(r.rows).toHaveLength(1); expect(r.summary).toMatch(/save 8\.40 USD/); expect(r.summary).toMatch(/demo figures/); expect(r.source.ids).toEqual([inv.id]);
    expect(CP.runTool(ctx("usr-globex-gina", "tnt-globex"), "discountsAvailable").rows).toHaveLength(0);
    const a = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), "Which discounts are available if we pay early?");
    expect(a.tools.map((t) => t.tool)).toContain("discountsAvailable"); expect(a.answer).not.toMatch(/[—;]/);
    const app = await buildApp(); const g = await app.inject({ method: "GET", url: "/terms/discounts", headers: { cookie: await login(app, "usr-cfo-jane") } });
    expect(g.statusCode).toBe(200); expect(g.json().rows[0].invoiceId).toBe(inv.id); expect(g.json().options.byCurrency[0]).toMatchObject({ currency: "USD", saved: 8.4 });
    const gg = await app.inject({ method: "GET", url: "/terms/discounts", headers: { cookie: await login(app, "usr-globex-gina") } });
    expect(gg.json().rows).toHaveLength(0);
  });
});

describe("forecasts with pay early and pay on due date", () => {
  it("adds the pay early option to the copilot cash forecast", async () => {
    paidSeed(); const inv = await nwInvoice(); inv.dueDate = addDays(today(), 25);
    const r = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "cashForecast"); const rows = r.rows as any[];
    expect(rows[3].outflow).toBe(420); expect(rows[1].payEarlyOutflow).toBe(411.6); expect(rows[1].outflow).toBe(0);
    expect(rows[3].payEarlyBalance - rows[3].balance).toBeCloseTo(8.4, 2);
    expect(r.summary).toMatch(/Pay early option/); expect(r.summary).toMatch(/demo figure/);
  });
  it("leaves the forecast alone when no discount is open", async () => {
    paidSeed(); const inv = await nwInvoice(); inv.invoiceDate = addDays(today(), -20); inv.dueDate = addDays(today(), 10);
    const r = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "cashForecast"); const rows = r.rows as any[];
    expect(rows.map((w) => w.payEarlyBalance)).toEqual(rows.map((w) => w.balance)); expect(r.summary).not.toMatch(/Pay early option/);
  });
  it("adds both options to the daily treasury forecast", async () => {
    paidSeed(); const inv = await nwInvoice(); inv.dueDate = addDays(today(), 25);
    const t = await O.treasury("tnt-acme");
    expect(t.forecast[25].outflow).toBe(420); expect(t.forecast[10].earlyOutflow).toBe(411.6); expect(t.forecast[25].earlyOutflow).toBe(0);
    expect(t.forecast[9].earlyBalance).toBe(t.forecast[9].balance);
    expect(Math.round((t.forecast[30].earlyBalance - t.forecast[30].balance) * 100) / 100).toBe(8.4);
    expect(t.earlyPay.byCurrency[0].saved).toBe(8.4); expect(t.earlyPay.rows).toHaveLength(1);
  });
});

describe("pay early and save", () => {
  it("proposes a maker checker change only when the user asks, and never moves money", async () => {
    paidSeed(); const inv = await nwInvoice(); const pays = db.intents.length;
    expect(SP.earlyPayProposals(ctx("usr-cfo-jane", "tnt-acme"), "show open invoices")).toHaveLength(0);
    const [p] = SP.earlyPayProposals(ctx("usr-cfo-jane", "tnt-acme"), "can we pay early and save?");
    expect(p).toMatchObject({ kind: "pay_early", path: "/changes", target: inv.id, allowed: true, body: { kind: "payment.early_pay", payload: { invoiceId: inv.id } } });
    expect(p.label).toMatch(/^Pay early and save 8\.40 USD/); expect(p.detail).toMatch(/demo figures/); expect(p.detail).toMatch(/second client admin approves the plan on the Invoices page/); expect(p.detail).not.toMatch(/in Changes/); expect(`${p.label} ${p.detail} ${p.reason}`).not.toMatch(/[—;]/);
    expect(SP.earlyPayProposals(ctx("usr-clerk-pat", "tnt-acme"), "pay early")[0].allowed).toBe(false);
    expect(SP.earlyPayProposals(ctx("usr-globex-gina", "tnt-globex"), "pay early")).toHaveLength(0);
    const a = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), "Which discounts can we take if we pay early?");
    expect(a.proposals.some((x) => x.kind === "pay_early" && x.target === inv.id)).toBe(true);
    expect(db.intents.length).toBe(pays); expect(db.invoices.find((i) => i.id === inv.id)!.earlyPay).toBeUndefined();
  });
  it("needs a second client admin, then records the plan on the invoice", async () => {
    paidSeed(); const inv = await nwInvoice(); const pays = db.intents.length;
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const pat = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: pat }, payload: {} })).statusCode).toBe(403);
    const ch = await app.inject({ method: "POST", url: "/changes", headers: { cookie: jane }, payload: { kind: "payment.early_pay", payload: { invoiceId: inv.id, tenantId: "tnt-globex" }, tenantId: "tnt-acme" } });
    expect(ch.statusCode).toBe(200); expect(ch.json()).toMatchObject({ kind: "payment.early_pay", status: "pending", tenantId: "tnt-acme", payload: { tenantId: "tnt-acme", invoiceId: inv.id } });
    expect(TM.discountRows("tnt-acme")[0].status).toBe("requested");
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: jane }, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: jane }, payload: { approve: true } })).statusCode).toBe(403);
    expect(db.invoices.find((i) => i.id === inv.id)!.earlyPay).toBeUndefined();
    const amara = await login(app, "usr-acme-amara"); const gina = await login(app, "usr-globex-gina");
    const list = await app.inject({ method: "GET", url: "/changes?status=pending", headers: { cookie: amara } });
    expect(list.json().filter((c: any) => c.kind === "payment.early_pay").map((c: any) => c.id)).toEqual([ch.json().id]);
    expect((await app.inject({ method: "GET", url: "/changes?status=pending", headers: { cookie: gina } })).json()).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: gina }, payload: { approve: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: pat }, payload: { approve: true } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: amara }, payload: { approve: true } });
    expect(ok.statusCode).toBe(200); expect(ok.json().change).toMatchObject({ status: "approved", approvedBy: "usr-acme-amara" });
    expect(db.invoices.find((i) => i.id === inv.id)!.earlyPay).toMatchObject({ status: "approved", payBy: addDays(today(), 10), pct: 2, discount: 8.4, requestedBy: "usr-cfo-jane" });
    expect(TM.discountRows("tnt-acme")[0].status).toBe("approved");
    expect(db.evidence.some((e) => e.event === "invoice.early_pay_approved" && e.subjectId === inv.id)).toBe(true);
    expect(db.intents.length).toBe(pays); expect(db.invoices.find((i) => i.id === inv.id)!.paid).toBe(false);
    expect(SP.earlyPayProposals(ctx("usr-cfo-jane", "tnt-acme"), "pay early")).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: jane }, payload: {} })).statusCode).toBe(409);
  });
  it("refuses another tenant's invoice, a closed window and an invoice with no discount", async () => {
    const inv = await nwInvoice(); const app = await buildApp(); const gina = await login(app, "usr-globex-gina"); const jane = await login(app, "usr-cfo-jane");
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: gina }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/changes", headers: { cookie: gina }, payload: { kind: "payment.early_pay", payload: { invoiceId: inv.id, tenantId: "tnt-acme" } } })).statusCode).toBe(404);
    inv.invoiceDate = addDays(today(), -11);
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: jane }, payload: {} })).statusCode).toBe(409);
    inv.terms = { netDays: 30 };
    expect((await app.inject({ method: "POST", url: `/invoices/${inv.id}/early-pay`, headers: { cookie: jane }, payload: {} })).statusCode).toBe(422);
  });
});

describe("older client admin change kinds stay inside the caller's tenant", () => {
  it("forces the tenant on payment.reroute and payment.schedule sent through POST /changes", async () => {
    const app = await buildApp(); const gina = await login(app, "usr-globex-gina"); const jane = await login(app, "usr-cfo-jane"); const amara = await login(app, "usr-acme-amara");
    const nw = db.suppliers.find((s) => s.id === "sup-northwind")!; const before = nw.preferredRail; const rail = nw.acceptedRails.find((r) => r !== before) ?? before;
    const post = (cookie: string, body: object) => app.inject({ method: "POST", url: "/changes", headers: { cookie }, payload: body });
    // Gina is a Globex admin. She names Acme in the payload and leaves out the top-level tenant.
    expect((await post(gina, { kind: "payment.reroute", payload: { tenantId: "tnt-acme", supplierId: "sup-northwind", rail } })).statusCode).toBe(404);
    expect((await post(gina, { kind: "payment.reroute", payload: { tenantId: "tnt-acme", supplierId: "sup-northwind", rail }, tenantId: "tnt-acme" })).statusCode).toBe(403);
    const po = db.pos.find((x) => (x.tenantId ?? "tnt-acme") === "tnt-acme")!;
    expect((await post(gina, { kind: "payment.schedule", payload: { tenantId: "tnt-acme", supplierId: po.supplierId, cadence: "monthly", nextDate: "2027-01-05", amount: 10, templatePoId: po.id } })).statusCode).toBe(404);
    expect(P.listChanges("pending")).toHaveLength(0); expect(SP.listSchedules("tnt-acme")).toHaveLength(0); expect(nw.preferredRail).toBe(before);
    // The same request from an Acme admin is stored with the Acme tenant, and only another Acme admin can approve it.
    const ch = await post(jane, { kind: "payment.reroute", payload: { tenantId: "tnt-globex", supplierId: "sup-northwind", rail } });
    expect(ch.statusCode).toBe(200); expect(ch.json()).toMatchObject({ tenantId: "tnt-acme", payload: { tenantId: "tnt-acme" } });
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: gina }, payload: { approve: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: amara }, payload: { approve: true } })).statusCode).toBe(200);
    expect(db.suppliers.find((s) => s.id === "sup-northwind")!.preferredRail).toBe(rail);
  });
  it("refuses to decide a client admin change that has no tenant", () => {
    const nw = db.suppliers.find((s) => s.id === "sup-northwind")!;
    const ch = P.requestChange(P.getUser("usr-cfo-jane")!, "payment.reroute", { tenantId: "tnt-acme", supplierId: nw.id, rail: nw.acceptedRails[0] }, null);
    expect(() => P.decideChange(P.getUser("usr-globex-gina")!, ch.id, true)).toThrow(/no tenant/);
    expect(() => P.decideChange(P.getUser("usr-acme-amara")!, ch.id, true)).toThrow(/no tenant/);
  });
});
