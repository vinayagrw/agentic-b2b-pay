import { describe, it, expect, beforeEach } from "vitest";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as P from "../src/platform.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const ctx = (id: string, scope: string | null): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator" });
const bigPo = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 30, unitPrice: 420 }], justification: "Line 4 retrofit" });
const line = (o: unknown) => JSON.stringify(o);
const dropped = () => db.evidence.filter((e) => e.event === "copilot.proposal.dropped").map((e: any) => e.data?.why ?? e.payload?.why ?? JSON.stringify(e));

describe("PROPOSE validator", () => {
  it("accepts a grounded approve_po in the caller tenant and marks it model", () => {
    const po = bigPo(); const c = ctx("usr-controller-sam", "tnt-acme"); const rows = [CP.runTool(c, "pendingApprovals", {})];
    const [p] = CP.modelProposals(c, line({ kind: "approve_po", targetId: po.id, reason: "largest order" }), rows);
    expect(p.kind).toBe("approve_po"); expect(p.source).toBe("model"); expect(p.target).toBe(po.id); expect(p.allowed).toBe(true);
    expect(db.pos.find((x) => x.id === po.id)!.status).toBe("pending_approval");
  });
  it("drops bad json, unknown kinds, extra args and over limit amounts", () => {
    const c = ctx("usr-cfo-jane", "tnt-acme"); const rows = [CP.runTool(c, "pendingApprovals", {})];
    for (const raw of ["{nope", line({ kind: "pay_now", targetId: "po-1", reason: "xxx" }), line({ kind: "approve_po", targetId: "po-1", reason: "xxx", args: { evil: 1 } }), line({ kind: "start_sweep", targetId: "tnt-acme", reason: "xxx", args: { amount: 9e9 } })])
      expect(CP.modelProposals(c, raw, rows)).toEqual([]);
    expect(dropped().length).toBe(4);
  });
  it("drops a target that is not in this answer's tool rows", () => {
    const po = bigPo(); const c = ctx("usr-cfo-jane", "tnt-acme");
    expect(CP.modelProposals(c, line({ kind: "approve_po", targetId: po.id, reason: "looks fine" }), [CP.runTool(c, "spendBySupplier", {})])).toEqual([]);
  });
  it("drops a foreign tenant id even when it sits in the rows", () => {
    const po = bigPo(); const g = ctx("usr-globex-gina", "tnt-globex"); const acmeRows = [CP.runTool(ctx("usr-cfo-jane", "tnt-acme"), "pendingApprovals", {})];
    expect(CP.modelProposals(g, line({ kind: "approve_po", targetId: po.id, reason: "looks fine" }), acmeRows)).toEqual([]);
    expect(dropped().some((w) => /tenant/.test(w))).toBe(true);
  });
  it("mock stub suggests approve_po for the top pending approval and strips the line", async () => {
    const po = bigPo(); const a = await CP.ask(ctx("usr-controller-sam", "tnt-acme"), "What should I do next?");
    expect(a.answer).not.toMatch(/PROPOSE/);
    const p = a.proposals.find((x) => x.source === "model")!; expect(p.kind).toBe("approve_po"); expect(p.target).toBe(po.id);
    expect(a.proposals.filter((x) => x.kind === "approve_po" && x.target === po.id).length).toBe(1);
  });
  it("stream filter hides CHART and PROPOSE lines", () => {
    let out = ""; const f = CP.lineFilter((t) => (out += t));
    for (const ch of "Answer po-1.\nPROPOSE: {\"kind\":\"approve_po\"}\nCHART: null") f(ch);
    expect(out).toBe("Answer po-1.\n");
  });
});
