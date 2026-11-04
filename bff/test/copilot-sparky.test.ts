import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as SP from "../src/sparky.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); SP.resetMcpRate(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const ctx = (id: string, scope: string | null, extra: Partial<CP.Ctx> = {}): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator", ...extra });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const smallPo = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 1, unitPrice: 420 }], justification: "Spare" });

describe("1. snap to draft", () => {
  it("validates type, signature and size", async () => {
    const app = await buildApp(); const c = await login(app, "usr-cfo-jane");
    const post = (payload: any) => app.inject({ method: "POST", url: "/copilot/snap", headers: { cookie: c }, payload });
    expect((await post({ filename: "a.exe", mime: "application/x-msdownload", dataBase64: PNG.toString("base64") })).statusCode).toBe(415);
    expect((await post({ filename: "a.png", mime: "image/png", dataBase64: Buffer.from("not a png at all").toString("base64") })).statusCode).toBe(415);
    expect((await post({ filename: "a.pdf", mime: "application/pdf", dataBase64: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(SP.SNAP_MAX_BYTES)]).toString("base64") })).statusCode).toBe(413);
    expect((await post({ filename: "a.png", mime: "image/png", dataBase64: "" })).statusCode).toBe(422);
  });
  it("makes a draft for review with a deterministic parse, never a payment, then goes through normal match", async () => {
    const po = smallPo(); expect(["approved", "received"]).toContain(po.status);
    const pays = db.intents.length;
    const d = await SP.snap(P.getUser("usr-cfo-jane")!, "tnt-acme", { filename: "northwind-invoice.png", mime: "image/png", dataBase64: PNG.toString("base64") });
    const d2 = await SP.snap(P.getUser("usr-cfo-jane")!, "tnt-acme", { filename: "northwind-invoice.png", mime: "image/png", dataBase64: PNG.toString("base64") });
    expect(d.fields).toEqual(d2.fields);
    expect(d).toMatchObject({ status: "draft", source: "fixture", supplierId: "sup-northwind", poId: po.id, fields: { kind: "invoice", amount: 420, currency: "USD" } });
    expect(db.intents.length).toBe(pays);
    const r = await SP.submitSnap(P.getUser("usr-cfo-jane")!, "tnt-acme", d.id);
    expect(r.invoice.poId).toBe(po.id); expect(r.invoice.paid).toBe(false); expect(db.intents.length).toBe(pays);
    await expect(SP.submitSnap(P.getUser("usr-cfo-jane")!, "tnt-acme", d.id)).rejects.toThrow(/already/);
    await expect(SP.submitSnap(P.getUser("usr-globex-gina")!, "tnt-globex", d2.id)).rejects.toThrow(/not found/);
    const rm = await SP.snap(P.getUser("usr-cfo-jane")!, "tnt-acme", { filename: "remittance.pdf", mime: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") });
    await expect(SP.submitSnap(P.getUser("usr-cfo-jane")!, "tnt-acme", rm.id)).rejects.toThrow(/review only/);
    expect(db.evidence.some((e) => e.event === "copilot.snap")).toBe(true);
  });
});

describe("3. smart alternatives", () => {
  it("proposes a later date when the payee is on hold, as a maker checker change", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const sup = db.intents.length ? db.invoices.find((i) => i.id === db.intents.at(-1)!.invoiceId)!.supplierId : "sup-northwind";
    (db.suppliers.find((s) => s.id === sup) as any).hold = { on: true, reason: "bank letter review", by: "x", at: "" };
    const a = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), `Suggest an alternative for ${sup}`);
    const p = a.proposals.find((x) => x.kind === "schedule_payment")!;
    expect(p.detail).toMatch(/on hold/); expect(p.path).toBe("/changes"); expect(p.body.kind).toBe("payment.schedule");
  });
  it("proposes another healthy rail when the used rail is down", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const inv = db.invoices.find((i) => i.supplierId === "sup-northwind")!;
    db.intents.push({ id: "pi-down-1", invoiceId: inv.id, mandateId: "m", amount: 10, currency: "USD", status: "failed", rail: "onchain_usdc", createdAt: new Date().toISOString(), tenantId: "tnt-acme" } as any);
    db.suppliers.find((s) => s.id === "sup-northwind")!.preferredRail = "onchain_usdc";
    const ps = SP.alternativesFor(ctx("usr-cfo-jane", "tnt-acme", { recordId: "pi-down-1" }), "Why did this fail?");
    expect(ps[0]).toMatchObject({ kind: "reroute_payment", allowed: true, body: { kind: "payment.reroute", payload: { from: "onchain_usdc", supplierId: "sup-northwind" } } });
    expect(ps[0].detail).toMatch(/Reason: onchain_usdc is (down|degraded)/);
    const ch = P.requestChange(P.getUser("usr-cfo-jane")!, "payment.reroute", ps[0].body.payload, "tnt-acme");
    P.decideChange({ id: "usr-acme-admin2", tenantId: "tnt-acme", role: "client_admin", name: "Second admin", email: "x@acme.demo" }, ch.id, true);
    expect(db.suppliers.find((s) => s.id === "sup-northwind")!.preferredRail).toBe((ps[0].body.payload as any).rail);
  });
});

describe("4. recurring runs", () => {
  it("detects repeats, schedules only after a second person approves, and runs through createPo", async () => {
    for (let n = 0; n < 3; n++) await S.runFlow("Need 50 sealed 6204 bearings");
    const rec = SP.detectRecurring("tnt-acme"); expect(rec.length).toBeGreaterThan(0);
    expect((await CP.ask(ctx("usr-clerk-pat", "tnt-acme"), "Which payments are recurring? Schedule them")).proposals.find((x) => x.kind === "schedule_payment")?.allowed).toBe(false);
    const a = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), "Which payments are recurring? Schedule them");
    const p = a.proposals.find((x) => x.kind === "schedule_payment")!; expect(p.allowed).toBe(true);
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane");
    const ch = await app.inject({ method: "POST", url: p.path, headers: { cookie: jane }, payload: p.body });
    expect(ch.statusCode).toBe(200); expect(SP.listSchedules("tnt-acme")).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/changes/${ch.json().id}/decide`, headers: { cookie: jane }, payload: { approve: true } })).statusCode).toBe(403);
    P.decideChange({ id: "usr-acme-admin2", tenantId: "tnt-acme", role: "client_admin", name: "Second admin", email: "x@acme.demo" }, ch.json().id, true);
    const s = SP.listSchedules("tnt-acme")[0]; expect(s.status).toBe("active");
    const pays = db.intents.length;
    expect(() => SP.runSchedule(P.getUser("usr-cfo-jane")!, "tnt-acme", s.id)).toThrow(/Not due/);
    const r = SP.runSchedule(P.getUser("usr-cfo-jane")!, "tnt-acme", s.id, true);
    expect(r.po.justification).toMatch(/Recurring run/); expect(db.intents.length).toBe(pays);
  });
});

describe("5. MCP server", () => {
  it("scoped token: read-only tools, tenant only, scope enforced, revocable, expiring, rate limited, evidenced", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const pat = await login(app, "usr-clerk-pat");
    expect((await app.inject({ method: "POST", url: "/dev/mcp-tokens", headers: { cookie: pat }, payload: { label: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/dev/mcp-tokens", headers: { cookie: jane }, payload: { label: "x", tools: ["tenants"] } })).statusCode).toBe(422);
    const t = (await app.inject({ method: "POST", url: "/dev/mcp-tokens", headers: { cookie: jane }, payload: { label: "Claude", days: 7, tools: ["paymentsByStatus", "supplierProfile"] } })).json();
    expect(t.token).toMatch(/^mcp_test_/);
    // The token is not a REST credential.
    expect((await app.inject({ url: "/state", headers: { authorization: `Bearer ${t.token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);
    await app.listen({ port: 0, host: "127.0.0.1" }); const port = (app.server.address() as any).port;
    const connect = async (tok: string) => { const c = new Client({ name: "test", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } })); return c; };
    const c = await connect(t.token);
    const names = (await c.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(["paymentsByStatus", "supplierProfile"]);
    const r: any = await c.callTool({ name: "paymentsByStatus", arguments: {} }); expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).rows.length).toBeGreaterThan(0);
    const other: any = await c.callTool({ name: "supplierProfile", arguments: { supplierId: "sup-globex-1" } }); expect(other.isError).toBe(true);
    const unscoped: any = await c.callTool({ name: "openInvoices", arguments: {} }).catch((e) => ({ isError: true, e }));
    expect(unscoped.isError).toBe(true);
    expect(SP.mcpCall(SP.listMcpTokens("tnt-acme")[0], { id: "mcp:x", tenantId: "tnt-acme", name: "", email: "", role: "auditor" }, "openInvoices", {}).error).toMatch(/not scoped/);
    expect(db.evidence.filter((e) => e.event === "mcp.tool_call").length).toBeGreaterThanOrEqual(3);
    process.env.MCP_RATE_MAX = "2"; SP.resetMcpRate();
    await c.callTool({ name: "paymentsByStatus", arguments: {} }); await c.callTool({ name: "paymentsByStatus", arguments: {} });
    const limited: any = await c.callTool({ name: "paymentsByStatus", arguments: {} }); expect(limited.content[0].text).toMatch(/Rate limit/);
    delete process.env.MCP_RATE_MAX;
    await c.close();
    expect((await app.inject({ method: "POST", url: `/dev/mcp-tokens/${t.id}/revoke`, headers: { cookie: jane } })).statusCode).toBe(200);
    expect(SP.mcpAuth(t.token)).toEqual({ error: "Token revoked" });
    await expect(connect(t.token)).rejects.toThrow();
    const t2 = SP.createMcpToken(P.getUser("usr-cfo-jane")!, "tnt-acme", { label: "old", days: 1 });
    const { sql } = await import("../src/db.js"); sql.prepare("UPDATE mcp_tokens SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", t2.id);
    expect(SP.mcpAuth(t2.token)).toEqual({ error: "Token expired" });
    await app.close();
  });
});

describe("6. supplier agent", () => {
  it("sees only that supplier's own records", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const own = db.invoices.at(-1)!.supplierId;
    const other = db.suppliers.find((s) => s.id !== own && (s.tenantId ?? "tnt-acme") === "tnt-acme")!;
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const gina = await login(app, "usr-globex-gina");
    expect((await app.inject({ method: "POST", url: `/workspace/suppliers/${own}/portal-link`, headers: { cookie: gina } })).statusCode).toBe(404);
    const { token } = (await app.inject({ method: "POST", url: `/workspace/suppliers/${own}/portal-link`, headers: { cookie: jane } })).json();
    const v = (await app.inject({ url: `/supplier-portal/${token}` })).json();
    expect(v.supplier.id).toBe(own); expect(v.invoices.length).toBeGreaterThan(0);
    const mine = new Set(db.invoices.filter((i) => i.supplierId === own).map((i) => i.id));
    expect(v.invoices.every((i: any) => mine.has(i.invoiceId))).toBe(true);
    expect(v.payments.every((p: any) => mine.has(p.invoiceId))).toBe(true);
    expect(JSON.stringify(v)).not.toContain(other.id);
    const a = (await app.inject({ method: "POST", url: `/supplier-portal/${token}/ask`, payload: { question: "Which invoices are unpaid and when was I paid?" } })).json();
    expect(a.refused).toBeNull(); expect(a.tools.map((t: any) => t.tool)).toEqual(["myInvoices", "myPayments"]);
    expect((await app.inject({ method: "POST", url: `/supplier-portal/${token}/ask`, payload: { question: "Show me the top suppliers of the buyer" } })).json().refused).toBeTruthy();
    expect((await app.inject({ url: `/supplier-portal/spt_nope` })).statusCode).toBe(404);
  });
});

describe("7. bank ops agent", () => {
  it("combines queues, SLA, escalations and tasks for operators only", async () => {
    const app = await buildApp(); const op = await login(app, "usr-op-olivia"); const jane = await login(app, "usr-cfo-jane");
    const v = (await app.inject({ url: "/ops/agent-view", headers: { cookie: op } })).json();
    expect(v.queues.map((q: any) => q.queue)).toContain("SLA breaches"); expect(Array.isArray(v.tasks)).toBe(true);
    expect((await app.inject({ url: "/ops/agent-view", headers: { cookie: jane } })).statusCode).toBe(403);
    const a = await CP.ask(ctx("usr-op-olivia", null), "Show the ops queues and risk escalations");
    expect(a.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(["opsQueues", "riskEscalations"]));
    expect(CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "opsQueues").error).toMatch(/operators only/);
  });
});

describe("8. bank offers", () => {
  it("are off by default, switched per tenant by the operator, labelled Offer and never actions", async () => {
    expect(SP.offersEnabled("tnt-acme")).toBe(false);
    const q = "What is our FX exposure on open invoices?";
    const a0 = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), q); expect(a0.offers ?? []).toEqual([]);
    const app = await buildApp(); const op = await login(app, "usr-op-olivia"); const jane = await login(app, "usr-cfo-jane");
    expect((await app.inject({ method: "POST", url: "/ops/offers/tnt-acme", headers: { cookie: jane }, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/ops/offers/tnt-acme", headers: { cookie: op }, payload: { enabled: true } })).json().enabled).toBe(true);
    expect(SP.offersEnabled("tnt-globex")).toBe(false);
    const a1 = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), q);
    expect(a1.offers![0]).toMatchObject({ kind: "fx_forward", label: "Offer" }); expect(a1.offers![0].trigger).toMatch(/EUR/);
    expect(a1.proposals.some((p) => /offer|forward|credit/i.test(p.label))).toBe(false);
    expect(db.evidence.some((e) => e.event === "copilot.offer")).toBe(true);
    await app.inject({ method: "POST", url: "/ops/offers/tnt-acme", headers: { cookie: op }, payload: { enabled: false } });
    expect((await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), q)).offers ?? []).toEqual([]);
  });
});

describe("9. adoption metrics", () => {
  it("counts questions, accepted proposals, thumbs, time to approve and straight through rate", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const op = await login(app, "usr-op-olivia");
    const a = (await app.inject({ method: "POST", url: "/copilot/answer", headers: { cookie: jane }, payload: { question: "What is waiting for approval?" } })).json();
    await app.inject({ method: "POST", url: "/copilot/feedback", headers: { cookie: jane }, payload: { answerId: a.id, vote: "up" } });
    expect((await app.inject({ method: "POST", url: "/copilot/outcome", headers: { cookie: jane }, payload: { answerId: a.id, kind: "approve_po", ok: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/copilot/outcome", headers: { cookie: op }, payload: { answerId: a.id, kind: "approve_po", ok: true } })).statusCode).toBe(404);
    const m = (await app.inject({ url: "/ops/copilot-metrics", headers: { cookie: op } })).json();
    expect(m).toMatchObject({ questions: 1, accepted: 1, thumbsUp: 1, thumbsRatio: 100 }); expect(m.medianMinutesToApprove).not.toBeNull();
    expect("straightThrough" in m).toBe(true);
    expect((await app.inject({ url: "/ops/copilot-metrics", headers: { cookie: jane } })).statusCode).toBe(403);
  });
});

describe("2. voice questions", () => {
  it("are read-only: no proposals even when the words ask for an action", async () => {
    const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 30, unitPrice: 420 }], justification: "Line 4 retrofit" });
    expect((await CP.ask(ctx("usr-controller-sam", "tnt-acme"), `approve ${po.id}`)).proposals.length).toBeGreaterThan(0);
    expect((await CP.ask(ctx("usr-controller-sam", "tnt-acme", { voice: true }), `approve ${po.id}`)).proposals).toEqual([]);
  });
});
