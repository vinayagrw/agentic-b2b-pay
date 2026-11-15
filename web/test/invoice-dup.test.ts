import { describe, it, expect } from "vitest";
import { invoiceSubmitNote } from "../src/lib/invoices";

describe("invoiceSubmitNote", () => {
  it("is empty without risk signals", () => { expect(invoiceSubmitNote({ id: "inv-1" })).toBe(""); });
  it("names the earlier invoice for a near duplicate", () => {
    const t = invoiceSubmitNote({ id: "inv-2", riskSignals: [{ code: "near_duplicate", invoiceId: "inv-1", detail: "x" }] });
    expect(t).toContain("inv-1"); expect(t).not.toMatch(/[;—]/);
  });
});
