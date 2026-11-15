import { describe, it, expect } from "vitest";
import { earlyPayOf, termsLabel, PaymentTerms } from "@b2b/shared";
import { payByLine, canAskEarlyPay, STATUS_TEXT, DEMO_NOTE, payEarlyLines, payOnDueLines, savedText, pendingEarlyPay, earlyPayDecision } from "../src/lib/terms";

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
  it("prints one total per currency with its own sign", () => {
    const o = { byCurrency: [{ currency: "EUR", invoices: 1, payOnDue: 1700, payEarly: 1674.5, saved: 25.5 }, { currency: "USD", invoices: 1, payOnDue: 420, payEarly: 411.6, saved: 8.4 }] };
    expect(payEarlyLines(o)).toEqual(["€1,674.50 out, €25.50 saved", "$411.60 out, $8.40 saved"]);
    expect(payOnDueLines(o)).toEqual(["€1,700.00 out, nothing saved", "$420.00 out, nothing saved"]);
    expect(savedText(o)).toBe("€25.50 and $8.40");
    expect(payEarlyLines({ byCurrency: [o.byCurrency[0]] }).join(" ")).not.toMatch(/\$/);
  });
  it("lists pending early pay requests and lets only a second client admin decide", () => {
    const ch = (o: object) => ({ id: "chg-1", kind: "payment.early_pay", status: "pending", requestedBy: "usr-cfo-jane", createdAt: "", payload: { invoiceId: "inv-1" }, ...o });
    expect(pendingEarlyPay([ch({}), ch({ id: "chg-2", kind: "identity.oidc" }), ch({ id: "chg-3", status: "approved" })]).map((c) => c.id)).toEqual(["chg-1"]);
    expect(pendingEarlyPay(undefined)).toEqual([]);
    const me = (id: string, role: string) => ({ user: { id, role } });
    expect(earlyPayDecision(ch({}), me("usr-acme-amara", "client_admin"))).toEqual({ ok: true, why: "" });
    expect(earlyPayDecision(ch({}), me("usr-cfo-jane", "client_admin"))).toMatchObject({ ok: false, why: expect.stringMatching(/second client admin account/) });
    expect(earlyPayDecision(ch({}), me("usr-controller-sam", "approver")).ok).toBe(false);
    expect(earlyPayDecision(ch({}), me("usr-op-olivia", "operator_admin")).ok).toBe(false);
    expect(earlyPayDecision(ch({}), null).ok).toBe(false);
  });
});
