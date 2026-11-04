# ADR-001: Own agent gateway and rail router, partner rails, stablecoin as one routed rail

**Status:** Proposed
**Date:** 2026-11-03
**Deciders:** Client CTO, CFO, Head of Compliance, Ciklum solution architect

## Context

Buyer and supplier agents need to raise POs and pay invoices across card, ACH, RTP, wire and stablecoin. Public agent protocols (AP2, ACP, x402, MPP, UCP) cover checkout but not PO, contract terms, approvals or net terms. SAP Agent Gateway A2A is GA (2026-10-27) and the live Visa pilot with BILL and Billtrust pays only approved invoices. The OCC GENIUS rule takes effect 2027-01-18 and the AML rule is still to come. Stablecoin sends are final, so compliance must run before the send. Protocols churn fast (ChatGPT Instant Checkout wound down in Mar 2026) and some partner rails are still early access (Mastercard Agent Pay for Machines).

## Decision

Build and own the control plane: agent gateway, agent identity binding, mandate and policy engine, 3-way match, rail router, compliance orchestration, ledger and evidence store. Partner for money movement: card, bank rails, MPC custody, stablecoin issue and ramps, screening engines. Treat stablecoin as one rail the router picks per payment, behind the same policy and compliance gates as every other rail, with fiat fallback always on.

## Options considered

### Option A: Orchestration layer over partners (score 72)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Low |
| Time to market | Fastest |
| Differentiation | Low, a reseller wrapper |

**Pros:** quick launch, little regulatory scope.
**Cons:** policy and evidence sit with partners, high lock in, no B2B mandate layer of our own.

### Option B: Own gateway and router, partner rails (score 82, chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Medium |
| Time to market | MVP in 90 days on simulated money |
| Differentiation | High, the B2B control layer nobody covers |

**Pros:** control of policy, keys and evidence. Rails can be swapped. Protocol churn absorbed by adapters.
**Cons:** we own the ledger and compliance orchestration and must run them well.

### Option C: Full stack with own issuer and custody (score 51)

| Dimension | Assessment |
|---|---|
| Complexity | Very high |
| Cost | Very high |
| Time to market | Years |
| Differentiation | High but not where clients pay |

**Pros:** full control.
**Cons:** GENIUS licence, reserves and capital, MiCA EMT rules in the EU. A bank sized project.

## Trade-off analysis

| Criterion | Weight | A | B | C |
|---|---|---|---|---|
| Time to market | 20 | 5 | 4 | 1 |
| Regulatory burden (low is good) | 20 | 5 | 4 | 1 |
| Differentiation | 15 | 2 | 5 | 4 |
| Cost to build and run | 15 | 4 | 3 | 1 |
| Rail flexibility | 10 | 3 | 5 | 4 |
| Control and auditability | 10 | 2 | 4 | 5 |
| Low partner lock in | 10 | 2 | 4 | 5 |
| Score of 100 (sum of weight times score, divided by 5) | | 72 | 82 | 51 |


A wins only if time to market outweighs everything (weight 35, differentiation 0 gives A 81 against B 79). B wins whenever the client wants its own product. C fails on regulation and cost. Making stablecoin one routed rail, not the core, keeps suppliers who want fiat and limits exposure if a coin depegs or a partner slips.

## Consequences

- Easier: adding rails, coins or protocols without touching policy. One evidence trail for audit and disputes.
- Harder: we must run a ledger of record, reconciliation to ERP (camt.053 and camt.054) and a compliance gate.
- Revisit: when the GENIUS AML rule lands, when MiCA or Hong Kong stablecoin rules change the coin list for a corridor, when volume justifies a ledger product, when a second stablecoin and custody partner is needed.

## Guardrails

- The model never holds keys or calls money APIs directly.
- No onchain send without screening, OFAC and a Travel Rule record.
- Custody signs only when the policy decision id matches.
- Supplier bank and wallet changes only in ERP master data with four eyes.
- End of day sweep to fiat and a depeg pause on the stablecoin rail.

## Action items

1. Build the MVP control plane on simulated rails (0 to 3 months). A working build exists in ~/git/agentic-b2b-pay, with the claude CLI for realtime agent reasoning behind deterministic policy gates.
2. Shortlist MPC custody, Travel Rule, KYT and two stablecoin partners (Circle CPN primary, BVNK secondary, Bridge as fallback).
3. Run one real money pilot after 2027-01-18 on one corridor.
4. Write platform terms with mandate based liability, using the liability matrix in 04-final.md section 8.
