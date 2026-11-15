import { describe, it, expect } from "vitest";
import { exceptionActions, invoiceStateLabel } from "../src/lib/invoices";

const me = (id: string, permissions: string[]) => ({ id, permissions });
const exc = { id: "inv-1", matchStatus: "exception", paid: false, submittedBy: "usr-pat" };

describe("exceptionActions", () => {
  it("offers all actions to an approver who did not send it", () => {
    expect(exceptionActions(exc, me("usr-sam", ["payments.approve", "flow.operate"]))).toEqual(["hold", "accept", "credit", "resubmit"]);
  });
  it("hides accept and credit note from the person who sent it", () => {
    expect(exceptionActions(exc, me("usr-pat", ["payments.approve", "flow.operate"]))).toEqual(["hold", "resubmit"]);
  });
  it("a clerk can hold and resubmit only", () => {
    expect(exceptionActions(exc, me("usr-x", ["flow.operate"]))).toEqual(["hold", "resubmit"]);
  });
  it("offers release for a held invoice and nothing for replaced or paid ones", () => {
    expect(exceptionActions({ ...exc, hold: { on: true } }, me("usr-sam", ["flow.operate"]))[0]).toBe("release");
    expect(exceptionActions({ ...exc, supersededBy: "inv-2" }, me("usr-sam", ["payments.approve", "flow.operate"]))).toEqual([]);
    expect(exceptionActions({ ...exc, paid: true }, me("usr-sam", ["payments.approve", "flow.operate"]))).toEqual([]);
    expect(exceptionActions({ ...exc, matchStatus: "unmatched" }, me("usr-sam", ["payments.approve", "flow.operate"]))).toEqual([]);
  });
  it("a matched unpaid invoice can still take a hold or a credit", () => {
    expect(exceptionActions({ ...exc, matchStatus: "matched" }, me("usr-sam", ["payments.approve", "flow.operate"]))).toEqual(["hold", "credit"]);
  });
});
describe("invoiceStateLabel", () => {
  it("names replaced, held and accepted invoices", () => {
    expect(invoiceStateLabel({ ...exc, supersededBy: "inv-2" })).toBe("Replaced by inv-2");
    expect(invoiceStateLabel({ ...exc, hold: { on: true, reason: "Check price" } })).toBe("On hold: Check price");
    expect(invoiceStateLabel({ ...exc, matchStatus: "matched", override: { by: "usr-sam", reason: "ok" } })).toBe("Accepted by usr-sam: ok");
    expect(invoiceStateLabel(exc)).toBe("");
  });
});
