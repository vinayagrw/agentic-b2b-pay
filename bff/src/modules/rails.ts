import crypto from "node:crypto";
import type { Rail } from "@b2b/shared";

/** Simulated rails. No real funds. Returns mock receipts and fake tx hashes. Idempotent on key. */
const seen = new Map<string, RailReceipt>();
export type RailReceipt = { rail: Rail; railRef: string; txHash: string | null; chain: string | null; status: "confirmed"; confirmedAt: string; simulated: true };
export async function sendOnRail(rail: Rail, amount: number, idempotencyKey: string, delayMs = Number(process.env.RAIL_DELAY_MS ?? 300)): Promise<RailReceipt> {
  const hit = seen.get(idempotencyKey);
  if (hit) return hit;
  await new Promise((r) => setTimeout(r, delayMs));
  const h = crypto.createHash("sha256").update(`${rail}:${amount}:${idempotencyKey}`).digest("hex");
  const prefix = { card: "VCN", ach: "ACH", rtp: "RTP", usdc: "USDC" }[rail];
  const rec: RailReceipt = {
    rail, railRef: `${prefix}-${h.slice(0, 12).toUpperCase()}`,
    txHash: rail === "usdc" ? `0x${h}` : null, chain: rail === "usdc" ? "base-sim" : null,
    status: "confirmed", confirmedAt: new Date().toISOString(), simulated: true,
  };
  seen.set(idempotencyKey, rec);
  return rec;
}
