import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { PoDraft, RegisterAgent } from "@b2b/shared";
import { db, reset } from "./modules/store.js";
import * as S from "./service.js";
import { llmMode } from "./llm.js";
import { fileURLToPath } from "node:url";

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
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof S.HttpError ? err.status : err instanceof z.ZodError ? 422 : err.statusCode ?? 500;
    reply.status(status).send({ error: err instanceof z.ZodError ? "validation" : err.message, issues: err instanceof z.ZodError ? err.issues : undefined });
  });
  const b = (req: any) => (req.body ?? {}) as any;

  app.get("/health", async () => ({ ok: true, llmMode: llmMode() }));
  app.get("/state", async () => ({ ...db, llmMode: llmMode(), signers: S.SIGNERS }));
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

  app.post("/buyer/draft", async (req) => S.draftPo(z.object({ need: z.string().min(3) }).parse(b(req)).need));
  app.post("/purchase-orders", async (req) => S.createPo(PoDraft.parse(b(req).draft), b(req).agentId));
  app.post("/approvals/:poId", async (req: any) => S.decideApproval(req.params.poId, !!b(req).approve, b(req).approver));
  app.post("/goods-receipts", async (req) => S.receiveGoods(b(req).poId, Number(b(req).shortBy ?? 0)));
  app.post("/invoices/render", async (req) => ({ text: S.invoiceText(b(req).poId, { priceBumpPct: Number(b(req).priceBumpPct ?? 0), poison: !!b(req).poison }) }));
  app.post("/invoices", async (req) => S.submitInvoice(b(req).poId, String(b(req).text)));
  app.post("/invoices/:id/match", async (req: any) => S.matchInvoice(req.params.id));
  app.post("/invoices/:id/pay", async (req: any) => {
    const key = req.headers["idempotency-key"]; if (!key) throw new S.HttpError(400, "Idempotency-Key header required");
    return S.payInvoice(req.params.id, String(key), { urgency: b(req).urgency, approvers: b(req).approvers });
  });
  app.post("/refunds", async (req) => S.refund(b(req).paymentIntentId, Number(b(req).amount), String(b(req).reason ?? "refund")));
  app.post("/erp/vendor-master/changes", async (req) => S.requestPayeeChange({ ...b(req), source: b(req).source ?? "erp" }));
  app.post("/erp/vendor-master/changes/:id/approve", async (req: any) => S.approvePayeeChange(req.params.id, String(b(req).approver)));
  app.post("/erp/vendor-master/changes/:id/callback", async (req: any) => S.callbackPayeeChange(req.params.id, !!b(req).confirmed));
  app.get("/settlements/:id", async (req: any) => db.settlements.find((s) => s.id === req.params.id) ?? { error: "not found" });
  app.get("/ledger/journals", async () => S.ledgerView());
  app.get("/statements/camt053", async (_req, reply) => reply.type("application/xml").send(S.camt053()));
  app.get("/evidence", async () => S.evidenceView());
  app.get("/evidence/:subjectId", async (req: any) => S.evidenceView(req.params.subjectId));
  app.post("/scenario/run", async (req) => S.runFlow(String(b(req).need ?? "Need 2000 sealed 6204 bearings for line 3 maintenance"), { scenario: b(req).scenario ?? "happy" }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  S.bootstrap();
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 8790), host: "127.0.0.1" });
  console.log(`bff on http://127.0.0.1:${process.env.PORT ?? 8790} LLM_MODE=${llmMode()}`);
}
