/**
 * Chat approvals. A card goes to Slack and or Teams when an order waits for approval.
 * Buttons carry a signed one-time action token. Decisions reuse the app rules: canApprove (maker-checker, level role),
 * requirePermission (role and amount limit) and the step-up threshold. Above the threshold chat can only send people to the app.
 * With no webhook env set, cards land in chat_messages (the mock outbox) and the Chat approvals page renders them.
 */
import crypto from "node:crypto";
import { sql } from "./db.js";
import { config } from "./config.js";
import { db, tenantOf, type PurchaseOrder } from "./modules/store.js";
import * as P from "./platform.js";
import * as I from "./iam.js";
import * as SU from "./stepup.js";
import * as S from "./service.js";

export type Provider = "slack" | "teams";
type Action = "approve" | "reject";
const now = () => new Date().toISOString();
const TOKEN_TTL_MS = 15 * 60_000;
const SLACK_WINDOW_S = 5 * 60;

export const slackLive = () => !!process.env.SLACK_WEBHOOK_URL;
export const teamsLive = () => !!process.env.TEAMS_WEBHOOK_URL;
export const slackSigningOn = () => !!process.env.SLACK_SIGNING_SECRET;
const appBase = () => (process.env.APP_BASE_URL || `http://localhost:${config.WEB_PORT}`).replace(/\/$/, "");
/** Server secret for action tokens. Its own env var, else derived from the session secret. Never logged. */
const tokenKey = () => process.env.CHAT_ACTION_SECRET || crypto.createHmac("sha256", config.SESSION_SECRET).update("chat-action-token").digest("hex");
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Settings, per tenant. No row means on, both channels, like a demo default.

export function settings(tenantId: string) {
  const r = sql.prepare("SELECT * FROM tenant_chat WHERE tenant_id = ?").get(tenantId) as any;
  return { tenantId, enabled: r ? !!r.enabled : true, slack: r ? !!r.slack : true, teams: r ? !!r.teams : true, updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null,
    mode: { slack: slackLive() ? "live" : "mock", teams: teamsLive() ? "live" : "mock" } };
}
export function setSettings(user: P.User, tenantId: string, x: { enabled?: boolean; slack?: boolean; teams?: boolean }) {
  if (!(P.isOperator(user) && user.role === "operator_admin") && !(user.role === "client_admin" && user.tenantId === tenantId)) throw new P.AuthError(403, "Only an admin can change chat approvals");
  const cur = settings(tenantId); const next = { enabled: x.enabled ?? cur.enabled, slack: x.slack ?? cur.slack, teams: x.teams ?? cur.teams };
  sql.prepare("INSERT INTO tenant_chat (tenant_id, enabled, slack, teams, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET enabled = excluded.enabled, slack = excluded.slack, teams = excluded.teams, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .run(tenantId, +next.enabled, +next.slack, +next.teams, user.id, now());
  P.audit(user.id, "tenant", tenantId, "chat.settings_changed", next);
  return settings(tenantId);
}

// Linked identities: a chat user maps to one app user in one tenant.

const SEED_LINKS: [Provider, string, string][] = [
  ["slack", "U0SAMRIVERA", "usr-controller-sam"], ["slack", "U0LEEPARK", "usr-treasurer-lee"], ["slack", "U0JANEOKAFOR", "usr-cfo-jane"], ["slack", "U0PATMORGAN", "usr-clerk-pat"], ["slack", "U0GUSNOVAK", "usr-globex-gus"],
  ["teams", "aad-sam-rivera", "usr-controller-sam"], ["teams", "aad-lee-park", "usr-treasurer-lee"], ["teams", "aad-jane-okafor", "usr-cfo-jane"], ["teams", "aad-pat-morgan", "usr-clerk-pat"], ["teams", "aad-gus-novak", "usr-globex-gus"],
];
export function seedIdentities() {
  const ins = sql.prepare("INSERT OR IGNORE INTO chat_identities (provider, external_id, user_id, tenant_id, display_name, linked_at) VALUES (?,?,?,?,?,?)");
  for (const [p, ext, uid] of SEED_LINKS) { const u = P.getUser(uid); if (u?.tenantId) ins.run(p, ext, uid, u.tenantId, u.name, now()); }
}
export function linkIdentity(provider: Provider, externalId: string, userId: string) {
  const u = P.getUser(userId); if (!u?.tenantId) throw new P.AuthError(404, "user not found");
  sql.prepare("INSERT OR REPLACE INTO chat_identities (provider, external_id, user_id, tenant_id, display_name, linked_at) VALUES (?,?,?,?,?,?)").run(provider, externalId, u.id, u.tenantId, u.name, now());
}
const ensureSeed = () => { if (!sql.prepare("SELECT 1 FROM chat_identities LIMIT 1").get()) seedIdentities(); };
const identity = (provider: Provider, externalId: string) => (ensureSeed(), sql.prepare("SELECT * FROM chat_identities WHERE provider = ? AND external_id = ?").get(provider, externalId) as any);
export const identities = (tenantId: string) => (ensureSeed(), sql.prepare("SELECT provider, external_id AS externalId, user_id AS userId, display_name AS name FROM chat_identities WHERE tenant_id = ? ORDER BY provider, display_name").all(tenantId) as any[])
  .map((r) => ({ ...r, role: P.getUser(r.userId)?.role ?? null }));

// Signed one-time action tokens. Format: cat1.<payload>.<hmac>. Only the sha256 of the token is stored.

export function issueToken(messageId: string, poId: string, action: Action, provider: Provider, at = Date.now()) {
  const body = b64u(JSON.stringify({ j: crypto.randomUUID(), m: messageId, p: poId, a: action, v: provider, e: at + TOKEN_TTL_MS }));
  const token = `cat1.${body}.${b64u(crypto.createHmac("sha256", tokenKey()).update(body).digest())}`;
  sql.prepare("INSERT INTO chat_action_tokens (token_hash, message_id, po_id, action, provider, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?,NULL,?)").run(sha256(token), messageId, poId, action, provider, new Date(at + TOKEN_TTL_MS).toISOString(), new Date(at).toISOString());
  return token;
}
export class TokenError extends P.AuthError {}
/** Checks signature, expiry and that the token is stored and unused. Does not consume it. */
export function checkToken(token: string, at = Date.now()) {
  const [v, body, sig] = String(token ?? "").split(".");
  if (v !== "cat1" || !body || !sig) throw new TokenError(401, "This button is not valid");
  if (!safeEq(sig, b64u(crypto.createHmac("sha256", tokenKey()).update(body).digest()))) throw new TokenError(401, "This button is not valid");
  let p: any; try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new TokenError(401, "This button is not valid"); }
  if (!(Number(p.e) > at)) throw new TokenError(401, "This button has expired. Open the order in the app.");
  const row = sql.prepare("SELECT * FROM chat_action_tokens WHERE token_hash = ?").get(sha256(token)) as any;
  if (!row) throw new TokenError(401, "This button is not valid");
  if (row.used_at) throw new TokenError(409, "This button was already used");
  return { hash: row.token_hash as string, messageId: row.message_id as string, poId: row.po_id as string, action: row.action as Action, provider: row.provider as Provider };
}
/** Marks the token and its sibling buttons on the same card as used. False when someone else got there first. */
function claim(hash: string, messageId: string) {
  return sql.transaction(() => {
    if (sql.prepare("UPDATE chat_action_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(now(), hash).changes !== 1) return false;
    sql.prepare("UPDATE chat_action_tokens SET used_at = ? WHERE message_id = ? AND used_at IS NULL").run(now(), messageId); return true;
  })();
}
const unclaim = (messageId: string) => sql.prepare("UPDATE chat_action_tokens SET used_at = NULL WHERE message_id = ?").run(messageId);

// Slack request signing, v0.

export function verifySlack(raw: string, headers: Record<string, any>, secret = process.env.SLACK_SIGNING_SECRET ?? "", at = Date.now()) {
  const ts = String(headers["x-slack-request-timestamp"] ?? ""); const sig = String(headers["x-slack-signature"] ?? "");
  if (!secret || !/^\d+$/.test(ts) || !sig.startsWith("v0=")) return false;
  if (Math.abs(Math.floor(at / 1000) - Number(ts)) > SLACK_WINDOW_S) return false;
  return safeEq(sig, `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`);
}

// Cards.

const money = (n: number, c = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
function facts(po: PurchaseOrder) {
  const sup = db.suppliers.find((s) => s.id === po.supplierId);
  return { poId: po.id, supplier: sup?.name ?? po.supplierId, amount: money(po.total, po.currency), rail: (sup?.preferredRail ?? "not set").replace(/_/g, " "),
    risk: (po.policy?.reasons ?? []).join(", ") || "No risk notes", link: `${appBase()}/app/approvals?po=${encodeURIComponent(po.id)}` };
}
export function slackCard(po: PurchaseOrder, t: { approve?: string; reject?: string }, state?: string) {
  const f = facts(po);
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: `Approval needed: ${f.poId}` } },
    { type: "section", fields: [{ type: "mrkdwn", text: `*Supplier*\n${f.supplier}` }, { type: "mrkdwn", text: `*Amount*\n${f.amount}` }, { type: "mrkdwn", text: `*Rail*\n${f.rail}` }, { type: "mrkdwn", text: `*Risk note*\n${f.risk}` }] },
  ];
  const open = { type: "button", action_id: "open", text: { type: "plain_text", text: "Open in app" }, url: f.link };
  if (state) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: state }] }, { type: "actions", elements: [open] });
  else blocks.push({ type: "actions", elements: [
    { type: "button", action_id: "approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: t.approve },
    { type: "button", action_id: "reject", style: "danger", text: { type: "plain_text", text: "Reject" }, value: t.reject }, open] });
  return { text: `Approval needed: ${f.poId} ${f.supplier} ${f.amount}`, blocks };
}
export function teamsCard(po: PurchaseOrder, t: { approve?: string; reject?: string }, state?: string) {
  const f = facts(po);
  const body: any[] = [
    { type: "TextBlock", size: "Medium", weight: "Bolder", text: `Approval needed: ${f.poId}` },
    { type: "FactSet", facts: [{ title: "Supplier", value: f.supplier }, { title: "Amount", value: f.amount }, { title: "Rail", value: f.rail }, { title: "Risk note", value: f.risk }] },
  ];
  if (state) body.push({ type: "TextBlock", text: state, wrap: true, weight: "Bolder" });
  const actions: any[] = state ? [] : [{ type: "Action.Submit", title: "Approve", style: "positive", data: { action: "approve", token: t.approve } }, { type: "Action.Submit", title: "Reject", style: "destructive", data: { action: "reject", token: t.reject } }];
  actions.push({ type: "Action.OpenUrl", title: "Open in app", url: f.link });
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body, actions } }] };
}
const cardFor = (p: Provider, po: PurchaseOrder, t: { approve?: string; reject?: string }, state?: string) => p === "slack" ? slackCard(po, t, state) : teamsCard(po, t, state);

// Outbound.

async function deliver(url: string, payload: unknown) {
  try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }); return r.ok ? "sent" : "failed"; } catch { return "failed"; }
}
const setDelivery = (id: string, d: string) => sql.prepare("UPDATE chat_messages SET delivery = ? WHERE id = ?").run(d, id);
/** Sends one card per switched on channel. Mock mode stores the card only. Returns the stored message ids. */
export function notify(po: PurchaseOrder) {
  const tenantId = tenantOf(po); const st = settings(tenantId); if (!st.enabled) return [];
  const ids: string[] = [];
  for (const provider of (["slack", "teams"] as Provider[]).filter((p) => st[p])) {
    const id = `msg-${crypto.randomUUID().slice(0, 12)}`; const t = { approve: issueToken(id, po.id, "approve", provider), reject: issueToken(id, po.id, "reject", provider) };
    const card = cardFor(provider, po, t); const url = provider === "slack" ? process.env.SLACK_WEBHOOK_URL : process.env.TEAMS_WEBHOOK_URL;
    sql.prepare("INSERT INTO chat_messages (id, tenant_id, po_id, provider, delivery, state, card, created_at) VALUES (?,?,?,?,?,'pending',?,?)").run(id, tenantId, po.id, provider, url ? "sending" : "mock", JSON.stringify(card), now());
    P.audit(null, "po", po.id, "chat.notified", { source: provider, message: id, mode: url ? "live" : "mock" });
    if (url) void deliver(url, card).then((d) => setDelivery(id, d));
    ids.push(id);
  }
  return ids;
}
S.onPendingApproval((po) => { notify(po); });

/** The mock outbox for a tenant, newest first, with the live order status next to each card. */
export function outbox(tenantId: string, limit = 50) {
  return (sql.prepare("SELECT * FROM chat_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, limit) as any[]).map((r) => {
    const po = db.pos.find((p) => p.id === r.po_id);
    return { id: r.id, provider: r.provider, poId: r.po_id, delivery: r.delivery, state: r.state, stateText: r.state_text, actedBy: r.acted_by, actedAt: r.acted_at, createdAt: r.created_at, poStatus: po?.status ?? null, card: JSON.parse(r.card) };
  });
}

// Inbound actions. One path for Slack, Teams and the mock page.

export type ActResult = { ok: boolean; outcome: "approved" | "rejected" | "level_passed" | "blocked" | "needs_code"; message: string; deepLink?: string; poStatus?: string };
const label = (p: Provider) => (p === "slack" ? "Slack" : "Teams");
export function act(source: Provider, token: string, chatUserId: string, at = Date.now()): ActResult {
  const tk = checkToken(token, at);
  if (tk.provider !== source) throw new TokenError(401, "This button is not valid");
  const po = db.pos.find((p) => p.id === tk.poId); if (!po) throw new P.AuthError(404, "Order not found");
  const f = facts(po);
  const block = (actor: string | null, why: string, outcome: "blocked" | "needs_code" = "blocked", deepLink?: string): ActResult => {
    P.audit(actor, "po", po.id, "chat.action_blocked", { source, action: tk.action, reason: why, message: tk.messageId }); return { ok: false, outcome, message: why, deepLink, poStatus: po.status };
  };
  const link = identity(source, String(chatUserId ?? ""));
  if (!link) return block(null, `Link your ${label(source)} account to the app first`);
  const u = P.getUser(link.user_id);
  if (!u || u.active === false) return block(link.user_id, "This user is turned off");
  if (!u.tenantId || u.tenantId !== link.tenant_id || tenantOf(po) !== u.tenantId || !I.inEntityScope(u, u.tenantId)) return block(u.id, "This order is not in your company");
  try { I.requirePermission(u, "payments.approve", { amount: po.total, tenantId: u.tenantId }); } catch (e: any) { return block(u.id, e.message); }
  if (tk.action === "approve" && SU.needsStepUp(po.usdEquivalent ?? po.total)) return block(u.id, `Needs your code, open in app. Orders over ${money(SU.thresholdUsd())} need your authenticator code.`, "needs_code", f.link);
  const can = S.canApprove(po, u); if (!can.ok) return block(u.id, can.why);
  if (!claim(tk.hash, tk.messageId)) throw new TokenError(409, "This button was already used");
  let after: PurchaseOrder;
  try { after = S.decideApproval(po.id, tk.action === "approve", u.id, `From ${label(source)}`); } catch (e: any) { unclaim(tk.messageId); return block(u.id, e.message); }
  const outcome: ActResult["outcome"] = tk.action === "reject" ? "rejected" : after.status === "approved" ? "approved" : "level_passed";
  const text = outcome === "approved" ? `Approved by ${u.name}` : outcome === "rejected" ? `Rejected by ${u.name}` : `Approved by ${u.name}. Waiting for the next approver in the app.`;
  P.audit(u.id, "po", po.id, `chat.${outcome}`, { source, action: tk.action, chatUser: String(chatUserId).slice(0, 64), message: tk.messageId });
  const card = cardFor(source, after, {}, text);
  sql.prepare("UPDATE chat_messages SET state = ?, state_text = ?, acted_by = ?, acted_at = ?, card = ? WHERE id = ?").run(outcome, text, u.id, now(), JSON.stringify(card), tk.messageId);
  if (source === "teams" && teamsLive()) void deliver(process.env.TEAMS_WEBHOOK_URL!, card);
  return { ok: true, outcome, message: text, poStatus: after.status };
}

/** Slack interactivity payload: the button value is our action token. Replies with the new card for response_url. */
export function slackAction(payload: any, at = Date.now()) {
  const a = payload?.actions?.[0]; const userId = String(payload?.user?.id ?? "");
  if (!a || a.action_id === "open") return { ok: true, text: "" };
  let r: ActResult;
  try { r = act("slack", String(a.value ?? ""), userId, at); } catch (e: any) { r = { ok: false, outcome: "blocked", message: e.message }; }
  const msg = r.ok ? (sql.prepare("SELECT card FROM chat_messages WHERE id = (SELECT message_id FROM chat_action_tokens WHERE token_hash = ?)").get(sha256(String(a.value))) as any) : null;
  const reply = msg ? { replace_original: true, ...JSON.parse(msg.card) } : { response_type: "ephemeral", replace_original: false, text: r.deepLink ? `${r.message} ${r.deepLink}` : r.message };
  const url = String(payload?.response_url ?? "");
  if (url.startsWith("https://hooks.slack.com/")) void deliver(url, reply);
  return { ok: r.ok, result: r, ...reply };
}
