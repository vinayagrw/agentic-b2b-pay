# 03 Red team gaps: B2B agentic payments and stablecoin platform

As of 2026-11-03. Target: 02-design.md (Option B). Method: adversary review (fraud, regulator, SOX auditor, supplier treasury, partner lock in, scale engineer, LLM safety), then extended web search on the top 6 gaps. Most sources are secondary or vendor pages. Check before client use.

## Gap table

| ID | Gap | Adversary | Severity | Evidence URL | Fix |
|---|---|---|---|---|---|
| G1 | No refund or error recovery path for stablecoin sends. Onchain transfers cannot be reversed. Design has no refund flow, no dispute state, disputes out of scope | Supplier treasury, CFO | Critical | https://www.spark.money/research/payment-reversal-stablecoin-chargeback-gap | Refund as a new linked payment (RefundIntent). Pre send holds and a short release delay for first time payees. Contract clause on misdirected funds. Card rail for buys that need dispute cover |
| G2 | Prompt injection and fake invoices. Supplier agent submits invoices the LLM reads. Hidden text can ask to change bank or wallet details or split amounts under thresholds | Fraud, LLM safety | Critical | https://sofy.ai/blog/prompt-injection-testing-erp-agents/ | Supplier master data (bank, wallet) changes only in ERP with four eyes and callback to a known contact. LLM output is data only. Invoice fields checked against PO, not trusted from model. Split invoice and near threshold detection. Injection test suite in CI |
| G3 | Custody and key control missing. Design says model never holds keys but does not say who signs onchain sends or how | Security, SOX auditor | Critical | https://protofire.io/guides/crypto-custody/ | MPC custody partner (Fireblocks, BitGo or Anchorage class) with its own policy engine as a second gate. Quorum signing above a set amount. Our policy decision id must match the custody approval |
| G4 | Travel Rule and AML thresholds unclear. US $3,000 BSA rule, EU zero threshold and self hosted wallet proof over EUR 1,000. GENIUS AML rule only proposed. Supplier self hosted wallets not handled | Regulator (FinCEN, OFAC, MiCA) | High | https://notabene.id/crypto-travel-rule-101/what-is-the-crypto-travel-rule | Travel Rule provider (Notabene class) plus KYT (Chainalysis or Elliptic class). Every transfer gets a Travel Rule record no matter the amount. Self hosted supplier wallets need ownership proof at onboarding. OFAC screening runs as its own step |
| G5 | ERP reconciliation format not defined. Ledger posts back to ERP but no bank statement standard. Auditors expect statement based matching | CFO auditor (SOX) | High | https://help.sap.com/doc/d38a485b480f45849e0cf6ce8d80f65b/SHIP/en-US/732a7a3bd7c540b5a1b750f80ca29168.pdf | Emit a daily camt.053 statement per wallet and camt.054 per payment. Map tx hash into the end to end id and remittance fields. SAP Digital Currency Hub style import |
| G6 | Liability for agent errors not assigned. No protocol sets who pays when an agent acts within a valid mandate but wrongly | CFO, partner, legal | High | https://www.finextra.com/blogposting/31251/deep-dive-the-hidden-liability-of-agentic-commerce | Platform terms that tie liability to mandate evidence: outside intent mandate means operator bears it, goods not matching cart mandate means supplier bears it. Agent error cover for registered agents where networks offer it |
| G7 | SOX segregation of duties. Same org admin could register an agent, write its mandate and set policy rules | SOX auditor | High | Design gap (no URL) | Separate roles for agent owner, mandate signer and policy admin. Policy rule changes need two approvers and are evidence logged. Quarterly access review export |
| G8 | Net terms and credit not modelled. B2B buys on 30 to 90 day terms but design pays on match only. No credit line, no early pay discount logic | Supplier treasury, procurement | Medium | Search found no agent specific net terms model (gap in market) | Add due_date driven scheduling, early pay discount option, and an optional credit partner hook. Payment executes on schedule, not on match |
| G9 | Overnight coin balances and depeg. CFO red line says no unhedged balances but no sweep or depeg trigger | CFO | Medium | https://www.occ.gov/news-issuances/news-releases/2026/nr-occ-2026-92.html | Just in time funding, end of day sweep to fiat, depeg alarm that pauses the stablecoin rail and routes to fiat |
| G10 | Partner lock in. One stablecoin partner, one custody partner, one KYA vendor | Partner lock in | Medium | Design gap | Adapter interfaces for custody, ramps and screening. Second ramp per corridor already planned, extend to custody and screening |
| G11 | Reliability on chain. No handling for reorgs, stuck transactions, gas spikes or chain outage. Idempotency only at API | Scale engineer | Medium | Design gap | Confirmation depth per chain, nonce manager, transaction status poller, chain health check feeding the router, outbox pattern for money events |
| G12 | Agent kill switch scope. Suspend stops new calls but not in flight intents | Security | Low | Design gap | Kill switch cancels queued intents and revokes mandates, and the custody partner gets a freeze call |

## Corrections after verification (2026-11-03)

- The OpenAI agent wallet loss often cited for G2 used Sepolia testnet ETH (incident 2026-06-26, report 2026-10-15). It shows the risk but is not a real money loss.
- Mastercard Agent Pay for Machines is early access and pilot, not live. Do not rely on it as a production rail in G10 planning.
- Circle CPN Managed Payments launched Apr 2026 for banks and PSPs. It is a candidate second partner for G10.
- ChatGPT Instant Checkout wound down Mar 2026. Liability lessons for G6 come from ACP and card rules, not that product.
- SAP Pay is GA in US and UK since 2026-10-06 via Tereina. It strengthens the G5 fix, since SAP already imports stablecoin statements.
- Visa pilot with BILL and Billtrust is verified. It pays only human approved invoices, which supports the G2 and G7 fixes.
- The FinCEN withdrawal claim in finding 4 is still single source.

## Research findings (top 6)

1. **Reversibility (G1).** Sources agree there is no protocol level chargeback. A refund is a new transfer back to the paying address. Stripe and Shopify do not offer disputes on USDC. Card based stablecoin products keep network dispute rights. A claimed Circle refund protocol appeared on one vendor page only (unverified). Pattern to use: linked refund payment, holds, escrow for high risk first payments.
2. **Prompt injection (G2).** NIST names indirect prompt injection as a class. Practitioner guidance says bank detail changes never go to an agent alone, need four eyes and a callback to a number from master data, not the invoice. Red flags: bank change close to a pay run, amounts just under a threshold.
3. **Custody (G3).** Two choices: key tech (multisig, MPC, HSM) and who holds keys (self or qualified custodian). MPC custodians offer policy rules, approver quorums and velocity limits. The treasury team owns the quorum setup.
4. **Travel Rule (G4).** FATF baseline is 1,000 USD or EUR. US BSA uses $3,000. EU applies to all transfers and needs proof of control for self hosted wallets over EUR 1,000. One source says FinCEN withdrew two crypto proposals in October 2026 but Travel Rule, SAR and OFAC duties still apply (single source, check). GENIUS AML and sanctions rules for issuers are proposed only.
5. **Reconciliation (G5).** SAP documents stablecoin account statements in camt.053 that import like a bank statement. Swift retires MT9xx statements around November 2028. Mapping of tx hash into camt fields is not standardised, so we define it.
6. **Liability (G6).** No protocol publishes a liability split. Commentary proposes mandate based allocation. AP2 leaves disputes out of scope. Mastercard says normal chargeback rights apply on agent card buys. Amex covers registered agent errors (reported). Nothing found on agent net terms, so G8 is a real market gap.

## Changes to design

- Add RefundIntent entity, refund API and a release delay for first time or changed payees.
- Supplier bank and wallet changes only in ERP master data, four eyes plus callback. LLM output treated as untrusted data.
- Add MPC custody partner as a second signing gate, with quorum above a threshold.
- Compliance gets Travel Rule provider, KYT, OFAC as separate steps, and wallet ownership proof at onboarding.
- Ledger emits camt.053 daily and camt.054 per payment.
- Platform terms with mandate based liability. Role split for SOX.
- Payment scheduling on due date, early pay discount, credit hook.
- Treasury sweep and depeg pause. Chain health checks and confirmation depth.
- Kill switch also cancels queued intents and freezes custody.

## Sources

- https://www.spark.money/research/payment-reversal-stablecoin-chargeback-gap
- https://stablecoininsider.org/can-stablecoin-transactions-be-reversed/
- https://sofy.ai/blog/prompt-injection-testing-erp-agents/
- https://www.levelpath.com/blog/stop-ai-invoice-fraud
- https://protofire.io/guides/crypto-custody/
- https://notabene.id/crypto-travel-rule-101/what-is-the-crypto-travel-rule
- https://complyfactor.com/insights/fincen-crypto-wallet-mixing-proposals-withdrawn-2026
- https://help.sap.com/doc/d38a485b480f45849e0cf6ce8d80f65b/SHIP/en-US/732a7a3bd7c540b5a1b750f80ca29168.pdf
- https://www.redcompasslabs.com/insights/what-now-iso-20022-deadlines-in-2026-onwards/
- https://www.finextra.com/blogposting/31251/deep-dive-the-hidden-liability-of-agentic-commerce
- https://www.allium.so/blog/ap2-googles-agent-payments-protocol/
