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
import * as X from "./explain.js";
import * as CP from "./copilot.js";
import * as FX from "./modules/fx.js";
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
import * as FV from "./flowview.js";
import * as I from "./iam.js";
import * as OIDC from "./oidc.js";
import { registerScim } from "./scim.js";
import * as SAML from "./saml.js";
import * as SU from "./stepup.js";
import * as Risk from "./risk.js";
import * as TB from "./tables.js";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

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
  // SAML posts the response as a form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body: string, done) => done(null, Object.fromEntries(new URLSearchParams(body))));
  await app.register(cookie, { secret: config.SESSION_SECRET });
  // Rate limits: per API key for bearer calls, per session for the browser, per IP otherwise.
  const bearerOf = (req: any) => /^Bearer (\S+)$/.exec(String(req.headers?.authorization ?? ""))?.[1];
  const rlKey = (req: any) => { const k = bearerOf(req); if (k) return `key:${crypto.createHash("sha256").update(k).digest("hex").slice(0, 24)}`; const sid = req.cookies?.sid; return sid ? `sid:${crypto.createHash("sha256").update(sid).digest("hex").slice(0, 24)}` : `ip:${req.ip}`; };
  await app.register(rateLimit, {
    global: true, timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000, keyGenerator: rlKey,
    max: (req: any, key: string) => key.startsWith("key:") ? Number(process.env.RATE_LIMIT_KEY_MAX) || 120 : key.startsWith("sid:") ? Number(process.env.RATE_LIMIT_SESSION_MAX) || 600 : Number(process.env.RATE_LIMIT_IP_MAX) || 300,
    allowList: (req: any) => req.url === "/health" || req.url.startsWith("/events") || req.url.startsWith("/webhooks/") || req.url.startsWith("/docs"),
    errorResponseBuilder: (_req: any, c: any) => Object.assign(new Error(`Too many requests. Try again in ${c.after}.`), { statusCode: 429 }),
  });
  await app.register(swagger, { openapi: { info: { title: "B2B Pay BFF", version: "0.1.0", description: "Agentic B2B payments API. Test mode only, no real funds." }, components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "sid" }, bearer: { type: "http", scheme: "bearer" } } } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  P.seedPlatform(); I.seedIdp();
  const COOKIE = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true };
  const userOf = (req: any): P.User | null => {
    const bearer = /^Bearer (\S+)$/.exec(String(req.headers?.authorization ?? ""))?.[1];
    if (bearer) return bearerUser(bearer);
    if (req.sessionUser !== undefined) return req.sessionUser;
    const raw = req.cookies?.sid; if (!raw) return null;
    const v = req.unsignCookie(raw); const hit = v.valid && v.value ? I.sessionUser(v.value) : null;
    req.sessionUser = hit?.user ?? null; req.sessionId = hit?.session.id ?? null; return req.sessionUser;
  };
  /** The signed-in user. Permission checks happen in the preHandler and in requirePermission calls. */
  const who = (req: any): P.User => { const u = userOf(req); if (!u) throw new P.AuthError(401, "Sign in required"); if (u.active === false) throw new P.AuthError(403, "This user is turned off"); return u; };
  const can = (req: any, perm: I.Permission, c: I.CheckCtx = {}) => I.requirePermission(who(req), perm, c);
  /** The business client a request acts on: ?tenantId for operators, otherwise the active tenant. */
  const clientOf = (req: any, u: P.User) => {
    const want = req.query?.tenantId ?? b(req).tenantId;
    const t = want ? P.tenantsFor(u).find((x) => x.id === want) : activeTenant(req, u);
    if (!t) throw new P.AuthError(403, "Not your tenant");
    if (t.kind !== "client") throw new P.AuthError(409, "Pick a business client in the tenant menu first");
    if (!I.inEntityScope(u, t.id)) throw new P.AuthError(403, `${t.id} is outside your role entity scope`);
    return t.id;
  };
  const ctx = (req: any) => { const u = who(req); return { u, t: clientOf(req, u) }; };
  /** Data scope for read views: a client tenant sees its own rows, an operator on a bank sees all. */
  const scopeOf = (req: any) => { const u = who(req); const t = activeTenant(req, u); return t.kind === "client" ? t.id : null; };
  const activeTenant = (req: any, u: P.User) => {
    const raw = req.cookies?.tenant; const v = raw ? req.unsignCookie(raw) : null;
    const want = v?.valid ? v.value : null; const allowed = P.tenantsFor(u).filter((t) => t.kind !== "client" || I.inEntityScope(u, t.id));
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
    const status = err instanceof P.AuthError ? err.status : err instanceof S.HttpError ? err.status : err instanceof FX.FxError ? err.status : err instanceof RailError ? err.status : err instanceof z.ZodError ? 422 : err.statusCode ?? 500;
    reply.status(status).send({ error: err instanceof z.ZodError ? "validation" : err.message, issues: err instanceof z.ZodError ? err.issues : undefined });
  });
  const b = (req: any) => (req.body ?? {}) as any;
  // Every route needs a signed-in user unless listed as public. Each route maps to one permission, checked here by requirePermission.
  const PUBLIC = new Set(["/health", "/auth/config", "/auth/demo-users", "/auth/login", "/auth/logout", "/auth/oidc/start", "/auth/oidc/callback", "/auth/saml/start", "/auth/saml/acs", "/auth/saml/metadata", "/.well-known/agent.json", "/webhooks/stripe", "/webhooks/circle"]);
  const ROUTE_PERMS: Record<string, I.Permission> = {
    "POST /reset": "platform.reset", "POST /kill-switch": "agents.manage", "POST /agents": "agents.manage", "POST /agents/:id/verify": "agents.manage", "POST /agents/:id/suspend": "agents.manage", "POST /agents/:id/resume": "agents.manage",
    "POST /policy/evaluate": "workspace.read", "POST /me/tenant": "workspace.read", "POST /approvals/:poId": "payments.approve", "POST /invoices/:id/pay": "payments.pay", "POST /refunds": "payments.refund",
    "POST /erp/vendor-master/changes": "erp.vendor_master", "POST /erp/vendor-master/changes/:id/approve": "payments.approve", "POST /erp/vendor-master/changes/:id/callback": "payments.approve",
    "GET /rails/balances": "rails.balances", "GET /users": "users.read", "PATCH /tenants/:id/branding": "settings.branding", "POST /tenants/:id/logo": "settings.branding",
    "POST /changes": "changes.request", "POST /copilot/ask": "workspace.read", "POST /copilot/answer": "workspace.read", "POST /changes/:id/decide": "changes.decide",
    "POST /workspace/agents": "agents.manage", "PUT /workspace/agents/:id/mandate": "agents.manage", "POST /workspace/agents/:id/keys": "agents.manage", "POST /workspace/agents/:id/:action": "agents.manage",
    "POST /workspace/rules": "rules.edit", "PUT /workspace/rules/:id": "rules.edit", "DELETE /workspace/rules/:id": "rules.edit", "POST /workspace/rules/order": "rules.edit",
    "POST /workspace/suppliers/invite": "suppliers.invite", "POST /workspace/suppliers/:id/link": "suppliers.invite", "POST /workspace/suppliers/:id/review": "suppliers.review",
    "POST /workspace/suppliers/:id/payee-change": "suppliers.payee_change", "POST /workspace/suppliers/:id/wallet-message": "workspace.read",
    "GET /ops/treasury": "treasury.read", "POST /ops/treasury/sweep": "treasury.sweep", "POST /ops/recon/run": "treasury.sweep", "GET /ops/recon": "treasury.read", "POST /ops/recon/exceptions/:id/resolve": "treasury.sweep",
    "GET /ops/recon/export.csv": "treasury.read", "GET /ops/compliance": "compliance.read", "POST /ops/cases/:id/sar/draft": "compliance.case.file", "PUT /ops/cases/:id/sar": "compliance.case.file",
    "POST /ops/cases/:id/sar/file": "compliance.case.file", "POST /ops/cases/:id/close": "compliance.case.file", "GET /ops/revenue": "treasury.read", "GET /ops/sankey": "treasury.read", "GET /ops/kpis": "treasury.read",
    "GET /cases/:id/evidence-pack": "audit.read", "GET /payments/:id/why/export.json": "audit.read", "GET /payments/:id/why/export.md": "audit.read",
    "GET /identity/configs": "identity.manage", "POST /identity/configs": "identity.manage", "GET /iam/users": "roles.manage", "GET /iam/roles": "roles.manage", "POST /iam/roles": "roles.manage", "PUT /iam/roles/:id": "roles.manage", "DELETE /iam/roles/:id": "roles.manage", "POST /iam/users/:id/role": "roles.manage",
    "POST /sessions/:id/revoke": "workspace.read", "POST /risk/:paymentId/decide": "risk.review", "POST /views": "workspace.read", "DELETE /views/:id": "workspace.read", "GET /dev/scim-tokens": "developers.keys", "POST /dev/scim-tokens": "developers.keys", "POST /dev/scim-tokens/:id/revoke": "developers.keys",
  };
  /** The permission a route needs. Developer routes need developers.keys, other reads need workspace.read, other writes need flow.operate. */
  const permFor = (method: string, url: string): I.Permission => ROUTE_PERMS[`${method} ${url}`] ?? (url.startsWith("/dev/") ? "developers.keys" : method === "GET" ? "workspace.read" : "flow.operate");
  app.addHook("preHandler", async (req: any) => {
    const url = req.routeOptions?.url as string | undefined;
    if (!url || PUBLIC.has(url) || url.startsWith("/uploads/") || url.startsWith("/onboard/") || url.startsWith("/scim/") || url.startsWith("/docs") || req.method === "HEAD" || req.method === "OPTIONS") return;
    can(req, permFor(req.method, url));
  });

  // Auth. SSO first. Demo login (pick a seeded user, no password) only when DEMO_LOGIN=1.
  const demoOn = () => process.env.DEMO_LOGIN === "1";
  const OIDC_COOKIE = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true, maxAge: 600 };
  const sessionCookie = (reply: any, id: string) => reply.setCookie("sid", id, { ...COOKIE, maxAge: Math.floor(I.absoluteMs() / 1000) }).clearCookie("tenant", { path: "/" });
  const meta = (req: any) => ({ ip: req.ip, ua: String(req.headers["user-agent"] ?? "") });
  app.get("/auth/config", async () => ({ demo: demoOn(), sso: I.listIdps().filter((x) => x.enabled).map((x) => ({ id: x.id, scope: x.scope, label: x.scope === "platform" ? "Sign in with SSO" : `Sign in with ${P.getTenant(x.scope)?.name ?? x.scope}` })), saml: { available: SAML.available(), label: "Sign in with SAML" } }));
  app.get("/auth/demo-users", async () => { if (!demoOn()) throw new P.AuthError(404, "Demo login is off"); return { demo: true, users: P.listUsers().filter((u) => u.active !== false) }; });
  app.post("/auth/login", async (req, reply) => {
    if (!demoOn()) throw new P.AuthError(404, "Demo login is off");
    const { userId } = z.object({ userId: z.string() }).parse(b(req));
    const u = P.getUser(userId); if (!u || u.active === false) throw new P.AuthError(401, "Unknown demo user");
    sessionCookie(reply, I.createSession(u, "demo", meta(req)));
    return { user: u };
  });
  app.get("/auth/oidc/start", async (req: any, reply) => {
    const id = String(req.query?.idp ?? I.listIdps().find((x) => x.enabled)?.id ?? "");
    if (!id) throw new P.AuthError(404, "No identity provider is set up");
    const { url, pending } = await OIDC.start(id);
    reply.setCookie("oidc", JSON.stringify(pending), OIDC_COOKIE); return reply.redirect(url);
  });
  app.get("/auth/oidc/callback", async (req: any, reply) => {
    const raw = req.cookies?.oidc; const v = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie("oidc", { path: "/" });
    const fail = (msg: string, idp?: string) => { P.audit(null, "auth", idp ?? "oidc", "auth.login_failed", { reason: msg }); return reply.redirect(`${OIDC.publicUrl()}/login?error=${encodeURIComponent(msg)}`); };
    if (!v?.valid || !v.value) return fail("Sign in expired. Start again.");
    const pending = JSON.parse(v.value) as OIDC.Pending;
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    try {
      const { user, idToken } = await OIDC.callback(pending, qs);
      sessionCookie(reply, I.createSession(user, "oidc", { idpId: pending.idp, idToken: idToken ?? undefined, ...meta(req) }));
      return reply.redirect(`${OIDC.publicUrl()}/`);
    } catch (e: any) { return fail(e instanceof P.AuthError ? e.message : "The identity provider rejected the sign in", pending.idp); }
  });
  app.get("/auth/saml/start", async (_req, reply) => {
    if (!SAML.available()) throw new P.AuthError(404, "SAML is not set up");
    return reply.redirect(await SAML.authorizeUrl());
  });
  app.post("/auth/saml/acs", async (req: any, reply) => {
    try {
      const user = await SAML.acs(b(req));
      sessionCookie(reply, I.createSession(user, "saml", meta(req)));
      return reply.redirect(`${OIDC.publicUrl()}/`);
    } catch (e: any) {
      const msg = e instanceof P.AuthError ? e.message : "The SAML sign in failed";
      P.audit(null, "auth", SAML.SAML_IDP_ID, "auth.login_failed", { reason: msg });
      return reply.redirect(`${OIDC.publicUrl()}/login?error=${encodeURIComponent(msg)}`);
    }
  });
  app.get("/auth/saml/metadata", async (_req, reply) => reply.type("application/xml").send(`<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${SAML.spEntityId()}"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAssertionsSigned="true"><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${SAML.acsUrl()}" index="1"/></md:SPSSODescriptor></md:EntityDescriptor>`));
  // Step-up with an authenticator app (TOTP), checked on the server for large approvals.
  app.get("/auth/step-up", async (req: any) => { const u = who(req); return SU.status(u.id, req.sessionId ?? null); });
  app.post("/auth/step-up/enroll", async (req: any) => SU.enroll(who(req)));
  app.post("/auth/step-up/verify", async (req: any) => { const u = who(req); return SU.verify(u, req.sessionId ?? null, String(b(req).code ?? "")); });
  app.post("/auth/logout", async (req: any, reply) => {
    userOf(req); const ended = req.sessionId ? I.endSession(req.sessionId, "logout", null) : null;
    reply.clearCookie("sid", { path: "/" }).clearCookie("tenant", { path: "/" });
    const redirect = ended?.idpId ? await OIDC.endSessionUrl(ended.idpId, ended.idToken) : null;
    return { ok: true, redirect };
  });
  app.get("/me", async (req) => {
    const u = userOf(req); if (!u) throw new P.AuthError(401, "Sign in required");
    const t = activeTenant(req, u); const g = I.grantOf(u);
    return { user: u, operator: P.isOperator(u), tenant: t, theme: P.themeFor(t), tenants: P.tenantsFor(u).filter((x) => x.kind !== "client" || I.inEntityScope(u, x.id)), llmMode: llmMode(), permissions: [...g.permissions], roleName: g.roleName, approveLimit: g.approveLimit };
  });
  app.post("/me/tenant", async (req, reply) => {
    const u = who(req); const id = String(b(req).tenantId ?? "");
    const t = P.tenantsFor(u).find((x) => x.id === id);
    if (!t || (t.kind === "client" && !I.inEntityScope(u, t.id))) throw new P.AuthError(403, "Not your tenant");
    reply.setCookie("tenant", id, COOKIE); return { ok: true };
  });
  // Identity, roles, permission check, sessions
  const roleTenant = (u: P.User) => (P.isOperator(u) ? null : u.tenantId);
  app.get("/identity/configs", async () => ({ providers: I.listIdps(), redirectUri: OIDC.redirectUri(), saml: { available: SAML.available(), entityId: SAML.spEntityId(), acsUrl: SAML.acsUrl() } }));
  app.post("/identity/configs", async (req) => P.requestChange(who(req), "identity.oidc", { ...b(req) }, null));
  app.get("/iam/permissions", async () => ({ permissions: I.PERMISSIONS, builtin: I.BUILTIN, clientPermissions: I.CLIENT_PERMS }));
  app.get("/iam/roles", async (req) => I.listRoles(roleTenant(who(req))));
  app.post("/iam/roles", async (req) => { const u = who(req); return I.saveRole(u, roleTenant(u), b(req)); });
  app.put("/iam/roles/:id", async (req: any) => { const u = who(req); return I.saveRole(u, roleTenant(u), b(req), req.params.id); });
  app.delete("/iam/roles/:id", async (req: any) => { const u = who(req); return I.deleteRole(u, roleTenant(u), req.params.id); });
  app.get("/iam/users", async (req) => { const u = who(req); return P.listUsers().filter((x) => x.tenantId === roleTenant(u) && x.active !== false); });
  app.post("/iam/users/:id/role", async (req: any) => I.assignRole(who(req), req.params.id, String(b(req).role ?? "")));
  app.get("/iam/check", async (req: any) => {
    const me = who(req); const q = req.query ?? {};
    let target = me;
    if (q.userId && q.userId !== me.id) { I.requirePermission(me, "roles.manage"); const t = P.getUser(String(q.userId)); if (!t || (!P.isOperator(me) && t.tenantId !== me.tenantId)) throw new P.AuthError(404, "user not found"); target = t; }
    const r = I.explain(target, String(q.permission ?? ""), { amount: q.amount !== undefined && q.amount !== "" ? Number(q.amount) : undefined, tenantId: q.tenantId ? String(q.tenantId) : undefined });
    if (q.paymentPoId && String(q.permission) === "payments.pay") { const po = db.pos.find((p) => p.id === q.paymentPoId); if (po) { try { I.sodPay(target, po as any); r.reasons.push({ ok: true, text: "Separation of duties holds, this user did not approve the order" }); } catch (e: any) { r.allowed = false; r.reasons.push({ ok: false, text: e.message }); } } }
    return r;
  });
  app.get("/sessions", async (req: any) => { const u = who(req); const all = I.explain(u, "sessions.manage").allowed; return { sessions: I.listSessions(u, all).map((s) => ({ ...s, current: !!req.sessionId && req.sessionId.startsWith(s.id) })), canManage: all, idleMinutes: I.idleMs() / 60000, absoluteHours: I.absoluteMs() / 3600000 }; });
  app.post("/sessions/:id/revoke", async (req: any) => { const u = who(req); return I.revokeSession(u, req.params.id, I.explain(u, "sessions.manage").allowed); });
  app.get("/dev/scim-tokens", async (req) => I.listScimTokens(ctx(req).t));
  app.post("/dev/scim-tokens", async (req) => { const { u, t } = ctx(req); return I.issueScimToken(u, t); });
  app.post("/dev/scim-tokens/:id/revoke", async (req: any) => { const { u, t } = ctx(req); return I.revokeScimToken(u, t, req.params.id); });
  registerScim(app);
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
  app.get("/tenants", async (req) => { const u = who(req); return P.tenantsFor(u); });
  app.get("/users", async (req) => { who(req); return P.listUsers(); });
  app.patch("/tenants/:id/branding", async (req: any) => {
    const u = who(req);
    if (!P.canAccessTenant(u, req.params.id)) throw new P.AuthError(403, "Not your tenant");
    const t = P.updateBranding(req.params.id, b(req)); P.audit(u.id, "tenant", t.id, "branding.updated", b(req)); return t;
  });
  app.post("/tenants/:id/logo", async (req: any) => {
    const u = who(req);
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
  app.get("/changes", async (req: any) => { const u = who(req); return P.listChanges(req.query?.status, P.isOperator(u) ? null : u.tenantId); });
  app.post("/changes", async (req) => { const x = b(req); const u = can(req, x.kind === "rail.settings" ? "settings.live_toggle" : x.kind === "identity.oidc" ? "identity.manage" : "changes.request"); return P.requestChange(u, String(x.kind), x.payload, x.tenantId ?? null); });
  app.post("/changes/:id/decide", async (req: any) => { const u = who(req); return P.decideChange(u, req.params.id, !!b(req).approve); });

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

  app.post("/buyer/draft", async (req) => { const { t } = ctx(req); return S.draftPo(z.object({ need: z.string().min(3) }).parse(b(req)).need, t); });
  app.post("/purchase-orders", async (req) => { const d = PoDraft.parse(b(req).draft); const sup = db.suppliers.find((x) => x.id === d.supplierId); if (sup) await S.ensureRates({ currency: d.currency, entityId: d.entityId, tenantId: sup.tenantId ?? "tnt-acme" }); const po = S.createPo(d, b(req).agentId); po.requestedBy = who(req).id; save(); return po; });
  app.post("/approvals/:poId", async (req: any) => { const { u, t } = ctx(req); const po = db.pos.find((p) => p.id === req.params.poId); if (!po || (po.tenantId ?? "tnt-acme") !== t) throw new S.HttpError(404, "po not found"); if (b(req).approve) { I.requirePermission(u, "payments.approve", { amount: po.total, tenantId: t }); SU.requireFresh(u, req.sessionId ?? null, po.usdEquivalent ?? po.total); } return S.decideApproval(po.id, !!b(req).approve, u.id, String(b(req).comment ?? "")); });
  app.post("/goods-receipts", async (req) => S.receiveGoods(b(req).poId, Number(b(req).shortBy ?? 0)));
  app.post("/invoices/render", async (req) => ({ text: S.invoiceText(b(req).poId, { priceBumpPct: Number(b(req).priceBumpPct ?? 0), poison: !!b(req).poison }) }));
  app.post("/invoices", async (req) => S.submitInvoice(b(req).poId, String(b(req).text), { invoiceDate: b(req).invoiceDate ? String(b(req).invoiceDate) : undefined }));
  app.post("/invoices/:id/match", async (req: any) => { const inv = db.invoices.find((i) => i.id === req.params.id); if (inv) await S.ensureRates({ currency: inv.currency, entityId: S.invoiceEntity(inv).id, tenantId: inv.tenantId ?? "tnt-acme", invoiceDate: inv.invoiceDate }); return S.matchInvoice(req.params.id); });
  app.post("/invoices/:id/pay", async (req: any) => {
    const key = req.headers["idempotency-key"]; if (!key) throw new S.HttpError(400, "Idempotency-Key header required");
    const u = who(req); const inv = db.invoices.find((i) => i.id === req.params.id); const po = inv && db.pos.find((p) => p.id === inv.poId);
    if (po) { if (!P.canAccessTenant(u, po.tenantId ?? "tnt-acme") || !I.inEntityScope(u, po.tenantId ?? "tnt-acme")) throw new S.HttpError(404, "invoice not found"); I.sodPay(u, po as any); }
    return S.payInvoice(req.params.id, String(key), { urgency: b(req).urgency, approvers: b(req).approvers, fxLockId: b(req).fxLockId ? String(b(req).fxLockId) : undefined });
  });
  app.post("/refunds", async (req) => { const u = who(req); const pi = db.intents.find((i) => i.id === b(req).paymentIntentId); if (!pi || !P.canAccessTenant(u, pi.tenantId ?? "tnt-acme")) throw new S.HttpError(404, "payment not found"); const r = await S.refund(pi.id, Number(b(req).amount), String(b(req).reason ?? "refund")); P.audit(u.id, "refund", r.id, "refund.requested_by", { amount: r.amount }); return r; });
  app.post("/erp/vendor-master/changes", async (req) => S.requestPayeeChange({ ...b(req), source: b(req).source ?? "erp" }));
  app.post("/erp/vendor-master/changes/:id/approve", async (req: any) => S.approvePayeeChange(req.params.id, String(b(req).approver)));
  app.post("/erp/vendor-master/changes/:id/callback", async (req: any) => S.callbackPayeeChange(req.params.id, !!b(req).confirmed));
  app.get("/settlements/:id", async (req: any) => db.settlements.find((s) => s.id === req.params.id) ?? { error: "not found" });
  app.get("/ledger/journals", async () => S.ledgerView());
  // Legal entities and FX. A client sees only its own entities, locks and books.
  app.get("/entities", async (req) => S.entitiesView(scopeOf(req)));
  app.get("/entities/:id/ledger", async (req: any) => S.entityLedgerView(req.params.id, scopeOf(req)));
  app.get("/fx/rate", async (req: any) => FX.getRate(String(req.query?.from ?? "EUR"), String(req.query?.to ?? "USD")));
  app.post("/fx/quotes", async (req) => { const { t } = ctx(req); const x = b(req); return FX.lockQuote({ tenantId: t, entityId: String(x.entityId), from: String(x.from), to: String(x.to ?? "USD") }); });
  app.get("/fx/locks/:id", async (req: any) => { const l = FX.getLock(req.params.id, scopeOf(req)); if (!l) throw new S.HttpError(404, "FX lock not found"); return { ...l, expired: FX.isExpired(l) }; });
  app.get("/statements/camt053", async (req: any, reply) => { const t = req.query?.tenantId ? clientOf(req, who(req)) : scopeOf(req); return reply.type("application/xml").header("content-disposition", `attachment; filename="camt053-${t ?? "all"}.xml"`).send(S.camt053(undefined, t)); });
  app.get("/evidence", async (req) => S.evidenceView(undefined, scopeOf(req)));
  app.get("/evidence/:subjectId", async (req: any) => S.evidenceView(req.params.subjectId, scopeOf(req)));
  app.post("/scenario/run", async (req) => { const { t } = ctx(req); return S.runFlow(String(b(req).need ?? "Need 2000 sealed 6204 bearings for line 3 maintenance"), { scenario: b(req).scenario ?? "happy", tenantId: t, entityId: b(req).entityId ? String(b(req).entityId) : undefined, currency: ["USD", "EUR", "GBP"].includes(b(req).currency) ? b(req).currency : undefined, invoiceDate: b(req).invoiceDate ? String(b(req).invoiceDate) : undefined }); });
  // Rails, payments, webhooks
  app.get("/rails", async () => S.railsView());
  app.get("/rails/balances", async () => S.railBalances());
  app.get("/payments", async (req) => { const st = scoped(scopeOf(req)); Risk.ensureScores(st.intents); return [...st.intents].reverse(); });
  app.get("/risk/inbox", async (req: any) => Risk.inbox(scopeOf(req), { status: req.query?.status ? String(req.query.status) : undefined }));
  app.post("/risk/:paymentId/decide", async (req: any) => Risk.decide(who(req), scopeOf(req), req.params.paymentId, String(b(req).action ?? ""), String(b(req).reason ?? "")));
  app.get("/views", async (req: any) => TB.listViews(who(req), String(req.query?.table ?? "")));
  app.post("/views", async (req) => TB.saveView(who(req), b(req)));
  app.delete("/views/:id", async (req: any) => TB.deleteView(who(req), req.params.id));
  app.get("/export/:kind", async (req: any, reply) => { const u = who(req); const ids = req.query?.ids ? new Set(String(req.query.ids).split(",").filter(Boolean).slice(0, 1000)) : undefined; const csv = TB.exportCsv(req.params.kind, scopeOf(req), u, () => clientOf(req, u), ids); return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${req.params.kind}.csv"`).send(csv); });
  app.get("/payments/:id", async (req: any) => { const i = db.intents.find((x) => x.id === req.params.id); if (!i) throw new S.HttpError(404, "payment not found"); Risk.ensureScores([i]); return { intent: i, riskReview: Risk.reviewOf(i.id), settlement: db.settlements.find((s) => s.id === i.settlementId) ?? null, evidence: db.evidence.filter((e) => e.subjectId === i.id) }; });
  app.post("/payments/poll", async () => ({ checked: await S.pollSettlements() }));
  app.get("/cases", async (req) => S.listCases(scopeOf(req)));
  app.post("/webhooks/stripe", async (req: any) => S.ingestWebhook("stripe", req.rawBody ?? Buffer.alloc(0), req.headers));
  app.post("/webhooks/circle", async (req: any) => S.ingestWebhook("circle", req.rawBody ?? Buffer.alloc(0), req.headers));
  app.head("/webhooks/circle", async () => "");
  // Step 4: agent registry, approval rules and inbox, supplier onboarding
  app.get("/workspace/agents", async (req) => W.agentsView(ctx(req).t));
  app.post("/workspace/agents", async (req) => { const { u, t } = ctx(req); return W.registerAgent(u, t, W.NewAgent.parse(b(req))); });
  app.put("/workspace/agents/:id/mandate", async (req: any) => { const { u, t } = ctx(req); return W.updateMandate(u, t, req.params.id, W.MandateInput.parse(b(req))); });
  app.post("/workspace/agents/:id/keys", async (req: any) => { const { u, t } = ctx(req); const a = W.agentsView(t).find((x) => x.id === req.params.id); if (!a) throw new S.HttpError(404, "agent not found"); if (a.status !== "active") throw new S.HttpError(409, "Resume the agent before issuing a key"); const k = W.issueAgentKey(db.agents.find((x) => x.id === a.id)!, u.id); save(); return k; });
  app.post("/workspace/agents/:id/:action", async (req: any) => { const { u, t } = ctx(req); const action = req.params.action; if (!["suspend", "resume", "kill"].includes(action)) throw new S.HttpError(404, "unknown action"); return W.setAgentState(u, t, req.params.id, action); });
  app.get("/workspace/rules", async (req) => S.listRules(ctx(req).t));
  app.post("/workspace/rules", async (req) => { const { u, t } = ctx(req); return W.upsertRule(u, t, W.RuleInput.parse(b(req))); });
  app.put("/workspace/rules/:id", async (req: any) => { const { u, t } = ctx(req); return W.upsertRule(u, t, W.RuleInput.parse(b(req)), req.params.id); });
  app.delete("/workspace/rules/:id", async (req: any) => { const { u, t } = ctx(req); return W.deleteRule(u, t, req.params.id); });
  app.post("/workspace/rules/order", async (req) => { const { u, t } = ctx(req); return W.reorderRules(u, t, z.array(z.string()).parse(b(req).ids)); });
  app.get("/workspace/approvals", async (req) => { const { u, t } = ctx(req); return W.approvalsInbox(u, t); });
  app.get("/workspace/suppliers", async (req) => W.suppliersView(ctx(req).t));
  app.post("/workspace/suppliers/invite", async (req) => { const { u, t } = ctx(req); return W.inviteSupplier(u, t, b(req)); });
  app.post("/workspace/suppliers/:id/link", async (req: any) => { const { u, t } = ctx(req); return W.newInviteLink(u, t, req.params.id); });
  app.post("/workspace/suppliers/:id/review", async (req: any) => { const { u, t } = ctx(req); return W.reviewSupplier(u, t, req.params.id, !!b(req).verify, String(b(req).note ?? "")); });
  app.post("/workspace/suppliers/:id/payee-change", async (req: any) => { const { u, t } = ctx(req); return W.requestPayeeChange(u, t, req.params.id, b(req)); });
  app.post("/workspace/suppliers/:id/wallet-message", async (req: any) => { const { t } = ctx(req); return W.walletMessageFor(t, req.params.id, String(b(req).address ?? "")); });
  // Step 5: treasury, reconciliation, compliance cases. Operator console, per tenant.
  const opCtx = (req: any) => { const u = who(req); const id = String(req.query?.tenantId ?? b(req).tenantId ?? ""); const t = P.getTenant(id); if (!t || t.kind !== "client") throw new P.AuthError(422, "Pass tenantId of a business client"); if (!I.inEntityScope(u, t.id)) throw new P.AuthError(403, `${t.id} is outside your role entity scope`); return { u, t: t.id }; };
  app.get("/ops/treasury", async (req) => O.treasury(opCtx(req).t));
  app.post("/ops/treasury/sweep", async (req) => { const { u, t } = opCtx(req); const x = b(req); return O.sweep(u, t, x.rail, Number(x.amount)); });
  app.post("/ops/recon/run", async (req) => O.runRecon(opCtx(req).t));
  app.get("/ops/recon", async (req) => O.runRecon(opCtx(req).t));
  app.post("/ops/recon/exceptions/:id/resolve", async (req: any) => { const { u, t } = opCtx(req); return O.resolveException(u, t, decodeURIComponent(req.params.id), b(req).action, String(b(req).note ?? "")); });
  app.get("/ops/recon/export.csv", async (req: any, reply) => { const { t } = opCtx(req); return reply.type("text/csv").header("content-disposition", `attachment; filename="recon-${t}.csv"`).send(O.reconCsv(t)); });
  app.get("/ops/compliance", async (req) => { who(req); return { ...O.complianceStatus(), cases: S.listCases(null), travelRule: O.travelRuleRecords(null) }; });
  app.post("/ops/cases/:id/sar/draft", async (req: any) => O.draftSar(who(req), req.params.id));
  app.put("/ops/cases/:id/sar", async (req: any) => O.editSar(who(req), req.params.id, String(b(req).text ?? "")));
  app.post("/ops/cases/:id/sar/file", async (req: any) => O.fileSar(who(req), req.params.id));
  app.post("/ops/cases/:id/close", async (req: any) => O.closeCase(who(req), req.params.id, String(b(req).resolution ?? "")));
  // Step 6: revenue, KPIs, dispute evidence, developer keys and webhooks
  app.get("/ops/revenue", async (req) => { who(req); return A.revenue(); });
  app.get("/payments/:id/mandates", async (req: any) => { const i = scoped(scopeOf(req)).intents.find((x) => x.id === req.params.id); if (!i) throw new S.HttpError(404, "payment not found"); return S.mandatesView(i.id); });
  // Copilot. Read-only tools scoped like every other read view. Proposals are returned, never executed.
  const cpCtx = (req: any): CP.Ctx => { const u = who(req); return { user: u, scope: scopeOf(req), prefix: P.isOperator(u) ? "/operator" : "/app" }; };
  app.post("/copilot/answer", async (req) => CP.ask(cpCtx(req), String(b(req).question ?? "")));
  app.post("/copilot/ask", async (req) => CP.enqueue(cpCtx(req), String(b(req).question ?? "")));
  app.get("/copilot/stream/:id", async (req: any, reply) => {
    const u = who(req); const p = CP.take(req.params.id, u.id);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const r = await CP.ask(p.ctx, p.question, (s) => send(s.event, s.data));
      for (const w of r.answer.match(/\S+\s*/g) ?? []) send("token", { text: w });
      send("done", r);
    } catch (e: any) { send("failed", { error: String(e.message ?? e) }); }
    reply.raw.end();
  });
  app.get("/payments/:id/why", async (req: any) => X.explainPayment(req.params.id, scopeOf(req)));
  app.get("/payments/:id/why/export.json", async (req: any, reply) => { const w = X.explainPayment(req.params.id, scopeOf(req)); return reply.header("content-disposition", `attachment; filename="why-${w.paymentId}.json"`).send({ ...w, records: S.evidenceView(undefined, null).records.filter((e) => [w.paymentId, w.poId, w.invoiceId].includes(e.subjectId)) }); });
  app.get("/payments/:id/why/export.md", async (req: any, reply) => { const w = X.explainPayment(req.params.id, scopeOf(req)); return reply.type("text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="why-${w.paymentId}.md"`).send(X.whyMarkdown(w)); });
  app.get("/flows/:id", async (req: any) => FV.flowSummary(req.params.id, scopeOf(req)));
  app.get("/transactions", async (req: any) => FV.transactions(scopeOf(req), req.query ?? {}));
  app.get("/transactions/export.csv", async (req: any, reply) => reply.type("text/csv").header("content-disposition", `attachment; filename="transactions.csv"`).send(FV.transactionsCsv(scopeOf(req), req.query ?? {})));
  app.get("/transactions/feed", async (req: any) => FV.liveFeed(scopeOf(req), Math.min(200, Number(req.query?.limit ?? 50) || 50)));
  app.get("/insights/home", async (req: any) => FV.homeInsights(scopeOf(req), Math.min(90, Number(req.query?.days ?? 14) || 14)));
  app.get("/ops/sankey", async (req: any) => { who(req); return FV.sankey(Math.min(365, Number(req.query?.days ?? 30) || 30)); });
  app.get("/ops/kpis", async (req) => { who(req); return A.kpis(); });
  app.get("/cases/:id/evidence-pack", async (req: any, reply) => { const u = who(req); const c = S.getCase(req.params.id); if (!c || !P.canAccessTenant(u, c.tenantId ?? "tnt-acme")) throw new S.HttpError(404, "case not found"); P.audit(u.id, "case", c.id, "dispute.evidence_exported", {}); return reply.header("content-disposition", `attachment; filename="evidence-${c.id}.json"`).send(A.evidencePack(c.id)); });
  app.get("/dev/keys", async (req) => D.listApiKeys(ctx(req).t));
  app.post("/dev/keys", async (req) => { const { u, t } = ctx(req); return D.createApiKey(u, t, String(b(req).label ?? ""), b(req).role ?? "auditor"); });
  app.post("/dev/keys/:id/revoke", async (req: any) => { const { u, t } = ctx(req); return D.revokeApiKey(u, t, req.params.id); });
  app.get("/dev/webhooks", async (req) => ({ endpoints: D.listEndpoints(ctx(req).t), eventTypes: D.EVENT_TYPES, backoffSec: D.BACKOFF_SEC }));
  app.post("/dev/webhooks", async (req) => { const { u, t } = ctx(req); return D.createEndpoint(u, t, String(b(req).url ?? ""), Array.isArray(b(req).events) ? b(req).events : []); });
  app.post("/dev/webhooks/:id/active", async (req: any) => { const { u, t } = ctx(req); return D.setEndpointActive(u, t, req.params.id, !!b(req).active); });
  app.delete("/dev/webhooks/:id", async (req: any) => { const { u, t } = ctx(req); return D.deleteEndpoint(u, t, req.params.id); });
  app.post("/dev/webhooks/:id/test", async (req: any) => { const { t } = ctx(req); if (!D.listEndpoints(t).some((e: any) => e.id === req.params.id)) throw new S.HttpError(404, "endpoint not found"); const id = D.recordEvent(t, "ping", { message: "Test event from the developer page" }, req.params.id); await D.deliverDue(); return { eventId: id }; });
  app.post("/dev/deliveries/:id/retry", async (req: any) => { const { t } = ctx(req); D.retryDelivery(t, req.params.id); await D.deliverDue(); return { ok: true }; });
  app.get("/dev/events", async (req) => D.eventLog(ctx(req).t));
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
