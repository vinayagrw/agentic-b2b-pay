import { describe, expect, it } from "vitest";
import { eventText, evidenceFileName, paidLine } from "../src/lib/evidence";

describe("evidence helpers", () => {
  it("names the download file safely", () => { expect(evidenceFileName("po-12")).toBe("evidence-po-12.json"); expect(evidenceFileName("../po 1")).toBe("evidence-po1.json"); });
  it("puts event codes in plain words", () => { expect(eventText("card.authorization_approved")).toBe("Card authorization approved"); });
  it("sums up a card payment with last 4 and the issuer label", () => {
    const card: any = { kind: "Mandate-bound virtual card", issuerLabel: "Simulated issuer", last4: "4242", authorizations: [{ decision: "declined" }, { decision: "approved" }] };
    const line = paidLine({ order: { id: "po-1" } as any, payment: { method: "card", cards: [card], railPayments: [] } });
    expect(line).toBe("Paid with a mandate-bound virtual card ending 4242. Simulated issuer."); expect(line).not.toMatch(/token/);
  });
  it("sums up a rail payment", () => { expect(paidLine({ order: { id: "po-1" } as any, payment: { method: "rail", cards: [], railPayments: [{ id: "pi-1", kind: "payment", rail: "ach", amount: 5, currency: "USD", status: "settled", createdAt: null }] } })).toBe("Paid by ach, payment pi-1."); });
});
