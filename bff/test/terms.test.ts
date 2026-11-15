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
const admin2: P.User = { id: "usr-acme-admin2", tenantId: "tnt-acme", role: "client_admin", name: "Second admin", email: "x@acme.demo" };
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
    expect(o.payOnDue).toMatchObject({ outflow: 420, saved: 0 }); expect(o.payEarly).toMatchObject({ outflow: 411.6, saved: 8.4 }); expect(o.note).toMatch(/demo figures/);
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
    expect(g.statusCode).toBe(200); expect(g.json().rows[0].invoiceId).toBe(inv.id); expect(g.json().options.payEarly.saved).toBe(8.4);
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
    expect(t.earlyPay.payEarly.saved).toBe(8.4); expect(t.earlyPay.rows).toHaveLength(1);
  });
});

describe("pay early and save", () => {
  it("proposes a maker checker change only when the user asks, and never moves money", async () => {
    paidSeed(); const inv = await nwInvoice(); const pays = db.intents.length;
    expect(SP.earlyPayProposals(ctx("usr-cfo-jane", "tnt-acme"), "show open invoices")).toHaveLength(0);
    const [p] = SP.earlyPayProposals(ctx("usr-cfo-jane", "tnt-acme"), "can we pay early and save?");
    expect(p).toMatchObject({ kind: "pay_early", path: "/changes", target: inv.id, allowed: true, body: { kind: "payment.early_pay", payload: { invoiceId: inv.id } } });
    expect(p.label).toMatch(/^Pay early and save 8\.40 USD/); expect(p.detail).toMatch(/demo figures/); expect(p.detail).toMatch(/second client admin/); expect(`${p.label} ${p.detail} ${p.reason}`).not.toMatch(/[—;]/);
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
    P.decideChange(admin2, ch.json().id, true);
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
