# V1 verification: research files

Date 2026-11-03. Scope: all 17 in-window items in ranked-15d.md (fewer than 20 exist), plus the Visa BILL Billtrust conflict. Wrong items were fixed in place in the source files.

| # | Statement | File | Verdict | Corrected text | Where I looked |
|---|---|---|---|---|---|
| 1 | SAP Agent Gateway inbound A2A GA, 2026-10-27, Sourcing Assistant RFP in Ariba, user authorizations apply | ranked, R1, L1 | verified | None. Note the RFP case is an illustrative scenario, invoke needs a user token plus customer ACL | architecture.learning.sap.com (primary, opened) |
| 2 | OCC GENIUS Act final rule 2026-10-21, effective 2027-01-18, BSA AML OFAC left to later rule | ranked, R3, R4 | verified (core). CFR part, rewards and wrapped token points not in OCC release | Marked as law firm readout points | occ.gov nr-occ-2026-92 (primary, opened) |
| 3 | Visa, BILL, Billtrust pilot 2026-10-20, TAP, tokenised credentials, human approved invoices | ranked, R2, R4, L1 | verified | L1 "unverified" tags changed to verified. Added Billtrust authenticates agent for portal access | financefeeds.com, article dated 2026-10-28 (opened) |
| 4 | Mastercard Agent Pay for Machines "live" 2026-10-20 | ranked, R2 | wrong (status) | Early access (APIs, toolkit, sandbox), still pilot stage, first announced June 2026. BVNK wallet and partners correct | theblock.co, decrypt.co, coinmarketcap (search) |
| 5 | Mastercard Stablecoin Security at Money20/20, 2026-10-19 to 24 | ranked, R3/R4 | verified, date tightened | 2026-10-19, API screening before funds move on chain, North America first, global 2027 | theblock.co 2026-10-19, fintechmagazine.com |
| 6 | Visa 17 percent business share, 160 programs, 200 percent growth, dated 2026-11-01 | ranked, R3 | wrong (date) | Data published 2026-10-01 (17 percent, FY2026 to date) and 2026-09-08 (160 programs, ~200 percent). Outside window, press repeats only | thedefiant.io, crypto.news, kucoin (search) |
| 7 | Oracle AI World agent apps, "25 agentic apps" | ranked, R1 | unverified | Only Feb 2026 Oracle SCM agent release found. Keep Low | oracle.com press 2026-02-10 (search) |
| 8 | ORO Labs resold as SAP Ariba Procurement Orchestration, GA Nov 2026 | ranked, R1 | verified | None | erp.today, sapinsider, procurementmag (search) |
| 9 | OpenAI agent took wallet funds, Oct 2026, possibly testnet | ranked, R4 | wrong (date, detail) | Sepolia testnet ETH, incident 2026-06-26, report 2026-10-15 (outside window) | cointelegraph, cryptotimes.io 2026-10-16 (search) |
| 10 | Mastercard AP4M early access 2026-10-20 | ranked, R2 | unverified | Single low source. Keep Low | not found in search coverage |
| 11 | SAP Enterprise AI Gateway at TechEd | ranked, R1 | unverified | Blog only | not checked beyond file source |
| 12 | Coupa Navi Connect MCP has no public server or guide | ranked, R1 | unverified | Third party review only | not checked beyond file source |
| 13 | Lightning agent wallets on mainnet, x402 in card networks | ranked, R2 | unverified | x402 inside Mastercard is supported by item 4 | partial via item 4 sources |
| 14 | PhotonPay 40M USD Series C, week of 2026-11-03 | ranked, R3 | verified, date wrong | 2026-10-29, led by Blockchain Capital | americanbanker, fintechfutures, cryptorank (search) |
| 15 | HSBC RedCoin reaches 50,000 users in a week | ranked, R3 | wrong | Phased PayMe rollout from 2026-10-23 to about 3.3M eligible users, no activation count disclosed | scmp.com, decrypt.co, northeasttimes (search) |
| 16 | Visa Intelligent Commerce Connect, one integration | ranked, R2 | unverified | Blog only | not checked beyond file source |
| 17 | Revenium joins Agentic AI Foundation 2026-11-03 | ranked, R1 | unverified | Only a June 2026 FinOps Foundation join found. Do not use without primary | search (no AAIF match) |
| 18 | Mastercard KYA with Skyfire, 2026-09-30 (anchor) | ranked | verified | None | financefeeds.com (opened) |

Counts: 18 checked. Verified 7 (items 1, 2, 3, 5, 8, 14, 18, two with date fixes). Wrong 4 (items 4, 6, 9, 15, all fixed in place). Unverified 7 (items 7, 10, 11, 12, 13, 16, 17).

Conflict resolved: Visa BILL Billtrust pilot is verified. FinanceFeeds (2026-10-28) states launch 2026-10-20, TAP plus Agentic Directory registration, tokenised credentials, human approved invoices only. L1-leaders.md updated.

## Important missing topics

1. Circle CPN Managed Payments and Stripe agent treasury (L1 has them, unverified, not in ranked list)
2. Visa stablecoin settlement run rate (about 20 to 25B USD annualised) and onchain credit
3. Anchorpoint (Standard Chartered led) HKD retail stablecoin and HKMA licence wave
4. FinCEN or Treasury BSA AML proposal timing for GENIUS Act
5. EU side: MiCA, ECB digital euro and EURC B2B usage in window
6. Agent dispute and chargeback rules from Visa and Mastercard for commercial cards
7. ERP side payments: Oracle, Workday, NetSuite agent pay actions, Kyriba and treasury systems
8. Tokenized deposit progress (JPMD, Clearing House network) in window
9. Real B2B fraud or loss cases involving agents
