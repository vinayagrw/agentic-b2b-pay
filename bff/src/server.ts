import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { onChange } from "./modules/store.js";
import { appendEvidence } from "./modules/evidence.js";
import * as P from "./platform.js";
import { z } from "zod";
import { PoDraft, RegisterAgent } from "@b2b/shared";
import { db, reset, save } from "./modules/store.js";
import * as S from "./service.js";
import { RailError } from "./rails/index.js";
import { onchainAddress } from "./rails/onchain.js";
import { llmMode } from "./llm.js";
import { fileURLToPath } from "node:url";
import * as W from "./workspace.js";
import * as O from "./ops.js";
import * as D from "./developers.js";
import * as A from "./analytics.js";
import { scoped } from "./modules/store.js";

/** MCP style tool registry. Same names as REST operations. */
export const TOOLS = [
  { name: "draft_purchase_order", description: "Turn a natural language need into a PO draft", input: { need: "string" }, run: (a: any) => S.draftPo(String(a.need)) },
  { name: "create_purchase_order", description: "Submit PO draft, runs policy engine", input: { draft: "PoDraft" }, run: (a: any) => S.createPo(PoDraft.parse(a.draft)) },
  { name: "evaluate_policy", description: "Dry run policy for supplier, category and amount", input: { supplierId: "string", category: "string", amount: "number" }, run: (a: any) => S.policyFor("agt-buyer-1", a.supplierId, a.category, Number(a.amount)).decision },
  { name: "submit_invoice", description: "Supplier agent submits invoice text for a PO", input: { poId: "string", text: "string" }, run: (a: any) => S.submitInvoice(a.poId, a.text) },
  { name: "match_invoice", description: "Run 3-way match", input: { invoiceId: "string" }, run: (a: any) => S.matchInvoice(a.invoiceId) },
  { name: "execute_payment", description: "Route, screen, sign and settle a matched invoice", input: { invoiceId: "string", idempotencyKey: "string" }, run: (a: any) => S.payInvoice(a.invoiceId, a.idempotencyKey) },
  { name: "get_evidence", description: "Evidence chain for a subject", input: { subjectId: "string" }, run: (a: any) => S.evidenceView(a.subjectId) },
];

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: true, credentials: true });
  // Keep the raw bytes for webhook signature checks, parse JSON for everything else.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req: any, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString("utf8"))); } catch (e: any) { e.statusCode = 400; done(e, undefined); }
  });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  P.seedPlatform();
  const COOKIE = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true };
  const userOf = (req: any): P.User | null => {
    const bearer = /^Bearer (\S+)$/.exec(String(req.headers?.authorization ?? ""))?.[1];
    if (bearer) return bearerUser(bearer);
    const raw = req.cookies?.sid; if (!raw) return null;
    const v = req.unsignCookie(raw); return v.valid && v.value ? P.getUser(v.value) : null;
  };
  const guard = (req: any, roles: readonly P.Role[]) => P.requireRole(userOf(req), roles);
  /** The business client a request acts on: ?tenantId for operators, otherwise the active tenant. */
  const clientOf = (req: any, u: P.User) => {
    const want = req.query?.tenantId ?? b(req).tenantId;
    const t = want ? P.tenantsFor(u).find((x) => x.id === want) : activeTenant(req, u);
    if (!t) throw new P.AuthError(403, "Not your tenant");
    if (t.kind !== "client") throw new P.AuthError(409, "Pick a business client in the tenant menu first");
    return t.id;
  };
  const ctx = (req: any, roles: readonly P.Role[] = P.ROLES) => { const u = guard(req, roles); return { u, t: clientOf(req, u) }; };
  /** Data scope for read views: a client tenant sees its own rows, an operator on a bank sees all. */
  const scopeOf = (req: any) => { const u = guard(req, P.ROLES); const t = activeTenant(req, u); return t.kind === "client" ? t.id : null; };
  const activeTenant = (req: any, u: P.User) => {
    const raw = req.cookies?.tenant; const v = raw ? req.unsignCookie(raw) : null;
    const want = v?.valid ? v.value : null; const allowed = P.tenantsFor(u);
    return allowed.find((t) => t.id === want) ?? allowed.find((t) => t.id === u.tenantId) ?? allowed[0];
  };
  // Every mutating call lands in the evidence hash chain.
  app.addHook("onSend", async (req: any, reply, payload) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.url.startsWith("/auth/") && !req.url.startsWith("/webhooks/")) {
      const u = userOf(req);
      appendEvidence(db.evidence, "api", req.routeOptions?.url ?? req.url, `api.${req.method.toLowerCase()}`, { actor: u?.id ?? "anonymous", role: u?.role ?? null, url: req.url, status: reply.statusCode });
      save();
    }
    return payload;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof P.AuthError ? err.status : err instanceof S.HttpError ? err.status : err instanceof RailError ? err.status : err instanceof z.ZodError ? 422 : err.statusCode ?? 500;
    reply.status(status).send({ error: err instanceof z.ZodError ? "validation" : err.message, issues: err instanceof z.ZodError ? err.issues : undefined });
  });
  const b = (req: any) => (req.body ?? {}) as any;
  // Every route needs a signed-in user unless listed as public. Mutations need a role from ROUTE_ROLES or a sensible default.
  const PUBLIC = new Set(["/health", "/auth/demo-users", "/auth/login", "/auth/logout", "/.well-known/agent.json", "/webhooks/stripe", "/webhooks/circle"]);
  const ADM = ["operator_admin", "client_admin"] as const; const APPR = ["operator_admin", "client_admin", "approver"] as const;
  const PAYERS = ["operator_admin", "client_admin", "approver", "ap_clerk"] as const;
  const ROUTE_ROLES: Record<string, readonly P.Role[]> = {
    "POST /reset": ["operator_admin"], "POST /kill-switch": ADM, "POST /agents": ADM, "POST /agents/:id/verify": ADM, "POST /agents/:id/suspend": ADM, "POST /agents/:id/resume": ADM,
    "POST /approvals/:poId": APPR, "POST /refunds": APPR, "POST /erp/vendor-master/changes": ADM, "POST /erp/vendor-master/changes/:id/approve": APPR, "POST /erp/vendor-master/changes/:id/callback": APPR,
    "GET /rails/balances": ["operator_admin", "client_admin", "auditor"],
  };
  app.addHook("preHandler", async (req: any) => {
    const url = req.routeOptions?.url as string | undefined;
    if (!url || PUBLIC.has(url) || url.startsWith("/uploads/") || url.startsWith("/onboard/") || req.method === "HEAD" || req.method === "OPTIONS") return;
    const roles = ROUTE_ROLES[`${req.method} ${url}`] ?? (req.method === "GET" ? P.ROLES : PAYERS);
    guard(req, roles);
  });

  // Auth (demo login: pick a seeded user, no password)
  app.get("/auth/demo-users", async () => ({ demo: true, users: P.listUsers() }));
  app.post("/auth/login", async (req, reply) => {
    const { userId } = z.object({ userId: z.string() }).parse(b(req));
    const u = P.getUser(userId); if (!u) throw new P.AuthError(401, "Unknown demo user");
    reply.setCookie("sid", u.id, COOKIE).clearCookie("tenant", { path: "/" });
    P.audit(u.id, "user", u.id, "auth.login", { role: u.role, demo: true });
    return { user: u };
  });
  app.post("/auth/logout", async (_req, reply) => { reply.clearCookie("sid", { path: "/" }).clearCookie("tenant", { path: "/" }); return { ok: true }; });
  app.get("/me", async (req) => {
    const u = userOf(req); if (!u) throw new P.AuthError(401, "Sign in required");
    const t = activeTenant(req, u);
    return { user: u, operator: P.isOperator(u), tenant: t, theme: P.themeFor(t), tenants: P.tenantsFor(u), llmMode: llmMode() };
  });
  app.post("/me/tenant", async (req, reply) => {
    const u = guard(req, P.ROLES); const id = String(b(req).tenantId);
    if (!P.tenantsFor(u).some((t) => t.id === id)) throw new P.AuthError(403, "Not your tenant");
    reply.setCookie("tenant", id, COOKIE); return { ok: true };
  });
  // Live updates
  app.get("/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write(`event: hello\ndata: {}\n\n`);
    const off = onChange((e) => reply.raw.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25000);
    req.raw.on("close", () => { off(); clearInterval(ping); });
  });
  // Tenants, branding, rail settings
  app.get("/tenants", async (req) => { const u = guard(req, P.ROLES); return P.tenantsFor(u); });
  app.get("/users", async (req) => { guard(req, ["operator_admin", "auditor"]); return P.listUsers(); });
  app.patch("/tenants/:id/branding", async (req: any) => {
    const u = guard(req, ["operator_admin", "client_admin"]);
    if (!P.canAccessTenant(u, req.params.id)) throw new P.AuthError(403, "Not your tenant");
    const t = P.updateBranding(req.params.id, b(req)); P.audit(u.id, "tenant", t.id, "branding.updated", b(req)); return t;
  });
  app.post("/tenants/:id/logo", async (req: any) => {
    const u = guard(req, ["operator_admin", "client_admin"]);
    if (!P.canAccessTenant(u, req.params.id)) throw new P.AuthError(403, "Not your tenant");
    const m = /^data:image\/(png|jpeg|svg\+xml|webp);base64,(.+)$/.exec(String(b(req).dataUrl ?? ""));
    if (!m) throw new P.AuthError(422, "Logo must be a png, jpeg, svg or webp data URL");
    const ext = m[1] === "svg+xml" ? "svg" : m[1] === "jpeg" ? "jpg" : m[1];
    const name = `${req.params.id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true }); fs.writeFileSync(path.join(config.UPLOAD_DIR, name), Buffer.from(m[2], "base64"));
    return { logo: `/api/uploads/${name}` };
  });
  app.get("/uploads/:name", async (req: any, reply) => {
    const name = path.basename(req.params.name); const f = path.join(config.UPLOAD_DIR, name);
    if (!fs.existsSync(f)) throw new P.AuthError(404, "not found");
    const ext = path.extname(name).slice(1); const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return reply.type(type).send(fs.readFileSync(f));
  });
  // Maker-checker
  app.get("/changes", async (req: any) => { const u = guard(req, P.ROLES); return P.listChanges(req.query?.status, P.isOperator(u) ? null : u.tenantId); });
  app.post("/changes", async (req) => { const u = guard(req, ["operator_admin", "client_admin"]); const x = b(req); return P.requestChange(u, String(x.kind), x.payload, x.tenantId ?? null); });
  app.post("/changes/:id/decide", async (req: any) => { const u = guard(req, P.ROLES); return P.decideChange(u, req.params.id, !!b(req).approve); });

  app.get("/health", async () => ({ ok: true, llmMode: llmMode() }));
  app.get("/state", async (req) => ({ ...scoped(scopeOf(req)), llmMode: llmMode(), signers: S.SIGNERS }));
  app.post("/reset", async () => { reset(); S.bootstrap(); return { ok: true }; });

  // Agent gateway: MCP style
  app.get("/mcp/tools", async () => ({ tools: TOOLS.map(({ run, ...t }) => t) }));
  app.post("/mcp/call", async (req) => { const { name, arguments: args } = b(req); const t = TOOLS.find((x) => x.name === name); if (!t) throw new S.HttpError(404, `unknown tool ${name}`); return { content: await t.run(args ?? {}) }; });
  // A2A style agent card
  app.get("/.well-known/agent.json", async () => ({ name: "B2B pay gateway", protocols: ["mcp", "a2a"], skills: TOOLS.map((t) => t.name), url: "http://localhost:8790" }));

  app.post("/agents", async (req) => S.registerAgent(RegisterAgent.parse(b(req))));
  app.post("/agents/:id/verify", async (req: any) => S.kyaVerify(req.params.id));
  app.post("/agents/:id/suspend", async (req: any) => S.setAgentStatus(req.params.id, "suspended"));
  app.post("/agents/:id/resume", async (req: any) => S.setAgentStatus(req.params.id, "active"));
  app.post("/kill-switch", async (req) => S.setKillSwitch(!!b(req).on));
  app.post("/policy/evaluate", async (req) => { const x = b(req); return S.policyFor(x.agentId ?? "agt-buyer-1", x.supplierId, x.category, Number(x.amount)).decision; });

  app.post("/buyer/draft", async (req) => { const { t } = ctx(req, PAYERS); return S.draftPo(z.object({ need: z.string().min(3) }).parse(b(req)).need, t); });
  app.post("/purchase-orders", async (req) => S.createPo(PoDraft.parse(b(req).draft), b(req).agentId));
  app.post("/approvals/:poId", async (req: any) => { const { u, t } = ctx(req, APPR); const po = db.pos.find((p) => p.id === req.params.poId); if (!po || (po.tenantId ?? "tnt-acme") !== t) throw new S.HttpError(404, "po not found"); return S.decideApproval(po.id, !!b(req).approve, u.id, String(b(req).comment ?? "")); });
  app.post("/goods-receipts", async (req) => S.receiveGoods(b(req).poId, Number(b(req).shortBy ?? 0)));
  app.post("/invoices/render", async (req) => ({ text: S.invoiceText(b(req).poId, { priceBumpPct: Number(b(req).priceBumpPct ?? 0), poison: !!b(req).poison }) }));
  app.post("/invoices", async (req) => S.submitInvoice(b(req).poId, String(b(req).text)));
  app.post("/invoices/:id/match", async (req: any) => S.matchInvoice(req.params.id));
  app.post("/invoices/:id/pay", async (req: any) => {
    const key = req.headers["idempotency-key"]; if (!key) throw new S.HttpError(400, "Idempotency-Key header required");
    return S.payInvoice(req.params.id, String(key), { urgency: b(req).urgency, approvers: b(req).approvers });
  });
  app.post("/refunds", async (req) => { const u = guard(req, APPR); const pi = db.intents.find((i) => i.id === b(req).paymentIntentId); if (!pi || !P.canAccessTenant(u, pi.tenantId ?? "tnt-acme")) throw new S.HttpError(404, "payment not found"); const r = await S.refund(pi.id, Number(b(req).amount), String(b(req).reason ?? "refund")); P.audit(u.id, "refund", r.id, "refund.requested_by", { amount: r.amount }); return r; });
  app.post("/erp/vendor-master/changes", async (req) => S.requestPayeeChange({ ...b(req), source: b(req).source ?? "erp" }));
  app.post("/erp/vendor-master/changes/:id/approve", async (req: any) => S.approvePayeeChange(req.params.id, String(b(req).approver)));
  app.post("/erp/vendor-master/changes/:id/callback", async (req: any) => S.callbackPayeeChange(req.params.id, !!b(req).confirmed));
  app.get("/settlements/:id", async (req: any) => db.settlements.find((s) => s.id === req.params.id) ?? { error: "not found" });
  app.get("/ledger/journals", async () => S.ledgerView());
  app.get("/statements/camt053", async (req: any, reply) => { const t = req.query?.tenantId ? clientOf(req, guard(req, P.ROLES)) : scopeOf(req); return reply.type("application/xml").header("content-disposition", `attachment; filename="camt053-${t ?? "all"}.xml"`).send(S.camt053(undefined, t)); });
  app.get("/evidence", async () => S.evidenceView());
  app.get("/evidence/:subjectId", async (req: any) => S.evidenceView(req.params.subjectId));
  app.post("/scenario/run", async (req) => { const { t } = ctx(req, PAYERS); return S.runFlow(String(b(req).need ?? "Need 2000 sealed 6204 bearings for line 3 maintenance"), { scenario: b(req).scenario ?? "happy", tenantId: t }); });
  // Rails, payments, webhooks
  app.get("/rails", async () => S.railsView());
  app.get("/rails/balances", async () => S.railBalances());
  app.get("/payments", async (req) => [...scoped(scopeOf(req)).intents].reverse());
  app.get("/payments/:id", async (req: any) => { const i = db.intents.find((x) => x.id === req.params.id); if (!i) throw new S.HttpError(404, "payment not found"); return { intent: i, settlement: db.settlements.find((s) => s.id === i.settlementId) ?? null, evidence: db.evidence.filter((e) => e.subjectId === i.id) }; });
  app.post("/payments/poll", async () => ({ checked: await S.pollSettlements() }));
  app.get("/cases", async (req) => S.listCases(scopeOf(req)));
  app.post("/webhooks/stripe", async (req: any) => S.ingestWebhook("stripe", req.rawBody ?? Buffer.alloc(0), req.headers));
  app.post("/webhooks/circle", async (req: any) => S.ingestWebhook("circle", req.rawBody ?? Buffer.alloc(0), req.headers));
  app.head("/webhooks/circle", async () => "");
  // Step 4: agent registry, approval rules and inbox, supplier onboarding
  app.get("/workspace/agents", async (req) => W.agentsView(ctx(req).t));
  app.post("/workspace/agents", async (req) => { const { u, t } = ctx(req, ADM); return W.registerAgent(u, t, W.NewAgent.parse(b(req))); });
  app.put("/workspace/agents/:id/mandate", async (req: any) => { const { u, t } = ctx(req, ADM); return W.updateMandate(u, t, req.params.id, W.MandateInput.parse(b(req))); });
  app.post("/workspace/agents/:id/keys", async (req: any) => { const { u, t } = ctx(req, ADM); const a = W.agentsView(t).find((x) => x.id === req.params.id); if (!a) throw new S.HttpError(404, "agent not found"); if (a.status !== "active") throw new S.HttpError(409, "Resume the agent before issuing a key"); const k = W.issueAgentKey(db.agents.find((x) => x.id === a.id)!, u.id); save(); return k; });
  app.post("/workspace/agents/:id/:action", async (req: any) => { const { u, t } = ctx(req, ADM); const action = req.params.action; if (!["suspend", "resume", "kill"].includes(action)) throw new S.HttpError(404, "unknown action"); return W.setAgentState(u, t, req.params.id, action); });
  app.get("/workspace/rules", async (req) => S.listRules(ctx(req).t));
  app.post("/workspace/rules", async (req) => { const { u, t } = ctx(req, ADM); return W.upsertRule(u, t, W.RuleInput.parse(b(req))); });
  app.put("/workspace/rules/:id", async (req: any) => { const { u, t } = ctx(req, ADM); return W.upsertRule(u, t, W.RuleInput.parse(b(req)), req.params.id); });
  app.delete("/workspace/rules/:id", async (req: any) => { const { u, t } = ctx(req, ADM); return W.deleteRule(u, t, req.params.id); });
  app.post("/workspace/rules/order", async (req) => { const { u, t } = ctx(req, ADM); return W.reorderRules(u, t, z.array(z.string()).parse(b(req).ids)); });
  app.get("/workspace/approvals", async (req) => { const { u, t } = ctx(req); return W.approvalsInbox(u, t); });
  app.get("/workspace/suppliers", async (req) => W.suppliersView(ctx(req).t));
  app.post("/workspace/suppliers/invite", async (req) => { const { u, t } = ctx(req, ["operator_admin", "client_admin", "ap_clerk"]); return W.inviteSupplier(u, t, b(req)); });
  app.post("/workspace/suppliers/:id/link", async (req: any) => { const { u, t } = ctx(req, ["operator_admin", "client_admin", "ap_clerk"]); return W.newInviteLink(u, t, req.params.id); });
  app.post("/workspace/suppliers/:id/review", async (req: any) => { const { u, t } = ctx(req, ["client_admin"]); return W.reviewSupplier(u, t, req.params.id, !!b(req).verify, String(b(req).note ?? "")); });
  app.post("/workspace/suppliers/:id/payee-change", async (req: any) => { const { u, t } = ctx(req, ["client_admin", "ap_clerk"]); return W.requestPayeeChange(u, t, req.params.id, b(req)); });
  app.post("/workspace/suppliers/:id/wallet-message", async (req: any) => { const { t } = ctx(req); return W.walletMessageFor(t, req.params.id, String(b(req).address ?? "")); });
  // Step 5: treasury, reconciliation, compliance cases. Operator console, per tenant.
  const OPS = ["operator_admin", "auditor"] as const; const OPA = ["operator_admin"] as const;
  const opCtx = (req: any, roles: readonly P.Role[] = OPS) => { const u = guard(req, roles); const id = String(req.query?.tenantId ?? b(req).tenantId ?? ""); const t = P.getTenant(id); if (!t || t.kind !== "client") throw new P.AuthError(422, "Pass tenantId of a business client"); return { u, t: t.id }; };
  app.get("/ops/treasury", async (req) => O.treasury(opCtx(req).t));
  app.post("/ops/treasury/sweep", async (req) => { const { u, t } = opCtx(req, OPA); const x = b(req); return O.sweep(u, t, x.rail, Number(x.amount)); });
  app.post("/ops/recon/run", async (req) => O.runRecon(opCtx(req, OPA).t));
  app.get("/ops/recon", async (req) => O.runRecon(opCtx(req).t));
  app.post("/ops/recon/exceptions/:id/resolve", async (req: any) => { const { u, t } = opCtx(req, OPA); return O.resolveException(u, t, decodeURIComponent(req.params.id), b(req).action, String(b(req).note ?? "")); });
  app.get("/ops/recon/export.csv", async (req: any, reply) => { const { t } = opCtx(req); return reply.type("text/csv").header("content-disposition", `attachment; filename="recon-${t}.csv"`).send(O.reconCsv(t)); });
  app.get("/ops/compliance", async (req) => { guard(req, OPS); return { ...O.complianceStatus(), cases: S.listCases(null), travelRule: O.travelRuleRecords(null) }; });
  app.post("/ops/cases/:id/sar/draft", async (req: any) => O.draftSar(guard(req, OPA), req.params.id));
  app.put("/ops/cases/:id/sar", async (req: any) => O.editSar(guard(req, OPA), req.params.id, String(b(req).text ?? "")));
  app.post("/ops/cases/:id/sar/file", async (req: any) => O.fileSar(guard(req, OPA), req.params.id));
  app.post("/ops/cases/:id/close", async (req: any) => O.closeCase(guard(req, OPA), req.params.id, String(b(req).resolution ?? "")));
  // Step 6: revenue, KPIs, dispute evidence, developer keys and webhooks
  app.get("/ops/revenue", async (req) => { guard(req, OPS); return A.revenue(); });
  app.get("/ops/kpis", async (req) => { guard(req, OPS); return A.kpis(); });
  app.get("/cases/:id/evidence-pack", async (req: any, reply) => { const u = guard(req, ["operator_admin", "auditor", "client_admin"]); const c = S.getCase(req.params.id); if (!c || !P.canAccessTenant(u, c.tenantId ?? "tnt-acme")) throw new S.HttpError(404, "case not found"); P.audit(u.id, "case", c.id, "dispute.evidence_exported", {}); return reply.header("content-disposition", `attachment; filename="evidence-${c.id}.json"`).send(A.evidencePack(c.id)); });
  const DEV = ["operator_admin", "client_admin"] as const;
  app.get("/dev/keys", async (req) => D.listApiKeys(ctx(req, DEV).t));
  app.post("/dev/keys", async (req) => { const { u, t } = ctx(req, DEV); return D.createApiKey(u, t, String(b(req).label ?? ""), b(req).role ?? "auditor"); });
  app.post("/dev/keys/:id/revoke", async (req: any) => { const { u, t } = ctx(req, DEV); return D.revokeApiKey(u, t, req.params.id); });
  app.get("/dev/webhooks", async (req) => ({ endpoints: D.listEndpoints(ctx(req, DEV).t), eventTypes: D.EVENT_TYPES, backoffSec: D.BACKOFF_SEC }));
  app.post("/dev/webhooks", async (req) => { const { u, t } = ctx(req, DEV); return D.createEndpoint(u, t, String(b(req).url ?? ""), Array.isArray(b(req).events) ? b(req).events : []); });
  app.post("/dev/webhooks/:id/active", async (req: any) => { const { u, t } = ctx(req, DEV); return D.setEndpointActive(u, t, req.params.id, !!b(req).active); });
  app.delete("/dev/webhooks/:id", async (req: any) => { const { u, t } = ctx(req, DEV); return D.deleteEndpoint(u, t, req.params.id); });
  app.post("/dev/webhooks/:id/test", async (req: any) => { const { t } = ctx(req, DEV); if (!D.listEndpoints(t).some((e: any) => e.id === req.params.id)) throw new S.HttpError(404, "endpoint not found"); const id = D.recordEvent(t, "ping", { message: "Test event from the developer page" }, req.params.id); await D.deliverDue(); return { eventId: id }; });
  app.post("/dev/deliveries/:id/retry", async (req: any) => { const { t } = ctx(req, DEV); D.retryDelivery(t, req.params.id); await D.deliverDue(); return { ok: true }; });
  app.get("/dev/events", async (req) => D.eventLog(ctx(req, DEV).t));
  // Public supplier portal. The token in the path is the only credential.
  app.get("/onboard/:token", async (req: any) => W.onboardingView(req.params.token));
  app.post("/onboard/:token/kyb", async (req: any) => W.saveKyb(req.params.token, b(req)));
  app.post("/onboard/:token/bank", async (req: any) => W.saveBank(req.params.token, b(req)));
  app.post("/onboard/:token/wallet-message", async (req: any) => W.onboardingMessage(req.params.token, String(b(req).address ?? "")));
  app.post("/onboard/:token/wallet", async (req: any) => W.saveWallet(req.params.token, b(req)));
  app.post("/onboard/:token/submit", async (req: any) => W.submitOnboarding(req.params.token));
  return app;
}
/** Bearer keys: scoped agent keys act as an AP clerk in their tenant. */
function bearerUser(key: string): P.User | null {
  if (key.startsWith("bpk_")) return D.apiKeyUser(key);
  if (key.startsWith("agk_")) { const a = W.agentForKey(key); return a ? { id: `agent:${a.id}`, tenantId: a.tenantId ?? "tnt-acme", name: a.name, email: "", role: "ap_clerk" } : null; }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  S.bootstrap(); P.writeSeedLogos(config.UPLOAD_DIR);
  const app = await buildApp();
  await app.listen({ port: config.BFF_PORT, host: "127.0.0.1" });
  console.log(`bff on http://127.0.0.1:${config.BFF_PORT} LLM_MODE=${llmMode()}`);
  for (const r of S.railsView()) console.log(`rail ${r.rail} ${r.env}: ${r.configured ? "configured" : "Not configured (" + r.notConfiguredReason + ")"}`);
  console.log(`Base Sepolia wallet ${onchainAddress("sandbox")}, fund it with test USDC from https://faucet.circle.com`);
  S.startSettlementWatcher(config.RAIL_POLL_MS);
  D.startWebhookWorker(config.RAIL_POLL_MS);
}
