import { describe, expect, it } from "vitest";
import { actionsFor, masked, statusTone, usedPct } from "../src/lib/cards";

describe("cards helpers", () => {
  it("shows last4 only", () => { expect(masked("4242")).toBe("•••• 4242"); expect(masked("")).toBe("Not issued yet"); });
  it("works out the limit bar", () => { expect(usedPct({ spent: 50, limit: 200 })).toBe(25); expect(usedPct({ spent: 500, limit: 200 })).toBe(100); expect(usedPct({ spent: 1, limit: 0 })).toBe(0); });
  it("offers the right controls", () => { expect(actionsFor("active")).toMatchObject({ freeze: true, unfreeze: false, cancel: true }); expect(actionsFor("frozen")).toMatchObject({ freeze: false, unfreeze: true }); expect(actionsFor("closed")).toMatchObject({ cancel: false, limit: false }); expect(statusTone("pending_approval")).toBe("warn"); });
});
