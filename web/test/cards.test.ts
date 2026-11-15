import { describe, expect, it } from "vitest";
import { actionsFor, canIssueForOrder, mandateLine, masked, statusTone, usedPct } from "../src/lib/cards";

describe("cards helpers", () => {
  it("shows last4 only", () => { expect(masked("4242")).toBe("•••• 4242"); expect(masked("")).toBe("Not issued yet"); });
  it("works out the limit bar", () => { expect(usedPct({ spent: 50, limit: 200 })).toBe(25); expect(usedPct({ spent: 500, limit: 200 })).toBe(100); expect(usedPct({ spent: 1, limit: 0 })).toBe(0); });
  it("offers the right controls", () => { expect(actionsFor("active")).toMatchObject({ freeze: true, unfreeze: false, cancel: true }); expect(actionsFor("frozen")).toMatchObject({ freeze: false, unfreeze: true }); expect(actionsFor("closed")).toMatchObject({ cancel: false, limit: false }); expect(statusTone("pending_approval")).toBe("warn"); });
});

describe("mandate-bound virtual card helpers", () => {
  const o = { cartAmount: 250, currency: "USD", supplier: "Northwind", mandate: { ok: true, reason: "", intentId: "im-1", cartId: "cm-1", cartHash: "a", bindingHash: "b", checks: [] } };
  it("offers a card only for approved orders that are not paid", () => {
    expect(["approved", "received", "invoiced"].every(canIssueForOrder)).toBe(true);
    expect(["pending_approval", "rejected", "paid"].some(canIssueForOrder)).toBe(false);
  });
  it("says the mandate state in plain words", () => {
    expect(mandateLine(o, false)).toMatch(/works once, for exactly \$250.00 to Northwind/);
    expect(mandateLine(o, true)).toMatch(/was used/);
    const bad = mandateLine({ ...o, mandate: { ...o.mandate, ok: false, reason: "The signed cart changed after the card was issued" } }, false);
    expect(bad).toMatch(/will decline/); expect(bad).not.toMatch(/[\u2014;]/);
  });
});
