# Roadmap: from strong demo to state of the art enterprise platform

What exists today: multi-tenant operator console and client workspace, white label theming, live Stripe, Circle and Base Sepolia rails with async settlement, demo role auth, maker-checker, audit hash chain, agent registry with mandates and kill switch, approval rule designer, supplier KYB with wallet proof, treasury and forecast, reconciliation with camt.053, OFAC cases, Travel Rule, SAR drafts, refunds, disputes, revenue analytics, API keys and signed webhooks.

The gap in one line: the money movement and compliance core is real, but the enterprise wrapper (identity, entities, FX, ops, contracts) and the agent era standards (AP2, x402, network agent tokens) are missing. Banks will not buy without the first. Nobody will remember the demo without the second.

## Ranked gaps

Impact is 1 to 5. Effort is S (under 2 weeks), M (2 to 6 weeks), L (over 6 weeks).

| # | Feature | Why it matters | Who asks for it | Impact | Effort | Leader that has it |
|---|---|---|---|---|---|---|
| 1 | SSO with SAML and OIDC | Demo roles fail every bank security review. No SSO, no pilot. | CISO, IT | 5 | M | Ramp, Brex, Coupa, Bill.com |
| 2 | Fine-grained RBAC with custom roles and scopes | Maker-checker needs real per-entity, per-amount, per-action permissions | Controller, auditor | 5 | M | SAP Ariba, Coupa, Ramp |
| 3 | AP2 mandates (intent and cart mandates, signed) | Turns our homegrown mandates into the emerging open standard for agent payments | Bank innovation lead, agent builders | 5 | M | Google AP2 partners, Mastercard Agent Pay |
| 4 | Multi entity and multi currency ledger | Real groups pay from many legal entities in many currencies | CFO, group treasurer | 5 | L | Tipalti, Coupa, SAP Ariba |
| 5 | FX quotes, locks and stablecoin to fiat conversion | Cross border is where stablecoins win. Without FX the story is US only. | Treasurer | 5 | M | Circle, Stripe, Tipalti |
| 6 | Agent copilot chat over spend and payments | The headline experience buyers expect in 2026. Ask, see, act with approval. | CFO, AP clerk | 5 | M | Ramp, Brex |
| 7 | Explainable decisions on every agent action | Regulators and auditors want the why, not just the hash | Compliance, auditor | 5 | S | Visa Intelligent Commerce, Ramp |
| 8 | Anomaly and fraud feed with risk scores | Agents spending money need a live watchdog beyond OFAC | Risk, fraud ops | 4 | M | Stripe Radar, Brex, Ramp |
| 9 | Virtual cards per PO and per agent | Card rails with tight limits are how agents safely buy today | AP lead, procurement | 4 | M | Ramp, Brex, Visa Intelligent Commerce |
| 10 | Network agent tokens (Visa Intelligent Commerce, Mastercard Agent Pay) | Lets our agents pay on the card networks with verified agent identity | Bank card business | 4 | L | Visa, Mastercard |
| 11 | SCIM user provisioning | Joiners and leavers must sync from Okta or Entra automatically | IT | 4 | S | Ramp, Brex, Coupa |
| 12 | SOC 2 evidence and audit exports | Hash chain is great, but auditors need CSV, PDF and SIEM feeds | Auditor, CISO | 4 | M | Stripe, Bill.com, Tipalti |
| 13 | OpenAPI spec and typed SDKs | Developers integrate in days not weeks | Developers, partners | 4 | S | Stripe, Circle |
| 14 | Sandbox per tenant | Each client tests safely without touching live rails | Developers, implementation team | 4 | M | Stripe, Circle |
| 15 | Natural language policy builder | Write rules in plain words, see them compiled and simulated | Controller | 4 | M | Ramp, Brex |
| 16 | Mobile and Slack or Teams approvals, with voice | Approvers live in chat and on phones, not in consoles | Executives, approvers | 4 | M | Ramp, Brex, Bill.com |
| 17 | x402 machine payments | Agents pay per API call in USDC over HTTP. A true agent native rail. | Agent builders, API sellers | 4 | M | Coinbase, Stripe, Cloudflare |
| 18 | Payment what-if simulator | Test a policy or payment run against history before it goes live | Treasurer, controller | 3 | M | Coupa, Kyriba |
| 19 | Live money flow map | Shows funds moving across entities, rails and chains in real time. Great in demos. | Executives, sales | 3 | S | Circle, Brex |
| 20 | Dynamic discounting and early pay | Turns idle stablecoin treasury into supplier discount yield | Treasurer, suppliers | 3 | M | Taulia (SAP), C2FO, Coupa |
| 21 | Observability with traces, SLO dashboards and status page | Banks need proof of uptime and fast incident response | SRE, bank ops | 4 | M | Stripe, Circle |
| 22 | Rate limits, idempotency keys and quotas per key | Protects the platform and makes retries safe | Developers, SRE | 4 | S | Stripe |
| 23 | Contractual SLAs and DR with tested failover | Required in bank vendor contracts | Procurement, risk | 4 | L | Stripe, Circle |
| 24 | Data residency (EU, UK, US regions) | GDPR and local banking rules block single region | DPO, legal | 4 | L | Stripe, SAP Ariba |
| 25 | ERP sync (NetSuite, SAP, Dynamics) | AP lives in the ERP. No sync means double entry. | Controller | 4 | L | Bill.com, Tipalti, Ramp |
| 26 | Agent marketplace | Third party agents (collections, sourcing, FX) plug in under our mandates | Bank, partners | 3 | L | Coupa, Visa |
| 27 | Internationalisation and locale formats | Global groups and global suppliers | Supplier, client admins | 3 | M | Tipalti, SAP Ariba |
| 28 | Accessibility to WCAG 2.2 AA | Public sector and bank procurement require it | Procurement | 3 | M | Coupa, Bill.com |
| 29 | Supplier self service portal with tax forms | Cuts AP tickets and collects W-9 and W-8 data | Suppliers, AP | 3 | M | Tipalti, Bill.com |

## Now, Next, Later

**Now (next 6 weeks): pass the security review and own the agent story**
- SSO with SAML and OIDC, SCIM
- Fine-grained RBAC
- Explainable decisions
- AP2 mandates
- OpenAPI spec and SDKs, rate limits and idempotency
- Live money flow map

**Next (quarter 2): win the CFO and the treasurer**
- Multi entity and multi currency ledger, FX
- Agent copilot chat over spend
- Anomaly and fraud feed
- Virtual cards per PO and per agent
- Slack, Teams and mobile approvals
- Sandbox per tenant, SOC 2 evidence exports, observability

**Later (quarter 3 and beyond): scale and differentiate**
- Visa and Mastercard agent tokens
- x402 machine payments
- Natural language policy builder and what-if simulator
- Dynamic discounting
- Data residency, DR and SLAs
- ERP sync, agent marketplace, i18n, accessibility, supplier portal

## Top 5 to build next

1. **SSO and fine-grained RBAC**: without them no bank lets a pilot start.
2. **AP2 mandates**: moves our mandate model onto the open standard partners are adopting.
3. **Explainable decisions**: cheap to build on the audit chain and loved by compliance.
4. **Multi entity ledger with FX**: unlocks cross border, where stablecoins beat wires.
5. **Agent copilot chat**: the demo moment that makes the platform feel 2026, with every action routed through maker-checker.
