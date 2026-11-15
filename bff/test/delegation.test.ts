import { describe, it, expect, beforeEach } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as I from "../src/iam.js";
import * as W from "../src/workspace.js";
import * as DLG from "../src/delegation.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const user = (id: string) => P.getUser(id)!;
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const agentPo = (qty = 70) => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty, unitPrice: 420 }], justification: "Line 4 retrofit" });
const bigPo = (qty = 70) => { const po = agentPo(qty); po.requestedBy = "usr-clerk-pat"; return po; };
const audits = (event: string) => sql.prepare("SELECT * FROM audit WHERE event = ?").all(event) as any[];

describe("approval delegation", () => {
  it("lets a delegate approve a level for the person who handed over, and records both names", () => {
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam", "Budget ok");
    expect(() => S.decideApproval(po.id, true, "usr-treasurer-lee")).toThrow(/client admin/);
    const d = DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5), note: "On leave" });
    expect(d.state).toBe("active");
    const row = W.approvalsInbox(user("usr-treasurer-lee"), "tnt-acme").find((x) => x.id === po.id)!;
    expect(row.canAct).toBe(true); expect(row.delegatedFrom?.userId).toBe("usr-cfo-jane");
    S.decideApproval(po.id, true, "usr-treasurer-lee", "For Jane");
    expect(po.status).toBe("approved");
    expect(po.approval!.levels[1].approvals[0]).toMatchObject({ userId: "usr-treasurer-lee", onBehalfOf: "usr-cfo-jane" });
    expect(audits("approval.delegated").length).toBeGreaterThan(0); expect(audits("approval.delegate_approved").length).toBeGreaterThan(0);
  });

  it("refuses self delegation, non approvers, bad dates and other tenants", () => {
    const jane = user("usr-cfo-jane");
    expect(() => DLG.create(user("usr-controller-sam"), "tnt-acme", { toUserId: "usr-controller-sam", startsOn: day(0), endsOn: day(1) })).toThrow(/yourself/);
    expect(() => DLG.create(jane, "tnt-acme", { toUserId: "usr-clerk-pat", startsOn: day(0), endsOn: day(1) })).toThrow(/approver role/);
    expect(() => DLG.create(jane, "tnt-acme", { toUserId: "usr-acme-amara", startsOn: day(0), endsOn: day(1) })).toThrow(/approver role/);
    expect(() => DLG.create(jane, "tnt-acme", { toUserId: "usr-globex-gus", startsOn: day(0), endsOn: day(1) })).toThrow(/not in this business/);
    expect(() => DLG.create(jane, "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(3), endsOn: day(1) })).toThrow(/on or after/);
    expect(() => DLG.create(jane, "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(200) })).toThrow(/90 days/);
    expect(() => DLG.create(user("usr-clerk-pat"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(1) })).toThrow();
  });

  it("does not let a delegate act on an order they raised, or for a requester, and keeps earlier-level SoD", async () => {
    DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5) });
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam");
    expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(true);
    po.requestedBy = "usr-treasurer-lee"; expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    po.requestedBy = "usr-cfo-jane"; expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    po.requestedBy = "usr-clerk-pat"; po.approval!.levels[0].approvals[0].userId = "usr-treasurer-lee";
    expect(S.canApprove(po, user("usr-treasurer-lee")).why).toMatch(/already approved/);
  });

  it("applies the delegate's own amount limit, ends on revoke and ignores future ranges", async () => {
    const r = I.saveRole(user("usr-cfo-jane"), "tnt-acme", { name: "Small approver", baseRole: "approver", permissions: ["payments.approve", "workspace.read", "flow.operate"], approveLimit: 1000 });
    I.assignRole(user("usr-cfo-jane"), "usr-treasurer-lee", r.id);
    const d = DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5) });
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam");
    const app = await buildApp(); const lee = await login(app, "usr-treasurer-lee"); await stepUp(app, lee);
    const res = await app.inject({ method: "POST", url: `/approvals/${po.id}`, headers: { cookie: lee }, payload: { approve: true } });
    expect(res.statusCode).toBe(403); expect(res.json().error).toMatch(/above the limit of 1000/);
    const jane = await login(app, "usr-cfo-jane");
    expect((await app.inject({ method: "POST", url: `/approvals/delegations/${d.id}/revoke`, headers: { cookie: lee } })).statusCode).toBe(403);
    const rv = await app.inject({ method: "POST", url: `/approvals/delegations/${d.id}/revoke`, headers: { cookie: jane } }); expect(rv.json().state).toBe("revoked");
    expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(2), endsOn: day(5) });
    expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    const list = (await app.inject({ url: "/approvals/delegations", headers: { cookie: jane } })).json();
    expect(list.delegations.map((x: any) => x.state).sort()).toEqual(["revoked", "upcoming"]);
    expect(list.candidates.map((x: any) => x.id)).toContain("usr-treasurer-lee");
  });
});

describe("resubmit after rejection", () => {
  it("lets the requester send a rejected order again with a note, and keeps the history", async () => {
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat"); const sam = await login(app, "usr-controller-sam");
    const c = await app.inject({ method: "POST", url: "/purchase-orders", headers: { cookie: pat }, payload: { draft: { supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 70, unitPrice: 420 }], justification: "Line 4 retrofit" } } });
    const id = c.json().id; expect(c.json().status).toBe("pending_approval");
    const rej = await app.inject({ method: "POST", url: `/approvals/${id}`, headers: { cookie: sam }, payload: { approve: false, comment: "Too many" } }); expect(rej.json().status).toBe("rejected");
    expect((await app.inject({ method: "POST", url: `/approvals/${id}/resubmit`, headers: { cookie: sam }, payload: { note: "Fewer units" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/approvals/${id}/resubmit`, headers: { cookie: pat }, payload: { note: "" } })).statusCode).toBe(422);
    const inbox = (await app.inject({ url: "/workspace/approvals", headers: { cookie: pat } })).json().find((x: any) => x.id === id); expect(inbox.canResubmit).toBe(true);
    const r = await app.inject({ method: "POST", url: `/approvals/${id}/resubmit`, headers: { cookie: pat }, payload: { note: "Split the order, need it this month" } });
    expect(r.statusCode).toBe(200); expect(r.json().status).toBe("pending_approval");
    const po = db.pos.find((p) => p.id === id)!;
    expect(po.approval!.round).toBe(2); expect(po.approval!.current).toBe(0); expect(po.approval!.rejectedBy).toBeUndefined();
    expect(po.approval!.history![0]).toMatchObject({ round: 1, note: "Split the order, need it this month", resubmittedBy: "usr-clerk-pat", rejectedBy: { userId: "usr-controller-sam", comment: "Too many" } });
    expect(db.evidence.filter((e) => e.subjectId === id).map((e) => e.event)).toEqual(expect.arrayContaining(["approval.rejected", "approval.resubmitted"]));
    expect(audits("approval.resubmitted").length).toBeGreaterThan(0);
    expect((await app.inject({ method: "POST", url: `/approvals/${id}/resubmit`, headers: { cookie: pat }, payload: { note: "Again" } })).statusCode).toBe(409);
    S.decideApproval(id, true, "usr-controller-sam"); S.decideApproval(id, true, "usr-cfo-jane");
    expect(po.status).toBe("approved");
  });

  it("blocks the mandate principal on an agent order, directly and through a delegate", () => {
    const po = agentPo(); expect(po.requestedBy).toBeUndefined(); expect(S.requesterOf(po)).toBe("usr-cfo-jane");
    S.decideApproval(po.id, true, "usr-controller-sam");
    expect(S.canApprove(po, user("usr-cfo-jane")).why).toMatch(/You raised this order/);
    DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5) });
    expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    expect(S.canApprove(po, user("usr-acme-amara")).ok).toBe(true);
  });

  it("lets an approver act at a higher role level only through a hand over, by design", () => {
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam");
    expect(po.approval!.levels[1].role).toBe("client_admin");
    expect(S.canApprove(po, user("usr-treasurer-lee")).ok).toBe(false);
    DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5) });
    expect(S.canApprove(po, user("usr-treasurer-lee"))).toMatchObject({ ok: true, onBehalfOf: "usr-cfo-jane" });
  });

  it("ignores a delegation from another tenant", () => {
    DLG.create(user("usr-globex-gina"), "tnt-globex", { toUserId: "usr-globex-gus", startsOn: day(0), endsOn: day(5) });
    const po = bigPo(); S.decideApproval(po.id, true, "usr-controller-sam");
    expect(S.canApprove(po, user("usr-globex-gus")).ok).toBe(false);
    expect(DLG.activeFor("usr-globex-gus", "tnt-acme")).toEqual([]);
  });

  it("caps resubmits at 5 and keeps the rejecting level and delegate in the evidence", () => {
    DLG.create(user("usr-cfo-jane"), "tnt-acme", { toUserId: "usr-treasurer-lee", startsOn: day(0), endsOn: day(5) });
    const po = bigPo();
    S.decideApproval(po.id, true, "usr-controller-sam"); S.decideApproval(po.id, false, "usr-treasurer-lee", "No");
    S.resubmitPo(po.id, "usr-clerk-pat", "Fewer units");
    expect(po.approval!.history![0]).toMatchObject({ rejectedLevel: 2, rejectedRole: "client_admin" });
    for (let i = 0; i < 4; i++) { S.decideApproval(po.id, false, "usr-controller-sam", "No"); S.resubmitPo(po.id, "usr-clerk-pat", `Try ${i}`); }
    S.decideApproval(po.id, false, "usr-controller-sam", "No");
    expect(() => S.resubmitPo(po.id, "usr-clerk-pat", "Again")).toThrow(/too many/);
    po.status = "paid";
    const rej = S.disputeEvidence("tnt-acme", po.id).approvals.decisions.find((d: any) => d.decision === "rejected" && d.round === 1);
    expect(rej).toMatchObject({ level: 2, role: "client_admin", userId: "usr-treasurer-lee", onBehalfOf: "usr-cfo-jane" });
  });

  it("lets a requester without flow.operate resubmit through the route", async () => {
    const r = I.saveRole(user("usr-cfo-jane"), "tnt-acme", { name: "Read only", baseRole: "ap_clerk", permissions: ["workspace.read"] });
    I.assignRole(user("usr-cfo-jane"), "usr-clerk-pat", r.id);
    const po = bigPo(); S.decideApproval(po.id, false, "usr-controller-sam", "No");
    const app = await buildApp(); const pat = await login(app, "usr-clerk-pat");
    const res = await app.inject({ method: "POST", url: `/approvals/${po.id}/resubmit`, headers: { cookie: pat }, payload: { note: "Fewer units" } });
    expect(res.statusCode).toBe(200); expect(res.json().status).toBe("pending_approval");
  });
});
