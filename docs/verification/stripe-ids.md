# Stripe test PaymentIntent verification

Checked on 2026-11-03 (local). Stripe source: GET /v1/payment_intents/{id} with the test mode key from .env, through the stripe npm package in bff. App source: SQLite file data/app.db, table payment_intents, matched on the providerRef field inside the data column. Stripe amounts are in cents, app amounts are in dollars. Stripe status succeeded maps to app status settled.

| PaymentIntent | Stripe amount | Currency | Stripe status | livemode | Created (UTC) | App row | App amount | App status | Result |
|---|---|---|---|---|---|---|---|---|---|
| pi_3UXvUwHL3vGJPaYL0oiQpShy | 100 | usd | succeeded | false | 2026-11-04 04:08:30 | none | n/a | n/a | Verified in Stripe test only. From sandbox contract tests, not in the app DB |
| pi_3UXvUwHL3vGJPaYL0tnQgcWK | 100 | usd | succeeded | false | 2026-11-04 04:08:30 | none | n/a | n/a | Verified in Stripe test only. From sandbox contract tests, not in the app DB |
| pi_3UXvguHL3vGJPaYL0FUYcITL | 850 | usd | succeeded | false | 2026-11-04 04:20:52 | pi-1007 | 8.50 | settled | Verified |
| pi_3UXvhEHL3vGJPaYL0bb9bzsX | 850000 | usd | succeeded | false | 2026-11-04 04:21:12 | pi-1014 | 8500 | settled | Verified |
| pi_3UXvhsHL3vGJPaYL1sJxrXXX | 850000 | usd | succeeded | false | 2026-11-04 04:21:52 | pi-1029 | 8500 | settled | Verified |
| pi_3UXvinHL3vGJPaYL1mvnLR7h | 850000 | usd | succeeded | false | 2026-11-04 04:22:49 | pi-1040 | 8500 | settled | Verified |

No mismatches were found, so no status refresh was needed and no rows were changed. Each app row timeline shows pending from the adapter, then settled from the watcher on Stripe status succeeded.
