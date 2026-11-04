import crypto from "node:crypto";
import type { Rail } from "@b2b/shared";
import type { RailAdapter, SendResult, ProviderStatus, RailWebhookEvent } from "../src/rails/types.js";
import { setAdapters, RailError } from "../src/rails/index.js";

/** Pure in-process rail used only by tests. send() leaves the payment pending, the test decides how it ends. */
export type Fake = RailAdapter & { sent: Map<string, SendResult>; outcome: ProviderStatus; failSend?: string; webhookQueue: RailWebhookEvent[] };
const QUOTES: Record<Rail, [string, number, number, number]> = {
  stripe_card: ["Card (fake)", 0.029, 10_000, 2880], stripe_ach: ["ACH (fake)", 0, 1_000_000, 5760],
  circle_usdc: ["USDC Circle (fake)", 0, 5_000_000, 1], onchain_usdc: ["USDC Base (fake)", 0, 1_000_000, 1],
};
export function fake(id: Rail, configured = true): Fake {
  const [label, pct, maxAmount, settleMinutes] = QUOTES[id];
  const f: Fake = {
    id, sent: new Map(), outcome: "settled", webhookQueue: [],
    readiness: (env) => (configured && env === "sandbox" ? { configured: true } : { configured: false, reason: env === "live" ? "live keys missing" : "keys missing" }),
    quote: (amount) => ({ rail: id, label, feeUsd: Math.round((pct * amount + (id === "stripe_ach" ? 0.5 : id === "stripe_card" ? 0.3 : id === "circle_usdc" ? 0.1 : 0.02)) * 100) / 100, maxAmount, settleMinutes }),
    async send(i) {
      if (f.failSend) throw new Error(f.failSend);
      const hit = f.sent.get(i.idempotencyKey); if (hit) return hit;
      const ref = `${id}-${crypto.createHash("sha256").update(i.idempotencyKey).digest("hex").slice(0, 12)}`;
      const r: SendResult = { providerRef: ref, status: "pending", explorerUrl: id.endsWith("usdc") ? `https://sepolia.basescan.org/tx/0x${crypto.createHash("sha256").update(ref).digest("hex")}` : undefined };
      f.sent.set(i.idempotencyKey, r); return r;
    },
    async status(ref) { return { providerRef: ref, status: f.outcome, detail: `fake ${f.outcome}` }; },
    async handleWebhook(raw) { if (raw.toString() !== "signed") throw new RailError(400, "bad signature"); return f.webhookQueue.splice(0); },
    async balance() { return { rail: id, currency: id.endsWith("usdc") ? "USDC" : "USD", amount: 1000, detail: "fake" }; },
    refund: id.startsWith("stripe") ? async (ref) => ({ providerRef: `re-${ref}`, status: "settled" }) : undefined,
  };
  return f;
}
export function installFakes(opts: Partial<Record<Rail, boolean>> = {}) {
  const all = { stripe_card: fake("stripe_card", opts.stripe_card ?? true), stripe_ach: fake("stripe_ach", opts.stripe_ach ?? true), circle_usdc: fake("circle_usdc", opts.circle_usdc ?? true), onchain_usdc: fake("onchain_usdc", opts.onchain_usdc ?? true) };
  setAdapters(all); return all;
}
