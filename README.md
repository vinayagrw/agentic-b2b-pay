<div align="center">

# Agentic B2B Pay

**AI agents buy, people approve, and real sandbox rails move the money with full evidence.**

![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite&logoColor=white)
![Stripe test mode](https://img.shields.io/badge/Stripe-test%20mode-635BFF?logo=stripe&logoColor=white)
![Base Sepolia](https://img.shields.io/badge/Base-Sepolia-0052FF?logo=coinbase&logoColor=white)
![Claude CLI](https://img.shields.io/badge/Claude-CLI-D97757?logo=anthropic&logoColor=white)
![License](https://img.shields.io/badge/license-private%20demo-lightgrey)
![Tests](https://img.shields.io/badge/tests-98%20passed-brightgreen)

[Screenshots](#screenshots) · [How a payment flows](#how-a-payment-flows) · [Quick start](#quick-start) · [Sandbox setup](#sandbox-setup) · [Architecture](#architecture) · [Safety](#safety)

</div>

> [!WARNING]
> **TEST MODE ONLY.** Every payment runs on Stripe test mode, the Circle developer sandbox or Base Sepolia testnet USDC. No real money moves. Live mode is refused unless live keys are set and a second operator approves.

---

## Screenshots

Captured at 1440 by 900 from the running app after a reset and the happy, sanctioned and poisoned scenarios.

| | |
|:--:|:--:|
| ![Operator home with rail health and money flow map](docs/images/operator-home.png)<br/>**Operator home** with money flow map | ![Operator transaction history with filters](docs/images/operator-transactions-history.png)<br/>**Transaction history** |
| ![Operator compliance cases](docs/images/operator-compliance.png)<br/>**Compliance** | ![Operator treasury balances](docs/images/operator-treasury.png)<br/>**Treasury** |
| ![Operator reconciliation](docs/images/operator-reconciliation.png)<br/>**Reconciliation** | ![Operator branding editor with live preview](docs/images/operator-branding.png)<br/>**Branding** |
| ![Operator developer keys and webhooks](docs/images/operator-developers.png)<br/>**Developers** | ![Client home with KPIs and scenarios](docs/images/client-home.png)<br/>**Client home** |
| ![Client approvals inbox](docs/images/client-approvals.png)<br/>**Approvals** | ![Client agent registry](docs/images/client-agents.png)<br/>**Agents** |
| ![Client approval rules](docs/images/client-rules.png)<br/>**Rules** | ![Payment flow view of a settled payment](docs/images/payment-flow.png)<br/>**Payment flow** of a settled payment |
| ![Live transaction feed](docs/images/client-transactions-live.png)<br/>**Live transactions** | ![Supplier onboarding portal](docs/images/onboarding.png)<br/>**Supplier onboarding** |
| ![Client home in light theme](docs/images/client-home-light.png)<br/>**Light theme** | ![Second bank, Globex on Harbor Trust](docs/images/globex-home.png)<br/>**Second bank** (Globex on Harbor Trust) |

---

## How a payment flows

The agent proposes. Policy, people, matching, routing and screening decide. The rail settles and the ledger posts only on a verified settlement.

```mermaid
sequenceDiagram
  autonumber
  actor U as Buyer
  participant A as Buyer agent
  participant G as Gateway
  participant P as Policy
  participant H as Approver
  participant M as 3-way match
  participant R as Router
  participant C as Compliance
  participant X as Rail adapter
  participant L as Ledger and ERP
  U->>A: Describe the need
  A->>G: Draft PO with signed mandate
  G->>P: Check limits and rules
  P-->>H: Ask for approval if needed
  H->>P: Approve
  P->>M: PO, goods receipt, invoice
  M->>R: Matched invoice
  R->>C: Chosen rail
  C->>X: Screened payment
  X-->>L: Webhook or watcher says settled
  L-->>U: Paid, posted and synced
```

### Payment status

```mermaid
stateDiagram-v2
  [*] --> created
  created --> denied: policy says no
  created --> routed
  routed --> screened
  screened --> blocked: sanctions hit
  screened --> submitted
  submitted --> pending
  submitted --> failed
  pending --> settled
  pending --> failed
  settled --> refunded
  denied --> [*]
  blocked --> [*]
  failed --> [*]
  settled --> [*]
  refunded --> [*]
```

| Status | Meaning |
|---|---|
| `created` | Payment intent exists for a matched invoice |
| `denied` | Policy or an approver said no |
| `routed` | The router picked a rail |
| `screened` | Compliance checks passed |
| `blocked` | A sanctions or KYT hit stopped it |
| `submitted` | Sent to the rail adapter |
| `pending` | The rail accepted it and it is in flight |
| `settled` | Verified webhook or watcher confirmed it |
| `failed` | The rail rejected it |
| `refunded` | A refund went out as a new forward payment |

Rendered copies: [sequence SVG](docs/diagrams/payment-sequence.svg) and [state SVG](docs/diagrams/payment-states.svg).

---

## Real transactions

These Stripe test mode PaymentIntents were read back from Stripe and matched to app rows. Full method and notes in [docs/verification/stripe-ids.md](docs/verification/stripe-ids.md).

| PaymentIntent | Amount | Status | App row | Verified |
|---|--:|:--:|:--:|:--:|
| `pi_3UXvUwHL3vGJPaYL0oiQpShy` | $1.00 | succeeded | none | Stripe only, contract test |
| `pi_3UXvUwHL3vGJPaYL0tnQgcWK` | $1.00 | succeeded | none | Stripe only, contract test |
| `pi_3UXvguHL3vGJPaYL0FUYcITL` | $8.50 | succeeded | `pi-1007` | Yes |
| `pi_3UXvhEHL3vGJPaYL0bb9bzsX` | $8,500.00 | succeeded | `pi-1014` | Yes |
| `pi_3UXvhsHL3vGJPaYL1sJxrXXX` | $8,500.00 | succeeded | `pi-1029` | Yes |
| `pi_3UXvinHL3vGJPaYL1mvnLR7h` | $8,500.00 | succeeded | `pi-1040` | Yes |

> [!NOTE]
> All rows have `livemode: false`. They are test mode objects and moved no real funds. App row ids come from the database at verification time and change after a reset.

---

## Capabilities

| # | Capability | What it does | Where |
|:-:|---|---|---|
| 1 | Agent identity | Ed25519 keys and a signed mandate per agent | `modules/kya.ts` |
| 2 | Policy engine | Per payment, total, supplier and category limits, kill switch, split detection | `modules/policy.ts` |
| 3 | Approval rules | Ordered rules, maker-checker, agents never approve their own spend | `modules/rules.ts` |
| 4 | 3-way match | PO, goods receipt and invoice with tolerance | `modules/match.ts` |
| 5 | Rail router | Scores card, ACH, Circle USDC and onchain USDC, skips rails without keys | `modules/router.ts` |
| 6 | Compliance gate | KYB, sanctions, OFAC wallet list, KYT, Travel Rule record | `modules/compliance.ts` |
| 7 | Custody | Local 2 of 3 threshold signing before a stablecoin send | `modules/custody.ts` |
| 8 | Ledger and reconciliation | Double entry journals, trial balance, camt.053 export | `modules/ledger.ts` |
| 9 | ERP sync | Local SAP and Coupa adapters, payee changes with four eyes and callback | `modules/erp.ts` |
| 10 | Evidence | Hash chained audit trail for every decision | `modules/evidence.ts` |

### Flow visuals

| View | What you see |
|---|---|
| Money flow map | Tenants, rails and suppliers as a flow, with blocked money split out |
| Payment flow | Each step from need to ERP with actor, time and duration, plus the rule decision next to Claude's explanation |
| Live transactions | Events stream in as they happen, with status chips |
| History | Search, filter by status, rail, tenant, date and amount, export CSV |

---

## Quick start

```bash
make setup        # npm install
cp .env.example .env
make dev          # bff on 8790, web on http://localhost:5180
```

Open http://localhost:5180, pick a demo user and run a scenario from the client home. Set `LLM_MODE=live` to use the local `claude` CLI for the buyer agent, invoice reader and route explainer.

<details>
<summary><b>Environment variables</b> (names only)</summary>

| Name | Purpose |
|---|---|
| `BFF_PORT` | BFF port, default 8790 |
| `LLM_MODE` | `mock` or `live` |
| `SESSION_SECRET` | Signs session cookies |
| `DB_FILE` | Optional database path |
| `STRIPE_SECRET_KEY` | Stripe test key |
| `STRIPE_WEBHOOK_SECRET` | Secret printed by `stripe listen` |
| `CIRCLE_API_KEY` | Circle sandbox API key |
| `CIRCLE_ENTITY_SECRET` | 32 byte hex entity secret |
| `BASE_SEPOLIA_RPC` | Base Sepolia RPC URL |
| `RAIL_POLL_MS` | Settlement watcher interval |
| `STRIPE_LIVE_SECRET_KEY` | Optional, live mode only |
| `CIRCLE_LIVE_API_KEY` | Optional, live mode only |
| `CIRCLE_LIVE_ENTITY_SECRET` | Optional, live mode only |
| `ONCHAIN_LIVE_PRIVATE_KEY` | Optional, live mode only |

</details>

---

## Sandbox setup

### Stripe CLI

Forward test webhooks to the BFF and put the printed `whsec_` value in `.env` as `STRIPE_WEBHOOK_SECRET`.

```bash
stripe listen --api-key "$STRIPE_SECRET_KEY" --all-snapshot --forward-to localhost:8790/webhooks/stripe
```

Load `STRIPE_SECRET_KEY` from `.env` into your shell first. Do not paste keys into the command history.

### Circle sandbox

1. Sign in at [console.circle.com](https://console.circle.com) and switch to the sandbox.
2. Open **API & Client Keys** and create an API key. It looks like `TEST_API_KEY:...`. Put it in `CIRCLE_API_KEY`.
3. Make an entity secret with `openssl rand -hex 32` and register it in the **Configurator**. Put it in `CIRCLE_ENTITY_SECRET`.
4. Save the recovery file Circle gives you somewhere safe and outside the repo.
5. Start the BFF. It creates the wallet set and wallet on first use. Fund that wallet at [faucet.circle.com](https://faucet.circle.com) on Base Sepolia.

> [!NOTE]
> Console menu labels above are from memory and are unverified. Circle may have renamed them.

### Base Sepolia funding

The BFF prints its Base Sepolia address at start. The key lives in `data/keys/base-sepolia.json`, which is gitignored. Send it test USDC from [faucet.circle.com](https://faucet.circle.com) and a little Base Sepolia ETH for gas. Until it is funded the router skips `onchain_usdc` for payments above the balance.

---

## Architecture

```mermaid
flowchart LR
  subgraph Agents["Agents"]
    BA["Buyer agent<br/>Claude CLI"]
    IR["Invoice reader"]
    RX["Route explainer"]
  end
  GW["Agent gateway<br/>REST, MCP, A2A"]
  KYA["Agent identity<br/>signed mandate"]
  POL["Policy engine<br/>limits, approvals"]
  M3["3-way match"]
  RT["Rail router"]
  CMP["Compliance gate<br/>KYB, sanctions, KYT"]
  CUS["Custody<br/>2 of 3 signing"]
  subgraph Adapters["Rail adapters"]
    ST["Stripe test mode"]
    CI["Circle sandbox"]
    BS["Base Sepolia USDC"]
  end
  LED["Double entry ledger"]
  ERP["ERP adapters<br/>SAP, Coupa"]
  EVD["Evidence store<br/>hash chained"]
  BA --> GW
  IR --> GW
  GW --> KYA --> POL --> M3 --> RT --> CMP
  CMP --> ST
  CMP --> CUS --> CI
  CUS --> BS
  RX -. explains .-> RT
  ST --> LED
  CI --> LED
  BS --> LED
  LED --> ERP
  POL -.-> EVD
  CMP -.-> EVD
  LED -.-> EVD
```

Rendered copy: [architecture SVG](docs/diagrams/architecture.svg). Workspaces are `shared` (zod types), `bff` (Fastify 5) and `web` (React 18 and Vite 6).

| Rail | Sandbox behaviour | Settles from |
|---|---|---|
| `stripe_card` | PaymentIntent with `pm_card_visa` | Webhook or watcher |
| `stripe_ach` | `us_bank_account` with Stripe test bank numbers | Webhook or watcher, a few minutes |
| `circle_usdc` | Circle developer wallet on Base Sepolia | Circle webhook or watcher |
| `onchain_usdc` | viem ERC-20 transfer of Base Sepolia USDC | Watcher reads the receipt |

---

## Safety

> [!IMPORTANT]
> Claude never sends real money. The LLM only proposes and explains. Prices, matching, routing, policy, screening and money movement are deterministic code.

- Invoice text is untrusted. The extract schema has no payee fields and injection lines are logged and ignored.
- Payee changes go only through the ERP adapter with four eyes and a callback.
- Live mode is per tenant and per rail. It needs live keys **and** maker-checker approval by a second operator.

---

## Testing

```bash
make test          # vitest with LLM_MODE=mock, 98 passed and 4 skipped
make e2e           # full flow once with the real claude CLI
cd bff && SANDBOX_TESTS=1 npx vitest run sandbox   # contract tests against real sandboxes
```

---

## Project layout

```text
agentic-b2b-pay/
├── shared/          zod types shared by bff and web
├── bff/
│   ├── src/
│   │   ├── modules/ policy, router, compliance, custody, ledger, evidence, erp
│   │   ├── rails/   stripe, circle, onchain adapters
│   │   └── server.ts
│   └── test/
├── web/src/         React pages, shell and UI kit
├── docs/
│   ├── images/      screenshots
│   ├── diagrams/    Mermaid sources and SVGs
│   ├── research/    research and design pack
│   └── verification/
└── data/            local SQLite and keys, gitignored
```

---

## More

| Doc | What it is |
|---|---|
| [Roadmap](docs/roadmap.md) | Ranked gaps to an enterprise platform. The leader column is unverified. |
| [Research pack](docs/research/README.md) | Design, red team, ADR and explainer |
| [Demo script](docs/demo-script.md) | A timed walk through for a bank audience, about 21 minutes |
