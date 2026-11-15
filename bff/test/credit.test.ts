import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db, tenantOf } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as CR from "../src/credit.js";
import * as CP from "../src/copilot.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const user = (id: string) => P.getUser(id)!;
const pat = () => user("usr-clerk-pat"); const sam = () => user("usr-controller-sam"); const lee = () => user("usr-treasurer-lee"); const olivia = () => user("usr-op-olivia");
const draw = (amount: number, by = pat()) => CR.requestDraw(by, "tnt-acme", { amount, purpose: "Cover the week 3 gap" });
const fund = (amount: number) => { const d = draw(amount); return CR.decideDraw(sam(), "tnt-acme", null, d.id, true); };
const journalsOf = (t: string) => db.journals.filter((j) => tenantOf(j) === t);
const net = (j: { entries: { debit: number; credit: number }[] }) => Math.round(j.entries.reduce((a, e) => a + e.debit - e.credit, 0) * 100);

describe("simulated credit line", () => {
  it("seeds one demo line and lets only the bank operator set limit and rate", () => {
    expect(CR.getLine("tnt-acme")).toMatchObject({ limit: 50000, aprPct: 9.5, currency: "USD", status: "active", bankId: "bank-northstar" });
    expect(CR.getLine("tnt-globex")).toBeNull();
    expect(() => CR.setLine(user("usr-cfo-jane"), "tnt-acme", { limit: 900000, aprPct: 1 })).toThrow(/Only the bank operator/);
    expect(() => CR.setLine(user("usr-audit-ava"), "tnt-acme", { limit: 900000, aprPct: 1 })).toThrow(/treasury.sweep/);
    const l = CR.setLine(olivia(), "tnt-globex", { limit: 20000, aprPct: 11 });
    expect(l).toMatchObject({ tenantId: "tnt-globex", bankId: "bank-harbor", limit: 20000, aprPct: 11, setBy: "usr-op-olivia" });
    expect(db.evidence.some((e: any) => e.event === "credit.line_set" && e.subjectId === "tnt-globex")).toBe(true);
  });

  it("blocks a draw over the limit, and counts draws that wait for approval", () => {
    expect(() => draw(50000.01)).toThrow(/over the credit limit/);
    draw(30000);
    expect(() => draw(25000)).toThrow(/over the credit limit. 20000.00 USD is left/);
    expect(CR.usage("tnt-acme")).toMatchObject({ outstanding: 0, pending: 30000, available: 20000, usedPct: 60 });
    expect(journalsOf("tnt-acme").some((j) => j.memo.startsWith("Credit line"))).toBe(false);
  });

  it("does not let the maker approve their own draw, and needs the approve permission", () => {
    const d = draw(2000, sam());
    expect(() => CR.decideDraw(sam(), "tnt-acme", null, d.id, true)).toThrow(/cannot approve it/);
    expect(() => CR.decideDraw(pat(), "tnt-acme", null, d.id, true)).toThrow(/payments.approve/);
    expect(CR.getDraw("tnt-acme", d.id).status).toBe("pending_approval");
    const ok = CR.decideDraw(lee(), "tnt-acme", null, d.id, true);
    expect(ok).toMatchObject({ status: "funded", outstanding: 2000, decidedBy: "usr-treasurer-lee" });
    expect(() => CR.decideDraw(lee(), "tnt-acme", null, d.id, true)).toThrow(/already funded/);
    const r = draw(100); expect(CR.decideDraw(sam(), "tnt-acme", null, r.id, false).status).toBe("rejected");
    expect(CR.usage("tnt-acme")).toMatchObject({ outstanding: 2000, pending: 0 });
  });

  it("needs a fresh authenticator code to approve a draw over the threshold", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const patC = await login("usr-clerk-pat"); const samC = await login("usr-controller-sam");
    const small = await app.inject({ method: "POST", url: "/credit/draws", headers: { cookie: patC }, payload: { amount: 500, purpose: "Small top up" } });
    expect(small.statusCode).toBe(200); expect(small.json().needsStepUp).toBe(false);
    expect((await app.inject({ method: "POST", url: `/credit/draws/${small.json().id}/decide`, headers: { cookie: samC }, payload: { approve: true } })).json().status).toBe("funded");
    const big = await app.inject({ method: "POST", url: "/credit/draws", headers: { cookie: patC }, payload: { amount: 20000, purpose: "Supplier run for line 3" } });
    expect(big.json().needsStepUp).toBe(true);
    const own = await app.inject({ method: "POST", url: `/credit/draws/${big.json().id}/decide`, headers: { cookie: patC }, payload: { approve: true } });
    expect(own.statusCode).toBe(403);
    const no = await app.inject({ method: "POST", url: `/credit/draws/${big.json().id}/decide`, headers: { cookie: samC }, payload: { approve: true } });
    expect(no.statusCode).toBe(403); expect(no.json().error).toMatch(/step_up_required/);
    expect(CR.usage("tnt-acme")).toMatchObject({ outstanding: 500, pending: 20000 });
    await stepUp(app, samC);
    const yes = await app.inject({ method: "POST", url: `/credit/draws/${big.json().id}/decide`, headers: { cookie: samC }, payload: { approve: true } });
    expect(yes.statusCode).toBe(200); expect(yes.json().status).toBe("funded");
    const page = (await app.inject({ url: "/credit", headers: { cookie: patC } })).json();
    expect(page.lender).toBe("Simulated lender"); expect(page.usage).toMatchObject({ outstanding: 20500, available: 29500 });
    expect(db.evidence.some((e: any) => e.event === "credit.draw_funded" && e.payload?.steppedUp === true)).toBe(true);
    await app.close();
  });

  it("books balanced ledger entries for a draw and a repayment with interest", () => {
    const cash0 = S.entitiesView("tnt-acme").find((e) => e.id === "ent-acme-us")!.cash;
    const d = fund(5000);
    const at = Date.parse(d.fundedAt!) + 30 * 864e5;
    const r = CR.repay(sam(), "tnt-acme", d.id, 2000, at);
    expect(r.repayment).toMatchObject({ principal: 2000, interest: 15.62, days: 30 });
    expect(r.draw).toMatchObject({ status: "funded", outstanding: 3000, interestPaid: 15.62 });
    const js = journalsOf("tnt-acme").filter((j) => j.ref === d.id);
    expect(js).toHaveLength(2); for (const j of js) { expect(net(j)).toBe(0); expect(j.entityId).toBe("ent-acme-us"); }
    expect(js[0].entries.map((e) => [e.account, e.debit, e.credit])).toEqual([[CR.CASH, 5000, 0], [CR.LIABILITY, 0, 5000]]);
    expect(js[1].entries.map((e) => [e.account, e.debit, e.credit])).toEqual([[CR.LIABILITY, 2000, 0], [CR.INTEREST, 15.62, 0], [CR.CASH, 0, 2015.62]]);
    expect(CR.ledgerOwed("tnt-acme")).toBe(3000); expect(CR.usage("tnt-acme").outstanding).toBe(3000);
    const books = S.entityLedgerView("ent-acme-us", "tnt-acme");
    expect(books.balanced).toBe(true); expect(books.trialBalance.accounts[CR.LIABILITY].balance).toBe(-3000);
    expect(S.entitiesView("tnt-acme").find((e) => e.id === "ent-acme-us")!.cash).toBeCloseTo(cash0 + 5000 - 2015.62, 2);
    expect(() => CR.repay(sam(), "tnt-acme", d.id, 3000.01, at)).toThrow(/at most 3000.00/);
    expect(() => CR.repay(pat(), "tnt-acme", d.id, undefined, at)).not.toThrow();
    expect(CR.getDraw("tnt-acme", d.id)).toMatchObject({ status: "repaid", outstanding: 0 });
    expect(CR.ledgerOwed("tnt-acme")).toBe(0); expect(CR.usage("tnt-acme").available).toBe(50000);
    expect(S.entityLedgerView("ent-acme-us", "tnt-acme").balanced).toBe(true);
    expect(() => CR.repay(sam(), "tnt-acme", d.id, 1)).toThrow(/already repaid/);
  });

  it("keeps the bank inside its exposure cap and respects a frozen line", () => {
    expect(() => CR.setCap(sam(), "bank-northstar", 6000)).toThrow(/Only the bank operator/);
    expect(CR.setCap(olivia(), "bank-northstar", 6000)).toMatchObject({ cap: 6000, outstanding: 0 });
    const d = fund(5000);
    expect(() => draw(2000)).toThrow(/over the bank exposure cap. The bank can lend 1000.00 USD more/);
    expect(draw(1000).status).toBe("pending_approval");
    expect(CR.exposure("bank-northstar")).toMatchObject({ outstanding: 5000, pending: 1000, headroom: 1000, committed: 50000 });
    expect(() => CR.setLine(olivia(), "tnt-acme", { limit: 4000, aprPct: 9.5 })).toThrow(/cannot be below the 5000.00 USD already drawn/);
    CR.setLine(olivia(), "tnt-acme", { limit: 50000, aprPct: 9.5, status: "frozen" });
    expect(() => draw(10)).toThrow(/frozen by the bank/);
    expect(CR.repay(sam(), "tnt-acme", d.id, 5000).draw.status).toBe("repaid");
  });

  it("keeps tenants apart", async () => {
    const d = fund(4000); const gina = user("usr-globex-gina"); const gus = user("usr-globex-gus");
    expect(() => CR.getDraw("tnt-globex", d.id)).toThrow(/not found/);
    expect(() => CR.decideDraw(gus, "tnt-globex", null, d.id, true)).toThrow(/not found/);
    expect(() => CR.repay(gina, "tnt-globex", d.id, 100)).toThrow(/not found/);
    expect(() => CR.requestDraw(gina, "tnt-acme", { amount: 10, purpose: "Not mine" })).toThrow(/another tenant/);
    expect(() => CR.requestDraw(gina, "tnt-globex", { amount: 10, purpose: "No line yet" })).toThrow(/has not set up a credit line/);
    expect(CR.view("tnt-globex")).toMatchObject({ line: null, draws: [], repayments: [], usage: { outstanding: 0, limit: 0 } });
    expect(journalsOf("tnt-globex").some((j) => j.memo.startsWith("Credit line"))).toBe(false);
    CR.setLine(olivia(), "tnt-globex", { limit: 8000, aprPct: 12 });
    expect(CR.exposure("bank-harbor")).toMatchObject({ outstanding: 0, committed: 8000 }); expect(CR.exposure("bank-northstar").outstanding).toBe(4000);
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const ginaC = await login("usr-globex-gina"); const oliviaC = await login("usr-op-olivia");
    const page = (await app.inject({ url: "/credit", headers: { cookie: ginaC } })).json();
    expect(page.line.limit).toBe(8000); expect(page.draws).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/credit/draws/${d.id}/repay`, headers: { cookie: ginaC }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: "/credit?tenantId=tnt-acme", headers: { cookie: ginaC } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/ops/credit", headers: { cookie: ginaC } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/ops/credit/lines/tnt-globex", headers: { cookie: ginaC }, payload: { limit: 999999, aprPct: 0 } })).statusCode).toBe(403);
    const ops = await app.inject({ url: "/ops/credit", headers: { cookie: oliviaC } });
    expect(ops.statusCode).toBe(200); expect(ops.json().clients.map((c: any) => [c.tenantId, c.outstanding])).toEqual(expect.arrayContaining([["tnt-acme", 4000], ["tnt-globex", 0]]));
    const put = await app.inject({ method: "PUT", url: "/ops/credit/lines/tnt-globex", headers: { cookie: oliviaC }, payload: { limit: 9000, aprPct: 10 } });
    expect(put.statusCode).toBe(200); expect(put.json().limit).toBe(9000);
    await app.close();
  });

  it("gives the copilot a read tool for line usage, scoped to the tenant", () => {
    fund(4000); draw(1000);
    const ctx = (id: string, scope: string | null): CP.Ctx => ({ user: user(id), scope, prefix: scope ? "/app" : "/operator" });
    const a = CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "creditLine");
    expect(a.error).toBeUndefined(); expect(a.rows).toEqual([expect.objectContaining({ tenantId: "tnt-acme", limit: 50000, drawn: 4000, waitingForApproval: 1000, available: 45000, openDraws: 1, pendingDraws: 1 })]);
    expect(a.summary).toContain("Simulated lender"); expect(a.summary).not.toMatch(/[—;]/); expect(a.source.links[0].href).toBe("/app/credit");
    const g = CP.runTool(ctx("usr-globex-gina", "tnt-globex"), "creditLine");
    expect(g.rows).toEqual([]); expect(g.summary).toMatch(/No credit line is set up/); expect(JSON.stringify(g)).not.toContain("tnt-acme");
    expect(() => CP.runTool(ctx("usr-globex-gina", "tnt-acme"), "creditLine")).toThrow();
    expect(CP.runTool(ctx("usr-op-olivia", null), "creditLine").rows.map((r: any) => r.tenantId)).toEqual(["tnt-acme"]);
    expect(CP.mockPlan("How much of my credit line is used?").map((p) => p.name)).toContain("creditLine");
    expect(CP.mockPlan("Can we borrow working capital?").map((p) => p.name)).toContain("creditLine");
    expect(CR.LENDER_NOTE).not.toMatch(/[—;]/);
  });
});
