import { describe, it, expect, beforeEach } from "vitest";
import { sql, useDb } from "../src/db.js";
import { reset, reload, db, onChange } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";
import { verifyChain } from "../src/modules/evidence.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); S.bootstrap(); P.seedPlatform(); });

const login = async (app: any, userId: string) => {
  const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((x: any) => x.name === "sid"); return `sid=${c.value}`;
};

describe("sqlite store", () => {
  it("runs migrations and creates every table", () => {
    const names = (sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of ["tenants", "users", "agents", "mandates", "suppliers", "pos", "invoices", "payment_intents", "rail_events", "journals", "cases", "audit", "pending_changes", "idempotency_keys", "provider_events"]) expect(names).toContain(t);
  });
  it("round trips the domain state and maps intent status", async () => {
    await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const before = JSON.parse(JSON.stringify(db));
    reload();
    expect(JSON.parse(JSON.stringify(db))).toEqual(before);
    expect((sql.prepare("SELECT status FROM payment_intents").get() as any).status).toBe("settled");
    expect((sql.prepare("SELECT COUNT(*) n FROM audit").get() as any).n).toBe(db.evidence.length);
    expect(verifyChain(db.evidence).valid).toBe(true);
  });
  it("emits change events on save", () => {
    const seen: string[] = []; const off = onChange((e) => seen.push(e.type));
    S.setKillSwitch(true); off();
    expect(seen).toContain("state.changed");
  });
  it("seeds two banks, two clients and a user per role", () => {
    const t = P.listTenants();
    expect(t.filter((x) => x.kind === "bank")).toHaveLength(2);
    expect(t.filter((x) => x.kind === "client")).toHaveLength(2);
    expect(new Set(P.listUsers().map((u) => u.role))).toEqual(new Set(P.ROLES));
  });
});

describe("auth", () => {
  it("demo login sets a signed cookie and /me returns user, tenant and theme", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: "/me" })).statusCode).toBe(401);
    const cookie = await login(app, "usr-cfo-jane");
    const me = (await app.inject({ url: "/me", headers: { cookie } })).json();
    expect(me.user.role).toBe("client_admin"); expect(me.tenant.id).toBe("tnt-acme");
    expect(me.theme.name).toBe("Northstar Bank"); expect(me.tenants).toHaveLength(1);
  });
  it("rejects a forged cookie", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: "/me", headers: { cookie: "sid=usr-op-olivia.forged" } })).statusCode).toBe(401);
  });
  it("role guard blocks a clerk from editing branding and allows an operator", async () => {
    const app = await buildApp();
    const clerk = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "PATCH", url: "/tenants/tnt-acme/branding", headers: { cookie: clerk }, payload: { primary: "#000000" } })).statusCode).toBe(403);
    const op = await login(app, "usr-op-olivia");
    const r = await app.inject({ method: "PATCH", url: "/tenants/bank-harbor/branding", headers: { cookie: op }, payload: { primary: "#112233" } });
    expect(r.statusCode).toBe(200); expect(r.json().branding.primary).toBe("#112233");
    expect((await app.inject({ method: "PATCH", url: "/tenants/bank-harbor/branding", headers: { cookie: op }, payload: { primary: "red" } })).statusCode).toBe(422);
  });
  it("audits every mutating call into the evidence chain", async () => {
    const app = await buildApp();
    const op = await login(app, "usr-op-olivia");
    await app.inject({ method: "POST", url: "/kill-switch", headers: { cookie: op }, payload: { on: true } });
    const last = db.evidence[db.evidence.length - 1];
    expect(last.event).toBe("api.post"); expect((last.payload as any).actor).toBe("usr-op-olivia");
    expect(verifyChain(db.evidence).valid).toBe(true);
  });
});

describe("maker-checker", () => {
  const change = { kind: "rail.settings", payload: { tenantId: "tnt-acme", rail: "stripe_ach", setting: { env: "sandbox" } } };
  it("maker cannot approve own change, a second operator can", async () => {
    const app = await buildApp();
    const olivia = await login(app, "usr-op-olivia"); const omar = await login(app, "usr-op-omar");
    const c = (await app.inject({ method: "POST", url: "/changes", headers: { cookie: olivia }, payload: change })).json();
    expect(c.status).toBe("pending");
    expect((await app.inject({ method: "POST", url: `/changes/${c.id}/decide`, headers: { cookie: olivia }, payload: { approve: true } })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `/changes/${c.id}/decide`, headers: { cookie: omar }, payload: { approve: true } });
    expect(r.statusCode).toBe(200); expect(r.json().change.approvedBy).toBe("usr-op-omar");
    expect((await app.inject({ method: "POST", url: `/changes/${c.id}/decide`, headers: { cookie: omar }, payload: { approve: true } })).statusCode).toBe(409);
  });
  it("checker needs the required role", () => {
    const c = P.requestChange(P.getUser("usr-op-olivia")!, change.kind, change.payload);
    expect(() => P.decideChange(P.getUser("usr-controller-sam")!, c.id, true)).toThrow(/operator_admin/);
  });
  it("live mode is refused without live keys", () => {
    expect(() => P.requestChange(P.getUser("usr-op-olivia")!, "rail.settings", { tenantId: "tnt-acme", rail: "stripe_card", setting: { env: "live" } })).toThrow(/live keys/);
  });
});
