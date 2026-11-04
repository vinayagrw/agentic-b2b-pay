import { describe, it, expect, beforeEach } from "vitest";
import { setAdapters, adapter } from "../src/rails/index.js";
import { onchainAddress } from "../src/rails/onchain.js";

/** Real sandbox calls. Run with SANDBOX_TESTS=1 npm test -- sandbox. Test mode only, never live. */
const on = process.env.SANDBOX_TESTS === "1";
const send = (rail: Parameters<typeof adapter>[0], wallet: string | null = null) => adapter(rail).send({ intentId: `ct-${Date.now()}`, amount: 1, currency: "USD", idempotencyKey: `contract-${rail}-${Date.now()}`, env: "sandbox", beneficiary: { name: "Contract test", wallet, bankRef: "test" }, memo: "contract test" });
const SINK = "0x000000000000000000000000000000000000dEaD";

describe.skipIf(!on)("sandbox contract", () => {
  beforeEach(() => setAdapters(null));
  for (const rail of ["stripe_card", "stripe_ach"] as const) it(`${rail} creates a test PaymentIntent`, async () => {
    if (!adapter(rail).readiness("sandbox").configured) return;
    const r = await send(rail); console.log(rail, r.providerRef, r.status);
    expect(r.providerRef).toMatch(/^pi_/);
    expect((await adapter(rail).status(r.providerRef, "sandbox")).providerRef).toBe(r.providerRef);
  }, 30000);
  it("circle_usdc wallet, balance and transfer", async () => {
    if (!adapter("circle_usdc").readiness("sandbox").configured) return;
    const b = await adapter("circle_usdc").balance("sandbox"); console.log("circle", b.detail, b.amount);
    if (b.amount < 1) return;
    const r = await send("circle_usdc", SINK); console.log("circle tx", r.providerRef, r.status); expect(r.providerRef).toBeTruthy();
  }, 60000);
  it("onchain_usdc balance and transfer", async () => {
    const b = await adapter("onchain_usdc").balance("sandbox"); console.log("onchain", onchainAddress("sandbox"), b.amount);
    if (b.amount < 1) return;
    const r = await send("onchain_usdc", SINK); console.log("onchain tx", r.explorerUrl); expect(r.providerRef).toMatch(/^0x/);
  }, 60000);
});
