import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as FX from "../src/modules/fx.js";
import * as X from "../src/explain.js";
import { sql } from "../src/db.js";
import { buildApp } from "../src/server.js";

// Mocked rate source. No network is used.
let rates: Record<string, number> = {};
let calls = 0; let offline = false;
const mock: FX.RateFetcher = async (b, q) => { calls++; if (offline) throw new Error("offline"); const r = rates[`${b}${q}`]; if (!r) throw new Error("no pair"); return { rate: r, date: "2026-11-03", source: "mock ECB" }; };
beforeEach(() => { sql.prepare("DELETE FROM fx_rates").run(); rates = { EURUSD: 1.1, GBPUSD: 1.25, EURGBP: 0.88, USDEUR: 0.91 }; calls = 0; offline = false; FX.setRateFetcher(mock); reset(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };

/** EUR purchase from Northwind booked on the chosen entity, matched and paid. */
async function eurInvoice(entityId: string) {
  await S.ensureRates({ currency: "EUR", entityId, tenantId: "tnt-acme" });
  const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "EUR", entityId, lines: [{ sku: "NW-BRG-6204", description: "Ball bearing 6204 sealed", qty: 100, unitPrice: 4.25 }], justification: "EUR test" });
  S.autoApprove(po); S.receiveGoods(po.id);
  const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {}));
  expect(S.matchInvoice(inv.id).status).toBe("matched");
  return { po, inv: db.invoices.find((i) => i.id === inv.id)! };
}

describe("legal entities and FX (rate fetch mocked)", () => {
  it("seeds several entities per tenant with functional currencies", () => {
    const acme = FX.listEntities("tnt-acme");
    expect(acme.map((e) => [e.name, e.currency])).toEqual([["Acme US Inc", "USD"], ["Acme Europe BV", "EUR"], ["Acme UK Ltd", "GBP"]]);
    expect(FX.listEntities("tnt-globex").every((e) => e.tenantId === "tnt-globex")).toBe(true);
  });
  it("converts, caches, and falls back to a stale cached rate when offline", async () => {
    const r = await FX.getRate("EUR", "USD");
    expect(r.rate).toBe(1.1); expect(r.stale).toBe(false); expect(FX.convert(425, r.rate)).toBe(467.5);
    await FX.getRate("EUR", "USD"); expect(calls).toBe(1);
    offline = true; const s = await FX.getRate("EUR", "USD", { force: true });
    expect(s.stale).toBe(true); expect(s.rate).toBe(1.1); expect(s.staleReason).toMatch(/last cached rate/);
    await expect(FX.getRate("GBP", "EUR")).rejects.toThrow(/No rate is invented/);
  });
  it("lock expires and an expired lock is refused", async () => {
    const l = await FX.lockQuote({ tenantId: "tnt-acme", entityId: "ent-acme-us", from: "EUR", to: "USD", ttlMs: 1000 });
    expect(l.id).toMatch(/^fxl-/); expect(FX.isExpired(l)).toBe(false); expect(FX.isExpired(l, Date.parse(l.expiresAt) + 1)).toBe(true);
    sql.prepare("UPDATE fx_locks SET data = json_set(data, '$.expiresAt', ?) WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), l.id);
    expect(() => FX.useLock(l.id, "tnt-acme", "pi-x", { from: "EUR", to: "USD", entityId: "ent-acme-us" })).toThrow(/expired/);
    const { inv } = await eurInvoice("ent-acme-us");
    await expect(S.payInvoice(inv.id, "k-exp", { fxLockId: l.id })).rejects.toThrow(/expired/);
  });
  it("settles at the locked rate and books a realised FX loss in the US entity", async () => {
    const { inv } = await eurInvoice("ent-acme-us");
    expect(inv.currency).toBe("EUR"); expect(inv.accrual).toMatchObject({ rate: 1.1, amount: 467.5, functionalCurrency: "USD" });
    rates.EURUSD = 1.12; sql.prepare("DELETE FROM fx_rates").run();
    const { intent } = await S.payInvoice(inv.id, "k-fx");
    expect(intent.fx).toMatchObject({ rate: 1.12, invoiceAmount: 425, settlementAmount: 476 });
    expect(intent.amount).toBe(476);
    rates.EURUSD = 1.3; // a later market move does not change the locked settlement
    await S.pollSettlements();
    expect(intent.status).toBe("settled");
    expect(intent.fx!.realised).toMatchObject({ kind: "loss", apFunctional: 467.5, cashFunctional: 476 });
    const j = db.journals.find((x) => x.ref === intent.id && x.memo.startsWith("Payment"))!;
    expect(j.entityId).toBe("ent-acme-us");
    expect(j.entries.find((e) => e.account === "7200 Realised FX loss")!.debit).toBe(8.5);
    const w = X.explainPayment(intent.id, "tnt-acme").items.find((i) => i.key === "fx")!;
    expect(w.why).toMatch(/realised FX loss/); expect(w.why).toMatch(intent.fx!.lockId);
  });
  it("books a gain when the rate falls and no FX line when the entity matches the invoice currency", async () => {
    const a = await eurInvoice("ent-acme-us");
    rates.EURUSD = 1.05; sql.prepare("DELETE FROM fx_rates").run();
    const p1 = (await S.payInvoice(a.inv.id, "k-g")).intent;
    const eu = await eurInvoice("ent-acme-eu");
    expect(eu.inv.accrual).toMatchObject({ functionalCurrency: "EUR", rate: 1, amount: 425 });
    const p2 = (await S.payInvoice(eu.inv.id, "k-eu")).intent;
    await S.pollSettlements();
    expect(p1.fx!.realised!.kind).toBe("gain");
    expect(db.journals.find((x) => x.ref === p1.id && x.memo.startsWith("Payment"))!.entries.find((e) => e.account === "7100 Realised FX gain")!.credit).toBe(21.25);
    expect(p2.fx!.realised!.kind).toBe("none");
    const pj = db.journals.find((x) => x.ref === p2.id && x.memo.startsWith("Payment"))!;
    expect(pj.entries.every((e) => e.currency === "EUR")).toBe(true);
    expect(pj.entries.find((e) => e.account.startsWith("10"))).toMatchObject({ origCurrency: "USD", origAmount: p2.amount });
  });
  it("double entry balances per entity", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const a = await eurInvoice("ent-acme-us"); await S.payInvoice(a.inv.id, "k1");
    const b = await eurInvoice("ent-acme-eu"); await S.payInvoice(b.inv.id, "k2");
    await S.pollSettlements();
    for (const id of ["ent-acme-us", "ent-acme-eu", "ent-acme-uk"]) {
      const v = S.entityLedgerView(id, "tnt-acme");
      expect(v.balanced).toBe(true); expect(v.trialBalance.totalDebit).toBe(v.trialBalance.totalCredit);
      for (const j of v.journals) expect(j.entries.reduce((s, e) => s + e.debit - e.credit, 0)).toBeCloseTo(0, 6);
    }
    expect(S.entityLedgerView("ent-acme-eu", "tnt-acme").journals.length).toBeGreaterThanOrEqual(2);
    expect(S.entityLedgerView("ent-acme-uk", "tnt-acme").journals.length).toBe(0);
  });
  it("keeps entities, books and locks inside their tenant", async () => {
    const app = await buildApp();
    const gina = await login(app, "usr-globex-gina"); const jane = await login(app, "usr-cfo-jane");
    const ents = (await app.inject({ method: "GET", url: "/entities", headers: { cookie: gina } })).json();
    expect(ents.map((e: any) => e.id)).toEqual(["ent-globex-us", "ent-globex-uk"]);
    expect((await app.inject({ method: "GET", url: "/entities/ent-acme-eu/ledger", headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/entities/ent-acme-eu/ledger", headers: { cookie: jane } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/fx/quotes", headers: { cookie: gina }, payload: { entityId: "ent-acme-us", from: "EUR" } })).statusCode).toBe(404);
    const q = (await app.inject({ method: "POST", url: "/fx/quotes", headers: { cookie: jane }, payload: { entityId: "ent-acme-us", from: "EUR" } })).json();
    expect(q.rate).toBe(1.1);
    expect((await app.inject({ method: "GET", url: `/fx/locks/${q.id}`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect(() => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", entityId: "ent-globex-us", lines: [{ sku: "NW-BRG-6204", description: "x", qty: 1, unitPrice: 4.25 }], justification: "x" })).toThrow(/entity not found/);
    await app.close();
  });
});
