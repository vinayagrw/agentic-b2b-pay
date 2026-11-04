import { describe, it, expect, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as W from "../src/workspace.js";
import { buildApp } from "../src/server.js";
import { pickRule } from "../src/modules/rules.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); W.setBankTokenizer(async (b) => ({ tokenId: `btok_test_${b.accountNumber.slice(-4)}`, last4: b.accountNumber.slice(-4), bankName: "STRIPE TEST BANK" })); });
const user = (id: string) => P.getUser(id)!;
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const MANDATE = { perTxnMax: 500, monthlyLimit: 600, allowedCategories: ["mro", "components"], allowedRails: ["onchain_usdc", "stripe_ach"], validTo: new Date(Date.now() + 30 * 864e5).toISOString() };

describe("tenants", () => {
  it("seeds domain rows for both Acme and Globex", () => {
    for (const t of ["tnt-acme", "tnt-globex"]) for (const table of ["agents", "mandates", "suppliers"]) expect((sql.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id = ?`).get(t) as any).n).toBeGreaterThan(0);
  });
  it("runs a Globex flow inside the Globex tenant only", async () => {
    const r = await S.runFlow("Need 3 shelf label packs", { tenantId: "tnt-globex" });
    const po = db.pos.find((p) => p.id === r.poId)!;
    expect(po.tenantId).toBe("tnt-globex"); expect(po.total).toBeLessThan(10);
    const pi = db.intents.find((i) => i.id === r.intentId)!; expect(pi.tenantId).toBe("tnt-globex");
    expect((sql.prepare("SELECT tenant_id FROM payment_intents WHERE id = ?").get(pi.id) as any).tenant_id).toBe("tnt-globex");
  });
  it("scopes /state to the active client tenant", async () => {
    await S.runFlow("Need 3 shelf label packs", { tenantId: "tnt-globex" });
    const app = await buildApp(); const cookie = await login(app, "usr-cfo-jane");
    const st = (await app.inject({ url: "/state", headers: { cookie } })).json();
    expect(st.pos.map((p: any) => p.id)).toEqual(["po-eu-seed"]); expect(st.suppliers.every((s: any) => !s.tenantId || s.tenantId === "tnt-acme")).toBe(true);
  });
});

describe("approval rules", () => {
  it("picks the first matching rule by position", () => {
    const rules = S.listRules("tnt-acme");
    expect(pickRule(rules, { amount: 30000, category: "components", supplierId: "sup-northwind", buyerOrgId: "org-acme" })?.name).toBe("Large spend");
    expect(pickRule(rules, { amount: 500, category: "it", supplierId: "sup-northwind", buyerOrgId: "org-acme" })?.name).toBe("IT hardware");
    expect(pickRule(rules, { amount: 500, category: "mro", supplierId: "sup-northwind", buyerOrgId: "org-acme" })).toBeNull();
  });
  it("routes a large PO through two levels with comments and blocks the wrong role", () => {
    const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 70, unitPrice: 420 }], justification: "Line 4 retrofit" });
    expect(po.status).toBe("pending_approval"); expect(po.approval?.ruleName).toBe("Large spend");
    expect(() => S.decideApproval(po.id, true, "usr-cfo-jane")).toThrow(/approver/);
    S.decideApproval(po.id, true, "usr-controller-sam", "Budget ok");
    expect(po.status).toBe("pending_approval"); expect(po.approval!.current).toBe(1);
    expect(() => S.decideApproval(po.id, true, "usr-treasurer-lee")).toThrow(/client admin/);
    S.decideApproval(po.id, true, "usr-cfo-jane", "Go");
    expect(po.status).toBe("approved"); expect(po.approval!.levels[0].approvals[0].comment).toBe("Budget ok");
  });
  it("the inbox shows who can act", () => {
    const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 30, unitPrice: 420 }], justification: "Spare motors" });
    expect(W.approvalsInbox(user("usr-controller-sam"), "tnt-acme").find((x) => x.id === po.id)?.canAct).toBe(true);
    expect(W.approvalsInbox(user("usr-clerk-pat"), "tnt-acme").find((x) => x.id === po.id)?.canAct).toBe(false);
  });
  it("the inbox carries maker, rail, policy result and risk flags for the approval card", () => {
    const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty: 30, unitPrice: 420 }], justification: "Spare motors" });
    const row = W.approvalsInbox(user("usr-controller-sam"), "tnt-acme").find((x) => x.id === po.id)!;
    expect(row.maker.kind).toBe("agent"); expect(row.maker.name).toBeTruthy(); expect(row.rail).toBeTruthy();
    expect(["allow", "needs_approval", "deny"]).toContain(row.policy.outcome); expect(Array.isArray(row.riskFlags)).toBe(true);
    expect(row.riskFlags).toContain("Large amount, 10,000 USD or more");
    expect(W.riskFlags({ total: 50, policy: { checks: [{ rule: "Budget", pass: false, detail: "over" }] } }, { screeningStatus: "flagged" })).toEqual(["Budget: over", "Supplier flagged in screening"]);
  });
  it("validates and reorders rules", () => {
    const u = user("usr-cfo-jane");
    expect(() => W.upsertRule(u, "tnt-acme", { name: "x", active: true, minAmount: 100, maxAmount: 50, categories: [], entities: [], levels: [{ role: "approver", count: 1 }] })).toThrow(/above the minimum/);
    const r = W.upsertRule(u, "tnt-acme", { name: "Northwind any amount", active: true, minAmount: 0, maxAmount: null, categories: [], entities: ["sup-northwind"], levels: [{ role: "approver", count: 2 }] });
    W.reorderRules(u, "tnt-acme", [r.id, ...S.listRules("tnt-acme").filter((x) => x.id !== r.id).map((x) => x.id)]);
    const po = S.createPo({ supplierId: "sup-northwind", category: "mro", currency: "USD", lines: [{ sku: "NW-GLV-NIT", description: "Gloves", qty: 2, unitPrice: 12 }], justification: "Gloves" });
    expect(po.approval?.ruleName).toBe("Northwind any amount"); expect(db.evidence.some((e) => e.event === "rule.reordered")).toBe(true);
  });
});

describe("agent registry", () => {
  it("registers an agent with a mandate, shows the key once and stores only the hash", () => {
    const r = W.registerAgent(user("usr-cfo-jane"), "tnt-acme", { name: "Spares bot", erpRole: "buyer.requisitioner", protocols: ["mcp"], mandate: MANDATE as any });
    expect(r.key.key).toMatch(/^agk_test_/); expect(r.mandate.monthlyLimit).toBe(600);
    expect(JSON.stringify(sql.prepare("SELECT * FROM agent_keys").all())).not.toContain(r.key.key);
    expect(W.agentForKey(r.key.key)?.id).toBe(r.agent.id);
    W.setAgentState(user("usr-cfo-jane"), "tnt-acme", r.agent.id, "kill");
    expect(W.agentForKey(r.key.key)).toBeNull();
    expect(() => W.setAgentState(user("usr-cfo-jane"), "tnt-acme", r.agent.id, "resume")).toThrow(/killed/);
  });
  it("enforces the per transaction and monthly limits from the mandate editor", () => {
    const r = W.registerAgent(user("usr-cfo-jane"), "tnt-acme", { name: "Spares bot", erpRole: "buyer.requisitioner", protocols: ["mcp"], mandate: MANDATE as any });
    const draft = (qty: number) => ({ supplierId: "sup-northwind", category: "mro" as const, currency: "USD" as const, lines: [{ sku: "NW-GLV-NIT", description: "Gloves", qty, unitPrice: 12 }], justification: "Gloves" });
    const first = S.createPo(draft(30), r.agent.id); expect(first.policy.reasons).toEqual(["All rules passed"]); expect(first.status).toBe("approved");
    const second = S.createPo(draft(30), r.agent.id);
    expect(second.status).toBe("rejected"); expect(second.policy.reasons.join()).toMatch(/Monthly limit/);
    W.updateMandate(user("usr-cfo-jane"), "tnt-acme", r.agent.id, { ...MANDATE, monthlyLimit: 5000 } as any);
    const third = S.createPo(draft(30), r.agent.id); expect(third.status).toBe("pending_approval"); expect(third.policy.reasons.join()).toMatch(/split/);
    expect((W.agentsView("tnt-acme").find((a) => a.id === r.agent.id)?.usage.total as any).count).toBe(0);
  });
  it("agent keys authenticate as the agent's tenant", async () => {
    const r = W.registerAgent(user("usr-globex-gina"), "tnt-globex", { name: "Fixtures bot", erpRole: "buyer.requisitioner", protocols: ["mcp"], mandate: MANDATE as any });
    const app = await buildApp();
    const st = (await app.inject({ url: "/state", headers: { authorization: `Bearer ${r.key.key}` } })).json();
    expect(st.agents.map((a: any) => a.id)).toContain(r.agent.id); expect(st.agents.some((a: any) => a.id === "agt-buyer-1")).toBe(false);
  });
});

describe("supplier onboarding", () => {
  const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const kyb = { legalName: "Tidewater Valves LLC", taxIdType: "ein", taxId: "12-3456789", address: { line1: "1 Dock St", city: "Norfolk", postalCode: "23510", country: "US" }, ubos: [{ name: "Ana Reyes", ownershipPct: 60, country: "US" }] };
  it("invite, KYB, bank token, signed wallet proof, submit and review", async () => {
    const inv = W.inviteSupplier(user("usr-clerk-pat"), "tnt-acme", { name: "Tidewater Valves", email: "ap@tidewater.example" });
    expect(() => W.saveKyb(inv.token, { ...kyb, taxId: "123" })).toThrow();
    W.saveKyb(inv.token, kyb);
    await W.saveBank(inv.token, { holderName: "Tidewater Valves LLC", routingNumber: "110000000", accountNumber: "000123456789" });
    const msg = W.onboardingMessage(inv.token, acct.address).message;
    await expect(W.saveWallet(inv.token, { address: acct.address, signature: await acct.signMessage({ message: "something else" }) })).rejects.toThrow(/does not match/);
    await W.saveWallet(inv.token, { address: acct.address, signature: await acct.signMessage({ message: msg }) });
    expect(W.submitOnboarding(inv.token).status).toBe("submitted");
    const s = W.reviewSupplier(user("usr-cfo-jane"), "tnt-acme", inv.supplier.id, true, "Docs fine");
    expect(s.onboarding!.status).toBe("verified"); expect(s.walletAddress).toBe(acct.address); expect(s.bankDetailsRef).toBe("btok_test_6789");
    expect(s.acceptedRails).toContain("onchain_usdc"); expect(db.mandates.find((m) => m.id === "mdt-1")!.allowedSuppliers).toContain(s.id);
  });
  it("payee changes after verification need an approver as checker", async () => {
    const inv = W.inviteSupplier(user("usr-clerk-pat"), "tnt-acme", { name: "Tidewater Valves", email: "ap@tidewater.example" });
    W.saveKyb(inv.token, kyb); await W.saveBank(inv.token, { holderName: "Tidewater", routingNumber: "110000000", accountNumber: "000123456789" }); W.submitOnboarding(inv.token);
    W.reviewSupplier(user("usr-cfo-jane"), "tnt-acme", inv.supplier.id, true);
    const c = await W.requestPayeeChange(user("usr-clerk-pat"), "tnt-acme", inv.supplier.id, { field: "bank", bank: { holderName: "Tidewater", routingNumber: "110000000", accountNumber: "000999990001" } });
    expect(() => P.decideChange(user("usr-cfo-jane"), c.id, true)).toThrow(/approver/);
    P.decideChange(user("usr-controller-sam"), c.id, true);
    expect(db.suppliers.find((s) => s.id === inv.supplier.id)!.bankDetailsRef).toBe("btok_test_0001");
  });
  it("the public portal needs a valid token and the payment path refuses unverified suppliers", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: "/onboard/not-a-token" })).statusCode).toBe(404);
    const inv = W.inviteSupplier(user("usr-clerk-pat"), "tnt-acme", { name: "Tidewater Valves", email: "ap@tidewater.example" });
    const v = (await app.inject({ url: `/onboard/${inv.token}` })).json(); expect(v.status).toBe("draft"); expect(v.tenant).toBe("Acme Manufacturing Inc");
    expect(() => S.createPo({ supplierId: inv.supplier.id, category: "mro", currency: "USD", lines: [{ sku: "X", description: "x", qty: 1, unitPrice: 1 }], justification: "x" })).toThrow(/onboarding/);
  });
});
