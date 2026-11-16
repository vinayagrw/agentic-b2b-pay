import { describe, it, expect } from "vitest";
import { actionRequest } from "../src/lib/invoices";

const inv = { id: "inv-1", amount: 8.5 };
describe("invoice action form", () => {
  it("needs a reason for hold, release and accept", () => {
    expect(actionRequest(inv, "hold", { reason: " " })).toEqual({ error: "Add a reason." });
    expect(actionRequest(inv, "hold", { reason: "Check qty" })).toEqual({ path: "/invoices/inv-1/hold", body: { reason: "Check qty", release: false } });
    expect(actionRequest(inv, "release", { reason: "ok" })).toEqual({ path: "/invoices/inv-1/hold", body: { reason: "ok", release: true } });
    expect(actionRequest(inv, "accept", { reason: "agreed" })).toEqual({ path: "/invoices/inv-1/override", body: { reason: "agreed" } });
  });
  it("checks the credit amount against the invoice", () => {
    expect(actionRequest(inv, "credit", { amount: "0", reason: "x" })).toEqual({ error: "Enter a credit amount above 0." });
    expect(actionRequest(inv, "credit", { amount: "9", reason: "x" })).toEqual({ error: "Most you can credit is 8.5." });
    expect(actionRequest(inv, "credit", { amount: "1.5", reason: "" })).toEqual({ error: "Add a reason." });
    expect(actionRequest(inv, "credit", { amount: "1.5", reason: "damaged" })).toEqual({ path: "/invoices/inv-1/credit-notes", body: { amount: 1.5, reason: "damaged" } });
  });
  it("needs corrected text to resubmit", () => {
    expect(actionRequest(inv, "resubmit", { text: "" })).toEqual({ error: "Paste the corrected invoice text." });
    expect(actionRequest(inv, "resubmit", { text: "INV fixed" })).toEqual({ path: "/invoices/inv-1/resubmit", body: { text: "INV fixed" } });
  });
});
