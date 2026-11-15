import { describe, it, expect, beforeEach } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as RT from "../src/retention.js";
import { installFakes } from "./fakeRail.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); installFakes(); });
const op = () => P.getUser("usr-op-olivia")!;
const later = Date.now() + 400 * 86_400_000;
const settledFlow = async () => { const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements(); return db.intents.find((i) => i.id === r.intentId)!; };

describe("retention policies and purge", () => {
  it("validates policies and is operator only", () => {
    expect(() => RT.setPolicy(op(), "widgets", 30)).toThrow(/Record type/);
    expect(() => RT.setPolicy(op(), "audit", 0)).toThrow(/whole number/);
    expect(() => RT.setPolicy(P.getUser("usr-cfo-jane")!, "audit", 30)).toThrow(/Operators only/);
    expect(RT.setPolicy(op(), "payments", 30).days).toBe(30);
    expect(RT.setPolicy(op(), "payments", null).days).toBeNull();
  });
  it("a legal hold on the client blocks the purge, release lets it run, and the run is audited", async () => {
    const pi = await settledFlow(); expect(pi.status).toBe("settled");
    for (const t of RT.RECORD_TYPES) RT.setPolicy(op(), t, 30);
    const h = RT.placeHold(op(), { tenantId: "tnt-acme", reason: "Litigation notice" });
    const r1 = RT.purge(op(), later);
    expect(r1.removedIds.payments).not.toContain(pi.id); expect(r1.skippedForHold.payments).toBeGreaterThan(0);
    expect(db.intents.some((i) => i.id === pi.id)).toBe(true);
    RT.releaseHold(op(), h.id);
    const r2 = RT.purge(op(), later);
    expect(r2.removedIds.payments).toContain(pi.id); expect(db.intents.some((i) => i.id === pi.id)).toBe(false);
    expect(r2.removed.audit).toBeGreaterThan(0); expect(db.auditAnchor?.seq).toBeGreaterThan(0);
    const last = db.evidence[db.evidence.length - 1]; expect(last.event).toBe("retention.purged"); expect((last.payload as any).removedIds.payments).toContain(pi.id);
    expect(RT.verify().valid).toBe(true);
  });
  it("a case hold keeps that case's payment while others go", async () => {
    const a = await settledFlow(); const b = await settledFlow();
    const c = S.openCase({ tenantId: "tnt-acme", kind: "dispute", intentId: a.id, title: "Disputed bearings", detail: {} });
    RT.placeHold(op(), { caseId: c.id, reason: "Dispute evidence" });
    RT.setPolicy(op(), "payments", 30);
    const r = RT.purge(op(), later);
    expect(r.removedIds.payments).toContain(b.id); expect(r.removedIds.payments).not.toContain(a.id);
  });
});

describe("audit export and verify", () => {
  it("verify finds the first tampered row", async () => {
    await settledFlow();
    expect(RT.verify()).toMatchObject({ valid: true, brokenAt: null });
    const row = sql.prepare("SELECT seq, data FROM audit ORDER BY seq LIMIT 1 OFFSET 2").get() as { seq: number; data: string };
    const d = JSON.parse(row.data); d.payload = { ...(d.payload ?? {}), tampered: true };
    sql.prepare("UPDATE audit SET data = ? WHERE seq = ?").run(JSON.stringify(d), row.seq);
    expect(RT.verify()).toMatchObject({ valid: false, brokenAt: row.seq });
  });
  it("exports JSONL for one client and date range over HTTP, operators only", async () => {
    await settledFlow();
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const olivia = await login("usr-op-olivia"); const jane = await login("usr-cfo-jane");
    const today = new Date().toISOString().slice(0, 10);
    const r = await app.inject({ method: "GET", url: `/ops/audit/export.jsonl?tenantId=tnt-acme&from=${today}&to=${today}`, headers: { cookie: olivia } });
    expect(r.statusCode).toBe(200);
    const lines = r.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0); expect(lines.every((l) => RT.auditTenant(l) === "tnt-acme")).toBe(true);
    const none = await app.inject({ method: "GET", url: `/ops/audit/export.jsonl?tenantId=tnt-acme&from=2001-01-01&to=2001-01-02`, headers: { cookie: olivia } });
    expect(none.body.trim()).toBe("");
    expect((await app.inject({ method: "GET", url: "/ops/audit/verify", headers: { cookie: olivia } })).json().valid).toBe(true);
    expect((await app.inject({ method: "POST", url: "/ops/retention/purge", headers: { cookie: jane } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/ops/retention/holds", headers: { cookie: olivia }, payload: { tenantId: "tnt-acme", reason: "Audit" } })).statusCode).toBe(200);
  });
});
