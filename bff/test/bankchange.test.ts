import { describe, it, expect, beforeEach } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as BC from "../src/bankchange.js";
import * as R from "../src/risk.js";
import * as CP from "../src/copilot.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";
import * as W from "../src/workspace.js";
import { appendEvidence } from "../src/modules/evidence.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const IBAN = "DE44500105175407324931"; const ROUTING = "021000021"; const ACCOUNT = "987654321098";
const bank = (o: any = {}) => ({ kind: "bank", bank: { holderName: "Northwind Components LLC", bankName: "Commerzbank", country: "DE", iban: IBAN, ...o }, channel: "email", channelNote: "Email from the supplier asking to use a new account" });
const ask = (app: any, cookie: string, supplierId = "sup-northwind", body: any = bank()) => app.inject({ method: "POST", url: `/suppliers/${supplierId}/bank-changes`, headers: { cookie }, payload: body });
const callback = (app: any, cookie: string, id: string, outcome = "confirmed") => app.inject({ method: "POST", url: `/bank-changes/${id}/callback`, headers: { cookie }, payload: { outcome, spokeTo: "Dana at Northwind", note: "Called the number on file" } });
const decide = (app: any, cookie: string, id: string, approve = true) => app.inject({ method: "POST", url: `/bank-changes/${id}/decide`, headers: { cookie }, payload: { approve, note: "Checked by phone" } });
const pay = async () => { const r = await S.runFlow("Need 50 sealed 6204 bearings"); return db.intents.find((i) => i.id === r.intentId) ?? db.intents.at(-1)!; };
const northwind = () => db.suppliers.find((s) => s.id === "sup-northwind")!;

describe("supplier bank-detail change check", () => {
  it("does not apply a change without approval", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const before = northwind().bankDetailsRef;
    const r = await ask(app, pat); expect(r.statusCode).toBe(200); expect(r.json().status).toBe("pending");
    expect(northwind().bankDetailsRef).toBe(before);
    expect(sql.prepare("SELECT COUNT(*) n FROM supplier_payout_details WHERE supplier_id = 'sup-northwind'").get()).toEqual({ n: 0 });
    expect(r.json().signals.map((s: any) => s.code)).toEqual(expect.arrayContaining(["different_country", "channel"]));
    expect(r.json().signals.map((s: any) => s.code)).not.toContain("requester_can_approve");
    expect((await ask(app, pat)).statusCode).toBe(409);
    const sam = await login(app, "usr-controller-sam");
    const rej = await decide(app, sam, r.json().id, false); expect(rej.statusCode).toBe(200); expect(rej.json().status).toBe("rejected");
    expect(northwind().bankDetailsRef).toBe(before); expect(BC.paymentHold("tnt-acme", "sup-northwind")).toBeNull();
    expect(db.evidence.filter((e) => e.subjectId === "sup-northwind").map((e) => e.event)).toEqual(expect.arrayContaining(["bank_change.requested", "bank_change.rejected"]));
  });

  it("stops the maker from approving, even with payments.approve", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane");
    const r = await ask(app, jane); expect(r.json().signals.map((s: any) => s.code)).toContain("requester_can_approve");
    await stepUp(app, jane);
    const cb = await callback(app, jane, r.json().id); expect(cb.statusCode).toBe(403); expect(cb.json().error).toMatch(/cannot record/);
    const d = await decide(app, jane, r.json().id); expect(d.statusCode).toBe(403); expect(d.json().error).toMatch(/cannot approve/);
    const pat = await login(app, "usr-clerk-pat");
    expect((await decide(app, pat, r.json().id)).statusCode).toBe(403);
    expect(BC.detail("tnt-acme", r.json().id).status).toBe("pending");
  });

  it("needs a fresh authenticator code to approve", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const id = (await ask(app, pat)).json().id;
    expect((await callback(app, sam, id)).statusCode).toBe(200);
    const no = await decide(app, sam, id); expect(no.statusCode).toBe(403); expect(no.json().error).toMatch(/step_up_required/);
    expect(BC.detail("tnt-acme", id).status).toBe("pending");
    await stepUp(app, sam);
    const ok = await decide(app, sam, id); expect(ok.statusCode).toBe(200); expect(ok.json().status).toBe("approved");
    expect(northwind().bankDetailsRef).toBe(`bank-chg-${id}`);
    expect(db.evidence.filter((e) => e.subjectId === "sup-northwind").map((e) => e.event)).toEqual(expect.arrayContaining(["bank_change.callback", "bank_change.approved", "payee.changed"]));
  });

  it("needs a recorded and confirmed call-back to the number on file", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const id = (await ask(app, pat)).json().id; await stepUp(app, sam);
    const none = await decide(app, sam, id); expect(none.statusCode).toBe(409); expect(none.json().error).toMatch(/call-back/);
    expect((await callback(app, sam, id, "no_answer")).statusCode).toBe(200);
    expect((await decide(app, sam, id)).statusCode).toBe(409);
    const cb = await callback(app, sam, id); expect(cb.json().callback.phone).toBe(northwind().contactPhone); expect(cb.json().callback.outcome).toBe("confirmed");
    delete northwind().contactPhone;
    expect((await callback(app, sam, id)).statusCode).toBe(409);
    expect((await decide(app, sam, id)).json().status).toBe("approved");
  });

  it("holds payments during the cooling-off time after approval", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam"); const jane = await login(app, "usr-cfo-jane");
    expect((await app.inject({ method: "PUT", url: "/bank-changes/settings", headers: { cookie: pat }, payload: { coolingOffHours: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/bank-changes/settings", headers: { cookie: jane } })).json().coolingOffHours).toBe(24);
    expect((await app.inject({ method: "PUT", url: "/bank-changes/settings", headers: { cookie: jane }, payload: { coolingOffHours: 48 } })).json().coolingOffHours).toBe(48);
    const id = (await ask(app, pat)).json().id; await callback(app, sam, id); await stepUp(app, sam);
    const ok = (await decide(app, sam, id)).json();
    expect(ok.coolingOff).toBe(true); expect(Date.parse(ok.holdUntil) - Date.parse(ok.decidedAt)).toBe(48 * 3_600_000);
    const held = await pay(); expect(held.status).toBe("blocked"); expect(held.blockedReason).toMatch(/cooling-off/); expect(held.holdKind).toBe("bank_change");
    sql.prepare("UPDATE bank_change_requests SET hold_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    expect(BC.paymentHold("tnt-acme", "sup-northwind")).toBeNull();
    const free = await pay(); expect(free.holdKind).toBeUndefined(); expect(free.status).not.toBe("blocked");
  });

  it("holds payments while a request is pending and shows them in the risk inbox", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const before = await pay(); expect(before.status).not.toBe("blocked");
    await ask(app, pat);
    const held = await pay(); expect(held.status).toBe("blocked"); expect(held.blockedReason).toMatch(/waiting for a second person/);
    const row = R.inbox("tnt-acme").find((r) => r.paymentId === held.id)!;
    expect(row).toBeTruthy(); expect(row.reasons.map((r) => r.code)).toContain("bank_change_hold"); expect(row.score).toBeGreaterThanOrEqual(R.REVIEW_AT);
    const inbox = (await app.inject({ url: "/risk/inbox", headers: { cookie: sam } })).json();
    expect(inbox.some((r: any) => r.paymentId === held.id)).toBe(true);
    const list = (await app.inject({ url: "/bank-changes?status=pending", headers: { cookie: sam } })).json();
    expect(list.requests).toHaveLength(1); expect(list.requests[0].paymentsHeld).toBe(true);
    // Other suppliers are not held.
    expect(BC.paymentHold("tnt-acme", "sup-contoso")).toBeNull();
  });

  it("flags the same account on a supplier in another tenant without naming the tenant", async () => {
    const app = await buildApp(); const gwen = await login(app, "usr-globex-gwen"); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const g = await ask(app, gwen, "sup-initech", bank({ holderName: "Initech Packaging Co" })); expect(g.statusCode).toBe(200);
    expect(g.json().signals.map((s: any) => s.code)).not.toContain("duplicate_account");
    const a = await ask(app, pat); const dup = a.json().signals.find((s: any) => s.code === "duplicate_account");
    expect(dup).toBeTruthy(); expect(dup.detail).toBe("The same account is on another supplier on the platform");
    for (const body of [a.body, (await app.inject({ url: "/bank-changes", headers: { cookie: sam } })).body, (await app.inject({ url: `/bank-changes/${a.json().id}`, headers: { cookie: sam } })).body]) expect(body).not.toMatch(/globex|initech/i);
    // The other tenant's request is not readable from here.
    expect((await app.inject({ url: `/bank-changes/${g.json().id}`, headers: { cookie: sam } })).statusCode).toBe(404);
    expect((await callback(app, sam, g.json().id)).statusCode).toBe(404);
    expect((await ask(app, pat, "sup-initech")).statusCode).toBe(404);
    // Inside one tenant the other supplier is named.
    const c = await ask(app, pat, "sup-contoso", bank({ holderName: "Contoso Logistics Ltd" }));
    expect(c.json().signals.find((s: any) => s.code === "duplicate_account").detail).toMatch(/Northwind Components LLC/);
  });

  it("never returns or logs a full account number", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const a = await ask(app, pat, "sup-northwind", { ...bank(), channelNote: `Please pay to ${IBAN} from now on` });
    const b = await ask(app, pat, "sup-contoso", { kind: "bank", bank: { holderName: "Contoso Logistics Ltd", bankName: "Chase", country: "US", routingNumber: ROUTING, accountNumber: ACCOUNT }, channel: "phone", channelNote: `Caller read out account ${ACCOUNT}` });
    const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";
    const w = await ask(app, pat, "sup-fabrikam", { kind: "wallet", wallet: { address: WALLET }, channel: "portal", channelNote: "Asked in the portal" });
    expect(a.json().new.last4).toBe(IBAN.slice(-4)); expect(b.json().new.last4).toBe(ACCOUNT.slice(-4)); expect(w.json().new.last4).toBe(WALLET.slice(-4));
    expect(w.json().signals.map((s: any) => s.code)).toContain("new_wallet");
    const id = a.json().id; const cb = await callback(app, sam, id); await stepUp(app, sam); const ok = await decide(app, sam, id);
    const fab = () => db.suppliers.find((x) => x.id === "sup-fabrikam")!; fab().acceptedRails = ["stripe_ach"];
    const bodies = [a.body, b.body, w.body, cb.body, ok.body, (await app.inject({ url: "/bank-changes", headers: { cookie: sam } })).body, (await app.inject({ url: `/bank-changes/${id}`, headers: { cookie: sam } })).body,
      (await app.inject({ url: "/workspace/suppliers", headers: { cookie: sam } })).body, JSON.stringify(db.evidence), JSON.stringify(db.suppliers),
      JSON.stringify(CP.runTool({ user: P.getUser("usr-cfo-jane")!, scope: "tnt-acme", prefix: "/app" }, "bankChanges"))];
    for (const txt of bodies) { for (const secret of [IBAN, ACCOUNT, ROUTING, WALLET, WALLET.toLowerCase()]) expect(txt).not.toContain(secret); expect(txt).not.toMatch(/"(old_enc|new_enc|account_hash|enc)"/); }
    // The stored rows hold sealed values only.
    const rows = JSON.stringify(sql.prepare("SELECT * FROM bank_change_requests").all()) + JSON.stringify(sql.prepare("SELECT * FROM supplier_payout_details").all());
    for (const secret of [IBAN, ACCOUNT, WALLET]) expect(rows).not.toContain(secret);
    // An approved wallet is the one value stored in full, on the supplier record only, because the pay flow needs it.
    const wid = w.json().id; await callback(app, sam, wid); const wok = await decide(app, sam, wid); expect(wok.statusCode).toBe(200);
    expect(fab().walletAddress).toBe(WALLET); expect(fab().acceptedRails).toEqual(expect.arrayContaining(["stripe_ach", "circle_usdc", "onchain_usdc"]));
    for (const txt of [wok.body, (await app.inject({ url: "/bank-changes?status=all", headers: { cookie: sam } })).body, JSON.stringify(db.evidence), JSON.stringify(sql.prepare("SELECT * FROM bank_change_requests").all()) + JSON.stringify(sql.prepare("SELECT * FROM supplier_payout_details").all())]) expect(txt).not.toContain(WALLET);
    // Bank numbers stay hidden everywhere, also on the supplier record.
    for (const secret of [IBAN, ACCOUNT, ROUTING]) expect(JSON.stringify(db.suppliers)).not.toContain(secret);
  });

  it("takes the country from the IBAN, not from what the requester types", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    const r = await ask(app, pat, "sup-contoso", bank({ holderName: "Contoso Logistics Ltd", country: "GB" }));
    expect(r.statusCode).toBe(200); expect(r.json().old.country).toBe("GB"); expect(r.json().new.country).toBe("DE");
    expect(r.json().signals.map((x: any) => x.code)).toContain("different_country");
  });

  it("needs a call-back phone on file and lets only a reviewer set it", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const jane = await login(app, "usr-cfo-jane");
    const phone = (cookie: string, v: string) => app.inject({ method: "PUT", url: "/suppliers/sup-northwind/callback-phone", headers: { cookie }, payload: { phone: v } });
    delete northwind().contactPhone;
    const no = await ask(app, pat); expect(no.statusCode).toBe(409); expect(no.json().error).toMatch(/call-back phone/);
    expect(BC.list("tnt-acme")).toHaveLength(0); expect(BC.paymentHold("tnt-acme", "sup-northwind")).toBeNull();
    expect((await phone(pat, "+1 312 555 0199")).statusCode).toBe(403);
    expect((await phone(jane, "call me")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await phone(jane, "+1 312 555 0199")).statusCode).toBe(200); expect(northwind().contactPhone).toBe("+1 312 555 0199");
    expect(JSON.stringify(db.evidence.filter((e) => e.event === "supplier.callback_phone_changed"))).not.toContain("312 555");
    const r = await ask(app, pat); expect(r.statusCode).toBe(200); expect(r.json().signals.map((x: any) => x.code)).toContain("phone_changed");
    // Locked while the request waits.
    const locked = await phone(jane, "+1 312 555 0100"); expect(locked.statusCode).toBe(409); expect(northwind().contactPhone).toBe("+1 312 555 0199");
  });

  it("refuses requests from agent keys", async () => {
    const app = await buildApp();
    const reg = W.registerAgent(P.getUser("usr-cfo-jane")!, "tnt-acme", { name: "Spares bot", erpRole: "buyer.requisitioner", protocols: ["mcp"], mandate: { perTxnMax: 500, monthlyLimit: 600, allowedCategories: ["mro"], allowedRails: ["stripe_ach"], validTo: new Date(Date.now() + 30 * 864e5).toISOString() } as any });
    const r = await app.inject({ method: "POST", url: "/suppliers/sup-northwind/bank-changes", headers: { authorization: `Bearer ${reg.key.key}` }, payload: bank() });
    expect(r.statusCode).toBe(403); expect(r.json().error).toMatch(/signed-in person/);
    expect(BC.list("tnt-acme")).toHaveLength(0); expect(BC.paymentHold("tnt-acme", "sup-northwind")).toBeNull();
  });

  it("holds payments for the cooling-off time after a change made through the older routes", async () => {
    expect(BC.paymentHold("tnt-acme", "sup-northwind")).toBeNull();
    appendEvidence(db.evidence, "supplier", "sup-northwind", "payee_change.applied", { field: "walletAddress" });
    expect(BC.paymentHold("tnt-acme", "sup-northwind")).toMatch(/cooling-off/);
    expect(BC.paymentHold("tnt-acme", "sup-contoso")).toBeNull();
    expect(BC.paymentHold("tnt-acme", "sup-northwind", Date.now() + 25 * 3_600_000)).toBeNull();
    const intent = await pay(); expect(intent.status).toBe("blocked"); expect(intent.blockedReason).toMatch(/cooling-off/);
  });

  it("seeds the demo request on a fresh database once the users exist", async () => {
    useDb(":memory:"); reload(); reset();
    const hadJane = !!P.getUser("usr-cfo-jane");
    if (!hadJane) expect(BC.seedDemo(true)).toBeNull();
    P.seedPlatform();
    expect(BC.seedDemo(true)?.status).toBe("pending");
  });

  it("seeds one pending demo request on Contoso and feeds the copilot", async () => {
    expect(BC.list(null)).toHaveLength(0);
    const r = BC.seedDemo(true)!; expect(r.supplierId).toBe("sup-contoso"); expect(r.status).toBe("pending");
    expect(r.old.country).toBe("GB"); expect(r.new.country).toBe("DE");
    expect(r.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["different_country", "different_bank", "requester_can_approve", "channel"]));
    expect(BC.seedDemo(true)).toBeNull(); expect(BC.list("tnt-acme", { status: "pending" })).toHaveLength(1); expect(BC.list("tnt-globex")).toHaveLength(0);
    const t = CP.runTool({ user: P.getUser("usr-cfo-jane")!, scope: "tnt-acme", prefix: "/app" }, "bankChanges");
    expect(t.rows).toHaveLength(1); expect((t.rows[0] as any).paymentsHeld).toBe(true); expect(t.summary).toMatch(/1 waiting/);
    expect(CP.mockPlan("any supplier bank detail changes waiting?").map((p) => p.name)).toContain("bankChanges");
  });
});

describe("ERP vendor master changes go through the bank-change check", () => {
  it("creates a pending request with the ERP channel and applies nothing", async () => {
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const pat = await login(app, "usr-clerk-pat"); const before = northwind().bankDetailsRef;
    const { channel, channelNote, ...rest } = bank();
    const r = await app.inject({ method: "POST", url: "/erp/vendor-master/changes", headers: { cookie: jane }, payload: { supplierId: "sup-northwind", ...rest, channel: "email", channelNote: "Vendor master sync" } });
    expect(r.statusCode).toBe(200); expect(r.json().status).toBe("pending"); expect(r.json().channel).toBe("erp");
    expect(northwind().bankDetailsRef).toBe(before);
    expect((await app.inject({ method: "POST", url: "/erp/vendor-master/changes", headers: { cookie: pat }, payload: { supplierId: "sup-northwind", ...rest } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/erp/vendor-master/changes/${r.json().id}/approve`, headers: { cookie: jane }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/workspace/suppliers/sup-northwind/payee-change", headers: { cookie: pat }, payload: {} })).statusCode).toBe(404);
  });
});
