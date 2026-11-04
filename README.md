# Agentic B2B Pay (demo)

Enterprise demo of agentic B2B procurement to payment on real sandbox rails: Stripe test mode, the Circle developer sandbox and Base Sepolia USDC. TypeScript only. Claude never runs a live payment.

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
| Rail router over provider rails (stripe_card, stripe_ach, circle_usdc, onchain_usdc), skips rails without keys | modules/router.ts |
| Compliance gate (KYB, sanctions, OFAC wallet, KYT, Travel Rule record on every USDC transfer) | modules/compliance.ts |
| Local threshold signing, 2 of 3 quorum before a stablecoin send | modules/custody.ts |
| Double entry ledger, trial balance, reconciliation, camt.053 export | modules/ledger.ts, service.ts |
| Hash chained evidence store | modules/evidence.ts |
| Rail adapters (quote, send, status, handleWebhook, balance) | rails/stripe.ts, rails/circle.ts, rails/onchain.ts |
| Local SAP and Coupa adapters (DB records, no live ERP) | modules/erp.ts |
| Refunds as new forward payments | service.ts |
| Payee changes only via ERP adapter, four eyes plus callback | service.ts |
| LLM adapter (`claude -p ... --output-format json`, 60 s timeout, deterministic fallback) | llm.ts, agents.ts |

The LLM only proposes. Prices are re-read from the catalog, invoice values are checked against the PO, routing, policy, screening and money moves are deterministic. Invoice text is untrusted, the extract schema has no payee fields, and injection lines are logged and ignored.

## Demo story

Buyer agent tab: type a need, draft, submit to policy, or click a scenario (happy path, blocked sanctioned wallet, poisoned invoice). Then walk Approvals, Supplier, Treasury and ledger, and Evidence and audit.

## Key endpoints

`POST /buyer/draft`, `POST /purchase-orders`, `POST /approvals/:poId`, `POST /goods-receipts`, `POST /invoices`, `POST /invoices/:id/match`, `POST /invoices/:id/pay` (Idempotency-Key header), `POST /refunds`, `POST /erp/vendor-master/changes`, `GET /ledger/journals`, `GET /statements/camt053`, `GET /evidence/:subjectId`, `POST /agents/:id/suspend`, `POST /kill-switch`, `GET /mcp/tools`.

## Rails

Each rail is a `RailAdapter` in `bff/src/rails`. A payment goes `submitted`, then `pending`, then `settled` or `failed`. The ledger posts and the invoice is marked paid only on `settled`, which comes from a verified webhook or the settlement watcher (polls every `RAIL_POLL_MS`, default 5 s). Idempotency keys live in the `idempotency_keys` table. A rail with missing keys shows Not configured and the router skips it. There is no fallback adapter. The in-process fake adapter lives only in `bff/test/fakeRail.ts`.

| Rail | What it does in sandbox | Settles from |
|---|---|---|
| `stripe_card` | PaymentIntent confirmed with `pm_card_visa` | `payment_intent.succeeded` webhook or watcher |
| `stripe_ach` | `us_bank_account` PaymentIntent with test routing 110000000 and account 000123456789, microdeposits verified with `SM11AA` | webhook or watcher, takes a few minutes in test mode |
| `circle_usdc` | Circle W3S developer-controlled wallet on BASE-SEPOLIA. Wallet set and wallet are created on first use and stored in the `kv` table | `/webhooks/circle` (ECDSA signature with the key from `X-Circle-Key-Id`) or watcher |
| `onchain_usdc` | viem ERC-20 `transfer` of Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` from a key generated into `data/keys/base-sepolia.json` (gitignored) | watcher reads the receipt, link to sepolia.basescan.org |

Stripe rails collect funds into the platform Stripe balance. Outbound supplier payout through a Stripe Connect account is not built yet, the supplier side is recorded in the ledger and ERP feed. Disputes (`charge.dispute.created`) open a case. Stripe refunds use the Refunds API, stablecoin transfers are final.

Setup:
1. Copy `.env.example` to `.env`. Set `STRIPE_SECRET_KEY` (sk_test), `STRIPE_WEBHOOK_SECRET`, `CIRCLE_API_KEY` (TEST_API_KEY) and `CIRCLE_ENTITY_SECRET` (the 32 byte hex secret you registered with Circle).
2. Forward Stripe webhooks: `stripe listen --forward-to localhost:8790/webhooks/stripe` and put the printed `whsec_` in `.env`.
3. Start the BFF. It prints the Base Sepolia address. Fund it with test USDC at https://faucet.circle.com (and a little Base Sepolia ETH for gas). Fund the Circle wallet the same way, its address shows in Settings.
4. Circle webhooks need a public URL (for example a tunnel) subscribed in the Circle console. Without one the watcher settles Circle transfers.

Live mode is a per tenant, per rail toggle in Settings, approved by a second operator. It is refused unless the live keys (`STRIPE_LIVE_SECRET_KEY`, `CIRCLE_LIVE_API_KEY` plus `CIRCLE_LIVE_ENTITY_SECRET`, `ONCHAIN_LIVE_PRIVATE_KEY`) are set.

Contract tests against the real sandboxes: `cd bff && SANDBOX_TESTS=1 npx vitest run sandbox`.
