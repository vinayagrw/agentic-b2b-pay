import { describe, it, expect } from "vitest";
import { titleOf } from "../src/live";
describe("activity titles", () => {
  it("keeps acronyms upper case", () => { expect(titleOf("kya.verified")).toBe("KYA verified"); expect(titleOf("fx.lock_created")).toBe("FX lock created"); expect(titleOf("payment.settled")).toBe("Payment settled"); });
});
