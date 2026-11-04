import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import type { PaymentIntent } from "../src/modules/store.js";
import { appendEvidence } from "../src/modules/evidence.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as R from "../src/risk.js";
import * as X from "../src/explain.js";
import * as CP from "../src/copilot.js";
import { buildApp } from "../src/server.js";
import { toCsv } from "../src/tables.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const NOON = "2026-11-04T12:00:00.000Z";
const minus = (iso: string, ms: number) => new Date(new Date(iso).getTime() - ms).toISOString();
/** A real happy path payment, moved to a fixed daytime timestamp. */
async function base(at = NOON) { const r = await S.runFlow("Need 50 sealed 6204 bearings"); const pi = db.intents.find((i) => i.id === r.intentId)!; pi.createdAt = at; return pi; }
/** An earlier payment to the same supplier. */
const prior = (pi: PaymentIntent, n: number, o: Partial<PaymentIntent>) => { const x = { ...pi, id: `pi-prior-${n}`, idempotencyKey: `k-${n}`, risk: undefined, status: "settled" as const, ...o }; db.intents.push(x); return x; };
const codes = (pi: PaymentIntent) => R.scorePayment(pi).reasons.map((r) => r.code);
const supOf = (pi: PaymentIntent) => db.suppliers.find((s) => s.id === db.invoices.find((i) => i.id === pi.invoiceId)!.supplierId)!;

describe("risk rules", () => {
  it("scores a payment on store and a routine daytime payment only flags the first rail", async () => {
    const r = await S.runFlow("Need 50 sealed 6204 bearings");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    expect(pi.risk).toBeTruthy(); expect(db.evidence.some((e) => e.subjectId === pi.id && e.event === "risk.scored")).toBe(true);
    pi.createdAt = NOON;
    const s = R.scorePayment(pi);
    expect(s.reasons.map((x) => x.code)).toEqual(["first_rail"]); expect(s.score).toBe(R.POINTS.first_rail); expect(s.level).toBe("low");
  });
  it("new supplier under 30 days", async () => {
    const pi = await base(); (supOf(pi) as any).createdAt = minus(NOON, 5 * 864e5);
    expect(codes(pi)).toContain("new_supplier");
    (supOf(pi) as any).createdAt = minus(NOON, 45 * 864e5);
    expect(codes(pi)).not.toContain("new_supplier");
  });
  it("amount spike against supplier history", async () => {
    const pi = await base();
    prior(pi, 1, { amount: pi.amount / 10, createdAt: minus(NOON, 3 * 864e5) });
    expect(codes(pi)).not.toContain("amount_spike");
    prior(pi, 2, { amount: pi.amount / 10, createdAt: minus(NOON, 2 * 864e5) });
    const s = R.scorePayment(pi); const spike = s.reasons.find((x) => x.code === "amount_spike")!;
    expect(spike.detail).toMatch(/10\.0 times/);
  });
  it("bank or wallet change in the last 30 days", async () => {
    const pi = await base(new Date(Date.now() + 5_000).toISOString());
    expect(codes(pi)).not.toContain("payee_change");
    appendEvidence(db.evidence, "supplier", supOf(pi).id, "payee_change.applied", { field: "walletAddress" });
    expect(codes(pi)).toContain("payee_change");
  });
  it("odd hour", async () => {
    expect(codes(await base("2026-11-04T23:30:00.000Z"))).toContain("odd_hour");
    reset(); P.seedPlatform(); S.bootstrap();
    expect(codes(await base("2026-11-04T09:00:00.000Z"))).not.toContain("odd_hour");
  });
  it("velocity counts only the same tenant in 15 minutes", async () => {
    const pi = await base();
    for (const n of [1, 2]) prior(pi, n, { createdAt: minus(NOON, n * 60_000) });
    prior(pi, 9, { createdAt: minus(NOON, 3 * 60_000), tenantId: "tnt-globex" });
    expect(codes(pi)).not.toContain("velocity");
    prior(pi, 3, { createdAt: minus(NOON, 4 * 60_000) });
    expect(codes(pi)).toContain("velocity");
  });
  it("first payment on a rail", async () => {
    const pi = await base();
    expect(codes(pi)).toContain("first_rail");
    prior(pi, 1, { createdAt: minus(NOON, 864e5) });
    expect(codes(pi)).not.toContain("first_rail");
  });
  it("high risk corridor and score cap", async () => {
    const pi = await base("2026-11-04T23:00:00.000Z"); const sup = supOf(pi);
    db.orgs.find((o) => o.id === sup.orgId)!.country = "IR"; (sup as any).createdAt = minus(NOON, 864e5);
    appendEvidence(db.evidence, "supplier", sup.id, "payee.changed", {}); pi.createdAt = new Date(Date.now() + 1000).toISOString();
    const s = R.scorePayment(pi);
    expect(s.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["high_risk_corridor", "new_supplier", "payee_change"]));
    expect(s.score).toBeLessThanOrEqual(100); expect(s.level).toBe("high");
  });
});

describe("risk inbox", () => {
  const flag = async (tenantId?: string) => {
    const r = await S.runFlow(tenantId ? "Need 3 shelf label packs" : "Need 50 sealed 6204 bearings", { tenantId });
    const pi = db.intents.find((i) => i.id === r.intentId)!; const sup = supOf(pi);
    db.orgs.find((o) => o.id === sup.orgId)!.country = "IR"; pi.risk = undefined; return pi;
  };
  it("keeps the inbox, decisions and the copilot tool inside the tenant", async () => {
    const acme = await flag(); const globex = await flag("tnt-globex");
    expect(R.inbox("tnt-acme").map((r) => r.paymentId)).toEqual([acme.id]);
    expect(R.inbox("tnt-globex").map((r) => r.paymentId)).toEqual([globex.id]);
    expect(R.inbox(null).length).toBe(2);
    const app = await buildApp();
    const gina = await login(app, "usr-globex-gina");
    const cross = await app.inject({ method: "POST", url: `/risk/${acme.id}/decide`, headers: { cookie: gina }, payload: { action: "clear", reason: "Looks fine" } });
    expect(cross.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/risk/inbox", headers: { cookie: gina } });
    expect(list.json().map((r: any) => r.paymentId)).toEqual([globex.id]);
    const csv = await app.inject({ method: "GET", url: "/export/risk", headers: { cookie: gina } });
    expect(csv.body).toContain(globex.id); expect(csv.body).not.toContain(acme.id);
    const t = CP.runTool({ user: P.getUser("usr-globex-gina")!, scope: "tnt-globex", prefix: "/app" }, "riskInbox", {});
    expect(t.source.ids).toEqual([globex.id]);
    expect(CP.mockPlan("Any risky or flagged payments?").map((p) => p.name)).toContain("riskInbox");
  });
  it("clear needs a reason and risk.review, escalate raises an alert, and the Why panel shows it", async () => {
    const pi = await flag(); const app = await buildApp();
    const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    expect((await app.inject({ method: "POST", url: `/risk/${pi.id}/decide`, headers: { cookie: pat }, payload: { action: "clear", reason: "ok then" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/risk/${pi.id}/decide`, headers: { cookie: sam }, payload: { action: "clear", reason: "" } })).statusCode).toBe(422);
    expect(X.explainPayment(pi.id, "tnt-acme").items.find((i) => i.key === "risk")!.outcome).toBe("waiting");
    const esc = await app.inject({ method: "POST", url: `/risk/${pi.id}/decide`, headers: { cookie: sam }, payload: { action: "escalate", reason: "Corridor needs compliance review" } });
    expect(esc.statusCode).toBe(200); expect(esc.json().status).toBe("escalated");
    expect(db.alerts.some((a) => a.kind === "risk.escalated")).toBe(true);
    expect(X.explainPayment(pi.id, "tnt-acme").items.find((i) => i.key === "risk")!.outcome).toBe("failed");
    await app.inject({ method: "POST", url: `/risk/${pi.id}/decide`, headers: { cookie: sam }, payload: { action: "clear", reason: "Compliance cleared the supplier" } });
    const why = X.explainPayment(pi.id, "tnt-acme").items.find((i) => i.key === "risk")!;
    expect(why.outcome).toBe("passed"); expect(why.why).toMatch(/Sam Rivera cleared it/);
    expect(R.inbox("tnt-acme", { status: "cleared" }).length).toBe(1); expect(R.inbox("tnt-acme", { status: "open" }).length).toBe(0);
  });
});

describe("saved views and CSV export", () => {
  it("saves views per user and never shows them to anyone else", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const sam = await login(app, "usr-controller-sam");
    const v = await app.inject({ method: "POST", url: "/views", headers: { cookie: jane }, payload: { table: "payments", name: "Blocked", state: { filter: "blocked", hidden: ["providerRef"] } } });
    expect(v.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/views?table=payments", headers: { cookie: jane } })).json()[0].state.filter).toBe("blocked");
    expect((await app.inject({ method: "GET", url: "/views?table=payments", headers: { cookie: sam } })).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/views/${v.json().id}`, headers: { cookie: sam } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/views", headers: { cookie: jane }, payload: { table: "nope", name: "x" } })).statusCode).toBe(422);
  });
  it("exports each table as CSV, escapes formulas and honours a selection", async () => {
    const r = await S.runFlow("Need 50 sealed 6204 bearings"); await S.runFlow("Need 60 sealed 6204 bearings");
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane");
    for (const k of ["payments", "approvals", "suppliers", "ledger", "risk"]) {
      const res = await app.inject({ method: "GET", url: `/export/${k}`, headers: { cookie: jane } });
      expect(res.statusCode).toBe(200); expect(res.headers["content-type"]).toMatch(/text\/csv/);
    }
    const one = await app.inject({ method: "GET", url: `/export/payments?ids=${r.intentId}`, headers: { cookie: jane } });
    expect(one.body.trim().split("\r\n").length).toBe(2);
    expect(toCsv(["a"], [["=SUM(A1)"], ["x,y"]])).toBe("a\r\n'=SUM(A1)\r\n\"x,y\"\r\n");
    expect((await app.inject({ method: "GET", url: "/export/secrets", headers: { cookie: jane } })).statusCode).toBe(404);
  });
});
