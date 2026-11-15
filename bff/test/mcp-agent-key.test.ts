import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as W from "../src/workspace.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
const acmePo = () => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 2, unitPrice: 420 }], justification: "Spare" });
const agent = (id: string) => db.agents.find((a) => a.id === id)!;
const call = (app: any, key: string, name: string, args: any) => app.inject({ method: "POST", url: "/mcp/call", headers: { authorization: `Bearer ${key}` }, payload: { name, arguments: args } });

describe("/mcp/call resolves the agent from its key", () => {
  it("demo agent key maps to agt-buyer-1 and works", async () => {
    const app = await buildApp(); const k = W.issueAgentKey(agent("agt-buyer-1"), "test").key;
    const r = await call(app, k, "evaluate_policy", { supplierId: "sup-northwind", category: "components", amount: 100 });
    expect(r.statusCode).toBe(200);
  });
  it("wrong key is 401", async () => {
    const app = await buildApp();
    expect((await call(app, "agk_test_nope", "evaluate_policy", { supplierId: "sup-northwind", category: "components", amount: 1 })).statusCode).toBe(401);
  });
  it("killed agent, paused agent and kill switch are 403", async () => {
    const app = await buildApp(); const a = agent("agt-buyer-1"); const k = W.issueAgentKey(a, "test").key;
    const args = { supplierId: "sup-northwind", category: "components", amount: 1 };
    db.killSwitch = true as any; const ks = await call(app, k, "evaluate_policy", args); expect(ks.statusCode).toBe(403); db.killSwitch = false as any;
    a.status = "suspended" as any; expect((await call(app, k, "evaluate_policy", args)).statusCode).toBe(403); a.status = "active" as any;
    W.setAgentState({ id: "usr-op", tenantId: "tnt-acme", name: "Op", email: "", role: "client_admin" } as any, "tnt-acme", a.id, "kill");
    expect((await call(app, k, "evaluate_policy", args)).statusCode).toBe(403);
  });
  it("unverified agent is 403", async () => {
    const app = await buildApp(); const a = agent("agt-buyer-1"); const k = W.issueAgentKey(a, "test").key;
    a.erpRole = "" as any;
    expect((await call(app, k, "evaluate_policy", { supplierId: "sup-northwind", category: "components", amount: 1 })).statusCode).toBe(403);
  });
  it("an agent from tenant B cannot touch tenant A", async () => {
    const app = await buildApp(); const po = acmePo();
    const gina = { id: "usr-globex-gina", tenantId: "tnt-globex", name: "Gina", email: "", role: "client_admin" };
    const b = W.registerAgent(gina as any, "tnt-globex", W.NewAgent.parse({ name: "Globex bot", mandate: { monthlyLimit: 1000, perTxnMax: 500, allowedCategories: ["components"], allowedRails: ["stripe_ach"], validTo: "2030-01-01" } }));
    const k = (b as any).key.key;
    expect((await call(app, k, "submit_invoice", { poId: po.id, text: S.invoiceText(po.id, {}) })).statusCode).toBe(404);
    expect((await call(app, k, "evaluate_policy", { supplierId: "sup-northwind", category: "components", amount: 1 })).statusCode).toBe(404);
    const ev = (await call(app, k, "get_evidence", { subjectId: po.id })).json(); expect(ev.content.records).toHaveLength(0);
  });
});
