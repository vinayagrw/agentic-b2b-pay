# V3 design verification

Checked 2026-11-03. Files: 02-design.md, 03-redteam-gaps.md.

| Statement | Verdict | Fix | Where looked |
|---|---|---|---|
| Option matrix totals 360, 410, 255 and scores 72, 82, 51 | Correct | None | Recomputed by hand |
| Sensitivity: TTM 35 and differentiation 0 gives a tie | Wrong. A 81, B 79 | Rewrote line with real numbers | Recomputed |
| Six of seven personas pick B | Correct (procurement picks B or A, supplier neutral) | None | Section 2 table |
| Red team has 12 gaps, 3 critical | Correct (G1 to G3) | None | 03 gap table |
| Section 8 changes match 03 changes and the design (RefundIntent, POST /refunds, custody, camt export, kill switch) | Consistent | None | 02 sections 4, 6, 7, 8 and 03 |
| Modules M1 to M12 map to components and MVP table | Consistent | None | 02 sections 1, 4, 7 |
| OCC GENIUS final rule effective 2027-01-18 | Verified. Finalised 2026-10-21 | None | WebSearch, OCC bulletin 2026-50, Skadden, MoFo |
| US Travel Rule 3,000 USD, EU TFR every transfer, self hosted proof over EUR 1,000 | Correct | None | Regulation knowledge, Notabene source in 03 |
| camt.053 daily statement, camt.054 debit or credit notification | Correct | None | ISO 20022 definitions |
| MPC custody, x402 (Coinbase HTTP 402), AP2 (Google), ACP (OpenAI and Stripe) | Correct as used | None | Known specs |
| Mermaid flowchart and sequence | Valid by reading. CLI render failed (no headless browser) | None | verify/m1.mmd, verify/m2.mmd |
| Em dashes and semicolons | None found in either file | None | grep |

Sources: https://occ.gov/news-issuances/bulletins/2026/bulletin-2026-50.html , https://www.skadden.com/insights/publications/2026/10/occ-finalizes-genius-act-rule
