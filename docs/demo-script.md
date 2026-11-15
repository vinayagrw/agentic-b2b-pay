# Demo script: agentic B2B payments for a bank

A 30 minute walk through for a bank or PSP executive. The story: the bank white labels this platform, sells it to business clients, and earns a fee on every agent initiated supplier payment, with controls a risk team will sign off.

Every number on screen comes from the database or a live rail API. Rails run in sandbox (Stripe test mode, Circle sandbox, Base Sepolia), so no real money moves. Four things are simulated and say so on screen: the card issuer when Stripe Issuing is off, chat approvals (mock preview), early-pay savings (demo figures) and the credit line (simulated lender). Duty rates are your own inputs. There is no live tariff feed.

## Before the meeting

1. Fill `.env` with `STRIPE_SECRET_KEY` (sk_test), `STRIPE_WEBHOOK_SECRET`, `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`. Set `LLM_MODE=live` to use the claude CLI, or leave it off to show the deterministic fallback.
2. `npm run sdn:fetch --workspace bff` downloads the OFAC SDN list into `data/ofac`.
3. `npm run dev`, then open http://localhost:5180.
4. Fund the Base Sepolia wallet printed in the BFF log with test USDC from https://faucet.circle.com. The faucet has a CAPTCHA, so you do this yourself. 20 test USDC covers the whole demo.
5. Run `stripe listen --forward-to localhost:8790/webhooks/stripe` so card and ACH payments settle by webhook.
6. Keep onchain invoices under 10 USD. The phrases below are sized for that.
7. Restart the bff once before the demo so the newest migrations and seeds load (the mandate card table, the pending bank-change request for sup-contoso, the two duty orders and the credit line).
8. Never approve a real pending order in a shared environment. Use the seeded demo records.

## 1. The bank's console (3 minutes)

Sign in as **Olivia Grant, operator admin**.

- **Home**: settled volume, bank net revenue, blocked payments, open cases and recon exceptions, all across tenants.
- **Tenants**: two banks (Northstar Bank and Harbor Trust), each with a business client (Acme and Globex).
- **Branding**: switch the tenant menu between Northstar and Harbor. Logo, colours and name change across the console. This is the white label.
- **Settings**: every rail shows Sandbox or Live. Ask to switch a rail to Live: it waits for a second operator (maker checker) and is refused without live keys.

Say: "Your brand, your pricing, your risk rules. We supply the rails and the agent controls."

## 2. A business client and its agents (4 minutes)

Use the user menu, **Open client workspace**, or sign in as **Jane Okafor, client admin at Acme**.

- **Agents**: the procurement agent has a signed mandate with a per transaction limit, a monthly limit, categories, allowed rails and an expiry. Register a new agent, show the scoped key revealed once, then press **Kill**. Its key is revoked and it cannot be resumed.
- **Rules**: ordered approval rules. Mid spend needs one approver, large spend needs an approver then a client admin, IT always needs a client admin. Reorder them with the arrows.

## 3. An agent buys, people approve (4 minutes)

On **Purchase orders**, ask the agent: `Need 2 sample kits for the line 3 trial`. That is a 5 USD order, under every rule, so it goes straight through.

Then ask: `Need 30 servo motors for line 4`. That is 12,600 USD, the Mid spend rule matches, and the PO lands in **Approvals**. Sign in as **Sam Rivera, approver**, add a comment and approve. The comment and the rule are in the audit log.

## 4. Supplier onboarding (3 minutes)

On **Suppliers**, invite a new supplier. Open the link in a private window. It is the bank branded portal:

- Company details with EIN or VAT and owners.
- Bank account: tokenized by Stripe with test numbers 110000000 and 000123456789. Only the token and last four digits are kept.
- Wallet: sign the ownership message with a browser wallet, or paste a signature. The server checks it with viem.

Submit, then as Jane press **Verify supplier**. Bank or wallet changes after that need an approver to check them.

## 5. Paying on real rails (3 minutes)

Post the goods receipt for the sample kit PO, render and submit the supplier invoice, match it, then pay on **Payments**.

- The router picks USDC on Base for 5 USD. The payment goes pending, and the watcher settles it from the chain. Open the Basescan link.
- For a card payment, use a supplier that takes card. The Stripe test dashboard shows the PaymentIntent and the webhook settles it.
- Open the payment drawer: the timeline shows created, routed, submitted, pending and settled, with the source of each step.

For Globex (Harbor Trust brand), switch tenant and use `Need 3 shelf label packs` (3.60 USD on ACH) or `Need 2 display hook sets` (6.80 USD on USDC).

## 6. Controls a risk team asks about (3 minutes)

- On **Home** in the client workspace, run the **sanctioned** scenario. The supplier's wallet is on the demo watchlist, the payment is blocked before it reaches the rail, and a case opens.
- In the operator **Compliance** page, open the case: list hits, the Travel Rule record, and **Draft SAR with the model**. A person edits it and files it internally. Nothing goes to a regulator.
- **Reconciliation**: run the match. Each settlement is tied to a ledger journal. Export camt.053 for the bank's core or CSV for the client's ERP.
- **Treasury**: live balances from each rail and the 30 day forecast from open invoices. The sweep from USDC to USD says honestly that Circle Wallets has no fiat payout.

## 7. The agent approves, the checkout takes payment (4 minutes)

Open with the market: "ChatGPT Wallet launched on 13 Nov 2026. The buyer approves in the chat and the merchant's own checkout takes the payment, with a token tied to one transaction that must not be saved or reused. It is US only, Pro tier, on Amex, Mastercard and Visa. Fees, merchant of record and dispute rules are not stated. So the open question is proof. Here is our answer for B2B."

- **Cards** (`/app/cards`): show the issuer label at the top. It reads "Stripe Issuing (test mode)" or "Simulated issuer". Say which one is on screen.
- **Purchase orders**: on an approved order press **Issue card for this order**. This is the mandate-bound virtual card.
- **Card page** (`/app/cards/:id`): the "Linked order and mandate" panel shows the live mandate status, the binding hash and the checks.
- Use the simulate box to charge the wrong amount. It is declined with "The charge must equal the order amount exactly". Then charge the right amount. It is approved once.
- Press **Evidence**. The drawer shows the order, the signed mandates, the approvals, the charge and the audit timeline. Press **Download JSON**.

Say: "One order, one card, one charge, one evidence record. If there is a dispute, this is the file you send."

## 8. Two gates fraud teams ask for (3 minutes)

- **Chat approvals** (`/app/chat-approvals`): the order from part 3 shows as a Slack and a Teams card. Say that this is a mock preview. The same approval rules apply as in the app.
- **Suppliers**: open Details and show the **Change bank details** form.
- **Bank changes** (`/app/bank-changes`): open the seeded request for sup-contoso. Show the warning signs, the call-back step and the second person step. While it waits, payments to that supplier are held. After approval they stay held for the cooling-off time.
- **Risk** (`/app/risk`): the pending request sits at the top.

## 9. Working capital (3 minutes)

- **Invoices** (`/app/invoices`): the Terms column shows the pay-by date and the saving. Press **Ask to pay early**. A second client admin approves it. Say that savings are demo figures and the payment still sends the full amount.
- **Purchase orders**: the Duty and Landed cost columns. In the copilot ask `Run the tariff cash scenario`. It draws 12 weeks of cash with and without exclusions. Say that duty rates are entered by you and there is no live tariff feed.
- **Credit line** (`/app/credit`): the "Simulated lender" banner, the line of 50,000 USD at 9.5 percent, a draw request and the second person approval. The operator view is `/operator/credit`.
- **Copilot**: ask for a chart, switch the chart type and export the PNG.

## 10. The business case (1 minute)

- **Revenue**: bank fee, rail cost and net, by tenant, rail and month, from settled payments.
- **Developers**: the client creates API keys (hashed at rest) and webhook endpoints. Deliveries are signed and retried, and the event log shows each try.

Close: "Agents do the work, your rules decide, your brand is on it, and every step is in an audit chain you can verify."

## If something goes wrong

- A rail shows Not configured: its keys are missing from `.env`. The router skips it, so pick another rail.
- An onchain payment stays pending: the wallet has no test USDC, or Base Sepolia is slow. Press **Check status now**.
- A new page is empty or a seeded record is missing: the bff was not restarted after the last update. Restart it.
- The card page says Simulated issuer: Stripe Issuing is not on for the test account. The flow is the same.
- The model is slow or offline: the deterministic fallback drafts the PO and the SAR, and the screen says which one ran.
