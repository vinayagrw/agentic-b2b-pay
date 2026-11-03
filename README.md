# Agentic B2B Pay (demo)

Enterprise demo of agentic B2B procurement to payment, with a simulated USDC rail. TypeScript only. No real funds move.

Workspaces: `shared` (zod types), `bff` (Fastify 5, port 8790), `web` (React 18 + Vite 6, port 5180). Node 20 or newer.

## Run

```bash
make setup        # npm install
make dev          # bff on 8790 (LLM_MODE=mock by default), web on http://localhost:5180
LLM_MODE=live npm run dev   # buyer agent, invoice reader and route explainer use the local claude CLI
make test         # vitest, LLM_MODE=mock
make e2e          # npm run e2e:live, full flow once with the real claude CLI
make e2e-mock     # same flow with the deterministic fallback
```

State persists to `data/db.json`. Use Reset demo in the console to reseed.

## Modules (bff/src)

| Module | File |
|---|---|
| Agent gateway, REST plus MCP style `/mcp/tools` and `/mcp/call`, A2A card at `/.well-known/agent.json` | server.ts |
| Agent identity registry (simplified KYA, Ed25519 keys, signed mandate) | modules/kya.ts |
| Mandate and policy engine (per txn, total, per supplier, category, kill switch, approval threshold, split detection) | modules/policy.ts |
| PO, goods receipt, invoice, 3-way match with tolerance | modules/match.ts, service.ts |
| Rail router (card, ACH, RTP, USDC by amount, speed, cost, preference, compliance) | modules/router.ts |
| Compliance gate (KYB, sanctions, OFAC wallet, KYT, Travel Rule record on every USDC transfer) | modules/compliance.ts |
| Simulated MPC custody, 2 of 3 quorum before a stablecoin send | modules/custody.ts |
| Double entry ledger, trial balance, reconciliation, camt.053 export | modules/ledger.ts, service.ts |
| Hash chained evidence store | modules/evidence.ts |
| Simulated rails and simulated SAP and Coupa adapters | modules/rails.ts, modules/erp.ts |
| Refunds as new forward payments | service.ts |
| Payee changes only via ERP adapter, four eyes plus callback | service.ts |
| LLM adapter (`claude -p ... --output-format json`, 60 s timeout, deterministic fallback) | llm.ts, agents.ts |

The LLM only proposes. Prices are re-read from the catalog, invoice values are checked against the PO, routing, policy, screening and money moves are deterministic. Invoice text is untrusted, the extract schema has no payee fields, and injection lines are logged and ignored.

## Demo story

Buyer agent tab: type a need, draft, submit to policy, or click a scenario (happy path, blocked sanctioned wallet, poisoned invoice). Then walk Approvals, Supplier, Treasury and ledger, and Evidence and audit.

## Key endpoints

`POST /buyer/draft`, `POST /purchase-orders`, `POST /approvals/:poId`, `POST /goods-receipts`, `POST /invoices`, `POST /invoices/:id/match`, `POST /invoices/:id/pay` (Idempotency-Key header), `POST /refunds`, `POST /erp/vendor-master/changes`, `GET /ledger/journals`, `GET /statements/camt053`, `GET /evidence/:subjectId`, `POST /agents/:id/suspend`, `POST /kill-switch`, `GET /mcp/tools`.
