import { describe, expect, it } from "vitest";
import { decideBlock, drawBlock, drawTone, DRAW_STATUS, interestEstimate, pct, type CreditLine } from "../src/lib/credit";

const line: CreditLine = { tenantId: "tnt-acme", bankId: "bank-northstar", limit: 50000, aprPct: 9.5, currency: "USD", status: "active", setBy: "usr-op-olivia", updatedAt: "" };
const usage = { limit: 50000, outstanding: 20000, pending: 5000, available: 25000, usedPct: 50 };

describe("credit line helpers", () => {
  it("blocks a draw over what is left", () => {
    expect(drawBlock(25000, line, usage)).toBeNull();
    expect(drawBlock(25000.01, line, usage)).toMatch(/over the credit limit. \$25,000.00 is left/);
    expect(drawBlock(0, line, usage)).toMatch(/above zero/);
    expect(drawBlock(10, null, usage)).toMatch(/not set up/);
    expect(drawBlock(10, { ...line, status: "frozen" }, usage)).toMatch(/frozen/);
  });
  it("never lets the maker approve", () => {
    expect(decideBlock({ status: "pending_approval", requestedBy: "u1" }, "u1", true)).toMatch(/second person/);
    expect(decideBlock({ status: "pending_approval", requestedBy: "u1" }, "u2", true)).toBeNull();
    expect(decideBlock({ status: "pending_approval", requestedBy: "u1" }, "u2", false)).toMatch(/cannot approve/);
    expect(decideBlock({ status: "funded", requestedBy: "u1" }, "u2", true)).toMatch(/Already decided/);
  });
  it("works out bars, tones and interest", () => {
    expect(pct(25, 100)).toBe(25); expect(pct(500, 100)).toBe(100); expect(pct(1, 0)).toBe(0);
    expect(drawTone("funded")).toBe("ok"); expect(drawTone("pending_approval")).toBe("warn"); expect(drawTone("rejected")).toBe("bad");
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    expect(interestEstimate(2000, 9.5, "2026-01-01T00:00:00Z", t0 + 30 * 864e5)).toEqual({ days: 30, interest: 15.62 });
    expect(interestEstimate(2000, 9.5, "2026-01-01T00:00:00Z", t0).days).toBe(1);
  });
  it("uses plain words", () => { for (const v of Object.values(DRAW_STATUS)) expect(v).not.toMatch(/[—;]/); });
});
