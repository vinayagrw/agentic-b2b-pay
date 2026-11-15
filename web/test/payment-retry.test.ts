import { describe, it, expect } from "vitest";
import { retryState, canAchReturn } from "../src/lib/payments";

describe("payment retry and return helpers", () => {
  it("offers retry only on a failed payment under the cap that was not retried", () => {
    expect(retryState({ status: "failed", env: "sandbox" }, 1, 3).allowed).toBe(true);
    expect(retryState({ status: "settled" }, 1, 3).allowed).toBe(false);
    expect(retryState({ status: "failed", retriedBy: "pi-9" }, 1, 3).note).toMatch(/pi-9/);
    expect(retryState({ status: "failed" }, 3, 3).note).toMatch(/3 of 3/);
    expect(retryState({ status: "failed", env: "live" }, 1, 3).allowed).toBe(false);
  });
  it("offers an ACH return only on a settled sandbox ACH payment", () => {
    expect(canAchReturn({ status: "settled", rail: "stripe_ach", env: "sandbox" })).toBe(true);
    expect(canAchReturn({ status: "settled", rail: "stripe_card", env: "sandbox" })).toBe(false);
    expect(canAchReturn({ status: "returned", rail: "stripe_ach" })).toBe(false);
    expect(canAchReturn({ status: "settled", rail: "stripe_ach", kind: "refund" })).toBe(false);
  });
});
