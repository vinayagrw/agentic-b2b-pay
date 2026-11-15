import { describe, expect, it } from "vitest";
import { remittanceUrl, isPaid, noticeLabel } from "../src/lib/portal";

describe("supplier portal helpers", () => {
  it("builds remittance links and encodes the token", () => {
    expect(remittanceUrl("spt_a/b", "pi-1", "csv")).toBe("/api/supplier-portal/spt_a%2Fb/payments/pi-1/remittance.csv");
    expect(remittanceUrl("t", "pi-1", "html")).toMatch(/remittance\.html$/);
  });
  it("offers remittance only for paid payments", () => { expect(isPaid({ status: "settled" })).toBe(true); expect(isPaid({ status: "pending" })).toBe(false); });
  it("labels notice kinds in plain words", () => { expect(noticeLabel("dispute_opened")).toBe("Dispute opened"); expect(noticeLabel("x")).toBe("x"); });
});
