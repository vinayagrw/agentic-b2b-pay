import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as CH from "../src/chatops.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
afterEach(() => { delete process.env.SLACK_SIGNING_SECRET; });

const po = (qty: number) => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty, unitPrice: 420 }], justification: "Line 4 retrofit" });
/** A pending order under the step-up threshold, with its chat cards. */
function smallPending() { const p = po(30); p.total = 2000; p.usdEquivalent = 2000; return p; }
const tokens = (poId: string, provider: CH.Provider) => {
  const m = CH.outbox("tnt-acme").find((x) => x.poId === poId && x.provider === provider)!;
  if (provider === "teams") { const a = m.card.attachments[0].content.actions; return { approve: a[0].data.token as string, reject: a[1].data.token as string, id: m.id }; }
  const els = m.card.blocks.find((b: any) => b.type === "actions").elements; return { approve: els[0].value as string, reject: els[1].value as string, id: m.id };
};
const sign = (secret: string, ts: number, raw: string) => `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;

describe("chat approvals", () => {
  it("stores Slack and Teams cards in the mock outbox when an order waits for approval", () => {
    const p = po(30); expect(p.status).toBe("pending_approval");
    const out = CH.outbox("tnt-acme").filter((m) => m.poId === p.id);
    expect(out.map((m) => m.provider).sort()).toEqual(["slack", "teams"]);
    expect(out.every((m) => m.delivery === "mock" && m.state === "pending")).toBe(true);
    const txt = JSON.stringify(out); expect(txt).toContain("Northwind"); expect(txt).toContain("Open in app"); expect(txt).toContain("Risk note");
    expect(CH.outbox("tnt-globex").length).toBe(0);
    // Tokens are stored hashed only.
    const t = tokens(p.id, "teams"); expect(sql.prepare("SELECT COUNT(*) c FROM chat_action_tokens WHERE token_hash = ?").get(t.approve)).toMatchObject({ c: 0 });
  });
  it("respects the per tenant switch and channel choice", () => {
    const jane = P.getUser("usr-cfo-jane")!; const sam = P.getUser("usr-controller-sam")!;
    expect(() => CH.setSettings(sam, "tnt-acme", { enabled: false })).toThrow(/admin/);
    CH.setSettings(jane, "tnt-acme", { teams: false });
    const p2 = po(30); expect(p2.status).toBe("pending_approval"); expect(CH.outbox("tnt-acme").filter((m) => m.poId === p2.id).map((m) => m.provider)).toEqual(["slack"]);
    CH.setSettings(jane, "tnt-acme", { enabled: false });
    const p3 = po(30); expect(CH.outbox("tnt-acme").filter((m) => m.poId === p3.id)).toEqual([]);
  });
  it("verifies Slack signatures: good, bad and stale", () => {
    const secret = "test-signing-secret"; const raw = "payload=%7B%7D"; const ts = Math.floor(Date.now() / 1000);
    expect(CH.verifySlack(raw, { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign(secret, ts, raw) }, secret)).toBe(true);
    expect(CH.verifySlack(raw, { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign("wrong", ts, raw) }, secret)).toBe(false);
    expect(CH.verifySlack(raw + "x", { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign(secret, ts, raw) }, secret)).toBe(false);
    const old = ts - 6 * 60; expect(CH.verifySlack(raw, { "x-slack-request-timestamp": String(old), "x-slack-signature": sign(secret, old, raw) }, secret)).toBe(false);
    expect(CH.verifySlack(raw, { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign(secret, ts, raw) }, "")).toBe(false);
  });
  it("approves from a signed Slack request and updates the card", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
    const app = await buildApp(); const p = smallPending(); const t = tokens(p.id, "slack");
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: "U0SAMRIVERA" }, actions: [{ action_id: "approve", value: t.approve }] }) }).toString();
    const ts = Math.floor(Date.now() / 1000);
    const bad = await app.inject({ method: "POST", url: "/integrations/slack/actions", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(ts), "x-slack-signature": sign("nope", ts, raw) }, payload: raw });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/integrations/slack/actions", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(ts), "x-slack-signature": sign("test-signing-secret", ts, raw) }, payload: raw });
    expect(ok.statusCode).toBe(200); expect(ok.json().result.outcome).toBe("approved");
    expect(db.pos.find((x) => x.id === p.id)!.status).toBe("approved");
    const m = CH.outbox("tnt-acme").find((x) => x.id === t.id)!; expect(m.stateText).toBe("Approved by Sam Rivera");
    expect(JSON.stringify(m.card)).not.toContain(t.reject);
    expect(db.evidence.some((e: any) => e.event === "chat.approved" && e.payload?.source === "slack")).toBe(true);
    // With signing on, Slack tokens cannot be replayed through the Teams endpoint.
    const p2 = smallPending(); const t2 = tokens(p2.id, "slack");
    expect((await app.inject({ method: "POST", url: "/integrations/teams/actions", payload: { token: t2.approve, chatUserId: "U0SAMRIVERA" } })).statusCode).toBe(401);
  });
  it("action tokens are single use and expire after 15 minutes", () => {
    const p = smallPending(); const t = tokens(p.id, "teams");
    expect(() => CH.act("teams", t.approve, "aad-sam-rivera", Date.now() + 16 * 60_000)).toThrow(/expired/);
    expect(() => CH.act("teams", t.approve.slice(0, -2) + "xx", "aad-sam-rivera")).toThrow(/not valid/);
    expect(CH.act("teams", t.approve, "aad-sam-rivera").outcome).toBe("approved");
    expect(() => CH.act("teams", t.approve, "aad-sam-rivera")).toThrow(/already used/);
    expect(() => CH.act("teams", t.reject, "aad-lee-park")).toThrow(/already used/);
    expect(db.evidence.some((e: any) => e.event === "chat.approved" && e.payload?.source === "teams")).toBe(true);
  });
  it("blocks the maker, wrong roles and unlinked users, and leaves the button usable", () => {
    const p = smallPending(); p.requestedBy = "usr-controller-sam"; const t = tokens(p.id, "teams");
    const r = CH.act("teams", t.approve, "aad-sam-rivera"); expect(r).toMatchObject({ ok: false, outcome: "blocked" }); expect(r.message).toMatch(/another person/);
    expect(CH.act("teams", t.approve, "aad-pat-morgan").ok).toBe(false);
    expect(CH.act("teams", t.approve, "aad-nobody").message).toMatch(/Link your Teams account/);
    expect(db.evidence.some((e: any) => e.event === "chat.action_blocked" && e.payload?.source === "teams")).toBe(true);
    expect(CH.act("teams", t.approve, "aad-lee-park").outcome).toBe("approved");
  });
  it("cannot approve above the step-up threshold from chat, but sends a deep link", () => {
    const p = po(30); expect(p.usdEquivalent ?? p.total).toBeGreaterThan(10000); const t = tokens(p.id, "slack");
    const r = CH.act("slack", t.approve, "U0SAMRIVERA");
    expect(r).toMatchObject({ ok: false, outcome: "needs_code" }); expect(r.message).toMatch(/Needs your code, open in app/); expect(r.deepLink).toContain(`/app/approvals?po=${p.id}`);
    expect(db.pos.find((x) => x.id === p.id)!.status).toBe("pending_approval");
    expect(CH.act("slack", t.reject, "U0SAMRIVERA").outcome).toBe("rejected");
  });
  it("keeps tenants apart", () => {
    const p = smallPending(); const t = tokens(p.id, "teams");
    const r = CH.act("teams", t.approve, "aad-gus-novak"); expect(r.ok).toBe(false); expect(r.message).toMatch(/not in your company/);
    expect(CH.identities("tnt-globex").every((i: any) => i.userId.startsWith("usr-globex"))).toBe(true);
  });
  it("serves the outbox only to the signed in tenant and acts through the mock path", async () => {
    const app = await buildApp(); const p = smallPending(); const t = tokens(p.id, "slack");
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const gina = await login("usr-globex-gina");
    expect((await app.inject({ url: "/integrations/chat/outbox", headers: { cookie: gina } })).json().messages).toEqual([]);
    const jane = await login("usr-cfo-jane");
    expect((await app.inject({ url: "/integrations/chat/outbox", headers: { cookie: jane } })).json().messages.length).toBeGreaterThan(0);
    const r = await app.inject({ method: "POST", url: "/integrations/teams/actions", payload: { token: t.approve, chatUserId: "U0LEEPARK" } });
    expect(r.statusCode).toBe(200); expect(r.json().message).toBe("Approved by Lee Park");
  });
});
