import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as FV from "../src/flowview.js";
import { buildApp } from "../src/server.js";
import { installFakes } from "./fakeRail.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); installFakes(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };

describe("flow summary", () => {
  it("walks a settled payment through all twelve steps with actors and durations", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const pending = FV.flowSummary(r.intentId!);
    expect(pending.steps.map((s) => s.key)).toEqual([...FV.STEP_KEYS]);
    expect(pending.steps.find((s) => s.key === "settled")!.status).toBe("running");
    await S.pollSettlements();
    const f = FV.flowSummary(r.intentId!);
    const by = Object.fromEntries(f.steps.map((s) => [s.key, s]));
    for (const k of ["need", "po", "policy", "match", "route", "compliance", "custody", "submitted", "settled", "ledger", "erp"]) expect(by[k].status, k).toBe("done");
    expect(by.need.actor?.kind).toBe("agent"); expect(by.policy.actor?.kind).toBe("system");
    expect(by.settled.details.providerRef).toBeTruthy();
    expect(f.steps.slice(1).some((s) => s.durationMs !== null)).toBe(true);
    expect(f.decision.decidedBy).toBe("router"); expect(f.decision.deterministic?.rail).toBe("onchain_usdc");
  });
  it("stops at compliance for a sanctioned payee and marks later steps not reached", async () => {
    const r = await S.runFlow("steel", { scenario: "sanctioned" });
    const by = Object.fromEntries(FV.flowSummary(r.intentId!).steps.map((s) => [s.key, s]));
    expect(by.compliance.status).toBe("blocked"); expect(by.compliance.reason).toBeTruthy();
    for (const k of ["custody", "submitted", "settled", "ledger", "erp"]) expect(by[k].status, k).toBe("not_reached");
  });
  it("hides other tenants' payments", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    expect(() => FV.flowSummary(r.intentId!, "tnt-globex")).toThrow(/not found/);
  });
});

describe("transactions, feed, sankey and home insights", () => {
  it("filters, searches, sorts and exports CSV", async () => {
    await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    await S.runFlow("steel", { scenario: "sanctioned" });
    const all = FV.transactions(null);
    expect(all.total).toBe(db.intents.length);
    expect(FV.transactions(null, { status: "blocked" }).rows.every((r) => r.status === "blocked")).toBe(true);
    expect(FV.transactions(null, { min: 1e9 }).total).toBe(0);
    const asc = FV.transactions(null, { sort: "amount", dir: "asc" }).rows.map((r) => r.amount);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(FV.transactions(null, { q: all.rows[0].id }).rows[0].id).toBe(all.rows[0].id);
    const csv = FV.transactionsCsv(null).trim().split("\n");
    expect(csv[0]).toMatch(/^id,createdAt,status/); expect(csv.length).toBe(all.total + 1);
    expect(FV.liveFeed(null)[0].seq).toBeGreaterThan(FV.liveFeed(null).at(-1)!.seq);
  });
  it("sankey balances settled volume through rails and sends blocked volume to Blocked", async () => {
    await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    await S.runFlow("steel", { scenario: "sanctioned" });
    const k = FV.sankey(30);
    const settled = db.intents.filter((i) => i.status === "settled").reduce((a, i) => a + i.amount, 0);
    expect(k.settledVolume).toBeCloseTo(settled); expect(k.blockedVolume).toBeGreaterThan(0);
    const blocked = k.nodes.findIndex((n) => n.kind === "blocked");
    expect(k.links.filter((l) => l.target === blocked).reduce((a, l) => a + l.value, 0)).toBeCloseTo(k.blockedVolume);
    const railIn = k.links.filter((l) => k.nodes[l.target].kind === "rail").reduce((a, l) => a + l.value, 0);
    const railOut = k.links.filter((l) => k.nodes[l.source].kind === "rail").reduce((a, l) => a + l.value, 0);
    expect(railIn).toBeCloseTo(railOut);
    expect(FV.sankey(30, Date.now() + 400 * 864e5).links).toEqual([]);
  });
  it("home insights give a daily series and rail health from real payments", async () => {
    await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const h = FV.homeInsights(null, 7);
    expect(h.series).toHaveLength(7); expect(h.series.at(-1)!.payments).toBeGreaterThan(0);
    const usdc = h.rails.find((r) => r.rail === "onchain_usdc")!;
    expect(usdc.lastSuccess).toBeTruthy(); expect(usdc.errorRate).toBe(0);
  });
  it("routes are scoped and the sankey is operator only", async () => {
    const app = await buildApp();
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const op = await login(app, "usr-op-olivia"); const gina = await login(app, "usr-globex-gina");
    expect((await app.inject({ url: `/flows/${r.intentId}`, headers: { cookie: op } })).json().steps).toHaveLength(12);
    expect((await app.inject({ url: `/flows/${r.intentId}`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/transactions", headers: { cookie: gina } })).json().total).toBe(0);
    expect((await app.inject({ url: "/transactions/export.csv", headers: { cookie: op } })).headers["content-type"]).toMatch(/csv/);
    expect((await app.inject({ url: "/ops/sankey?days=7", headers: { cookie: op } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ops/sankey", headers: { cookie: gina } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/insights/home", headers: { cookie: gina } })).json().rails.length).toBeGreaterThan(0);
  });
});
