import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as X from "../src/explain.js";
import { sql } from "../src/db.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { reset(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
async function invoiceReady() {
  const d = (await S.draftPo("Need 50 sealed 6204 bearings")).value;
  const po = S.createPo(d); S.autoApprove(po); S.receiveGoods(po.id);
  const inv = await S.submitInvoice(po.id, S.invoiceText(po.id, {})); S.matchInvoice(inv.id);
  return { po, inv };
}

describe("explainable decisions (no model)", () => {
  it("explains an approved payment with evidence ids and hashes", async () => {
    const r = await S.runFlow("Need 50 sealed 6204 bearings");
    const w = X.explainPayment(r.intentId!, null);
    expect(w.items.map((i) => i.key)).toEqual(["policy", "approval", "mandates", "compliance", "route", "settlement"]);
    for (const k of ["policy", "mandates", "compliance", "route"]) expect(w.items.find((i) => i.key === k)!.outcome).toBe("passed");
    const m = w.items.find((i) => i.key === "mandates")!;
    expect(m.evidence?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.evidence.find((e) => e.id === m.evidence!.id)?.hash).toBe(m.evidence!.hash);
    expect(w.chain.valid).toBe(true);
    expect(X.whyMarkdown(w)).toMatch(/Hash chain check: valid/);
  });
  it("explains a blocked OFAC payment", async () => {
    const r = await S.runFlow("steel", { scenario: "sanctioned" });
    const w = X.explainPayment(r.intentId!, null);
    const c = w.items.find((i) => i.key === "compliance")!;
    expect(c.outcome).toBe("failed");
    expect(c.why).toMatch(/OFAC/);
    expect(w.items.find((i) => i.key === "settlement")!.why).toMatch(/No money moved/);
    expect(w.headline).toMatch(/Stopped at compliance/);
  });
  it("says clearly when a PO predates mandates, and reset backfills them", async () => {
    const { po, inv } = await invoiceReady();
    sql.prepare("DELETE FROM purchase_mandates WHERE po_id = ?").run(po.id);
    const { intent } = await S.payInvoice(inv.id, "why-legacy");
    expect(intent.status).toBe("blocked");
    const m = X.explainPayment(intent.id, null).items.find((i) => i.key === "mandates")!;
    expect(m.outcome).toBe("failed");
    expect(m.why).toMatch(/created before signed mandates were switched on/);
    expect(S.backfillMandates()).toBe(1);
    const again = await S.payInvoice(inv.id, "why-legacy-2");
    expect(again.intent.status).not.toBe("blocked");
  });
  it("seeded demo flows carry mandates and are never blocked by them", async () => {
    for (const t of ["tnt-acme", "tnt-globex"]) {
      const r = await S.runFlow("Need 50 sealed 6204 bearings", { tenantId: t });
      if (!r.intentId) continue;
      expect(X.explainPayment(r.intentId, null).items.find((i) => i.key === "mandates")!.outcome).toBe("passed");
    }
  });
  it("export respects tenant scope and permissions", async () => {
    const r = await S.runFlow("Need 50 sealed 6204 bearings");
    const app = await buildApp();
    const jane = await login(app, "usr-cfo-jane"), gina = await login(app, "usr-globex-gina"), pat = await login(app, "usr-clerk-pat");
    const ok = await app.inject({ url: `/payments/${r.intentId}/why/export.json`, headers: { cookie: jane } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().chain.valid).toBe(true);
    expect(ok.json().records.length).toBeGreaterThan(3);
    expect((await app.inject({ url: `/payments/${r.intentId}/why/export.md`, headers: { cookie: jane } })).body).toMatch(/Decision record/);
    expect((await app.inject({ url: `/payments/${r.intentId}/why/export.json`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/payments/${r.intentId}/why`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/payments/${r.intentId}/why/export.json`, headers: { cookie: pat } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/payments/${r.intentId}/why`, headers: { cookie: pat } })).statusCode).toBe(200);
  });
});
