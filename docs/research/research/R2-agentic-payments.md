# R2 Agentic payment protocols and networks (window 2026-10-19 to 2026-11-03)

Scores are 1 to 5 for Recency (R), Authority (A), B2B relevance (B). Confidence: H means a primary source, M means reputable press or several secondary sources agree, L means a single blog or aggregator. Dates come from search results. Items marked L still need a check against the primary release.

## Ranked news

| Rank | Date | Item | Source URL | B2B relevance | R/A/B | Confidence |
|---|---|---|---|---|---|---|
| 1 | 2026-10-20 | Visa, BILL and Billtrust pilot where AI agents pay supplier invoices | https://www.danielmcglynn.com/ai-agents-started-paying-their-own-bills-this-week/ | AP and AR automation on card rails is the direct B2B use case | 5/2/5 | L (find the Visa or BILL release) |
| 2 | 2026-10-20 | Mastercard opens early access (APIs, toolkit, sandbox) to Agent Pay for Machines, still pilot stage, first announced June 2026: an agent made nine x402 payments under one budget. BVNK was the agent wallet, Coinbase CDP and Base were partners, settlement in fiat or stablecoin through Global Money Platform | https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Launches-Agent-Pay-for-Machines-to-Unlock-Super-Fast-Always-On-Payments/default.aspx | A card network now carries x402 and stablecoin settlement, so machine to machine payments fit inside network rules | 5/5/4 | H |
| 3 | 2026-10-26 | Fortune feature on Pay for Machines and x402 micropayments, with Mastercard's Jorn Lambert | https://fortune.com/2026/10/26/ai-agent-shopping-commerce-mastercard-pay-for-machines-agent-pay-x402-micropayments-jorn-lambert/ | Confirms the network's direction and positioning | 5/4/3 | M |
| 4 | 2026-10-26 | Weekly roundup says Lightning wallets for agents are on mainnet and x402 is now inside card networks | https://agentpaywire.com/articles/agent-payments-week-2026-10-26/ | Shows rails are converging | 5/2/3 | L |
| 5 | 2026-10-20 | Mastercard Agent Pay for Merchants (AP4M) reportedly in early access, for agent to agent transactions | https://universalcommerceprotocol.fr/en/agentic-payments/ | Agent to agent flows match procurement agents dealing with supplier agents | 5/2/4 | L |
| 6 | Oct 2026 (Payments Forum) | Visa Intelligent Commerce Connect: one integration for agents to find merchants and check out on any network or alternative payment method | https://atxp.ai/blog/mastercard-agent-pay-stripe-acp-visa-x402-comparison-2026/ | Fewer integrations for agent platforms. The B2B checkout path is unclear | 4/2/3 | L |
| 7 | 2026-10-13 (older context) | PayPal Agent Ready docs updated with ACP for ChatGPT and UCP for Gemini. Not yet generally available | https://www.aeosome.com/blog/can-ai-agents-pay-at-your-store-stripe-paypal-visa-mastercard/ | Mostly consumer. Braintree merchants get coverage on both protocols | 3/2/2 | L |
| 8 | 2026-10-13 (older context) | Constructor Agentic Checkout uses Stripe in its onsite shopping agents | https://agentpaywire.com/articles/agent-payments-week-2026-10-26/ | Retail. Shows that ACP-style Shared Payment Tokens are used outside ChatGPT | 3/2/2 | L |
| 9 | 2026-10-01 (older context) | Coinbase Business lets existing merchant checkouts accept agent payments over x402 | https://github.com/Ricosworks1/blockchain-payment-flow-analysis/releases/tag/market-update-mastercard-agent-pay-machines-x402-stablecoin-oct-2026 | Stablecoin acceptance for B2B API, data and compute sellers | 3/2/4 | L |
| 10 | Older context: 2025-10-14 | Visa Trusted Agent Protocol, which verifies agents with signed HTTP requests | https://wiki.private.law/en/agentic-payments | KYA at the merchant edge, which B2B portals need too | 1/3/4 | M |
| 11 | Older context: 2025 to 2026 | Google AP2, with intent, cart and payment mandates as verifiable credentials. Its governance moved toward FIDO in 2026, but sources disagree on the details | https://appliedtechnologyindex.com/research/2026-comparative-analysis-agentic-commerce-payment-protocols/ | The mandate model works as the audit trail for delegated purchasing authority | 2/3/5 | M |

Adyen: no new announcement in the window. It is listed as an x402 Foundation member only (L).

## Protocol comparison

| Protocol | Who | Mandate model | Rail | B2B fit | Status (Nov 2026) |
|---|---|---|---|---|---|
| AP2 | Google, with 60+ partners. FIDO work in 2026 | Signed intent, cart and payment mandates as verifiable credentials | Any rail: cards, bank transfer, stablecoin via the x402 extension | High. Mandates map to purchase orders and spend policy | Spec is public. Pilots are in progress |
| ACP | OpenAI and Stripe | Shared Payment Token tied to one merchant and one amount | Cards through Stripe and other PSPs | Low to medium. Built for checkout, not invoices | Live in ChatGPT. PayPal support is in docs |
| UCP | Google and retailers | Commerce flow layer. Uses AP2 for payment | Any | Medium | Live in Gemini and AI Mode |
| Visa Intelligent Commerce, TAP, Connect | Visa | Agent-bound network tokens plus TAP signatures for agent identity | Visa cards | Medium to high. The BILL and Billtrust invoice pilot shows this | Pilots since Sep 2026. Connect announced |
| Mastercard Agent Pay, Pay for Machines, AP4M | Mastercard | Agentic tokens with budgets. Know Your Agent registration | Cards, plus x402 and stablecoin through Global Money Platform | Medium to high | Live in some markets. Machines demo on 20 Oct |
| x402 | Coinbase, x402 Foundation (Stripe, Visa, Mastercard, Adyen) | Pay per request after HTTP 402. No long-lived mandate | USDC and other stablecoins on Base and other chains | High for API, data and compute. Low for large invoices | Production. Now carried by card networks |
| MPP | Stripe and Tempo | Session-based machine payments | Stablecoin and cards | Medium | Early |

## Architecture implications

1. Separate mandate from rail. Store the mandate as a signed object, using the AP2 format, then route the payment to card tokens, x402 stablecoin or bank transfer. Networks now carry every rail, so the gateway should not lock in one rail.
2. Make KYA a first-class service. Check TAP signatures, Mastercard agent registration and the principal's credentials at the edge, then link each payment to a verified agent and a verified business principal.
3. Treat B2B as invoice first. The Visa, BILL and Billtrust pilot shows the value is in paying invoices and running AP workflows, not cart checkout. Connect mandates to PO numbers, approval policy and ERP reconciliation.
4. Build budgets and micropayments together. The Pay for Machines demo spent one budget across nine payments. The ledger needs budget envelopes, per-call x402 charges and netting for stablecoin settlement.
5. Plan for protocol churn. ACP, UCP, AP2, x402 and MPP all coexist and governance is still changing. Put each protocol behind an adapter layer and keep a regular review of the specs.

## Sources
- https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Launches-Agent-Pay-for-Machines-to-Unlock-Super-Fast-Always-On-Payments/default.aspx
- https://fortune.com/2026/10/26/ai-agent-shopping-commerce-mastercard-pay-for-machines-agent-pay-x402-micropayments-jorn-lambert/
- https://www.danielmcglynn.com/ai-agents-started-paying-their-own-bills-this-week/
- https://agentpaywire.com/articles/agent-payments-week-2026-10-26/
- https://universalcommerceprotocol.fr/en/agentic-payments/
- https://atxp.ai/blog/mastercard-agent-pay-stripe-acp-visa-x402-comparison-2026/
- https://appliedtechnologyindex.com/research/2026-comparative-analysis-agentic-commerce-payment-protocols/
- https://wiki.private.law/en/agentic-payments
