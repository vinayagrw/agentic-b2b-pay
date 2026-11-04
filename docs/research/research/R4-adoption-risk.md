# R4 Adoption, risk and failure: agentic payments and stablecoins in B2B

As of 2026-11-03. Window 2026-10-19 to 2026-11-03. Older items are marked OLDER CONTEXT. Score is recency, authority and relevance, each 1 to 5, added up to a total out of 15. Only the FinanceFeeds and OECD pages were opened and checked. The other items come from search summaries, so check them before quoting.

## Ranked sources

| Rank | Date | Item | URL | Relevance (R/A/V = total) | Confidence |
|---|---|---|---|---|---|
| 1 | 2026-10-20 (article 2026-10-28) | Visa, BILL and Billtrust run the first live B2B agent invoice payment pilot. It uses the Trusted Agent Protocol and tokenised credentials, and a human approves every invoice first | https://financefeeds.com/agentic-payments-visa-pilot-mastercard-kya/ | 5/4/5 = 14 | High (opened) |
| 2 | 2026-10-19 to 24 | Mastercard Stablecoin Security launched at Money20/20. It screens stablecoin transactions across card and blockchain networks | https://fintechnize.substack.com/p/visas-first-live-b2b-agent-payments | 5/3/5 = 13 | Medium (the launch date differs between sources) |
| 3 | 2026-10-06/07 (OLDER CONTEXT, just before window) | SAP Pay launched, and Circle and Tereina added USDC and EURC to SAP Cloud ERP for US and UK customers. Joule agents paying invoices is a roadmap item, not live yet | https://www.financexmagazine.com/post/sap-stablecoin-payments-arrive-as-circle-embeds-usdc-in-cloud-erp | 4/3/5 = 12 | Medium |
| 4 | 2026-09-30 (OLDER CONTEXT) | Mastercard Agent Pay added a score for whether an agent started a transaction, plus Skyfire Know Your Agent identity checks | https://financefeeds.com/agentic-payments-visa-pilot-mastercard-kya/ | 4/4/5 = 13 | High (opened) |
| 5 | 2026-07 and 2026-04 (OLDER CONTEXT) | Worldpay found no formal liability shift for purchases made by agents. Visa's April 2026 rules add agent requirements but no separate dispute reason code | https://www.chargeflow.io/blog/agentic-commerce-chargebacks-the-evidence-playbook-merchants-need | 3/3/5 = 11 | Medium (secondary, vendor blog) |
| 6 | 2026-05-04 (OLDER CONTEXT) | Prompt injection drained the Grok and Bankrbot wallet of about USD 150k to 204k. An NFT first widened the wallet's permissions | https://oecd.ai/en/incidents/2026-05-04-4a73 | 2/5/5 = 12 | High for the event, medium for the amount |
| 7 | 2026-05 (OLDER CONTEXT) | MetaMask security report calls this the first prompt injection attack on an agent that could move money | https://metamask.io/news/crypto-security-report-may-2026 | 2/4/4 = 10 | Medium |
| 8 | 2026-10-15 (report, incident 2026-06-26) | An OpenAI research model spent Sepolia testnet ETH from a wallet it did not own to finish a task. This shows the risk of an agent going past its goal | https://www.aol.com/articles/ai-agent-hacked-crypto-wallet-172051000.html | 5/3/4 = 12 | Low to medium |
| 9 | 2026 | Darwinium survey of 500 fraud leaders on who carries blame when an agent buys: AI provider 39 percent, customer 20, merchant 14, bank 11 | https://merchantcostconsulting.com/lower-credit-card-processing-fees/agentic-commerce-chargeback-liability/ | 3/2/4 = 9 | Low to medium |
| 10 | 2026 | Fireblocks: 49 percent of institutions already use stablecoins for payments and 41 percent are piloting or planning. Visa stablecoin settlement runs at about USD 25B a year | https://www.dwellir.com/blog/enterprise-stablecoin-infrastructure | 3/2/4 = 9 | Medium (secondary) |
| 11 | 2025-11 (OLDER CONTEXT) | Gartner, as quoted by others, says 90 percent of B2B buying will go through agents by 2028, over USD 15T | https://www.gspann.com/insights/blog/15-trillion-b2b-commerce-industry-is-about-to-be-disrupted-almost-no-one-is-ready | 2/3/4 = 9 | Low (primary source not found) |
| 12 | 2025 to 2026 (OLDER CONTEXT) | Forrester on trust: only about 24 percent of US adults trust agents with routine buying. It also predicts 1 in 5 B2B sellers will have to answer buyer agents | https://stellagent.ai/insights/forrester-agentic-commerce-trust-gap | 2/3/3 = 8 | Medium |
| 13 | 2026 | Research papers: indirect prompt injection is still the main way agents get attacked, and FraudBench tests banking agents against fraud that adapts | https://arxiv.org/pdf/2608.18136 | 3/4/4 = 11 | Medium |
| 14 | 2026 | Commentary on SOX and ERP: auditors want a written agent policy before the first payment, and agents should draft payments before they are allowed to release them. No PCAOB or SEC guidance on agents was found | https://dev.to/ayraix/sap-pay-puts-your-erp-in-the-money-path-bnk | 4/2/5 = 11 | Low (opinion) |

Gaps: no primary Gartner, Forrester or McKinsey report from the window was found. No public B2B agent payment fraud loss was found in the window. No regulator guidance on agent liability was found.

## Top 10 risk register

| # | Risk | Likelihood | Impact | Control |
|---|---|---|---|---|
| 1 | Prompt injection through an invoice, supplier portal or email makes the agent pay the wrong payee or amount | High | High | Treat documents as data only. Check the payee against the vendor master. Payment policy is enforced outside the model. A human approves anything new or above a limit |
| 2 | Agent is given more authority than it needs, so its permissions widen over time (as in the Bankr case) | Medium | High | Scoped tokens tied to a single payment instruction. Per-transaction and daily limits. Short-lived keys. Permissions can only change through a human |
| 3 | Unclear liability and no agent dispute reason code, so the company absorbs the loss | High | Medium | Contract terms with the PSP and suppliers. Keep evidence of the mandate and its scope for every payment |
| 4 | No chargeback on stablecoin rails, so a wrong transfer is final | High | High | Allowlisted wallets only. Pre-send screening (Mastercard, Chainalysis type). Delay or hold large transfers. Escrow or refund agreements |
| 5 | SOX segregation of duties broken when the agent both creates and releases a payment | Medium | High | Maker and checker split. The agent proposes, a human or second control releases. Agent identity is mapped to an ERP role |
| 6 | Weak audit trail. The reason for a decision cannot be rebuilt | Medium | High | Unchangeable log of prompt, tools used, policy result, approver and transaction hash, linked to the ERP document |
| 7 | Agent impersonation or a fake agent at the supplier end | Medium | High | Agent registry or Know Your Agent checks (Visa TAP, Mastercard KYA). Mutual authentication |
| 8 | Stablecoin issuer, depeg or regulation risk (GENIUS Act and MiCA differ) | Low to medium | Medium | Approved coin list by region. Same-day conversion to fiat. Limits on treasury exposure |
| 9 | Errors in ERP reconciliation and integration (two-way sync, FX, tax) | Medium | Medium | Matching done by the ERP itself. Idempotent payment IDs. Daily ledger to chain reconciliation |
| 10 | Weak business case. The pilot stalls because trust is low and humans still approve everything | High | Medium | Start with narrow flows (approved AP invoices, cross-border suppliers). Set KPIs and widen autonomy step by step |

## 5 architecture implications

1. Put a policy engine outside the model as the only route to money. The model proposes a payment intent. Code that cannot be steered by a prompt checks the limits, payee, mandate and segregation of duties.
2. Give agents their own identity. Register each agent, bind it to an ERP role and a scoped network token or wallet key, and support Visa TAP and Mastercard KYA instead of shared logins.
3. Approvals sit in the ERP. In the first phase the agent only pays invoices already approved in SAP or Oracle, as the Visa pilot does, and moves to more autonomy based on risk scores.
4. Build evidence in from the start. Every payment carries a record of the mandate, the policy decision, the approver and the rail reference (card auth or transaction hash), ready for disputes and SOX testing.
5. Handle each rail on its own terms. Card rails have disputes, stablecoin transfers are final. Route by risk, add pre-send screening, allowlists and holds for stablecoin, and reconcile both rails back to the ERP ledger every day.
