import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as I from "../src/iam.js";
import * as OIDC from "../src/oidc.js";
import { patchActive } from "../src/scim.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
afterEach(() => { vi.useRealTimers(); });
const user = (id: string) => P.getUser(id)!;
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); expect(r.statusCode).toBe(200); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const bigPo = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 70, unitPrice: 420 }], justification: "Line 4 retrofit" });
const seedIdp = (scope = "platform") => sql.prepare("INSERT INTO idp_configs (id, scope, issuer, client_id, client_secret_enc, group_role_map, enabled, updated_at) VALUES (?,?,?,?,?,?,1,?)").run(`idp-${scope}`, scope, "http://idp.test/realms/x", "web", I.seal("s3cret"), JSON.stringify(I.DEFAULT_GROUP_MAP), new Date().toISOString());

describe("RBAC", () => {
  it("built-in roles become permission sets", () => {
    expect(I.explain(user("usr-clerk-pat"), "payments.pay").allowed).toBe(true);
    expect(I.explain(user("usr-clerk-pat"), "payments.approve").allowed).toBe(false);
    expect(I.explain(user("usr-audit-ava"), "audit.read").allowed).toBe(true);
    expect(I.explain(user("usr-audit-ava"), "treasury.sweep").allowed).toBe(false);
    expect(I.explain(user("usr-op-olivia"), "suppliers.review").allowed).toBe(false);
  });
  it("custom role with an amount limit and entity scope explains each decision", () => {
    const r = I.saveRole(user("usr-cfo-jane"), "tnt-acme", { name: "Small approver", baseRole: "approver", permissions: ["payments.approve", "workspace.read"], approveLimit: 1000, entityScope: ["tnt-acme"] });
    I.assignRole(user("usr-cfo-jane"), "usr-controller-sam", r.id);
    const sam = user("usr-controller-sam");
    expect(I.explain(sam, "payments.approve", { amount: 900 }).allowed).toBe(true);
    const over = I.explain(sam, "payments.approve", { amount: 5000 });
    expect(over.allowed).toBe(false); expect(over.reasons.at(-1)!.text).toMatch(/above the limit of 1000/);
    expect(I.explain(sam, "payments.pay").allowed).toBe(false);
    expect(I.explain(sam, "payments.approve", { tenantId: "tnt-globex" }).allowed).toBe(false);
  });
  it("client admins cannot grant operator permissions or edit another tenant's roles", () => {
    expect(() => I.saveRole(user("usr-cfo-jane"), "tnt-acme", { name: "Sweeper", permissions: ["treasury.sweep"] })).toThrow(/Not allowed/);
    const r = I.saveRole(user("usr-globex-gina"), "tnt-globex", { name: "Globex view", permissions: ["workspace.read"] });
    expect(() => I.assignRole(user("usr-cfo-jane"), "usr-controller-sam", r.id)).toThrow(/another tenant/);
    expect(() => I.assignRole(user("usr-cfo-jane"), "usr-cfo-jane", "approver")).toThrow(/own role/);
  });
  it("routes enforce permissions and the approve amount limit", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "POST", url: "/workspace/rules", headers: { cookie: pat }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: "/ops/kpis", headers: { cookie: pat } })).statusCode).toBe(403);
    const r = I.saveRole(user("usr-cfo-jane"), "tnt-acme", { name: "Small approver", baseRole: "approver", permissions: ["payments.approve", "workspace.read"], approveLimit: 1000 });
    I.assignRole(user("usr-cfo-jane"), "usr-controller-sam", r.id);
    const po = bigPo(); const sam = await login(app, "usr-controller-sam");
    const res = await app.inject({ method: "POST", url: `/approvals/${po.id}`, headers: { cookie: sam }, payload: { approve: true } });
    expect(res.statusCode).toBe(403); expect(res.json().error).toMatch(/above the limit/);
    const chk = (await app.inject({ url: `/iam/check?permission=payments.approve&amount=${po.total}`, headers: { cookie: sam } })).json();
    expect(chk.allowed).toBe(false); expect(chk.reasons.length).toBeGreaterThan(1);
  });
});

describe("separation of duties", () => {
  it("the approver of an order cannot release its payment", () => {
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam");
    expect(() => I.sodPay(user("usr-controller-sam"), po as any)).toThrow(/Separation of duties/);
    expect(() => I.sodPay(user("usr-clerk-pat"), po as any)).not.toThrow();
  });
  it("the maker cannot be the checker", () => {
    seedIdp();
    const c = P.requestChange(user("usr-op-olivia"), "identity.oidc", { id: "idp-platform", scope: "platform", issuer: "http://idp.test/realms/y", clientId: "web2", groupRoleMap: I.DEFAULT_GROUP_MAP });
    expect(() => P.decideChange(user("usr-op-olivia"), c.id, true)).toThrow(/maker/);
    P.decideChange(user("usr-op-omar"), c.id, true);
    expect(I.getIdp("idp-platform")!.clientId).toBe("web2"); expect(I.getIdp("idp-platform")!.secret()).toBe("s3cret");
  });
  it("never stores a plain client secret in the change queue", () => {
    const c = P.requestChange(user("usr-op-olivia"), "identity.oidc", { scope: "bank-harbor", issuer: "https://idp.harbor.test", clientId: "h", clientSecret: "plain-value" });
    const raw = (sql.prepare("SELECT payload FROM pending_changes WHERE id = ?").get(c.id) as any).payload;
    expect(raw).not.toContain("plain-value");
  });
});

describe("OIDC callback claim mapping", () => {
  it("maps tenant and groups and provisions just in time", () => {
    seedIdp();
    const { user: u } = OIDC.completeLogin("idp-platform", { sub: "kc-1", email: "new.person@acme.demo", name: "New Person", tenant: "tnt-acme", groups: ["approver", "ap_clerk"] }, "id.token.fake");
    expect(u.tenantId).toBe("tnt-acme"); expect(u.role).toBe("approver"); expect(u.source).toBe("oidc");
    const again = OIDC.completeLogin("idp-platform", { sub: "kc-1", email: "new.person@acme.demo", tenant: "tnt-acme", groups: ["ap_clerk"] }).user;
    expect(again.id).toBe(u.id); expect(again.role).toBe("ap_clerk");
    expect(db.evidence.some((e) => e.event === "user.jit_created")).toBe(true);
  });
  it("reuses seeded users by email and maps operator staff", () => {
    seedIdp();
    expect(OIDC.completeLogin("idp-platform", { sub: "kc-o", email: "olivia@operator.demo", tenant: "operator", groups: ["/operator_admin"] }).user.id).toBe("usr-op-olivia");
  });
  it("rejects claims outside the provider scope or without a mapped group", () => {
    seedIdp("bank-northstar");
    const idp = I.getIdp("idp-bank-northstar")!;
    expect(() => I.mapClaims({ sub: "a", email: "a@x", tenant: "tnt-globex", groups: ["approver"] }, idp)).toThrow(/not a client of bank-northstar/);
    expect(() => I.mapClaims({ sub: "a", email: "a@x", tenant: "operator", groups: ["operator_admin"] }, idp)).toThrow(/platform/);
    expect(() => I.mapClaims({ sub: "a", email: "a@x", tenant: "tnt-acme", groups: ["operator_admin"] }, idp)).toThrow(/No group/);
    expect(() => I.mapClaims({ sub: "a", email: "a@x", groups: ["approver"] }, idp)).toThrow(/tenant claim/);
  });
});

describe("sessions", () => {
  it("expire on idle and absolute timeouts and audit it", () => {
    const t0 = Date.parse("2026-01-01T09:00:00Z");
    const id = I.createSession(user("usr-cfo-jane"), "demo", {}, t0);
    expect(I.sessionUser(id, t0 + 10 * 60_000)?.user.id).toBe("usr-cfo-jane");
    expect(I.sessionUser(id, t0 + 10 * 60_000 + I.idleMs())).toBeNull();
    expect(db.evidence.some((e) => e.event === "session.expired")).toBe(true);
    let t = t0; const id2 = I.createSession(user("usr-cfo-jane"), "demo", {}, t0);
    while (t < t0 + I.absoluteMs() - 20 * 60_000) { t += 20 * 60_000; expect(I.sessionUser(id2, t)).not.toBeNull(); }
    expect(I.sessionUser(id2, t0 + I.absoluteMs())).toBeNull();
  });
  it("cookie is httpOnly and sameSite lax, sessions can be listed and revoked", async () => {
    const app = await buildApp();
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-clerk-pat" } });
    const c = r.cookies.find((x: any) => x.name === "sid")!; expect(c.httpOnly).toBe(true); expect(String(c.sameSite).toLowerCase()).toBe("lax");
    const pat = `sid=${c.value}`; const jane = await login(app, "usr-cfo-jane");
    const list = (await app.inject({ url: "/sessions", headers: { cookie: jane } })).json();
    const pats = list.sessions.find((s: any) => s.userId === "usr-clerk-pat"); expect(pats).toBeTruthy();
    expect((await app.inject({ method: "POST", url: `/sessions/${list.sessions.find((s: any) => s.userId === "usr-cfo-jane").id}/revoke`, headers: { cookie: pat } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/sessions/${pats.id}/revoke`, headers: { cookie: jane } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/me", headers: { cookie: pat } })).statusCode).toBe(401);
    expect(db.evidence.some((e) => e.event === "session.revoked")).toBe(true);
  });
  it("demo login is off unless DEMO_LOGIN=1", async () => {
    const app = await buildApp(); const old = process.env.DEMO_LOGIN; process.env.DEMO_LOGIN = "0";
    try {
      expect((await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-cfo-jane" } })).statusCode).toBe(404);
      expect((await app.inject({ url: "/auth/config" })).json().demo).toBe(false);
    } finally { process.env.DEMO_LOGIN = old; }
  });
});

describe("SCIM 2.0", () => {
  it("parses active patches in path and value forms", () => {
    expect(patchActive({ Operations: [{ op: "replace", path: "active", value: false }] })).toBe(false);
    expect(patchActive({ Operations: [{ op: "Replace", value: { active: "True" } }] })).toBe(true);
    expect(() => patchActive({ Operations: [{ op: "replace", path: "name", value: 1 }] })).toThrow();
  });
  it("provisions users and groups with a hashed per tenant token", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane");
    const tok = (await app.inject({ method: "POST", url: "/dev/scim-tokens", headers: { cookie: jane }, payload: {} })).json();
    expect(tok.token).toMatch(/^scim_/);
    expect((sql.prepare("SELECT COUNT(*) n FROM scim_tokens WHERE hash = ?").get(tok.token) as any).n).toBe(0);
    const H = { authorization: `Bearer ${tok.token}`, "content-type": "application/scim+json" };
    expect((await app.inject({ url: "/scim/v2/Users" })).statusCode).toBe(401);
    const list = (await app.inject({ url: "/scim/v2/Users", headers: H })).json();
    expect(list.totalResults).toBe(4); expect(list.Resources.every((u: any) => u.userName.endsWith("@acme.demo"))).toBe(true);
    const created = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: H, payload: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "nia@acme.demo", name: { givenName: "Nia", familyName: "Ross" } }) });
    expect(created.statusCode).toBe(201); const nia = created.json();
    expect((await app.inject({ url: `/scim/v2/Users?filter=${encodeURIComponent('userName eq "nia@acme.demo"')}`, headers: H })).json().totalResults).toBe(1);
    expect((await app.inject({ method: "POST", url: "/scim/v2/Users", headers: H, payload: JSON.stringify({ userName: "nia@acme.demo" }) })).statusCode).toBe(409);
    const g = await app.inject({ method: "POST", url: "/scim/v2/Groups", headers: H, payload: JSON.stringify({ displayName: "Payables", members: [{ value: nia.id }] }) });
    expect(g.statusCode).toBe(201); expect(g.json().members[0].value).toBe(nia.id);
    await app.inject({ method: "PATCH", url: `/scim/v2/Groups/approver`, headers: H, payload: JSON.stringify({ Operations: [{ op: "add", path: "members", value: [{ value: nia.id }] }] }) });
    expect(user(nia.id).role).toBe("approver");
    const niaCookie = `sid=${I.createSession(user(nia.id), "demo")}`;
    const off = await app.inject({ method: "PATCH", url: `/scim/v2/Users/${nia.id}`, headers: H, payload: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: false }] }) });
    expect(off.json().active).toBe(false);
    expect((await app.inject({ url: "/me", headers: { cookie: niaCookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/scim/v2/Users/usr-globex-gina`, headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/scim/v2/Users/${nia.id}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/scim/v2/Groups/${g.json().id}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/scim/v2/Groups/approver`, headers: H })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: `/dev/scim-tokens/${tok.id}/revoke`, headers: { cookie: jane }, payload: {} });
    expect((await app.inject({ url: "/scim/v2/Users", headers: H })).statusCode).toBe(401);
  });
});
