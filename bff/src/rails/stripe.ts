import Stripe from "stripe";
import { secret } from "../config.js";
import { header, RailError, type RailAdapter, type RailEnv, type ProviderStatus, type RailWebhookEvent } from "./types.js";

/**
 * Stripe card and ACH, test mode by default.
 * Card: PaymentIntent confirmed with the test method pm_card_visa.
 * ACH: us_bank_account PaymentIntent with Stripe test bank numbers, verified with the test microdeposit descriptor SM11AA.
 * Both collect funds into the platform Stripe balance. Outbound supplier payout through a Connect account is not built,
 * the supplier side is recorded in the ledger and ERP. See README "Rails".
 */
const clients = new Map<string, Stripe>();
const keyFor = (env: RailEnv) => (env === "live" ? secret("STRIPE_LIVE_SECRET_KEY") : secret("STRIPE_SECRET_KEY"));
function client(env: RailEnv) {
  const key = keyFor(env); if (!key) throw new RailError(503, `Stripe ${env} key is not configured`);
  if (env === "sandbox" && !key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new RailError(409, "STRIPE_SECRET_KEY must be a test key (sk_test_)");
  let c = clients.get(key); if (!c) { c = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "agentic-b2b-pay" } }); clients.set(key, c); }
  return c;
}
/** The Stripe SDK client for other modules (supplier bank tokens, dispute evidence). Throws when keys are missing. */
export const stripeClient = (env: RailEnv) => client(env);
const dash = (env: RailEnv, id: string) => `https://dashboard.stripe.com/${env === "live" ? "" : "test/"}payments/${id}`;
export function mapPi(s: Stripe.PaymentIntent.Status): ProviderStatus {
  if (s === "succeeded") return "settled";
  if (s === "canceled" || s === "requires_payment_method") return "failed";
  return "pending";
}
const cents = (a: number) => Math.round(a * 100);

function make(kind: "card" | "ach"): RailAdapter {
  const id = kind === "card" ? "stripe_card" : "stripe_ach";
  return {
    id,
    sweepUnsupported: "Stripe balances are already in USD. Payouts to the bank account run on the Stripe payout schedule.",
    readiness: (env) => {
      const k = keyFor(env);
      if (!k) return { configured: false, reason: env === "live" ? "STRIPE_LIVE_SECRET_KEY missing" : "STRIPE_SECRET_KEY missing" };
      if (env === "sandbox" && !/^(sk|rk)_test_/.test(k)) return { configured: false, reason: "STRIPE_SECRET_KEY is not a test key" };
      return { configured: true };
    },
    quote: (amount) => kind === "card"
      ? { rail: id, label: "Card (Stripe)", feeUsd: Math.round((amount * 0.029 + 0.3) * 100) / 100, maxAmount: 10_000, settleMinutes: 2 * 1440 }
      : { rail: id, label: "ACH (Stripe)", feeUsd: Math.round(Math.min(amount * 0.008, 5) * 100) / 100, maxAmount: 1_000_000, settleMinutes: 4 * 1440 },
    async send(i) {
      const s = client(i.env);
      const base = { amount: cents(i.amount), currency: "usd", description: i.memo, metadata: { intentId: i.intentId, beneficiary: i.beneficiary.name } };
      let pi: Stripe.PaymentIntent;
      if (kind === "card") {
        pi = await s.paymentIntents.create({ ...base, allowed_payment_method_types: ["card"], payment_method: i.env === "sandbox" ? "pm_card_visa" : undefined, confirm: true }, { idempotencyKey: `${i.idempotencyKey}-card` });
      } else {
        if (i.env !== "sandbox") throw new RailError(409, "Live ACH needs a real mandate and bank account from the payer");
        pi = await s.paymentIntents.create({
          ...base, allowed_payment_method_types: ["us_bank_account"], confirm: true,
          payment_method_data: { type: "us_bank_account", us_bank_account: { account_holder_type: "company", routing_number: "110000000", account_number: "000123456789" }, billing_details: { name: "Acme Manufacturing Inc" } },
          payment_method_options: { us_bank_account: { verification_method: "microdeposits" } },
          mandate_data: { customer_acceptance: { type: "online", online: { ip_address: "127.0.0.1", user_agent: "agentic-b2b-pay" } } },
        }, { idempotencyKey: `${i.idempotencyKey}-ach` });
        if (pi.status === "requires_action" && pi.next_action?.type === "verify_with_microdeposits") pi = await s.paymentIntents.verifyMicrodeposits(pi.id, { descriptor_code: "SM11AA" });
      }
      return { providerRef: pi.id, status: mapPi(pi.status), dashboardUrl: dash(i.env, pi.id), detail: `Stripe status ${pi.status}` };
    },
    async status(ref, env) {
      const pi = await client(env).paymentIntents.retrieve(ref);
      return { providerRef: pi.id, status: mapPi(pi.status), dashboardUrl: dash(env, pi.id), detail: `Stripe status ${pi.status}` };
    },
    handleWebhook: (raw, headers) => verifyStripeWebhook(raw, headers),
    async balance(env) {
      const b = await client(env).balance.retrieve();
      const usd = (l: { currency: string; amount: number }[]) => (l.find((x) => x.currency === "usd")?.amount ?? 0) / 100;
      return { rail: id, currency: "USD", amount: usd(b.available), detail: `Stripe ${env} balance, pending ${usd(b.pending).toFixed(2)}` };
    },
    async refund(ref, amount, env) {
      const r = await client(env).refunds.create({ payment_intent: ref, amount: cents(amount) });
      return { providerRef: r.id, status: r.status === "succeeded" ? "settled" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending", dashboardUrl: dash(env, ref) };
    },
  };
}

/** Shared by both Stripe rails: one webhook endpoint, signature checked on the raw body. */
export async function verifyStripeWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<RailWebhookEvent[]> {
  const whsec = secret("STRIPE_WEBHOOK_SECRET");
  if (!whsec) throw new RailError(503, "STRIPE_WEBHOOK_SECRET is not configured");
  const sig = header(headers, "stripe-signature"); if (!sig) throw new RailError(400, "Missing Stripe-Signature header");
  let e: Stripe.Event;
  try { e = Stripe.webhooks.constructEvent(raw, sig, whsec); } catch (err: any) { throw new RailError(400, `Stripe signature check failed: ${err.message}`); }
  const o: any = e.data.object;
  switch (e.type) {
    case "payment_intent.succeeded": case "payment_intent.processing": case "payment_intent.payment_failed": case "payment_intent.canceled":
      return [{ eventId: e.id, type: e.type, providerRef: o.id, status: mapPi(o.status), detail: o.last_payment_error?.message ?? `Stripe ${e.type}` }];
    case "charge.dispute.created":
      return [{ eventId: e.id, type: e.type, providerRef: typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id ?? null, dispute: { id: o.id, amount: o.amount / 100, reason: o.reason, chargeId: typeof o.charge === "string" ? o.charge : o.charge?.id } }];
    default:
      return [{ eventId: e.id, type: e.type, providerRef: o?.payment_intent ?? null }];
  }
}

export const stripeCard = make("card");
export const stripeAch = make("ach");
