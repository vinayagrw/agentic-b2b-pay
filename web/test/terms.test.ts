import { describe, it, expect } from "vitest";
import { earlyPayOf, termsLabel, PaymentTerms } from "@b2b/shared";
import { payByLine, canAskEarlyPay, STATUS_TEXT, DEMO_NOTE } from "../src/lib/terms";

const inv = { amount: 1000, currency: "USD", invoiceDate: "2026-11-01", dueDate: "2026-12-01", terms: { netDays: 30, discountPct: 2, discountDays: 10 } };
describe("payment terms wording", () => {
  it("labels terms in plain words", () => {
    expect(termsLabel(inv.terms)).toBe("2 percent off if paid in 10 days, net 30");
    expect(termsLabel({ netDays: 45 })).toBe("Net 45");
    expect(termsLabel(undefined)).toBe("No terms set");
  });
  it("works out the pay-by date and the saving", () => {
    expect(earlyPayOf(inv, "2026-11-05")).toEqual({ pct: 2, payBy: "2026-11-11", discount: 20, net: 980, daysLeft: 6, open: true });
    expect(earlyPayOf(inv, "2026-11-11")?.open).toBe(true);
    expect(earlyPayOf(inv, "2026-11-12")?.open).toBe(false);
    expect(earlyPayOf({ ...inv, terms: { netDays: 30 } }, "2026-11-05")).toBeNull();
  });
  it("shows Pay by <date> to save <amount> only while the discount is open", () => {
    expect(payByLine(inv, "2026-11-05")).toBe("Pay by 2026-11-11 to save $20.00");
    expect(payByLine(inv, "2026-11-20")).toBe("Discount passed on 2026-11-11. Due 2026-12-01");
    expect(payByLine({ ...inv, terms: { netDays: 30 } }, "2026-11-05")).toBe("Due 2026-12-01");
    expect(payByLine({ ...inv, terms: undefined }, "2026-11-05")).toBe("No terms set");
    expect(payByLine({ ...inv, paid: true }, "2026-11-05")).toBe("Paid");
  });
  it("rejects half set or impossible terms", () => {
    expect(PaymentTerms.safeParse({ netDays: 30, discountPct: 2 }).success).toBe(false);
    expect(PaymentTerms.safeParse({ netDays: 10, discountPct: 2, discountDays: 20 }).success).toBe(false);
    expect(PaymentTerms.safeParse({ netDays: 30, discountPct: 2, discountDays: 10 }).success).toBe(true);
  });
  it("only offers the ask button on an open discount to a user who may ask", () => {
    expect(canAskEarlyPay({ status: "open" }, true)).toBe(true);
    expect(canAskEarlyPay({ status: "open" }, false)).toBe(false);
    for (const s of ["requested", "approved", "missed"] as const) expect(canAskEarlyPay({ status: s }, true)).toBe(false);
  });
  it("uses plain wording with no em dashes or semicolons", () => {
    for (const t of [...Object.values(STATUS_TEXT), DEMO_NOTE, payByLine(inv, "2026-11-05")]) expect(t).not.toMatch(/[\u2014;]/);
    expect(DEMO_NOTE).toMatch(/demo figures/);
  });
});
