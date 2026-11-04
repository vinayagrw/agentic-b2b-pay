import type { Rail, PaymentStatus } from "@b2b/shared";

export type RailEnv = "sandbox" | "live";
export type RailQuote = { rail: Rail; label: string; feeUsd: number; maxAmount: number; settleMinutes: number };
export type SendIntent = {
  intentId: string; amount: number; currency: "USD"; idempotencyKey: string; env: RailEnv;
  beneficiary: { name: string; wallet: string | null; bankRef: string };
  memo: string;
};
/** Provider status mapped to our lifecycle. submitted is ours only, adapters report pending, settled or failed. */
export type ProviderStatus = Exclude<PaymentStatus, "submitted">;
export type SendResult = { providerRef: string; status: ProviderStatus; explorerUrl?: string; dashboardUrl?: string; detail?: string };
export type RailWebhookEvent = {
  eventId: string; type: string; providerRef: string | null; status?: ProviderStatus; detail?: string;
  explorerUrl?: string;
  dispute?: { id: string; amount: number; reason: string; chargeId: string };
};
export type RailBalance = { rail: Rail; currency: string; amount: number; detail: string };
export type Readiness = { configured: boolean; reason?: string; address?: string };

export interface RailAdapter {
  id: Rail;
  readiness(env: RailEnv): Readiness;
  quote(amount: number): RailQuote;
  send(intent: SendIntent): Promise<SendResult>;
  status(providerRef: string, env: RailEnv): Promise<SendResult>;
  /** Verifies the provider signature on the raw body and maps events. Throws on a bad signature. */
  handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<RailWebhookEvent[]>;
  balance(env: RailEnv): Promise<RailBalance>;
  refund?(providerRef: string, amount: number, env: RailEnv): Promise<SendResult>;
}

export class RailError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export const header = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
