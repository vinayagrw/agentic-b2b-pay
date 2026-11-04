import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as LV from "../src/live.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { reset(); S.bootstrap(); LV.resetFloatCache(); });

describe("confidence from stored inputs", () => {
  it("reads match headroom, router lead and risk score", () => {
    expect(LV.matchConfidence({ status: "matched", tolerancePct: 2, totals: { variancePct: 0.5 } }).value).toBe(75);
    expect(LV.matchConfidence({ status: "exception", tolerancePct: 2, totals: { variancePct: 3 } }).value).toBe(0);
    expect(LV.matchConfidence(undefined).value).toBeNull();
    const r = LV.routeConfidence({ rail: "a", options: [{ rail: "a", eligible: true, score: 80 }, { rail: "b", eligible: true, score: 60 }, { rail: "c", eligible: false, score: 0 }] });
    expect(r.value).toBe(25); expect(r.basis).toContain("60");
    expect(LV.routeConfidence({ rail: "a", options: [{ rail: "a", eligible: true, score: 50 }] }).value).toBe(100);
    expect(LV.riskConfidence({ score: 35, level: "medium" }).value).toBe(65);
  });
  it("covers a real payment and classifies activity", async () => {
    const r = await S.runFlow("Need 50 sealed 6204 bearings");
    const pi = db.intents.find((i) => i.id === r.intentId)!;
    const c = LV.confidenceForPayment(pi);
    expect(c.map((x) => x.key)).toEqual(["match", "route", "risk"]);
    expect(c.find((x) => x.key === "route")!.value).not.toBeNull();
    const feed = LV.activity(null, { limit: 100 });
    expect(feed.length).toBeGreaterThan(0);
    expect(new Set(feed.map((f) => f.kind)).has("payment")).toBe(true);
    expect(LV.kindOf("payment", "risk.scored")).toBe("risk");
    expect(LV.kindOf("supplier", "supplier.invited")).toBeNull();
  });
});

describe("live routes", () => {
  it("serves pulse and payloads", async () => {
    const app = await buildApp();
    const run = await S.runFlow("Need 50 sealed 6204 bearings");
    const l = await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-op-olivia" } });
    const cookie = `sid=${l.cookies.find((x: any) => x.name === "sid")?.value}`;
    const p = await app.inject({ method: "GET", url: "/live/pulse", headers: { cookie } });
    expect(p.statusCode).toBe(200); { const j = p.json(); expect(j.rails.length).toBeGreaterThan(0); expect(j.failures.ratePct).toBeGreaterThanOrEqual(0); expect(typeof j.float.total).toBe("number"); }

    const pl = LV.payloadsFor(db.intents.find((i) => i.id === run.intentId)!);
    expect(pl.records.length).toBeGreaterThan(0);
    await app.close();
  });
});
