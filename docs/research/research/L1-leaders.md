# L1 Leaders: B2B agentic commerce, agentic payments and stablecoin rails

As of 2026-11-03. Method: WebSearch (extended) across secondary and primary sources. No primary press release was fetched page by page, so most claims are tagged "unverified" (one secondary source or an aggregator) or "verified" (two or more independent sources agree, or a vendor domain was returned). Re-check against vendor newsrooms before client use.

## Last 15 days at a glance

- 2026-10-20 Mastercard Agent Pay for Machines early access on x402, with Coinbase, Base and BVNK settlement in fiat or stablecoin (verified, two sources)
- 2026-10-20 Visa pilot with BILL and Billtrust where agents settle buyer approved invoices (verified, investor.visa.com and bill.com releases, live pilot)
- 2026-10 Circle blog positions CPN Managed Payments (launched Apr 2026 for banks and PSPs) for agent payments over x402 or MPP (verified, circle.com blog dated 2026-10-19)
- 2026-10-21 Stripe Treasury for agents, via Stripe MCP, human approval rules (verified, stripe.com)
- 2026-10-27 SAP architecture note on A2A interoperability for the SAP Agent Gateway (verified, sap.com domain)
- 2026-04-14 Amex Intent Intelligence, part of the ACE kit, framework published later (verified, corrected date)
- 2026-10-13 PayPal Agent Ready docs supporting ACP and UCP (unverified)

## Company profiles

### Visa
- Builds: Visa Intelligent Commerce (agent tokens, spend controls) and Trusted Agent Protocol (TAP) with Cloudflare. Signed HTTP headers prove agent identity and user consent to merchants.
- How built: network tokens bound to an agent, plus signed request headers (Web Bot Auth style). Card rails settle. Stablecoin settlement exists separately.
- Status: TAP launched Oct 2025, pilots done 2025, scaling through 2026 (verified). B2B invoice pilot with BILL and Billtrust, 2026-10-20, agent pays only buyer approved items (verified, investor.visa.com and bill.com releases, live pilot).
- Sources: https://financefeeds.com/agentic-payments-visa-pilot-mastercard-kya/ , https://www.danielmcglynn.com/ai-agents-started-paying-their-own-bills-this-week/ , https://www.refontelearning.com/blog/agentic-commerce-ai-agent-payment-protocols

### Mastercard
- Builds: Agent Pay (agentic tokens, registered agents, a KYA style registry) and Agent Pay for Machines.
- How built: tokenised credentials per agent. Machines variant uses x402 signed payment vouchers and settles via Coinbase, Base and BVNK (BVNK acquired Aug 2026, verified V1).
- Status: Agent Pay live with issuers 2025 to 2026 (verified). Machines early access 2026-10-20 (verified).
- Sources: https://coinalertnews.com/news/2026/10/20/mastercard-ai-agent-payments-early-access , https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026

### Stripe (ACP, Bridge, Tempo, Privy)
- Builds: Agentic Commerce Protocol with OpenAI (Sep 2025, Apache 2.0). Shared Payment Token so the agent never sees the raw card. Machine Payments Protocol (MPP) with Tempo, launched 2026-03-18, using sessions with preauthorised spend limits. Radar tuned for agent traffic. Bridge for stablecoin issuing and orchestration. Privy for embedded wallets. Treasury for agents, x402 compatible, 2026-10-21.
- How built: protocol plus token vault. Merchant stays merchant of record. Tempo is a payments focused L1 chain. Stripe can be enabled by a merchant without a partner agreement (unverified).
- Status: ACP and SPT GA (verified). MPP launched 2026-03-18 with Tempo mainnet the same day (verified, multiple trade sources). Instant Checkout in ChatGPT was deprioritised in March 2026, purchases now finish on merchant sites or merchant apps, ACP continues (verified, several secondary sources, OpenAI post not fetched). Privy agent role not confirmed (unverified).
- Sources: https://www.crossmint.com/learn/agentic-payments-protocols-compared , https://toomanysecrets.com/the-protocols-powering-agentic-commerce-a-september-2026-update/ , https://agentpaywire.com/articles/agent-payments-week-2026-10-26/

### PayPal
- Builds: Agentic Commerce Services, Agent Ready (merchants discoverable and payable by agents), PayPal in ChatGPT checkout, MCP server and agent toolkit.
- How built: wallet based, supports ACP for ChatGPT and UCP for Google AI Mode and Gemini. PYUSD stablecoin available.
- Status: Agent Ready docs updated 2026-10-13 (unverified). ChatGPT support announced 2025 (verified).
- Sources: https://www.americanbanker.com/payments/news/paypal-earnings-beat-analysts-expectations , https://ranketta.com/blog/agentic-payments

### Adyen
- Builds: Adyen Agentic, one integration covering UCP, ACP, AP2 and Meta AI checkout. Launched 2026-06-16, limited US enterprise availability (verified, adyen.com).
- How built: protocol adapter layer on the Adyen acquiring stack with tokenisation.
- Status: launched 2026-06-16, limited US availability (unverified).
- Source: https://www.digitalapplied.com/blog/agentic-commerce-standards-ucp-acp-ap2-2026-merchant-guide

### Coinbase (x402, Base)
- Builds: x402, an HTTP 402 based pay per request protocol for agents in USDC. Base L2 for settlement. Coinbase Business lets existing checkouts accept agent payments via x402. Agent wallets (AgentKit).
- How built: open protocol plus facilitator that verifies and settles signed payment payloads onchain.
- Status: x402 live since 2025 (verified). Coinbase Business agent acceptance expanded Oct 2026 (unverified). Settlement partner for Mastercard Machines (verified).
- Sources: https://www.danielmcglynn.com/ai-agents-started-paying-their-own-bills-this-week/ , https://agentpaywire.com/articles/agent-payments-week-2026-10-26/

### Circle (CPN, Arc)
- Builds: Arc L1 with agent wallets, spending rules and sub cent USDC nanopayments. x402 Facilitator Service settling on Arc, Base and Polygon. Agent Marketplace. Circle Payments Network (CPN) for institutional payouts, plus CPN Managed Payments for agent payments over x402 or MPP without own custody or screening stack.
- How built: stablecoin native L1 with USDC as gas, hosted facilitator, managed compliance.
- Status: Arc mainnet 2026-09-16 (verified, Circle pressroom and arc.io). Facilitator live (verified, Arc X post plus press). CPN Managed Payments launched Apr 2026, agent use case pitched on circle.com blog Oct 2026 (verified, date of agent post not exact). Circle claims USDC is about 98.8 percent of agent tx volume (unverified).
- Sources: https://www.pymnts.com/blockchain/2026/circle-debuts-agentic-commerce-focused-blockchain-arc/ , https://x.com/arc/status/2101114052894437777 , https://coingeek.com/could-ai-agents-kill-circle-new-layer-1-blockchain-arc/

### Google (AP2, UCP)
- Builds: Agent Payments Protocol with signed Intent, Cart and Payment mandates as verifiable credentials. Universal Commerce Protocol (UCP) for checkout in AI Mode and Gemini. AP2 x402 extension for stablecoin.
- How built: mandate chain gives non repudiable proof of user intent, works with A2A and MCP.
- Status: AP2 announced Sep 2025, 60 plus partners. Handed to the FIDO Alliance 2026-04-28 (unverified). UCP leading on checkout (unverified).
- Sources: https://www.crossmint.com/learn/agentic-payments-protocols-compared , https://www.digitalapplied.com/blog/agentic-commerce-standards-ucp-acp-ap2-2026-merchant-guide

### OpenAI
- Builds: ACP co author with Stripe. Instant Checkout in ChatGPT with PayPal and Stripe as processors.
- How built: agent surface calls merchant ACP endpoints, payment via delegated token.
- Status: launched Sep 2025 (verified). Instant Checkout deprioritised March 2026, hosted payment sheet only in private beta for select marketplaces (verified, several secondary sources).
- Sources: https://www.reactify-solutions.com/articles/agentic-commerce-protocols-2026 , https://www.americanbanker.com/payments/news/paypal-earnings-beat-analysts-expectations

### SAP (Ariba, Agent Gateway, SAP Pay)
- Builds: next gen Ariba on BTP with Joule agents for source to pay. SAP Agent Gateway with A2A discovery endpoints for third party agents. SAP Pay, embedded payment execution in SAP Cloud ERP powered by Tereina, positioned as the base for Joule triggered payments.
- How built: agents on BTP, A2A plus MCP gateway as the governed perimeter, payments embedded in ERP.
- Status: next gen Ariba rolling out from Feb 2026, some agents Q4 2026 to Q1 2027 (verified). Agent Gateway A2A note 2026-10-27 (verified, sap.com). SAP Pay GA for SAP Cloud ERP in US and UK, announced 2026-10-06 at SAP Connect, fiat and stablecoin (USDC, EURC via Circle) settlement (verified, SAP Community and trade press). Agentic payments still future. Joule Agent Runtime free to 2026-12-31 (unverified).
- Sources: https://www.sap.com/products/financial-management/sap-pay.html , https://architecture.learning.sap.com/news/2026/10/27/a2a-agent-gateway-interoperability , https://futurumgroup.com/insights/is-saps-next-gen-ariba-the-missing-link-for-real-agentic-procurement-workflows/

### Coupa
- Builds: Navi agents across procurement, sourcing, invoicing and payments. Navi Connect MCP server with 30 plus tools. Payment Batch Creation Agent.
- How built: MCP server exposed per tenant with spend policy controls, Coupa Pay for execution.
- Status: September 2026 release GA. Batch agent ran 2,395 payments worth 20.1M USD in five weeks. 450 plus customers using agents (verified, coupa.com plus press). MCP live on five of six US tenants checked 2026-10-05 (unverified).
- Sources: https://www.coupa.com/newsroom/coupas-september-release-accelerates-agentic-spend-capabilities/ , https://procurementmag.com/news/coupa-scales-agentic-procurement-with-mcp-tools

### Oracle
- Builds: AI agents in Fusion Cloud ERP and Procurement (AI Agent Studio). J.P. Morgan supply chain finance embedded in Oracle Cloud ERP.
- How built: agents inside Fusion, bank partner rails for payment.
- Status: no specific agentic payments launch found in this run (unverified). JPM SCF integration live (verified).
- Source: https://www.finextra.com/pressarticle/106585/jp-morgan-payments-and-oracle-team-on-supply-chain-finance

### BILL
- Builds: AP and AR agents for SMB and mid market. Partner in Visa agent invoice pilot.
- Status: 100,000 plus customers on newer agents (unverified). Visa pilot 2026-10-20 (verified, investor.visa.com and bill.com releases, live pilot).
- Sources: https://resources.rework.com/tools/ai-agents/best-ai-agents-for-accounts-payable-2026 , https://www.danielmcglynn.com/ai-agents-started-paying-their-own-bills-this-week/

### Billtrust
- Builds: AR automation and B2B payments network. Partner in Visa agent invoice pilot.
- Status: pilot 2026-10-20 (verified, investor.visa.com and bill.com releases, live pilot). Billtrust authenticates the agent for portal access. No standalone agent product found.
- Source: https://financefeeds.com/agentic-payments-visa-pilot-mastercard-kya/

### JPMorgan Kinexys
- Builds: Kinexys Digital Payments (blockchain deposit accounts), JPMD USD deposit token on Base. J.P. Morgan Payments with Mirakl on agentic commerce for merchants.
- How built: permissioned ledger plus public chain deposit token, bank grade KYC.
- Status: JPMD live on Base (verified). No explicit agent mandate product found (unverified). Ant International onchain collaboration (unverified).
- Sources: https://www.americanbanker.com/payments/news/jpmorganchase-ant-collaborate-on-digital-asset-payments , https://www.fxcintel.com/research/reports/ct-jpmorgan-sibos-2026-interview

### Amex
- Builds: Agentic Commerce Experiences developer kit, Agent Purchase Protection (dispute cover for agent purchases), Intent Intelligence framework for capturing and authenticating intent.
- Status: kit and protection launched 2026-04-14 for select developers (verified, Business Wire). Intent Intelligence is part of the kit (verified).
- Source: https://agentspay.ai/vs/coupa-ai-navi-agents , https://dev.to/synfinity-dynamics-pvt-ltd/is-2026-the-year-of-agentic-payments-what-developers-need-to-know-36nm

## Capability matrix

Values: GA, pilot, announced, none. "none" means not found in this run, not proven absent. Most cells are unverified.

| Company | Mandates or intent proof | Agent identity or KYA | Tokenized credentials | Spend controls | Card rails | Stablecoin support | ERP integration | Dispute handling | Dev APIs or MCP |
|---|---|---|---|---|---|---|---|---|---|
| Visa | GA | GA | GA | GA | GA | pilot | pilot | GA | GA |
| Mastercard | GA | GA | GA | GA | GA | pilot | none | GA | GA |
| Stripe | GA | GA | GA | GA | GA | GA | none | GA | GA |
| PayPal | GA | announced | GA | GA | GA | GA | none | GA | GA |
| Adyen | GA | announced | GA | announced | GA | none | none | GA | GA |
| Coinbase | announced | GA | none | GA | none | GA | none | none | GA |
| Circle | announced | GA | none | GA | none | GA | none | none | GA |
| Google | GA | GA | none | GA | none | announced | none | announced | GA |
| OpenAI | GA | GA | GA | announced | GA | none | none | none | GA |
| SAP | announced | GA | none | GA | none | GA | GA | none | GA |
| Coupa | GA | GA | none | GA | GA | none | GA | none | GA |
| Oracle | none | announced | none | GA | none | none | GA | none | announced |
| BILL | pilot | none | pilot | GA | GA | none | GA | none | GA |
| Billtrust | pilot | none | pilot | none | GA | none | GA | none | announced |
| JPMorgan Kinexys | none | none | none | none | none | GA | pilot | none | GA |
| Amex | GA | announced | GA | GA | GA | none | none | GA | GA |

## Gaps to close

- Fetch primary releases for Visa B2B pilot, Circle CPN Managed Payments, Stripe treasury for agents, Arc mainnet date, Tempo mainnet, Privy role.
- Confirm SAP Pay GA and any Joule payment agent date on sap.com news.
- Search Oracle and Kinexys newsrooms for explicit agent payment launches.
