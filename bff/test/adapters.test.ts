import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import Stripe from "stripe";
import { verifyStripeWebhook, mapPi } from "../src/rails/stripe.js";
import { verifyCircleSignature, mapCircle, uuidFrom } from "../src/rails/circle.js";

describe("stripe adapter, offline", () => {
  const secret = "whsec_unit_test_fixture";
  const body = JSON.stringify({ id: "evt_t1", object: "event", type: "charge.dispute.created", data: { object: { id: "dp_1", amount: 5000, reason: "fraudulent", charge: "ch_1", payment_intent: "pi_1" } } });
  it("verifies the signature on the raw body and maps a dispute", async () => {
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    const [e] = await verifyStripeWebhook(Buffer.from(body), { "stripe-signature": sig });
    expect(e).toMatchObject({ eventId: "evt_t1", providerRef: "pi_1", dispute: { id: "dp_1", amount: 50 } });
  });
  it("rejects a tampered body", async () => {
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    await expect(verifyStripeWebhook(Buffer.from(body.replace("5000", "9")), { "stripe-signature": sig })).rejects.toThrow(/signature/);
  });
  it("maps PaymentIntent status", () => { expect(mapPi("succeeded")).toBe("settled"); expect(mapPi("processing")).toBe("pending"); expect(mapPi("canceled")).toBe("failed"); });
});

describe("circle adapter, offline", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const body = Buffer.from(JSON.stringify({ notificationId: "n1", notificationType: "transactions.outbound", notification: { id: "tx1", state: "COMPLETE" } }));
  const sig = crypto.sign("sha256", body, privateKey).toString("base64");
  it("verifies ECDSA signature with the key from X-Circle-Key-Id", async () => {
    await expect(verifyCircleSignature(body, { "x-circle-signature": sig, "x-circle-key-id": "k1" }, async () => pub)).resolves.toBeUndefined();
    await expect(verifyCircleSignature(Buffer.from(body.toString() + " "), { "x-circle-signature": sig, "x-circle-key-id": "k1" }, async () => pub)).rejects.toThrow(/signature/);
  });
  it("maps states and derives UUID idempotency keys", () => {
    expect(mapCircle("COMPLETE")).toBe("settled"); expect(mapCircle("SENT")).toBe("pending"); expect(mapCircle("DENIED")).toBe("failed");
    expect(uuidFrom("idem-1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); expect(uuidFrom("a")).toBe(uuidFrom("a"));
  });
});
