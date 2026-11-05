import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as C from "../src/cards.js";
import * as CP from "../src/copilot.js";
import * as FV from "../src/flowview.js";
import * as O from "../src/ops.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); C.setIssuer(null); });
const pat = () => P.getUser("usr-clerk-pat")!;
const issue = (x: any) => C.issueCard(pat(), "tnt-acme", null, { label: "Test card", currency: "USD", ...x }).then((r) => r.card);
const auth = (id: string, merchant: string, amount: number, extra: Partial<C.AuthRequest> = {}, at?: number) => C.authorize("tnt-acme", id, { merchant, amount, ...extra }, { source: "simulator", actor: "usr-clerk-pat", at });

describe("virtual cards", () => {
  it("uses the simulated issuer in tests and shows last4 only", async () => {
    expect((await C.issuerInfo()).label).toBe("Simulated issuer");
    const c = await issue({ type: "recurring", limit: 500 });
    expect(c.status).toBe("active"); expect(c.last4).toMatch(/^\d{4}$/); expect(c.issuerLabel).toBe("Simulated issuer");
  });

  it("gives each decline reason in plain words", async () => {
    const c = await issue({ type: "recurring", limit: 100, mcc: "5085" });
    expect(auth(c.id, "Grainger", 150, { mcc: "5085" }).decision.code).toBe("over_limit");
    expect(auth(c.id, "Grainger", 10, { mcc: "5999" }).decision.code).toBe("wrong_merchant");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085", currency: "EUR" }).decision.code).toBe("wrong_currency");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }, Date.now() + 6 * 365 * 864e5).decision.code).toBe("expired");
    await C.setState(pat(), "tnt-acme", c.id, "freeze");
    const fz = auth(c.id, "Grainger", 10, { mcc: "5085" }); expect(fz.decision.code).toBe("frozen"); expect(fz.decision.reason).toMatch(/frozen/);
    await C.setState(pat(), "tnt-acme", c.id, "unfreeze");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }).decision.approved).toBe(true);
    await C.setState(pat(), "tnt-acme", c.id, "cancel");
    expect(auth(c.id, "Grainger", 10, { mcc: "5085" }).decision.code).toBe("canceled");
  });

  it("closes a one-time card after the first charge", async () => {
    const c = await issue({ type: "one_time", limit: 300 });
    expect(auth(c.id, "Any shop", 120).decision.approved).toBe(true);
    expect(C.cardDetail("tnt-acme", c.id).card.status).toBe("closed");
    const again = auth(c.id, "Any shop", 10); expect(again.decision.code).toBe("already_used");
  });

  it("locks a vendor card to one supplier", async () => {
    await expect(issue({ type: "vendor_locked", limit: 1000 })).rejects.toThrow(/exactly one/);
    const c = await issue({ type: "vendor_locked", limit: 1000, supplierId: "sup-northwind" });
    expect(auth(c.id, "Northwind Components LLC", 200).decision.approved).toBe(true);
    expect(auth(c.id, "Contoso Logistics Ltd", 200).decision.code).toBe("wrong_merchant");
  });

  it("scopes an agent card to the mandate limit and allowed suppliers", async () => {
    await expect(issue({ type: "agent", agentId: "agt-buyer-1", limit: 90000 })).rejects.toThrow(/monthly limit/);
    const c = await issue({ type: "agent", agentId: "agt-buyer-1", limit: 5000 });
    expect(c.ownerType).toBe("agent"); expect(c.allowedMerchants).toContain("Contoso Logistics Ltd");
    expect(auth(c.id, "Contoso Logistics Ltd", 3000).decision.approved).toBe(true);
    expect(auth(c.id, "Contoso Logistics Ltd", 3000).decision.code).toBe("over_limit");
    expect(auth(c.id, "Random Store", 10).decision.code).toBe("wrong_merchant");
    db.agents.find((a) => a.id === "agt-buyer-1")!.status = "suspended";
    expect(auth(c.id, "Contoso Logistics Ltd", 10).decision.code).toBe("agent_paused");
  });

  it("needs maker-checker and step-up for a large card", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const sam = await login("usr-controller-sam"); const lee = await login("usr-treasurer-lee");
    const body = { type: "recurring", label: "Big card", limit: 20000, currency: "USD" };
    const no = await app.inject({ method: "POST", url: "/cards", headers: { cookie: sam }, payload: body });
    expect(no.statusCode).toBe(403); expect(no.json().error).toMatch(/step_up_required/);
    await stepUp(app, sam);
    const req = await app.inject({ method: "POST", url: "/cards", headers: { cookie: sam }, payload: body });
    expect(req.statusCode).toBe(200); expect(req.json().needsApproval).toBe(true); const id = req.json().card.id;
    expect(C.decide(C.getCard("tnt-acme", id), { merchant: "x", amount: 1 }).code).toBe("not_issued");
    const self = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: sam }, payload: { approve: true } });
    expect(self.statusCode).toBe(403); expect(self.json().error).toMatch(/cannot approve/);
    const noCode = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: lee }, payload: { approve: true } });
    expect(noCode.statusCode).toBe(403); expect(noCode.json().error).toMatch(/step_up_required/);
    await stepUp(app, lee);
    const ok = await app.inject({ method: "POST", url: `/cards/${id}/decide`, headers: { cookie: lee }, payload: { approve: true } });
    expect(ok.statusCode).toBe(200); expect(ok.json().status).toBe("active"); expect(ok.json().approvedBy).toBe("usr-treasurer-lee");
    const ev = db.evidence.filter((e) => e.subjectId === id).map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(["card.requested", "card.approved", "card.issued"]));
  });

  it("keeps cards inside their tenant and never returns a card number", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const patC = await login("usr-clerk-pat"); const gina = await login("usr-globex-gina");
    const made = await app.inject({ method: "POST", url: "/cards", headers: { cookie: patC }, payload: { type: "one_time", label: "Lunch", limit: 50 } });
    expect(made.statusCode).toBe(200); const id = made.json().card.id;
    expect((await app.inject({ url: "/cards", headers: { cookie: gina } })).json().cards).toEqual([]);
    expect((await app.inject({ url: `/cards/${id}`, headers: { cookie: gina } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/cards/${id}/freeze`, headers: { cookie: gina } })).statusCode).toBe(404);
    const sim = await app.inject({ method: "POST", url: `/cards/${id}/simulate`, headers: { cookie: patC }, payload: { merchant: "Cafe", amount: 20 } });
    expect(sim.json().decision.approved).toBe(true);
    const rv = await app.inject({ method: "POST", url: `/cards/${id}/reveal`, headers: { cookie: patC } });
    expect(rv.statusCode).toBe(403);
    const all = [made.body, sim.body, (await app.inject({ url: "/cards", headers: { cookie: patC } })).body, (await app.inject({ url: `/cards/${id}`, headers: { cookie: patC } })).body];
    for (const txt of all) { expect(txt).not.toMatch(/\b\d{13,19}\b/); expect(txt).not.toMatch(/"(number|pan|cvc|cvv)"\s*:\s*"\d/i); }
    await stepUp(app, patC);
    const rv2 = await app.inject({ method: "POST", url: `/cards/${id}/reveal`, headers: { cookie: patC } });
    expect(rv2.json().mocked).toBe(true); expect(rv2.body).not.toMatch(/\d{13,19}/); expect(rv2.json().cvc).toBe("•••");
  });

  it("feeds transactions, reconciliation and the copilot", async () => {
    const c = await issue({ type: "recurring", limit: 400 });
    auth(c.id, "Office Depot", 80); auth(c.id, "Office Depot", 900);
    const tx = FV.transactions("tnt-acme").rows.filter((r) => r.rail === "card_issuing");
    expect(tx.map((r) => r.status).sort()).toEqual(["denied", "settled"]);
    expect(FV.transactions("tnt-globex").rows.some((r) => r.rail === "card_issuing")).toBe(false);
    const rec = O.runRecon("tnt-acme").rows.filter((r) => r.rail === "card_issuing");
    expect(rec).toHaveLength(1); expect(rec[0].status).toBe("matched");
    const t = CP.runTool({ user: P.getUser("usr-cfo-jane")!, scope: "tnt-acme", prefix: "/app" }, "cardSpend");
    expect(t.rows).toHaveLength(1); expect((t.rows[0] as any).spent).toBe(80);
    expect(CP.mockPlan("how much have we spent on cards").map((p) => p.name)).toContain("cardSpend");
  });
});
